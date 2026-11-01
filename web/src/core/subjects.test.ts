import { describe, expect, it } from 'vitest';
import { det, EARMUFF, frame, GLASSES, HAIRNET, HEAD, PPE_MANIFEST, settings } from '../test/fixtures';
import type { ModelManifest } from './manifest';
import { analyzeFrame, classifyObservation, confirmedInFirstPass, SubjectTracker } from './subjects';

const S = settings();

describe('associação de EPIs a pessoas', () => {
  it('associa óculos, protetor concha e touca à cabeça correta', () => {
    const f = frame([det('head', HEAD, 0.9), det('safety_glasses', GLASSES, 0.8), det('hearing_protection', EARMUFF, 0.7), det('hairnet', HAIRNET, 0.6)]);
    const a = analyzeFrame(f, PPE_MANIFEST, S);
    expect(a.subjects).toHaveLength(1);
    expect(a.subjects[0].unobservable).toBeNull();
    expect(a.subjects[0].ppeScores).toEqual({ safety_glasses: 0.8, hearing_protection: 0.7, hairnet: 0.6 });
    expect(a.unassigned).toHaveLength(0);
  });

  it('não mistura EPIs de pessoas diferentes', () => {
    const left = { x1: 20, y1: 100, x2: 160, y2: 260 };
    const right = { x1: 440, y1: 100, x2: 580, y2: 260 };
    const glassesLeft = { x1: 50, y1: 160, x2: 130, y2: 190 };
    const f = frame([det('head', left, 0.9), det('head', right, 0.9), det('safety_glasses', glassesLeft, 0.9)]);
    const a = analyzeFrame(f, PPE_MANIFEST, S);
    expect(a.subjects[0].ppeScores.safety_glasses).toBeCloseTo(0.9);
    expect(a.subjects[1].ppeScores.safety_glasses).toBe(0);
  });

  it('com rosto como sujeito, conchas ao lado do rosto são associadas', () => {
    const m: ModelManifest = {
      ...PPE_MANIFEST,
      classes: ['face', 'glasses', 'earmuffs'],
      subjectClass: 'face',
      ppeClassMap: { glasses: 'safety_glasses', earmuffs: 'hearing_protection' },
    };
    const face = { x1: 260, y1: 160, x2: 340, y2: 260 }; // 80×100
    const muffRight = { x1: 330, y1: 185, x2: 380, y2: 245 }; // quase toda fora do rosto
    const glasses = { x1: 268, y1: 190, x2: 332, y2: 212 };
    const far = { x1: 500, y1: 180, x2: 540, y2: 230 };
    const a = analyzeFrame(frame([det('face', face, 0.9), det('earmuffs', muffRight, 0.7), det('glasses', glasses, 0.8), det('earmuffs', far, 0.9)]), m, S);
    expect(a.subjects[0].ppeScores).toMatchObject({ hearing_protection: 0.7, safety_glasses: 0.8 });
    expect(a.unassigned).toHaveLength(1);
  });

  it('a mesma peça vista por dois detectores vira uma caixa só, com a maior confiança', () => {
    const m: ModelManifest = {
      ...PPE_MANIFEST,
      classes: ['head', 'glasses', 'safety_glasses'],
      ppeClassMap: { glasses: 'safety_glasses', safety_glasses: 'safety_glasses' },
    };
    const generic = { x1: 262, y1: 192, x2: 378, y2: 228 };
    const a = analyzeFrame(frame([det('head', HEAD, 0.9, m), det('glasses', generic, 0.6, m), det('safety_glasses', GLASSES, 0.8, m)]), m, S);
    expect(a.subjects[0].ppeDetections).toHaveLength(1);
    expect(a.subjects[0].ppeDetections[0].className).toBe('safety_glasses');
    expect(a.subjects[0].ppeScores.safety_glasses).toBe(0.8);
  });

  it('peças separadas da mesma classe (as duas conchas) continuam duas caixas', () => {
    const left = { x1: 190, y1: 200, x2: 240, y2: 270 };
    const right = { x1: 400, y1: 200, x2: 450, y2: 270 };
    const a = analyzeFrame(frame([det('head', HEAD, 0.9), det('hearing_protection', left, 0.7), det('hearing_protection', right, 0.6)]), PPE_MANIFEST, S);
    expect(a.subjects[0].ppeDetections).toHaveLength(2);
  });

  it('EPI entre duas pessoas próximas não é atribuído a nenhuma e não vira ausência', () => {
    const left = { x1: 150, y1: 120, x2: 300, y2: 300 };
    const right = { x1: 320, y1: 120, x2: 470, y2: 300 };
    const between = { x1: 290, y1: 200, x2: 330, y2: 240 };
    const a = analyzeFrame(frame([det('head', left, 0.9), det('head', right, 0.9), det('hearing_protection', between, 0.9)]), PPE_MANIFEST, S);
    expect(a.ambiguous).toHaveLength(1);
    expect(a.subjects.map((s) => s.ppeScores.hearing_protection)).toEqual([0, 0]);
    for (const s of a.subjects) expect(classifyObservation(s, 'hearing_protection', S)).toBe('ambiguous');
    // Outras classes dessas pessoas continuam negativas normalmente.
    expect(classifyObservation(a.subjects[0], 'hairnet', S)).toBe('negative');
  });

  it('EPI longe de qualquer cabeça fica sem associação', () => {
    const f = frame([det('head', HEAD, 0.9), det('safety_glasses', { x1: 560, y1: 400, x2: 630, y2: 470 }, 0.9)]);
    const a = analyzeFrame(f, PPE_MANIFEST, S);
    expect(a.unassigned).toHaveLength(1);
    expect(a.subjects[0].ppeScores.safety_glasses).toBe(0);
  });

  it('ignora cabeças abaixo da confiança mínima', () => {
    const a = analyzeFrame(frame([det('head', HEAD, 0.2)]), PPE_MANIFEST, S);
    expect(a.subjects).toHaveLength(0);
  });

  it('portão de tamanho: com recorte da cabeça vale minSubjectPx; sem recorte, a regra antiga de 12% do quadro', () => {
    const small = { x1: 300, y1: 200, x2: 345, y2: 250 }; // 50 px num quadro de 480
    const crop = { x1: 200, y1: 100, x2: 450, y2: 350 };
    const refined = analyzeFrame(frame([det('head', small, 0.9)], { crops: [crop] }), PPE_MANIFEST, S);
    expect(refined.subjects[0].unobservable).toBeNull();
    const notRefined = analyzeFrame(frame([det('head', small, 0.9)]), PPE_MANIFEST, S);
    expect(notRefined.subjects[0].unobservable).toBe('subject_small'); // 50 < 0,12 × 480
    const tiny = { x1: 300, y1: 200, x2: 325, y2: 230 };
    const far = analyzeFrame(frame([det('head', tiny, 0.9)], { crops: [crop] }), PPE_MANIFEST, S);
    expect(far.subjects[0].unobservable).toBe('subject_small'); // 30 < 48 px mesmo com recorte
  });

  it('marca como inobservável: pessoa pequena, cortada, borrada ou escura', () => {
    const small = analyzeFrame(frame([det('head', { x1: 300, y1: 200, x2: 330, y2: 230 }, 0.9)]), PPE_MANIFEST, S);
    expect(small.subjects[0].unobservable).toBe('subject_small');
    const cut = analyzeFrame(frame([det('head', { x1: 0, y1: 100, x2: 200, y2: 300 }, 0.9)]), PPE_MANIFEST, S);
    expect(cut.subjects[0].unobservable).toBe('subject_truncated');
    const blur = analyzeFrame(frame([det('head', HEAD, 0.9)], { quality: { sharpness: 2, brightness: 120 } }), PPE_MANIFEST, S);
    expect(blur.subjects[0].unobservable).toBe('blurry');
    const dark = analyzeFrame(frame([det('head', HEAD, 0.9)], { quality: { sharpness: 200, brightness: 10 } }), PPE_MANIFEST, S);
    expect(dark.subjects[0].unobservable).toBe('too_dark');
  });

  it('modelo sem classe de sujeito trata o quadro inteiro como uma pessoa', () => {
    const m: ModelManifest = { ...PPE_MANIFEST, classes: ['safety_glasses'], subjectClass: undefined, ppeClassMap: { safety_glasses: 'safety_glasses' } };
    const a = analyzeFrame(frame([det('safety_glasses', GLASSES, 0.8, m)]), m, S);
    expect(a.subjects).toHaveLength(1);
    expect(a.subjects[0].wholeFrame).toBe(true);
    expect(a.subjects[0].ppeScores.safety_glasses).toBeCloseTo(0.8);
  });
});

