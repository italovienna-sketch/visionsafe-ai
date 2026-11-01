import { containment, expand, iou } from './geometry';
import type { ModelManifest } from './manifest';
import type { Settings } from './settings';
import {
  PPE_CLASSES,
  type Box,
  type Detection,
  type FrameResult,
  type ObservationOutcome,
  type PpeClass,
  type RegionQuality,
  type UncertainReason,
} from './types';

/** Uma pessoa visível em um quadro, com os EPIs associados a ela. */
export interface SubjectObservation {
  box: Box;
  score: number;
  /** null = observável; caso contrário, motivo da incerteza. */
  unobservable: UncertainReason | null;
  quality: RegionQuality;
  /** Maior confiança por classe-alvo entre as detecções associadas a esta pessoa. */
  ppeScores: Record<PpeClass, number>;
  ppeDetections: Detection[];
  /**
   * Classes com uma detecção que caiu entre esta pessoa e outra (atribuição incerta). Sem confirmação
   * própria, a observação dessas classes vira "ambígua" — nunca negativa.
   */
  ambiguousClasses: PpeClass[];
  /** true quando o modelo não separa pessoas e o quadro inteiro foi tratado como um sujeito. */
  wholeFrame: boolean;
}

export interface FrameAnalysis {
  subjects: SubjectObservation[];
  /** EPIs detectados que não puderam ser associados a nenhuma pessoa. */
  unassigned: Detection[];
  /** EPIs que cabem em mais de uma pessoa sem margem para decidir de quem são. */
  ambiguous: Detection[];
}

/** Margem de expansão da caixa do sujeito para incluir protetores tipo concha e touca. */
export function associationRegion(box: Box, subjectClass: string | undefined): Box {
  // Cabeça: protetor concha fica nas laterais e a touca pode exceder o topo.
  if (subjectClass === 'head') return expand(box, 0.35, 0.3);
  // Rosto: a caixa é mais estreita que a cabeça — conchas ficam quase inteiras fora dela, nas laterais.
  if (subjectClass === 'face') return expand(box, 0.6, 0.45);
  return expand(box, 0.05, 0.05);
}

const MIN_CONTAINMENT = 0.5;
/**
 * Se a 2ª pessoa mais provável tiver contenção até esta distância da 1ª, a peça não é atribuída a
 * ninguém (pessoas lado a lado: escolher a mais próxima seria um palpite).
 */
const OWNER_MARGIN = 0.25;
/** Mesma peça vista por dois detectores (ex.: óculos genérico + óculos do modelo de recorte). */
const DUPLICATE_IOU = 0.4;
const DUPLICATE_CONTAINMENT = 0.7;

function sameItem(a: Detection, b: Detection): boolean {
  return iou(a, b) >= DUPLICATE_IOU || containment(a, b) >= DUPLICATE_CONTAINMENT || containment(b, a) >= DUPLICATE_CONTAINMENT;
}

