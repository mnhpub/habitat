import { CommandError } from '../shared/command';

/** Enforce the same bounded JSON envelope for HTTP and WebSocket commands. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const reader = req.body?.getReader();
  if (!reader) throw new CommandError('JSON body required');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16_384) { await reader.cancel(); throw new CommandError('Request body too large', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new CommandError('Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommandError('JSON object required');
  return value as Record<string, unknown>;
}
