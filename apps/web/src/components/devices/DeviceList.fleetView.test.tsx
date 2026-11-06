import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';
import { useCustomFieldDefinitionsStore } from '../../stores/customFieldDefinitions';
import { fetchWithAuth } from '../../stores/auth';
import { downloadBlob } from '../../lib/downloadBlob';
import { GROUPING_STORAGE_KEY } from './deviceGroupingPreference';

// Fork: the fleet Devices & Assets page groups by Site / hardware, filters by
// value, scrolls instead of paging, and exports Excel / CSV (UTF-8 BOM) / PDF.

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
  hasPermission: () => true,
}));
vi.mock('../../lib/downloadBlob', () => ({ downloadBlob: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const downloadMock = vi.mocked(downloadBlob);

const i5 = '12th Gen Intel(R) Core(TM) i5-12400';
const i7 = '13th Gen Intel(R) Core(TM) i7-13700';

function device(n: number, siteName: string, cpuModel: string, ramTotalMb = 16224): Device {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    id, deviceClass: 'agent', hostname: `host-${String(n).padStart(3, '0')}`, os: 'windows', osVersion: '11',
    status: 'online', cpuPercent: 1, ramPercent: 1, lastSeen: '2026-10-01T12:00:00.000Z',
    orgId: 'org-1', orgName: 'Acme', siteId: siteName, siteName, agentVersion: '0.125.2', tags: [],
    hardware: { cpuModel, ramTotalMb },
  };
}

const fleet = [
  device(1, 'ICOOL CẦU CHỮ Y', i5),
  device(2, 'ICOOL CẦU CHỮ Y', i7, 32768),
  device(3, 'ICOOL ĐẠI LỘ 2', i5),
];

beforeEach(() => {
  vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true, status: 200, json: async () => ({ counts: {} }) } as unknown as Response);
  downloadMock.mockReset();
  writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS]);
  useCustomFieldDefinitionsStore.setState({ definitions: [], status: 'idle' });
});
afterEach(() => window.localStorage.clear());

const headerTexts = () => screen.getAllByTestId('device-group-header').map((h) => h.textContent ?? '');

describe('DeviceList fleet view', () => {
  it('groups by Site then CPU by default', () => {
    render(<DeviceList devices={fleet} fleetView />);
    const headers = headerTexts();
    expect(headers).toHaveLength(5);
    expect(headers[0]).toContain('ICOOL CẦU CHỮ Y');
    expect(headers[1]).toContain('Intel Core i5');
    expect(headers[2]).toContain('Intel Core i7');
    expect(headers[3]).toContain('ICOOL ĐẠI LỘ 2');
    expect(screen.queryByTestId('device-list-pagination')).toBeNull();
  });

  it('collapses a group and remembers the grouping choice', () => {
    render(<DeviceList devices={fleet} fleetView />);
    fireEvent.click(within(screen.getAllByTestId('device-group-header')[0]!).getByRole('button'));
    expect(screen.queryByText('host-001')).toBeNull();
    expect(screen.getByText('host-003')).toBeTruthy();

    fireEvent.click(screen.getByTestId('device-grouping-chip-cpu'));
    fireEvent.click(screen.getByTestId('device-grouping-toggle-cpu'));
    expect(JSON.parse(window.localStorage.getItem(GROUPING_STORAGE_KEY)!)).toEqual({ bySite: true, hardware: [] });
    expect(headerTexts()).toHaveLength(2);
  });

  it('hides devices whose value is unticked', () => {
    render(<DeviceList devices={fleet} fleetView />);
    fireEvent.click(screen.getByTestId('device-grouping-chip-cpu'));
    const menu = screen.getByTestId('device-grouping-menu-cpu');
    fireEvent.click(within(menu).getByText('Intel Core i5').closest('label')!.querySelector('input')!);
    expect(screen.queryByText('host-001')).toBeNull();
    expect(screen.queryByText('host-003')).toBeNull();
    expect(screen.getByText('host-002')).toBeTruthy();
  });

  it('exports CSV with a UTF-8 BOM and the grouping columns', async () => {
    render(<DeviceList devices={fleet} fleetView />);
    fireEvent.click(screen.getByTestId('device-list-export-menu'));
    fireEvent.click(screen.getByTestId('device-list-export-csv'));
    await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(1));
    const bytes = new Uint8Array(await (downloadMock.mock.calls[0]![0] as Blob).arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes.slice(3));
    const [header, first] = text.split('\n');
    expect(header!.startsWith('"Device","Site","CPU"')).toBe(true);
    expect(first).toContain('"ICOOL CẦU CHỮ Y","Intel Core i5"');
  });

  it('exports an Excel workbook', async () => {
    render(<DeviceList devices={fleet} fleetView />);
    fireEvent.click(screen.getByTestId('device-list-export-menu'));
    fireEvent.click(screen.getByTestId('device-list-export-xlsx'));
    await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(1));
    expect(downloadMock.mock.calls[0]![1]).toMatch(/\.xlsx$/);
    const bytes = new Uint8Array(await (downloadMock.mock.calls[0]![0] as Blob).arrayBuffer());
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('PK');
  });
});
