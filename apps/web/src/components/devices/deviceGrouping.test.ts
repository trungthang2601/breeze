import { describe, expect, it } from 'vitest';
import type { Device } from './DeviceList';
import {
  UNKNOWN_VALUE, allGroupIds, applyValueFilters, boardName, bucketCounts, buildGroupedItems,
  cpuFamily, diskSummary, ramBucket,
} from './deviceGrouping';

const dev = (id: string, siteName: string, hw: Device['hardware'], status: Device['status'] = 'online'): Device =>
  ({ id, hostname: id, siteName, status, hardware: hw } as unknown as Device);

const i5 = { cpuModel: '12th Gen Intel(R) Core(TM) i5-12400', ramTotalMb: 16224 };
const i7 = { cpuModel: '13th Gen Intel(R) Core(TM) i7-13700', ramTotalMb: 32600 };
const r5 = { cpuModel: 'AMD Ryzen 5 5600G with Radeon Graphics', ramTotalMb: 15800 };

describe('bucketing', () => {
  it('reduces CPU models to a family', () => {
    expect(cpuFamily('12th Gen Intel(R) Core(TM) i5-12400')).toBe('Intel Core i5');
    expect(cpuFamily('Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz')).toBe('Intel Core i7');
    expect(cpuFamily('Intel(R) Core(TM) Ultra 7 155H')).toBe('Intel Core Ultra 7');
    expect(cpuFamily('AMD Ryzen 5 5600G with Radeon Graphics')).toBe('AMD Ryzen 5');
    expect(cpuFamily('Intel(R) Celeron(R) G5905 CPU @ 3.50GHz')).toBe('Intel Celeron');
    expect(cpuFamily('Intel(R) Xeon(R) E-2224')).toBe('Intel Xeon');
    expect(cpuFamily('')).toBe(UNKNOWN_VALUE);
    expect(cpuFamily(undefined)).toBe(UNKNOWN_VALUE);
  });

  it('snaps RAM to the installed size', () => {
    expect(ramBucket(16224)).toBe('16 GB');
    expect(ramBucket(7900)).toBe('8 GB');
    expect(ramBucket(null)).toBe(UNKNOWN_VALUE);
  });

  it('summarises physical disks, falling back to total size', () => {
    expect(diskSummary([{ sizeGb: 512, mediaType: 'SSD' }, { sizeGb: 1000, mediaType: 'HDD' }])).toBe('SSD 512 GB + HDD 1 TB');
    expect(diskSummary(null, 476.9)).toBe('477 GB');
    expect(diskSummary(undefined)).toBe(UNKNOWN_VALUE);
  });

  it('shortens mainboard vendors', () => {
    expect(boardName('ASUSTeK COMPUTER INC.', 'PRIME H610M-E D4')).toBe('ASUS PRIME H610M-E D4');
    expect(boardName('Gigabyte Technology Co., Ltd.', 'H510M H')).toBe('Gigabyte H510M H');
    expect(boardName('Micro-Star International Co., Ltd.', 'PRO B660M-A DDR4 (MS-7D46)')).toBe('MSI PRO B660M-A DDR4 (MS-7D46)');
    expect(boardName(null, null)).toBe(UNKNOWN_VALUE);
  });
});

describe('grouping', () => {
  const devices = [
    dev('a', 'Site B', i5),
    dev('b', 'Site A', i7),
    dev('c', 'Site A', i5, 'offline'),
    dev('d', 'Site A', i5),
    dev('e', 'Site B', r5),
    dev('f', 'Site A', undefined),
  ];

  it('returns devices untouched when no grouping is chosen', () => {
    const items = buildGroupedItems(devices, { bySite: false, hardware: [] }, new Set());
    expect(items.every((i) => i.type === 'device')).toBe(true);
    expect(items).toHaveLength(6);
  });

  it('groups by site then CPU, sites and families sorted, unknown last', () => {
    const items = buildGroupedItems(devices, { bySite: true, hardware: ['cpu'] }, new Set());
    const shape = items.map((i) => (i.type === 'header' ? `${'  '.repeat(i.header.level)}[${i.header.values.join('/')}] ${i.header.count}` : `    ${i.device.id}`));
    expect(shape).toEqual([
      '[Site A] 4',
      '  [Intel Core i5] 2', '    c', '    d',
      '  [Intel Core i7] 1', '    b',
      `  [${UNKNOWN_VALUE}] 1`, '    f',
      '[Site B] 2',
      '  [AMD Ryzen 5] 1', '    e',
      '  [Intel Core i5] 1', '    a',
    ]);
    const siteA = items[0];
    expect(siteA.type === 'header' && siteA.header).toMatchObject({ online: 3, childGroups: 3 });
  });

  it('combines several hardware dimensions into one group', () => {
    const items = buildGroupedItems(devices, { bySite: false, hardware: ['cpu', 'ram'] }, new Set());
    const headers = items.flatMap((i) => (i.type === 'header' ? [i.header.values.join(' · ')] : []));
    expect(headers).toEqual(['AMD Ryzen 5 · 16 GB', 'Intel Core i5 · 16 GB', 'Intel Core i7 · 32 GB', `${UNKNOWN_VALUE} · ${UNKNOWN_VALUE}`]);
  });

  it('keeps the header but hides the rows of a collapsed group', () => {
    const ids = allGroupIds(devices, { bySite: true, hardware: [] });
    const items = buildGroupedItems(devices, { bySite: true, hardware: [] }, new Set([ids[0]]));
    expect(items.map((i) => (i.type === 'header' ? i.header.values[0] : i.device.id))).toEqual(['Site A', 'Site B', 'a', 'e']);
  });

  it('filters out excluded values and counts buckets', () => {
    expect(applyValueFilters(devices, { cpu: ['Intel Core i5'] }).map((d) => d.id)).toEqual(['b', 'e', 'f']);
    expect(applyValueFilters(devices, { site: ['Site B'], cpu: [UNKNOWN_VALUE] }).map((d) => d.id)).toEqual(['b', 'c', 'd']);
    expect(bucketCounts(devices, 'ram')).toEqual([
      { value: '16 GB', count: 4 }, { value: '32 GB', count: 1 }, { value: UNKNOWN_VALUE, count: 1 },
    ]);
  });
});
