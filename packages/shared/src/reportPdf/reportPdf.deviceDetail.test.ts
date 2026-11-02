import { describe, expect, it } from 'vitest';
import { buildReportPdf, deviceDetailInfoPairs } from './reportPdf';
import type { DeviceDetailRecord, DeviceDetailSummary } from '../types/deviceDetailReport';

export const sampleDevice = (hostname: string, extra: Partial<DeviceDetailRecord> = {}): DeviceDetailRecord => ({
  deviceId: `id-${hostname}`,
  hostname,
  displayName: null,
  siteName: 'ICOOL Bình Phú',
  status: 'online',
  osType: 'windows',
  osVersion: 'Microsoft Windows 10 Pro 22H2',
  osBuild: '19045.5011',
  architecture: 'amd64',
  agentVersion: '0.110.3',
  lastUser: 'ICOOL\\thungan',
  lastSeenIp: '113.161.10.20',
  isVirtual: false,
  lastSeenAt: '2026-11-02T01:47:00Z',
  enrolledAt: '2026-10-16T12:32:00Z',
  hardware: {
    manufacturer: 'Gigabyte Technology Co., Ltd.',
    model: 'B460M DS3H',
    serialNumber: 'To be filled by O.E.M.',
    cpuModel: 'Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz',
    cpuCores: 6,
    cpuThreads: 12,
    ramTotalMb: 16224,
    diskTotalGb: 1170,
    gpuModel: 'NVIDIA GeForce GTX 1050 Ti',
    motherboardManufacturer: 'Gigabyte Technology Co., Ltd.',
    motherboardProduct: 'B460M DS3H',
    motherboardVersion: 'x.x',
    biosVersion: 'F5',
    memoryModules: [
      { slot: 'DIMM1', capacityMb: 8192, speedMhz: 2666, manufacturer: 'Kingston', partNumber: 'KVR26N19S8/8', serialNumber: '1A2B3C4D' },
      { slot: 'DIMM2', capacityMb: 8192, speedMhz: 3200, manufacturer: 'Samsung', partNumber: 'M378A1K43EB2-CWE', serialNumber: '5E6F7A8B' },
    ],
    physicalDisks: [
      { model: 'KINGSTON SA400S37240G', sizeGb: 240, mediaType: 'SSD', busType: 'SATA', serialNumber: '50026B7782A1B2C3' },
      { model: 'ST1000DM010-2EP102', sizeGb: 1000, mediaType: 'HDD', busType: 'SATA', serialNumber: 'ZN1ABCDE' },
    ],
  },
  volumes: [
    { mountPoint: 'C:', fsType: 'NTFS', totalGb: 222.9, usedGb: 205.1, freeGb: 17.8, usedPercent: 92 },
    { mountPoint: 'D:', fsType: 'NTFS', totalGb: 931.5, usedGb: 410.2, freeGb: 521.3, usedPercent: 44 },
  ],
  network: [
    { interfaceName: 'Ethernet', macAddress: '00:1A:2B:3C:4D:5E', ipAddress: '192.168.1.110', ipType: 'ipv4', isPrimary: true },
  ],
  warranty: null,
  ...extra,
});

const summary = (devices: DeviceDetailRecord[], includeSoftware = false): DeviceDetailSummary => ({
  layout: 'device_detail', includeSoftware, truncated: false, devices,
});
const opts = (s: DeviceDetailSummary) => ({ reportType: 'device_inventory', generatedAt: 'Nov 2, 2026, 10:00 AM', timezone: 'Asia/Ho_Chi_Minh', summary: s });

describe('device detail PDF', () => {
  it('starts every device on its own page and prints RAM / disk serials', () => {
    const doc = buildReportPdf([], opts(summary([sampleDevice('4k-BP-110'), sampleDevice('4k-BP-111')])));
    expect(doc.getNumberOfPages()).toBe(2);
    const text = doc.output();
    expect(text).toContain('Device Detail');
    expect(text).toContain('4k-BP-111');
    expect(text).toContain('M378A1K43EB2-CWE');
    expect(text).toContain('5E6F7A8B');
    expect(text).toContain('50026B7782A1B2C3');
    expect(text).toContain('00:1A:2B:3C:4D:5E');
    expect(text).toContain('ICOOL Binh Phu');
    expect(text).not.toContain('Installed software');
  });

  it('adds the software list only when asked', () => {
    const apps = Array.from({ length: 3 }, (_, i) => ({ name: `App ${i}`, version: '1.0', publisher: 'Vendor', installDate: '2026-10-01' }));
    const text = buildReportPdf([], opts(summary([sampleDevice('PC-1', { software: apps, softwareCount: 3 })], true))).output();
    expect(text).toContain('Installed software - 3');
    expect(text).toContain('App 2');
  });

  it('says what is missing for an older agent instead of printing empty tables', () => {
    const text = buildReportPdf([], opts(summary([sampleDevice('OLD', {
      hardware: { ...sampleDevice('x').hardware!, memoryModules: null, physicalDisks: null },
      volumes: [],
      network: [],
    })]))).output();
    expect(text).toContain('Per-module details not reported');
    expect(text).toContain('No volume data reported.');
  });

  it('builds the info grid', () => {
    const pairs = Object.fromEntries(deviceDetailInfoPairs(sampleDevice('PC'), 'UTC'));
    expect(pairs.CPU).toBe('Intel Core i5-10400 (6 cores / 12 threads)');
    expect(pairs.RAM).toBe('16 GB');
    expect(pairs.Site).toBe('ICOOL Binh Phu');
    expect(pairs['Operating system']).toBe('Windows 10 Pro 22H2');
  });

  it('falls back to the inventory table without a detail summary', () => {
    const text = buildReportPdf([], { reportType: 'device_inventory', generatedAt: 'now', timezone: 'UTC' }).output();
    expect(text).toContain('No data available');
  });
});
