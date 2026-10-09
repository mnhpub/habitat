import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, EventContext, EventStore, toast, useStore, useToasts, type EventCtx } from './store';
import { Icon, ICONS, Logo, ROLE_LABEL, Tau } from './lib';
import type { Command, CommandResult, Role } from '../shared/types';
import * as Production from './pages/production';
import * as Backstage from './pages/backstage';
import * as Audience from './pages/audience';
import * as Ops from './pages/ops';
import * as Breakouts from './pages/breakouts';

interface Me { identity: { email: string; name: string; warp: boolean; device: string; source: 'access' | 'dev' }; devAuth: boolean; requireWarp: boolean }

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/dev-login" element={<DevLogin />} />
        <Route path="/e/:eventId/*" element={<EventShell />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toasts />
    </BrowserRouter>
  );
}

function Toasts() {
  const list = useToasts();
  if (!list.length) return null;
  const t = list[list.length - 1];
  return <div className={`toast ${t.kind === 'info' ? 'info' : ''}`} role="status">{t.text}</div>;
}

function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'signin' | 'devlogin' | 'error'>('loading');
  const [err, setErr] = useState('');
  useEffect(() => {
    api<Me>('/api/me').then((m) => { setMe(m); setState('ok'); }).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 401) setState((e.body as { devAuth?: boolean })?.devAuth ? 'devlogin' : 'signin');
      else { setErr(e instanceof Error ? e.message : String(e)); setState('error'); }
    });
  }, []);
  return { me, state, err };
}

// ---------------------------------------------------------------- home

interface EventListItem { id: string; name: string; kind: string; venue: string; createdAt: number; roles: Role[]; member: boolean }

function Home() {
  const { me, state, err } = useMe();
  const [events, setEvents] = useState<EventListItem[] | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'corporate' | 'social'>('corporate');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  useEffect(() => { if (state === 'ok') api<EventListItem[]>('/api/events').then(setEvents).catch(() => setEvents([])); }, [state]);
  if (state === 'devlogin') return <Navigate to="/dev-login" replace />;
  if (state === 'loading') return <Centered><span className="muted">Loading…</span></Centered>;
  if (state === 'signin') return <Centered><SignInHelp /></Centered>;
  if (state === 'error') return <Centered><div className="banner">Couldn't reach the server: {err}</div></Centered>;

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const { id } = await api<{ id: string }>('/api/events', { method: 'POST', json: { name, kind } });
      nav(`/e/${id}/organizer`);
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not create event'); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '28px 20px' }} className="stack loose">
      <div className="row between">
        <div className="row"><Logo /><span style={{ fontWeight: 700, fontSize: 18 }}>Habitat</span></div>
        <Identity me={me!} />
      </div>
      <div className="stack tight">
        <h1>Your events</h1>
        <span className="muted">Every event is its own live venue: stages, backstage, lobby, services and its own clock.</span>
      </div>
      <div className="grid" style={{ '--min': '280px' } as React.CSSProperties}>
        {events === null && <span className="muted">Loading events…</span>}
        {events?.length === 0 && <span className="muted">No events yet. Create one below — it starts with demo content so every screen has something in it.</span>}
        {events?.map((e) => (
          <EventCard
            key={e.id}
            e={e}
            onRename={(name) => setEvents((list) => list?.map((x) => (x.id === e.id ? { ...x, name } : x)) ?? list)}
            onDelete={() => { setEvents((list) => list?.filter((x) => x.id !== e.id) ?? list); toast('Event deleted', 'info'); }}
          />
        ))}
      </div>
      <div className="panel" style={{ maxWidth: 560 }}>
        <span className="label">Create an event</span>
        <label className="fieldlabel">Event name<input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Partner Summit 2026" /></label>
        <div className="seg" role="radiogroup" aria-label="Kind">
          <button type="button" role="radio" aria-checked={kind === 'corporate'} className={kind === 'corporate' ? 'on' : ''} onClick={() => setKind('corporate')}>Corporate</button>
          <button type="button" role="radio" aria-checked={kind === 'social'} className={kind === 'social' ? 'on' : ''} onClick={() => setKind('social')}>Social</button>
        </div>
        <div><button className="btn primary" disabled={busy || !name.trim()} onClick={create}>Create event</button></div>
        <span className="muted small">You'll be its organizer. Add your team from Team &amp; setup.</span>
      </div>
    </div>
  );
}

