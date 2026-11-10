import { describe, expect, it } from 'vitest';
import { WHATS_NEW_ENTRIES } from './whatsNew';
import { WHATS_NEW_TRANSLATIONS, localizeWhatsNew } from './whatsNewTranslations';

describe('whatsNew translations (fork)', () => {
  const latest = WHATS_NEW_ENTRIES[0]!;

  it('has a Vietnamese translation for the latest release', () => {
    // Fails after an upstream merge brings a new release: add its vi entry.
    expect(WHATS_NEW_TRANSLATIONS.vi?.[latest.version]).toBeDefined();
  });

  it('only translates releases that exist, with the same number of highlights', () => {
    for (const [lang, byVersion] of Object.entries(WHATS_NEW_TRANSLATIONS)) {
      for (const [version, tr] of Object.entries(byVersion)) {
        const entry = WHATS_NEW_ENTRIES.find((e) => e.version === version);
        expect(entry, `${lang} ${version}`).toBeDefined();
        expect(tr.highlights).toHaveLength(entry!.highlights.length);
      }
    }
  });

  it('picks the translation for the UI language and falls back to English', () => {
    expect(localizeWhatsNew(latest, 'vi').title).toBe(WHATS_NEW_TRANSLATIONS.vi![latest.version]!.title);
    expect(localizeWhatsNew(latest, 'vi-VN').title).toBe(WHATS_NEW_TRANSLATIONS.vi![latest.version]!.title);
    expect(localizeWhatsNew(latest, 'en')).toBe(latest);
    expect(localizeWhatsNew(latest, 'xx')).toBe(latest);
    expect(localizeWhatsNew(latest, undefined)).toBe(latest);
    // Version, date and link are never changed.
    const vi = localizeWhatsNew(latest, 'vi');
    expect([vi.version, vi.date, vi.learnMoreUrl]).toEqual([latest.version, latest.date, latest.learnMoreUrl]);
  });
});
