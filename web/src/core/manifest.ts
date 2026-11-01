import type { ResizeMode } from './geometry';
import type { Settings } from './settings';
import { PPE_CLASSES, type PpeClass } from './types';
import type { YoloOutputFormat } from './yolo';

/**
 * Manifesto que acompanha cada arquivo .onnx. Descreve classes, formato e procedência.
 * Gerado por training/export_onnx.py (ou export_diagnostic_model.py).
 */
export interface ModelManifest {
  name: string;
  version: string;
  /** "ppe" = modelo treinado para os EPIs-alvo; "diagnostic" = apenas valida o pipeline. */
  purpose: 'ppe' | 'diagnostic';
  file: string;
  inputSize: number;
  format?: YoloOutputFormat;
  /** Pré-processamento igual ao do treino. Padrão "letterbox". */
  resize?: ResizeMode;
  /** Nomes das classes na ordem dos índices de saída do modelo. */
  classes: string[];
  /** Classe usada para separar pessoas (ex.: "head" ou "person"). Ausente = quadro inteiro. */
  subjectClass?: string;
  /** Mapa classe-do-modelo -> classe-alvo. Classes-alvo ausentes ficam "não suportadas". */
  ppeClassMap: Partial<Record<string, PpeClass>>;
  /** Classes-alvo que o modelo cobre apenas de forma aproximada (ex.: óculos genéricos). */
  proxyClasses?: Partial<Record<PpeClass, string>>;
  license?: string;
  /**
   * Limiar de "positivo" recomendado por classe-alvo, escolhido na validação do treino (nunca no teste). Usado no
   * lugar do ajuste padrão enquanto Settings.useModelThresholds estiver ligado. Com cropModel, valem os do recorte.
   */
  thresholds?: Partial<Record<PpeClass, number>>;
  training?: { dataset?: string; datasetLicense?: string; date?: string; notes?: string; baseModel?: string };
  metrics?: Record<string, unknown>;
  /**
   * Modelo de EPI que roda só no recorte da cabeça (2ª passada). Quando presente, o modelo principal
   * fornece apenas o sujeito (subjectClass) e os EPIs vêm exclusivamente deste modelo; `ppeClassMap` e
   * `proxyClasses` do manifesto validado passam a ser os dele (os originais ficam em `mainPpeClassMap`).
   */
  cropModel?: CropModelSpec;
  /** Mapa original do modelo principal quando `cropModel` o substitui (só para exibição/diagnóstico). */
  mainPpeClassMap?: Partial<Record<string, PpeClass>>;
  /**
   * Modelo de recorte anterior, mantido no manifesto como reserva: se o `cropModel` atual não carregar (arquivo
   * ausente/corrompido, formato inesperado), o app tenta este. No JSON é `cropModelFallback`; depois de validado,
   * `fallback` é o manifesto completo equivalente com o modelo anterior no lugar.
   */
  cropModelFallback?: CropModelSpec;
  fallback?: ModelManifest;
}

export type CropModelSpec = Pick<
  ModelManifest,
  'name' | 'version' | 'file' | 'inputSize' | 'format' | 'resize' | 'classes' | 'ppeClassMap' | 'proxyClasses' | 'license' | 'training' | 'metrics' | 'thresholds'
> & {
  /**
   * Classes de EPI do modelo PRINCIPAL que continuam valendo (no quadro inteiro e também no recorte), somadas às do
   * modelo de recorte. Ex.: ["glasses"] quando o modelo de recorte só conhece óculos escuros de obra e o principal
   * pega óculos em geral. A classe-alvo correspondente herda a nota de aproximação do modelo principal.
   */
  keepMainClasses?: string[];
};

export class ManifestError extends Error {}

