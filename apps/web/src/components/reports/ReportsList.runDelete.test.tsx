import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ReportsList from './ReportsList';

const runs = [
  { id: 'run-a', reportId: 'r1', status: 'completed', startedAt: null, completedAt: null, outputUrl: null, errorMessage: null, createdAt: '2026-11-02T00:00:00Z', reportName: 'DS CPU', reportType: 'device_inventory' },
  { id: 'run-b', reportId: 'r1', status: 'failed', startedAt: null, completedAt: null, outputUrl: null, errorMessage: 'x', createdAt: '2026-11-01T00:00:00Z', reportName: 'DS CPU', reportType: 'device_inventory' },
  { id: 'run-c', reportId: 'r1', status: 'running', startedAt: null, completedAt: null, outputUrl: null, errorMessage: null, createdAt: '2026-11-01T00:00:00Z', reportName: 'DS CPU', reportType: 'device_inventory' },
];

function mockApi() {
  fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: runs }) });
    if (init?.method === 'DELETE' || url === '/reports/runs/bulk-delete') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, deleted: [], failed: [] }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [], pagination: {} }) });
  });
}

async function openRunsTab() {
  render(<ReportsList />);
  fireEvent.click(await screen.findByText(/recent runs/i));
  await screen.findAllByText('DS CPU');
}

describe('ReportsList — deleting runs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('deletes one run from its row', async () => {
    await openRunsTab();
    fireEvent.click(screen.getByTestId('delete-run-run-a'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/reports/runs/run-a', { method: 'DELETE' }));
    // A run still generating offers no delete button.
    expect(screen.queryByTestId('delete-run-run-c')).toBeNull();
  });

  it('select-all picks only finished runs and deletes them in one request', async () => {
    await openRunsTab();
    fireEvent.click(screen.getByLabelText('Select all runs'));
    fireEvent.click(screen.getByTestId('delete-selected-runs'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/reports/runs/bulk-delete', expect.objectContaining({ method: 'POST' })));
    const call = fetchWithAuth.mock.calls.find(([url]) => url === '/reports/runs/bulk-delete')!;
    expect(JSON.parse((call[1] as { body: string }).body)).toEqual({ ids: ['run-a', 'run-b'] });
  });

  it('does nothing when the confirm is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openRunsTab();
    fireEvent.click(screen.getByTestId('delete-run-run-a'));
    expect(fetchWithAuth).not.toHaveBeenCalledWith('/reports/runs/run-a', { method: 'DELETE' });
  });
});
