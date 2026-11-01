import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { det, frame, GLASSES, HEAD, PPE_MANIFEST } from '../test/fixtures';
import type { FrameResult } from '../core/types';
import { InferenceError } from '../inference/client';
import { ManifestMissing, MonitorController, type ControllerDeps } from './MonitorController';

function fakeStream() {
  const track = {
    stop: vi.fn(),
    label: 'Câmera traseira',
    getSettings: () => ({ facingMode: 'environment', width: 640, height: 480, deviceId: 'cam1' }),
    addEventListener: vi.fn(),
  };
  return { stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream, track };
}

function fakeClient(infer: (b: ImageBitmap, score?: number, iou?: number, timeoutMs?: number, debug?: boolean) => Promise<FrameResult>) {
  return {
    load: vi.fn(async () => ({ backend: 'wasm', threads: 1, loadMs: 1, outputDims: [1, 8, 2100], format: 'yolo-raw' })),
    infer: vi.fn(infer),
    terminate: vi.fn(),
  };
}

const bitmap = () => ({ close: vi.fn(), width: 640, height: 480 }) as unknown as ImageBitmap;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function makeController(deps: Partial<ControllerDeps>) {
  const c = new MonitorController({
    storage: null,
    baseUrl: 'http://localhost/',
    fetchJson: async () => PPE_MANIFEST,
    listCameras: async () => [],
    grabFrame: async () => bitmap(),
    ...deps,
  });
  Object.defineProperty(c.video, 'readyState', { value: 4 });
  Object.defineProperty(c.video, 'videoWidth', { value: 640 });
  Object.defineProperty(c.video, 'videoHeight', { value: 480 });
  return c;
}

