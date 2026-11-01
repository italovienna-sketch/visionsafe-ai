import { PPE_CLASSES, type PpeClass, type PpeStatus } from './types';

/** Gabarito informado pelo avaliador: a pessoa está usando o EPI? null = não avaliar. */
export type GroundTruth = Record<PpeClass, boolean | null>;

export interface EvalSample {
  t: number;
  /** Cenário = trecho contínuo com o mesmo gabarito (cada mudança de gabarito inicia outro). */
  scenario: number;
  cls: PpeClass;
  truth: boolean;
  status: PpeStatus;
}

export interface ClassMetrics {
  samples: number;
  scenarios: number;
  /** Usando EPI e sistema disse DETECTED. */
  tp: number;
  /** Sem EPI e sistema disse DETECTED (falso positivo). */
  fp: number;
  /** Usando EPI e sistema disse NOT_DETECTED (falso negativo / detecção perdida). */
  fn: number;
  /** Sem EPI e sistema disse NOT_DETECTED. */
  tn: number;
  uncertain: number;
  unavailable: number;
  precision: number | null;
  recall: number | null;
  /** Fração de amostras com decisão (DETECTED/NOT_DETECTED). */
  coverage: number | null;
}

/** Limites abaixo dos quais a interface avisa que os dados são insuficientes. */
export const MIN_SAMPLES = 60;
export const MIN_SCENARIOS = 4;

export function computeMetrics(samples: readonly EvalSample[]): Record<PpeClass, ClassMetrics> {
  const out = {} as Record<PpeClass, ClassMetrics>;
  for (const cls of PPE_CLASSES) {
    const s = samples.filter((x) => x.cls === cls);
    const m: ClassMetrics = {
      samples: s.length,
      scenarios: new Set(s.map((x) => x.scenario)).size,
      tp: 0,
      fp: 0,
      fn: 0,
      tn: 0,
      uncertain: 0,
      unavailable: 0,
      precision: null,
      recall: null,
      coverage: null,
    };
    for (const x of s) {
      if (x.status === 'DETECTED') x.truth ? m.tp++ : m.fp++;
      else if (x.status === 'NOT_DETECTED') x.truth ? m.fn++ : m.tn++;
      else if (x.status === 'UNCERTAIN') m.uncertain++;
      else m.unavailable++;
    }
    if (m.tp + m.fp > 0) m.precision = m.tp / (m.tp + m.fp);
    if (m.tp + m.fn > 0) m.recall = m.tp / (m.tp + m.fn);
    if (m.samples > 0) m.coverage = (m.tp + m.fp + m.fn + m.tn) / m.samples;
    out[cls] = m;
  }
  return out;
}

export function isInsufficient(m: ClassMetrics): boolean {
  return m.samples < MIN_SAMPLES || m.scenarios < MIN_SCENARIOS;
}

export interface LatencyStats {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export function latencyStats(values: readonly number[]): LatencyStats | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))];
  return { count: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, p50: q(0.5), p95: q(0.95), max: v[v.length - 1] };
}

export function samplesToCsv(samples: readonly EvalSample[]): string {
  const rows = samples.map((s) => [new Date(s.t).toISOString(), s.scenario, s.cls, s.truth ? 1 : 0, s.status].join(','));
  return ['timestamp,cenario,classe,usando_epi,status', ...rows].join('\n');
}
