/**
 * Fork: group and filter the Devices & Assets list by Site and by hardware
 * (CPU family, installed RAM, physical disks, mainboard). Pure helpers so the
 * list, its export and the tests all bucket a device the same way.
 */
import { formatDiskSize, formatInstalledRam, normalizePhysicalDisks } from '@breeze/shared';
import type { Device } from './DeviceList';

export type HardwareDimension = 'cpu' | 'ram' | 'disk' | 'board';
export type GroupDimension = 'site' | HardwareDimension;
export const HARDWARE_DIMENSIONS: readonly HardwareDimension[] = ['cpu', 'ram', 'disk', 'board'];
export const GROUP_DIMENSIONS: readonly GroupDimension[] = ['site', ...HARDWARE_DIMENSIONS];

/** Sentinel for "the agent did not report this"; the UI renders it localized. */
export const UNKNOWN_VALUE = '\u0000unknown';

/** "12th Gen Intel(R) Core(TM) i5-12400" -> "Intel Core i5". */
export function cpuFamily(model: string | null | undefined): string {
  const m = (model ?? '').replace(/\((?:R|TM|tm|r)\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!m) return UNKNOWN_VALUE;
  let x: RegExpMatchArray | null;
  if ((x = m.match(/Core Ultra ?(\d)/i))) return `Intel Core Ultra ${x[1]}`;
  if ((x = m.match(/Core i([3579])\b/i)) || (x = m.match(/\bi([3579])-\d/i))) return `Intel Core i${x[1]}`;
  if ((x = m.match(/Ryzen (?:Threadripper|AI)?\s*(\d+)/i))) return /Threadripper/i.test(m) ? 'AMD Ryzen Threadripper' : `AMD Ryzen ${x[1]}`;
  if (/Xeon/i.test(m)) return 'Intel Xeon';
  if (/EPYC/i.test(m)) return 'AMD EPYC';
  if (/Celeron/i.test(m)) return 'Intel Celeron';
  if (/Pentium/i.test(m)) return 'Intel Pentium';
  if (/Atom/i.test(m)) return 'Intel Atom';
  if ((x = m.match(/Apple (M\d+)/i))) return `Apple ${x[1].toUpperCase()}`;
  if (/Athlon/i.test(m)) return 'AMD Athlon';
  if (/Core 2/i.test(m)) return 'Intel Core 2';
  // Anything else: the first two words are usually vendor + line.
  return m.split(' ').slice(0, 2).join(' ');
}

/** 16224 MB -> "16 GB" (same rounding the reports use). */
export function ramBucket(totalMb: number | null | undefined): string {
  return formatInstalledRam(totalMb ?? null) ?? UNKNOWN_VALUE;
}

/** Physical disks -> "SSD 512 GB + HDD 1 TB"; falls back to total size. */
export function diskSummary(physicalDisks: unknown, diskTotalGb?: number | null): string {
  const disks = normalizePhysicalDisks(physicalDisks);
  if (disks.length > 0) {
    return disks
      .map((d) => [d.mediaType, formatDiskSize(d.sizeGb)].filter(Boolean).join(' '))
      .join(' + ');
  }
  if (typeof diskTotalGb === 'number' && diskTotalGb > 0) return `${Math.round(diskTotalGb)} GB`;
  return UNKNOWN_VALUE;
}

const BOARD_VENDORS: Array<[RegExp, string]> = [
  [/^ASUSTeK|^ASUS/i, 'ASUS'],
  [/^Gigabyte/i, 'Gigabyte'],
  [/^Micro-Star|^MSI/i, 'MSI'],
  [/^ASRock/i, 'ASRock'],
  [/^Dell/i, 'Dell'],
  [/^(HP|Hewlett)/i, 'HP'],
  [/^LENOVO/i, 'Lenovo'],
  [/^Intel/i, 'Intel'],
  [/^BIOSTAR/i, 'Biostar'],
];

/** "ASUSTeK COMPUTER INC." + "PRIME H610M-E D4" -> "ASUS PRIME H610M-E D4". */
export function boardName(manufacturer: string | null | undefined, product: string | null | undefined): string {
  const man = (manufacturer ?? '').trim();
  const prod = (product ?? '').trim();
  if (!man && !prod) return UNKNOWN_VALUE;
  const short = BOARD_VENDORS.find(([re]) => re.test(man))?.[1] ?? man.replace(/,?\s*(Co\.,?\s*)?(Ltd\.?|Inc\.?|Corporation|Corp\.?)$/i, '').trim();
  if (!prod) return short || UNKNOWN_VALUE;
  return prod.toLowerCase().startsWith(short.toLowerCase()) ? prod : `${short} ${prod}`.trim();
}

/** The bucket a device falls in for one dimension. */
export function dimensionValue(device: Device, dim: GroupDimension): string {
  const hw = device.hardware;
  switch (dim) {
    case 'site': return device.siteName || UNKNOWN_VALUE;
    case 'cpu': return cpuFamily(hw?.cpuModel);
    case 'ram': return ramBucket(hw?.ramTotalMb);
    case 'disk': return diskSummary(hw?.physicalDisks, hw?.diskTotalGb);
    case 'board': return boardName(hw?.motherboardManufacturer, hw?.motherboardProduct);
  }
}

/** Sort key so RAM/disk buckets order by size, everything else by name. */
function bucketSortKey(dim: GroupDimension, value: string): string {
  if (value === UNKNOWN_VALUE) return '￿';
  if (dim === 'ram') {
    const gb = parseFloat(value);
    return Number.isFinite(gb) ? String(Math.round(gb * 10)).padStart(8, '0') : value;
  }
  return value;
}
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function compareBuckets(dim: GroupDimension, a: string, b: string): number {
  return collator.compare(bucketSortKey(dim, a), bucketSortKey(dim, b));
}

/** value -> count, ordered for a filter menu. */
export function bucketCounts(devices: readonly Device[], dim: GroupDimension): Array<{ value: string; count: number }> {
  const m = new Map<string, number>();
  for (const d of devices) {
    const v = dimensionValue(d, dim);
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => compareBuckets(dim, a[0], b[0]))
    .map(([value, count]) => ({ value, count }));
}

export type ExcludedValues = Partial<Record<GroupDimension, readonly string[]>>;

/** Drop devices whose value for any dimension is excluded. */
export function applyValueFilters<T extends Device>(devices: readonly T[], excluded: ExcludedValues): T[] {
  const active = GROUP_DIMENSIONS.filter((d) => (excluded[d]?.length ?? 0) > 0);
  if (active.length === 0) return devices.slice();
  const sets = active.map((d) => [d, new Set(excluded[d])] as const);
  return devices.filter((dev) => sets.every(([d, s]) => !s.has(dimensionValue(dev, d))));
}

export type GroupingConfig = {
  /** Outer level: one group per site. */
  bySite: boolean;
  /** Inner level (or outer when bySite is off): devices sharing ALL of these. */
  hardware: readonly HardwareDimension[];
};

export function isGrouping(cfg: GroupingConfig): boolean {
  return cfg.bySite || cfg.hardware.length > 0;
}

/** Combined hardware key, e.g. "Intel Core i5 · 16 GB". */
export function hardwareKey(device: Device, dims: readonly HardwareDimension[]): string[] {
  return dims.map((d) => dimensionValue(device, d));
}

export type GroupHeader = {
  /** Stable id for collapse state: "site:<name>" / "site:<name>|hw:<a>·<b>". */
  id: string;
  level: 0 | 1;
  kind: 'site' | 'hardware';
  /** Raw bucket values (UNKNOWN_VALUE where unknown). */
  values: string[];
  count: number;
  online: number;
  /** Number of inner groups (outer site header with hardware grouping on). */
  childGroups: number;
};

export type GroupedItem<T extends Device> =
  | { type: 'header'; header: GroupHeader }
  | { type: 'device'; device: T; groupIds: string[] };

/**
 * Re-orders `devices` into groups (keeping their given order inside each
 * group) and returns a flat list of header and device items. Devices of a
 * collapsed group are left out; its header stays.
 */
export function buildGroupedItems<T extends Device>(
  devices: readonly T[],
  cfg: GroupingConfig,
  collapsed: ReadonlySet<string>,
): GroupedItem<T>[] {
  if (!isGrouping(cfg)) return devices.map((device) => ({ type: 'device', device, groupIds: [] }));
  const hwDims = cfg.hardware;
  const SEP = '\u0001';

  type Inner = { values: string[]; devices: T[] };
  type Outer = { values: string[]; devices: T[]; inner: Map<string, Inner> };
  const outers = new Map<string, Outer>();
  for (const d of devices) {
    const outerValues = cfg.bySite ? [dimensionValue(d, 'site')] : hardwareKey(d, hwDims);
    const outerKey = outerValues.join(SEP);
    let o = outers.get(outerKey);
    if (!o) { o = { values: outerValues, devices: [], inner: new Map() }; outers.set(outerKey, o); }
    o.devices.push(d);
    if (cfg.bySite && hwDims.length > 0) {
      const iv = hardwareKey(d, hwDims);
      const ik = iv.join(SEP);
      let i = o.inner.get(ik);
      if (!i) { i = { values: iv, devices: [] }; o.inner.set(ik, i); }
      i.devices.push(d);
    }
  }

  const cmpValues = (dims: readonly GroupDimension[]) => (a: string[], b: string[]) => {
    for (let k = 0; k < dims.length; k++) {
      const c = compareBuckets(dims[k], a[k], b[k]);
      if (c !== 0) return c;
    }
    return 0;
  };
  const outerDims: GroupDimension[] = cfg.bySite ? ['site'] : [...hwDims];
  const online = (ds: readonly T[]) => ds.filter((d) => d.status === 'online').length;

  const items: GroupedItem<T>[] = [];
  const sortedOuters = [...outers.values()].sort((a, b) => cmpValues(outerDims)(a.values, b.values));
  for (const o of sortedOuters) {
    const oid = (cfg.bySite ? 'site:' : 'hw:') + o.values.join(SEP);
    items.push({ type: 'header', header: {
      id: oid, level: 0, kind: cfg.bySite ? 'site' : 'hardware', values: o.values,
      count: o.devices.length, online: online(o.devices), childGroups: o.inner.size,
    } });
    if (collapsed.has(oid)) continue;
    if (o.inner.size === 0) {
      for (const device of o.devices) items.push({ type: 'device', device, groupIds: [oid] });
      continue;
    }
    const inners = [...o.inner.values()].sort((a, b) => cmpValues(hwDims)(a.values, b.values));
    for (const i of inners) {
      const iid = `${oid}|hw:${i.values.join(SEP)}`;
      items.push({ type: 'header', header: {
        id: iid, level: 1, kind: 'hardware', values: i.values,
        count: i.devices.length, online: online(i.devices), childGroups: 0,
      } });
      if (collapsed.has(iid)) continue;
      for (const device of i.devices) items.push({ type: 'device', device, groupIds: [oid, iid] });
    }
  }
  return items;
}

/** Every header id for the current config (for "collapse all"). */
export function allGroupIds<T extends Device>(devices: readonly T[], cfg: GroupingConfig): string[] {
  return buildGroupedItems(devices, cfg, new Set())
    .filter((i): i is { type: 'header'; header: GroupHeader } => i.type === 'header')
    .map((i) => i.header.id);
}
