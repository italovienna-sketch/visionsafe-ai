import { AlertManager, type AlertEvent } from '../core/alerts';
import { computeMetrics, type EvalSample, type GroundTruth } from '../core/evaluation';
import { activeTargets, supportedTargets, validateManifest, type ModelManifest } from '../core/manifest';
import { effectiveSettings, loadSettings, saveSettings, sanitizeSettings, type Settings } from '../core/settings';
import { noSubjectDecision, unavailableDecision, VerificationEngine } from '../core/statusEngine';
import { analyzeFrame, classifyObservation, SubjectTracker, type FrameAnalysis } from '../core/subjects';
import { PPE_CLASSES, type DecisionMap, type FrameResult, type PpeClass, type UnavailableReason } from '../core/types';
import { Beeper } from '../audio/beeper';
import { checkCameraSupport, listCameras, mapCameraError, openCamera, stopStream, type CameraErrorInfo } from '../camera/camera';
import { InferenceClient, InferenceError } from '../inference/client';
import type { LoadInfo, RefineOptions } from '../inference/protocol';

/**
 * Recorte da cabeça para a 2ª passada: lado = HEAD_CROP_RATIO × maior lado do rosto/cabeça.
 * Valores escolhidos pela varredura de training/distance_benchmark.py (ver docs/DISTANCIA.md).
 */
const HEAD_CROP_RATIO = 5;
const HEAD_CROP_MIN_SIDE = 96;

export type CameraState = 'idle' | 'requesting' | 'running' | 'error';
export type ModelState = 'none' | 'loading' | 'ready' | 'error';

export interface FrameView {
  result: FrameResult;
  analysis: FrameAnalysis;
  trackIds: number[];
  perTrack: Record<number, DecisionMap>;
}

export interface MonitorSnapshot {
  camera: {
    state: CameraState;
    error: CameraErrorInfo | null;
    facing: 'environment' | 'user' | 'unknown';
    label: string;
    devices: { deviceId: string; label: string }[];
    width: number;
    height: number;
    pausedByVisibility: boolean;
  };
  /** Monitoramento pausado pelo usuário: câmera continua aberta, sem inferência. */
  paused: boolean;
  model: {
    state: ModelState;
    manifest: ModelManifest | null;
    info: LoadInfo | null;
    error: string | null;
    errorCode: string | null;
    source: 'server' | 'file' | null;
    /** Progresso do download do arquivo .onnx (bytes). */
    progress: { loaded: number; total: number } | null;
    /** Preenchido quando o modelo de recorte atual falhou e o anterior (cropModelFallback) foi carregado no lugar. */
    fallbackNote: string | null;
  };
  inferenceError: string | null;
  frame: FrameView | null;
  primaryTrackId: number | null;
  decisions: DecisionMap;
  fps: number;
  latencyMs: number;
  alerts: AlertEvent[];
  soundReady: boolean;
  settings: Settings;
  evaluation: {
    truth: GroundTruth;
    recording: boolean;
    scenario: number;
    samples: EvalSample[];
    latencies: number[];
  };
}

export interface ControllerDeps {
  openCamera: typeof openCamera;
  listCameras: typeof listCameras;
  createClient: () => Pick<InferenceClient, 'load' | 'infer' | 'terminate'>;
  grabFrame: (video: HTMLVideoElement) => Promise<ImageBitmap>;
  decodeImage: (image: Blob) => Promise<ImageBitmap>;
  fetchJson: (url: string) => Promise<unknown>;
  now: () => number;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  baseUrl: string;
}

const EVAL_KEY = 'visionsafe.evaluation.v1';
const MAX_SAMPLES = 20000;
const MAX_LATENCIES = 2000;
const SAMPLE_PERIOD_MS = 1000;
const STALE_MS = 3000;
const TRACK_TTL_FRAMES = 2.5;

export class ManifestMissing extends Error {}

function unsupportedReason(m: ModelManifest, cls: PpeClass): UnavailableReason {
  return supportedTargets(m).has(cls) && m.proxyClasses?.[cls] ? 'proxy_disabled' : 'class_unsupported';
}

