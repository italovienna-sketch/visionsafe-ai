import { describe, expect, it } from 'vitest';
import { settings } from '../test/fixtures';
import { VerificationEngine } from './statusEngine';
import type { ObservationOutcome, UncertainReason } from './types';

const S = settings({ windowMs: 5000, minObservations: 8, minPositive: 3, absentRatio: 0.85, maxAmbiguousRatio: 0.25 });

/** Alimenta o motor com uma sequência de observações a cada 200 ms para óculos. */
function feed(engine: VerificationEngine, outcomes: ObservationOutcome[], start = 0, step = 200, reason?: UncertainReason) {
  let t = start;
  for (const o of outcomes) {
    engine.observe(1, t, [{ cls: 'safety_glasses', outcome: o, score: o === 'positive' ? 0.9 : o === 'ambiguous' ? 0.35 : 0.02, reason }], S);
    t += step;
  }
  return t - step;
}

describe('motor de verificação', () => {
  it('sem observações a pessoa é incerta', () => {
    const e = new VerificationEngine();
    expect(e.decide(1, 'safety_glasses', 0, S)).toMatchObject({ status: 'UNCERTAIN', reason: 'no_subject' });
  });

  it('declara DETECTED após o mínimo de positivas', () => {
    const e = new VerificationEngine();
    let t = feed(e, ['positive', 'positive']);
    expect(e.decide(1, 'safety_glasses', t, S).status).toBe('UNCERTAIN');
    t = feed(e, ['positive'], t + 200);
    const d = e.decide(1, 'safety_glasses', t, S);
    expect(d.status).toBe('DETECTED');
    expect(d.bestScore).toBeCloseTo(0.9);
  });

  it('uma única detecção perdida não gera NOT_DETECTED', () => {
    const e = new VerificationEngine();
    const t = feed(e, ['positive', 'positive', 'positive', 'negative', 'positive']);
    expect(e.decide(1, 'safety_glasses', t, S).status).toBe('DETECTED');
  });

  it('NOT_DETECTED só após a janela completa, com contagem regressiva', () => {
    const e = new VerificationEngine();
    let t = feed(e, Array(10).fill('negative')); // 10 negativas em 1,8 s
    let d = e.decide(1, 'safety_glasses', t, S);
    expect(d).toMatchObject({ status: 'UNCERTAIN', reason: 'verifying' });
    expect(d.verifyRemainingMs).toBe(5000 - 1800);
    t = feed(e, Array(20).fill('negative'), t + 200);
    d = e.decide(1, 'safety_glasses', t, S);
    expect(d.status).toBe('NOT_DETECTED');
    expect(d.verifyRemainingMs).toBe(0);
  });

  it('a suavização não esconde mudanças reais: retirar e recolocar o EPI aparece dentro de uma janela', () => {
    // Quadros a cada 800 ms (latência medida no PC de teste): o pior caso realista para a janela de 5 s.
    const e = new VerificationEngine();
    const step = 800;
    let t = feed(e, Array(10).fill('positive'), 0, step);
    expect(e.decide(1, 'safety_glasses', t, S).status).toBe('DETECTED');
    const removedAt = t + step;
    let leftDetected: number | null = null;
    let notConfirmed: number | null = null;
    for (t = removedAt; t <= removedAt + 3 * S.windowMs; t += step) {
      e.observe(1, t, [{ cls: 'safety_glasses', outcome: 'negative', score: 0.02 }], S);
      const st = e.decide(1, 'safety_glasses', t, S).status;
      if (st !== 'DETECTED' && leftDetected === null) leftDetected = t;
      if (st === 'NOT_DETECTED') {
        notConfirmed = t;
        break;
      }
    }
    expect(leftDetected! - removedAt).toBeLessThanOrEqual(S.windowMs);
    expect(notConfirmed! - removedAt).toBeLessThanOrEqual(S.windowMs + step);
    // Recolocar: volta a "Detectado" assim que houver positivas suficientes (minPositive quadros).
    const back = t + step;
    t = feed(e, Array(S.minPositive).fill('positive'), back, step);
    expect(e.decide(1, 'safety_glasses', t, S).status).not.toBe('NOT_DETECTED');
    t = feed(e, Array(4).fill('positive'), t + step, step);
    expect(e.decide(1, 'safety_glasses', t, S).status).toBe('DETECTED');
  });

  it('observações ambíguas (confiança baixa) nunca contam como ausência', () => {
    const e = new VerificationEngine();
    const seq: ObservationOutcome[] = Array.from({ length: 40 }, (_, i) => (i % 2 ? 'ambiguous' : 'negative'));
    const t = feed(e, seq);
    expect(e.decide(1, 'safety_glasses', t, S)).toMatchObject({ status: 'UNCERTAIN', reason: 'ambiguous_scores' });
  });

  it('imagem inobservável mantém o estado incerto com o motivo', () => {
    const e = new VerificationEngine();
    const t = feed(e, Array(40).fill('unobservable'), 0, 200, 'blurry');
    const d = e.decide(1, 'safety_glasses', t, S);
    expect(d).toMatchObject({ status: 'UNCERTAIN', reason: 'blurry' });
    expect(d.counts.unobservable).toBeGreaterThan(0);
    expect(d.progress).toBe(0);
  });

  it('detecções inconsistentes resultam em incerto, não em decisão', () => {
    const e = new VerificationEngine();
    // Na janela final: 5 positivas e 21 negativas -> P < N (não detectado) e 81% < 85% (não ausente).
    const seq: ObservationOutcome[] = Array.from({ length: 32 }, (_, i) => (i % 6 === 0 ? 'positive' : 'negative'));
    const t = feed(e, seq);
    const d = e.decide(1, 'safety_glasses', t, S);
    expect(d.status).toBe('UNCERTAIN');
    expect(d.reason).toBe('inconsistent');
  });

  it('observações antigas saem da janela', () => {
    const e = new VerificationEngine();
    feed(e, ['positive', 'positive', 'positive']);
    expect(e.decide(1, 'safety_glasses', 400, S).status).toBe('DETECTED');
    expect(e.decide(1, 'safety_glasses', 400 + 6000, S).status).toBe('UNCERTAIN');
  });

  it('pessoas diferentes têm janelas independentes', () => {
    const e = new VerificationEngine();
    for (let i = 0; i < 3; i++) {
      e.observe(1, i * 100, [{ cls: 'hairnet', outcome: 'positive', score: 0.9 }], S);
      e.observe(2, i * 100, [{ cls: 'hairnet', outcome: 'negative', score: 0 }], S);
    }
    expect(e.decide(1, 'hairnet', 300, S).status).toBe('DETECTED');
    expect(e.decide(2, 'hairnet', 300, S).status).toBe('UNCERTAIN');
    e.dropTrack(1);
    expect(e.decide(1, 'hairnet', 300, S).reason).toBe('no_subject');
  });

  it('a contagem regressiva reinicia após um intervalo longo sem observações válidas', () => {
    const e = new VerificationEngine();
    feed(e, Array(5).fill('negative'));
    const t = feed(e, ['negative'], 20000);
    expect(e.decide(1, 'safety_glasses', t, S).verifyRemainingMs).toBe(5000);
  });
});
