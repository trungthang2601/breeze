import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import AuditLogViewer from './AuditLogViewer';
import { fetchWithAuth } from '../../stores/auth';

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

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('AuditLogViewer', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ data: [], pagination: { total: 0, totalPages: 1 } }));
    authState.claims = { status: 'unresolved' };
    authState.user = { canManagePartnerWide: true };
  });

  it('injects no orgId override by default — ambient scope handles it, as before', async () => {
    render(<AuditLogViewer />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [, init] = fetchMock.mock.calls[0];
    expect((init as { orgIdOverride?: string })?.orgIdOverride).toBeUndefined();
  });

  it('pins every request to the record org via orgIdOverride when orgId is set, regardless of ambient scope (#5075 W02)', async () => {
    render(<AuditLogViewer orgId="org-record-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    for (const [, init] of fetchMock.mock.calls) {
      expect((init as { orgIdOverride?: string })?.orgIdOverride).toBe('org-record-1');
    }
  });

  it('pins the export request to the same org', async () => {
    render(<AuditLogViewer orgId="org-record-1" />);
    await screen.findByText(/audit log/i);

    const exportButton = screen.getByRole('button', { name: /export/i });
    exportButton.click();

    await waitFor(() => {
      const exportCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/audit-logs/export'));
      expect(exportCall).toBeTruthy();
      expect((exportCall![1] as { orgIdOverride?: string })?.orgIdOverride).toBe('org-record-1');
    });
  });

  describe('partner accounts scope', () => {
    it('offers the partner-accounts view to a partner user with all-org access and requests scope=partner without org injection', async () => {
      authState.claims = { status: 'resolved', claims: { scope: 'partner' } };
      render(<AuditLogViewer />);

      const partnerOption = await screen.findByRole('radio', { name: /partner accounts/i });
      expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('scope=partner'))).toBe(true);

      fetchMock.mockClear();
      fireEvent.click(partnerOption);

      await waitFor(() => {
        const call = fetchMock.mock.calls.find(([url]) => String(url).includes('scope=partner'));
        expect(call).toBeTruthy();
        expect((call![1] as { skipOrgIdInjection?: boolean })?.skipOrgIdInjection).toBe(true);
      });
      expect(await screen.findByText(/belong to no organization/i)).toBeTruthy();
    });

    it('exports partner-account activity with scope=partner', async () => {
      authState.claims = { status: 'resolved', claims: { scope: 'partner' } };
      render(<AuditLogViewer />);
      fireEvent.click(await screen.findByRole('radio', { name: /partner accounts/i }));
      await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('scope=partner'))).toBe(true));

      fireEvent.click(await screen.findByRole('button', { name: /export/i }));
      await waitFor(() => {
        const exportCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/audit-logs/export'));
        expect(String(exportCall?.[0])).toContain('scope=partner');
        expect((exportCall![1] as { skipOrgIdInjection?: boolean })?.skipOrgIdInjection).toBe(true);
      });
    });

    it('hides the toggle for a partner user limited to selected organizations', async () => {
      authState.claims = { status: 'resolved', claims: { scope: 'partner' } };
      authState.user = { canManagePartnerWide: false };
      render(<AuditLogViewer />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(screen.queryByRole('radio', { name: /partner accounts/i })).toBeNull();
    });

    it('hides the toggle for organization users and on an org record Activity tab', async () => {
      authState.claims = { status: 'resolved', claims: { scope: 'organization' } };
      const { unmount } = render(<AuditLogViewer />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(screen.queryByRole('radio', { name: /partner accounts/i })).toBeNull();
      unmount();

      authState.claims = { status: 'resolved', claims: { scope: 'partner' } };
      render(<AuditLogViewer orgId="org-record-1" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(screen.queryByRole('radio', { name: /partner accounts/i })).toBeNull();
    });

    it('shows a clear message and keeps the toggle when the API refuses partner scope', async () => {
      authState.claims = { status: 'resolved', claims: { scope: 'partner' } };
      render(<AuditLogViewer />);
      const partnerOption = await screen.findByRole('radio', { name: /partner accounts/i });

      fetchMock.mockResolvedValue(jsonResponse({ error: 'forbidden' }, false, 403));
      fireEvent.click(partnerOption);

      expect(await screen.findByText(/requires partner access to all organizations/i)).toBeTruthy();
      expect(screen.getByRole('radio', { name: /organization/i })).toBeTruthy();
    });
  });
});
