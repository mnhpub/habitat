import { useState } from 'react';
import type { Command, SurveyQuestion, SurveyView } from '../../shared/types';
import { toast, useEvent } from '../store';
import { Empty } from '../lib';

type Draft = { prompt: string; kind: SurveyQuestion['kind']; options: string };

/** Surveys: crew build and read them; everyone answers the ones that are open. */
export function Surveys() {
  const { snap, has } = useEvent();
  const surveys = snap.state.surveys;
  const crew = has('producer', 'moderator');
  const open = surveys.filter((s) => s.status === 'open');
  const other = surveys.filter((s) => s.status !== 'open');

  return (
    <div className="cols">
      <div className="main-col stack loose">
        <div className="stack tight">
          <h1>Surveys</h1>
          <span className="muted">Short feedback forms for this event. Anonymous surveys never show who answered.</span>
        </div>
        {crew && <SurveyBuilder />}

        <div className="stack tight">
          <span className="label">Open now · {open.length}</span>
          {open.length ? open.map((s) => <SurveyCard key={s.id} sv={s} />) : <Empty>No survey is open right now.</Empty>}
        </div>
        {other.length > 0 && (
          <div className="stack tight">
            <span className="label">Closed and drafts · {other.length}</span>
            {other.map((s) => <SurveyCard key={s.id} sv={s} />)}
          </div>
        )}
      </div>
    </div>
  );
}

