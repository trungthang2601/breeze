import { describe, expect, it } from 'vitest';
import {
  buildReportPdf,
  groupDeviceInventoryBySite,
  pdfSafeText,
  shortCpuLabel,
  shortOsLabel,
} from './reportPdf';

const row = (hostname: string, siteName: string | null, status = 'offline') => ({
  deviceId: `id-${hostname}`,
  hostname,
  osType: 'windows',
  osVersion: 'Microsoft Windows 11 Pro 24H2',
  status,
  lastSeenAt: '2026-10-31T03:47:00Z',
  enrolledAt: '2026-10-16T12:32:00Z',
  cpuModel: '12th Gen Intel(R) Core(TM) i7-12700KF',
  ramTotalMb: 16224,
  diskTotalGb: 464,
  serialNumber: `SN-${hostname}`,
  siteName,
});

describe('device inventory PDF helpers', () => {
  it('folds Vietnamese diacritics and dashes for the built-in font', () => {
    expect(pdfSafeText('ICOOL Xô Viết Nghệ Tĩnh')).toBe('ICOOL Xo Viet Nghe Tinh');
    expect(pdfSafeText('Đồng Đen')).toBe('Dong Den');
    expect(pdfSafeText('Trần Não – Cầu Sài Gòn')).toBe('Tran Nao - Cau Sai Gon');
  });

  it('shortens OS and CPU labels', () => {
    expect(shortOsLabel('windows', 'Microsoft Windows 11 Pro 24H2')).toBe('Windows 11 Pro 24H2');
    expect(shortOsLabel('linux', null)).toBe('Linux');
    expect(shortOsLabel(null, null)).toBe('—');
    expect(shortCpuLabel('12th Gen Intel(R) Core(TM) i7-12700KF')).toBe('Intel Core i7-12700KF');
    expect(shortCpuLabel('Intel(R) Core(TM) i3-10100 CPU @ 3.60GHz')).toBe('Intel Core i3-10100');
    expect(shortCpuLabel(undefined)).toBe('—');
  });

  it('groups by site A→Z, hostnames A→Z, devices with no site last', () => {
    const groups = groupDeviceInventoryBySite([
      row('B-2', 'ICOOL Tô Ký', 'online'),
      row('Spare', null),
      row('A-1', 'ICOOL Đồng Đen'),
      row('B-1', 'ICOOL Tô Ký'),
    ]);
    expect(groups).toHaveLength(3);
    expect(new Set(groups.slice(0, 2).map((g) => g.site))).toEqual(new Set(['ICOOL Tô Ký', 'ICOOL Đồng Đen']));
    const toKy = groups.find((g) => g.site === 'ICOOL Tô Ký')!;
    expect(toKy.rows.map((r) => r.hostname)).toEqual(['B-1', 'B-2']);
    expect(toKy.online).toBe(1);
    expect(groups.at(-1)!.site).toBe('No site');
  });
});

describe('device inventory PDF', () => {
  const opts = { reportType: 'device_inventory', generatedAt: 'Oct 31, 2026, 12:02 PM', timezone: 'Asia/Ho_Chi_Minh' };

  it('renders a per-site overview and site sections with curated columns, not the raw field dump', () => {
    const rows = [
      row('Order-TK-L1', 'ICOOL Tô Ký', 'online'),
      row('ThuNgan-TK', 'ICOOL Tô Ký'),
      row('Order-XVNT-L1', 'ICOOL Xô Viết Nghệ Tĩnh'),
    ];
    const text = buildReportPdf(rows, opts).output();
    expect(text).toContain('Devices per site');
    expect(text).toContain('ICOOL To Ky');
    expect(text).toContain('ICOOL Xo Viet Nghe Tinh');
    expect(text).toContain('Intel Core i7-12700KF');
    expect(text).toContain('Windows 11 Pro 24H2');
    // Raw internals the generic table used to print.
    expect(text).not.toContain('id-Order-TK-L1');
    expect(text).not.toContain('Enrolled At');
  });

  it('is far shorter than the generic table for a large inventory', () => {
    const rows = Array.from({ length: 276 }, (_, i) => row(`PC-${i}`, `Site ${i % 7}`));
    const pages = buildReportPdf(rows, opts).getNumberOfPages();
    expect(pages).toBeLessThanOrEqual(16);
  });

  it('still renders an empty inventory', () => {
    const text = buildReportPdf([], opts).output();
    expect(text).toContain('No data available for the selected filters.');
  });
});

describe('device inventory GPU and RAM columns', () => {
  it('keeps the em dash placeholder and shortens GPU names', async () => {
    const { shortGpuLabel, ramLabel } = await import('./reportPdf');
    expect(pdfSafeText('—')).toBe('—');
    expect(shortGpuLabel('Intel(R) UHD Graphics 770; NVIDIA GeForce RTX 3050')).toBe('Intel UHD Graphics 770, NVIDIA GeForce RTX 3050');
    expect(shortGpuLabel(null)).toBe('—');
    expect(ramLabel([{ capacityMb: 8192, speedMhz: 3200 }, { capacityMb: 8192, speedMhz: 3200 }], 16224)).toBe('2 x 8 GB (3200 MHz)');
    expect(ramLabel([
      { slot: 'DIMM1', capacityMb: 8192, speedMhz: 2666, serialNumber: '1A2B3C4D' },
      { slot: 'DIMM2', capacityMb: 8192, speedMhz: 3200, serialNumber: '5E6F7A8B' },
    ], 16224)).toBe('1 x 8 GB (2666 MHz) - SN: 1A2B3C4D\n1 x 8 GB (3200 MHz) - SN: 5E6F7A8B');
    expect(pdfSafeText('a\nb')).toBe('a\nb');
    expect(ramLabel(null, 16224)).toBe('16 GB');
    expect(ramLabel(undefined, null)).toBe('—');
  });

  it('prints GPU and RAM stick summary in the site tables', () => {
    const text = buildReportPdf([
      { ...row('4k-BP-117', 'ICOOL Binh Phu'), gpuModel: 'NVIDIA GeForce RTX 3050', memoryModules: [{ capacityMb: 8192, speedMhz: 3200 }, { capacityMb: 8192, speedMhz: 3200 }] },
    ], { reportType: 'device_inventory', generatedAt: 'now', timezone: 'UTC' }).output();
    expect(text).toContain('NVIDIA GeForce RTX 3050');
    // The RAM cell may wrap inside its column, so check the stick count part.
    expect(text).toContain('2 x 8 GB');
    expect(text).toContain('GPU');
  });
});

describe('device inventory disk column', () => {
  it('lists each drive with its serial, else the total', async () => {
    const { diskLabel, cpuGpuLabel } = await import('./reportPdf');
    expect(diskLabel([
      { model: 'Samsung SSD 980 500GB', sizeGb: 500, mediaType: 'SSD', serialNumber: 'S4EWNX0R123456' },
      { model: 'ST1000DM010', sizeGb: 1000, mediaType: 'HDD', serialNumber: 'ZN1ABCDE' },
    ], 1465)).toBe('SSD 500 GB - SN: S4EWNX0R123456\nHDD 1 TB - SN: ZN1ABCDE');
    expect(diskLabel(null, 238)).toBe('238 GB');
    expect(diskLabel(null, null)).toBe('—');
    expect(cpuGpuLabel('Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz', 'NVIDIA GeForce GTX 1050 Ti'))
      .toBe('Intel Core i5-10400\nNVIDIA GeForce GTX 1050 Ti');
    expect(cpuGpuLabel('Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz', null)).toBe('Intel Core i5-10400');
  });
});
