export type CameraErrorKind =
  | 'insecure_context'
  | 'unsupported'
  | 'permission_denied'
  | 'not_found'
  | 'in_use'
  | 'overconstrained'
  | 'aborted'
  | 'unknown';

export interface CameraErrorInfo {
  kind: CameraErrorKind;
  title: string;
  hint: string;
  detail?: string;
}

const MESSAGES: Record<CameraErrorKind, { title: string; hint: string }> = {
  insecure_context: {
    title: 'A câmera exige conexão segura (HTTPS)',
    hint: 'Abra o protótipo por um endereço https:// ou por http://localhost. Veja o README para as opções.',
  },
  unsupported: {
    title: 'Este navegador não oferece acesso à câmera',
    hint: 'Use o Google Chrome atualizado no Android ou no computador.',
  },
  permission_denied: {
    title: 'Permissão de câmera negada',
    hint: 'Toque no ícone de cadeado na barra de endereço, permita a câmera e toque em "Tentar novamente".',
  },
  not_found: {
    title: 'Nenhuma câmera encontrada',
    hint: 'Verifique se o aparelho possui câmera disponível e se outro aplicativo não a desativou.',
  },
  in_use: {
    title: 'A câmera está em uso por outro aplicativo',
    hint: 'Feche outros aplicativos ou abas que usem a câmera e tente novamente.',
  },
  overconstrained: {
    title: 'A câmera escolhida não está disponível',
    hint: 'Selecione outra câmera em Ajustes ou tente novamente.',
  },
  aborted: {
    title: 'A abertura da câmera foi interrompida',
    hint: 'Tente novamente.',
  },
  unknown: {
    title: 'Não foi possível abrir a câmera',
    hint: 'Tente novamente. Se persistir, reinicie o navegador.',
  },
};

export function cameraError(kind: CameraErrorKind, detail?: string): CameraErrorInfo {
  return { kind, ...MESSAGES[kind], detail };
}

export function mapCameraError(err: unknown): CameraErrorInfo {
  const name = (err as { name?: string })?.name ?? '';
  const detail = err instanceof Error ? err.message : String(err);
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return cameraError('permission_denied', detail);
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return cameraError('not_found', detail);
    case 'NotReadableError':
    case 'TrackStartError':
      return cameraError('in_use', detail);
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return cameraError('overconstrained', detail);
    case 'AbortError':
      return cameraError('aborted', detail);
    case 'SecurityError':
      return cameraError('insecure_context', detail);
    default:
      return cameraError('unknown', detail);
  }
}

/** Verifica pré-requisitos antes de pedir permissão. */
export function checkCameraSupport(): CameraErrorInfo | null {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return cameraError('insecure_context');
  if (!navigator.mediaDevices?.getUserMedia) return cameraError('unsupported');
  return null;
}

export interface OpenOptions {
  deviceId?: string | null;
  facing: 'environment' | 'user';
}

/**
 * Abre a câmera preferindo o dispositivo escolhido, depois a câmera traseira/frontal pedida
 * e, por último, qualquer câmera disponível.
 */
export async function openCamera(opts: OpenOptions, gum = (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)): Promise<MediaStream> {
  const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
  const attempts: MediaStreamConstraints[] = [];
  if (opts.deviceId) attempts.push({ audio: false, video: { deviceId: { exact: opts.deviceId }, ...size } });
  attempts.push({ audio: false, video: { facingMode: { ideal: opts.facing }, ...size } });
  attempts.push({ audio: false, video: true });

  let lastErr: unknown;
  for (const c of attempts) {
    try {
      return await gum(c);
    } catch (e) {
      lastErr = e;
      const name = (e as { name?: string })?.name;
      // Permissão negada / contexto inseguro não melhoram com outras restrições.
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') throw e;
    }
  }
  throw lastErr;
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'videoinput');
}
