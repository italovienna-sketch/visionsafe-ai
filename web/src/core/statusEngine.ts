import type { Settings } from './settings';
import {
  PPE_CLASSES,
  type ClassDecision,
  type DecisionMap,
  type ObservationOutcome,
  type PpeClass,
  type UncertainReason,
  type UnavailableReason,
} from './types';

interface Obs {
  t: number;
  outcome: ObservationOutcome;
  score: number;
  reason?: UncertainReason;
}

interface TrackState {
  obs: Record<PpeClass, Obs[]>;
  /** Início da observação válida contínua (base da contagem regressiva). */
  validSince: number | null;
  lastValid: number | null;
}

/**
 * Motor de verificação por pessoa e por classe.
 * Uma única detecção perdida nunca gera NOT_DETECTED: é preciso uma janela completa com
 * observações válidas suficientes, majoritariamente negativas e com poucas ambíguas.
 */
export class VerificationEngine {
  private tracks = new Map<number, TrackState>();

  observe(
    trackId: number,
    now: number,
    entries: { cls: PpeClass; outcome: ObservationOutcome; score: number; reason?: UncertainReason }[],
    settings: Settings,
  ): void {
    let st = this.tracks.get(trackId);
    if (!st) {
      st = { obs: { safety_glasses: [], hearing_protection: [], hairnet: [] }, validSince: null, lastValid: null };
      this.tracks.set(trackId, st);
    }
    const anyValid = entries.some((e) => e.outcome !== 'unobservable');
    if (anyValid) {
      if (st.lastValid === null || now - st.lastValid > settings.windowMs) st.validSince = now;
      st.lastValid = now;
    }
    for (const e of entries) {
      const list = st.obs[e.cls];
      list.push({ t: now, outcome: e.outcome, score: e.score, reason: e.reason });
      const cutoff = now - settings.windowMs;
      while (list.length && list[0].t < cutoff) list.shift();
    }
  }

  decide(trackId: number, cls: PpeClass, now: number, settings: Settings): ClassDecision {
    const st = this.tracks.get(trackId);
    const counts = { positive: 0, negative: 0, ambiguous: 0, unobservable: 0 };
    if (!st) return uncertain('no_subject', counts, 0, 0, settings.windowMs, 0);

    const cutoff = now - settings.windowMs;
    const list = st.obs[cls].filter((o) => o.t >= cutoff);
    let bestScore = 0;
    for (const o of list) {
      counts[o.outcome]++;
      bestScore = Math.max(bestScore, o.score);
    }
    const last = list[list.length - 1];
    const lastScore = last?.score ?? 0;
    const valid = counts.positive + counts.negative;
    const ambiguousRatio = counts.ambiguous / Math.max(1, valid + counts.ambiguous);
    const remaining =
      st.validSince === null ? settings.windowMs : Math.max(0, settings.windowMs - (now - st.validSince));
    const progress = Math.min(1, valid / settings.minObservations);

    const base = { bestScore, lastScore, counts, verifyRemainingMs: remaining, progress };

    if (counts.positive >= settings.minPositive && counts.positive >= counts.negative) {
      return { status: 'DETECTED', ...base };
    }
    if (
      remaining === 0 &&
      valid >= settings.minObservations &&
      counts.negative / valid >= settings.absentRatio &&
      ambiguousRatio <= settings.maxAmbiguousRatio
    ) {
      return { status: 'NOT_DETECTED', ...base };
    }

    let reason: UncertainReason;
    if (!last) reason = 'no_subject';
    else if (last.outcome === 'unobservable') reason = last.reason ?? 'insufficient_observations';
    else if (ambiguousRatio > settings.maxAmbiguousRatio) reason = 'ambiguous_scores';
    else if (remaining > 0) reason = 'verifying';
    else if (valid < settings.minObservations) reason = 'insufficient_observations';
    else reason = 'inconsistent';
    return { status: 'UNCERTAIN', reason, ...base };
  }

  decideAll(trackId: number, now: number, settings: Settings): DecisionMap {
    return Object.fromEntries(PPE_CLASSES.map((c) => [c, this.decide(trackId, c, now, settings)])) as DecisionMap;
  }

  dropTrack(trackId: number): void {
    this.tracks.delete(trackId);
  }

  reset(): void {
    this.tracks.clear();
  }
}

function uncertain(
  reason: UncertainReason,
  counts: ClassDecision['counts'],
  bestScore: number,
  lastScore: number,
  remaining: number,
  progress: number,
): ClassDecision {
  return { status: 'UNCERTAIN', reason, counts, bestScore, lastScore, verifyRemainingMs: remaining, progress };
}

/** Decisão uniforme quando câmera/modelo/inferência estão indisponíveis. */
export function unavailableDecision(reason: UnavailableReason): ClassDecision {
  return {
    status: 'CAMERA_UNAVAILABLE',
    reason,
    bestScore: 0,
    lastScore: 0,
    counts: { positive: 0, negative: 0, ambiguous: 0, unobservable: 0 },
    verifyRemainingMs: 0,
    progress: 0,
  };
}

export function noSubjectDecision(): ClassDecision {
  return {
    status: 'UNCERTAIN',
    reason: 'no_subject',
    bestScore: 0,
    lastScore: 0,
    counts: { positive: 0, negative: 0, ambiguous: 0, unobservable: 0 },
    verifyRemainingMs: 0,
    progress: 0,
  };
}
