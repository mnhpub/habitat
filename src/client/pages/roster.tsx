import { useMemo, useState } from 'react';
import type { Command, Guest } from '../../shared/types';
import { formatCsv, parseCsv } from '../../shared/csv';
import { toast, useEvent } from '../store';
import { Empty } from '../lib';

type Attendance = 'in_person' | 'online' | 'on_demand';
const ATTENDANCE: Record<Attendance, string> = { in_person: 'In person', online: 'Online', on_demand: 'On demand' };

/** Map the attendance words people write in spreadsheets onto the values the server accepts. */
function attendanceOf(value: string): Attendance {
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['in_person', 'in_room', 'onsite', 'on_site', 'room'].includes(v)) return 'in_person';
  if (['on_demand', 'ondemand', 'replay', 'recording'].includes(v)) return 'on_demand';
  return 'online';
}

function statusOf(g: Guest): string {
  if (g.waitlisted) return 'Waitlisted';
  if (g.checkedIn) return 'Checked in';
  return g.mode === 'in_person' ? 'Registered' : 'Registered · not yet in';
}

/** The guest roster: everyone registered for this event, with sign-up answers, waitlist and import/export. */
export function Roster() {
  const { snap, send } = useEvent();
  const s = snap.state;
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'all' | 'registered' | 'waitlisted'>('all');
  const [busy, setBusy] = useState(false);
  const questions = s.signup.questions;

  const shown = useMemo(() => s.guests
    .filter((g) => (view === 'all' || (view === 'waitlisted' ? g.waitlisted : !g.waitlisted)))
    .filter((g) => !query || `${g.name} ${g.email ?? ''}`.toLowerCase().includes(query.toLowerCase())),
  [s.guests, view, query]);

  const registered = s.guests.filter((g) => !g.waitlisted).length;
  const waitlisted = s.guests.filter((g) => g.waitlisted).length;

  const exportRoster = () => {
    const rows = [
      ['Name', 'Email', 'Attendance', 'Status', 'Seat', 'Waitlisted', ...questions.map((q) => q.label)],
      ...s.guests.map((g) => [g.name, g.email ?? '', ATTENDANCE[g.mode as Attendance] ?? g.mode, statusOf(g), g.seat ?? '', g.waitlisted ? 'yes' : 'no', ...questions.map((q) => g.answers?.[q.id] ?? '')]),
    ];
    const url = URL.createObjectURL(new Blob([formatCsv(rows)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${s.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'roster'}-guests.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /** Import a CSV with a header row. Columns: name (required), email, attendance. Sent in batches of 500. */
  const importRoster = async (file: File) => {
    setBusy(true);
    try {
      const [header = [], ...data] = parseCsv(await file.text());
      const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
      const nameCol = col('name');
      if (nameCol < 0) { toast('The first row needs a "name" column'); return; }
      const emailCol = col('email');
      const attendanceCol = Math.max(col('attendance'), col('mode'));
      const rows = data
        .filter((r) => (r[nameCol] ?? '').trim())
        .map((r) => ({
          name: r[nameCol].trim().slice(0, 120),
          email: emailCol >= 0 && r[emailCol]?.trim() ? r[emailCol].trim() : undefined,
          mode: attendanceOf(attendanceCol >= 0 ? r[attendanceCol] ?? '' : ''),
        }));
      if (!rows.length) { toast('No guests found in that file'); return; }
      let imported = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const ok = await send({ type: 'IMPORT_GUESTS', rows: rows.slice(i, i + 500) } as Command);
        if (!ok) return;
        imported += Math.min(500, rows.length - i);
      }
      toast(`Sent ${imported} guest${imported === 1 ? '' : 's'} to the roster. Duplicate emails are skipped.`, 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not read that file');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cols">
      <div className="main-col stack loose">
        <div className="stack tight">
          <h1>Guest roster</h1>
          <span className="muted">Everyone registered for this event, with their sign-up answers. Waitlisted people are approved here when there is room.</span>
        </div>

        <div className="grid" style={{ '--min': '160px' } as React.CSSProperties}>
          <div className="panel stack tight"><span className="label">Registered</span><b style={{ fontSize: 22 }}>{registered}</b><span className="small muted">{s.signup.capacity ? `of ${s.signup.capacity}` : 'no limit'}</span></div>
          <div className="panel stack tight"><span className="label">Waitlisted</span><b style={{ fontSize: 22 }}>{waitlisted}</b><span className="small muted">approve to register</span></div>
          <div className="panel stack tight"><span className="label">Checked in</span><b style={{ fontSize: 22 }}>{s.guests.filter((g) => g.checkedIn).length}</b><span className="small muted">so far</span></div>
        </div>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input className="field" style={{ flex: '1 1 220px' }} placeholder="Search name or email" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the roster" />
          {(['all', 'registered', 'waitlisted'] as const).map((v) => (
            <button key={v} className={`btn sm ${view === v ? 'on' : 'ghost'}`} aria-pressed={view === v} onClick={() => setView(v)}>{v === 'all' ? 'Everyone' : v === 'registered' ? 'Registered' : 'Waitlist'}</button>
          ))}
          <button className="btn sm" onClick={exportRoster}>Export CSV</button>
          <label className={`btn sm ${busy ? 'disabled' : ''}`} style={{ cursor: busy ? 'default' : 'pointer' }}>
            {busy ? 'Importing…' : 'Import CSV'}
            <input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importRoster(f); }} />
          </label>
        </div>
        <span className="small muted">Import takes a CSV with a header row: <b>name</b> (required), <b>email</b>, <b>attendance</b> (in person, online or on demand). Rows with an email already on the roster are skipped.</span>

        <div className="panel">
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Guest</th><th>Attendance</th><th>Status</th>{questions.map((q) => <th key={q.id}>{q.label}</th>)}<th /></tr></thead>
              <tbody>
                {shown.map((g) => (
                  <tr key={g.id}>
                    <td><b>{g.name}</b><div className="small muted">{g.email ?? 'No email'}</div></td>
                    <td className="small">{ATTENDANCE[g.mode as Attendance] ?? g.mode}{g.seat ? <div className="muted">Seat {g.seat}</div> : null}</td>
                    <td><span className={`pill ${g.waitlisted ? 'warn' : g.checkedIn ? 'ok' : ''}`}>{statusOf(g)}</span></td>
                    {questions.map((q) => <td key={q.id} className="small">{g.answers?.[q.id] ?? '—'}</td>)}
                    <td style={{ textAlign: 'right' }}>
                      {g.waitlisted && <button className="btn sm primary" onClick={() => send({ type: 'SET_GUEST_WAITLIST', guestId: g.id, waitlisted: false })}>Approve</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!shown.length && <Empty>{s.guests.length ? 'No guests match.' : 'No guests yet.'}</Empty>}
        </div>
      </div>
    </div>
  );
}
