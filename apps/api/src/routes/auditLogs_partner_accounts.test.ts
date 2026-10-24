/**
 * Partner-level account activity (?scope=partner).
 *
 * Sign-ins, invites, MFA and user-admin events of partner users are written
 * with org_id = NULL, so the org-scoped Audit Trail list never shows them
 * (RLS breeze_has_org_access rejects a NULL org for non-system callers).
 *
 * GIVEN a partner-scope caller
 *  WHEN they call GET /audit-logs?scope=partner
 *  THEN org_access 'all' gets rows filtered to NULL org + their partner's users,
 *       read under a system DB context
 *   AND org_access 'selected' / organization scope get 403 without touching the DB
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const PARTNER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_A = '11111111-1111-1111-1111-111111111111';

vi.mock('../services', () => ({}));
vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  writeRouteAudit: vi.fn(),
}));

// Every WHERE clause the route hands to drizzle, in call order.
const whereCalls: unknown[] = [];

const createDbChain = () => ({
  from: vi.fn().mockReturnValue({
    leftJoin: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn((w: unknown) => {
          whereCalls.push(w);
          return {
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([]),
              }),
            }),
          };
        }),
      }),
    }),
    where: vi.fn((w: unknown) => {
      whereCalls.push(w);
      return Promise.resolve([{ count: 0 }]);
    }),
  }),
});

const withSystemDbAccessContextMock = vi.fn(async (fn: any) => fn());
const runOutsideDbContextMock = vi.fn((fn: any) => fn());

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => createDbChain()),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(async () => []),
  },
  withDbAccessContext: vi.fn(async (_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: withSystemDbAccessContextMock,
  runOutsideDbContext: runOutsideDbContextMock,
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, accessibleOrgIds: null },
}));

vi.mock('../db/schema', () => ({
  auditLogs: {
    orgId: 'orgId', actorId: 'actorId', resourceId: 'resourceId', timestamp: 'timestamp',
    id: 'id', action: 'action', actorEmail: 'actorEmail', actorType: 'actorType',
    details: 'details', resourceType: 'resourceType', resourceName: 'resourceName',
  },
  users: { id: 'id', name: 'name' },
  devices: { agentId: 'agentId', hostname: 'hostname', displayName: 'displayName', siteId: 'siteId' },
}));

type TestAuth = {
  scope: 'system' | 'partner' | 'organization';
  partnerId: string | null;
  partnerOrgAccess: 'all' | 'selected' | 'none' | null;
};
let authState: TestAuth = { scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'all' };

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'partner-user-1', email: 'admin@example.com', name: 'Partner Admin' },
      orgId: null,
      accessibleOrgIds: [ORG_A],
      canAccessOrg: (id: string) => id === ORG_A,
      orgCondition: () => undefined,
      ...authState,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

describe('audit-logs partner account activity (scope=partner)', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    whereCalls.length = 0;
    authState = { scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'all' };
    const { auditLogRoutes } = await import('./auditLogs');
    app = new Hono();
    app.route('/audit-logs', auditLogRoutes);
  });

  it('partner admin with all-org access reads NULL-org rows of their own partner users under a system context', async () => {
    const res = await app.request('/audit-logs?scope=partner&page=1&limit=25');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toEqual([]);
    expect(body.pagination.total).toBe(0);

    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);

    // count + rows queries both carry the partner boundary.
    expect(whereCalls).toHaveLength(2);
    for (const where of whereCalls) {
      const serialized = JSON.stringify(where);
      expect(serialized).toContain(PARTNER_ID);
      expect(serialized).toContain('partner_users');
    }
  });

  it('ignores the auto-injected orgId when scope=partner', async () => {
    const res = await app.request(`/audit-logs?scope=partner&skipCount=true&orgId=${ORG_A}`);
    expect(res.status).toBe(200);
    expect(whereCalls).toHaveLength(1);
    const serialized = JSON.stringify(whereCalls[0]);
    expect(serialized).toContain(PARTNER_ID);
    expect(serialized).not.toContain(ORG_A);
  });

  it('rejects a partner member with selected-org access', async () => {
    authState = { scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'selected' };
    const res = await app.request('/audit-logs?scope=partner');
    expect(res.status).toBe(403);
    expect(whereCalls).toHaveLength(0);
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
  });

  it('rejects an organization-scope caller', async () => {
    authState = { scope: 'organization', partnerId: null, partnerOrgAccess: null };
    const res = await app.request('/audit-logs/logs?scope=partner');
    expect(res.status).toBe(403);
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
  });

  it('applies the partner boundary to /search as well', async () => {
    const res = await app.request('/audit-logs/search?scope=partner&q=login');
    expect(res.status).toBe(200);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    for (const where of whereCalls) {
      expect(JSON.stringify(where)).toContain(PARTNER_ID);
    }
  });

  it('rejects /search with scope=partner for a selected-org member', async () => {
    authState = { scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'selected' };
    const res = await app.request('/audit-logs/search?scope=partner&q=login');
    expect(res.status).toBe(403);
    expect(whereCalls).toHaveLength(0);
  });

  it('default (no scope) keeps the org-scoped path and never opens a system context', async () => {
    const res = await app.request('/audit-logs?page=1&limit=25');
    expect(res.status).toBe(200);
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
    for (const where of whereCalls) {
      expect(JSON.stringify(where ?? null)).not.toContain('partner_users');
    }
  });
});

describe('resolvePartnerAccountsAccess', () => {
  it('grants system scope every NULL-org row', async () => {
    const { resolvePartnerAccountsAccess } = await import('./auditLogs');
    expect(resolvePartnerAccountsAccess({ scope: 'system', partnerId: null })).toEqual({ ok: true, partnerId: null });
  });

  it('requires partner org_access all', async () => {
    const { resolvePartnerAccountsAccess } = await import('./auditLogs');
    expect(resolvePartnerAccountsAccess({ scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'all' }))
      .toEqual({ ok: true, partnerId: PARTNER_ID });
    expect(resolvePartnerAccountsAccess({ scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'selected' }))
      .toEqual({ ok: false });
    expect(resolvePartnerAccountsAccess({ scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: null }))
      .toEqual({ ok: false });
    expect(resolvePartnerAccountsAccess({ scope: 'partner', partnerId: null, partnerOrgAccess: 'all' }))
      .toEqual({ ok: false });
    expect(resolvePartnerAccountsAccess({ scope: 'organization', partnerId: null, partnerOrgAccess: null }))
      .toEqual({ ok: false });
  });
});
