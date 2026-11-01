import { iou, unletterbox, type Letterbox } from './geometry';
import type { Box, Detection, RawOutputStats } from './types';

/**
 * Formatos de saída suportados:
 * - yolo-raw: tensor [1, 4+nc, N] (YOLOv8/YOLO11 exportados pela Ultralytics), caixas cx,cy,w,h
 *   em pixels de entrada e escores por classe já com sigmoid. Requer NMS.
 * - yolo-end2end: tensor [1, N, 6] com x1,y1,x2,y2,score,classe (YOLO26/YOLOv10, sem NMS).
 */
export type YoloOutputFormat = 'yolo-raw' | 'yolo-end2end';

export function inferOutputFormat(dims: readonly number[], numClasses: number): YoloOutputFormat {
  if (dims.length !== 3) throw new Error(`Saída do modelo com ${dims.length} dimensões; esperado 3.`);
  if (dims[1] === 4 + numClasses) return 'yolo-raw';
  if (dims[2] === 6) return 'yolo-end2end';
  throw new Error(
    `Formato de saída [${dims.join(', ')}] incompatível com ${numClasses} classes declaradas no manifesto.`,
  );
}

export interface DecodeOptions {
  format: YoloOutputFormat;
  dims: readonly number[];
  classNames: readonly string[];
  /** Escore mínimo para manter um candidato (antes da decisão por classe). */
  scoreThreshold: number;
  iouThreshold: number;
  letterbox: Letterbox;
  srcWidth: number;
  srcHeight: number;
  maxDetections?: number;
}

export function decodeYolo(data: Float32Array, opts: DecodeOptions): Detection[] {
  const nc = opts.classNames.length;
  const candidates: Detection[] = [];
  const push = (box: Box, classIndex: number, score: number) => {
    const b = unletterbox(box, opts.letterbox, opts.srcWidth, opts.srcHeight);
    if (b.x2 - b.x1 < 1 || b.y2 - b.y1 < 1) return;
    candidates.push({ ...b, classIndex, className: opts.classNames[classIndex] ?? `class_${classIndex}`, score });
  };

  if (opts.format === 'yolo-raw') {
    const n = opts.dims[2];
    for (let i = 0; i < n; i++) {
      let best = -1;
      let bestScore = opts.scoreThreshold;
      for (let c = 0; c < nc; c++) {
        const s = data[(4 + c) * n + i];
        if (s >= bestScore) {
          bestScore = s;
          best = c;
        }
      }
      if (best < 0) continue;
      const cx = data[i];
      const cy = data[n + i];
      const w = data[2 * n + i];
      const h = data[3 * n + i];
      push({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 }, best, bestScore);
    }
    return nms(candidates, opts.iouThreshold, opts.maxDetections ?? 100);
  }

  const n = opts.dims[1];
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const score = data[o + 4];
    if (score < opts.scoreThreshold) continue;
    const cls = Math.round(data[o + 5]);
    if (cls < 0 || cls >= nc) continue;
    push({ x1: data[o], y1: data[o + 1], x2: data[o + 2], y2: data[o + 3] }, cls, score);
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, opts.maxDetections ?? 100);
}

/**
 * Resumo da saída bruta do modelo (antes de limiar/NMS), para diagnóstico:
 * maior escore de cada classe e quantos candidatos passariam de 0,25.
 */
export function rawStats(data: Float32Array, format: YoloOutputFormat, dims: readonly number[], numClasses: number): RawOutputStats {
  const maxPerClass = new Array<number>(numClasses).fill(0);
  let above025 = 0;
  if (format === 'yolo-raw') {
    const n = dims[2];
    for (let c = 0; c < numClasses; c++) {
      for (let i = 0; i < n; i++) {
        const s = data[(4 + c) * n + i];
        if (s > maxPerClass[c]) maxPerClass[c] = s;
        if (s >= 0.25) above025++;
      }
    }
  } else {
    for (let i = 0; i < dims[1]; i++) {
      const s = data[i * 6 + 4];
      const c = Math.round(data[i * 6 + 5]);
      if (c >= 0 && c < numClasses && s > maxPerClass[c]) maxPerClass[c] = s;
      if (s >= 0.25) above025++;
    }
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  return { dims: [...dims], format, maxPerClass, candidatesAbove025: above025, valueRange: [min, max] };
}

/** NMS por classe (caixas de classes diferentes não se suprimem). */
export function nms(dets: Detection[], iouThreshold: number, maxDetections = 100): Detection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const d of sorted) {
    if (kept.length >= maxDetections) break;
    if (kept.some((k) => k.classIndex === d.classIndex && iou(k, d) > iouThreshold)) continue;
    kept.push(d);
  }
  return kept;
}

/**
 * Converte RGBA (ImageData já com letterbox) em tensor float32 NCHW normalizado 0..1.
 * As bordas do letterbox devem ter sido pintadas com cinza 114 (padrão Ultralytics).
 */
export function rgbaToChw(rgba: Uint8ClampedArray, size: number, out?: Float32Array): Float32Array {
  const plane = size * size;
  const t = out ?? new Float32Array(3 * plane);
  for (let i = 0, p = 0; p < plane; i += 4, p++) {
    t[p] = rgba[i] / 255;
    t[plane + p] = rgba[i + 1] / 255;
    t[2 * plane + p] = rgba[i + 2] / 255;
  }
  return t;
}

