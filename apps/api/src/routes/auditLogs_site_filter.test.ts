/**
 * Site (branch) filter (?siteId=) and the User filter count query.
 *
 * GIVEN a caller on the Audit Trail
 *  WHEN they pick a site
 *  THEN count + rows carry the device-in-site predicate (resource, details,
 *       agent arms) and the dashboard fast path is skipped
 *   AND a site-restricted caller asking for a site outside their allowlist gets 403
 *   AND scope=partner ignores siteId
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const PARTNER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_A = '11111111-1111-1111-1111-111111111111';
const SITE_TT = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SITE_OTHER = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

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

const executeMock = vi.fn(async () => [] as unknown[]);
const withSystemDbAccessContextMock = vi.fn(async (fn: any) => fn());
const runOutsideDbContextMock = vi.fn((fn: any) => fn());

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => createDbChain()),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: executeMock,
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
  allowedSiteIds?: string[];
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
      canAccessSite: (siteId: string) => !authState.allowedSiteIds || authState.allowedSiteIds.includes(siteId),
      ...authState,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

describe('audit-logs site filter', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    whereCalls.length = 0;
    authState = { scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'all' };
    executeMock.mockClear();
    const { auditLogRoutes } = await import('./auditLogs');
    app = new Hono();
    app.route('/audit-logs', auditLogRoutes);
  });

  it('applies the device-in-site predicate to both the count and the rows query', async () => {
    const res = await app.request(`/audit-logs?page=1&limit=25&orgId=${ORG_A}&siteId=${SITE_TT}`);
    expect(res.status).toBe(200);
    expect(whereCalls).toHaveLength(2);
    for (const where of whereCalls) {
      const serialized = JSON.stringify(where);
      expect(serialized).toContain(SITE_TT);
      expect(serialized).toContain('FROM devices d WHERE d.site_id');
      expect(serialized).toContain('rawActorId');
      expect(serialized).toContain('deviceId');
    }
  });

  it('skips the LATERAL fast path when a site is selected', async () => {
    const res = await app.request(`/audit-logs/logs?limit=5&skipCount=true&orgId=${ORG_A}&siteId=${SITE_TT}`);
    expect(res.status).toBe(200);
    expect(executeMock).not.toHaveBeenCalled();
    expect(whereCalls).toHaveLength(1);
    expect(JSON.stringify(whereCalls[0])).toContain(SITE_TT);
  });

  it('rejects a site outside a site-restricted caller allowlist', async () => {
    authState = { scope: 'organization', partnerId: null, partnerOrgAccess: null, allowedSiteIds: [SITE_OTHER] };
    const res = await app.request(`/audit-logs?siteId=${SITE_TT}`);
    expect(res.status).toBe(403);
    expect(whereCalls).toHaveLength(0);

    const search = await app.request(`/audit-logs/search?q=x&siteId=${SITE_TT}`);
    expect(search.status).toBe(403);
  });

  it('allows a site inside the allowlist', async () => {
    authState = { scope: 'organization', partnerId: null, partnerOrgAccess: null, allowedSiteIds: [SITE_TT] };
    const res = await app.request(`/audit-logs?siteId=${SITE_TT}`);
    expect(res.status).toBe(200);
  });

  it('applies the site predicate to /search and pins the selected org', async () => {
    const res = await app.request(`/audit-logs/search?q=script&orgId=${ORG_A}&siteId=${SITE_TT}`);
    expect(res.status).toBe(200);
    for (const where of whereCalls) {
      const serialized = JSON.stringify(where);
      expect(serialized).toContain(SITE_TT);
      expect(serialized).toContain(ORG_A);
    }
  });

  it('ignores siteId in the partner-accounts view', async () => {
    const res = await app.request(`/audit-logs?scope=partner&siteId=${SITE_TT}`);
    expect(res.status).toBe(200);
    for (const where of whereCalls) {
      const serialized = JSON.stringify(where);
      expect(serialized).toContain(PARTNER_ID);
      expect(serialized).not.toContain(SITE_TT);
    }
  });

  it('User filter matches names through a users subquery, so the join-less count query stays valid', async () => {
    const res = await app.request('/audit-logs?user=Huy');
    expect(res.status).toBe(200);
    // [0] = countRows (FROM audit_logs only), [1] = queryRows.
    const countWhere = JSON.stringify(whereCalls[0]);
    expect(countWhere).toContain('FROM users u WHERE u.name ILIKE');
    expect(countWhere).toContain('%Huy%');
  });
});
