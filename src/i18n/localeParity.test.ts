import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import de from './locales/de.json';
import zhCN from './locales/zh-CN.json';

const flatten = (node: unknown, prefix = ''): string[] => {
  if (node === null || typeof node !== 'object') return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    flatten(value, prefix ? `${prefix}.${key}` : key),
  );
};

const flattenValues = (
  node: unknown,
  prefix = '',
  output = new Map<string, unknown>(),
): Map<string, unknown> => {
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      flattenValues(value, prefix ? `${prefix}.${key}` : key, output);
    }
  } else {
    output.set(prefix, node);
  }
  return output;
};

const placeholders = (value: string): string[] =>
  [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)]
    .map((match) => match[1].trim().replace(/\s+/g, ' '))
    .sort();

const richTags = (value: string): string[] =>
  [...value.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)\b[^>]*>/g)]
    .map((match) => `${match[0].startsWith('</') ? '/' : ''}${match[1]}`)
    .sort();

const edgeWhitespace = (value: string): [number, number] => [
  value.match(/^\s*/u)?.[0].length ?? 0,
  value.match(/\s*$/u)?.[0].length ?? 0,
];

const translatedLocales = { de, 'zh-CN': zhCN } as const;

describe('locale key parity', () => {
  for (const [locale, catalog] of Object.entries(translatedLocales)) {
    it(`${locale}.json carries every key en.json has, and nothing extra`, () => {
      const enKeys = new Set(flatten(en));
      const localeKeys = new Set(flatten(catalog));
      const missing = [...enKeys].filter((key) => !localeKeys.has(key));
      const extra = [...localeKeys].filter((key) => !enKeys.has(key));
      expect(missing).toEqual([]);
      expect(extra).toEqual([]);
    });
  }

  it('zh-CN preserves interpolation variables, rich-text tags, and edge whitespace', () => {
    const enValues = flattenValues(en);
    const zhValues = flattenValues(zhCN);
    const mismatches: string[] = [];

    for (const [key, sourceValue] of enValues) {
      const targetValue = zhValues.get(key);
      if (typeof sourceValue !== 'string' || typeof targetValue !== 'string') continue;

      if (JSON.stringify(placeholders(sourceValue)) !== JSON.stringify(placeholders(targetValue))) {
        mismatches.push(`${key}: placeholders`);
      }
      if (JSON.stringify(richTags(sourceValue)) !== JSON.stringify(richTags(targetValue))) {
        mismatches.push(`${key}: rich tags`);
      }
      if (JSON.stringify(edgeWhitespace(sourceValue)) !== JSON.stringify(edgeWhitespace(targetValue))) {
        mismatches.push(`${key}: edge whitespace`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('carries the attachments-only purge keys (#272)', () => {
    for (const key of [
      'operation.partDeleted',
      'operation.partStripped',
      'operation.partFailed',
      'operation.purgingProgress',
      'status.purge.attachmentsOnlySkipped_one',
      'status.purge.attachmentsOnlySkipped_other',
      'status.purge.failureStreakPaused',
      'filters.hasHelp',
    ]) {
      expect(flatten(en)).toContain(key);
    }
  });
});
