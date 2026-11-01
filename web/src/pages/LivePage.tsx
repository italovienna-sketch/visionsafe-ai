import { useEffect, useState } from 'react';
import { Metric, ModelNotice, ModelPanel, Notice, fmt } from '../components/Common';
import { IconAlert, IconCamera, IconMute, IconPause, IconPlay, IconStop, IconSwitch, IconVolume } from '../components/Icons';
import { StatusCard } from '../components/StatusCard';
import { isStale, VideoStage } from '../components/VideoStage';
import { PPE_INFO } from '../core/ppe';
import { PPE_CLASSES, type UncertainReason } from '../core/types';
import { useController, useMonitor } from '../controller/context';
import type { MonitorSnapshot } from '../controller/MonitorController';

const GUIDE: Partial<Record<UncertainReason, string>> = {
  subject_small: 'Aproxime-se: a pessoa está pequena demais na imagem.',
  subject_truncated: 'Centralize a pessoa — parte da cabeça está fora do quadro.',
  blurry: 'Segure o celular firme: a imagem está borrada.',
  too_dark: 'Iluminação insuficiente: procure um local mais claro.',
  too_bright: 'Imagem estourada: evite contraluz.',
};

/** Orientação de enquadramento baseada no que o modelo realmente viu no último quadro. */
function framingHint(snap: MonitorSnapshot): { text: string; showGuide: boolean } | null {
  if (snap.camera.state !== 'running' || snap.paused || snap.model.state !== 'ready' || !snap.frame) return null;
  const subjects = snap.frame.analysis.subjects;
  const who = snap.model.manifest?.subjectClass === 'face' ? 'o rosto' : snap.model.manifest?.subjectClass === 'head' ? 'a cabeça' : 'a pessoa';
  if (subjects.length === 0) return { text: `Enquadre ${who} de frente, a cerca de 1 a 2 metros.`, showGuide: true };
  const idx = snap.frame.trackIds.indexOf(snap.primaryTrackId ?? -1);
  const reason = subjects[idx]?.unobservable;
  return reason && GUIDE[reason] ? { text: GUIDE[reason]!, showGuide: reason === 'subject_small' || reason === 'subject_truncated' } : null;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function LivePage() {
  const c = useController();
  const snap = useMonitor();
  const { camera, model, settings } = snap;
  const running = camera.state === 'running';
  const requesting = camera.state === 'requesting';
  const missing = PPE_CLASSES.filter((cls) => snap.decisions[cls].status === 'NOT_DETECTED');
  const subjects = snap.frame?.analysis.subjects.length ?? 0;
  const wholeFrame = snap.frame?.analysis.subjects[0]?.wholeFrame;
  const timings = snap.frame?.result.timings;
  const raw = snap.frame?.result.raw;
  const hint = framingHint(snap);
  const live = running && !snap.paused;
  const stale = live && isStale(snap);
  // Idade do último resultado: relógio local, porque o painel só recebe instantâneos quando há resultado novo.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [live]);

  const chip = !running
    ? null
    : snap.paused
      ? { cls: 'paused', text: 'Pausado' }
      : model.state === 'ready'
        ? stale
          ? { cls: 'stale', text: 'Análise atrasada · resultado antigo' }
          : { cls: 'live', text: 'Ao vivo · analisando' }
        : model.state === 'loading'
          ? { cls: 'idle', text: 'Câmera ativa · carregando modelo' }
          : { cls: 'idle', text: 'Câmera ativa · sem análise' };

  return (
    <div className="page live">
      <div className="live-grid">
        <div className="live-main">
          {missing.length > 0 && (
            <div className="alert-banner" role="alert" data-testid="alert-banner">
              <IconAlert size={20} />
              <span>
                Não confirmado na imagem: {missing.map((m) => PPE_INFO[m].label).join(', ')} — confira pessoalmente
              </span>
            </div>
          )}

          <div className="stage-wrap">
            <VideoStage />
            {chip && (
              <span className={`stage-chip ${chip.cls}`} data-testid="stage-chip">
                <span className="dot" aria-hidden="true" />
                {chip.text}
              </span>
            )}
            {hint?.showGuide && (
              <div className="frame-guide" aria-hidden="true">
                <span />
              </div>
            )}
            {hint && (
              <p className="stage-hint" role="status" data-testid="framing-hint">
                {hint.text}
              </p>
            )}
            {running && snap.paused && (
              <div className="stage-paused">
                <button className="btn btn-primary btn-lg" onClick={() => c.resume()}>
                  <IconPlay /> Retomar análise
                </button>
              </div>
            )}
            {!running && (
              <div className="stage-placeholder">
                {requesting ? (
                  <div className="placeholder-body">
                    <span className="spinner" aria-hidden="true" />
                    <p>Aguardando permissão da câmera…</p>
                    <p className="small muted">Toque em “Permitir” no aviso do navegador.</p>
                  </div>
                ) : camera.state === 'error' && camera.error ? (
                  <div className="placeholder-body" role="alert">
                    <IconAlert size={32} />
                    <strong>{camera.error.title}</strong>
                    <p className="small muted">{camera.error.hint}</p>
                    <button className="btn btn-primary" onClick={() => c.startCamera()}>
                      Tentar novamente
                    </button>
                  </div>
                ) : (
                  <div className="placeholder-body">
                    <IconCamera size={36} />
                    <p>{camera.pausedByVisibility ? 'A câmera foi desligada ao sair da página.' : 'Câmera desligada.'}</p>
                    <p className="small muted">A permissão só é solicitada quando você tocar no botão.</p>
                    <button className="btn btn-primary btn-lg" onClick={() => c.startCamera()}>
                      <IconPlay /> {camera.pausedByVisibility ? 'Religar câmera' : 'Iniciar câmera'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {live && snap.frame && model.state === 'ready' && (
            <p className="stage-legend small muted" data-testid="stage-legend">
              <span className="legend-swatch person" aria-hidden="true" /> Contorno da pessoa: estado verificado (igual ao painel) ·{' '}
              <span className="legend-swatch ppe" aria-hidden="true" /> caixa ciano: detecção do quadro atual, com confiança (tracejada =
              abaixo do limiar)
            </p>
          )}

          <div className="controls" role="group" aria-label="Controles da câmera">
            {running ? (
              <>
                {snap.paused ? (
                  <button className="btn btn-primary" onClick={() => c.resume()}>
                    <IconPlay /> Retomar
                  </button>
                ) : (
                  <button className="btn" onClick={() => c.pause()} disabled={model.state !== 'ready'} title="Pausa a análise sem desligar a câmera">
                    <IconPause /> Pausar
                  </button>
                )}
                <button className="btn btn-danger-outline" onClick={() => c.stopCamera()}>
                  <IconStop /> Parar
                </button>
              </>
            ) : (
              <button className="btn btn-primary" disabled={requesting} onClick={() => c.startCamera()}>
                <IconPlay /> {camera.state === 'error' ? 'Tentar novamente' : 'Iniciar'}
              </button>
            )}
            <button className="btn" disabled={!running} onClick={() => c.switchCamera()} aria-label="Trocar câmera">
              <IconSwitch /> <span className="btn-text">Trocar</span>
            </button>
            <button
              className={`btn${settings.soundEnabled ? ' btn-on' : ''}`}
              aria-pressed={settings.soundEnabled}
              aria-label={settings.soundEnabled ? 'Som ligado' : 'Som desligado'}
              onClick={() => (settings.soundEnabled ? c.disableSound() : c.enableSound())}
            >
              {settings.soundEnabled ? <IconVolume /> : <IconMute />} <span className="btn-text">Som</span>
            </button>
          </div>
        </div>

        <aside className="live-side">
          <section className="panel" aria-labelledby="ppe-title">
            <div className="panel-head">
              <h2 id="ppe-title">EPIs da pessoa principal</h2>
              {live && snap.frame && subjects > 1 && <span className="tag">{subjects} pessoas</span>}
            </div>
            <div className="status-grid">
              {PPE_CLASSES.map((cls) => (
                <StatusCard
                  key={cls}
                  cls={cls}
                  decision={snap.decisions[cls]}
                  showCountdown={settings.showCountdown}
                  proxyNote={model.manifest?.proxyClasses?.[cls]}
                />
              ))}
            </div>
            <p className="help">
              “Não confirmado” significa que o EPI não apareceu na imagem durante a verificação — não prova que a pessoa
              está sem ele. “Não avaliável” nunca é infração. Estados verificados numa janela de{' '}
              {Math.round(settings.windowMs / 1000)} s; confianças vêm só do modelo.
            </p>
          </section>

          <ModelNotice />
          {snap.inferenceError && (
            <Notice tone="error" title="Falha na inferência">
              {snap.inferenceError} — nova tentativa automática em 1 s.
            </Notice>
          )}
          {live && wholeFrame && (
            <Notice tone="warn" title="Modelo sem separação de pessoas">
              Este modelo não localiza pessoas; o quadro inteiro é avaliado como um único sujeito. Use com apenas uma pessoa
              em cena.
            </Notice>
          )}

          <div className="metrics-row" aria-label="Desempenho">
            <Metric label="Latência" value={live && snap.frame ? fmt(snap.latencyMs) : '—'} unit="ms" />
            <Metric label="Análises/s" value={live && snap.frame ? fmt(snap.fps, 1) : '—'} />
            <Metric label="Último resultado" value={live && snap.frame ? `há ${fmt(Math.max(0, now - snap.frame.result.timestamp) / 1000, 1)}` : '—'} unit={live && snap.frame ? 's' : undefined} />
            <Metric label="Pessoas" value={live && snap.frame ? subjects : '—'} />
          </div>

          <ModelPanel />

          <section className="panel" aria-labelledby="events-title">
            <div className="panel-head">
              <h2 id="events-title">Eventos desta sessão</h2>
              <span className="tag">local</span>
            </div>
            {snap.alerts.length === 0 ? (
              <p className="small muted">Nenhum evento. Um evento é registrado quando um EPI fica “Não confirmado” após a verificação.</p>
            ) : (
              <ul className="events" data-testid="events">
                {snap.alerts.slice(0, 8).map((a) => (
                  <li key={a.id}>
                    <span className="mono muted">{a.wallTime ? time(a.wallTime) : '—'}</span>
                    <span>
                      Pessoa {a.trackId} · {PPE_INFO[a.cls].short} não confirmado
                      {!a.audible && <span className="muted"> (sem som)</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="help">Eventos reais desta demonstração, guardados só na memória deste aparelho. Nada é enviado.</p>
          </section>

          {settings.showDebug && snap.frame && timings && (
            <details className="debug" open>
              <summary>Diagnóstico técnico</summary>
              <p className="mono small">
                pré {fmt(timings.preprocessMs, 1)} ms · modelo {fmt(timings.inferenceMs, 1)} ms ·
                {timings.refineMs !== undefined && ` recortes ${snap.frame.result.crops?.length ?? 0}${snap.frame.result.mainCropSkipped ? ` (${snap.frame.result.mainCropSkipped} passada dispensada)` : ''} (${fmt(timings.refineMs, 1)} ms) ·`} pós{' '}
                {fmt(timings.postprocessMs, 1)} ms ·
                quadro {snap.frame.result.frameWidth}×{snap.frame.result.frameHeight} · detecções {snap.frame.result.detections.length}
              </p>
              {raw && model.manifest && (
                <p className="mono small" data-testid="raw-stats">
                  saída [{raw.dims.join('×')}] {raw.format} · valores {fmt(raw.valueRange[0], 2)}…{fmt(raw.valueRange[1], 2)} ·
                  candidatos ≥25%: {raw.candidatesAbove025} · máx/classe:{' '}
                  {raw.maxPerClass
                    .map((v, i) => ({ v, n: model.manifest!.classes[i] }))
                    .sort((a, b) => b.v - a.v)
                    .slice(0, 6)
                    .map((x) => `${x.n} ${Math.round(x.v * 100)}%`)
                    .join(', ')}
                </p>
              )}
              {snap.frame.analysis.subjects.map((s, i) => (
                <p key={i} className="mono small">
                  Pessoa {snap.frame!.trackIds[i]}: nitidez {fmt(s.quality.sharpness)} · brilho {fmt(s.quality.brightness)} · altura{' '}
                  {fmt(((s.box.y2 - s.box.y1) / snap.frame!.result.frameHeight) * 100)}%
                </p>
              ))}
            </details>
          )}
        </aside>
      </div>
    </div>
  );
}
