import type { ModelManifest } from '../core/manifest';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../core/settings';
import type { Box, Detection, FrameResult, RegionQuality } from '../core/types';

export const PPE_MANIFEST: ModelManifest = {
  name: 'teste-ppe',
  version: '0.0.1',
  purpose: 'ppe',
  file: 'teste.onnx',
  inputSize: 320,
  format: 'yolo-raw',
  classes: ['head', 'safety_glasses', 'hearing_protection', 'hairnet'],
  subjectClass: 'head',
  ppeClassMap: { safety_glasses: 'safety_glasses', hearing_protection: 'hearing_protection', hairnet: 'hairnet' },
};

export const GOOD_Q: RegionQuality = { sharpness: 200, brightness: 120 };

export function det(className: string, box: Box, score: number, manifest = PPE_MANIFEST): Detection {
  return { ...box, className, classIndex: manifest.classes.indexOf(className), score };
}

/** Cabeça centralizada de 200x200 num quadro 640x480 e EPIs opcionais sobre ela. */
export const HEAD: Box = { x1: 220, y1: 120, x2: 420, y2: 320 };
export const GLASSES: Box = { x1: 260, y1: 190, x2: 380, y2: 230 };
export const EARMUFF: Box = { x1: 190, y1: 200, x2: 240, y2: 270 };
export const HAIRNET: Box = { x1: 220, y1: 100, x2: 420, y2: 180 };

export function frame(detections: Detection[], opts: { quality?: RegionQuality; t?: number; crops?: Box[] } = {}): FrameResult {
  const q = opts.quality ?? GOOD_Q;
  const subjectQuality: Record<number, RegionQuality> = {};
  detections.forEach((d, i) => {
    if (d.className === 'head' || d.className === 'person') subjectQuality[i] = q;
  });
  return {
    frameWidth: 640,
    frameHeight: 480,
    detections,
    subjectQuality,
    frameQuality: q,
    timings: { preprocessMs: 1, inferenceMs: 10, postprocessMs: 1, totalMs: 12 },
    timestamp: opts.t ?? 0,
    crops: opts.crops,
  };
}

export function settings(patch: Partial<Settings> = {}): Settings {
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...patch });
}