function allDecisions(reason: UnavailableReason): DecisionMap {
  return Object.fromEntries(PPE_CLASSES.map((c) => [c, unavailableDecision(reason)])) as DecisionMap;
}

function defaultDeps(): ControllerDeps {
  return {
    openCamera,
    listCameras,
    createClient: () => new InferenceClient(),
    grabFrame: (v) => createImageBitmap(v),
    decodeImage: (b) => createImageBitmap(b),
    fetchJson: async (url) => {
      const r = await fetch(url, { cache: 'no-cache' });
      if (r.status === 404) throw new ManifestMissing('manifest.json não encontrado');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      try {
        return await r.json();
      } catch {
        // Servidores de desenvolvimento devolvem index.html para arquivos inexistentes.
        throw new ManifestMissing('manifest.json não encontrado');
      }
    },
    now: () => performance.now(),
    storage: typeof localStorage !== 'undefined' ? localStorage : null,
    baseUrl: new URL('./', document.baseURI).href,
  };
}

/**
 * Orquestra câmera -> inferência -> associação -> verificação -> alertas.
 * Independente de React: a interface assina mudanças via subscribe/getSnapshot.
 */
export class MonitorController {
  readonly video: HTMLVideoElement;
  private deps: ControllerDeps;
  private listeners = new Set<() => void>();
  private snap: MonitorSnapshot;
  private stream: MediaStream | null = null;
  private client: Pick<InferenceClient, 'load' | 'infer' | 'terminate'> | null = null;
  private loopToken = 0;
  private engine = new VerificationEngine();
  private tracker = new SubjectTracker();
  private alertMgr: AlertManager;
  private beeper = new Beeper();
  private lastResultAt = 0;
  private lastSampleAt = -Infinity;
  private staleTimer: number | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private persistTimer: number | null = null;

  constructor(deps: Partial<ControllerDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
    const settings = this.deps.storage === localStorage ? loadSettings() : sanitizeSettings(null);
    this.alertMgr = new AlertManager(settings.alertCooldownMs, settings.alertGlobalGapMs);
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('aria-label', 'Imagem ao vivo da câmera');
    const stored = this.loadEvaluation();
    this.snap = {
      camera: { state: 'idle', error: null, facing: 'unknown', label: '', devices: [], width: 0, height: 0, pausedByVisibility: false },
      paused: false,
      model: { state: 'none', manifest: null, info: null, error: null, errorCode: null, source: null, progress: null, fallbackNote: null },
      inferenceError: null,
      frame: null,
      primaryTrackId: null,
      decisions: allDecisions('camera_off'),
      fps: 0,
      latencyMs: 0,
      alerts: [],
      soundReady: false,
      settings,
      evaluation: {
        truth: { safety_glasses: null, hearing_protection: null, hairnet: null },
        recording: false,
        scenario: stored.scenario,
        samples: stored.samples,
        latencies: [],
      },
    };
  }

  // ----------------------------------------------------------------- store
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;

  private set(patch: Partial<MonitorSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }
  private setCamera(patch: Partial<MonitorSnapshot['camera']>) {
    this.set({ camera: { ...this.snap.camera, ...patch } });
  }
  private setModel(patch: Partial<MonitorSnapshot['model']>) {
    this.set({ model: { ...this.snap.model, ...patch } });
  }

