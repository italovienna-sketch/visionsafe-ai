import type { ModelManifest } from '../core/manifest';
import type { FrameResult } from '../core/types';
import type { LoadInfo, RefineOptions, WorkerRequest, WorkerResponse } from './protocol';

export class InferenceError extends Error {
  constructor(
    message: string,
    readonly code: 'model_missing' | 'load_failed' | 'infer_failed' | 'timeout' | 'worker_crashed' | 'terminated',
  ) {
    super(message);
  }
}

type WorkerLike = Pick<Worker, 'postMessage' | 'terminate'> & {
  onmessage: ((ev: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
};

/** Fachada da thread principal para o worker de inferência (uma requisição por vez). */
export class InferenceClient {
  private worker: WorkerLike;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: FrameResult) => void; reject: (e: Error) => void; timer: number }>();
  private loadWaiter: { resolve: (i: LoadInfo) => void; reject: (e: Error) => void } | null = null;
  private onProgress: ((loaded: number, total: number) => void) | null = null;

  constructor(factory: () => WorkerLike = defaultWorkerFactory) {
    this.worker = factory();
    this.worker.onmessage = (ev) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => this.failAll(new InferenceError(ev.message || 'Worker de inferência falhou.', 'worker_crashed'));
  }

  load(
    manifest: ModelManifest,
    source: { url: string; cropUrl?: string } | { buffer: ArrayBuffer },
    backend: 'wasm' | 'webgpu',
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<LoadInfo> {
    this.loadWaiter?.reject(new InferenceError('Carregamento substituído.', 'terminated'));
    this.onProgress = onProgress ?? null;
    return new Promise((resolve, reject) => {
      this.loadWaiter = { resolve, reject };
      const msg: WorkerRequest = {
        type: 'load',
        manifest,
        backend,
        ...('url' in source ? { modelUrl: source.url, cropModelUrl: source.cropUrl } : { modelBuffer: source.buffer.slice(0) }),
      };
      this.worker.postMessage(msg);
    });
  }

  /** Envia um quadro (o bitmap é transferido e fechado pelo worker). */
  infer(
    bitmap: ImageBitmap,
    scoreThreshold: number,
    iouThreshold: number,
    timeoutMs = 15000,
    debug = false,
    refine?: RefineOptions,
  ): Promise<FrameResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new InferenceError(`Inferência excedeu ${timeoutMs} ms.`, 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const msg: WorkerRequest = { type: 'infer', id, bitmap, scoreThreshold, iouThreshold, debug, refine };
      this.worker.postMessage(msg, [bitmap]);
    });
  }

  terminate(): void {
    this.worker.terminate();
    this.failAll(new InferenceError('Worker encerrado.', 'terminated'));
  }

  private onMessage(msg: WorkerResponse) {
    if (msg.type === 'progress') {
      this.onProgress?.(msg.loaded, msg.total);
    } else if (msg.type === 'loaded') {
      this.loadWaiter?.resolve(msg.info);
      this.loadWaiter = null;
    } else if (msg.type === 'result') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(msg.result);
    } else if (msg.stage === 'load') {
      this.loadWaiter?.reject(new InferenceError(msg.message, msg.code));
      this.loadWaiter = null;
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.reject(new InferenceError(msg.message, msg.code));
    }
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.loadWaiter?.reject(err);
    this.loadWaiter = null;
  }
}

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}