export function validateManifest(raw: unknown): ModelManifest {
  const m = validateModelFields(raw, '');
  if (m.cropModel === undefined) return m;
  const { cropModelFallback, ...rest } = m;
  const primary = validateCrop(rest);
  if (cropModelFallback === undefined) return primary;
  let fallback: ModelManifest;
  try {
    fallback = validateCrop({ ...rest, cropModel: cropModelFallback });
  } catch (e) {
    throw new ManifestError(`cropModelFallback: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ...primary, fallback };
}

function validateCrop(m: ModelManifest): ModelManifest {
  if (m.purpose !== 'ppe') throw new ManifestError('cropModel só é aceito em modelos "ppe".');
  if (!m.subjectClass) throw new ManifestError('cropModel exige subjectClass no modelo principal (é o que orienta o recorte).');
  const crop = validateModelFields({ purpose: 'ppe', ...(m.cropModel as object) }, 'cropModel.') as ModelManifest;
  if (crop.subjectClass) throw new ManifestError('cropModel.subjectClass não é suportado: o sujeito vem do modelo principal.');
  if (crop.classes.includes(m.subjectClass)) {
    throw new ManifestError(`cropModel.classes não pode conter a classe de sujeito "${m.subjectClass}".`);
  }
  const keep = (m.cropModel as { keepMainClasses?: unknown }).keepMainClasses ?? [];
  if (!Array.isArray(keep) || !keep.every((k) => typeof k === 'string')) {
    throw new ManifestError('cropModel.keepMainClasses deve ser uma lista de nomes.');
  }
  const ppeClassMap: Partial<Record<string, PpeClass>> = { ...crop.ppeClassMap };
  const proxyClasses: Partial<Record<PpeClass, string>> = { ...crop.proxyClasses };
  for (const k of keep as string[]) {
    const target = m.ppeClassMap[k];
    if (!target) throw new ManifestError(`cropModel.keepMainClasses: "${k}" não é classe de EPI do modelo principal.`);
    if (crop.classes.includes(k)) throw new ManifestError(`cropModel.keepMainClasses: "${k}" também existe no modelo de recorte.`);
    ppeClassMap[k] = target;
    const note = m.proxyClasses?.[target];
    if (note) proxyClasses[target] = proxyClasses[target] ? `${proxyClasses[target]} ${note}` : note;
  }
  const { purpose: _p, subjectClass: _s, ...spec } = crop;
  return {
    ...m,
    cropModel: { ...spec, keepMainClasses: keep as string[] },
    mainPpeClassMap: m.ppeClassMap,
    ppeClassMap,
    proxyClasses: Object.keys(proxyClasses).length ? proxyClasses : undefined,
    thresholds: crop.thresholds,
  };
}

function validateModelFields(raw: unknown, prefix: string): ModelManifest {
  if (!raw || typeof raw !== 'object') throw new ManifestError(`Manifesto ${prefix ? `(${prefix.slice(0, -1)}) ` : ''}ausente ou inválido.`);
  const m = raw as Record<string, unknown>;
  const req = (k: string, t: string) => {
    if (typeof m[k] !== t) throw new ManifestError(`Campo "${prefix}${k}" ausente ou inválido no manifesto.`);
  };
  req('name', 'string');
  req('version', 'string');
  req('file', 'string');
  req('inputSize', 'number');
  if (m.purpose !== 'ppe' && m.purpose !== 'diagnostic') {
    throw new ManifestError(`Campo "${prefix}purpose" deve ser "ppe" ou "diagnostic".`);
  }
  if (!Array.isArray(m.classes) || m.classes.length === 0 || !m.classes.every((c) => typeof c === 'string')) {
    throw new ManifestError(`Campo "${prefix}classes" deve ser uma lista de nomes.`);
  }
  const classes = m.classes as string[];
  const inputSize = m.inputSize as number;
  if (!Number.isInteger(inputSize) || inputSize < 64 || inputSize > 1280 || inputSize % 32 !== 0) {
    throw new ManifestError(`${prefix}inputSize deve ser múltiplo de 32 entre 64 e 1280.`);
  }
  if (m.format !== undefined && m.format !== 'yolo-raw' && m.format !== 'yolo-end2end') {
    throw new ManifestError('Campo "format" deve ser "yolo-raw" ou "yolo-end2end".');
  }
  if (m.resize !== undefined && m.resize !== 'letterbox' && m.resize !== 'stretch') {
    throw new ManifestError('Campo "resize" deve ser "letterbox" ou "stretch".');
  }
  if (m.subjectClass !== undefined && !classes.includes(m.subjectClass as string)) {
    throw new ManifestError(`subjectClass "${String(m.subjectClass)}" não está em "classes".`);
  }
  const map = (m.ppeClassMap ?? {}) as Record<string, string>;
  if (typeof map !== 'object') throw new ManifestError('ppeClassMap inválido.');
  for (const [modelClass, target] of Object.entries(map)) {
    if (!classes.includes(modelClass)) throw new ManifestError(`${prefix}ppeClassMap: classe "${modelClass}" não existe no modelo.`);
    if (!(PPE_CLASSES as readonly string[]).includes(target)) {
      throw new ManifestError(`${prefix}ppeClassMap: alvo "${target}" não é uma classe de EPI conhecida.`);
    }
  }
  if (m.thresholds !== undefined) {
    const t = m.thresholds as Record<string, unknown>;
    if (typeof t !== 'object' || t === null) throw new ManifestError(`${prefix}thresholds inválido.`);
    for (const [cls, v] of Object.entries(t)) {
      if (!(PPE_CLASSES as readonly string[]).includes(cls)) throw new ManifestError(`${prefix}thresholds: "${cls}" não é classe de EPI.`);
      if (typeof v !== 'number' || !(v >= 0.05 && v <= 0.99)) throw new ManifestError(`${prefix}thresholds.${cls} deve estar entre 0,05 e 0,99.`);
    }
  }
  if (m.purpose === 'ppe' && Object.keys(map).length === 0) {
    throw new ManifestError('Modelo "ppe" precisa mapear ao menos uma classe de EPI.');
  }
  return m as unknown as ModelManifest;
}

/** Classes-alvo efetivamente suportadas pelo modelo. */
export function supportedTargets(m: ModelManifest): Set<PpeClass> {
  return new Set(Object.values(m.ppeClassMap).filter((v): v is PpeClass => !!v));
}

/** Classes-alvo que o modelo cobre e que o usuário não desativou (classes aproximadas podem ser desligadas). */
export function activeTargets(m: ModelManifest, s: Pick<Settings, 'allowProxy'>): Set<PpeClass> {
  const out = new Set<PpeClass>();
  for (const c of supportedTargets(m)) {
    if (m.proxyClasses?.[c] && !s.allowProxy[c]) continue;
    out.add(c);
  }
  return out;
}