  // ----------------------------------------------------------------- modelo
  /** Carrega models/manifest.json do servidor. Ausência não é erro: o app fica "aguardando modelo". */
  async loadServerModel(): Promise<void> {
    this.setModel({ state: 'loading', error: null, errorCode: null });
    this.refreshDecisions();
    let manifest: ModelManifest;
    try {
      manifest = validateManifest(await this.deps.fetchJson(new URL('models/manifest.json', this.deps.baseUrl).href));
    } catch (e) {
      const missing = e instanceof ManifestMissing;
      this.setModel({
        state: missing ? 'none' : 'error',
        manifest: null,
        info: null,
        error: missing ? null : e instanceof Error ? e.message : String(e),
        errorCode: missing ? 'model_missing' : 'manifest_invalid',
      });
      this.refreshDecisions();
      return;
    }
    // A versão entra na URL: trocar o .onnx mantendo o nome não reaproveita o arquivo antigo do cache.
    const url = (f: string, v: string) => new URL(`models/${f}?v=${encodeURIComponent(v)}`, this.deps.baseUrl).href;
    const crop = manifest.cropModel;
    const ok = await this.loadModel(manifest, { url: url(manifest.file, manifest.version), cropUrl: crop && url(crop.file, crop.version) }, 'server');
    const fb = manifest.fallback;
    if (ok || !crop || !fb?.cropModel) return;
    const reason = this.snap.model.error;
    if (await this.loadModel(fb, { url: url(fb.file, fb.version), cropUrl: url(fb.cropModel.file, fb.cropModel.version) }, 'server')) {
      this.setModel({
        fallbackNote: `O modelo de EPI ${crop.name} v${crop.version} não carregou (${reason}). Em uso: versão anterior ${fb.cropModel.name} v${fb.cropModel.version}.`,
      });
    }
  }

  /** Carrega um modelo escolhido pelo usuário (arquivos locais — nada é enviado à rede). */
  async loadLocalModel(onnx: File, manifestFile: File): Promise<void> {
    this.setModel({ state: 'loading', error: null, errorCode: null });
    let manifest: ModelManifest;
    try {
      manifest = validateManifest(JSON.parse(await manifestFile.text()));
    } catch (e) {
      this.setModel({ state: 'error', error: e instanceof Error ? e.message : String(e), errorCode: 'manifest_invalid' });
      this.refreshDecisions();
      return;
    }
    if (manifest.cropModel) {
      const error = 'Este manifesto usa dois modelos (rosto + recorte). Carregamento por arquivo aceita um só; publique-os em models/.';
      this.setModel({ state: 'error', error, errorCode: 'manifest_invalid' });
      this.refreshDecisions();
      return;
    }
    await this.loadModel(manifest, { buffer: await onnx.arrayBuffer() }, 'file');
  }

  private async loadModel(
    manifest: ModelManifest,
    source: { url: string; cropUrl?: string } | { buffer: ArrayBuffer },
    origin: 'server' | 'file',
  ): Promise<boolean> {
    const wasRunning = this.snap.camera.state === 'running';
    this.stopLoop();
    this.client?.terminate();
    this.client = this.deps.createClient();
    this.setModel({ state: 'loading', manifest, info: null, error: null, errorCode: null, source: origin, progress: null, fallbackNote: null });
    this.resetVerification();
    try {
      const info = await this.client.load(manifest, source, this.snap.settings.backend, (loaded, total) =>
        this.setModel({ progress: { loaded, total } }),
      );
      this.setModel({ state: 'ready', info });
      if (wasRunning || this.snap.camera.state === 'running') this.startLoop();
      this.refreshDecisions();
      return true;
    } catch (e) {
      const code = e instanceof InferenceError ? e.code : 'load_failed';
      this.setModel({ state: code === 'model_missing' ? 'none' : 'error', error: e instanceof Error ? e.message : String(e), errorCode: code });
      this.refreshDecisions();
      return false;
    }
  }

