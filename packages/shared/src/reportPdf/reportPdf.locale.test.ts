import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDeviceListPdf, buildReportPdf, pdfSafeText } from './reportPdf';
import { PDF_TRANSLATIONS, pdfTranslator } from './pdfLabels';
import type { DeviceDetailSummary } from '../types/deviceDetailReport';

// Fork: PDFs follow the UI language and embed a Unicode font for diacritics.

const fontFile = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../apps/web/public/fonts/pdf/${name}`, import.meta.url))).toString('base64');
const font = { regular: fontFile('BeVietnamPro-Regular.ttf'), bold: fontFile('BeVietnamPro-Bold.ttf') };

const listInput = {
  title: 'Thiết bị & Tài sản',
  meta: '1 thiết bị',
  columns: ['Thiết bị', 'Trạng thái'],
  sections: [{ title: 'ICOOL CẦU CHỮ Y', level: 0 as const, rows: [['CCY-01', 'Trực tuyến']] }],
};
const base = { generatedAt: 'Nov 11, 2026', timezone: 'Asia/Ho_Chi_Minh' };

const detail: DeviceDetailSummary = {
  layout: 'device_detail',
  includeSoftware: false,
  truncated: false,
  devices: [{
    id: 'd1', hostname: 'CCY-01', displayName: null, status: 'online', siteName: 'ICOOL CẦU CHỮ Y',
    osType: 'linux', osVersion: 'Debian 13', osBuild: null, architecture: 'amd64', agentVersion: '0.127.0',
    lastSeenAt: '2026-11-11T01:00:00.000Z', enrolledAt: '2026-10-01T01:00:00.000Z', lastUser: null, lastSeenIp: null,
    isVirtual: false, hardware: null, warranty: null, volumes: [], network: [],
  }],
} as unknown as DeviceDetailSummary;

describe('pdfTranslator', () => {
  it('translates known strings, fills placeholders and falls back to English', () => {
    const vi = pdfTranslator('vi');
    expect(vi('Page {page} of {total}', { page: 2, total: 5 })).toBe('Trang 2 / 5');
    expect(pdfTranslator('vi-VN')('Confidential')).toBe('Bảo mật');
    expect(vi('Some new upstream string')).toBe('Some new upstream string');
    expect(pdfTranslator('de-DE')('Confidential')).toBe('Confidential');
    expect(pdfTranslator(null)('Device {index} of {total}', { index: 1, total: '3+' })).toBe('Device 1 of 3+');
  });

  it('keeps every placeholder of the English source in the translation', () => {
    const tokens = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [locale, table] of Object.entries(PDF_TRANSLATIONS)) {
      for (const [english, translated] of Object.entries(table)) {
        expect(tokens(translated), `${locale}: ${english}`).toEqual(tokens(english));
      }
    }
  });
});

describe('PDF language + font', () => {
  it('stays English and ASCII-folded without locale or font (upstream behaviour)', () => {
    const text = buildDeviceListPdf(listInput, base).output();
    expect(text).toContain('ICOOL CAU CHU Y');
    expect(text).toContain('Confidential');
    expect(text).toContain('Page 1 of 1');
    expect(pdfSafeText('CẦU CHỮ Y')).toBe('CAU CHU Y');
  });

  it('translates the page chrome and folds it when the font is unavailable', () => {
    const text = buildDeviceListPdf(listInput, { ...base, locale: 'vi' }).output();
    expect(text).toContain('Bao mat');
    expect(text).toContain('Trang 1 / 1');
    expect(text).not.toContain('Confidential');
  });

  it('embeds the Unicode font and keeps diacritics when a font is supplied', () => {
    const doc = buildDeviceListPdf(listInput, { ...base, locale: 'vi', font });
    expect(Object.keys(doc.getFontList())).toContain('BreezeUnicode');
    expect(doc.getFont().fontName).toBe('BreezeUnicode');
    const text = doc.output();
    // Embedded-font text is glyph-encoded, so neither spelling appears as plain text.
    expect(text).not.toContain('ICOOL CAU CHU Y');
    expect(text).not.toContain('Confidential');
    // Module state is restored for the next build.
    expect(pdfSafeText('CẦU CHỮ Y')).toBe('CAU CHU Y');
    expect(buildDeviceListPdf(listInput, base).output()).toContain('Confidential');
  });

  it('writes the Device Detail report in the UI language', () => {
    const en = buildReportPdf([], { ...base, reportType: 'device_inventory', summary: detail }).output();
    expect(en).toContain('Device information');
    expect(en).toContain('Device 1 of 1');
    const vi = buildReportPdf([], { ...base, reportType: 'device_inventory', summary: detail, locale: 'vi' }).output();
    expect(vi).toContain('Thong tin thiet bi');
    expect(vi).toContain('Thiet bi 1 / 1');
    expect(vi).toContain('truc tuyen');
    expect(vi).not.toContain('Device information');
    expect(() => buildReportPdf([], { ...base, reportType: 'device_inventory', summary: detail, locale: 'vi', font })).not.toThrow();
  });
});
