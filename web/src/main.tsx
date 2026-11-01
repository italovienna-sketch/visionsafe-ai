import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MonitorController } from './controller/MonitorController';
import './styles.css';

const controller = new MonitorController();
void controller.loadServerModel();
// Exposto apenas em desenvolvimento/testes E2E para inspecionar o estado real do pipeline.
if (import.meta.env.DEV || new URLSearchParams(location.search).has('e2e')) {
  (window as unknown as { __visionsafe: MonitorController }).__visionsafe = controller;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App controller={controller} />
  </StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
