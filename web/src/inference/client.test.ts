import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frame, PPE_MANIFEST } from '../test/fixtures';
import { InferenceClient, InferenceError } from './client';
import type { WorkerRequest, WorkerResponse } from './protocol';

class FakeWorker {
  onmessage: ((ev: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  sent: WorkerRequest[] = [];
  terminated = false;
  postMessage(msg: WorkerRequest) {
    this.sent.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  reply(msg: WorkerResponse) {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>);
  }
}

const bitmap = () => ({ close: vi.fn(), width: 640, height: 480 }) as unknown as ImageBitmap;

describe('cliente de inferência', () => {
  let w: FakeWorker;
  let client: InferenceClient;
  beforeEach(() => {
    vi.useFakeTimers();
    w = new FakeWorker();
    client = new InferenceClient(() => w);
  });
  afterEach(() => vi.useRealTimers());

  it('carrega o modelo e devolve informações do runtime', async () => {
    const p = client.load(PPE_MANIFEST, { url: 'models/x.onnx' }, 'wasm');
    expect(w.sent[0]).toMatchObject({ type: 'load', modelUrl: 'models/x.onnx', backend: 'wasm' });
    w.reply({ type: 'loaded', info: { backend: 'wasm', threads: 4, loadMs: 50, outputDims: [1, 8, 2100], format: 'yolo-raw' } });
    await expect(p).resolves.toMatchObject({ backend: 'wasm', threads: 4 });
  });

  it('arquivo de modelo ausente gera erro model_missing', async () => {
    const p = client.load(PPE_MANIFEST, { url: 'models/x.onnx' }, 'wasm');
    w.reply({ type: 'error', stage: 'load', code: 'model_missing', message: 'não encontrado' });
    await expect(p).rejects.toMatchObject({ code: 'model_missing' });
  });

  it('resolve a inferência correspondente ao id', async () => {
    const p = client.infer(bitmap(), 0.1, 0.45);
    const id = (w.sent[0] as { id: number }).id;
    const result = frame([]);
    w.reply({ type: 'result', id, result });
    await expect(p).resolves.toBe(result);
  });

  it('falha de inferência é propagada', async () => {
    const p = client.infer(bitmap(), 0.1, 0.45);
    w.reply({ type: 'error', id: 1, stage: 'infer', code: 'infer_failed', message: 'boom' });
    await expect(p).rejects.toBeInstanceOf(InferenceError);
  });

  it('expira após o timeout', async () => {
    const p = client.infer(bitmap(), 0.1, 0.45, 500);
    vi.advanceTimersByTime(600);
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
  });

  it('queda do worker rejeita tudo o que estava pendente', async () => {
    const p = client.infer(bitmap(), 0.1, 0.45);
    w.onerror?.({ message: 'crash' } as ErrorEvent);
    await expect(p).rejects.toMatchObject({ code: 'worker_crashed' });
  });
});
