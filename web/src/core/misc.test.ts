import { describe, expect, it } from 'vitest';
import { PPE_MANIFEST } from '../test/fixtures';
import { AlertManager } from './alerts';
import { computeMetrics, isInsufficient, latencyStats, samplesToCsv, type EvalSample } from './evaluation';
import { validateManifest, supportedTargets } from './manifest';
import { laplacianVariance, measureQuality } from './quality';
import { ANALYSIS_MODES, currentMode, DEFAULT_SETTINGS, effectiveSettings, sanitizeSettings } from './settings';

describe('alertas com supressão de repetição', () => {
  it('alerta na transição e respeita o cooldown por pessoa/classe', () => {
    const a = new AlertManager(10000, 0);
    expect(a.update(1, 'hairnet', 'UNCERTAIN', 0)).toBeNull();
    expect(a.update(1, 'hairnet', 'NOT_DETECTED', 100)).toMatchObject({ trackId: 1, cls: 'hairnet', audible: true });
    expect(a.update(1, 'hairnet', 'NOT_DETECTED', 200)).toBeNull(); // persistente: sem repetição
    expect(a.update(1, 'hairnet', 'DETECTED', 300)).toBeNull();
    expect(a.update(1, 'hairnet', 'NOT_DETECTED', 400)).toBeNull(); // oscilando: ainda no cooldown
    expect(a.update(1, 'hairnet', 'NOT_DETECTED', 10200)).not.toBeNull(); // lembrete após cooldown
  });

  it('classes e pessoas diferentes alertam independentemente, mas o som respeita o intervalo global', () => {
    const a = new AlertManager(10000, 3000);
    expect(a.update(1, 'hairnet', 'NOT_DETECTED', 0)?.audible).toBe(true);
    expect(a.update(1, 'safety_glasses', 'NOT_DETECTED', 500)?.audible).toBe(false);
    expect(a.update(2, 'hairnet', 'NOT_DETECTED', 3500)?.audible).toBe(true);
  });

  it('remover a pessoa limpa o histórico de alertas dela', () => {
    const a = new AlertManager(10000, 0);
    a.update(1, 'hairnet', 'NOT_DETECTED', 0);
    a.dropTrack(1);
    expect(a.update(1, 'hairnet', 'NOT_DETECTED', 10)).not.toBeNull();
  });
});

