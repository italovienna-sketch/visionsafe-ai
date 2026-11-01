/**
 * Aviso sonoro local via Web Audio. O AudioContext só é criado após um gesto do usuário
 * (exigência dos navegadores para reprodução de áudio).
 */
export class Beeper {
  private ctx: AudioContext | null = null;

  /** Deve ser chamado dentro de um manipulador de clique/toque. */
  async unlock(): Promise<boolean> {
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx.state === 'running';
    } catch {
      return false;
    }
  }

  get ready(): boolean {
    return this.ctx?.state === 'running';
  }

  beep(volume: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || volume <= 0) return;
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0, t);
    [880, 660, 880].forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f;
      osc.connect(gain);
      const start = t + i * 0.18;
      gain.gain.setValueAtTime(volume * 0.3, start);
      gain.gain.setValueAtTime(0, start + 0.14);
      osc.start(start);
      osc.stop(start + 0.15);
    });
  }
}
