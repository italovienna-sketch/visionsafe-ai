import { describe, expect, it } from 'vitest';
import { computeDisplayTransform, computeLetterbox, computeResize, containment, headCrop, iou, toDisplay, unletterbox } from './geometry';

describe('geometria', () => {
  it('recorte da cabeça: quadrado ampliado, deslocado para cima e dentro do quadro', () => {
    const c = headCrop({ x1: 600, y1: 300, x2: 640, y2: 350 }, 1280, 720, 2.2, 96);
    expect(c.x2 - c.x1).toBe(110);
    expect(c.y2 - c.y1).toBe(110);
    expect((c.x1 + c.x2) / 2).toBeCloseTo(620, 0);
    expect((c.y1 + c.y2) / 2).toBeLessThan(325);
    // Rosto minúsculo: usa o lado mínimo. Rosto na borda: recorte não sai do quadro.
    const tiny = headCrop({ x1: 0, y1: 0, x2: 10, y2: 12 }, 1280, 720, 2.2, 96);
    expect(tiny).toEqual({ x1: 0, y1: 0, x2: 96, y2: 96 });
    const edge = headCrop({ x1: 1250, y1: 690, x2: 1280, y2: 720 }, 1280, 720, 2.2, 96);
    expect(edge.x2).toBe(1280);
    expect(edge.y2).toBe(720);
    // Rosto enorme: limitado ao menor lado do quadro.
    const big = headCrop({ x1: 100, y1: 0, x2: 700, y2: 700 }, 1280, 720, 2.2, 96);
    expect(big.y2 - big.y1).toBe(720);
  });

  it('IoU de caixas idênticas, disjuntas e parciais', () => {
    const a = { x1: 0, y1: 0, x2: 10, y2: 10 };
    expect(iou(a, a)).toBe(1);
    expect(iou(a, { x1: 20, y1: 20, x2: 30, y2: 30 })).toBe(0);
    expect(iou(a, { x1: 5, y1: 0, x2: 15, y2: 10 })).toBeCloseTo(50 / 150);
  });

  it('containment mede a fração da caixa interna dentro da externa', () => {
    expect(containment({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 5, y1: 0, x2: 100, y2: 100 })).toBeCloseTo(0.5);
  });

  it('letterbox -> unletterbox recupera as coordenadas originais', () => {
    const lb = computeLetterbox(1280, 720, 320);
    expect(lb.scaleX).toBeCloseTo(0.25);
    expect(lb.padX).toBe(0);
    expect(lb.padY).toBe(70);
    const original = { x1: 100, y1: 200, x2: 500, y2: 600 };
    const inModel = {
      x1: original.x1 * lb.scaleX + lb.padX,
      y1: original.y1 * lb.scaleY + lb.padY,
      x2: original.x2 * lb.scaleX + lb.padX,
      y2: original.y2 * lb.scaleY + lb.padY,
    };
    const back = unletterbox(inModel, lb, 1280, 720);
    expect(back.x1).toBeCloseTo(100);
    expect(back.y2).toBeCloseTo(600);
  });

  it('modo stretch usa escalas independentes em X e Y, sem bordas', () => {
    const s = computeResize(1280, 720, 320, 'stretch');
    expect(s).toMatchObject({ scaleX: 0.25, padX: 0, padY: 0, width: 320, height: 320 });
    expect(s.scaleY).toBeCloseTo(320 / 720);
    const back = unletterbox({ x1: 32, y1: 32, x2: 64, y2: 160 }, s, 1280, 720);
    expect(back).toEqual({ x1: 128, y1: 72, x2: 256, y2: 360 });
    expect(computeResize(1280, 720, 320, 'letterbox')).toEqual(computeLetterbox(1280, 720, 320));
  });

  it('transformação de exibição reproduz object-fit contain com faixas', () => {
    // vídeo 640x480 numa área 400x600: escala 0.625, faixas verticais de (600-300)/2 = 150
    const t = computeDisplayTransform(640, 480, 400, 600, 'contain', false);
    expect(t.scale).toBeCloseTo(0.625);
    expect(t.offsetY).toBeCloseTo(150);
    const b = toDisplay({ x1: 0, y1: 0, x2: 640, y2: 480 }, t);
    expect(b).toEqual({ x1: 0, y1: 150, x2: 400, y2: 450 });
  });

  it('cover corta as bordas e espelhamento inverte o eixo X', () => {
    const cover = computeDisplayTransform(640, 480, 400, 600, 'cover', false);
    expect(cover.scale).toBeCloseTo(1.25);
    expect(cover.offsetX).toBeCloseTo(-200);
    const m = computeDisplayTransform(640, 480, 640, 480, 'contain', true);
    expect(toDisplay({ x1: 0, y1: 0, x2: 100, y2: 50 }, m)).toEqual({ x1: 540, y1: 0, x2: 640, y2: 50 });
  });
});
