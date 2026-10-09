/** Languages viewers can translate chat into. ISO 639-1 codes, as the translation model expects. */
export const LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' }, { code: 'es', name: 'Español' }, { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' }, { code: 'pt', name: 'Português' }, { code: 'it', name: 'Italiano' },
  { code: 'nl', name: 'Nederlands' }, { code: 'sv', name: 'Svenska' }, { code: 'pl', name: 'Polski' },
  { code: 'tr', name: 'Türkçe' }, { code: 'ru', name: 'Русский' }, { code: 'uk', name: 'Українська' },
  { code: 'ar', name: 'العربية' }, { code: 'hi', name: 'हिन्दी' }, { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'vi', name: 'Tiếng Việt' }, { code: 'th', name: 'ไทย' }, { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' }, { code: 'zh', name: '中文' },
];

export const TRANSLATION_MAX_CHARS = 500;

export function isLanguageCode(code: unknown): code is string {
  return typeof code === 'string' && LANGUAGES.some((l) => l.code === code);
}