describe('modelo de recorte (cropModel) como única fonte de EPIs', () => {
  const M: ModelManifest = {
    ...PPE_MANIFEST,
    cropModel: { name: 'c', version: '1', file: 'c.onnx', inputSize: 416, classes: ['safety_glasses'], ppeClassMap: { safety_glasses: 'safety_glasses' } },
    ppeClassMap: { safety_glasses: 'safety_glasses' },
  };

  it('pessoa sem recorte fica "não analisada" (incerta), nunca negativa', () => {
    const a = analyzeFrame(frame([det('head', HEAD, 0.9)]), M, S);
    expect(a.subjects[0].unobservable).toBe('not_refined');
    expect(classifyObservation(a.subjects[0], 'safety_glasses', S)).toBe('unobservable');
  });

  it('pessoa dentro do recorte é analisada normalmente', () => {
    const crop = { x1: 120, y1: 20, x2: 520, y2: 420 };
    const a = analyzeFrame(frame([det('head', HEAD, 0.9), det('safety_glasses', GLASSES, 0.8)], { crops: [crop] }), M, S);
    expect(a.subjects[0].unobservable).toBeNull();
    expect(classifyObservation(a.subjects[0], 'safety_glasses', S)).toBe('positive');
  });
});

describe('classificação de observações por limiar', () => {
  const subj = (score: number, unobservable: null | 'blurry' = null) =>
    analyzeFrame(frame([det('head', HEAD, 0.9), ...(score ? [det('safety_glasses', GLASSES, score)] : [])], { quality: unobservable ? { sharpness: 1, brightness: 120 } : undefined }), PPE_MANIFEST, S).subjects[0];

  it('acima do limiar = positiva; entre piso e limiar = ambígua; abaixo = negativa', () => {
    expect(classifyObservation(subj(0.8), 'safety_glasses', S)).toBe('positive');
    expect(classifyObservation(subj(0.35), 'safety_glasses', S)).toBe('ambiguous');
    expect(classifyObservation(subj(0.12), 'safety_glasses', S)).toBe('negative');
    expect(classifyObservation(subj(0), 'safety_glasses', S)).toBe('negative');
  });

  it('limiar configurável por classe', () => {
    const strict = settings({ classes: { ...S.classes, safety_glasses: { threshold: 0.9, ambiguousFloor: 0.3 } } });
    expect(classifyObservation(subj(0.8), 'safety_glasses', strict)).toBe('ambiguous');
  });

  it('pessoa inobservável nunca gera negativa', () => {
    expect(classifyObservation(subj(0, 'blurry'), 'safety_glasses', S)).toBe('unobservable');
  });
});

