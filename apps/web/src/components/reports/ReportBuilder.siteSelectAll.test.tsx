import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ReportBuilder from './ReportBuilder';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const sites = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'ICOOL Dong Den' },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'ICOOL To Ky' },
];

describe('ReportBuilder — select all sites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: 'org-1' } as never);
    vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).startsWith('/orgs/sites') ? { data: sites } : { data: { rows: [] } }),
    }) as unknown as Response);
  });

  it('ticks and clears every site at once', async () => {
    render(<ReportBuilder mode="builder" defaultValues={{ type: 'device_inventory', dataSource: { scope: 'by_site', layout: 'table' } }} />);

    const all = await screen.findByTestId('select-all-sites');
    fireEvent.click(all);
    for (const site of sites) {
      expect((screen.getByLabelText(site.name) as HTMLInputElement).checked).toBe(true);
    }
    expect(screen.getByText(/đã chọn 2\/2/)).toBeInTheDocument();

    fireEvent.click(all);
    await waitFor(() => {
      for (const site of sites) expect((screen.getByLabelText(site.name) as HTMLInputElement).checked).toBe(false);
    });
  });
});
