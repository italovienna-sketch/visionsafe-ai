import type { Box } from './types';

export function area(b: Box): number {
  return Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
}

export function intersection(a: Box, b: Box): number {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  return w > 0 && h > 0 ? w * h : 0;
}

export function iou(a: Box, b: Box): number {
  const inter = intersection(a, b);
  if (inter === 0) return 0;
  return inter / (area(a) + area(b) - inter);
}

/** Fração da caixa `inner` contida em `outer` (intersection over inner area). */
export function containment(inner: Box, outer: Box): number {
  const a = area(inner);
  return a === 0 ? 0 : intersection(inner, outer) / a;
}

/** Expande a caixa proporcionalmente ao seu tamanho (ex.: 0.3 = 30% para cada lado). */
export function expand(b: Box, ratioX: number, ratioY = ratioX): Box {
  const w = b.x2 - b.x1;
  const h = b.y2 - b.y1;
  return { x1: b.x1 - w * ratioX, y1: b.y1 - h * ratioY, x2: b.x2 + w * ratioX, y2: b.y2 + h * ratioY };
}

/**
 * Como o quadro é ajustado à entrada quadrada do modelo:
 * - letterbox: mantém a proporção e preenche as bordas com cinza 114 (padrão Ultralytics);
 * - stretch: estica o quadro inteiro, para modelos treinados com imagens esticadas (ex.: exportações Roboflow).
 */
export type ResizeMode = 'letterbox' | 'stretch';

export interface Letterbox {
  scaleX: number;
  scaleY: number;
  padX: number;
  padY: number;
  /** Largura/altura do conteúdo redimensionado dentro do quadrado de entrada. */
  width: number;
  height: number;
}

/** Calcula o letterbox (redimensionamento mantendo proporção + bordas) usado pelos modelos YOLO. */
export function computeLetterbox(srcW: number, srcH: number, size: number): Letterbox {
  const scale = Math.min(size / srcW, size / srcH);
  const width = Math.round(srcW * scale);
  const height = Math.round(srcH * scale);
  return { scaleX: scale, scaleY: scale, padX: Math.floor((size - width) / 2), padY: Math.floor((size - height) / 2), width, height };
}

export function computeResize(srcW: number, srcH: number, size: number, mode: ResizeMode): Letterbox {
  if (mode === 'letterbox') return computeLetterbox(srcW, srcH, size);
  return { scaleX: size / srcW, scaleY: size / srcH, padX: 0, padY: 0, width: size, height: size };
}

/** Converte uma caixa no espaço de entrada do modelo para o espaço do quadro de origem. */
export function unletterbox(b: Box, lb: Letterbox, srcW: number, srcH: number): Box {
  const clampX = (v: number) => Math.min(srcW, Math.max(0, v));
  const clampY = (v: number) => Math.min(srcH, Math.max(0, v));
  return {
    x1: clampX((b.x1 - lb.padX) / lb.scaleX),
    y1: clampY((b.y1 - lb.padY) / lb.scaleY),
    x2: clampX((b.x2 - lb.padX) / lb.scaleX),
    y2: clampY((b.y2 - lb.padY) / lb.scaleY),
  };
}

/**
 * Região quadrada da cabeça para a 2ª passada do detector: centrada no sujeito (rosto/cabeça),
 * com lado = `ratio` × o maior lado da caixa, deslocada 10% para cima (touca/topo da cabeça),
 * no mínimo `minSide` px e mantida dentro do quadro. Coordenadas inteiras do quadro nativo.
 * Mesma regra de `head_crop` em training/distance_benchmark.py, onde a estratégia foi medida.
 */
export function headCrop(subject: Box, frameW: number, frameH: number, ratio: number, minSide: number): Box {
  const cx = (subject.x1 + subject.x2) / 2;
  const cy = (subject.y1 + subject.y2) / 2;
  let side = Math.max(subject.x2 - subject.x1, subject.y2 - subject.y1) * ratio;
  side = Math.min(Math.max(side, minSide), frameW, frameH);
  const x1 = Math.round(Math.min(Math.max(cx - side / 2, 0), frameW - side));
  const y1 = Math.round(Math.min(Math.max(cy - side / 2 - 0.1 * side, 0), frameH - side));
  const s = Math.round(side);
  return { x1, y1, x2: x1 + s, y2: y1 + s };
}

export interface DisplayTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  mirrored: boolean;
  viewWidth: number;
}

/**
 * Mapeia coordenadas do quadro de vídeo para a área exibida, reproduzindo o comportamento
 * de CSS object-fit (contain/cover). Necessário para alinhar as caixas ao vídeo na tela.
 */
export function computeDisplayTransform(
  videoW: number,
  videoH: number,
  viewW: number,
  viewH: number,
  fit: 'contain' | 'cover',
  mirrored: boolean,
): DisplayTransform {
  const sx = viewW / videoW;
  const sy = viewH / videoH;
  const scale = fit === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
  return {
    scale,
    offsetX: (viewW - videoW * scale) / 2,
    offsetY: (viewH - videoH * scale) / 2,
    mirrored,
    viewWidth: viewW,
  };
}

export function toDisplay(b: Box, t: DisplayTransform): Box {
  let x1 = b.x1 * t.scale + t.offsetX;
  let x2 = b.x2 * t.scale + t.offsetX;
  const y1 = b.y1 * t.scale + t.offsetY;
  const y2 = b.y2 * t.scale + t.offsetY;
  if (t.mirrored) {
    [x1, x2] = [t.viewWidth - x2, t.viewWidth - x1];
  }
  return { x1, y1, x2, y2 };
}
