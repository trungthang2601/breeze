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
 * One-line summary: "2 x 8 GB @ 3200 MHz", "1 x 16 GB",
 * "1 x 8 GB + 1 x 4 GB @ 2666 MHz". Largest modules first; the speed is shown
 * only when every module reports the same one. Returns null when there is
 * nothing to describe (older agents, non-Windows hosts, WMI failure).
 */
export function summarizeMemoryModules(value: unknown): string | null {
  const modules = normalizeMemoryModules(value);
  if (modules.length === 0) return null;

  const counts = new Map<number, number>();
  for (const m of modules) counts.set(m.capacityMb, (counts.get(m.capacityMb) ?? 0) + 1);
  const sizes = [...counts.entries()]
    .sort(([a], [b]) => b - a)
    .map(([capacityMb, count]) => `${count} x ${formatModuleSize(capacityMb)}`)
    .join(' + ');

  const speeds = new Set(modules.map((m) => m.speedMhz ?? 0));
  const speed = speeds.size === 1 ? [...speeds][0]! : 0;
  return speed > 0 ? `${sizes} @ ${speed} MHz` : sizes;
}
