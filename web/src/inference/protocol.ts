import type { ModelManifest } from '../core/manifest';
import type { FrameResult } from '../core/types';

/**
 * 2ª passada do detector em recortes da cabeça, em resolução nativa do quadro.
 * Recupera EPIs pequenos demais depois que o quadro inteiro é reduzido para a entrada do modelo
 * (ex.: 1280×720 → 416 px). Medido em training/distance_benchmark.py.
 */
export interface RefineOptions {
  /** Classe de sujeito (rosto/cabeça) que define onde recortar. */
  subjectClass: string;
  /** Confiança mínima do sujeito na 1ª passada para gerar um recorte. */
  minSubjectScore: number;
  /** Máximo de recortes por quadro (cada recorte custa uma inferência). */
  maxCrops: number;
  /** Lado do recorte = ratio × maior lado do sujeito. */
  ratio: number;
  /** Lado mínimo do recorte (px do quadro). */
  minSide: number;
  /**
   * Por classe do modelo principal: se a 1ª passada já viu essa classe com pelo menos esta confiança, de forma
   * inequívoca nesta pessoa, a passada do modelo principal no recorte é dispensada (a decisão já é "positiva";
   * a passada extra não mudaria nada). Só se aplica às classes de cropModel.keepMainClasses.
   */
  skipMainAbove?: Record<string, number>;
}

export interface LoadRequest {
  type: 'load';
  manifest: ModelManifest;
  modelUrl?: string;
  modelBuffer?: ArrayBuffer;
  /** URL do ONNX de manifest.cropModel (modelo de EPI da 2ª passada). */
  cropModelUrl?: string;
  backend: 'wasm' | 'webgpu';
}

export interface InferRequest {
  type: 'infer';
  id: number;
  bitmap: ImageBitmap;
  scoreThreshold: number;
  iouThreshold: number;
  /** Inclui estatísticas da saída bruta no resultado (diagnóstico). */
  debug?: boolean;
  refine?: RefineOptions;
}

export type WorkerRequest = LoadRequest | InferRequest;

export interface LoadInfo {
  backend: string;
  threads: number;
  loadMs: number;
  outputDims: number[];
  format: string;
  /** Modelo de recorte carregado (quando o manifesto tem cropModel). */
  crop?: { name: string; version: string; outputDims: number[]; format: string };
}

export type WorkerResponse =
  | { type: 'loaded'; info: LoadInfo }
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'result'; id: number; result: FrameResult }
  | { type: 'error'; id?: number; stage: 'load' | 'infer'; code: 'model_missing' | 'load_failed' | 'infer_failed'; message: string };
