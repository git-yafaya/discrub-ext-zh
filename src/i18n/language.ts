/**
 * Language codes Discrub ships a catalog for. English is the source
 * language and the fallback; every other entry is a community-editable
 * catalog in `src/i18n/locales/`.
 */
export const SUPPORTED_LANGUAGES = ['en', 'de', 'zh-CN'] as const;
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: LanguageCode = 'en';

/** Native-script display names for the pickers. */
export const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  en: 'English',
  de: 'Deutsch',
  'zh-CN': '简体中文',
};

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

function normalizeBrowserTag(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-');
}

function isSimplifiedChineseTag(value: string): boolean {
  return (
    value === 'zh' ||
    value === 'zh-hans' ||
    value.startsWith('zh-hans-') ||
    value === 'zh-cn' ||
    value.startsWith('zh-cn-') ||
    value === 'zh-sg' ||
    value.startsWith('zh-sg-')
  );
}

/**
 * Best supported match for the browser's preferred languages
 * (`navigator.languages`, then `navigator.language`). German region
 * subtags resolve to `de`; Simplified Chinese tags such as `zh-CN`,
 * `zh-SG`, and `zh-Hans` resolve to `zh-CN`. Traditional Chinese tags
 * are not redirected to Simplified Chinese. Falls back to English when
 * nothing matches or when there is no navigator (tests).
 */
export function detectBrowserLanguage(
  candidates: readonly string[] | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.languages?.length
      ? navigator.languages
      : navigator.language
        ? [navigator.language]
        : undefined,
): LanguageCode {
  for (const candidate of candidates ?? []) {
    const normalized = normalizeBrowserTag(candidate);

    if (isSimplifiedChineseTag(normalized)) return 'zh-CN';

    const exact = SUPPORTED_LANGUAGES.find((code) => code.toLowerCase() === normalized);
    if (exact) return exact;

    const base = normalized.split('-')[0];
    const baseMatch = SUPPORTED_LANGUAGES.find((code) => code.toLowerCase() === base);
    if (baseMatch) return baseMatch;
  }
  return DEFAULT_LANGUAGE;
}

/** Coerce a stored setting value to a supported code (English when unset or unknown). */
export function normalizeLanguage(value: unknown): LanguageCode {
  if (isLanguageCode(value)) return value;
  if (typeof value === 'string' && normalizeBrowserTag(value) === 'zh-cn') return 'zh-CN';
  return DEFAULT_LANGUAGE;
}
