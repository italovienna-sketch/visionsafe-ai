/// <reference lib="webworker" />
// Worker de inferência: mantém a sessão ONNX fora da thread principal para não travar a interface.
import type * as Ort from 'onnxruntime-web';
import { computeResize, headCrop, type Letterbox, type ResizeMode } from '../core/geometry';
import type { CropModelSpec, ModelManifest } from '../core/manifest';
import { confirmedInFirstPass } from '../core/subjects';
import { measureQuality, QUALITY_SIZE } from '../core/quality';
import type { Box, Detection, FrameResult, RawOutputStats, RegionQuality } from '../core/types';
import { decodeYolo, inferOutputFormat, nms, rawStats, rgbaToChw, type YoloOutputFormat } from '../core/yolo';
import type { LoadRequest, InferRequest, RefineOptions, WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let ort: typeof Ort | null = null;
let session: Ort.InferenceSession | null = null;
let manifest: ModelManifest | null = null;
let format: YoloOutputFormat = 'yolo-raw';
let outputDims: number[] = [];
let inputCanvas: OffscreenCanvas | null = null;
let inputCtx: OffscreenCanvasRenderingContext2D | null = null;
let qualityCtx: OffscreenCanvasRenderingContext2D | null = null;
let tensorData: Float32Array | null = null;

/** Modelo de EPI da 2ª passada (manifest.cropModel): sessão, entrada e formato próprios. */
interface CropRuntime {
  session: Ort.InferenceSession;
  spec: CropModelSpec;
  format: YoloOutputFormat;
  ctx: OffscreenCanvasRenderingContext2D;
  tensor: Float32Array;
}
let crop: CropRuntime | null = null;

const post = (msg: WorkerResponse) => self.postMessage(msg);

class ModelMissingError extends Error {}

/** Baixa o modelo informando o progresso (quando o servidor envia Content-Length). */
async function fetchModel(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { cache: 'force-cache' });
  if (res.status === 404) throw new ModelMissingError(`Arquivo de modelo não encontrado: ${url}`);
  if (!res.ok) throw new Error(`Falha ao baixar o modelo (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (performance.now() - lastPost > 100) {
      lastPost = performance.now();
      post({ type: 'progress', loaded, total });
    }
  }
  post({ type: 'progress', loaded, total: total || loaded });
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  if (buf.length > 4 && new TextDecoder().decode(buf.subarray(0, 15)).toLowerCase().includes('<!doctype')) {
    // Alguns servidores devolvem index.html para arquivos inexistentes.
    throw new ModelMissingError(`Arquivo de modelo não encontrado: ${url}`);
  }
  return buf.buffer;
}

async function load(req: LoadRequest): Promise<void> {
  const t0 = performance.now();
  try {
    await session?.release();
    session = null;
    ort = req.backend === 'webgpu' ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm');
    // Multithread requer crossOriginIsolated (cabeçalhos COOP/COEP); caso contrário, 1 thread.
    const threads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    ort.env.wasm.numThreads = threads;
    ort.env.logLevel = 'error';

    await crop?.session.release();
    crop = null;
    const model = req.modelBuffer ?? (await fetchModel(req.modelUrl!));
    const created = await createSession(model, req.backend);
    session = created.session;
    const backend = created.backend;

    manifest = req.manifest;
    const size = manifest.inputSize;
    const declared = session.inputMetadata?.[0];
    const shape = declared && 'shape' in declared ? (declared.shape as (number | string)[]) : null;
    if (shape && typeof shape[2] === 'number' && shape[2] !== size) {
      throw new Error(`O modelo espera entrada ${shape[2]}×${shape[3]}, mas o manifesto declara ${size}.`);
    }
    inputCanvas = new OffscreenCanvas(size, size);
    inputCtx = inputCanvas.getContext('2d', { willReadFrequently: true });
    qualityCtx = new OffscreenCanvas(QUALITY_SIZE, QUALITY_SIZE).getContext('2d', { willReadFrequently: true });
    if (!inputCtx || !qualityCtx) throw new Error('OffscreenCanvas 2D indisponível neste navegador.');
    tensorData = new Float32Array(3 * size * size);

    // Execução de aquecimento: valida o formato da saída antes de aceitar quadros reais.
    const out = await run(tensorData);
    outputDims = [...out.dims];
    format = manifest.format ?? inferOutputFormat(outputDims, manifest.classes.length);
    checkOutputFormat();

    let cropInfo: { name: string; version: string; outputDims: number[]; format: string } | undefined;
    const spec = manifest.cropModel;
    if (spec) {
      if (!req.cropModelUrl) throw new Error('O manifesto declara cropModel, mas o arquivo do modelo de recorte não foi informado.');
      const s = (await createSession(await fetchModel(req.cropModelUrl), backend)).session;
      const ctx = new OffscreenCanvas(spec.inputSize, spec.inputSize).getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('OffscreenCanvas 2D indisponível neste navegador.');
      const tensor = new Float32Array(3 * spec.inputSize * spec.inputSize);
      const o = await runOn(s, spec.inputSize, tensor);
      const dims = [...o.dims];
      const fmt = spec.format ?? inferOutputFormat(dims, spec.classes.length);
      checkFormat(fmt, dims, spec.classes.length, 'modelo de recorte');
      crop = { session: s, spec, format: fmt, ctx, tensor };
      cropInfo = { name: spec.name, version: spec.version, outputDims: dims, format: fmt };
    }

    post({
      type: 'loaded',
      info: { backend, threads: backend === 'wasm' ? threads : 0, loadMs: performance.now() - t0, outputDims, format, crop: cropInfo },
    });
  } catch (e) {
    session = null;
    post({
      type: 'error',
      stage: 'load',
      code: e instanceof ModelMissingError ? 'model_missing' : 'load_failed',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function createSession(model: ArrayBuffer, wanted: 'wasm' | 'webgpu') {
  const opts = (ep: string): Ort.InferenceSession.SessionOptions => ({ executionProviders: [ep], graphOptimizationLevel: 'all' });
  if (wanted === 'webgpu' && 'gpu' in navigator) {
    try {
      return { session: await ort!.InferenceSession.create(new Uint8Array(model), opts('webgpu')), backend: 'webgpu' as const };
    } catch {
      // sem WebGPU utilizável: cai para WASM
    }
  }
  return { session: await ort!.InferenceSession.create(new Uint8Array(model), opts('wasm')), backend: 'wasm' as const };
}

function checkFormat(fmt: YoloOutputFormat, dims: number[], nc: number, what: string) {
  if (fmt === 'yolo-raw' && dims[1] !== 4 + nc) {
    throw new Error(`Saída do ${what} [${dims.join(', ')}] não corresponde às ${nc} classes do manifesto.`);
  }
  if (fmt === 'yolo-end2end' && dims[2] !== 6) {
    throw new Error(`Saída do ${what} [${dims.join(', ')}] não é end-to-end [1, N, 6].`);
  }
}

function checkOutputFormat() {
  checkFormat(format, outputDims, manifest!.classes.length, 'modelo');
}

async function runOn(s: Ort.InferenceSession, size: number, data: Float32Array): Promise<Ort.Tensor> {
  const input = new ort!.Tensor('float32', data, [1, 3, size, size]);
  const outputs = await s.run({ [s.inputNames[0]]: input });
  return outputs[s.outputNames[0]];
}

function run(data: Float32Array): Promise<Ort.Tensor> {
  return runOn(session!, manifest!.inputSize, data);
}

/** Desenha a região (sx, sy, sw, sh) do quadro na entrada de um modelo e preenche o tensor. */
function drawInput(
  ctx: OffscreenCanvasRenderingContext2D,
  tensor: Float32Array,
  size: number,
  resize: ResizeMode,
  bitmap: ImageBitmap,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): Letterbox {
  const lb = computeResize(sw, sh, size, resize);
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bitmap, sx, sy, sw, sh, lb.padX, lb.padY, lb.width, lb.height);
  rgbaToChw(ctx.getImageData(0, 0, size, size).data, size, tensor);
  return lb;
}

function prepareInput(bitmap: ImageBitmap, sx: number, sy: number, sw: number, sh: number): Letterbox {
  return drawInput(inputCtx!, tensorData!, manifest!.inputSize, manifest!.resize ?? 'letterbox', bitmap, sx, sy, sw, sh);
}

/**
 * 2ª passada: roda o modelo em recortes da cabeça em resolução nativa e devolve só as detecções
 * de EPI (o sujeito já vem da 1ª passada; recortes parciais da cabeça criariam sujeitos duplicados).
 */
async function refine(bitmap: ImageBitmap, first: Detection[], req: InferRequest, opts: RefineOptions) {
  const allSubjects = first.filter((d) => d.className === opts.subjectClass && d.score >= opts.minSubjectScore);
  const subjects = [...allSubjects].sort((a, b) => b.score - a.score).slice(0, opts.maxCrops);
  const crops: Box[] = [];
  const extra: Detection[] = [];
  let skipped = 0;
  const keepMain = crop?.spec.keepMainClasses ?? [];
  for (const s of subjects) {
    const c = headCrop(s, bitmap.width, bitmap.height, opts.ratio, opts.minSide);
    const w = c.x2 - c.x1;
    const h = c.y2 - c.y1;
    if (w < 8 || h < 8) continue;
    crops.push(c);
    const decodeCrop = (out: Ort.Tensor, lb: Letterbox, fmt: YoloOutputFormat, classNames: string[], keep: (n: string) => boolean) => {
      const dets = decodeYolo(out.data as Float32Array, {
        format: fmt,
        dims: out.dims,
        classNames,
        scoreThreshold: req.scoreThreshold,
        iouThreshold: req.iouThreshold,
        letterbox: lb,
        srcWidth: w,
        srcHeight: h,
      });
      out.dispose?.();
      for (const d of dets) {
        if (d.className === opts.subjectClass || !keep(d.className)) continue;
        extra.push({ ...d, x1: d.x1 + c.x1, y1: d.y1 + c.y1, x2: d.x2 + c.x1, y2: d.y2 + c.y1 });
      }
    };
    if (crop && keepMain.length && keepMain.every((cls) => confirmedInFirstPass(s, cls, first, allSubjects, opts))) {
      skipped++;
    } else if (!crop || keepMain.length) {
      // Modelo principal no recorte: todas as classes (sem cropModel) ou só as mantidas (keepMainClasses).
      const lb = prepareInput(bitmap, c.x1, c.y1, w, h);
      decodeCrop(await run(tensorData!), lb, format, manifest!.classes, (n) => !crop || keepMain.includes(n));
    }
    if (crop) {
      const { spec } = crop;
      const lb = drawInput(crop.ctx, crop.tensor, spec.inputSize, spec.resize ?? 'letterbox', bitmap, c.x1, c.y1, w, h);
      decodeCrop(await runOn(crop.session, spec.inputSize, crop.tensor), lb, crop.format, spec.classes, () => true);
    }
  }
  return { crops, extra, skipped };
}

async function infer(req: InferRequest): Promise<void> {
  const { bitmap } = req;
  try {
    if (!session || !manifest || !inputCtx || !qualityCtx || !tensorData) throw new Error('Modelo não carregado.');
    const t0 = performance.now();
    const srcW = bitmap.width;
    const srcH = bitmap.height;
    const lb = prepareInput(bitmap, 0, 0, srcW, srcH);
    const t1 = performance.now();

    const out = await run(tensorData);
    const t2 = performance.now();

    const data = out.data as Float32Array;
    let detections = decodeYolo(data, {
      format,
      dims: out.dims,
      classNames: manifest.classes,
      scoreThreshold: req.scoreThreshold,
      iouThreshold: req.iouThreshold,
      letterbox: lb,
      srcWidth: srcW,
      srcHeight: srcH,
    });
    const raw: RawOutputStats | undefined = req.debug ? rawStats(data, format, out.dims, manifest.classes.length) : undefined;
    out.dispose?.();

    let crops: Box[] | undefined;
    let mainCropSkipped: number | undefined;
    const tr = performance.now();
    if (crop) {
      // EPIs vêm do modelo de recorte; do principal ficam só o sujeito e as classes de keepMainClasses.
      const keepMain = crop.spec.keepMainClasses ?? [];
      detections = detections.filter((d) => d.className === manifest!.subjectClass || keepMain.includes(d.className));
    }
    if (req.refine) {
      const r = await refine(bitmap, detections, req, req.refine);
      crops = r.crops;
      mainCropSkipped = r.skipped;
      // A mesma peça vista no quadro inteiro e no recorte: o NMS por classe mantém a de maior confiança.
      if (r.extra.length) detections = nms([...detections, ...r.extra], req.iouThreshold);
    }
    const refineMs = req.refine ? performance.now() - tr : undefined;

    const sample = (sx: number, sy: number, sw: number, sh: number): RegionQuality => {
      qualityCtx!.drawImage(bitmap, sx, sy, Math.max(1, sw), Math.max(1, sh), 0, 0, QUALITY_SIZE, QUALITY_SIZE);
      return measureQuality(qualityCtx!.getImageData(0, 0, QUALITY_SIZE, QUALITY_SIZE).data, QUALITY_SIZE, QUALITY_SIZE);
    };
    const subjectQuality: Record<number, RegionQuality> = {};
    detections.forEach((d, i) => {
      if (manifest!.subjectClass && d.className === manifest!.subjectClass) {
        subjectQuality[i] = sample(d.x1, d.y1, d.x2 - d.x1, d.y2 - d.y1);
      }
    });
    const frameQuality = sample(0, 0, srcW, srcH);
    const t3 = performance.now();

    const result: FrameResult = {
      frameWidth: srcW,
      frameHeight: srcH,
      detections,
      subjectQuality,
      frameQuality,
      timings: { preprocessMs: t1 - t0, inferenceMs: t2 - t1, postprocessMs: t3 - t2 - (refineMs ?? 0), totalMs: t3 - t0, refineMs },
      timestamp: Date.now(),
      raw,
      crops,
      mainCropSkipped,
    };
    post({ type: 'result', id: req.id, result });
  } catch (e) {
    post({ type: 'error', id: req.id, stage: 'infer', code: 'infer_failed', message: e instanceof Error ? e.message : String(e) });
  } finally {
    bitmap.close();
  }
}

// Mensagens são processadas em fila para nunca executar duas sessões ao mesmo tempo.
let queue = Promise.resolve();
self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  queue = queue.then(() => (msg.type === 'load' ? load(msg) : infer(msg)));
};
