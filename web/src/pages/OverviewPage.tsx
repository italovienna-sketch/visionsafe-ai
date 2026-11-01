import { useEffect, useState } from 'react';
import { CameraIndicator, ModelNotice } from '../components/Common';
import { StatusCard } from '../components/StatusCard';
import { PPE_CLASSES } from '../core/types';
import { supportedTargets } from '../core/manifest';
import { useMonitor } from '../controller/context';
import type { Route } from '../App';

type Perm = 'granted' | 'denied' | 'prompt' | 'unknown';

export function OverviewPage({ go }: { go: (r: Route) => void }) {
  const snap = useMonitor();
  const [perm, setPerm] = useState<Perm>('unknown');
  const secure = window.isSecureContext;
  const hasApi = !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    let cancelled = false;
    navigator.permissions
      ?.query({ name: 'camera' as PermissionName })
      .then((p) => {
        if (cancelled) return;
        setPerm(p.state as Perm);
        p.onchange = () => setPerm(p.state as Perm);
      })
      .catch(() => setPerm('unknown'));
    return () => {
      cancelled = true;
    };
  }, []);

  const m = snap.model.manifest;
  const supported = m ? supportedTargets(m) : new Set();
  const cameraText = !secure
    ? 'Requer HTTPS'
    : !hasApi
      ? 'Não suportada neste navegador'
      : snap.camera.state === 'running'
        ? 'Ativa'
        : perm === 'denied'
          ? 'Permissão negada'
          : perm === 'granted'
            ? 'Permitida (desligada)'
            : 'Disponível — permissão será solicitada';
  const modelText =
    snap.model.state === 'ready'
      ? m?.purpose === 'diagnostic'
        ? 'Diagnóstico (sem EPIs)'
        : `${m?.name} — ${supported.size} de 3 EPIs${Object.keys(m?.proxyClasses ?? {}).length ? ' (com aproximações)' : ''}`
      : snap.model.state === 'loading'
        ? 'Carregando…'
        : snap.model.state === 'error'
          ? 'Erro'
          : 'Não configurado — câmera disponível para testes';

  return (
    <div className="page">
      <header className="hero">
        <p className="eyebrow">Protótipo independente · Prova de conceito</p>
        <h1>VisionSafe AI</h1>
        <p className="lead">
          Verificação de EPIs em tempo real pela câmera do celular: óculos de segurança, protetor auricular e touca. A
          inferência roda no próprio aparelho; nenhuma imagem é enviada ou armazenada.
        </p>
        <button className="btn btn-primary btn-lg" onClick={() => go('live')}>
          Abrir monitoramento ao vivo
        </button>
      </header>

      <ModelNotice />

      <section className="card">
        <h2>Situação do protótipo</h2>
        <dl className="kv">
          <dt>Câmera</dt>
          <dd>
            {cameraText} <CameraIndicator />
          </dd>
          <dt>Modelo</dt>
          <dd>{modelText}</dd>
          <dt>Execução</dt>
          <dd>
            {snap.model.info
              ? `ONNX Runtime Web · ${snap.model.info.backend}${snap.model.info.threads > 1 ? ` (${snap.model.info.threads} threads)` : ''}`
              : '—'}
          </dd>
          <dt>Status</dt>
          <dd>Demonstração — não é um sistema de segurança certificado nem oficial.</dd>
        </dl>
      </section>

      <section className="card">
        <h2>Resumo da detecção atual</h2>
        <div className="status-grid">
          {PPE_CLASSES.map((cls) => (
            <StatusCard key={cls} cls={cls} decision={snap.decisions[cls]} showCountdown={false} compact />
          ))}
        </div>
      </section>
    </div>
  );
}
