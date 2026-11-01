import { createContext, useContext, useSyncExternalStore } from 'react';
import type { MonitorController, MonitorSnapshot } from './MonitorController';

export const ControllerContext = createContext<MonitorController | null>(null);

export function useController(): MonitorController {
  const c = useContext(ControllerContext);
  if (!c) throw new Error('ControllerContext ausente');
  return c;
}

export function useMonitor(): MonitorSnapshot {
  const c = useController();
  return useSyncExternalStore(c.subscribe, c.getSnapshot);
}