  // ----------------------------------------------------------------- câmera
  async startCamera(): Promise<void> {
    if (this.snap.camera.state === 'requesting' || this.snap.camera.state === 'running') return;
    const unsupported = checkCameraSupport();
    if (unsupported) {
      this.setCamera({ state: 'error', error: unsupported });
      this.refreshDecisions();
      return;
    }
    this.setCamera({ state: 'requesting', error: null, pausedByVisibility: false });
    this.set({ paused: false });
    try {
      const s = this.snap.settings;
      const stream = await this.deps.openCamera({ deviceId: s.deviceId, facing: s.preferredFacing });
      // O estado pode ter mudado durante o await (usuário parou ou saiu da página).
      if ((this.snap.camera.state as CameraState) !== 'requesting') {
        stopStream(stream); // parado enquanto a permissão era solicitada
        return;
      }
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play().catch(() => undefined);
      await this.waitForVideo();
      const track = stream.getVideoTracks()[0];
      const ts = track?.getSettings?.() ?? {};
      track?.addEventListener('ended', () => this.handleTrackEnded());
      const devices = (await this.deps.listCameras().catch(() => [])).map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Câmera ${i + 1}` }));
      this.setCamera({
        state: 'running',
        facing: ts.facingMode === 'user' || ts.facingMode === 'environment' ? ts.facingMode : 'unknown',
        label: track?.label ?? '',
        devices,
        width: this.video.videoWidth || ts.width || 0,
        height: this.video.videoHeight || ts.height || 0,
      });
      this.requestWakeLock();
      this.startStaleWatch();
      this.startLoop();
    } catch (e) {
      stopStream(this.stream);
      this.stream = null;
      this.setCamera({ state: 'error', error: mapCameraError(e) });
    }
    this.refreshDecisions();
  }

  stopCamera(pausedByVisibility = false): void {
    this.stopLoop();
    stopStream(this.stream);
    this.stream = null;
    this.video.srcObject = null;
    this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
    if (this.staleTimer !== null) clearInterval(this.staleTimer);
    this.staleTimer = null;
    this.resetVerification();
    this.setCamera({ state: 'idle', error: null, pausedByVisibility });
    this.set({ frame: null, fps: 0, primaryTrackId: null, inferenceError: null, paused: false });
    this.refreshDecisions();
  }

  /** Pausa a análise mantendo a câmera aberta (útil para reposicionar o celular). */
  pause(): void {
    if (this.snap.camera.state !== 'running' || this.snap.paused) return;
    this.stopLoop();
    this.resetVerification();
    this.set({ paused: true, frame: null, fps: 0, primaryTrackId: null });
    this.refreshDecisions();
  }

  resume(): void {
    if (!this.snap.paused) return;
    this.set({ paused: false });
    this.refreshDecisions();
    this.startLoop();
  }

  /**
   * Diagnóstico com imagem conhecida: roda o modelo uma vez sobre a imagem e devolve
   * detecções decodificadas + estatísticas da saída bruta. Não altera o estado do monitoramento.
   */
  async diagnoseImage(image: Blob): Promise<FrameResult> {
    if (this.snap.model.state !== 'ready' || !this.client) throw new Error('Nenhum modelo carregado.');
    const bitmap = await this.deps.decodeImage(image);
    const s = this.snap.settings;
    return this.client.infer(bitmap, s.detectorScoreFloor, s.nmsIou, 30000, true, this.refineOptions());
  }

  /**
   * Opções da 2ª passada; só existe com modelo que tem classe de sujeito para orientar o recorte.
   * Com manifest.cropModel ela é obrigatória (é a única fonte de EPIs), independentemente do ajuste.
   */
  private refineOptions(): RefineOptions | undefined {
    const m = this.snap.model.manifest;
    const s = effectiveSettings(this.snap.settings, m);
    const subjectClass = m?.subjectClass;
    if (!subjectClass || (!s.headRefine && !m?.cropModel)) return undefined;
    // Limiar de "positivo" da classe-alvo de cada classe mantida do modelo principal (keepMainClasses).
    const skipMainAbove: Record<string, number> = {};
    if (s.adaptiveRefine) {
      for (const c of m?.cropModel?.keepMainClasses ?? []) {
        const target = m!.ppeClassMap[c];
        if (target) skipMainAbove[c] = s.classes[target].threshold;
      }
    }
    return {
      subjectClass,
      minSubjectScore: s.subjectThreshold,
      maxCrops: s.refineMaxCrops,
      ratio: HEAD_CROP_RATIO,
      minSide: HEAD_CROP_MIN_SIDE,
      skipMainAbove,
    };
  }

  async switchCamera(): Promise<void> {
    const { devices, facing } = this.snap.camera;
    const s = this.snap.settings;
    if (devices.length > 1) {
      const currentId = this.stream?.getVideoTracks()[0]?.getSettings?.().deviceId ?? s.deviceId;
      const idx = devices.findIndex((d) => d.deviceId === currentId);
      this.updateSettings({ deviceId: devices[(idx + 1) % devices.length].deviceId });
    } else {
      this.updateSettings({ deviceId: null, preferredFacing: facing === 'user' ? 'environment' : 'user' });
    }
    this.stopCamera();
    await this.startCamera();
  }

  private handleTrackEnded() {
    if (this.snap.camera.state !== 'running') return;
    this.stopCamera();
    this.setCamera({ state: 'error', error: mapCameraError({ name: 'NotReadableError', message: 'A câmera foi desconectada.' }) });
    this.refreshDecisions();
  }

  private waitForVideo(): Promise<void> {
    if (this.video.readyState >= 2 && this.video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.video.removeEventListener('loadeddata', done);
        resolve();
      };
      this.video.addEventListener('loadeddata', done);
      setTimeout(done, 3000);
    });
  }

  private async requestWakeLock() {
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      this.wakeLock = (await wl?.request('screen')) ?? null;
    } catch {
      this.wakeLock = null;
    }
  }

  /** Chamado pelo App em visibilitychange/pagehide: libera a câmera ao sair da página. */
  handleVisibility(hidden: boolean): void {
    if (hidden && (this.snap.camera.state === 'running' || this.snap.camera.state === 'requesting')) {
      this.stopCamera(true);
    }
  }

  dispose(): void {
    this.stopCamera();
    this.client?.terminate();
    this.client = null;
  }

  // ----------------------------------------------------------------- laço de inferência
  private startLoop() {
    if (this.snap.model.state !== 'ready' || this.snap.camera.state !== 'running' || this.snap.paused || !this.client) return;
    const token = ++this.loopToken; // invalida qualquer laço anterior: no máximo um ativo
    void this.loop(token);
  }

  private stopLoop() {
    this.loopToken++;
  }

  private async loop(token: number) {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    while (token === this.loopToken) {
      const started = this.deps.now();
      if (this.video.readyState < 2 || this.video.videoWidth === 0) {
        await sleep(50);
        continue;
      }
      let bitmap: ImageBitmap;
      try {
        bitmap = await this.deps.grabFrame(this.video);
      } catch {
        await sleep(100);
        continue;
      }
      if (token !== this.loopToken || !this.client) {
        bitmap.close();
        return;
      }
      try {
        const s = this.snap.settings;
        const result = await this.client.infer(bitmap, s.detectorScoreFloor, s.nmsIou, 15000, s.showDebug, this.refineOptions());
        if (token !== this.loopToken) return;
        this.handleResult(result, this.deps.now() - started);
      } catch (e) {
        if (token !== this.loopToken) return;
        this.handleInferenceFailure(e);
        await sleep(1000);
        continue;
      }
      const wait = this.snap.settings.inferenceIntervalMs - (this.deps.now() - started);
      await sleep(Math.max(0, wait));
    }
  }

  private handleInferenceFailure(e: unknown) {
    this.set({ inferenceError: e instanceof Error ? e.message : String(e), frame: null });
    this.resetVerification();
    this.refreshDecisions();
  }

  /** Processa o resultado de um quadro (público para testes). */
  handleResult(result: FrameResult, roundTripMs: number): void {
    const manifest = this.snap.model.manifest;
    if (!manifest) return;
    const s = effectiveSettings(this.snap.settings, manifest);
    const now = this.deps.now();
    const supported = activeTargets(manifest, s);
    const unsupported = (cls: PpeClass) => unavailableDecision(unsupportedReason(manifest, cls));
    const analysis = analyzeFrame(result, manifest, s);
    // Com quadros lentos, a pessoa precisa sobreviver a pelo menos ~2 intervalos entre inferências.
    const { ids, expired } = this.tracker.update(
      analysis.subjects.map((x) => x.box),
      now,
      TRACK_TTL_FRAMES * (roundTripMs + s.inferenceIntervalMs),
    );
    for (const id of expired) {
      this.engine.dropTrack(id);
      this.alertMgr.dropTrack(id);
    }

    const perTrack: Record<number, DecisionMap> = {};
    const newAlerts: AlertEvent[] = [];
    analysis.subjects.forEach((subj, i) => {
      const id = ids[i];
      const entries = PPE_CLASSES.filter((c) => supported.has(c)).map((cls) => ({
        cls,
        outcome: classifyObservation(subj, cls, s),
        score: subj.ppeScores[cls],
        reason: subj.unobservable ?? undefined,
      }));
      this.engine.observe(id, now, entries, s);
      const d = {} as DecisionMap;
      for (const cls of PPE_CLASSES) {
        d[cls] = supported.has(cls) ? this.engine.decide(id, cls, now, s) : unsupported(cls);
        const a = supported.has(cls) ? this.alertMgr.update(id, cls, d[cls].status, now) : null;
        if (a) newAlerts.push({ ...a, wallTime: Date.now() });
      }
      perTrack[id] = d;
    });

    // Pessoa principal: a maior caixa observável (ou a maior, se nenhuma for observável).
    let primary: number | null = null;
    let bestArea = -1;
    analysis.subjects.forEach((subj, i) => {
      const a = (subj.box.x2 - subj.box.x1) * (subj.box.y2 - subj.box.y1) * (subj.unobservable ? 0.01 : 1);
      if (a > bestArea) {
        bestArea = a;
        primary = ids[i];
      }
    });

    const decisions =
      primary !== null
        ? perTrack[primary]
        : (Object.fromEntries(
            PPE_CLASSES.map((c) => [c, supported.has(c) ? noSubjectDecision() : unsupported(c)]),
          ) as DecisionMap);

    const dt = this.lastResultAt ? now - this.lastResultAt : 0;
    this.lastResultAt = now;
    const fps = dt > 0 ? (this.snap.fps ? this.snap.fps * 0.8 + (1000 / dt) * 0.2 : 1000 / dt) : this.snap.fps;

    if (newAlerts.some((a) => a.audible)) this.signalAlert();

    const ev = this.snap.evaluation;
    const latencies = [...ev.latencies.slice(-(MAX_LATENCIES - 1)), roundTripMs];
    let samples = ev.samples;
    if (ev.recording && now - this.lastSampleAt >= SAMPLE_PERIOD_MS) {
      this.lastSampleAt = now;
      const t = Date.now();
      const add: EvalSample[] = [];
      for (const cls of PPE_CLASSES) {
        const truth = ev.truth[cls];
        if (truth === null || !supported.has(cls)) continue;
        add.push({ t, scenario: ev.scenario, cls, truth, status: decisions[cls].status });
      }
      if (add.length) {
        samples = [...samples, ...add].slice(-MAX_SAMPLES);
        this.persistEvaluation();
      }
    }

    this.set({
      frame: { result, analysis, trackIds: ids, perTrack },
      primaryTrackId: primary,
      decisions,
      fps,
      latencyMs: roundTripMs,
      inferenceError: null,
      alerts: newAlerts.length ? [...newAlerts.reverse(), ...this.snap.alerts].slice(0, 20) : this.snap.alerts,
      evaluation: { ...ev, latencies, samples },
    });
  }

  private signalAlert() {
    const s = this.snap.settings;
    if (s.soundEnabled) this.beeper.beep(s.soundVolume);
    if (s.vibrate && 'vibrate' in navigator) navigator.vibrate?.([200, 100, 200]);
  }

  private startStaleWatch() {
    if (this.staleTimer !== null) clearInterval(this.staleTimer);
    this.staleTimer = window.setInterval(() => this.refreshDecisions(), 1000);
  }

  /** Recalcula decisões quando não há quadros (câmera parada, modelo ausente, quadros atrasados). */
  private refreshDecisions() {
    const reason = this.unavailableReason();
    if (reason) {
      const same = PPE_CLASSES.every((c) => this.snap.decisions[c].status === 'CAMERA_UNAVAILABLE' && this.snap.decisions[c].reason === reason);
      if (!same) this.set({ decisions: allDecisions(reason), frame: reason === 'stale' ? this.snap.frame : null });
    }
  }

  private unavailableReason(): UnavailableReason | null {
    const { camera, model, inferenceError } = this.snap;
    if (camera.state === 'error') return 'camera_error';
    if (camera.state !== 'running') return 'camera_off';
    if (model.state === 'loading') return 'model_loading';
    if (model.state !== 'ready') return 'model_missing';
    if (this.snap.paused) return 'paused';
    if (inferenceError) return 'inference_error';
    if (this.lastResultAt && this.deps.now() - this.lastResultAt > STALE_MS) return 'stale';
    if (!this.lastResultAt) return 'warming_up';
    return null;
  }

  private resetVerification() {
    this.engine.reset();
    this.tracker.reset();
    this.alertMgr.reset();
    this.lastResultAt = 0;
  }

  // ----------------------------------------------------------------- som
  async enableSound(): Promise<boolean> {
    const ok = await this.beeper.unlock();
    this.updateSettings({ soundEnabled: ok });
    this.set({ soundReady: ok });
    return ok;
  }

  disableSound(): void {
    this.updateSettings({ soundEnabled: false });
  }

  async testSound(): Promise<void> {
    if (await this.beeper.unlock()) {
      this.set({ soundReady: true });
      this.beeper.beep(this.snap.settings.soundVolume);
    }
  }

  // ----------------------------------------------------------------- ajustes
  updateSettings(patch: Partial<Settings>): void {
    const settings = sanitizeSettings({ ...this.snap.settings, ...patch });
    if (this.deps.storage === localStorage) saveSettings(settings);
    this.alertMgr.configure(settings.alertCooldownMs, settings.alertGlobalGapMs);
    const backendChanged = settings.backend !== this.snap.settings.backend;
    this.set({ settings });
    if (backendChanged && this.snap.model.manifest && this.snap.model.source === 'server') void this.loadServerModel();
  }

  async refreshDevices(): Promise<void> {
    const devices = (await this.deps.listCameras().catch(() => [])).map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Câmera ${i + 1}` }));
    this.setCamera({ devices });
  }

  // ----------------------------------------------------------------- avaliação
  setTruth(cls: PpeClass, value: boolean | null): void {
    const ev = this.snap.evaluation;
    if (ev.truth[cls] === value) return;
    // Mudar o gabarito inicia um novo cenário para não misturar condições diferentes.
    this.set({ evaluation: { ...ev, truth: { ...ev.truth, [cls]: value }, scenario: ev.scenario + 1 } });
  }

  setRecording(recording: boolean): void {
    const ev = this.snap.evaluation;
    this.lastSampleAt = -Infinity;
    this.set({ evaluation: { ...ev, recording, scenario: recording && !ev.recording ? ev.scenario + 1 : ev.scenario } });
  }

  clearEvaluation(): void {
    this.deps.storage?.removeItem(EVAL_KEY);
    this.set({ evaluation: { ...this.snap.evaluation, samples: [], latencies: [], recording: false } });
  }

  metrics() {
    return computeMetrics(this.snap.evaluation.samples);
  }

  private loadEvaluation(): { samples: EvalSample[]; scenario: number } {
    try {
      const raw = this.deps.storage?.getItem(EVAL_KEY);
      if (!raw) return { samples: [], scenario: 0 };
      const p = JSON.parse(raw) as { samples?: EvalSample[]; scenario?: number };
      return { samples: Array.isArray(p.samples) ? p.samples : [], scenario: p.scenario ?? 0 };
    } catch {
      return { samples: [], scenario: 0 };
    }
  }

  private persistEvaluation() {
    if (this.persistTimer !== null) return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      try {
        this.deps.storage?.setItem(EVAL_KEY, JSON.stringify({ samples: this.snap.evaluation.samples, scenario: this.snap.evaluation.scenario }));
      } catch {
        /* armazenamento cheio/indisponível — dados ficam só em memória */
      }
    }, 2000);
  }
}