describe('rastreamento', () => {
  it('mantém o id enquanto a pessoa se move pouco e expira após o TTL', () => {
    const tr = new SubjectTracker(1000, 0.3);
    const a = tr.update([HEAD], 0).ids[0];
    const moved = { ...HEAD, x1: HEAD.x1 + 10, x2: HEAD.x2 + 10 };
    expect(tr.update([moved], 100).ids[0]).toBe(a);
    const { ids, expired } = tr.update([], 2000);
    expect(ids).toEqual([]);
    expect(expired).toEqual([a]);
    expect(tr.update([HEAD], 2100).ids[0]).not.toBe(a);
  });

  it('com quadros lentos, o TTL estendido mantém a mesma pessoa', () => {
    const tr = new SubjectTracker(1500, 0.3);
    const a = tr.update([HEAD], 0).ids[0];
    // Próxima inferência só 2,4 s depois (aparelho lento): sem extensão a trilha expiraria.
    const { ids, expired } = tr.update([HEAD], 2400, 5000);
    expect(ids[0]).toBe(a);
    expect(expired).toEqual([]);
    // A extensão nunca encurta o TTL mínimo.
    expect(tr.update([HEAD], 3000, 10).ids[0]).toBe(a);
  });

  it('duas pessoas recebem ids distintos', () => {
    const tr = new SubjectTracker();
    const { ids } = tr.update([HEAD, { x1: 0, y1: 0, x2: 50, y2: 50 }], 0);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('dispensa da passada redundante no recorte', () => {
  const m = { subjectClass: 'face', skipMainAbove: { glasses: 0.5 } };
  const face = { x1: 260, y1: 160, x2: 340, y2: 260 };
  const glasses = { x1: 268, y1: 190, x2: 332, y2: 212 };
  const g = (score: number, box = glasses) => ({ ...box, className: 'glasses', classIndex: 1, score });
  const f = { ...face, className: 'face', classIndex: 0, score: 0.9 };

  it('dispensa só quando a 1ª passada já tem óculos acima do limiar nesta pessoa', () => {
    expect(confirmedInFirstPass(f, 'glasses', [f, g(0.7)], [f], m)).toBe(true);
    expect(confirmedInFirstPass(f, 'glasses', [f, g(0.4)], [f], m)).toBe(false);
    expect(confirmedInFirstPass(f, 'glasses', [f], [f], m)).toBe(false);
    expect(confirmedInFirstPass(f, 'glasses', [f, g(0.9)], [f], { subjectClass: 'face' })).toBe(false);
  });

  it('não dispensa se a peça também cabe em outra pessoa', () => {
    const other = { ...face, x1: 300, x2: 380, score: 0.9, className: 'face', classIndex: 0 };
    expect(confirmedInFirstPass(f, 'glasses', [f, other, g(0.9)], [f, other], m)).toBe(false);
  });
});
