import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({}),
    { getState: () => ({}) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ReportBuilder from './ReportBuilder';
import { useOrgStore } from '../../stores/orgStore';

describe('ReportBuilder live preview — picked but empty columns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: 'org-1' });
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/reports/generate') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { rows: [
            { hostname: '4k-BP-117', osType: 'windows', osVersion: '11', physicalDisks: null },
            { hostname: '4k-BP-118', osType: 'windows', osVersion: '11', physicalDisks: null },
          ] } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    });
  });

  it('keeps the Disks column and says why it is empty', async () => {
    render(
      <ReportBuilder
        mode="create"
        defaultValues={{ type: 'device_inventory', builderType: 'devices', columns: ['hostname', 'os', 'disks'] }}
      />,
    );
    await waitFor(() => expect(screen.getAllByText('4k-BP-117').length).toBeGreaterThan(0));
    expect(screen.getAllByTestId('preview-empty-columns')[0]).toHaveTextContent('No data yet for: Disks');
  });

  it('merges legacy RAM / disk columns of a saved report into one RAM and one Disks column', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/reports/generate') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { rows: [
            { hostname: 'PC-1', ramTotalMb: 16384, diskTotalGb: 238,
              memoryModules: [{ slot: 'DIMM1', capacityMb: 8192, speedMhz: 3200, serialNumber: 'AA11' }, { slot: 'DIMM2', capacityMb: 8192, speedMhz: 3200, serialNumber: 'BB22' }] },
          ] } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    });
    render(
      <ReportBuilder
        mode="create"
        defaultValues={{ type: 'device_inventory', builderType: 'devices', columns: ['hostname', 'memory', 'ram_modules', 'ram_serials', 'disk_usage'] }}
      />,
    );
    expect((await screen.findAllByText('1 x 8 GB (3200 MHz) - SN: AA11, 1 x 8 GB (3200 MHz) - SN: BB22')).length).toBeGreaterThan(0);
    // Agent without drive details: falls back to the total size.
    expect(screen.getAllByText('238 GB').length).toBeGreaterThan(0);
    expect(screen.queryByText('RAM (MB)')).toBeNull();
  });
});
