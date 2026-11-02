import { describe, expect, it } from 'vitest';
import { formatDiskSize, normalizePhysicalDisks, physicalDiskDetailLines, physicalDiskLines } from './physicalDisks';

const disks = [
  { model: 'Samsung SSD 980 500GB', sizeGb: 500, mediaType: 'SSD', busType: 'NVMe', serialNumber: 'S4EWNX0R123456' },
  { model: 'ST1000DM010-2EP102', sizeGb: 1000, mediaType: 'HDD', busType: 'SATA' },
];

describe('physicalDisks', () => {
  it('writes each serial next to its drive', () => {
    expect(physicalDiskLines(disks)).toEqual(['SSD 500 GB - SN: S4EWNX0R123456', 'HDD 1 TB']);
    expect(physicalDiskDetailLines(disks)).toEqual([
      'Samsung SSD 980 500GB (SSD 500 GB, NVMe) - SN: S4EWNX0R123456',
      'ST1000DM010-2EP102 (HDD 1 TB, SATA)',
    ]);
    expect(physicalDiskLines([{ sizeGb: 240, serialNumber: 'X1' }])).toEqual(['240 GB - SN: X1']);
  });

  it('drops junk', () => {
    expect(normalizePhysicalDisks(null)).toEqual([]);
    expect(normalizePhysicalDisks([{ sizeGb: 0 }, 'x', null])).toEqual([]);
    expect(physicalDiskLines(undefined)).toEqual([]);
  });

  it('formats sizes', () => {
    expect(formatDiskSize(256)).toBe('256 GB');
    expect(formatDiskSize(1000)).toBe('1 TB');
    expect(formatDiskSize(2000)).toBe('2 TB');
    expect(formatDiskSize(1500)).toBe('1.5 TB');
  });
});
