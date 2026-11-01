import type { ModelManifest } from './manifest';
import { PPE_CLASSES, type PpeClass } from './types';

export interface ClassSettings {
  /** Confiança mínima para contar uma observação como positiva. */
  threshold: number;
  /** Abaixo do limiar mas acima deste piso = observação ambígua (não conta como ausência). */
  ambiguousFloor: number;
}

export interface Settings {
  classes: Record<PpeClass, ClassSettings>;
  /** Usa o limiar recomendado pelo modelo (manifest.thresholds) nas classes em que ele existe. */
  useModelThresholds: boolean;
  /** Janela de verificação (ms). NOT_DETECTED só após observar a pessoa por todo este tempo. */
  windowMs: number;
  /** Observações válidas (positivas + negativas) mínimas antes de declarar NOT_DETECTED. */
  minObservations: number;
  /** Positivas mínimas na janela para declarar DETECTED. */
  minPositive: number;
  /** Fração mínima de negativas entre as válidas para declarar NOT_DETECTED. */
  absentRatio: number;
  /** Fração máxima de ambíguas permitida para declarar NOT_DETECTED. */
  maxAmbiguousRatio: number;
  showCountdown: boolean;

  /**
   * Altura mínima da caixa do sujeito em pixels do quadro nativo (não em fração do quadro: o que
   * limita a detecção é quantos pixels a câmera entrega no rosto, não a proporção na imagem).
   * Abaixo disso a observação é "inconclusiva — distante", nunca "não detectado".
   */
  minSubjectPx: number;
  /** Nitidez mínima (variância do Laplaciano) no recorte do sujeito. */
  minSharpness: number;
  minBrightness: number;
  maxBrightness: number;
  /** Confiança mínima para aceitar uma caixa de sujeito (pessoa/cabeça). */
  subjectThreshold: number;

  /**
   * 2ª passada do detector em recortes da cabeça na resolução nativa da câmera (recupera EPIs
   * pequenos que somem ao reduzir o quadro inteiro para a entrada do modelo). Custa 1 inferência
   * extra por pessoa analisada.
   */
  headRefine: boolean;
  /** Máximo de pessoas refinadas por quadro. */
  refineMaxCrops: number;
  /**
   * Dispensa a passada do modelo principal no recorte quando a 1ª passada já confirmou o EPI na pessoa
   * (mesma decisão, uma inferência a menos). Ver docs/DESEMPENHO.md.
   */
  adaptiveRefine: boolean;
  /** Escore mínimo para o detector manter uma caixa (antes da decisão por classe). */
  detectorScoreFloor: number;
  /** IoU acima do qual caixas da mesma classe são fundidas pelo NMS. */
  nmsIou: number;
  /**
   * Classes-alvo cobertas apenas por aproximação (ex.: óculos comuns no lugar de óculos de segurança).
   * Desligadas = a classe aparece como "Não avaliável" em vez de usar o sinal aproximado.
   */
  allowProxy: Record<PpeClass, boolean>;

  /** Intervalo mínimo entre inferências (ms) — limita a carga no celular. */
  inferenceIntervalMs: number;
  backend: 'wasm' | 'webgpu';

  soundEnabled: boolean;
  soundVolume: number;
  vibrate: boolean;
  /** Tempo mínimo entre alertas repetidos para a mesma pessoa e classe. */
  alertCooldownMs: number;
  /** Intervalo mínimo entre quaisquer alertas sonoros. */
  alertGlobalGapMs: number;

  preferredFacing: 'environment' | 'user';
  deviceId: string | null;
  showDebug: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  classes: {
    safety_glasses: { threshold: 0.5, ambiguousFloor: 0.25 },
    hearing_protection: { threshold: 0.5, ambiguousFloor: 0.25 },
    hairnet: { threshold: 0.5, ambiguousFloor: 0.25 },
  },
  useModelThresholds: true,
  windowMs: 5000,
  minObservations: 8,
  minPositive: 3,
  absentRatio: 0.85,
  maxAmbiguousRatio: 0.25,
  showCountdown: true,
  minSubjectPx: 48,
  minSharpness: 20,
  minBrightness: 40,
  maxBrightness: 225,
  subjectThreshold: 0.4,
  headRefine: true,
  refineMaxCrops: 2,
  adaptiveRefine: true,
  detectorScoreFloor: 0.1,
  nmsIou: 0.45,
  allowProxy: { safety_glasses: true, hearing_protection: true, hairnet: true },
  inferenceIntervalMs: 150,
  backend: 'wasm',
  soundEnabled: false,
  soundVolume: 0.5,
  vibrate: true,
  alertCooldownMs: 15000,
  alertGlobalGapMs: 3000,
  preferredFacing: 'environment',
  deviceId: null,
  showDebug: false,
};

/** Ajustes efetivos: limiares recomendados pelo modelo substituem os manuais quando useModelThresholds está ligado. */
export function effectiveSettings(s: Settings, manifest: Pick<ModelManifest, 'thresholds'> | null | undefined): Settings {
  const rec = manifest?.thresholds;
  if (!s.useModelThresholds || !rec) return s;
  const classes = { ...s.classes };
  for (const c of PPE_CLASSES) {
    const t = rec[c];
    if (t !== undefined) classes[c] = { threshold: t, ambiguousFloor: Math.min(s.classes[c].ambiguousFloor, t) };
  }
  return { ...s, classes };
}

/**
 * Modos de análise = predefinições de ajustes reais (nenhum modo cria detecções nem muda o modelo).
 * O que muda é quantas pessoas recebem o recorte da cabeça por quadro e com que frequência se infere:
 * mais pessoas/menor intervalo = mais inferências por segundo = mais carga no aparelho.
 */
