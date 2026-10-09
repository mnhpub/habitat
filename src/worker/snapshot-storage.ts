import type { EventState } from '../shared/types';
import { CommandError } from '../shared/command';

// SQLite rows are limited to 2 MB. These chunks stay under 512 KiB even for UTF-8 text.
const CHUNK_CHARACTERS = 128 * 1024;
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export function snapshotChunks(state: EventState, maxBytes = MAX_SNAPSHOT_BYTES): string[] {
  const json = JSON.stringify(state);
  if (new TextEncoder().encode(json).byteLength > maxBytes) {
    throw new CommandError('This event has reached its state capacity', 409);
  }
  const chunks: string[] = [];
  let offset = 0;
  while (offset < json.length) {
    let end = Math.min(offset + CHUNK_CHARACTERS, json.length);
    // A surrogate pair must stay together when SQLite converts the string to UTF-8.
    if (end < json.length && json.charCodeAt(end - 1) >= 0xd800 && json.charCodeAt(end - 1) <= 0xdbff) end--;
    chunks.push(json.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export function writeSnapshot(sql: SqlStorage, chunks: string[]): void {
  sql.exec('DELETE FROM snapshot_chunks');
  chunks.forEach((json, part) => sql.exec('INSERT INTO snapshot_chunks (part, json) VALUES (?, ?)', part, json));
}
