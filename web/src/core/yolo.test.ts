import { describe, expect, it } from 'vitest';
import { computeLetterbox, computeResize } from './geometry';
import { decodeYolo, inferOutputFormat, nms, rawStats, rgbaToChw } from './yolo';

const classes = ['head', 'safety_glasses'];
const lb = computeLetterbox(320, 320, 320);
const base = { classNames: classes, scoreThreshold: 0.25, iouThreshold: 0.45, letterbox: lb, srcWidth: 320, srcHeight: 320 };

/** Monta um tensor [1, 4+nc, N] no layout canal-primeiro da Ultralytics. */
function rawTensor(cands: { cx: number; cy: number; w: number; h: number; scores: number[] }[]) {
  const n = cands.length;
  const c = 4 + classes.length;
  const data = new Float32Array(c * n);
  cands.forEach((k, i) => {
    data[i] = k.cx;
    data[n + i] = k.cy;
    data[2 * n + i] = k.w;
    data[3 * n + i] = k.h;
    k.scores.forEach((s, j) => (data[(4 + j) * n + i] = s));
  });
  return { data, dims: [1, c, n] };
}

describe('decodificação YOLO', () => {
  it('infere o formato pela forma do tensor', () => {
    expect(inferOutputFormat([1, 6, 2100], 2)).toBe('yolo-raw');
    expect(inferOutputFormat([1, 300, 6], 4)).toBe('yolo-end2end');
    expect(() => inferOutputFormat([1, 84, 2100], 4)).toThrow(/incompatível/);
  });

  it('decodifica saída bruta, aplica limiar e NMS por classe', () => {
    const { data, dims } = rawTensor([
      { cx: 100, cy: 100, w: 50, h: 50, scores: [0.9, 0.1] },
      { cx: 102, cy: 101, w: 50, h: 50, scores: [0.8, 0.05] }, // duplicata suprimida
      { cx: 100, cy: 100, w: 40, h: 20, scores: [0.1, 0.7] }, // outra classe, mesma região: mantida
      { cx: 200, cy: 200, w: 30, h: 30, scores: [0.2, 0.1] }, // abaixo do limiar
    ]);
    const out = decodeYolo(data, { ...base, format: 'yolo-raw', dims });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ className: 'head', score: expect.closeTo(0.9, 5), x1: 75, y1: 75, x2: 125, y2: 125 });
    expect(out[1].className).toBe('safety_glasses');
  });

  it('decodifica saída end-to-end [1,N,6] sem NMS', () => {
    const data = new Float32Array([10, 10, 50, 50, 0.95, 1, 0, 0, 5, 5, 0.1, 0]);
    const out = decodeYolo(data, { ...base, format: 'yolo-end2end', dims: [1, 2, 6] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ className: 'safety_glasses', x1: 10, x2: 50 });
  });

  it('remove o letterbox e limita ao quadro de origem', () => {
    const lb2 = computeLetterbox(640, 480, 320); // escala 0.5, padY 40
    const { data, dims } = rawTensor([{ cx: 160, cy: 160, w: 400, h: 100, scores: [0.9, 0] }]);
    const [d] = decodeYolo(data, { ...base, format: 'yolo-raw', dims, letterbox: lb2, srcWidth: 640, srcHeight: 480 });
    expect(d.x1).toBe(0);
    expect(d.x2).toBe(640);
    expect(d.y1).toBeCloseTo((110 - 40) / 0.5);
  });

  it('modo stretch: desfaz escalas X e Y independentes', () => {
    const s = computeResize(1280, 720, 320, 'stretch'); // sx 0.25, sy 0.444
    const { data, dims } = rawTensor([{ cx: 160, cy: 160, w: 80, h: 80, scores: [0.9, 0] }]);
    const [d] = decodeYolo(data, { ...base, format: 'yolo-raw', dims, letterbox: s, srcWidth: 1280, srcHeight: 720 });
    expect(d.x1).toBeCloseTo(480);
    expect(d.x2).toBeCloseTo(800);
    expect(d.y1).toBeCloseTo(270);
    expect(d.y2).toBeCloseTo(450);
  });

  it('estatísticas brutas: maior escore por classe e candidatos', () => {
    const { data, dims } = rawTensor([
      { cx: 1, cy: 1, w: 2, h: 2, scores: [0.3, 0.05] },
      { cx: 1, cy: 1, w: 2, h: 2, scores: [0.1, 0.6] },
    ]);
    const r = rawStats(data, 'yolo-raw', dims, 2);
    expect(r.maxPerClass[0]).toBeCloseTo(0.3);
    expect(r.maxPerClass[1]).toBeCloseTo(0.6);
    expect(r.candidatesAbove025).toBe(2);
    const e2e = rawStats(new Float32Array([0, 0, 1, 1, 0.7, 1, 0, 0, 1, 1, 0.2, 0]), 'yolo-end2end', [1, 2, 6], 2);
    expect(e2e.maxPerClass[1]).toBeCloseTo(0.7);
    expect(e2e.maxPerClass[0]).toBeCloseTo(0.2);
    expect(e2e.candidatesAbove025).toBe(1);
  });

  it('NMS respeita o limite de detecções', () => {
    const dets = Array.from({ length: 5 }, (_, i) => ({ x1: i * 100, y1: 0, x2: i * 100 + 50, y2: 50, classIndex: 0, className: 'head', score: 0.5 + i / 10 }));
    expect(nms(dets, 0.5, 3)).toHaveLength(3);
  });

  it('converte RGBA em CHW normalizado', () => {
    const t = rgbaToChw(new Uint8ClampedArray([255, 0, 51, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255]), 2);
    expect(Array.from(t.slice(0, 4))).toEqual([1, 0, 0, 1]);
    expect(t[4 + 1]).toBe(1);
    expect(t[8]).toBeCloseTo(0.2);
  });
});
