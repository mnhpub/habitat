import { useState } from 'react';
import type { SignupQuestion } from '../../shared/types';
import { toast, useEvent } from '../store';
import { Empty } from '../lib';

const MODES = [
  { id: 'in_person', label: 'In person' },
  { id: 'online', label: 'Online' },
  { id: 'on_demand', label: 'On demand' },
] as const;

/** Attendees' sign-up form. Shows their status once they have signed up, and lets them update their answers. */
export function SignUp() {
  const { snap, send } = useEvent();
  const form = snap.state.signup;
  const mine = snap.state.guests.find((g) => g.email === snap.me.email);
  const [name, setName] = useState(mine?.name ?? snap.me.name);
  const [mode, setMode] = useState<(typeof MODES)[number]['id']>(mine && mine.mode !== 'watch_party' ? mine.mode as (typeof MODES)[number]['id'] : 'online');
  const [answers, setAnswers] = useState<Record<string, string>>(mine?.answers ?? {});
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const ok = await send({ type: 'SIGNUP', mode, name: name.trim() || undefined, answers });
    setBusy(false);
    if (ok) toast(mine ? 'Your answers are saved' : 'You are signed up', 'info');
  };

  if (!form.open && !mine) {
    return (
      <div className="stack loose" style={{ maxWidth: 560 }}>
        <div className="stack tight"><h1>Sign-up</h1><span className="muted">Sign-up for this event is closed.</span></div>
        <Empty>The organizer will open it again if there is room. Check the event page for updates.</Empty>
      </div>
    );
  }

  const missing = form.questions.some((q) => q.required && !(answers[q.id] ?? '').trim());

  return (
    <div className="stack loose" style={{ maxWidth: 560 }}>
      <div className="stack tight">
        <h1>{mine ? 'Your sign-up' : 'Sign up for this event'}</h1>
        {mine && (
          <span className={`pill ${mine.waitlisted ? 'warn' : 'ok'}`} style={{ alignSelf: 'flex-start' }}>
            {mine.waitlisted ? 'On the waitlist · we will let you know when a place opens' : `Registered · ${MODES.find((m) => m.id === mine.mode)?.label ?? mine.mode}`}
          </span>
        )}
        {!form.open && mine && <span className="small muted">Sign-up is closed to new people. You can still update your answers.</span>}
        {form.capacity !== null && <span className="small muted">Places are limited{form.capacity ? ` · ${form.capacity} in total` : ''}. If the event is full you join the waitlist.</span>}
      </div>

      <div className="panel stack">
        <label className="fieldlabel">Name on your badge
          <input className="field" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="stack tight">
          <span className="label">How will you attend?</span>
          <div className="seg" role="radiogroup" aria-label="How you will attend">
            {MODES.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)}>{m.label}</button>
            ))}
          </div>
        </div>
        {form.questions.map((q) => <QuestionField key={q.id} q={q} value={answers[q.id] ?? ''} onChange={(v) => setAnswers({ ...answers, [q.id]: v })} />)}
        <div className="row">
          <button className="btn primary" onClick={submit} disabled={busy || missing || (!form.open && !mine)}>{mine ? 'Save answers' : 'Sign up'}</button>
          {missing && <span className="small muted">Answer the questions marked required.</span>}
        </div>
      </div>
    </div>
  );
}

function QuestionField({ q, value, onChange }: { q: SignupQuestion; value: string; onChange: (v: string) => void }) {
  return (
    <label className="fieldlabel">{q.label}{q.required ? ' *' : ''}
      <input className="field" value={value} maxLength={1000} onChange={(e) => onChange(e.target.value)} aria-required={q.required} />
    </label>
  );
}

/** Organizers: open or close sign-up, set a capacity, and choose the questions attendees answer. */
export function SignUpSettings() {
  const { snap, send } = useEvent();
  const saved = snap.state.signup;
  const [open, setOpen] = useState(saved.open);
  const [capacity, setCapacity] = useState(saved.capacity === null ? '' : String(saved.capacity));
  const [questions, setQuestions] = useState<SignupQuestion[]>(saved.questions);
  const [busy, setBusy] = useState(false);
  const registered = snap.state.guests.filter((g) => !g.waitlisted).length;
  const waitlisted = snap.state.guests.filter((g) => g.waitlisted).length;

  const update = (i: number, patch: Partial<SignupQuestion>) => setQuestions(questions.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const save = async () => {
    const cap = capacity.trim() === '' ? null : Number(capacity);
    if (cap !== null && (!Number.isInteger(cap) || cap < 1)) { toast('Capacity must be a whole number, or empty for no limit'); return; }
    const cleaned = questions.filter((q) => q.label.trim()).map((q, i) => ({ id: q.id || `q-${Date.now().toString(36)}-${i}`, label: q.label.trim(), required: q.required }));
    setBusy(true);
    const ok = await send({ type: 'SET_SIGNUP_FORM', open, capacity: cap, questions: cleaned });
    setBusy(false);
    if (ok) { setQuestions(cleaned); toast('Sign-up settings saved', 'info'); }
  };

  return (
    <div className="cols">
      <div className="main-col stack loose">
        <div className="stack tight">
          <h1>Sign-up form</h1>
          <span className="muted">Attendees see this form under Audience → Sign up. Answers appear on the guest roster.</span>
        </div>
        <div className="panel stack">
          <label className="check"><input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />Sign-up is open</label>
          <label className="fieldlabel">Capacity
            <input className="field" style={{ maxWidth: 200 }} inputMode="numeric" placeholder="No limit" value={capacity} onChange={(e) => setCapacity(e.target.value.replace(/[^\d]/g, ''))} />
          </label>
          <span className="small muted">{registered} registered{waitlisted ? ` · ${waitlisted} waitlisted` : ''}. New sign-ups join the waitlist once capacity is reached.</span>
        </div>
        <div className="panel stack">
          <span className="label">Questions</span>
          {questions.map((q, i) => (
            <div key={i} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input className="field" style={{ flex: '1 1 260px' }} value={q.label} maxLength={200} placeholder="Question" aria-label={`Question ${i + 1}`} onChange={(e) => update(i, { label: e.target.value })} />
              <label className="check small"><input type="checkbox" checked={q.required} onChange={(e) => update(i, { required: e.target.checked })} />Required</label>
              <button className="btn sm danger" onClick={() => setQuestions(questions.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          {!questions.length && <Empty>No questions. People only give a name and how they attend.</Empty>}
          <div className="row">
            <button className="btn" disabled={questions.length >= 20} onClick={() => setQuestions([...questions, { id: '', label: '', required: false }])}>Add question</button>
            <button className="btn primary" onClick={save} disabled={busy}>Save sign-up</button>
          </div>
        </div>
      </div>
    </div>
  );
}
