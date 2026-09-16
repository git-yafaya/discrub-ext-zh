import { describe, expect, it } from 'vitest';
import { detectBrowserLanguage, isLanguageCode, normalizeLanguage } from './language';

describe('language helpers (#124)', () => {
  it('detects a supported base language from region-qualified tags', () => {
    expect(detectBrowserLanguage(['de-AT', 'en-US'])).toBe('de');
    expect(detectBrowserLanguage(['de_CH'])).toBe('de');
    expect(detectBrowserLanguage(['DE'])).toBe('de');
  });

  it('detects Simplified Chinese browser tags', () => {
    expect(detectBrowserLanguage(['zh-CN'])).toBe('zh-CN');
    expect(detectBrowserLanguage(['zh_CN'])).toBe('zh-CN');
    expect(detectBrowserLanguage(['zh-Hans'])).toBe('zh-CN');
    expect(detectBrowserLanguage(['zh-Hans-CN'])).toBe('zh-CN');
    expect(detectBrowserLanguage(['zh-SG'])).toBe('zh-CN');
    expect(detectBrowserLanguage(['zh-CN-u-ca-chinese'])).toBe('zh-CN');
    expect(detectBrowserLanguage(['zh'])).toBe('zh-CN');
  });

  it('does not redirect Traditional Chinese tags to Simplified Chinese', () => {
    expect(detectBrowserLanguage(['zh-TW', 'en-US'])).toBe('en');
    expect(detectBrowserLanguage(['zh-HK', 'de-DE'])).toBe('de');
    expect(detectBrowserLanguage(['zh-Hant'])).toBe('en');
  });

  it('takes the first supported entry, not the first entry', () => {
    expect(detectBrowserLanguage(['fr-FR', 'de-DE', 'en'])).toBe('de');
    expect(detectBrowserLanguage(['ja-JP', 'zh-CN', 'de-DE'])).toBe('zh-CN');
  });

  it('falls back to English when nothing is supported or nothing is known', () => {
    expect(detectBrowserLanguage(['fr-FR', 'ja'])).toBe('en');
    expect(detectBrowserLanguage([])).toBe('en');
    expect(detectBrowserLanguage(undefined)).toBe('en');
  });

  it('normalizes stored values to a supported code', () => {
    expect(normalizeLanguage('de')).toBe('de');
    expect(normalizeLanguage('zh-CN')).toBe('zh-CN');
    expect(normalizeLanguage('zh-cn')).toBe('zh-CN');
    expect(normalizeLanguage('zh_CN')).toBe('zh-CN');
    expect(normalizeLanguage('')).toBe('en');
    expect(normalizeLanguage('xx')).toBe('en');
    expect(normalizeLanguage(undefined)).toBe('en');
    expect(isLanguageCode('en')).toBe(true);
    expect(isLanguageCode('zh-CN')).toBe(true);
    expect(isLanguageCode('zh-cn')).toBe(false);
    expect(isLanguageCode('pt')).toBe(false);
  });
});