describe('MonitorController', () => {
  beforeEach(() => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: vi.fn() } });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sem manifesto: fica "aguardando modelo" e nunca inventa detecções', async () => {
    const c = makeController({
      fetchJson: async () => {
        throw new ManifestMissing('404');
      },
    });
    await c.loadServerModel();
    const s = c.getSnapshot();
    expect(s.model).toMatchObject({ state: 'none', errorCode: 'model_missing', error: null });
    expect(Object.values(s.decisions).every((d) => d.status === 'CAMERA_UNAVAILABLE')).toBe(true);
  });

  it('falha de rede ao buscar o manifesto é um erro visível', async () => {
    const c = makeController({
      fetchJson: async () => {
        throw new Error('HTTP 500');
      },
    });
    await c.loadServerModel();
    expect(c.getSnapshot().model).toMatchObject({ state: 'error', error: 'HTTP 500' });
  });

  it('modelo de recorte novo que não carrega: usa o anterior (cropModelFallback) e avisa', async () => {
    const crop = { name: 'ppe-crop', version: '0.4.0', file: 'new.onnx', inputSize: 416, classes: ['hairnet'], ppeClassMap: { hairnet: 'hairnet' } };
    const m = {
      ...PPE_MANIFEST,
      classes: ['face', 'glasses'],
      subjectClass: 'face',
      ppeClassMap: { glasses: 'safety_glasses' },
      cropModel: crop,
      cropModelFallback: { ...crop, version: '0.3.0', file: 'old.onnx' },
    };
    const clients = [fakeClient(async () => frame([])), fakeClient(async () => frame([]))];
    clients[0].load.mockRejectedValueOnce(new Error('protobuf parsing failed'));
    let n = 0;
    const c = makeController({ fetchJson: async () => m, createClient: () => clients[n++] });
    await c.loadServerModel();
    const s = c.getSnapshot();
    expect(s.model.state).toBe('ready');
    expect(s.model.manifest?.cropModel?.version).toBe('0.3.0');
    expect((clients[1].load.mock.calls[0] as unknown[])[1]).toMatchObject({ cropUrl: expect.stringContaining('old.onnx?v=0.3.0') });
    expect(s.model.fallbackNote).toMatch(/0\.4\.0.*protobuf parsing failed.*0\.3\.0/);
  });

  it('arquivo .onnx ausente: estado "none" com código model_missing', async () => {
    const client = fakeClient(async () => frame([]));
    client.load.mockRejectedValueOnce(new InferenceError('Arquivo de modelo não encontrado', 'model_missing'));
    const c = makeController({ createClient: () => client });
    await c.loadServerModel();
    expect(c.getSnapshot().model).toMatchObject({ state: 'none', errorCode: 'model_missing' });
  });

  it('manifesto inválido gera erro claro', async () => {
    const c = makeController({ fetchJson: async () => ({ ...PPE_MANIFEST, inputSize: 7 }) });
    await c.loadServerModel();
    expect(c.getSnapshot().model.state).toBe('error');
    expect(c.getSnapshot().model.error).toMatch(/inputSize/);
  });

  it('permissão de câmera negada vira erro de câmera e status indisponível', async () => {
    const c = makeController({
      openCamera: async () => {
        throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      },
    });
    await c.startCamera();
    const s = c.getSnapshot();
    expect(s.camera.state).toBe('error');
    expect(s.camera.error?.kind).toBe('permission_denied');
    expect(s.decisions.hairnet).toMatchObject({ status: 'CAMERA_UNAVAILABLE', reason: 'camera_error' });
  });

  it('inicia uma única vez, roda inferência real do cliente e libera a câmera ao parar', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const client = fakeClient(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(5);
      inFlight--;
      return frame([det('head', HEAD, 0.9), det('safety_glasses', GLASSES, 0.9)]);
    });
    const { stream, track } = fakeStream();
    const open = vi.fn(async () => stream);
    const c = makeController({ createClient: () => client, openCamera: open });
    await c.loadServerModel();
    c.updateSettings({ inferenceIntervalMs: 0 });
    await Promise.all([c.startCamera(), c.startCamera()]);
    // Espera até haver observações positivas suficientes (o tempo de timers varia entre máquinas).
    await vi.waitFor(() => expect(c.getSnapshot().decisions.safety_glasses.status).toBe('DETECTED'), { timeout: 3000 });
    expect(open).toHaveBeenCalledTimes(1);
    expect(client.infer.mock.calls.length).toBeGreaterThan(2);
    expect(maxInFlight).toBe(1);
    expect(c.getSnapshot().decisions.hairnet.status).toBe('UNCERTAIN');
    c.stopCamera();
    expect(track.stop).toHaveBeenCalled();
    const calls = client.infer.mock.calls.length;
    await tick(40);
    expect(client.infer.mock.calls.length).toBeLessThanOrEqual(calls + 1);
    expect(c.getSnapshot().decisions.safety_glasses.reason).toBe('camera_off');
  });

  it('falha de inferência é exibida e invalida as decisões', async () => {
    const client = fakeClient(async () => {
      throw new InferenceError('falhou', 'infer_failed');
    });
    const c = makeController({ createClient: () => client, openCamera: async () => fakeStream().stream });
    await c.loadServerModel();
    await c.startCamera();
    await tick(20);
    expect(c.getSnapshot().inferenceError).toBe('falhou');
    expect(c.getSnapshot().decisions.safety_glasses).toMatchObject({ status: 'CAMERA_UNAVAILABLE', reason: 'inference_error' });
    c.stopCamera();
  });

  it('pipeline completo: ausência confirmada gera um alerta e registra amostra de avaliação', async () => {
    let now = 0;
    const c = makeController({ createClient: () => fakeClient(async () => frame([])), now: () => now });
    await c.loadServerModel();
    c.setTruth('hairnet', false);
    c.setRecording(true);
    const withGlasses = frame([det('head', HEAD, 0.9), det('safety_glasses', GLASSES, 0.9)]);
    for (let i = 0; i < 40; i++) {
      now = i * 200;
      c.handleResult(withGlasses, 20);
    }
    const s = c.getSnapshot();
    expect(s.decisions.safety_glasses.status).toBe('DETECTED');
    expect(s.decisions.hairnet.status).toBe('NOT_DETECTED');
    expect(s.alerts.filter((a) => a.cls === 'hairnet')).toHaveLength(1);
    expect(s.evaluation.samples.some((x) => x.cls === 'hairnet' && x.status === 'NOT_DETECTED' && x.truth === false)).toBe(true);
    expect(c.metrics().hairnet.tn).toBeGreaterThan(0);
  });

  it('classe não mapeada pelo modelo aparece como indisponível, nunca como ausente', async () => {
    const m = { ...PPE_MANIFEST, ppeClassMap: { safety_glasses: 'safety_glasses' as const } };
    let now = 0;
    const c = makeController({ fetchJson: async () => m, createClient: () => fakeClient(async () => frame([])), now: () => now });
    await c.loadServerModel();
    for (let i = 0; i < 40; i++) {
      now = i * 200;
      c.handleResult(frame([det('head', HEAD, 0.9)]), 20);
    }
    expect(c.getSnapshot().decisions.hairnet).toMatchObject({ status: 'CAMERA_UNAVAILABLE', reason: 'class_unsupported' });
    expect(c.getSnapshot().alerts.every((a) => a.cls === 'safety_glasses')).toBe(true);
  });

  it('classe aproximada desativada pelo usuário deixa de ser analisada', async () => {
    const m = { ...PPE_MANIFEST, proxyClasses: { safety_glasses: 'óculos comuns' } };
    let now = 0;
    const c = makeController({ fetchJson: async () => m, createClient: () => fakeClient(async () => frame([])), now: () => now });
    await c.loadServerModel();
    c.updateSettings({ allowProxy: { safety_glasses: false, hearing_protection: true, hairnet: true } });
    for (let i = 0; i < 40; i++) {
      now = i * 200;
      c.handleResult(frame([det('head', HEAD, 0.9)]), 20);
    }
    const s = c.getSnapshot();
    expect(s.decisions.safety_glasses).toMatchObject({ status: 'CAMERA_UNAVAILABLE', reason: 'proxy_disabled' });
    expect(s.decisions.hairnet.status).toBe('NOT_DETECTED');
    expect(s.alerts.some((a) => a.cls === 'safety_glasses')).toBe(false);
  });

  it('pausar mantém a câmera aberta, interrompe a inferência e retomar reinicia a verificação', async () => {
    const client = fakeClient(async () => {
      await tick(2);
      return frame([det('head', HEAD, 0.9), det('safety_glasses', GLASSES, 0.9)]);
    });
    const { stream, track } = fakeStream();
    const c = makeController({ createClient: () => client, openCamera: async () => stream });
    await c.loadServerModel();
    c.updateSettings({ inferenceIntervalMs: 0 });
    await c.startCamera();
    await vi.waitFor(() => expect(client.infer.mock.calls.length).toBeGreaterThan(1));
    c.pause();
    const calls = client.infer.mock.calls.length;
    await tick(40);
    expect(client.infer.mock.calls.length).toBeLessThanOrEqual(calls + 1);
    expect(track.stop).not.toHaveBeenCalled();
    expect(c.getSnapshot().camera.state).toBe('running');
    expect(c.getSnapshot().decisions.safety_glasses).toMatchObject({ status: 'CAMERA_UNAVAILABLE', reason: 'paused' });
    c.resume();
    await vi.waitFor(() => expect(c.getSnapshot().decisions.safety_glasses.status).toBe('DETECTED'), { timeout: 3000 });
    c.stopCamera();
    expect(c.getSnapshot().paused).toBe(false);
  });

  it('diagnóstico com imagem roda o modelo uma vez pedindo estatísticas brutas', async () => {
    const client = fakeClient(async () => frame([det('head', HEAD, 0.9)]));
    const c = makeController({ createClient: () => client, decodeImage: async () => bitmap() });
    await expect(c.diagnoseImage(new Blob())).rejects.toThrow(/Nenhum modelo/);
    await c.loadServerModel();
    const r = await c.diagnoseImage(new Blob());
    expect(r.detections).toHaveLength(1);
    expect(client.infer).toHaveBeenCalledTimes(1);
    expect(client.infer.mock.calls[0][4]).toBe(true);
    expect(c.getSnapshot().frame).toBeNull();
  });
});