describe('configurações', () => {
  it('valores inválidos voltam ao padrão e são limitados', () => {
    const s = sanitizeSettings({ windowMs: -5, minObservations: 'x', classes: { hairnet: { threshold: 3, ambiguousFloor: 0.99 } } });
    expect(s.windowMs).toBe(1000);
    expect(s.minObservations).toBe(DEFAULT_SETTINGS.minObservations);
    expect(s.classes.hairnet.threshold).toBe(0.99);
    expect(s.classes.hairnet.ambiguousFloor).toBeLessThanOrEqual(s.classes.hairnet.threshold);
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('configurações antigas (minSubjectHeight em fração) caem no portão em pixels e no refino padrão', () => {
    const s = sanitizeSettings({ minSubjectHeight: 0.12, refineMaxCrops: 9, headRefine: 'sim' });
    expect(s).not.toHaveProperty('minSubjectHeight');
    expect(s.minSubjectPx).toBe(DEFAULT_SETTINGS.minSubjectPx);
    expect(s.refineMaxCrops).toBe(4);
    expect(s.headRefine).toBe(DEFAULT_SETTINGS.headRefine);
  });

  it('piso de ambiguidade nunca excede o limiar', () => {
    const s = sanitizeSettings({ classes: { safety_glasses: { threshold: 0.3, ambiguousFloor: 0.6 } } });
    expect(s.classes.safety_glasses.ambiguousFloor).toBe(0.3);
  });
});

describe('manifesto do modelo', () => {
  it('aceita um manifesto válido', () => {
    const m = validateManifest(PPE_MANIFEST);
    expect([...supportedTargets(m)].sort()).toEqual(['hairnet', 'hearing_protection', 'safety_glasses']);
  });

  it.each([
    [{ ...PPE_MANIFEST, purpose: 'x' }, /purpose/],
    [{ ...PPE_MANIFEST, inputSize: 300 }, /múltiplo de 32/],
    [{ ...PPE_MANIFEST, subjectClass: 'person' }, /subjectClass/],
    [{ ...PPE_MANIFEST, ppeClassMap: { helmet: 'hairnet' } }, /não existe/],
    [{ ...PPE_MANIFEST, ppeClassMap: { hairnet: 'helmet' } }, /não é uma classe/],
    [{ ...PPE_MANIFEST, ppeClassMap: {} }, /ao menos uma/],
    [{ ...PPE_MANIFEST, classes: [] }, /classes/],
    [null, /ausente/],
  ])('rejeita manifesto inválido %#', (m, re) => {
    expect(() => validateManifest(m)).toThrow(re);
  });

  const CROP = {
    name: 'crop',
    version: '0.3.0',
    file: 'crop.onnx',
    inputSize: 416,
    classes: ['safety_glasses', 'hearing_protection', 'hairnet'],
    ppeClassMap: { safety_glasses: 'safety_glasses', hairnet: 'hairnet' },
  };
  const FACE_MAIN = {
    ...PPE_MANIFEST,
    classes: ['face', 'glasses', 'earmuffs'],
    subjectClass: 'face',
    ppeClassMap: { glasses: 'safety_glasses', earmuffs: 'hearing_protection' },
    proxyClasses: { safety_glasses: 'óculos comuns' },
  };

  it('cropModel substitui o mapa de EPIs pelo do modelo de recorte', () => {
    const m = validateManifest({ ...FACE_MAIN, cropModel: CROP });
    expect([...supportedTargets(m)].sort()).toEqual(['hairnet', 'safety_glasses']);
    expect(m.mainPpeClassMap).toEqual(FACE_MAIN.ppeClassMap);
    expect(m.proxyClasses).toBeUndefined(); // a aproximação era do modelo principal
    expect(m.cropModel?.classes).toEqual(CROP.classes);
  });

  it('keepMainClasses soma classes do modelo principal e herda a nota de aproximação', () => {
    const m = validateManifest({ ...FACE_MAIN, cropModel: { ...CROP, keepMainClasses: ['glasses'] } });
    expect(m.ppeClassMap).toEqual({ safety_glasses: 'safety_glasses', hairnet: 'hairnet', glasses: 'safety_glasses' });
    expect(m.proxyClasses).toEqual({ safety_glasses: 'óculos comuns' });
    expect(m.cropModel?.keepMainClasses).toEqual(['glasses']);
    expect([...supportedTargets(m)].sort()).toEqual(['hairnet', 'safety_glasses']);
  });

  it('cropModelFallback vira um manifesto completo com o modelo anterior no lugar', () => {
    const old = { ...CROP, name: 'antigo', version: '0.3.0', file: 'old.onnx' };
    const m = validateManifest({ ...FACE_MAIN, cropModel: { ...CROP, version: '0.4.0' }, cropModelFallback: old });
    expect(m.cropModel?.version).toBe('0.4.0');
    expect(m.fallback?.cropModel).toMatchObject({ name: 'antigo', file: 'old.onnx' });
    expect(m.fallback?.fallback).toBeUndefined();
    const t = validateManifest({ ...FACE_MAIN, thresholds: { hairnet: 0.3 }, cropModel: { ...CROP, thresholds: { hairnet: 0.6 } } });
    expect(t.thresholds).toEqual({ hairnet: 0.6 });
    expect(() => validateManifest({ ...FACE_MAIN, cropModel: CROP, cropModelFallback: { ...CROP, inputSize: 300 } })).toThrow(/cropModelFallback/);
  });

  it.each([
    [{ ...FACE_MAIN, cropModel: { ...CROP, keepMainClasses: ['face'] } }, /keepMainClasses/],
    [{ ...FACE_MAIN, cropModel: { ...CROP, keepMainClasses: 'glasses' } }, /keepMainClasses/],
    [{ ...FACE_MAIN, subjectClass: undefined, cropModel: CROP }, /subjectClass/],
    [{ ...FACE_MAIN, cropModel: { ...CROP, inputSize: 300 } }, /cropModel\.inputSize/],
    [{ ...FACE_MAIN, cropModel: { ...CROP, ppeClassMap: { helmet: 'hairnet' } } }, /cropModel\.ppeClassMap/],
    [{ ...FACE_MAIN, cropModel: { ...CROP, classes: ['face', 'hairnet'], ppeClassMap: { hairnet: 'hairnet' } } }, /sujeito/],
    [{ ...FACE_MAIN, cropModel: { ...CROP, subjectClass: 'hairnet' } }, /cropModel\.subjectClass/],
  ])('rejeita cropModel inválido %#', (m, re) => {
    expect(() => validateManifest(m)).toThrow(re);
  });

  it('modelo de diagnóstico pode não mapear nenhuma classe de EPI', () => {
    const m = validateManifest({ ...PPE_MANIFEST, purpose: 'diagnostic', classes: ['person'], subjectClass: 'person', ppeClassMap: {} });
    expect(supportedTargets(m).size).toBe(0);
  });
});

describe('qualidade de imagem', () => {
  it('imagem uniforme tem nitidez zero; padrão xadrez tem nitidez alta', () => {
    const w = 16;
    const flat = new Float32Array(w * w).fill(128);
    expect(laplacianVariance(flat, w, w)).toBe(0);
    const checker = Float32Array.from({ length: w * w }, (_, i) => (((i % w) + Math.floor(i / w)) % 2 ? 255 : 0));
    expect(laplacianVariance(checker, w, w)).toBeGreaterThan(1000);
  });

  it('mede o brilho médio', () => {
    const rgba = new Uint8ClampedArray(4 * 9).fill(200);
    expect(measureQuality(rgba, 3, 3).brightness).toBeCloseTo(200);
  });
});

describe('avaliação com gabarito', () => {
  const s = (scenario: number, truth: boolean, status: EvalSample['status']): EvalSample => ({ t: 0, scenario, cls: 'hairnet', truth, status });

  it('calcula VP/FP/FN/VN, precisão, revocação e cobertura', () => {
    const m = computeMetrics([
      s(1, true, 'DETECTED'),
      s(1, true, 'DETECTED'),
      s(1, true, 'NOT_DETECTED'),
      s(2, false, 'DETECTED'),
      s(2, false, 'NOT_DETECTED'),
      s(2, false, 'UNCERTAIN'),
    ]).hairnet;
    expect(m).toMatchObject({ tp: 2, fn: 1, fp: 1, tn: 1, uncertain: 1, scenarios: 2, samples: 6 });
    expect(m.precision).toBeCloseTo(2 / 3);
    expect(m.recall).toBeCloseTo(2 / 3);
    expect(m.coverage).toBeCloseTo(5 / 6);
    expect(isInsufficient(m)).toBe(true);
  });

  it('métricas ficam indefinidas sem dados', () => {
    const m = computeMetrics([]).safety_glasses;
    expect(m.precision).toBeNull();
    expect(m.recall).toBeNull();
    expect(isInsufficient(m)).toBe(true);
  });

  it('estatísticas de latência e CSV', () => {
    expect(latencyStats([])).toBeNull();
    expect(latencyStats([10, 20, 30, 40, 100])).toMatchObject({ count: 5, p50: 30, max: 100, mean: 40 });
    expect(samplesToCsv([s(1, true, 'DETECTED')]).split('\n')[1]).toMatch(/,1,hairnet,1,DETECTED$/);
  });
});

describe('modos de análise', () => {
  it('cada modo é reconhecido depois de aplicado, e o padrão é Equilibrado', () => {
    expect(currentMode(DEFAULT_SETTINGS)).toBe('balanced');
    for (const m of ['fast', 'balanced', 'detail'] as const) {
      expect(currentMode({ ...DEFAULT_SETTINGS, ...ANALYSIS_MODES[m].patch })).toBe(m);
    }
  });

  it('ajuste manual vira "personalizado" e os valores dos modos passam pela validação', () => {
    expect(currentMode({ ...DEFAULT_SETTINGS, refineMaxCrops: 3 })).toBeNull();
    for (const { patch } of Object.values(ANALYSIS_MODES)) {
      expect(sanitizeSettings({ ...DEFAULT_SETTINGS, ...patch })).toMatchObject(patch);
    }
  });
});

describe('limiares recomendados pelo modelo', () => {
  it('substituem os manuais só nas classes em que existem e só com useModelThresholds', () => {
    const m = { thresholds: { safety_glasses: 0.45, hearing_protection: 0.4 } };
    const eff = effectiveSettings(DEFAULT_SETTINGS, m);
    expect(eff.classes.safety_glasses).toEqual({ threshold: 0.45, ambiguousFloor: 0.25 });
    expect(eff.classes.hearing_protection.threshold).toBe(0.4);
    expect(eff.classes.hairnet).toEqual(DEFAULT_SETTINGS.classes.hairnet);
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, useModelThresholds: false }, m)).toEqual({ ...DEFAULT_SETTINGS, useModelThresholds: false });
    expect(effectiveSettings(DEFAULT_SETTINGS, { thresholds: { hairnet: 0.2 } }).classes.hairnet.ambiguousFloor).toBe(0.2);
  });

  it('o manifesto valida os limiares e, com cropModel, usa os do recorte', () => {
    expect(() => validateManifest({ ...PPE_MANIFEST, thresholds: { helmet: 0.4 } })).toThrow(/thresholds/);
    expect(() => validateManifest({ ...PPE_MANIFEST, thresholds: { hairnet: 1.5 } })).toThrow(/thresholds/);
  });
});
