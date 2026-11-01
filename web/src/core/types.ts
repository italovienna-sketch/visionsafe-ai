/** Classes-alvo do protótipo. Nomes técnicos em inglês; rótulos de UI ficam em ppe.ts. */
export const PPE_CLASSES = ['safety_glasses', 'hearing_protection', 'hairnet'] as const;
export type PpeClass = (typeof PPE_CLASSES)[number];

/** Estados explícitos exigidos pela especificação. */
export type PpeStatus = 'DETECTED' | 'NOT_DETECTED' | 'UNCERTAIN' | 'CAMERA_UNAVAILABLE';

/** Caixa em coordenadas de pixel do quadro de origem (x1,y1 canto superior esquerdo). */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Detecção bruta devolvida pelo modelo, já sem letterbox e após NMS. */
export interface Detection extends Box {
  classIndex: number;
  className: string;
  score: number;
}

/** Medidas de qualidade de imagem calculadas sobre o recorte de uma pessoa. */
export interface RegionQuality {
  /** Variância do Laplaciano em escala de cinza (nitidez). */
  sharpness: number;
  /** Luminância média 0..255. */
  brightness: number;
}

export interface InferenceTimings {
  preprocessMs: number;
  inferenceMs: number;
  postprocessMs: number;
  totalMs: number;
  /** Tempo da 2ª passada (recortes da cabeça), incluído em totalMs. */
  refineMs?: number;
}

/** Estatísticas da saída bruta do modelo (somente em modo diagnóstico). */
export interface RawOutputStats {
  dims: number[];
  format: string;
  maxPerClass: number[];
  candidatesAbove025: number;
  valueRange: [number, number];
}

export interface FrameResult {
  frameWidth: number;
  frameHeight: number;
  detections: Detection[];
  /** Qualidade por índice de detecção de "sujeito" (pessoa/cabeça). */
  subjectQuality: Record<number, RegionQuality>;
  /** Qualidade do quadro inteiro (usada quando o modelo não tem classe de sujeito). */
  frameQuality: RegionQuality;
  timings: InferenceTimings;
  timestamp: number;
  raw?: RawOutputStats;
  /** Recortes da cabeça analisados na 2ª passada (coordenadas do quadro). */
  crops?: Box[];
  /** Recortes em que a passada do modelo principal foi dispensada (EPI já confirmado na 1ª passada). */
  mainCropSkipped?: number;
}

/** Resultado de uma observação de uma classe em um quadro para um sujeito. */
export type ObservationOutcome = 'positive' | 'negative' | 'ambiguous' | 'unobservable';

export type UncertainReason =
  | 'no_subject'
  | 'subject_small'
  | 'not_refined'
  | 'subject_truncated'
  | 'blurry'
  | 'too_dark'
  | 'too_bright'
  | 'verifying'
  | 'insufficient_observations'
  | 'ambiguous_scores'
  | 'inconsistent';

export type UnavailableReason =
  | 'camera_off'
  | 'camera_error'
  | 'model_missing'
  | 'model_loading'
  | 'warming_up'
  | 'inference_error'
  | 'class_unsupported'
  | 'proxy_disabled'
  | 'paused'
  | 'stale';

export interface ClassDecision {
  status: PpeStatus;
  reason?: UncertainReason | UnavailableReason;
  /** Maior confiança vista para a classe dentro da janela (0 se nenhuma). */
  bestScore: number;
  /** Confiança da classe no quadro mais recente (0 se nenhuma). */
  lastScore: number;
  counts: { positive: number; negative: number; ambiguous: number; unobservable: number };
  /** ms restantes até que NOT_DETECTED possa ser declarado (0 = janela completa). */
  verifyRemainingMs: number;
  /** Fração (0..1) das observações válidas mínimas já coletadas. */
  progress: number;
}

export type DecisionMap = Record<PpeClass, ClassDecision>;
