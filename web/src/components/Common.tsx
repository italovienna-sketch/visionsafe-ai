import type { ReactNode } from 'react';
import { activeTargets, supportedTargets } from '../core/manifest';
import { PPE_INFO } from '../core/ppe';
import { PPE_CLASSES } from '../core/types';
import { useMonitor } from '../controller/context';
import { IconAlert, IconInfo } from './Icons';

export function Notice({ tone, title, children }: { tone: 'info' | 'warn' | 'error'; title: string; children?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="notice-icon">{tone === 'info' ? <IconInfo size={18} /> : <IconAlert size={18} />}</span>
      <div>
        <strong>{title}</strong>
        {children && <div className="notice-body">{children}</div>}
      </div>
    </div>
  );
}

/** Indicador permanente de câmera ativa (requisito de privacidade). */
export function CameraIndicator() {
  const snap = useMonitor();
  const on = snap.camera.state === 'running';
  const label = on ? (snap.paused ? 'Câmera ativa · pausado' : 'Câmera ativa') : snap.camera.state === 'requesting' ? 'Solicitando câmera' : 'Câmera desligada';
  return (
    <span className={`cam-indicator${on ? ' on' : ''}`} role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export const NO_MODEL_MESSAGE = 'Modelo de IA ainda não configurado — câmera disponível para testes.';

/** Explica o estado do modelo em linguagem clara; nunca finge capacidade inexistente. */
export function ModelNotice() {
  const { model } = useMonitor();
  if (model.state === 'loading') return null; // o painel do modelo mostra o progresso
  if (model.state === 'none')
    return (
      <Notice tone="warn" title={NO_MODEL_MESSAGE}>
        Nenhum modelo de EPI está instalado neste servidor. A câmera pode ser testada normalmente, mas nenhum EPI será
        avaliado. Instale <code>models/manifest.json</code> + <code>.onnx</code> ou carregue os arquivos em Ajustes.
      </Notice>
    );
  if (model.state === 'error')
    return (
      <Notice tone="error" title="Falha ao carregar o modelo">
        {model.error}
      </Notice>
    );
  const m = model.manifest;
  if (m?.purpose === 'diagnostic')
    return (
      <Notice tone="warn" title="Modelo de diagnóstico — não avalia EPIs">
        O modelo carregado ({m.name}) detecta apenas pessoas e serve para validar câmera, inferência e alinhamento das
        caixas. Os EPIs ficam “Não avaliável” até que um modelo treinado seja instalado.
      </Notice>
    );
  const proxies = Object.entries(m?.proxyClasses ?? {});
  if (proxies.length)
    return (
      <Notice tone="warn" title="Algumas classes são aproximações">
        {proxies.map(([cls, note]) => (
          <div key={cls}>
            <strong>{PPE_INFO[cls as keyof typeof PPE_INFO].label}:</strong> {note}
          </div>
        ))}
      </Notice>
    );
  return null;
}

const MODEL_STATE_LABEL = { none: 'Não configurado', loading: 'Carregando', ready: 'Pronto', error: 'Erro' } as const;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Painel compacto: estado do modelo, cobertura de classes e execução. */
export function ModelPanel() {
  const snap = useMonitor();
  const { model, settings } = snap;
  const m = model.manifest;
  const supported = m ? supportedTargets(m) : new Set();
  const active = m ? activeTargets(m, settings) : new Set();
  const p = model.progress;
  return (
    <section className="panel" aria-labelledby="model-panel-title" data-testid="model-panel">
      <div className="panel-head">
        <h2 id="model-panel-title">Modelo de IA</h2>
        <span className={`tag model-${model.state}`} data-testid="model-state-tag">
          {MODEL_STATE_LABEL[model.state]}
        </span>
      </div>
      {model.state === 'loading' && (
        <div className="load-progress">
          <div
            className={`progress${p && p.total ? '' : ' indeterminate'}`}
            role="progressbar"
            aria-label="Carregando modelo"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={p && p.total ? Math.round((p.loaded / p.total) * 100) : undefined}
          >
            <div style={p && p.total ? { width: `${Math.round((p.loaded / p.total) * 100)}%` } : undefined} />
          </div>
          <span className="small muted mono">
            {p ? `${formatBytes(p.loaded)}${p.total ? ` de ${formatBytes(p.total)}` : ''}` : 'Preparando…'}
          </span>
        </div>
      )}
      {model.fallbackNote && (
        <Notice tone="warn" title="Modelo de reserva em uso">
          {model.fallbackNote}
        </Notice>
      )}
      {m ? (
        <dl className="kv kv-compact">
          <dt>Nome</dt>
          <dd>
            {m.name} <span className="muted">v{m.version}</span>
          </dd>
          {m.cropModel && (
            <>
              <dt>EPIs (recorte)</dt>
              <dd data-testid="crop-model">
                {m.cropModel.name} <span className="muted">v{m.cropModel.version}</span>
              </dd>
            </>
          )}
          <dt>Tipo</dt>
          <dd>{m.purpose === 'diagnostic' ? 'Diagnóstico (só pessoas)' : 'Detector de EPI'}</dd>
          <dt>Classes</dt>
          <dd className="coverage">
            {PPE_CLASSES.map((c) => (
              <span
                key={c}
                className={`tag ${active.has(c) ? (m.proxyClasses?.[c] ? 'tag-warn' : 'tag-ok') : 'tag-off'}`}
                title={m.proxyClasses?.[c] ?? (supported.has(c) ? '' : 'Não reconhecido pelo modelo')}
              >
                {PPE_INFO[c].short}
                {!supported.has(c) ? ' · não' : m.proxyClasses?.[c] ? (active.has(c) ? ' · aprox.' : ' · desligado') : ''}
              </span>
            ))}
          </dd>
          <dt>Execução</dt>
          <dd>
            {model.info
              ? `${model.info.backend}${model.info.threads > 1 ? ` ×${model.info.threads}` : ''} · ${m.inputSize}px`
              : '—'}
          </dd>
          {m.license && (
            <>
              <dt>Licença</dt>
              <dd className="small">{m.license}</dd>
            </>
          )}
        </dl>
      ) : (
        model.state !== 'loading' && <p className="small muted">{model.state === 'none' ? NO_MODEL_MESSAGE : model.error}</p>
      )}
    </section>
  );
}

export function Metric({ label, value, unit }: { label: string; value: ReactNode; unit?: string }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value mono">
        {value}
        {unit && <span className="metric-unit">{unit}</span>}
      </span>
    </div>
  );
}

export const fmt = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);

export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
