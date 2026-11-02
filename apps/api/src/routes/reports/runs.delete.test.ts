import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  writeRouteAuditMock,
  deleteReturning,
  canManagePartnerWideMock,
  auditSensitiveReadMock,
  getReportRunMock,
  selectRows,
  rowsToCsvMock,
  rowsToTsvMock,
} = vi.hoisted(() => ({
  writeRouteAuditMock: vi.fn(),
  deleteReturning: [] as unknown[][],
  canManagePartnerWideMock: vi.fn(() => true),
  auditSensitiveReadMock: vi.fn(),
  getReportRunMock: vi.fn(),
  selectRows: [] as unknown[][],
  rowsToCsvMock: vi.fn((rows: unknown[]) => `csv:${JSON.stringify(rows)}`),
  rowsToTsvMock: vi.fn((rows: unknown[]) => `tsv:${JSON.stringify(rows)}`),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'reader@example.com',
      },
      scope: 'organization',
      orgId: '22222222-2222-4222-8222-222222222222',
      partnerId: null,
      accessibleOrgIds: ['22222222-2222-4222-8222-222222222222'],
      canAccessOrg: (orgId: string) => orgId === '22222222-2222-4222-8222-222222222222',
    });
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const result = selectRows.shift() ?? [];
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'offset']) {
        chain[method] = vi.fn(() => chain);
      }
      chain.limit = vi.fn(() => Promise.resolve(result));
      return chain;
    }),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(deleteReturning.shift() ?? [])) })),
    })),
  },
}));

vi.mock('../../db/schema', () => ({
  reports: {
    id: 'reports.id',
    orgId: 'reports.orgId',
    type: 'reports.type',
    name: 'reports.name',
    format: 'reports.format',
  },
  serviceDeliverableEvidence: { id: 'sde.id', reportRunId: 'sde.reportRunId' },
  reportRuns: {
    id: 'reportRuns.id',
    reportId: 'reportRuns.reportId',
    result: 'reportRuns.result',
    artifactId: 'reportRuns.artifactId',
  },
  // Execution plane W05 (#5716): runs.ts reaches artifactService for the
  // from-artifact attach route, and that module reads this table off the
  // barrel. Present so this partial schema mock stays loadable.
  aiRunArtifacts: {
    id: 'aiRunArtifacts.id',
    orgId: 'aiRunArtifacts.orgId',
    runId: 'aiRunArtifacts.runId',
    expiresAt: 'aiRunArtifacts.expiresAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ conditions }),
  eq: (column: unknown, value: unknown) => ({ column, value }),
  sql: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    REPORTS_EXPORT: { resource: 'reports', action: 'export' },
    REPORTS_READ: { resource: 'reports', action: 'read' },
    REPORTS_WRITE: { resource: 'reports', action: 'write' },
    REPORTS_DELETE: { resource: 'reports', action: 'delete' },
  },
}));

vi.mock('../../services/reportGenerationService', () => ({
  generateReport: vi.fn(),
  previousBaselineFor: vi.fn(),
  assertReportExecutionPreflight: vi.fn(),
  UnexecutableReportScopeError: class extends Error {},
}));

