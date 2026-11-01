import type { PpeClass, PpeStatus, UncertainReason, UnavailableReason } from './types';

export const PPE_INFO: Record<PpeClass, { label: string; short: string; description: string }> = {
  safety_glasses: {
    label: 'Óculos de segurança',
    short: 'Óculos',
    description: 'Óculos de proteção industrial no rosto.',
  },
  hearing_protection: {
    label: 'Protetor auricular',
    short: 'Auricular',
    description: 'Protetor de inserção (plug) ou tipo concha, conforme o EPI real da área.',
  },
  hairnet: {
    label: 'Touca / rede de cabelo',
    short: 'Touca',
    description: 'Cobertura capilar de proteção utilizada na área.',
  },
};

/**
 * Três estados lógicos para quem lê a tela:
 * - Detectado;
 * - Não confirmado: a pessoa foi observada por toda a janela e o EPI não apareceu na imagem — não prova que
 *   ela está sem o EPI (pode estar oculto, fora do ângulo ou não reconhecido pelo modelo);
 * - Não avaliável: o sistema não tem leitura confiável (verificando, distante, escuro, câmera/modelo parados).
 * UNCERTAIN e CAMERA_UNAVAILABLE compartilham o rótulo; o motivo e o ícone diferenciam a causa.
 */
export const STATUS_LABEL: Record<PpeStatus, string> = {
  DETECTED: 'Detectado',
  NOT_DETECTED: 'Não confirmado',
  UNCERTAIN: 'Não avaliável',
  CAMERA_UNAVAILABLE: 'Não avaliável',
};

/**
 * Rótulo do estado concordando com o nome do EPI (gênero e número), em maiúsculas como no painel:
 * ÓCULOS: DETECTADOS · PROTETOR AURICULAR: DETECTADO · TOUCA: DETECTADA.
 */
const AGREEMENT: Record<PpeClass, { suffix: string; plural: boolean }> = {
  safety_glasses: { suffix: 'os', plural: true },
  hearing_protection: { suffix: 'o', plural: false },
  hairnet: { suffix: 'a', plural: false },
};

export function classStatusLabel(cls: PpeClass, status: PpeStatus): string {
  const { suffix, plural } = AGREEMENT[cls];
  switch (status) {
    case 'DETECTED':
      return `DETECTAD${suffix.toUpperCase()}`;
    case 'NOT_DETECTED':
      return `NÃO CONFIRMAD${suffix.toUpperCase()}`;
    default:
      return plural ? 'NÃO AVALIÁVEIS' : 'NÃO AVALIÁVEL';
  }
}

/** Explicação curta exibida junto do estado (o que o profissional deve fazer). */
export const STATUS_HINT: Partial<Record<PpeStatus, string>> = {
  NOT_DETECTED: 'Não visto na imagem durante a verificação. Confira pessoalmente.',
};

export const REASON_LABEL: Record<UncertainReason | UnavailableReason, string> = {
  no_subject: 'Nenhuma pessoa visível',
  subject_small: 'Pessoa muito distante ou pequena',
  not_refined: 'Pessoa fora do recorte analisado (muitas pessoas no quadro)',
  subject_truncated: 'Pessoa cortada na borda da imagem',
  blurry: 'Imagem borrada',
  too_dark: 'Iluminação insuficiente',
  too_bright: 'Imagem superexposta',
  verifying: 'Verificando',
  insufficient_observations: 'Observações insuficientes',
  ambiguous_scores: 'Leitura ambígua (confiança baixa ou EPI entre pessoas)',
  inconsistent: 'Detecções inconsistentes',
  camera_off: 'Câmera desligada',
  camera_error: 'Erro de câmera',
  model_missing: 'Modelo de IA não configurado',
  model_loading: 'Carregando modelo',
  warming_up: 'Aguardando o primeiro quadro analisado',
  inference_error: 'Falha na inferência',
  class_unsupported: 'Modelo atual não reconhece este EPI',
  proxy_disabled: 'Classe aproximada desativada nos ajustes',
  paused: 'Monitoramento pausado',
  stale: 'Análise atrasada — resultado antigo',
};
