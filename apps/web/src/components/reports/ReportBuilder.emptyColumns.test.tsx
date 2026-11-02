import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ReportBuilder from './ReportBuilder';

describe('ReportBuilder live preview — picked but empty columns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(screen.getAllByText(/Disks \(model \+ serial\)/).length).toBeGreaterThan(1);
    expect(screen.getAllByTestId('preview-empty-columns')[0]).toHaveTextContent('No data yet for: Disks (model + serial)');
  });
});