/** One event on the home page. Organizers can rename it or delete it; deleting asks for the name first. */
function EventCard({ e, onRename, onDelete }: { e: EventListItem; onRename: (name: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(e.name);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const organizer = e.roles.includes('organizer');

  const save = async () => {
    const next = name.trim();
    if (!next || next === e.name) { setEditing(false); return; }
    setBusy(true);
    try {
      const r = await api<CommandResult>(`/api/events/${e.id}/commands`, { method: 'POST', json: { type: 'RENAME_EVENT', name: next, venue: e.venue } });
      if (!r.ok) throw new Error(r.error ?? 'Could not rename the event');
      onRename(next);
      setEditing(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not rename the event');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api(`/api/events/${e.id}`, { method: 'DELETE' });
      onDelete();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the event');
      setBusy(false);
    }
  };

  return (
    <div className="panel stack tight">
      {editing ? (
        <form className="stack tight" onSubmit={(ev) => { ev.preventDefault(); save(); }}>
          <input className="field" value={name} onChange={(ev) => setName(ev.target.value)} aria-label="Event name" maxLength={120} autoFocus />
          <div className="row">
            <button className="btn primary sm" type="submit" disabled={busy || !name.trim()}>Save name</button>
            <button className="btn sm" type="button" onClick={() => { setEditing(false); setName(e.name); }}>Cancel</button>
          </div>
        </form>
      ) : (
        <Link to={`/e/${e.id}/${landingFor(e.roles)}`} className="stack tight" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span style={{ fontWeight: 600, fontSize: 16 }}>{e.name}</span>
          <span className="muted small">{e.kind === 'social' ? 'Social' : 'Corporate'} · created {new Date(e.createdAt).toLocaleDateString()}</span>
          <div className="row">{e.roles.map((r) => <span key={r} className="pill accent">{ROLE_LABEL[r]}</span>)}</div>
        </Link>
      )}

      {organizer && !editing && !confirming && (
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm" onClick={() => setEditing(true)}>Rename</button>
          <button className="btn sm danger" onClick={() => setConfirming(true)}>Delete</button>
        </div>
      )}

      {confirming && (
        <form className="stack tight" onSubmit={(ev) => { ev.preventDefault(); if (typed === e.name) remove(); }}>
          <span className="small">
            Type <b>{e.name}</b> to delete this event. Its schedule, chat, journal, breakouts and team are removed for everyone, and this cannot be undone.
          </span>
          <input className="field" value={typed} onChange={(ev) => setTyped(ev.target.value)} aria-label="Type the event name to confirm" />
          <div className="row">
            <button className="btn danger sm" type="submit" disabled={busy || typed !== e.name}>Delete event</button>
            <button className="btn sm" type="button" onClick={() => { setConfirming(false); setTyped(''); }}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

function landingFor(roles: Role[]): string {
  if (roles.includes('organizer')) return 'organizer';
  if (roles.includes('producer')) return 'control';
  if (roles.includes('audio')) return 'bus';
  if (roles.includes('stage_manager')) return 'stage-manager';
  if (roles.includes('moderator')) return 'host';
  if (roles.includes('talent')) return 'green-room';
  if (roles.includes('foh')) return 'check-in';
  if (roles.includes('vendor')) return 'vendor';
  return 'lobby';
}

function Identity({ me }: { me: Me }) {
  return (
    <div className="row small">
      <span className={`pill ${me.identity.warp ? 'ok' : 'warn'}`}><Icon d={ICONS.shield} size={14} />{me.identity.warp ? 'WARP device' : 'Not on WARP'}</span>
      <span className="muted">{me.identity.name} · {me.identity.email}</span>
      {me.devAuth && <Link to="/dev-login" className="btn sm ghost">Switch person</Link>}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>{children}</div>;
}

function SignInHelp() {
  return (
    <div className="panel" style={{ maxWidth: 480 }}>
      <div className="row"><Logo /><h2>Sign in required</h2></div>
      <span className="muted">This app is protected by Cloudflare Access. Reload the page to sign in with your organization's identity provider. Crew controls also need the Cloudflare WARP client.</span>
      <button className="btn primary" onClick={() => location.reload()}>Reload</button>
    </div>
  );
}

// ---------------------------------------------------------------- dev sign-in (localhost only)

const DEV_PEOPLE: { email: string; name: string; note: string }[] = [
  { email: 'organizer@example.com', name: 'Rosa Alvarez', note: 'Creates events, adds the team' },
  { email: 'director@example.com', name: 'M. Hale', note: 'Producer / director' },
  { email: 'audio@example.com', name: 'Priya Natarajan', note: 'Audio' },
  { email: 'sm@example.com', name: 'Sam Ito', note: 'Stage manager' },
  { email: 'host@example.com', name: 'Marcus Bell', note: 'Host / moderator' },
  { email: 'talent@example.com', name: 'Kenji Mori', note: 'Talent' },
  { email: 'foh@example.com', name: 'Dee Ruiz', note: 'Front of house' },
  { email: 'vendor@example.com', name: 'Riverwalk Catering', note: 'Vendor' },
  { email: 'guest@example.com', name: 'Jordan Patel', note: 'Attendee' },
];

function DevLogin() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [warp, setWarp] = useState(true);
  const go = async (e: string, n: string) => {
    try {
      await api('/api/dev/login', { method: 'POST', json: { email: e, name: n, warp } });
      location.href = '/';
    } catch (err) { toast(err instanceof Error ? err.message : 'Failed'); }
  };
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '28px 20px' }} className="stack loose">
      <div className="row"><Logo /><h1>Local sign-in</h1></div>
      <div className="banner">Development only. In production, Cloudflare Access signs people in and reports whether they're on WARP. Roles come from each event's team list — the organizer adds people by email.</div>
      <label className="check"><input type="checkbox" checked={warp} onChange={(e) => setWarp(e.target.checked)} />Pretend this device is on WARP</label>
      <div className="grid" style={{ '--min': '220px' } as React.CSSProperties}>
        {DEV_PEOPLE.map((p) => (
          <button key={p.email} className="panel" style={{ cursor: 'pointer', textAlign: 'left' }} onClick={() => go(p.email, p.name)}>
            <span style={{ fontWeight: 600 }}>{p.name}</span>
            <span className="muted small">{p.email}</span>
            <span className="accent small">{p.note}</span>
          </button>
        ))}
      </div>
      <div className="panel">
        <span className="label">Someone else</span>
        <div className="row">
          <input className="field" style={{ flex: '1 1 200px' }} placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="field" style={{ flex: '1 1 200px' }} placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn primary" onClick={() => go(email, name)} disabled={!email.includes('@')}>Sign in</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- event shell

interface Screen { path: string; title: string; roles: Role[] | 'all'; el: () => ReactNode }

const CREW: Role[] = ['producer', 'audio', 'stage_manager', 'moderator', 'talent', 'foh', 'vendor'];

export const SCREENS: { group: string; items: Screen[] }[] = [
  { group: 'Production', items: [
    { path: 'control', title: 'Control room', roles: ['producer'], el: () => <Production.ControlRoom /> },
    { path: 'simple', title: 'Simple control room', roles: ['producer'], el: () => <Production.SimpleControl /> },
    { path: 'clock', title: 'Event clock & devices', roles: CREW, el: () => <Production.EventClock /> },
    { path: 'bus', title: 'Stream bus', roles: ['producer', 'audio'], el: () => <Production.StreamBus /> },
    { path: 'bridge', title: 'Bridge', roles: CREW, el: () => <Production.Bridge /> },
    { path: 'breakouts', title: 'Breakouts', roles: CREW, el: () => <Breakouts.Breakouts /> },
  ] },
  { group: 'Talent & backstage', items: [
    { path: 'green-room', title: 'Green room', roles: ['talent', 'stage_manager', 'producer'], el: () => <Backstage.GreenRoom /> },
    { path: 'talent', title: 'Talent (iPhone)', roles: ['talent'], el: () => <Backstage.TalentPhone /> },
    { path: 'stage-manager', title: 'Stage manager', roles: ['stage_manager', 'producer'], el: () => <Backstage.StageManager /> },
    { path: 'camera', title: 'Camera operator', roles: ['producer', 'stage_manager'], el: () => <Backstage.CameraOp /> },
  ] },
  { group: 'Audience', items: [
    { path: 'join', title: 'How to attend', roles: 'all', el: () => <Audience.Join /> },
    { path: 'lobby', title: 'Lobby & stage', roles: 'all', el: () => <Audience.Lobby /> },
    { path: 'engage', title: 'Engage', roles: 'all', el: () => <Audience.Engage /> },
    { path: 'vote', title: 'Vote (iPhone)', roles: 'all', el: () => <Audience.Vote /> },
    { path: 'qa', title: 'Q&A + chat (iPhone)', roles: 'all', el: () => <Audience.QAChat /> },
    { path: 'guest', title: 'My event (iPhone)', roles: 'all', el: () => <Audience.GuestHome /> },
    { path: 'networking', title: 'Networking', roles: 'all', el: () => <Audience.Networking /> },
    { path: 'watch-party', title: 'Watch party', roles: 'all', el: () => <Audience.WatchParty /> },
  ] },
  { group: 'Moderation', items: [
    { path: 'moderator', title: 'Moderator console', roles: ['moderator', 'producer'], el: () => <Ops.Moderator /> },
    { path: 'host', title: 'Host (iPad)', roles: ['moderator'], el: () => <Ops.HostView /> },
  ] },
  { group: 'Operations', items: [
    { path: 'organizer', title: 'Organizer', roles: [], el: () => <Ops.Organizer /> },
    { path: 'team', title: 'Team & setup', roles: [], el: () => <Ops.Team /> },
    { path: 'attendee-types', title: 'Attendee types', roles: [], el: () => <Ops.AttendeeTypes /> },
    { path: 'check-in', title: 'Check-in', roles: ['foh'], el: () => <Ops.CheckIn /> },
    { path: 'vendor', title: 'Orders & valet', roles: ['vendor', 'foh'], el: () => <Ops.VendorQueue /> },
  ] },
];

function EventShell() {
  const { eventId = '' } = useParams();
  const store = useMemo(() => new EventStore(eventId), [eventId]);
  useEffect(() => { store.start(); return () => store.stop(); }, [store]);
  useStore(store);
  const [menu, setMenu] = useState(false);

  const snap = store.snap;
  const ctx: EventCtx | null = useMemo(() => {
    if (!snap) return null;
    const has = (...roles: Role[]) => snap.me.roles.includes('organizer') || roles.some((r) => snap.me.roles.includes(r));
    return {
      store, snap, has,
      send: async (cmd: Command) => {
        const r = await store.send(cmd);
        if (!r.ok) toast(r.error ?? 'That did not work');
        return r.ok;
      },
    };
  }, [store, snap]);

  if (store.error && !snap) return <Centered><div className="panel" style={{ maxWidth: 440 }}><h2>Can't open this event</h2><span className="muted">{store.error}</span><Link className="btn" to="/">Back to events</Link></div></Centered>;
  if (!ctx) return <Centered><span className="muted">Connecting to the event…</span></Centered>;

  const visible = (s: Screen) => s.roles === 'all' || ctx.has(...s.roles);
  const firstPath = SCREENS.flatMap((g) => g.items).find(visible)?.path ?? 'lobby';

  return (
    <EventContext.Provider value={ctx}>
      <div className="shell">
        <nav className={`sidenav ${menu ? 'open' : ''}`} aria-label="Screens" onClick={() => setMenu(false)}>
          <Link to="/" className="brand" style={{ color: 'inherit', textDecoration: 'none' }}><Logo />Habitat</Link>
          {SCREENS.map((g) => {
            const items = g.items.filter(visible);
            if (!items.length) return null;
            return (
              <div key={g.group}>
                <div className="group">{g.group}</div>
                {items.map((s) => <NavLink key={s.path} to={s.path} className={({ isActive }) => (isActive ? 'active' : '')}>{s.title}</NavLink>)}
              </div>
            );
          })}
        </nav>
        <div className="content">
          <header className="topbar">
            <button className="btn sm ghost menu-btn" aria-label="Screens" onClick={() => setMenu(!menu)}><Icon d={ICONS.menu} /></button>
            <span style={{ fontWeight: 600 }}>{snap!.state.name}</span>
            <span className="pill">{snap!.state.lifecycle}</span>
            {snap!.state.production.onAir && <span className="pill live">ON AIR</span>}
            <span className="small muted">τ <Tau className="accent" /></span>
            <div className="grow" />
            <span className={`pill ${store.conn === 'live' ? 'ok' : 'warn'}`}><span className="dot" />{store.conn === 'live' ? 'Live' : store.conn === 'connecting' ? 'Connecting' : 'Reconnecting'}</span>
            <span className={`pill ${snap!.me.warp ? 'ok' : 'warn'}`} title="Device trust from Cloudflare One">{snap!.me.warp ? 'WARP' : 'No WARP'}</span>
            <span className="small muted">{snap!.me.name} · {snap!.me.roles.map((r) => ROLE_LABEL[r]).join(', ')}</span>
            <Link to="/" className="btn sm ghost">Events</Link>
          </header>
          <Routes>
            {SCREENS.flatMap((g) => g.items).map((s) => (
              <Route key={s.path} path={s.path} element={visible(s) ? <div className="page">{s.el()}</div> : <NoAccess />} />
            ))}
            <Route path="*" element={<Navigate to={firstPath} replace />} />
          </Routes>
        </div>
      </div>
    </EventContext.Provider>
  );
}

function NoAccess() {
  return <div className="page"><div className="panel" style={{ maxWidth: 480 }}><h2>Not part of your role</h2><span className="muted">Ask the organizer to add this role for you in Team &amp; setup.</span></div></div>;
}
