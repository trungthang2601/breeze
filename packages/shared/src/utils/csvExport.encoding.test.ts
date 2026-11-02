import { describe, expect, it } from 'vitest';
import { rowsToCsv, toUtf16LeWithBom, UTF8_BOM, withUtf8Bom } from './csvExport';

describe('Excel-safe encodings', () => {
  it('prefixes CSV with a UTF-8 BOM once', () => {
    const csv = rowsToCsv([{ siteName: 'ICOOL BÌNH PHÚ' }]);
    const withBom = withUtf8Bom(csv);
    expect(withBom.startsWith(UTF8_BOM)).toBe(true);
    expect(withUtf8Bom(withBom)).toBe(withBom);
    expect(Array.from(new TextEncoder().encode(withBom).slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('encodes TSV as UTF-16LE with a BOM that decodes back to the same Vietnamese text', () => {
    const text = 'siteName\tosVersion\nICOOL CÁCH MẠNG THÁNG TÁM\tdebian 13.7\n';
    const bytes = toUtf16LeWithBom(text);
    expect(Array.from(bytes.slice(0, 2))).toEqual([0xff, 0xfe]);
    expect(new TextDecoder('utf-16le').decode(bytes.slice(2))).toBe(text);
    expect(new TextDecoder('utf-16le').decode(toUtf16LeWithBom(UTF8_BOM + 'Đ').slice(2))).toBe('Đ');
  });
});
