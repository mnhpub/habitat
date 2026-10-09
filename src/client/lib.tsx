import type { ReactNode } from 'react';
import type { Role } from '../shared/types';
import { useEvent, useTick } from './store';

export function fmtTau(ms: number, withMs = false): string {
  const neg = ms < 0;
  const a = Math.abs(Math.floor(ms));
  const h = Math.floor(a / 3_600_000), m = Math.floor(a / 60_000) % 60, s = Math.floor(a / 1000) % 60, r = a % 1000;
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${neg ? '−' : ''}${p(h)}:${p(m)}:${p(s)}${withMs ? '.' + p(r, 3) : ''}`;
}

export function fmtCountdown(ms: number): string {
  const neg = ms < 0;
  const a = Math.abs(Math.round(ms / 1000));
  const m = Math.floor(a / 60), s = a % 60;
  return `${neg ? '+' : ''}${m}:${String(s).padStart(2, '0')}`;
}

export function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function initials(name: string): string {
  return name.split(/[\s·]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
}

export const ROLE_LABEL: Record<Role, string> = {
  organizer: 'Organizer', producer: 'Producer / director', audio: 'Audio', stage_manager: 'Stage manager',
  moderator: 'Host / moderator', talent: 'Talent', foh: 'Front of house', vendor: 'Vendor', attendee: 'Attendee',
};

/** Live event clock τ, ticking. */
export function Tau({ withMs = true, className = '' }: { withMs?: boolean; className?: string }) {
  const { store, snap } = useEvent();
  useTick(withMs ? 100 : 500);
  return <span className={`mono ${className}`}>{fmtTau(store.now() - snap.state.epoch, withMs)}</span>;
}

export function Person({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#3A4552" strokeWidth={1.2} aria-hidden="true">
      <circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
    </svg>
  );
}

export function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4CC9F0" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 20V8l9-5 9 5v12" /><path d="M7 20v-7h10v7" />
    </svg>
  );
}

export function Icon({ d, size = 18, color = 'currentColor', stroke = 1.8 }: { d: string; size?: number; color?: string; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export const ICONS = {
  check: 'M5 12l5 5 9-10',
  up: 'M6 15l6-6 6 6',
  menu: 'M4 6h16M4 12h16M4 18h16',
  shield: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z',
  applause: 'M7 11v8M7 11l4-7a2 2 0 013 2l-1 5h5a2 2 0 012 2l-1.5 6a2 2 0 01-2 1.5H7',
  love: 'M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z',
  laugh: 'M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M12 21a9 9 0 100-18 9 9 0 000 18z',
  wow: 'M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2',
  confused: 'M9 9a3 3 0 115 2c-1 .8-2 1.4-2 3M12 18h.01',
  coffee: 'M5 8h12v6a5 5 0 01-5 5h-2a5 5 0 01-5-5zM17 10h1.5a2.5 2.5 0 010 5H17M8 3v2M11 3v2M14 3v2',
  car: 'M5 16l1.5-5h11l1.5 5M4 16h16v3H4zM7.5 19v1.5M16.5 19v1.5',
  bed: 'M3 19V8M3 13h18v6M21 19v-6a3 3 0 00-3-3h-7v3',
  bus: 'M5 17V6a2 2 0 012-2h10a2 2 0 012 2v11M5 12h14M5 17h14M8 17v2M16 17v2',
  screen: 'M3 5h18v12H3zM8 21h8',
  mic: 'M9 5a3 3 0 016 0v6a3 3 0 01-6 0zM5 11a7 7 0 0014 0M12 18v3',
  headset: 'M4 14v-2a8 8 0 0116 0v2M3 14h4v6H3zM17 14h4v6h-4z',
  arrow: 'M2 12h18M14 6l6 6-6 6',
};

export function Empty({ children }: { children: ReactNode }) {
  return <div className="muted small" style={{ padding: '6px 0' }}>{children}</div>;
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" onClick={() => onChange(!on)} />;
}

/** Hide a control from people whose role can't use it; show a quiet note instead. */
export function Gate({ roles, children, note }: { roles: Role[]; children: ReactNode; note?: string }) {
  const { has } = useEvent();
  if (has(...roles)) return <>{children}</>;
  return note ? <div className="muted small">{note}</div> : null;
}