/** Crew only: write a survey, then open it when the room is ready. */
function SurveyBuilder() {
  const { send } = useEvent();
  const [title, setTitle] = useState('');
  const [anonymous, setAnonymous] = useState(true);
  const [questions, setQuestions] = useState<Draft[]>([{ prompt: '', kind: 'rating', options: '' }]);
  const [busy, setBusy] = useState(false);

  const update = (i: number, patch: Partial<Draft>) => setQuestions(questions.map((q, j) => (j === i ? { ...q, ...patch } : q)));

  const create = async () => {
    const built = questions.filter((q) => q.prompt.trim()).map((q) => ({
      prompt: q.prompt.trim(),
      kind: q.kind,
      options: q.kind === 'choice' ? q.options.split(',').map((o) => o.trim()).filter(Boolean) : [],
    }));
    if (!title.trim()) { toast('Give the survey a title'); return; }
    if (!built.length) { toast('Add at least one question'); return; }
    if (built.some((q) => q.kind === 'choice' && (q.options.length < 2 || q.options.length > 6))) {
      toast('Choice questions need 2 to 6 options, separated by commas'); return;
    }
    setBusy(true);
    const ok = await send({ type: 'SURVEY_CREATE', title: title.trim(), anonymous, questions: built } as Command);
    setBusy(false);
    if (ok) {
      toast('Survey saved as a draft. Open it when people should answer.', 'info');
      setTitle(''); setQuestions([{ prompt: '', kind: 'rating', options: '' }]);
    }
  };

  return (
    <div className="panel stack">
      <span className="label">New survey</span>
      <input className="field" placeholder="Survey title, e.g. Day one feedback" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Survey title" />
      <label className="check"><input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />Anonymous: don't record who answered</label>
      {questions.map((q, i) => (
        <div key={i} className="stack tight" style={{ borderTop: i ? '1px solid var(--line-soft)' : undefined, paddingTop: i ? 8 : 0 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input className="field" style={{ flex: '1 1 260px' }} placeholder="Question" maxLength={300} value={q.prompt} onChange={(e) => update(i, { prompt: e.target.value })} aria-label={`Question ${i + 1}`} />
            <select className="field" style={{ flex: '0 0 auto', width: 'auto' }} value={q.kind} onChange={(e) => update(i, { kind: e.target.value as Draft['kind'] })} aria-label="Answer type">
              <option value="rating">Rating 1–5</option>
              <option value="choice">Choose one</option>
              <option value="text">Written answer</option>
            </select>
            <button className="btn sm danger" disabled={questions.length === 1} onClick={() => setQuestions(questions.filter((_, j) => j !== i))}>Remove</button>
          </div>
          {q.kind === 'choice' && <input className="field" placeholder="Options, separated by commas" maxLength={400} value={q.options} onChange={(e) => update(i, { options: e.target.value })} aria-label="Options" />}
        </div>
      ))}
      <div className="row">
        <button className="btn" disabled={questions.length >= 20} onClick={() => setQuestions([...questions, { prompt: '', kind: 'rating', options: '' }])}>Add question</button>
        <button className="btn primary" onClick={create} disabled={busy}>Save draft</button>
      </div>
    </div>
  );
}

function SurveyCard({ sv }: { sv: SurveyView }) {
  const { send, has } = useEvent();
  const crew = has('producer', 'moderator');
  const [answers, setAnswers] = useState<Record<string, number | string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const payload: Record<string, number | string> = {};
    for (const q of sv.questions) {
      const v = answers[q.id];
      if (q.kind === 'text') { if (typeof v === 'string' && v.trim()) payload[q.id] = v.trim(); }
      else if (v !== undefined) payload[q.id] = v;
    }
    const ok = await send({ type: 'SURVEY_RESPOND', surveyId: sv.id, answers: payload });
    setBusy(false);
    if (ok) toast('Thanks, your answers are in', 'info');
  };

  const missing = sv.questions.some((q) => q.kind !== 'text' && answers[q.id] === undefined);

  return (
    <div className="panel stack">
      <div className="row between nowrap-row">
        <div className="stack tight" style={{ gap: 2 }}>
          <b>{sv.title}</b>
          <span className="small muted">{sv.responseCount} answer{sv.responseCount === 1 ? '' : 's'} · {sv.anonymous ? 'anonymous' : 'named'}</span>
        </div>
        <span className={`pill ${sv.status === 'open' ? 'ok' : sv.status === 'closed' ? '' : 'warn'}`}>{sv.status}</span>
      </div>

      {sv.status === 'open' && !sv.answered && (
        <div className="stack">
          {sv.questions.map((q) => (
            <QuestionInput key={q.id} q={q} value={answers[q.id]} onChange={(v) => setAnswers({ ...answers, [q.id]: v })} />
          ))}
          <div className="row"><button className="btn primary" onClick={submit} disabled={busy || missing}>Send answers</button>{missing && <span className="small muted">Answer each rating and choice question.</span>}</div>
        </div>
      )}
      {sv.status === 'open' && sv.answered && <span className="ok small">You have answered this survey.</span>}

      <div className="stack">
        {sv.questions.map((q) => <SummaryFor key={q.id} q={q} sv={sv} />)}
      </div>

      {crew && (
        <div className="stack tight">
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {sv.status !== 'open' && <button className="btn sm" onClick={() => send({ type: 'SURVEY_SET_STATUS', surveyId: sv.id, status: 'open' })}>Open</button>}
            {sv.status === 'open' && <button className="btn sm" onClick={() => send({ type: 'SURVEY_SET_STATUS', surveyId: sv.id, status: 'closed' })}>Close</button>}
            {sv.status === 'closed' && <button className="btn sm ghost" onClick={() => send({ type: 'SURVEY_SET_STATUS', surveyId: sv.id, status: 'draft' })}>Back to draft</button>}
            <button className="btn sm danger" onClick={() => send({ type: 'SURVEY_DELETE', surveyId: sv.id })}>Delete</button>
          </div>
          {sv.responses.length > 0 && (
            <details>
              <summary className="small">Individual answers ({sv.responses.length}){sv.anonymous ? ' · anonymous' : ''}</summary>
              <div className="scroll-x">
                <table className="table">
                  <thead><tr><th>{sv.anonymous ? 'Answer' : 'Who'}</th>{sv.questions.map((q) => <th key={q.id}>{q.prompt}</th>)}</tr></thead>
                  <tbody>
                    {sv.responses.map((r) => (
                      <tr key={r.id}>
                        <td className="small">{r.byName ?? 'Anonymous'}</td>
                        {sv.questions.map((q) => <td key={q.id} className="small">{displayAnswer(q, r.answers[q.id])}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function displayAnswer(q: SurveyQuestion, v: number | string | undefined): string {
  if (v === undefined) return '—';
  if (q.kind === 'choice' && typeof v === 'number') return q.options[v] ?? String(v);
  return String(v);
}

function QuestionInput({ q, value, onChange }: { q: SurveyQuestion; value: number | string | undefined; onChange: (v: number | string) => void }) {
  if (q.kind === 'rating') {
    return (
      <div className="stack tight">
        <span className="small">{q.prompt}</span>
        <div className="row" role="radiogroup" aria-label={q.prompt} style={{ gap: 6 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={value === n} className={`btn sm ${value === n ? 'on' : 'ghost'}`} onClick={() => onChange(n)}>{n}</button>
          ))}
        </div>
      </div>
    );
  }
  if (q.kind === 'choice') {
    return (
      <div className="stack tight">
        <span className="small">{q.prompt}</span>
        <div className="row" role="radiogroup" aria-label={q.prompt} style={{ gap: 6, flexWrap: 'wrap' }}>
          {q.options.map((o, i) => (
            <button key={o} type="button" role="radio" aria-checked={value === i} className={`btn sm ${value === i ? 'on' : 'ghost'}`} onClick={() => onChange(i)}>{o}</button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <label className="fieldlabel">{q.prompt}
      <textarea className="field" rows={2} maxLength={1000} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function SummaryFor({ q, sv }: { q: SurveyQuestion; sv: SurveyView }) {
  const row = sv.summary.find((s) => s.questionId === q.id);
  if (!row) return null;
  const total = sv.responseCount || 1;
  const bars = (labels: string[], counts: number[]) => (
    <div className="stack tight" style={{ gap: 4 }}>
      {labels.map((label, i) => (
        <div key={label} className="row nowrap-row small" style={{ gap: 8 }}>
          <span style={{ flex: '0 0 120px' }}>{label}</span>
          <div style={{ flex: 1, background: 'var(--line-soft)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
            <div style={{ width: `${Math.round((counts[i] / total) * 100)}%`, height: '100%', background: 'var(--accent)' }} />
          </div>
          <span className="muted" style={{ width: 28, textAlign: 'right' }}>{counts[i]}</span>
        </div>
      ))}
    </div>
  );
  return (
    <div className="stack tight">
      <span className="small"><b>{q.prompt}</b></span>
      {q.kind === 'rating' && (row.average !== undefined
        ? <>{bars(['1', '2', '3', '4', '5'], row.counts ?? [0, 0, 0, 0, 0])}<span className="small muted">Average {row.average} of 5</span></>
        : <span className="small muted">No ratings yet.</span>)}
      {q.kind === 'choice' && bars(q.options, row.optionCounts ?? q.options.map(() => 0))}
      {q.kind === 'text' && (row.texts?.length
        ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{row.texts.slice(-20).map((t, i) => <li key={i}>{t}</li>)}</ul>
        : <span className="small muted">No written answers yet.</span>)}
    </div>
  );
}
