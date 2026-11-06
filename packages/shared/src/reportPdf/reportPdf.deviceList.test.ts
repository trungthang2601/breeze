import { describe, expect, it } from 'vitest';
import { buildDeviceListPdf } from './reportPdf';

function pdfText(doc: ReturnType<typeof buildDeviceListPdf>): string {
  return doc.output();
}

describe('buildDeviceListPdf', () => {
  it('renders grouped sections with ASCII-folded Vietnamese headings', () => {
    const doc = buildDeviceListPdf({
      title: 'Devices & Assets',
      meta: '3 devices · grouped by Site + CPU',
      columns: ['Device', 'Status', 'CPU'],
      sections: [
        { title: 'ICOOL CẦU CHỮ Y · 3 devices', level: 0, rows: [] },
        { title: 'Intel Core i5 · 2 devices', level: 1, rows: [['CSKH', 'online', 'Intel Core i5-12400'], ['201', 'online', '']] },
        { title: 'Intel Celeron · 1 device', level: 1, rows: [['CCY-THUNGAN', 'offline', 'Intel Celeron G5905']] },
      ],
    }, { generatedAt: 'Nov 6, 2026', timezone: 'Asia/Ho_Chi_Minh' });
    const text = pdfText(doc);
    expect(text).toContain('ICOOL CAU CHU Y');
    expect(text).toContain('CCY-THUNGAN');
    expect(doc.getNumberOfPages()).toBe(1);
  });

  it('says so when nothing matches', () => {
    const doc = buildDeviceListPdf({ title: 'Devices', meta: '', columns: ['Device'], sections: [{ title: null, rows: [] }] },
      { generatedAt: 'now', timezone: 'UTC' });
    expect(pdfText(doc)).toContain('No devices match');
  });
});
