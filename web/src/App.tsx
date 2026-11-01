import { useEffect, useState, type ComponentType } from 'react';
import { CameraIndicator } from './components/Common';
import { IconCamera, IconChart, IconInfo, IconOverview, IconShield, IconSliders } from './components/Icons';
import { ControllerContext } from './controller/context';
import type { MonitorController } from './controller/MonitorController';
import { AboutPage } from './pages/AboutPage';
import { LivePage } from './pages/LivePage';
import { OverviewPage } from './pages/OverviewPage';
import { ResultsPage } from './pages/ResultsPage';
import { SettingsPage } from './pages/SettingsPage';

export type Route = 'overview' | 'live' | 'results' | 'settings' | 'about';

const NAV: { route: Route; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { route: 'overview', label: 'Visão geral', icon: IconOverview },
  { route: 'live', label: 'Monitorar', icon: IconCamera },
  { route: 'results', label: 'Testes', icon: IconChart },
  { route: 'settings', label: 'Ajustes', icon: IconSliders },
  { route: 'about', label: 'Sobre', icon: IconInfo },
];

const routeFromHash = (): Route => {
  const h = window.location.hash.replace('#/', '') as Route;
  return NAV.some((n) => n.route === h) ? h : 'overview';
};

export function App({ controller }: { controller: MonitorController }) {
  const [route, setRoute] = useState<Route>(routeFromHash);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    // Libera a câmera ao ocultar/fechar a página.
    const onVis = () => controller.handleVisibility(document.visibilityState === 'hidden');
    const onHide = () => controller.handleVisibility(true);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
    };
  }, [controller]);

  const go = (r: Route) => {
    window.location.hash = `#/${r}`;
    setRoute(r);
    window.scrollTo({ top: 0 });
  };

  return (
    <ControllerContext.Provider value={controller}>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <IconShield size={18} />
            </span>
            <span className="brand-name">
              VisionSafe <span className="muted">AI</span>
            </span>
            <span className="tag tag-proto">Protótipo</span>
          </div>
          <CameraIndicator />
        </header>
        <nav className="nav" aria-label="Navegação principal">
          {NAV.map((n) => (
            <a
              key={n.route}
              href={`#/${n.route}`}
              className={route === n.route ? 'active' : ''}
              aria-current={route === n.route ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                go(n.route);
              }}
            >
              <span className="nav-icon">
                <n.icon size={22} />
              </span>
              <span className="nav-label">{n.label}</span>
            </a>
          ))}
        </nav>
        <main className="content">
          {route === 'overview' && <OverviewPage go={go} />}
          {route === 'live' && <LivePage />}
          {route === 'results' && <ResultsPage />}
          {route === 'settings' && <SettingsPage />}
          {route === 'about' && <AboutPage />}
        </main>
      </div>
    </ControllerContext.Provider>
  );
}