// This suite proves audit-byte fidelity, not scope semantics — the site-scope
// authority layer is exercised by data.sitescope.test.ts, so stub it permissive.
vi.mock('../../services/siteScope', () => ({
  decodeSiteScope: vi.fn(() => ({ kind: 'unrestricted' })),
  intersectSiteScopes: vi.fn((a: unknown) => a),
  isSiteScopeSubset: vi.fn(() => true),
  persistedSiteScopeValues: vi.fn(() => ({})),
  reportRunMultiOrgScopeSqlPredicate: vi.fn(() => ({})),
  reportRunScopeSqlPredicate: vi.fn(() => ({})),
  resolveRequestReportAuthority: vi.fn(),
  resolveRequestReportAuthorityMap: vi.fn(),
  siteScopeFingerprint: vi.fn(() => 'fp'),
  unrestrictedReportRunScopeSqlPredicate: vi.fn(() => ({})),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));
vi.mock('../../services/partnerWideAccess', () => ({ canManagePartnerWidePolicies: canManagePartnerWideMock }));

vi.mock('./helpers', () => ({
  isSystemManagedReportDefinition: (row: { type: string | null; executionScopePrincipalKind: string | null }) =>
    row.executionScopePrincipalKind === 'system' || row.type === 'ai_org_narrative',
  getReportRunWithOrgCheck: getReportRunMock,
  getReportWithOrgCheck: vi.fn(),
  ensureOrgAccess: vi.fn(),
  getPagination: vi.fn(),
}));

vi.mock('@breeze/shared', () => ({
  rowsToCsv: rowsToCsvMock,
  rowsToTsv: rowsToTsvMock,
}));

vi.mock('../../services/sensitiveReadAudit', () => ({
  auditSensitiveRead: auditSensitiveReadMock,
}));

import { runsRoutes } from './runs';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const RUN_A = '33333333-3333-4333-8333-333333333333';
const RUN_B = '55555555-5555-4555-8555-555555555555';

function app() {
  const instance = new Hono();
  instance.route('/reports', runsRoutes);
  return instance;
}

function access(id: string, extra: Record<string, unknown> = {}) {
  return {
    metadata: { id, reportId: '44444444-4444-4444-8444-444444444444', orgId: ORG_ID, partnerId: null, ...extra },
    owner: { orgId: ORG_ID },
    ownerCondition: {},
    authority: { scope: { kind: 'unrestricted' } },
    runScopePredicate: {},
  };
}

const runRow = (status = 'completed', extra: Record<string, unknown> = {}) =>
  ({ status, reportName: 'DS CPU', type: 'device_inventory', executionScopePrincipalKind: 'user', portalSelfService: false, ...extra });

describe('deleting report runs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRows.length = 0;
    deleteReturning.length = 0;
    canManagePartnerWideMock.mockReturnValue(true);
  });

  it('deletes a completed run and audits it', async () => {
    getReportRunMock.mockResolvedValue(access(RUN_A));
    selectRows.push([runRow()], []);
    deleteReturning.push([{ id: RUN_A }]);

    const res = await app().request(`/reports/runs/${RUN_A}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(getReportRunMock).toHaveBeenCalledWith(RUN_A, expect.anything(), 'delete');
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'report.run.delete', resourceType: 'report_run', resourceId: RUN_A, resourceName: 'DS CPU', orgId: ORG_ID,
    }));
  });

  it('404s a run outside the caller\'s scope without touching the table', async () => {
    getReportRunMock.mockResolvedValue(null);
    const { db } = await import('../../db');

    const res = await app().request(`/reports/runs/${RUN_A}`, { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(db.delete).not.toHaveBeenCalled();
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('refuses a run that is still generating', async () => {
    getReportRunMock.mockResolvedValue(access(RUN_A));
    selectRows.push([runRow('running')]);
    const res = await app().request(`/reports/runs/${RUN_A}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'in_progress' });
  });

  it('keeps runs of system-managed definitions and runs used as service evidence', async () => {
    getReportRunMock.mockResolvedValue(access(RUN_A));
    selectRows.push([runRow('completed', { type: 'ai_org_narrative' })]);
    let res = await app().request(`/reports/runs/${RUN_A}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'system_managed' });

    selectRows.push([runRow()], [{ id: 'evidence-1' }]);
    res = await app().request(`/reports/runs/${RUN_A}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'evidence' });
  });

  it('refuses a partner-owned run without partner-wide rights', async () => {
    getReportRunMock.mockResolvedValue(access(RUN_A, { orgId: null, partnerId: 'p-1' }));
    canManagePartnerWideMock.mockReturnValue(false);
    const res = await app().request(`/reports/runs/${RUN_A}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('bulk delete reports per-id results', async () => {
    getReportRunMock.mockImplementation(async (id: string) => (id === RUN_A ? access(RUN_A) : null));
    selectRows.push([runRow()], []);
    deleteReturning.push([{ id: RUN_A }]);

    const res = await app().request('/reports/runs/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [RUN_A, RUN_B, RUN_A] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: [RUN_A], failed: [{ id: RUN_B, reason: 'not_found' }] });
    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
  });

  it('bulk delete validates the id list', async () => {
    const res = await app().request('/reports/runs/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });
    expect(res.status).toBe(400);
  });
});
