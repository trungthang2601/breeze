// Fork: remembers the Devices & Assets "Group by" choice per browser.
import { HARDWARE_DIMENSIONS, type GroupingConfig, type HardwareDimension } from './deviceGrouping';

export const GROUPING_STORAGE_KEY = 'breeze.devices.grouping.v1';
export const DEFAULT_GROUPING: GroupingConfig = { bySite: true, hardware: ['cpu'] };

export function parseGroupingPreference(raw: string | null): GroupingConfig {
  if (!raw) return DEFAULT_GROUPING;
  try {
    const v = JSON.parse(raw) as { bySite?: unknown; hardware?: unknown };
    const hardware = Array.isArray(v.hardware)
      ? v.hardware.filter((h): h is HardwareDimension => (HARDWARE_DIMENSIONS as readonly unknown[]).includes(h))
      : [];
    return { bySite: v.bySite === true, hardware: [...new Set(hardware)] };
  } catch {
    return DEFAULT_GROUPING;
  }
}

export function readGroupingPreference(): GroupingConfig {
  try {
    return parseGroupingPreference(window.localStorage.getItem(GROUPING_STORAGE_KEY));
  } catch {
    return DEFAULT_GROUPING;
  }
}

export function writeGroupingPreference(cfg: GroupingConfig): void {
  try {
    window.localStorage.setItem(GROUPING_STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* private mode / quota: the choice just isn't remembered */
  }
}
