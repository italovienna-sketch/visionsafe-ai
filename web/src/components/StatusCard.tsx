import type { ComponentType } from 'react';
import { classStatusLabel, PPE_INFO, REASON_LABEL, STATUS_HINT, STATUS_LABEL } from '../core/ppe';
import type { ClassDecision, PpeClass, PpeStatus } from '../core/types';
import { IconCheck, IconMinus, IconQuestion, IconX } from './Icons';

const ICON: Record<PpeStatus, ComponentType<{ size?: number }>> = {
  DETECTED: IconCheck,
  NOT_DETECTED: IconX,
  UNCERTAIN: IconQuestion,
  CAMERA_UNAVAILABLE: IconMinus,
};

export function statusClass(s: PpeStatus): string {
  return `st-${s.toLowerCase().replace('_', '-')}`;
}

export function StatusPill({ status }: { status: PpeStatus }) {
  const Icon = ICON[status];
  return (
    <span className={`pill ${statusClass(status)}`}>
      <Icon size={14} />
      {STATUS_LABEL[status]}
    </span>
  );
}

interface Props {
  cls: PpeClass;
  decision: ClassDecision;
  showCountdown: boolean;
  proxyNote?: string;
  compact?: boolean;
}

export function StatusCard({ cls, decision, showCountdown, proxyNote, compact }: Props) {
  const info = PPE_INFO[cls];
  const d = decision;
  const Icon = ICON[d.status];
  const label = classStatusLabel(cls, d.status);
  const verifying = d.status === 'UNCERTAIN' && d.reason === 'verifying';
  // Confiança só é exibida quando veio de uma inferência real nesta janela.
  // Confiança 0% em toda a janela não informa nada: só aparece quando o modelo viu algo.
  const score = d.status === 'CAMERA_UNAVAILABLE' || d.bestScore <= 0 ? null : d.lastScore;
  return (
    <section
      className={`status-card ${statusClass(d.status)}${compact ? ' compact' : ''}`}
      aria-label={`${info.label}: ${label}`}
      data-testid={`status-${cls}`}
      data-status={d.status}
    >
      <span className="status-icon" aria-hidden="true">
        <Icon size={compact ? 16 : 18} />
      </span>
      <div className="status-body">
        <div className="status-card-head">
          <span className="status-name">{compact ? info.short : info.label}</span>
          {proxyNote && (
            <span className="tag tag-warn" title={proxyNote}>
              aprox.
            </span>
          )}
        </div>
        <span className="status-label">{label}</span>
        {!compact && STATUS_HINT[d.status] && <span className="status-hint">{STATUS_HINT[d.status]}</span>}
        {/* O texto completo da aproximação fica num só lugar (aviso do modelo); aqui, só a indicação. */}
        {proxyNote && !compact && d.reason !== 'proxy_disabled' && <span className="proxy-note">Classe aproximada — veja o aviso do modelo.</span>}
        <div className="status-meta">
          {score !== null && (
            <span className="mono" title="Confiança no quadro mais recente / melhor na janela de verificação">
              conf. {Math.round(score * 100)}%
              {d.bestScore > score && <span className="muted"> · máx {Math.round(d.bestScore * 100)}%</span>}
            </span>
          )}
          {d.reason && d.status !== 'DETECTED' && d.status !== 'NOT_DETECTED' && (
            <span className="reason">
              {REASON_LABEL[d.reason]}
              {verifying && showCountdown && ` · ${Math.ceil(d.verifyRemainingMs / 1000)} s`}
            </span>
          )}
        </div>
        {d.status === 'UNCERTAIN' && showCountdown && (
          <div
            className="progress"
            role="progressbar"
            aria-label="Observações coletadas"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(d.progress * 100)}
          >
            <div style={{ width: `${Math.round(d.progress * 100)}%` }} />
          </div>
        )}
      </div>
    </section>
  );
}
