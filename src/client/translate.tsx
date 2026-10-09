import { useEffect, useState } from 'react';
import { LANGUAGES, TRANSLATION_MAX_CHARS } from '../shared/languages';
import { api, useEvent } from './store';

const KEY = 'habitat.translateTo';

/** The language this viewer reads chat in. Stored per browser; '' means show the original only. */
export function useTranslateTo(): [string, (code: string) => void] {
  const [code, setCode] = useState(() => {
    try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
  });
  const set = (next: string) => {
    setCode(next);
    try { localStorage.setItem(KEY, next); } catch { /* private window: keep it in memory only */ }
  };
  return [code, set];
}

export function LanguagePicker({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  return (
    <label className="row small muted" style={{ gap: 6 }}>
      Read chat in
      <select className="field" style={{ width: 'auto', minHeight: 32, padding: '4px 8px' }} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Original only</option>
        {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
      </select>
    </label>
  );
}

// Translations are per viewer and per language, so they are cached in memory for this page only.
const cache = new Map<string, Promise<string>>();

function translate(eventId: string, text: string, target: string): Promise<string> {
  const key = `${target}|${text}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = api<{ text: string }>(`/api/events/${eventId}/translate`, { method: 'POST', json: { text, target } }).then((r) => r.text);
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
  }
  return hit;
}

/** A chat message. When a reading language is chosen, its translation appears under the original. */
export function ChatText({ text, target }: { text: string; target: string }) {
  const { snap } = useEvent();
  const [translated, setTranslated] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setTranslated(null);
    setFailed(false);
    if (!target || text.length > TRANSLATION_MAX_CHARS) return;
    translate(snap.state.id, text, target)
      .then((t) => { if (live) setTranslated(t); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [snap.state.id, text, target]);
  return (
    <div style={{ color: 'var(--text-2)' }}>
      {text}
      {target && translated && <div className="small accent" style={{ marginTop: 2 }}>{translated}</div>}
      {target && failed && <div className="small muted">Translation unavailable</div>}
    </div>
  );
}
