import type { PpeClass, PpeStatus } from './types';

export interface AlertEvent {
  id: number;
  trackId: number;
  cls: PpeClass;
  /** Relógio monotônico (performance.now) usado nas regras de supressão. */
  at: number;
  /** Data/hora real para exibição (preenchida pelo controlador). */
  wallTime?: number;
  /** false quando o alerta foi registrado mas o som foi suprimido pelo intervalo global. */
  audible: boolean;
}

/**
 * Gera alertas locais quando uma classe está em NOT_DETECTED.
 * Supressão: cooldown por (pessoa, classe) — vale tanto para estado oscilando quanto persistente —
 * e intervalo mínimo global entre alertas sonoros. Nada é enviado para fora do aparelho.
 */
export class AlertManager {
  private lastAlertAt = new Map<string, number>();
  private lastAudibleAt = -Infinity;
  private nextId = 1;

  constructor(
    private cooldownMs: number,
    private globalGapMs: number,
  ) {}

  configure(cooldownMs: number, globalGapMs: number): void {
    this.cooldownMs = cooldownMs;
    this.globalGapMs = globalGapMs;
  }

  update(trackId: number, cls: PpeClass, status: PpeStatus, now: number): AlertEvent | null {
    if (status !== 'NOT_DETECTED') return null;
    const key = `${trackId}:${cls}`;
    const lastAlert = this.lastAlertAt.get(key);
    if (lastAlert !== undefined && now - lastAlert < this.cooldownMs) return null;

    this.lastAlertAt.set(key, now);
    const audible = now - this.lastAudibleAt >= this.globalGapMs;
    if (audible) this.lastAudibleAt = now;
    return { id: this.nextId++, trackId, cls, at: now, audible };
  }

  dropTrack(trackId: number): void {
    for (const k of [...this.lastAlertAt.keys()]) {
      if (k.startsWith(`${trackId}:`)) this.lastAlertAt.delete(k);
    }
  }

  reset(): void {
    this.lastAlertAt.clear();
    this.lastAudibleAt = -Infinity;
  }
}
