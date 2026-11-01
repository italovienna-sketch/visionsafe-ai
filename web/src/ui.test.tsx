import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { StatusCard } from './components/StatusCard';
import { ManifestMissing, MonitorController } from './controller/MonitorController';
import { noSubjectDecision, unavailableDecision } from './core/statusEngine';
import { classStatusLabel } from './core/ppe';
import type { ClassDecision, PpeClass, PpeStatus } from './core/types';

const base = noSubjectDecision();

describe('cartões de status', () => {
  it.each<[ClassDecision, string]>([
    [{ ...base, status: 'DETECTED', reason: undefined, lastScore: 0.87 }, 'DETECTADOS'],
    [{ ...base, status: 'NOT_DETECTED', reason: undefined }, 'NÃO CONFIRMADOS'],
    [{ ...base, status: 'UNCERTAIN', reason: 'blurry' }, 'NÃO AVALIÁVEIS'],
    [unavailableDecision('camera_off'), 'NÃO AVALIÁVEIS'],
  ])('mostra o estado em texto, não apenas por cor (%#)', (d, label) => {
    render(<StatusCard cls="safety_glasses" decision={d} showCountdown />);
    const card = screen.getByTestId('status-safety_glasses');
    expect(card).toHaveAttribute('data-status', d.status);
    expect(within(card).getByText(label)).toBeInTheDocument();
    expect(card).toHaveAccessibleName(`Óculos de segurança: ${label}`);
  });

  it.each<[PpeClass, PpeStatus, string]>([
    ['hearing_protection', 'DETECTED', 'DETECTADO'],
    ['hearing_protection', 'NOT_DETECTED', 'NÃO CONFIRMADO'],
    ['hearing_protection', 'UNCERTAIN', 'NÃO AVALIÁVEL'],
    ['hairnet', 'DETECTED', 'DETECTADA'],
    ['hairnet', 'NOT_DETECTED', 'NÃO CONFIRMADA'],
    ['hairnet', 'CAMERA_UNAVAILABLE', 'NÃO AVALIÁVEL'],
  ])('concorda o estado com o nome do EPI (%s, %s)', (cls, status, label) => {
    expect(classStatusLabel(cls, status)).toBe(label);
  });

  it('exibe confiança e motivo da incerteza com contagem regressiva', () => {
    render(<StatusCard cls="hairnet" decision={{ ...base, reason: 'verifying', lastScore: 0.1, bestScore: 0.1, verifyRemainingMs: 2300, progress: 0.5 }} showCountdown />);
    expect(screen.getByText('conf. 10%')).toBeInTheDocument();
    expect(screen.getByText(/Verificando · 3 s/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });
});

describe('aplicativo', () => {
  let controller: MonitorController;
  beforeEach(async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    controller = new MonitorController({
      storage: null,
      baseUrl: 'http://localhost/',
      fetchJson: async () => {
        throw new ManifestMissing('404');
      },
    });
    await controller.loadServerModel();
    window.location.hash = '';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('visão geral informa honestamente que não há modelo e oferece o monitoramento', () => {
    render(<App controller={controller} />);
    expect(screen.getByRole('heading', { name: 'VisionSafe AI' })).toBeInTheDocument();
    expect(screen.getAllByText('Modelo de IA ainda não configurado — câmera disponível para testes.').length).toBeGreaterThan(0);
    expect(screen.getByText(/não é um sistema de segurança certificado/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir monitoramento ao vivo' })).toBeInTheDocument();
  });

  it('navega entre as cinco telas', async () => {
    const user = userEvent.setup();
    render(<App controller={controller} />);
    const nav = screen.getByRole('navigation', { name: 'Navegação principal' });
    await user.click(within(nav).getByText('Monitorar'));
    expect(screen.getByRole('button', { name: 'Iniciar câmera' })).toBeInTheDocument();
    await user.click(within(nav).getByText('Testes'));
    expect(screen.getByRole('heading', { name: 'Resultados de teste' })).toBeInTheDocument();
    await user.click(within(nav).getByText('Ajustes'));
    expect(screen.getByTestId('model-state')).toHaveTextContent('Não configurado');
    await user.click(within(nav).getByText('Sobre'));
    expect(screen.getByRole('heading', { name: 'Sobre o protótipo' })).toBeInTheDocument();
  });

  it('mostra erro de permissão com botão de nova tentativa', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw Object.assign(new Error('x'), { name: 'NotAllowedError' });
        }),
      },
    });
    const user = userEvent.setup();
    window.location.hash = '#/live';
    render(<App controller={controller} />);
    await user.click(screen.getByRole('button', { name: 'Iniciar câmera' }));
    expect(await screen.findByText('Permissão de câmera negada')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Tentar novamente' }).length).toBeGreaterThan(0);
    expect(screen.getByTestId('status-hairnet')).toHaveAttribute('data-status', 'CAMERA_UNAVAILABLE');
  });

  it('indicador de câmera ativa fica visível em todas as telas', () => {
    render(<App controller={controller} />);
    expect(screen.getAllByRole('status').some((el) => el.textContent?.includes('Câmera desligada'))).toBe(true);
    act(() => controller.stopCamera());
  });
});
