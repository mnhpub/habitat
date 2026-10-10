import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, toast } from '../store';
import { Empty } from '../lib';

type Role = 'owner' | 'admin' | 'member';

interface Series {
  id: string; name: string; venue: string; kind: string; durationMin: number; timezone: string; timeOfDay: string;
  freq: 'weekly' | 'monthly'; interval: number; byDay: number[]; dayOfMonth: number | null; startsOn: string; endsOn: string | null;
  maxOccurrences: number; joinOpen: boolean; active: boolean; createdBy: string;
}
interface Session { id: string; name: string; venue: string; startsAt: number; durationMin: number; seriesId: string | null }
interface Member { email: string; role: Role; addedAt: number }
interface Workspace {
  id: string; name: string; role: Role | null; canManage?: boolean; series: Series[]; sessions: Session[]; members?: Member[];
}
interface Subscription { kind: 'org' | 'series'; id: string; name: string; feedUrl: string }
interface Campaign {
  id: string; kind: string; subject: string; body: string; audience: { kind: string; eventId?: string; seriesId?: string };
  status: 'draft' | 'sending' | 'sent'; total: number; sent: number; failed: number; createdAt: number; sentAt: number | null;
}
interface Recording { id: string; eventId: string; title: string; startedBy: string; startedAt: number; status: string; parts: number; bytes: number }
interface MyEvent { id: string; name: string; orgId: string | null; startsAt: number | null }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const when = (ms: number) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

