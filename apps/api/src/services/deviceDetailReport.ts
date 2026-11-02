/**
 * Device Detail report data: everything Breeze knows about each device, one
 * record per device, for the per-device PDF (`device_inventory` run with
 * `config.layout = 'detail'`).
 *
 * The caller (generateDeviceInventoryReport) has already applied the org,
 * site-scope and filter predicates and passes only the device ids it is
 * allowed to show; every query here is additionally pinned to `orgId`.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  DEVICE_DETAIL_MAX_DEVICES,
  DEVICE_DETAIL_MAX_SOFTWARE_PER_DEVICE,
  type DeviceDetailRecord,
  type DeviceDetailSummary,
} from '@breeze/shared';
import { db } from '../db';
import {
  deviceDisks,
  deviceHardware,
  deviceNetwork,
  devices,
  deviceSoftware,
  deviceWarranty,
  sites,
} from '../db/schema';

const CHUNK = 100;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const iso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
};

function groupBy<T extends { deviceId: string | null }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.deviceId) continue;
    const list = map.get(row.deviceId);
    if (list) list.push(row);
    else map.set(row.deviceId, [row]);
  }
  return map;
}

export async function buildDeviceDetailSummary(
  orgId: string,
  deviceIds: string[],
  opts: { includeSoftware: boolean },
): Promise<DeviceDetailSummary> {
  const unique = [...new Set(deviceIds)];
  const truncated = unique.length > DEVICE_DETAIL_MAX_DEVICES;
  const ids = unique.slice(0, DEVICE_DETAIL_MAX_DEVICES);
  if (ids.length === 0) {
    return { layout: 'device_detail', includeSoftware: opts.includeSoftware, truncated: false, devices: [] };
  }

  const base: Array<{
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
    lastSeenAt: Date | null;
    enrolledAt: Date | null;
  }> = [];
  const hardware: Array<typeof deviceHardware.$inferSelect> = [];
  const volumes: Array<{ deviceId: string; mountPoint: string; fsType: string | null; totalGb: number; usedGb: number; freeGb: number; usedPercent: number }> = [];
  const network: Array<{ deviceId: string; interfaceName: string; macAddress: string | null; ipAddress: string | null; ipType: string | null; isPrimary: boolean }> = [];
  const warranty: Array<{ deviceId: string | null; status: string | null; startDate: string | null; endDate: string | null }> = [];
  const software: Array<{ deviceId: string; name: string; version: string | null; publisher: string | null; installDate: string | null }> = [];

  for (const part of chunks(ids)) {
    base.push(...await db
      .select({
        deviceId: devices.id,
        hostname: devices.hostname,
        displayName: devices.displayName,
        siteName: sites.name,
        status: devices.status,
        osType: devices.osType,
        osVersion: devices.osVersion,
        osBuild: devices.osBuild,
        architecture: devices.architecture,
        agentVersion: devices.agentVersion,
        lastUser: devices.lastUser,
        lastSeenIp: devices.lastSeenIp,
        isVirtual: devices.isVirtual,
        lastSeenAt: devices.lastSeenAt,
        enrolledAt: devices.enrolledAt,
      })
      .from(devices)
      .leftJoin(sites, eq(devices.siteId, sites.id))
      .where(and(eq(devices.orgId, orgId), inArray(devices.id, part))));

    hardware.push(...await db
      .select()
      .from(deviceHardware)
      .where(and(eq(deviceHardware.orgId, orgId), inArray(deviceHardware.deviceId, part))));

    volumes.push(...await db
      .select({
        deviceId: deviceDisks.deviceId,
        mountPoint: deviceDisks.mountPoint,
        fsType: deviceDisks.fsType,
        totalGb: deviceDisks.totalGb,
        usedGb: deviceDisks.usedGb,
        freeGb: deviceDisks.freeGb,
        usedPercent: deviceDisks.usedPercent,
      })
      .from(deviceDisks)
      .where(and(eq(deviceDisks.orgId, orgId), inArray(deviceDisks.deviceId, part)))
      .orderBy(asc(deviceDisks.mountPoint)));

    network.push(...await db
      .select({
        deviceId: deviceNetwork.deviceId,
        interfaceName: deviceNetwork.interfaceName,
        macAddress: deviceNetwork.macAddress,
        ipAddress: deviceNetwork.ipAddress,
        ipType: deviceNetwork.ipType,
        isPrimary: deviceNetwork.isPrimary,
      })
      .from(deviceNetwork)
      .where(and(eq(deviceNetwork.orgId, orgId), inArray(deviceNetwork.deviceId, part)))
      .orderBy(asc(deviceNetwork.interfaceName)));

    warranty.push(...await db
      .select({
        deviceId: deviceWarranty.deviceId,
        status: deviceWarranty.status,
        startDate: deviceWarranty.warrantyStartDate,
        endDate: deviceWarranty.warrantyEndDate,
      })
      .from(deviceWarranty)
      .where(and(eq(deviceWarranty.orgId, orgId), inArray(deviceWarranty.deviceId, part))));

    if (opts.includeSoftware) {
      // device_software has no org_id; the device ids are already org- and
      // scope-checked, and the join pins them to this org once more.
      software.push(...await db
        .select({
          deviceId: deviceSoftware.deviceId,
          name: deviceSoftware.name,
          version: deviceSoftware.version,
          publisher: deviceSoftware.publisher,
          installDate: deviceSoftware.installDate,
        })
        .from(deviceSoftware)
        .innerJoin(devices, eq(deviceSoftware.deviceId, devices.id))
        .where(and(
          eq(devices.orgId, orgId),
          inArray(deviceSoftware.deviceId, part),
          eq(deviceSoftware.isSystem, false),
        ))
        .orderBy(asc(deviceSoftware.name)));
    }
  }

  const hwById = new Map(hardware.map((h) => [h.deviceId, h]));
  const volumesById = groupBy(volumes);
  const networkById = groupBy(network);
  const warrantyById = new Map(warranty.filter((w) => w.deviceId).map((w) => [w.deviceId as string, w]));
  const softwareById = groupBy(software);

  const records: DeviceDetailRecord[] = base
    .sort((a, b) => (a.siteName ?? '').localeCompare(b.siteName ?? '') || a.hostname.localeCompare(b.hostname))
    .map((d) => {
      const hw = hwById.get(d.deviceId);
      const w = warrantyById.get(d.deviceId);
      const apps = softwareById.get(d.deviceId) ?? [];
      const record: DeviceDetailRecord = {
        deviceId: d.deviceId,
        hostname: d.hostname,
        displayName: d.displayName,
        siteName: d.siteName,
        status: d.status,
        osType: d.osType,
        osVersion: d.osVersion,
        osBuild: d.osBuild,
        architecture: d.architecture,
        agentVersion: d.agentVersion,
        lastUser: d.lastUser,
        lastSeenIp: d.lastSeenIp,
        isVirtual: d.isVirtual,
        lastSeenAt: iso(d.lastSeenAt),
        enrolledAt: iso(d.enrolledAt),
        hardware: hw
          ? {
            manufacturer: hw.manufacturer,
            model: hw.model,
            serialNumber: hw.serialNumber,
            cpuModel: hw.cpuModel,
            cpuCores: hw.cpuCores,
            cpuThreads: hw.cpuThreads,
            ramTotalMb: hw.ramTotalMb,
            diskTotalGb: hw.diskTotalGb,
            gpuModel: hw.gpuModel,
            motherboardManufacturer: hw.motherboardManufacturer,
            motherboardProduct: hw.motherboardProduct,
            motherboardVersion: hw.motherboardVersion,
            biosVersion: hw.biosVersion,
            memoryModules: hw.memoryModules ?? null,
            physicalDisks: hw.physicalDisks ?? null,
          }
          : null,
        volumes: (volumesById.get(d.deviceId) ?? []).map(({ deviceId: _id, ...v }) => v),
        network: (networkById.get(d.deviceId) ?? []).map(({ deviceId: _id, ...n }) => n),
        warranty: w ? { status: w.status, startDate: w.startDate, endDate: w.endDate } : null,
      };
      if (opts.includeSoftware) {
        record.softwareCount = apps.length;
        record.software = apps
          .slice(0, DEVICE_DETAIL_MAX_SOFTWARE_PER_DEVICE)
          .map(({ deviceId: _id, ...s }) => s);
      }
      return record;
    });

  return { layout: 'device_detail', includeSoftware: opts.includeSoftware, truncated, devices: records };
}
