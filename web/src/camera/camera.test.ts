import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkCameraSupport, mapCameraError, openCamera } from './camera';

const domErr = (name: string) => Object.assign(new Error(name), { name });

describe('câmera', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['NotAllowedError', 'permission_denied'],
    ['NotFoundError', 'not_found'],
    ['NotReadableError', 'in_use'],
    ['OverconstrainedError', 'overconstrained'],
    ['SecurityError', 'insecure_context'],
    ['AbortError', 'aborted'],
    ['Weird', 'unknown'],
  ])('mapeia %s para %s com mensagem em português', (name, kind) => {
    const info = mapCameraError(domErr(name));
    expect(info.kind).toBe(kind);
    expect(info.title.length).toBeGreaterThan(5);
    expect(info.hint.length).toBeGreaterThan(5);
  });

  it('prefere o dispositivo escolhido, depois a câmera traseira, depois qualquer uma', async () => {
    const calls: MediaStreamConstraints[] = [];
    const stream = {} as MediaStream;
    const gum = vi.fn(async (c: MediaStreamConstraints) => {
      calls.push(c);
      if (calls.length < 3) throw domErr('OverconstrainedError');
      return stream;
    });
    await expect(openCamera({ deviceId: 'abc', facing: 'environment' }, gum)).resolves.toBe(stream);
    expect((calls[0].video as MediaTrackConstraints).deviceId).toEqual({ exact: 'abc' });
    expect((calls[1].video as MediaTrackConstraints).facingMode).toEqual({ ideal: 'environment' });
    expect(calls[2].video).toBe(true);
  });

  it('permissão negada não tenta outras restrições', async () => {
    const gum = vi.fn(async () => {
      throw domErr('NotAllowedError');
    });
    await expect(openCamera({ facing: 'environment' }, gum)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it('detecta contexto inseguro e navegador sem suporte', () => {
    vi.stubGlobal('isSecureContext', false);
    expect(checkCameraSupport()?.kind).toBe('insecure_context');
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: undefined });
    expect(checkCameraSupport()?.kind).toBe('unsupported');
  });
});
