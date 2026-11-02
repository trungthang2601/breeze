import { describe, expect, it } from 'vitest';
import { formatModuleSize, memoryModuleLines, memoryModuleSerials, normalizeMemoryModules, summarizeMemoryModules } from './memoryModules';

describe('memoryModules', () => {
  it('groups a matched pair with its speed', () => {
    expect(summarizeMemoryModules([
      { slot: 'DIMM1', capacityMb: 8192, speedMhz: 3200, manufacturer: 'Kingston' },
      { slot: 'DIMM2', capacityMb: 8192, speedMhz: 3200, manufacturer: 'Kingston' },
    ])).toBe('2 x 8 GB (3200 MHz)');
  });

  it('summarizes a single stick', () => {
    expect(summarizeMemoryModules([{ capacityMb: 16384, speedMhz: 3200 }])).toBe('1 x 16 GB (3200 MHz)');
  });

  it('keeps sticks of the same size but different bus apart, slower first', () => {
    expect(summarizeMemoryModules([
      { capacityMb: 8192, speedMhz: 3200 },
      { capacityMb: 8192, speedMhz: 2666 },
    ])).toBe('1 x 8 GB (2666 MHz), 1 x 8 GB (3200 MHz)');
  });

  it('lists mixed sizes largest first and omits an unknown speed', () => {
    expect(summarizeMemoryModules([
      { capacityMb: 4096, speedMhz: 0 },
      { capacityMb: 16384, speedMhz: 3200 },
    ])).toBe('1 x 16 GB (3200 MHz), 1 x 4 GB');
    expect(summarizeMemoryModules([{ capacityMb: 8192 }, { capacityMb: 8192, speedMhz: 0 }])).toBe('2 x 8 GB');
  });

  it('returns null when nothing usable was reported', () => {
    expect(summarizeMemoryModules(null)).toBeNull();
    expect(summarizeMemoryModules([])).toBeNull();
    expect(summarizeMemoryModules('2x8')).toBeNull();
    expect(summarizeMemoryModules([{ capacityMb: 0 }, { slot: 'x' }])).toBeNull();
  });

  it('lists module serials in slot order', () => {
    expect(memoryModuleSerials([
      { slot: 'DIMM1', capacityMb: 8192, serialNumber: '1A2B3C4D' },
      { slot: 'DIMM2', capacityMb: 8192, serialNumber: '5E6F7A8B' },
    ])).toBe('DIMM1: 1A2B3C4D, DIMM2: 5E6F7A8B');
    expect(memoryModuleSerials([{ capacityMb: 8192, serialNumber: 'ABC' }, { capacityMb: 8192 }])).toBe('ABC');
    expect(memoryModuleSerials([{ capacityMb: 8192 }])).toBeNull();
    expect(memoryModuleSerials(null)).toBeNull();
  });

  it('writes each serial next to its own stick', () => {
    expect(memoryModuleLines([
      { slot: 'DIMM1', capacityMb: 8192, speedMhz: 2666, serialNumber: '1A2B3C4D' },
      { slot: 'DIMM2', capacityMb: 8192, speedMhz: 3200, serialNumber: '5E6F7A8B' },
      { slot: 'DIMM3', capacityMb: 8192, speedMhz: 3200 },
    ])).toEqual([
      '1 x 8 GB (2666 MHz) - SN: 1A2B3C4D',
      '1 x 8 GB (3200 MHz) - SN: 5E6F7A8B',
      '1 x 8 GB (3200 MHz)',
    ]);
    // No serials at all: grouped like the summary.
    expect(memoryModuleLines([{ capacityMb: 8192, speedMhz: 3200 }, { capacityMb: 8192, speedMhz: 3200 }]))
      .toEqual(['2 x 8 GB (3200 MHz)']);
    expect(memoryModuleLines(null)).toEqual([]);
  });

  it('normalizes untrusted jsonb', () => {
    expect(normalizeMemoryModules([{ capacityMb: 8192, slot: ' DIMM1 ', speedMhz: -1, manufacturer: '' }, 'junk', null]))
      .toEqual([{ slot: 'DIMM1', capacityMb: 8192, speedMhz: null, manufacturer: null, partNumber: null, serialNumber: null }]);
  });

  it('formats sizes', () => {
    expect(formatModuleSize(512)).toBe('512 MB');
    expect(formatModuleSize(8192)).toBe('8 GB');
    expect(formatModuleSize(12288)).toBe('12 GB');
    expect(formatModuleSize(1536)).toBe('1.5 GB');
  });
});
