import type { Env } from './env';

/** Workers AI many-to-many translation model. */
const MODEL = '@cf/meta/m2m100-1.2b';

/** Translate one message with Workers AI. Throws if the model returns no text. */
export async function translateText(env: Env, text: string, target: string, source?: string): Promise<string> {
  const result = await env.AI.run(MODEL, {
    text,
    target_lang: target,
    source_lang: source ?? 'en',
  }) as { translated_text?: string };
  if (typeof result?.translated_text !== 'string' || !result.translated_text.trim()) {
    throw new Error('Translation model returned no text');
  }
  return result.translated_text;
}