/** A workspace (tenant): its sessions, recurring series, followers, team, email and recordings. */
export function WorkspacePage() {
  const { orgId = '' } = useParams();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [error, setError] = useState('');
  const [subs, setSubs] = useState<Subscription[]>([]);

  const load = () => {
    api<Workspace>(`/api/orgs/${orgId}`).then(setWs).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load this workspace'));
    api<Subscription[]>('/api/subscriptions').then(setSubs).catch(() => setSubs([]));
  };
  useEffect(() => { load(); }, [orgId]);

  if (error) return <Page><div className="banner">{error}</div><Link to="/" className="btn sm">Back to events</Link></Page>;
  if (!ws) return <Page><span className="muted">Loading workspace…</span></Page>;
  const admin = !!ws.canManage;
  const member = !!ws.role;

  return (
    <Page>
      <div className="row between nowrap-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="stack tight" style={{ gap: 2 }}>
          <Link to="/" className="small">← All events</Link>
          <h1>{ws.name}</h1>
          <span className="small muted">{ws.role ? `You are ${ws.role === 'owner' ? 'an owner' : ws.role === 'admin' ? 'an admin' : 'a member'}` : 'You are following this workspace'}</span>
        </div>
      </div>

      <Follow ws={ws} subs={subs} onChange={load} />
      {member && <Recurring ws={ws} onChange={load} />}
      <Sessions ws={ws} />
      {admin && <Campaigns ws={ws} />}
      {admin && <Recordings ws={ws} />}
      {admin && <Team ws={ws} onChange={load} />}
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <div style={{ maxWidth: 960, margin: '0 auto', padding: '28px 20px' }} className="stack loose">{children}</div>;
}

// ---------------------------------------------------------------- following

function Follow({ ws, subs, onChange }: { ws: Workspace; subs: Subscription[]; onChange: () => void }) {
  const followingOrg = subs.find((s) => s.kind === 'org' && s.id === ws.id);
  const toggle = async (kind: 'org' | 'series', id: string, on: boolean) => {
    try {
      await api(`/api/subscriptions/${kind}/${id}`, { method: on ? 'PUT' : 'DELETE' });
      onChange();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not update'); }
  };
  const calendar = followingOrg?.feedUrl;
  return (
    <div className="panel stack">
      <div className="row between nowrap-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="stack tight" style={{ gap: 2 }}>
          <span className="label">Follow</span>
          <span className="small muted">Followers get an email when a new session is scheduled, and a calendar that stays up to date. Only public sessions are shared.</span>
        </div>
        <button className={`btn ${followingOrg ? '' : 'primary'}`} onClick={() => toggle('org', ws.id, !followingOrg)}>{followingOrg ? 'Unfollow workspace' : 'Follow workspace'}</button>
      </div>
      {calendar && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <a className="btn sm" href={calendar.replace(/^https?:/, 'webcal:')}>Add to calendar</a>
          <button className="btn sm ghost" onClick={() => { void navigator.clipboard?.writeText(calendar); toast('Calendar link copied', 'info'); }}>Copy calendar link</button>
        </div>
      )}
      {ws.series.length > 0 && (
        <div className="stack tight">
          <span className="label">Recurring series</span>
          {ws.series.map((s) => {
            const on = subs.some((x) => x.kind === 'series' && x.id === s.id);
            return (
              <div key={s.id} className="row between nowrap-row">
                <span className="small"><b>{s.name}</b> · {describeRule(s)}</span>
                <button className={`btn sm ${on ? '' : 'ghost'}`} aria-pressed={on} onClick={() => toggle('series', s.id, !on)}>{on ? 'Following' : 'Follow series'}</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function describeRule(s: Series): string {
  const every = s.interval > 1 ? `every ${s.interval} ` : 'every ';
  const day = s.freq === 'weekly'
    ? (s.byDay.length ? `${every}${s.interval > 1 ? 'weeks' : 'week'} on ${s.byDay.map((d) => DAYS[d]).join(', ')}` : `${every}week`)
    : `${every}${s.interval > 1 ? 'months' : 'month'} on day ${s.dayOfMonth}`;
  return `${day} at ${s.timeOfDay} (${s.timezone})`;
}

// ---------------------------------------------------------------- recurring sessions

function Recurring({ ws, onChange }: { ws: Workspace; onChange: () => void }) {
  const [name, setName] = useState('');
  const [venue, setVenue] = useState('');
  const [freq, setFreq] = useState<'weekly' | 'monthly'>('weekly');
  const [interval, setInterval] = useState(1);
  const [byDay, setByDay] = useState<number[]>([2]);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [timeOfDay, setTimeOfDay] = useState('18:00');
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [durationMin, setDurationMin] = useState(60);
  const [startsOn, setStartsOn] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [endsOn, setEndsOn] = useState('');
  const [maxOccurrences, setMaxOccurrences] = useState(12);
  const [joinOpen, setJoinOpen] = useState(true);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const res = await api<{ sessions: number }>(`/api/orgs/${ws.id}/series`, {
        method: 'POST',
        json: { name, venue, freq, interval, byDay, dayOfMonth, timeOfDay, timezone, durationMin, startsOn, endsOn: endsOn || null, maxOccurrences, joinOpen },
      });
      toast(`Created ${res.sessions} session${res.sessions === 1 ? '' : 's'}. Followers have been told about each one.`, 'info');
      setName('');
      onChange();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not create the series'); } finally { setBusy(false); }
  };

  const stop = async (id: string) => {
    try { await api(`/api/orgs/${ws.id}/series/${id}`, { method: 'DELETE' }); onChange(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not stop the series'); }
  };

  const toggleDay = (d: number) => setByDay(byDay.includes(d) ? byDay.filter((x) => x !== d) : [...byDay, d].sort());

  return (
    <div className="panel stack">
      <span className="label">Recurring sessions</span>
      <span className="small muted">Sessions are created up to eight weeks ahead. Each one starts its own room with the team of the first session.</span>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input className="field" style={{ flex: '1 1 220px' }} placeholder="Series name, e.g. Monday stand-up" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} aria-label="Series name" />
        <input className="field" style={{ flex: '1 1 180px' }} placeholder="Venue (optional)" maxLength={120} value={venue} onChange={(e) => setVenue(e.target.value)} aria-label="Venue" />
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div className="seg" role="radiogroup" aria-label="Repeat">
          <button type="button" role="radio" aria-checked={freq === 'weekly'} className={freq === 'weekly' ? 'on' : ''} onClick={() => setFreq('weekly')}>Weekly</button>
          <button type="button" role="radio" aria-checked={freq === 'monthly'} className={freq === 'monthly' ? 'on' : ''} onClick={() => setFreq('monthly')}>Monthly</button>
        </div>
        <label className="small">Every <input className="field" style={{ width: 64 }} type="number" min={1} max={12} value={interval} onChange={(e) => setInterval(Number(e.target.value) || 1)} /> {freq === 'weekly' ? 'weeks' : 'months'}</label>
      </div>
      {freq === 'weekly' ? (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Days of the week">
          {DAYS.map((d, i) => (
            <button key={d} type="button" className={`btn sm ${byDay.includes(i) ? 'on' : 'ghost'}`} aria-pressed={byDay.includes(i)} onClick={() => toggleDay(i)}>{d}</button>
          ))}
        </div>
      ) : (
        <label className="small">On day <input className="field" style={{ width: 80 }} type="number" min={1} max={28} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value) || 1)} /> of the month (1 to 28)</label>
      )}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="small">Time <input className="field" type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} /></label>
        <label className="small">Time zone <input className="field" style={{ width: 200 }} value={timezone} onChange={(e) => setTimezone(e.target.value)} /></label>
        <label className="small">Length (minutes) <input className="field" style={{ width: 90 }} type="number" min={15} max={1440} value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value) || 60)} /></label>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="small">First session on <input className="field" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label>
        <label className="small">Last session on <input className="field" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></label>
        <label className="small">Up to <input className="field" style={{ width: 80 }} type="number" min={1} max={104} value={maxOccurrences} onChange={(e) => setMaxOccurrences(Number(e.target.value) || 1)} /> sessions</label>
      </div>
      <label className="check"><input type="checkbox" checked={joinOpen} onChange={(e) => setJoinOpen(e.target.checked)} />Public: anyone signed in can join, and followers see it</label>
      <div className="row"><button className="btn primary" onClick={create} disabled={busy || !name.trim() || (freq === 'weekly' && byDay.length === 0)}>Create series</button></div>

      {ws.series.length > 0 && (
        <div className="stack tight">
          <span className="label">Series</span>
          {ws.series.map((s) => (
            <div key={s.id} className="row between nowrap-row">
              <span className="small"><b>{s.name}</b> · {describeRule(s)}{s.active ? '' : ' · stopped'}</span>
              {s.active && <button className="btn sm danger" onClick={() => stop(s.id)}>Stop series</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- sessions

function Sessions({ ws }: { ws: Workspace }) {
  return (
    <div className="panel stack">
      <span className="label">Upcoming public sessions</span>
      {ws.sessions.length ? (
        <div className="stack tight">
          {ws.sessions.map((s) => (
            <Link key={s.id} to={`/e/${s.id}/lobby`} className="row between nowrap-row" style={{ textDecoration: 'none', color: 'inherit' }}>
              <span className="small"><b>{s.name}</b>{s.venue ? ` · ${s.venue}` : ''}</span>
              <span className="small muted">{when(s.startsAt)} · {s.durationMin} min</span>
            </Link>
          ))}
        </div>
      ) : <Empty>No public sessions are scheduled.</Empty>}
    </div>
  );
}

// ---------------------------------------------------------------- email

function Campaigns({ ws }: { ws: Workspace }) {
  const [list, setList] = useState<Campaign[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState('subscribers');
  const [events, setEvents] = useState<MyEvent[]>([]);
  const [busy, setBusy] = useState(false);

  const load = () => api<Campaign[]>(`/api/orgs/${ws.id}/campaigns`).then(setList).catch(() => setList([]));
  useEffect(() => {
    void load();
    api<MyEvent[]>('/api/events').then((all) => setEvents(all.filter((e) => e.orgId === ws.id))).catch(() => setEvents([]));
  }, [ws.id]);
  // Keep the status current while a send is in progress.
  const sending = list.some((c) => c.status === 'sending');
  useEffect(() => {
    if (!sending) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [sending]);

  const parseAudience = () => {
    if (audience === 'subscribers') return { kind: 'subscribers' };
    const [kind, id] = audience.split(':');
    return kind === 'series' ? { kind: 'series', seriesId: id } : { kind: 'event', eventId: id };
  };

  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/orgs/${ws.id}/campaigns`, { method: 'POST', json: { subject, body, audience: parseAudience() } });
      setSubject(''); setBody('');
      toast('Saved as a draft. Review it, then send.', 'info');
      void load();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not save the draft'); } finally { setBusy(false); }
  };

  const send = async (c: Campaign) => {
    if (!window.confirm(`Send "${c.subject}" to ${c.audience.kind === 'subscribers' ? 'every follower' : 'this audience'}? Sending cannot be undone.`)) return;
    try {
      const res = await api<{ total: number }>(`/api/orgs/${ws.id}/campaigns/${c.id}/send`, { method: 'POST' });
      toast(`Sending to ${res.total} ${res.total === 1 ? 'person' : 'people'}. People who unsubscribed are skipped.`, 'info');
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send');
    }
  };

  return (
    <div className="panel stack">
      <span className="label">Email</span>
      <span className="small muted">Send to followers, or to the registered guests of one session or series. Everyone can unsubscribe with one click, and people who do are never emailed again by this workspace.</span>
      <div className="stack tight">
        <input className="field" placeholder="Subject" maxLength={150} value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
        <textarea className="field" rows={5} placeholder="Write the message. Leave a blank line between paragraphs." maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message" />
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select className="field" style={{ width: 'auto' }} value={audience} onChange={(e) => setAudience(e.target.value)} aria-label="Audience">
            <option value="subscribers">Followers of the workspace</option>
            {ws.series.map((s) => <option key={s.id} value={`series:${s.id}`}>Followers of series: {s.name}</option>)}
            {events.map((e) => <option key={e.id} value={`event:${e.id}`}>Registered for: {e.name}</option>)}
          </select>
          <button className="btn primary" onClick={save} disabled={busy || !subject.trim() || !body.trim()}>Save draft</button>
        </div>
      </div>
      {list.length > 0 && (
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Subject</th><th>Status</th><th>Sent</th><th /></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td><b>{c.subject}</b><div className="small muted">{c.kind === 'notice' ? 'Session notice' : new Date(c.createdAt).toLocaleDateString()}</div></td>
                  <td><span className={`pill ${c.status === 'sent' ? 'ok' : c.status === 'sending' ? 'warn' : ''}`}>{c.status}</span></td>
                  <td className="small">{c.status === 'draft' ? `${c.audience.kind === 'subscribers' ? 'Followers' : 'Selected audience'}` : `${c.sent} sent${c.failed ? ` · ${c.failed} failed` : ''}${c.total - c.sent - c.failed > 0 ? ` · ${c.total - c.sent - c.failed} unsubscribed` : ''}`}</td>
                  <td style={{ textAlign: 'right' }}>{c.status === 'draft' && c.kind === 'campaign' && <button className="btn sm primary" onClick={() => send(c)}>Send</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- recordings

function Recordings({ ws }: { ws: Workspace }) {
  const [list, setList] = useState<Recording[] | null>(null);
  useEffect(() => { api<Recording[]>(`/api/orgs/${ws.id}/recordings`).then(setList).catch(() => setList([])); }, [ws.id]);
  return (
    <div className="panel stack">
      <span className="label">Team recordings</span>
      <span className="small muted">Video room sessions recorded by the team. Recordings are kept until the event is deleted.</span>
      {list === null ? <span className="muted small">Loading…</span> : list.length === 0 ? <Empty>Nothing recorded yet. Start a recording from the video room.</Empty> : (
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Title</th><th>Started</th><th>Status</th><th>Size</th><th /></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.title}</b></td>
                  <td className="small">{when(r.startedAt)}<div className="muted">{r.startedBy}</div></td>
                  <td><span className={`pill ${r.status === 'ready' ? 'ok' : 'warn'}`}>{r.status === 'ready' ? 'Ready' : 'Recording'}</span></td>
                  <td className="small">{r.bytes ? mb(r.bytes) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {r.status === 'ready' && <a className="btn sm" href={`/api/events/${r.eventId}/recordings/${r.id}/media`} download>Download</a>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- team

function Team({ ws, onChange }: { ws: Workspace; onChange: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const isOwner = ws.role === 'owner';
  const members = ws.members ?? [];
  const owners = members.filter((m) => m.role === 'owner').length;

  const save = async (addr: string, r: Role) => {
    try { await api(`/api/orgs/${ws.id}/members`, { method: 'PUT', json: { email: addr, role: r } }); onChange(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not change that role'); }
  };
  const remove = async (addr: string) => {
    try { await api(`/api/orgs/${ws.id}/members/${encodeURIComponent(addr)}`, { method: 'DELETE' }); onChange(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not remove that person'); }
  };

  return (
    <div className="panel stack">
      <span className="label">Team</span>
      <span className="small muted">Owners can do everything, admins manage people, campaigns and recordings, and members can create sessions. Adding someone by email gives them access as soon as they sign in.</span>
      <div className="scroll-x">
        <table className="table">
          <thead><tr><th>Person</th><th>Role</th><th /></tr></thead>
          <tbody>
            {members.map((m) => {
              const locked = m.role === 'owner' && (!isOwner || owners <= 1);
              return (
                <tr key={m.email}>
                  <td className="small">{m.email}</td>
                  <td>
                    <select className="field" style={{ width: 'auto' }} value={m.role} disabled={locked} aria-label={`Role for ${m.email}`} onChange={(e) => save(m.email, e.target.value as Role)}>
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                      {isOwner && <option value="owner">Owner</option>}
                    </select>
                  </td>
                  <td style={{ textAlign: 'right' }}>{!locked && <button className="btn sm danger" onClick={() => remove(m.email)}>Remove</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input className="field" style={{ flex: '1 1 240px' }} placeholder="email (as they sign in)" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email to add" />
        <select className="field" style={{ width: 'auto' }} value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role to give">
          <option value="member">Member</option>
          <option value="admin">Admin</option>
          {isOwner && <option value="owner">Owner</option>}
        </select>
        <button className="btn primary" disabled={!email.includes('@')} onClick={async () => { await save(email.trim().toLowerCase(), role); setEmail(''); }}>Add person</button>
      </div>
      <span className="small muted">Roles inside an event (producer, talent, and so on) are set in that event's Team &amp; setup.</span>
    </div>
  );
}
