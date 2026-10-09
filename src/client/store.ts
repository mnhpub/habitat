import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { ClientSnapshot, Command, Role } from '../shared/types';
import { EventStore } from './event-store';
export { api, ApiError, EventStore } from './event-store';

export interface EventCtx {
  store: EventStore;
  snap: ClientSnapshot;
  /** Send a command; failures show a toast. Resolves to whether it worked. */
  send: (cmd: Command) => Promise<boolean>;
  has: (...roles: Role[]) => boolean;
}

export const EventContext = createContext<EventCtx | null>(null);

export function useEvent(): EventCtx {
  const ctx = useContext(EventContext);
  if (!ctx) throw new Error('useEvent outside an event');
  return ctx;
}

export function useStore(store: EventStore) {
  useSyncExternalStore(store.subscribe, () => store.revision);
  return store;
}

/** Re-render on an interval (for the event clock and countdowns). */
export function useTick(ms = 200) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

// Toasts --------------------------------------------------------------------
type Toast = { id: number; text: string; kind: 'error' | 'info' };
let toasts: Toast[] = [];
const toastListeners = new Set<() => void>();
export function toast(text: string, kind: Toast['kind'] = 'error') {
  const t = { id: Date.now() + Math.random(), text, kind };
  toasts = [...toasts, t];
  toastListeners.forEach((l) => l());
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== t.id); toastListeners.forEach((l) => l()); }, 4000);
}
export function useToasts(): Toast[] {
  return useSyncExternalStore((l) => { toastListeners.add(l); return () => toastListeners.delete(l); }, () => toasts);
}
