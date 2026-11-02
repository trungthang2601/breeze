/**
 * Internal drives (SSD/HDD/NVMe) as reported by the agent
 * (`device_hardware.physical_disks`, Windows `Win32_DiskDrive` +
 * `MSFT_PhysicalDisk`; USB drives are excluded agent-side). Shared by the
 * device pages, the report builder preview and the report PDF.
 */
export type PhysicalDisk = {
  model?: string | null;
  /** Size in decimal GB, the way drives are sold (500 GB, 1 TB). */
  sizeGb: number;
  /** "SSD", "HDD" or null when Windows does not say. */
  mediaType?: string | null;
  /** "NVMe", "SATA", ... */
  busType?: string | null;
  serialNumber?: string | null;
};

const asText = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/** Coerce an untrusted jsonb value into a clean drive list. */
export function normalizePhysicalDisks(value: unknown): PhysicalDisk[] {
  if (!Array.isArray(value)) return [];
  const out: PhysicalDisk[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const sizeGb = typeof rec.sizeGb === 'number' && Number.isFinite(rec.sizeGb) && rec.sizeGb > 0 ? rec.sizeGb : null;
    if (sizeGb === null) continue;
    out.push({
      model: asText(rec.model),
      sizeGb,
      mediaType: asText(rec.mediaType),
      busType: asText(rec.busType),
      serialNumber: asText(rec.serialNumber),
    });
  }
  return out;
}

/** 500 → "500 GB", 1000 → "1 TB", 2000 → "2 TB", 1500 → "1.5 TB". */
export function formatDiskSize(sizeGb: number): string {
  if (sizeGb < 1000) return `${Math.round(sizeGb)} GB`;
  const tb = Math.round((sizeGb / 1000) * 10) / 10;
  return `${tb} TB`;
}

/**
 * Short line per drive, serial beside it: "SSD 500 GB - SN: S4EWNX0R123456".
 * Used where width is tight (PDF). Empty when the agent sent nothing.
 */
export function physicalDiskLines(value: unknown): string[] {
  return normalizePhysicalDisks(value).map((d) => {
    const head = [d.mediaType, formatDiskSize(d.sizeGb)].filter(Boolean).join(' ');
    return d.serialNumber ? `${head} - SN: ${d.serialNumber}` : head;
  });
}

/**
 * Full line per drive with the model:
 * "Samsung SSD 980 500GB (SSD 500 GB, NVMe) - SN: S4EWNX0R123456".
 */
export function physicalDiskDetailLines(value: unknown): string[] {
  return normalizePhysicalDisks(value).map((d) => {
    const spec = [[d.mediaType, formatDiskSize(d.sizeGb)].filter(Boolean).join(' '), d.busType]
      .filter(Boolean)
      .join(', ');
    const head = d.model ? `${d.model} (${spec})` : spec;
    return d.serialNumber ? `${head} - SN: ${d.serialNumber}` : head;
  });
}
