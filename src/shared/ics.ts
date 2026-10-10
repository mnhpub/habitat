/** Calendar files (RFC 5545) for event subscriptions. Text is escaped and long lines are folded. */

export interface IcsEvent {
  uid: string;
  title: string;
  start: number;
  durationMin: number;
  location: string;
  url: string;
}

const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Lines longer than 75 octets continue on the next line, prefixed by a space. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let chunk = '';
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (size + n > limit) { parts.push(chunk); chunk = ''; size = 0; }
    chunk += ch;
    size += n;
  }
  parts.push(chunk);
  return parts.join('\r\n ');
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function icsCalendar(name: string, events: IcsEvent[], now: number): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Habitat//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(e.uid)}`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(e.start)}`,
      `DTEND:${stamp(e.start + e.durationMin * 60_000)}`,
      `SUMMARY:${escapeText(e.title)}`,
      `LOCATION:${escapeText(e.location)}`,
      `URL:${escapeText(e.url)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