export function analyzeFrame(frame: FrameResult, manifest: ModelManifest, settings: Settings): FrameAnalysis {
  const subjectClass = manifest.subjectClass;
  const ppeDets: Detection[] = [];
  const subjectDets: { det: Detection; index: number }[] = [];
  frame.detections.forEach((d, index) => {
    if (subjectClass && d.className === subjectClass) {
      if (d.score >= settings.subjectThreshold) subjectDets.push({ det: d, index });
    } else if (manifest.ppeClassMap[d.className]) {
      ppeDets.push(d);
    }
  });

  const emptyScores = () =>
    Object.fromEntries(PPE_CLASSES.map((c) => [c, 0])) as Record<PpeClass, number>;

  const subjects: SubjectObservation[] = [];
  if (subjectClass) {
    for (const { det, index } of subjectDets) {
      const quality = frame.subjectQuality[index] ?? frame.frameQuality;
      subjects.push({
        box: det,
        score: det.score,
        quality,
        unobservable: observability(det, quality, frame, settings, !!manifest.cropModel),
        ppeScores: emptyScores(),
        ppeDetections: [],
        ambiguousClasses: [],
        wholeFrame: false,
      });
    }
  } else {
    // Sem classe de sujeito: não é possível separar pessoas. Trata o quadro como um único sujeito.
    const box = { x1: 0, y1: 0, x2: frame.frameWidth, y2: frame.frameHeight };
    subjects.push({
      box,
      score: 1,
      quality: frame.frameQuality,
      unobservable: qualityReason(frame.frameQuality, settings),
      ppeScores: emptyScores(),
      ppeDetections: [],
      ambiguousClasses: [],
      wholeFrame: true,
    });
  }

  const unassigned: Detection[] = [];
  const ambiguous: Detection[] = [];
  // Da maior para a menor confiança: a primeira caixa de cada peça é a que fica.
  for (const d of [...ppeDets].sort((a, b) => b.score - a.score)) {
    const target = manifest.ppeClassMap[d.className]!;
    const ranked = subjects
      .map((s, i) => ({ i, c: s.wholeFrame ? 1 : containment(d, associationRegion(s.box, subjectClass)) }))
      .filter((x) => x.c >= MIN_CONTAINMENT)
      .sort((a, b) => b.c - a.c);
    if (!ranked.length) {
      unassigned.push(d);
      continue;
    }
    if (ranked.length > 1 && ranked[0].c - ranked[1].c < OWNER_MARGIN) {
      ambiguous.push(d);
      for (const r of ranked.slice(0, 2)) {
        const amb = subjects[r.i].ambiguousClasses;
        if (!amb.includes(target)) amb.push(target);
      }
      continue;
    }
    const s = subjects[ranked[0].i];
    // Uma caixa por peça: duplicatas da mesma classe-alvo (outro detector/escala) não são desenhadas de novo.
    if (s.ppeDetections.some((o) => manifest.ppeClassMap[o.className] === target && sameItem(o, d))) continue;
    s.ppeDetections.push(d);
    s.ppeScores[target] = Math.max(s.ppeScores[target], d.score);
  }
  return { subjects, unassigned, ambiguous };
}

/**
 * A 1ª passada (quadro inteiro) já confirmou a classe `cls` nesta pessoa com confiança de "positivo", e a peça
 * não cabe também na região de outra pessoa. Nesse caso a passada do modelo principal no recorte não muda a
 * decisão e pode ser dispensada (ver RefineOptions.skipMainAbove).
 */
export function confirmedInFirstPass(
  subject: Box,
  cls: string,
  first: Detection[],
  allSubjects: Box[],
  opts: { subjectClass: string; skipMainAbove?: Record<string, number> },
): boolean {
  const min = opts.skipMainAbove?.[cls];
  if (min === undefined) return false;
  const inside = (d: Box, who: Box) => containment(d, associationRegion(who, opts.subjectClass)) >= MIN_CONTAINMENT;
  return first.some(
    (d) => d.className === cls && d.score >= min && inside(d, subject) && !allSubjects.some((o) => o !== subject && inside(d, o)),
  );
}

function qualityReason(q: RegionQuality, s: Settings): UncertainReason | null {
  if (q.brightness < s.minBrightness) return 'too_dark';
  if (q.brightness > s.maxBrightness) return 'too_bright';
  if (q.sharpness < s.minSharpness) return 'blurry';
  return null;
}

/**
 * Fração da altura do quadro exigida quando o sujeito NÃO passou pela 2ª passada (recorte da cabeça).
 * Medido em training/distance_benchmark.py: sem o recorte, relaxar o portão só troca "distante" por
 * "não detectado" falso (a 3 m, 29 de 62 quadros com óculos viraram negativos).
 */
const UNREFINED_MIN_FRACTION = 0.12;

