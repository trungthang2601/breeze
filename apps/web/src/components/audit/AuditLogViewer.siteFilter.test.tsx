import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import AuditLogViewer from './AuditLogViewer';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

type TestClaimsState =
  | { status: 'unresolved' }
  | { status: 'resolved'; claims: { scope: 'system' | 'partner' | 'organization' } };

const authState = vi.hoisted(() => ({
  claims: { status: 'unresolved' } as TestClaimsState,
  user: { canManagePartnerWide: true } as { canManagePartnerWide?: boolean },
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: { user: typeof authState.user }) => unknown) => selector({ user: authState.user }),
}));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => authState.claims }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

// Fork: the Site (branch) filter needs the REAL filter panel, so it lives apart
// from AuditLogViewer.test.tsx (which stubs AuditFilters).
describe('AuditLogViewer — site filter', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.mocked(showToast).mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ data: [], pagination: { total: 0, totalPages: 1 } }));
    authState.claims = { status: 'unresolved' };
    authState.user = { canManagePartnerWide: true };
  });

  describe('site (branch) filter', () => {
    const SITE_TT = 'site-thanh-thai';

    beforeEach(() => {
      fetchMock.mockImplementation(async (url: unknown) =>
        String(url).startsWith('/orgs/sites')
          ? jsonResponse({ data: [{ id: SITE_TT, name: 'ICOOL Thành Thái' }], pagination: { total: 1, totalPages: 1 } })
          : jsonResponse({ data: [], pagination: { total: 0, totalPages: 1 } })
      );
    });

    it('lists the org sites and sends siteId after Apply, showing the chosen site', async () => {
      authState.claims = { status: 'resolved', claims: { scope: 'partner' } };
      render(<AuditLogViewer />);

      fireEvent.click(await screen.findByRole('button', { name: /filters/i }));
      const select = await screen.findByRole('combobox', { name: /^site$/i });
      await screen.findByRole('option', { name: 'ICOOL Thành Thái' });
      fireEvent.change(select, { target: { value: SITE_TT } });

      fetchMock.mockClear();
      fireEvent.click(screen.getByRole('button', { name: /apply filters/i }));

      await waitFor(() => {
        const call = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/audit-logs?'));
        expect(call).toBeTruthy();
        expect(String(call![0])).toContain(`siteId=${SITE_TT}`);
        expect(String(call![0])).not.toContain('skipCount');
      });
      expect(await screen.findByText('ICOOL Thành Thái')).toBeTruthy();
    });

    it('hides the site picker in the partner-accounts view', async () => {
      authState.claims = { status: 'resolved', claims: { scope: 'partner' } };
      render(<AuditLogViewer />);
      fireEvent.click(await screen.findByRole('radio', { name: /partner accounts/i }));
      fireEvent.click(await screen.findByRole('button', { name: /filters/i }));
      await screen.findByRole('button', { name: /apply filters/i });
      expect(screen.queryByRole('combobox', { name: /^site$/i })).toBeNull();
    });
  });

});
