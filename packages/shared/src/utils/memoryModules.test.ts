import { describe, expect, it } from 'vitest';
import { formatModuleSize, normalizeMemoryModules, summarizeMemoryModules } from './memoryModules';

describe('memoryModules', () => {
  it('summarizes matched pairs with their speed', () => {
    expect(summarizeMemoryModules([
      { slot: 'DIMM1', capacityMb: 8192, speedMhz: 3200, manufacturer: 'Kingston' },
      { slot: 'DIMM2', capacityMb: 8192, speedMhz: 3200, manufacturer: 'Kingston' },
    ])).toBe('2 x 8 GB @ 3200 MHz');
  });

  it('summarizes a single stick', () => {
    expect(summarizeMemoryModules([{ capacityMb: 16384, speedMhz: 3200 }])).toBe('1 x 16 GB @ 3200 MHz');
  });

  it('lists mixed sizes largest first and drops a speed that differs', () => {
    expect(summarizeMemoryModules([
      { capacityMb: 4096, speedMhz: 2400 },
      { capacityMb: 8192, speedMhz: 2666 },
    ])).toBe('1 x 8 GB + 1 x 4 GB');
  });

  it('omits an unknown speed', () => {
    expect(summarizeMemoryModules([{ capacityMb: 8192 }, { capacityMb: 8192, speedMhz: 0 }])).toBe('2 x 8 GB');
  });

  it('returns null when nothing usable was reported', () => {
    expect(summarizeMemoryModules(null)).toBeNull();
    expect(summarizeMemoryModules([])).toBeNull();
    expect(summarizeMemoryModules('2x8')).toBeNull();
    expect(summarizeMemoryModules([{ capacityMb: 0 }, { slot: 'x' }])).toBeNull();
  });

  it('normalizes untrusted jsonb', () => {
    expect(normalizeMemoryModules([{ capacityMb: 8192, slot: ' DIMM1 ', speedMhz: -1, manufacturer: '' }, 'junk', null]))
      .toEqual([{ slot: 'DIMM1', capacityMb: 8192, speedMhz: null, manufacturer: null, partNumber: null }]);
  });

  it('formats sizes', () => {
    expect(formatModuleSize(512)).toBe('512 MB');
    expect(formatModuleSize(8192)).toBe('8 GB');
    expect(formatModuleSize(12288)).toBe('12 GB');
    expect(formatModuleSize(1536)).toBe('1.5 GB');
  });
});
