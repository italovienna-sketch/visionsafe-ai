import { useEffect, useRef } from 'react';
import { computeDisplayTransform, toDisplay } from '../core/geometry';
import { PPE_INFO, REASON_LABEL } from '../core/ppe';
import { effectiveSettings } from '../core/settings';
import { PPE_CLASSES, type Box, type DecisionMap, type PpeStatus } from '../core/types';
import { useController, useMonitor } from '../controller/context';
import type { MonitorSnapshot } from '../controller/MonitorController';

const COLORS: Record<PpeStatus | 'neutral' | 'ppe', string> = {
  DETECTED: '#22c55e',
  NOT_DETECTED: '#ef4444',
  UNCERTAIN: '#f59e0b',
  CAMERA_UNAVAILABLE: '#94a3b8',
  neutral: '#94a3b8',
  ppe: '#22d3ee',
};

function worst(d: DecisionMap | undefined): PpeStatus {
  if (!d) return 'CAMERA_UNAVAILABLE';
  const order: PpeStatus[] = ['NOT_DETECTED', 'UNCERTAIN', 'DETECTED', 'CAMERA_UNAVAILABLE'];
  const present = PPE_CLASSES.map((c) => d[c].status);
  return order.find((s) => present.includes(s)) ?? 'CAMERA_UNAVAILABLE';
}

/** Rótulo pequeno e translúcido: identifica a caixa sem cobrir a imagem. */
function drawLabel(ctx: CanvasRenderingContext2D, b: Box, color: string, label: string, below: boolean, viewH: number) {
  ctx.font = '600 12px system-ui, sans-serif';
  const tw = ctx.measureText(label).width + 8;
  const h = 18;
  let y = below ? b.y2 + 2 : b.y1 - h - 2;
  if (y < 0) y = b.y1 + 2;
  if (y + h > viewH) y = b.y2 - h - 2;
  ctx.globalAlpha = 0.78;
  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(b.x1, y, tw, h);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.fillText(label, b.x1 + 4, y + 13);
}

function drawBox(ctx: CanvasRenderingContext2D, b: Box, color: string, dashed: boolean, lineWidth: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(dashed ? [8, 6] : []);
  ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
  ctx.setLineDash([]);
}

/** Resultado antigo demais para ser apresentado como observação atual. */
export function isStale(snap: MonitorSnapshot): boolean {
  return PPE_CLASSES.some((c) => snap.decisions[c].reason === 'stale');
}

function draw(canvas: HTMLCanvasElement, snap: MonitorSnapshot) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  const f = snap.frame;
  const manifest = snap.model.manifest;
  if (!f || !manifest) return;

  const t = computeDisplayTransform(f.result.frameWidth, f.result.frameHeight, cw, ch, 'contain', snap.camera.facing === 'user');
  const lw = Math.max(2, Math.min(cw, ch) / 240);
  // Resultado atrasado: só contornos cinza tracejados, sem confiança — não é uma observação atual.
  const stale = isStale(snap);

  if (snap.settings.showDebug) {
    // Regiões analisadas na 2ª passada (recorte da cabeça em resolução nativa).
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    for (const c of f.result.crops ?? []) {
      const b = toDisplay(c, t);
      ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
    }
    ctx.restore();
  }

  const multi = f.analysis.subjects.filter((s) => !s.wholeFrame).length > 1;
  f.analysis.subjects.forEach((s, i) => {
    const id = f.trackIds[i];
    if (!s.wholeFrame) {
      // Cor da pessoa = estado verificado (o mesmo do painel lateral), não a detecção do quadro.
      const color = stale || s.unobservable ? COLORS.neutral : COLORS[worst(f.perTrack[id])];
      const tag = multi && id === snap.primaryTrackId ? ' · painel' : '';
      const label = `Pessoa ${id}${tag}${s.unobservable && !stale ? ` · ${REASON_LABEL[s.unobservable]}` : ''}`;
      const b = toDisplay(s.box, t);
      drawBox(ctx, b, color, stale || !!s.unobservable, lw);
      drawLabel(ctx, b, color, label, false, ch);
    }
    for (const d of s.ppeDetections) {
      const target = manifest.ppeClassMap[d.className]!;
      const belowThreshold = d.score < effectiveSettings(snap.settings, manifest).classes[target].threshold;
      const b = toDisplay(d, t);
      drawBox(ctx, b, stale ? COLORS.neutral : COLORS.ppe, stale || belowThreshold, Math.max(1.5, lw * 0.75));
      if (!stale) drawLabel(ctx, b, COLORS.ppe, `${PPE_INFO[target].short}${belowThreshold ? '?' : ''} ${Math.round(d.score * 100)}%`, true, ch);
    }
  });
  if (stale) return;
  for (const [list, note] of [
    [f.analysis.unassigned, 'sem pessoa'],
    [f.analysis.ambiguous, 'pessoa incerta'],
  ] as const) {
    for (const d of list) {
      const target = manifest.ppeClassMap[d.className]!;
      const b = toDisplay(d, t);
      drawBox(ctx, b, COLORS.neutral, true, Math.max(1.5, lw * 0.75));
      drawLabel(ctx, b, COLORS.neutral, `${PPE_INFO[target].short} ${Math.round(d.score * 100)}% · ${note}`, true, ch);
    }
  }
}

/** Vídeo ao vivo com sobreposição de caixas alinhada (object-fit: contain). */
export function VideoStage() {
  const controller = useController();
  const snap = useMonitor();
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const snapRef = useRef(snap);
  snapRef.current = snap;

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const v = controller.video;
    v.className = 'stage-video';
    el.prepend(v);
    return () => {
      // Mantém o elemento vivo fora da tela para a câmera continuar enquanto o usuário navega.
      document.getElementById('video-parking')?.appendChild(v);
    };
  }, [controller]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ro = new ResizeObserver(() => draw(c, snapRef.current));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (canvas.current) draw(canvas.current, snap);
  }, [snap]);

  const mirrored = snap.camera.facing === 'user';
  const aspect = snap.camera.width && snap.camera.height ? `${snap.camera.width} / ${snap.camera.height}` : '4 / 3';
  return (
    <div className={`stage${mirrored ? ' mirrored' : ''}`} ref={holder} style={{ aspectRatio: aspect }}>
      <canvas ref={canvas} className="stage-overlay" aria-hidden="true" />
    </div>
  );
}
