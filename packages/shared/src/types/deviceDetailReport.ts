/**
 * Device Detail report: the `device_inventory` report run with
 * `config.layout = 'detail'`. The generator puts one record per agent device in
 * `result.summary`, and the PDF renders one section (starting on a new page)
 * per device. Pure data so the API, the browser export and the scheduled
 * email render the same document from the stored run snapshot.
 */
export type DeviceDetailVolume = {
  mountPoint: string;
  fsType: string | null;
  totalGb: number;
  usedGb: number;
  freeGb: number;
  usedPercent: number;
};

export type DeviceDetailNetwork = {
  interfaceName: string;
  macAddress: string | null;
  ipAddress: string | null;
  ipType: string | null;
  isPrimary: boolean;
};

export type DeviceDetailSoftware = {
  name: string;
  version: string | null;
  publisher: string | null;
  installDate: string | null;
};

export type DeviceDetailHardware = {
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  cpuModel: string | null;
  cpuCores: number | null;
  cpuThreads: number | null;
  ramTotalMb: number | null;
  diskTotalGb: number | null;
  gpuModel: string | null;
  motherboardManufacturer: string | null;
  motherboardProduct: string | null;
  motherboardVersion: string | null;
  biosVersion: string | null;
  /** Raw jsonb, see utils/memoryModules. */
  memoryModules: unknown;
  /** Raw jsonb, see utils/physicalDisks. */
  physicalDisks: unknown;
};

export type DeviceDetailRecord = {
  deviceId: string;
  hostname: string;
  displayName: string | null;
  siteName: string | null;
  status: string | null;
  osType: string | null;
  osVersion: string | null;
  osBuild: string | null;
  architecture: string | null;
  agentVersion: string | null;
  lastUser: string | null;
  lastSeenIp: string | null;
  isVirtual: boolean;
  lastSeenAt: string | null;
  enrolledAt: string | null;
  hardware: DeviceDetailHardware | null;
  volumes: DeviceDetailVolume[];
  network: DeviceDetailNetwork[];
  warranty: { status: string | null; startDate: string | null; endDate: string | null } | null;
  /** Present only when the report was run with includeSoftware. */
  software?: DeviceDetailSoftware[];
  /** Total installed (non-system) apps, even when `software` was capped. */
  softwareCount?: number;
};

export type DeviceDetailSummary = {
  layout: 'device_detail';
  includeSoftware: boolean;
  /** True when the device count hit the cap and some devices were left out. */
  truncated: boolean;
  devices: DeviceDetailRecord[];
};

/** Upper bounds that keep a stored run snapshot (jsonb) a sane size. */
export const DEVICE_DETAIL_MAX_DEVICES = 300;
export const DEVICE_DETAIL_MAX_SOFTWARE_PER_DEVICE = 400;

export function isDeviceDetailSummary(value: unknown): value is DeviceDetailSummary {
  return Boolean(value)
    && typeof value === 'object'
    && (value as { layout?: unknown }).layout === 'device_detail'
    && Array.isArray((value as { devices?: unknown }).devices);
}