function minSubjectPx(b: Box, f: FrameResult, s: Settings): number {
  return isRefined(b, f) ? s.minSubjectPx : Math.max(s.minSubjectPx, UNREFINED_MIN_FRACTION * f.frameHeight);
}

function isRefined(b: Box, f: FrameResult): boolean {
  return f.crops?.some((c) => containment(b, c) >= 0.9) ?? false;
}

function observability(b: Box, q: RegionQuality, f: FrameResult, s: Settings, cropOnly: boolean): UncertainReason | null {
  // Com modelo de recorte, EPIs só existem dentro dos recortes: pessoa sem recorte não foi analisada
  // (não pode virar "não detectado").
  if (cropOnly && !isRefined(b, f)) return 'not_refined';
  if (b.y2 - b.y1 < minSubjectPx(b, f, s)) return 'subject_small';
  const mx = f.frameWidth * 0.01;
  const my = f.frameHeight * 0.01;
  // Topo/laterais cortados escondem touca e protetores; a borda inferior é aceitável para cabeça/tronco.
  if (b.x1 <= mx || b.x2 >= f.frameWidth - mx || b.y1 <= my) return 'subject_truncated';
  return qualityReason(q, s);
}

/** Classifica a observação de uma classe-alvo para um sujeito em um quadro. */
export function classifyObservation(
  subject: SubjectObservation,
  cls: PpeClass,
  settings: Settings,
): ObservationOutcome {
  if (subject.unobservable) return 'unobservable';
  const score = subject.ppeScores[cls];
  const cs = settings.classes[cls];
  if (score >= cs.threshold) return 'positive';
  if (score >= cs.ambiguousFloor || subject.ambiguousClasses.includes(cls)) return 'ambiguous';
  return 'negative';
}

// ---------------------------------------------------------------------------
// Rastreamento simples por IoU para manter cada pessoa com sua própria janela de verificação.

export interface Track {
  id: number;
  box: Box;
  firstSeen: number;
  lastSeen: number;
}

export class SubjectTracker {
  private tracks: Track[] = [];
  private nextId = 1;

  constructor(
    private readonly ttlMs = 1500,
    private readonly minIou = 0.3,
  ) {}

  /**
   * Associa sujeitos do quadro a trilhas existentes. Retorna o id da trilha de cada sujeito.
   * `ttlMs` permite estender a validade quando os quadros chegam devagar (aparelho lento):
   * uma trilha não pode expirar só porque a próxima inferência demorou.
   */
  update(boxes: Box[], now: number, ttlMs = this.ttlMs): { ids: number[]; expired: number[] } {
    const ttl = Math.max(this.ttlMs, ttlMs);
    const expired = this.tracks.filter((t) => now - t.lastSeen > ttl).map((t) => t.id);
    this.tracks = this.tracks.filter((t) => now - t.lastSeen <= ttl);

    const pairs: { t: number; b: number; v: number }[] = [];
    this.tracks.forEach((t, ti) =>
      boxes.forEach((b, bi) => {
        const v = iou(t.box, b);
        if (v >= this.minIou) pairs.push({ t: ti, b: bi, v });
      }),
    );
    pairs.sort((a, b) => b.v - a.v);
    const ids = new Array<number>(boxes.length).fill(0);
    const usedT = new Set<number>();
    for (const p of pairs) {
      if (usedT.has(p.t) || ids[p.b]) continue;
      usedT.add(p.t);
      ids[p.b] = this.tracks[p.t].id;
      this.tracks[p.t].box = boxes[p.b];
      this.tracks[p.t].lastSeen = now;
    }
    boxes.forEach((b, i) => {
      if (ids[i]) return;
      const t: Track = { id: this.nextId++, box: b, firstSeen: now, lastSeen: now };
      this.tracks.push(t);
      ids[i] = t.id;
    });
    return { ids, expired };
  }

  active(): readonly Track[] {
    return this.tracks;
  }

  reset(): void {
    this.tracks = [];
  }
}
