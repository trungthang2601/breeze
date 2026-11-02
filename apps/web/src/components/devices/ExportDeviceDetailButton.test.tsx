import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
const exportReport = vi.fn();
let allowed = true;
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ can: () => allowed }) }));
vi.mock('../reports/reportExport', () => ({
  exportReport: (...a: unknown[]) => exportReport(...a),
  getBrowserTimezone: () => 'Asia/Ho_Chi_Minh',
}));

import ExportDeviceDetailButton from './ExportDeviceDetailButton';

const summary = { layout: 'device_detail', includeSoftware: true, truncated: false, devices: [{ deviceId: 'dev-1', hostname: 'Order-TK-L1' }] };

describe('ExportDeviceDetailButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowed = true;
  });

  it('is hidden without reports:export', () => {
    allowed = false;
    const { container } = render(<ExportDeviceDetailButton deviceId="dev-1" orgId="org-1" hostname="Order-TK-L1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('generates the detail layout for this one device and downloads it', async () => {
    fetchWithAuth.mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: { rows: [], summary } }) });
    render(<ExportDeviceDetailButton deviceId="dev-1" orgId="org-1" hostname="Order-TK-L1" />);

    fireEvent.click(screen.getByTestId('export-device-detail'));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /download pdf/i }));

    await waitFor(() => expect(exportReport).toHaveBeenCalled());
    const [url, init] = fetchWithAuth.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/reports/generate');
    expect(JSON.parse(init.body)).toEqual({
      type: 'device_inventory',
      format: 'pdf',
      orgId: 'org-1',
      config: { layout: 'detail', includeSoftware: true, filters: { deviceIds: ['dev-1'] } },
    });
    expect(exportReport.mock.calls[0]![1]).toMatchObject({ format: 'pdf', summary, filename: 'device-detail-Order-TK-L1' });
  });

  it('shows an error instead of downloading when the API refuses', async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: 'Forbidden' }) });
    render(<ExportDeviceDetailButton deviceId="dev-1" />);
    fireEvent.click(screen.getByTestId('export-device-detail'));
    fireEvent.click(screen.getByRole('button', { name: /download pdf/i }));
    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
    expect(exportReport).not.toHaveBeenCalled();
  });
});