export type AnalysisMode = 'fast' | 'balanced' | 'detail';
type ModePatch = Pick<Settings, 'headRefine' | 'refineMaxCrops' | 'adaptiveRefine' | 'inferenceIntervalMs'>;

export const ANALYSIS_MODES: Record<AnalysisMode, { label: string; description: string; patch: ModePatch }> = {
  fast: {
    label: 'Rápido',
    description: '1 pessoa analisada por quadro, inferência a cada 300 ms. Para aparelhos fracos ou que esquentam.',
    patch: { headRefine: true, refineMaxCrops: 1, adaptiveRefine: true, inferenceIntervalMs: 300 },
  },
  balanced: {
    label: 'Equilibrado',
    description: 'Até 2 pessoas por quadro, inferência a cada 150 ms (padrão).',
    patch: { headRefine: true, refineMaxCrops: 2, adaptiveRefine: true, inferenceIntervalMs: 150 },
  },
  detail: {
    label: 'Detalhe',
    description: 'Até 4 pessoas por quadro, sem intervalo extra. Não aumenta o alcance: cada pessoa custa mais uma inferência.',
    patch: { headRefine: true, refineMaxCrops: 4, adaptiveRefine: true, inferenceIntervalMs: 0 },
  },
};

/** Modo correspondente aos ajustes atuais, ou null se o usuário personalizou algum deles. */
export function currentMode(s: Settings): AnalysisMode | null {
  for (const [mode, { patch }] of Object.entries(ANALYSIS_MODES) as [AnalysisMode, (typeof ANALYSIS_MODES)[AnalysisMode]][]) {
    if ((Object.keys(patch) as (keyof ModePatch)[]).every((k) => s[k] === patch[k])) return mode;
  }
  return null;
}

const clamp = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

/** Valida e normaliza configurações vindas do armazenamento local (tolerante a versões antigas). */
export function sanitizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const rc = (r.classes && typeof r.classes === 'object' ? r.classes : {}) as Record<string, Partial<ClassSettings>>;
  const classes = {} as Record<PpeClass, ClassSettings>;
  for (const c of PPE_CLASSES) {
    const threshold = clamp(rc[c]?.threshold, 0.05, 0.99, d.classes[c].threshold);
    const ambiguousFloor = clamp(rc[c]?.ambiguousFloor, 0.01, threshold, Math.min(d.classes[c].ambiguousFloor, threshold));
    classes[c] = { threshold, ambiguousFloor };
  }
  const minBrightness = clamp(r.minBrightness, 0, 254, d.minBrightness);
  return {
    classes,
    useModelThresholds: bool(r.useModelThresholds, d.useModelThresholds),
    windowMs: clamp(r.windowMs, 1000, 60000, d.windowMs),
    minObservations: Math.round(clamp(r.minObservations, 1, 200, d.minObservations)),
    minPositive: Math.round(clamp(r.minPositive, 1, 100, d.minPositive)),
    absentRatio: clamp(r.absentRatio, 0.5, 1, d.absentRatio),
    maxAmbiguousRatio: clamp(r.maxAmbiguousRatio, 0, 1, d.maxAmbiguousRatio),
    showCountdown: bool(r.showCountdown, d.showCountdown),
    minSubjectPx: clamp(r.minSubjectPx, 0, 2000, d.minSubjectPx),
    minSharpness: clamp(r.minSharpness, 0, 5000, d.minSharpness),
    minBrightness,
    maxBrightness: clamp(r.maxBrightness, minBrightness + 1, 255, d.maxBrightness),
    subjectThreshold: clamp(r.subjectThreshold, 0.05, 0.99, d.subjectThreshold),
    headRefine: bool(r.headRefine, d.headRefine),
    refineMaxCrops: Math.round(clamp(r.refineMaxCrops, 1, 4, d.refineMaxCrops)),
    adaptiveRefine: bool(r.adaptiveRefine, d.adaptiveRefine),
    detectorScoreFloor: clamp(r.detectorScoreFloor, 0.01, 0.9, d.detectorScoreFloor),
    nmsIou: clamp(r.nmsIou, 0.1, 0.95, d.nmsIou),
    allowProxy: Object.fromEntries(
      PPE_CLASSES.map((c) => [c, bool((r.allowProxy as Record<string, unknown> | undefined)?.[c], d.allowProxy[c])]),
    ) as Record<PpeClass, boolean>,
    inferenceIntervalMs: clamp(r.inferenceIntervalMs, 0, 5000, d.inferenceIntervalMs),
    backend: r.backend === 'webgpu' ? 'webgpu' : 'wasm',
    soundEnabled: bool(r.soundEnabled, d.soundEnabled),
    soundVolume: clamp(r.soundVolume, 0, 1, d.soundVolume),
    vibrate: bool(r.vibrate, d.vibrate),
    alertCooldownMs: clamp(r.alertCooldownMs, 0, 600000, d.alertCooldownMs),
    alertGlobalGapMs: clamp(r.alertGlobalGapMs, 0, 60000, d.alertGlobalGapMs),
    preferredFacing: r.preferredFacing === 'user' ? 'user' : 'environment',
    deviceId: typeof r.deviceId === 'string' && r.deviceId ? r.deviceId : null,
    showDebug: bool(r.showDebug, d.showDebug),
  };
}

const KEY = 'visionsafe.settings.v1';

export function loadSettings(): Settings {
  try {
    const s = localStorage.getItem(KEY);
    return sanitizeSettings(s ? JSON.parse(s) : null);
  } catch {
    return sanitizeSettings(null);
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* armazenamento indisponível (aba anônima etc.) — configurações valem só nesta sessão */
  }
}
