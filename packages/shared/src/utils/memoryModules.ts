/**
 * Installed RAM modules (DIMMs) as reported by the agent
 * (`device_hardware.memory_modules`, Windows `Win32_PhysicalMemory`).
 * Shared by the device pages, the report builder preview and the report PDF
 * so all three describe the same machine the same way.
 */
export type MemoryModule = {
  /** Slot label, e.g. "DIMM1" / "ChannelA-DIMM0". */
  slot?: string | null;
  /** Module size in MB. */
  capacityMb: number;
  /** Configured (running) speed in MHz; 0/absent when unknown. */
  speedMhz?: number | null;
  manufacturer?: string | null;
  partNumber?: string | null;
  /** Module serial from SPD; null when the vendor leaves it blank/zeroed. */
  serialNumber?: string | null;
};

const asText = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

const asPositiveNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

/**
 * Coerce an untrusted jsonb value into a clean module list. Anything that is
 * not an array of objects with a positive capacity is dropped, so a malformed
 * row degrades to "unknown" instead of throwing in a renderer.
 */
export function normalizeMemoryModules(value: unknown): MemoryModule[] {
  if (!Array.isArray(value)) return [];
  const out: MemoryModule[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const capacityMb = asPositiveNumber(rec.capacityMb);
    if (capacityMb === null) continue;
    out.push({
      slot: asText(rec.slot),
      capacityMb,
      speedMhz: asPositiveNumber(rec.speedMhz),
      manufacturer: asText(rec.manufacturer),
      partNumber: asText(rec.partNumber),
      serialNumber: asText(rec.serialNumber),
    });
  }
  return out;
}

/** 8192 → "8 GB", 512 → "512 MB", 12288 → "12 GB". */
export function formatModuleSize(capacityMb: number): string {
  if (capacityMb < 1024) return `${Math.round(capacityMb)} MB`;
  const gb = capacityMb / 1024;
  return `${Number.isInteger(gb) ? gb : Math.round(gb * 10) / 10} GB`;
}

/**
 * One-line summary, one group per (size, speed):
 *   "2 x 8 GB (3200 MHz)"                     matched pair
 *   "1 x 8 GB (2666 MHz), 1 x 8 GB (3200 MHz)" same size, different bus
 *   "1 x 16 GB (3200 MHz), 1 x 8 GB"           mixed, one speed unknown
 * Largest modules first, then slower first. Returns null when there is
 * nothing to describe (older agents, non-Windows hosts, WMI failure).
 */
export function summarizeMemoryModules(value: unknown): string | null {
  const modules = normalizeMemoryModules(value);
  if (modules.length === 0) return null;

  const groups = new Map<string, { capacityMb: number; speed: number; count: number }>();
  for (const m of modules) {
    const speed = m.speedMhz ?? 0;
    const key = `${m.capacityMb}:${speed}`;
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, { capacityMb: m.capacityMb, speed, count: 1 });
  }
  return [...groups.values()]
    .sort((a, b) => b.capacityMb - a.capacityMb || a.speed - b.speed)
    .map((g) => `${g.count} x ${formatModuleSize(g.capacityMb)}${g.speed > 0 ? ` (${g.speed} MHz)` : ''}`)
    .join(', ');
}

/**
 * RAM described line by line, the serial written right next to its stick:
 *   ["1 x 8 GB (2666 MHz) - SN: 1A2B3C4D", "1 x 8 GB (3200 MHz) - SN: 5E6F7A8B"]
 * When no stick reported a serial the matching sticks are grouped instead
 * ("2 x 8 GB (3200 MHz)"), same as summarizeMemoryModules. Empty when the
 * agent sent nothing.
 */
export function memoryModuleLines(value: unknown): string[] {
  const modules = normalizeMemoryModules(value);
  if (modules.length === 0) return [];
  if (!modules.some((m) => m.serialNumber)) {
    return (summarizeMemoryModules(modules) ?? '').split(', ').filter(Boolean);
  }
  return modules.map((m) => {
    const speed = m.speedMhz ? ` (${m.speedMhz} MHz)` : '';
    const sn = m.serialNumber ? ` - SN: ${m.serialNumber}` : '';
    return `1 x ${formatModuleSize(m.capacityMb)}${speed}${sn}`;
  });
}

/**
 * Module serials in slot order, "DIMM1: 1A2B3C4D, DIMM2: 5E6F7A8B" (slot
 * label omitted when unknown). Null when no module reported a serial.
 */
export function memoryModuleSerials(value: unknown): string | null {
  const parts = normalizeMemoryModules(value)
    .filter((m) => m.serialNumber)
    .map((m) => (m.slot ? `${m.slot}: ${m.serialNumber}` : `${m.serialNumber}`));
  return parts.length ? parts.join(', ') : null;
}
