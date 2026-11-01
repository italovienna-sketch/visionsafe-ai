import type { RegionQuality } from './types';

/** Converte RGBA em luminância (BT.601). */
export function toGray(rgba: Uint8ClampedArray, pixels: number): Float32Array {
  const g = new Float32Array(pixels);
  for (let i = 0, p = 0; p < pixels; i += 4, p++) {
    g[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return g;
}

/**
 * Variância do Laplaciano (kernel 4-vizinhos). Valores baixos indicam imagem borrada.
 * A escala depende do tamanho do recorte, por isso o worker sempre amostra em QUALITY_SIZE.
 */
export function laplacianVariance(gray: Float32Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function meanOf(gray: Float32Array): number {
  let s = 0;
  for (let i = 0; i < gray.length; i++) s += gray[i];
  return gray.length ? s / gray.length : 0;
}

export function measureQuality(rgba: Uint8ClampedArray, w: number, h: number): RegionQuality {
  const g = toGray(rgba, w * h);
  return { sharpness: laplacianVariance(g, w, h), brightness: meanOf(g) };
}

/** Lado do recorte quadrado usado para medir qualidade. */
export const QUALITY_SIZE = 96;
