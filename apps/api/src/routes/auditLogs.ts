import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, desc, eq, gte, lte, ilike, inArray, isNull, not, or, sql, SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { auditLogs as auditLogsTable, users, devices } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { csvRow } from '../services/spreadsheetExport';
import type { ActorType, AuditResult } from '@breeze/shared';

export const auditLogRoutes = new Hono();
const requireAuditLogRead = requirePermission(
  PERMISSIONS.AUDIT_READ.resource,
  PERMISSIONS.AUDIT_READ.action,
);
const requireAuditLogExport = requirePermission(
  PERMISSIONS.AUDIT_EXPORT.resource,
  PERMISSIONS.AUDIT_EXPORT.action,
);

// Apply auth to all routes
auditLogRoutes.use('*', authMiddleware);

// ============================================
// Schemas
// ============================================

const listLogsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  user: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  resource: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  // RecentActivity widget doesn't display "X of Y total"; the count(*) is a
  // 2-3s RLS-bound scan even with an index. Pass skipCount=true to skip it.
  skipCount: z.enum(['true', 'false']).optional(),
  // Explicit org filter from the org-selector dropdown. fetchWithAuth
  // auto-injects ?orgId=<current-org>; whitelist it here so zValidator keeps
  // it — otherwise it is stripped and every page spans the caller's full
  // accessible-org set, ignoring the dropdown selection.
  orgId: z.string().guid().optional(),
  // CSV of action codes to exclude (e.g. routine agent telemetry). Applied to
  // both the LATERAL fast-path (RecentActivity) and the standard query path.
  excludeActions: z.string().optional(),
  // 'partner' = partner-level account activity (rows with no org_id written by
  // or about the caller's partner users: sign-ins, invites, MFA, user admin).
  // Those rows are invisible to the org-scoped list because RLS
  // (breeze_has_org_access) rejects a NULL org_id for non-system callers.
  scope: z.enum(['org', 'partner']).optional(),
  // Narrow to activity on devices assigned to this site (a branch). Ignored
  // for scope=partner — partner-level account rows are not tied to devices.
  siteId: z.string().guid().optional()
});

const searchSchema = listLogsSchema.extend({
  q: z.string().min(1)
});

const idParamSchema = z.object({
  id: z.string().min(1)
});

const auditExportColumns = [
  'id',
  'timestamp',
  'actorId',
  'actorName',
  'actorEmail',
  'action',
  'resourceType',
  'resourceId',
  'resourceName',
  'category',
  'result',
  'ipAddress',
  'userAgent',
  'details'
] as const;

type AuditExportColumn = typeof auditExportColumns[number];

const exportSchema = z.object({
  format: z.enum(['csv', 'json']).default('json'),
  filters: z.object({
    user: z.string().min(1).optional(),
    action: z.string().min(1).optional(),
    resource: z.string().min(1).optional()
  }).optional(),
  dateRange: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional()
  }).optional(),
  columns: z.array(z.enum(auditExportColumns)).optional(),
  includeDetails: z.boolean().default(true)
});

const reportQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
});

// ============================================
// Action classification sets (for reports)
// ============================================

const securityActions = new Set([
  'user.login',
  'user.login.failed',
  'user.permission.change',
  'policy.update',
  'policy.create',
  'policy.evaluate',
  'automation.policy.evaluate',
  // Written by agentAuth when an agent token is presented from a new source IP —
  // NAT/mobility churn, or a stolen token being replayed elsewhere.
  'agent.source.ip.changed'
]);

const complianceActions = new Set([
  'data.access',
  'data.export',
  'device.create',
  'device.delete',
  'policy.update',
  'policy.evaluate',
  'automation.policy.evaluate',
  'script.execute',
  'organization.update'
]);

const dataAccessActions = new Set(['data.access']);
const dataChangeActions = new Set([
  'device.create',
  'device.delete',
  'device.update',
  'policy.update',
  'policy.evaluate',
  'automation.policy.evaluate',
  'policy.create',
  'script.execute',
  'organization.update'
]);
const exportActions = new Set(['data.export']);

// ============================================
// Helpers
// ============================================

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function escapeIlike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

function deriveCategory(action: string): string {
  if (action.startsWith('user.login') || action.startsWith('user.logout') || action.startsWith('user.permission')) return 'authentication';
  if (action.startsWith('device.')) return 'device';
  if (action.startsWith('script.')) return 'automation';
  if (action.startsWith('automation.policy.')) return 'policy';
  if (action.startsWith('policy.')) return 'policy';
  if (action.startsWith('alert.')) return 'alert';
  if (action.startsWith('data.')) return 'compliance';
  if (action.startsWith('organization.')) return 'organization';
  return 'system';
}

export type DbRow = {
  log: typeof auditLogsTable.$inferSelect;
  userName: string | null;
  deviceHostname: string | null;
  deviceDisplayName: string | null;
  deviceSiteId?: string | null;
};

export function resolveActorName(row: DbRow, details?: Record<string, unknown> | null): string {
  if (row.userName) {
    return row.userName;
  }

  const rawActorId = typeof details?.rawActorId === 'string' ? details.rawActorId : null;

  if (row.log.actorType === 'agent') {
    // Agent actions: never display the bare device hostname in the user
    // column, because that makes the device look like it's masquerading
    // as a user. Prefer "Agent (<hostname>)" when we can resolve a device,
    // falling back to a short agent-id slug, then a generic "Agent".
    const deviceName = row.deviceDisplayName || row.deviceHostname;
    if (deviceName) return `Agent (${deviceName})`;
    return rawActorId ? `Agent ${rawActorId.slice(0, 8)}` : 'Agent';
  }

  if (row.log.actorType === 'ai_agent') {
    // AI-agent-originated actions (wave 3, #3824): a distinct principal from
    // actorType 'agent' (the Go device agent). Agent-event callers of
    // recordActionIntentEvent (services/actionIntents/metrics.ts) supply the
    // acting agent's id as details.agentId — wired in PR 3b; until then real
    // ai_agent rows render the generic label below.
    const agentId = typeof details?.agentId === 'string' ? details.agentId : null;
    return agentId ? `AI Agent ${agentId.slice(0, 8)}` : 'AI Agent';
  }

  if (row.log.actorEmail) {
    return row.log.actorEmail;
  }

  if (row.log.actorType === 'api_key') {
    return rawActorId ? `API Key ${rawActorId.slice(0, 8)}` : 'API Key';
  }

  if (row.log.actorType === 'system') {
    return 'System';
  }

  return 'Unknown User';
}

function flattenEntry(row: DbRow) {
  const log = row.log;
  const details = log.details as Record<string, unknown> | null;
  const actorName = resolveActorName(row, details);
  return {
    id: log.id,
    timestamp: log.timestamp.toISOString(),
    action: log.action,
    resource: log.resourceName ?? log.resourceType,
    resourceType: log.resourceType,
    details: details ? JSON.stringify(details) : '{}',
    ipAddress: log.ipAddress ?? '',
    userAgent: log.userAgent ?? '',
    sessionId: details?.sessionId ?? null,
    user: {
      name: actorName,
      email: log.actorEmail ?? '',
      role: log.actorType,
      department: ''
    },
    initiatedBy: log.initiatedBy ?? null,
    changes: {
      before: {},
      after: details ?? {}
    }
  };
}

function toFullEntry(row: DbRow, includeDetails = true) {
  const log = row.log;
  const details = log.details as Record<string, unknown> | null;
  const actorName = resolveActorName(row, details);
  const entry: Record<string, unknown> = {
    id: log.id,
    timestamp: log.timestamp.toISOString(),
    user: {
      id: log.actorId,
      name: actorName,
      email: log.actorEmail ?? '',
      role: log.actorType
    },
    action: log.action,
    resource: {
      type: log.resourceType,
      id: log.resourceId ?? '',
      name: log.resourceName ?? ''
    },
    category: deriveCategory(log.action),
    result: log.result,
    ipAddress: log.ipAddress ?? '',
    userAgent: log.userAgent ?? '',
    initiatedBy: log.initiatedBy ?? null,
  };
  if (includeDetails) {
    entry.details = details ?? {};
  }
  return entry;
}

function parseExcludeActions(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Activity on devices assigned to `siteId`, matched the same three ways the
 * per-device Activity feed (routes/devices/events.ts) attributes a row:
 *   - resource arm: the row's resource is the device (resource_type 'device'),
 *   - details arm:  details.deviceId names the device (scripts, commands, ...),
 *   - agent arm:    the device's own agent wrote it (details.rawActorId).
 * The devices subqueries run under the caller's RLS, so a site in an org the
 * caller cannot reach simply matches nothing.
 */
export function siteActivityCondition(siteId: string): SQL {
  const deviceIds = sql`(SELECT d.id FROM devices d WHERE d.site_id = ${siteId}::uuid)`;
  const deviceIdTexts = sql`(SELECT d.id::text FROM devices d WHERE d.site_id = ${siteId}::uuid)`;
  const agentIds = sql`(SELECT d.agent_id FROM devices d WHERE d.site_id = ${siteId}::uuid)`;
  return or(
    sql`(${auditLogsTable.resourceType} = 'device' AND ${auditLogsTable.resourceId} IN ${deviceIds})`,
    sql`(${auditLogsTable.details} ? 'deviceId' AND ${auditLogsTable.details}->>'deviceId' IN ${deviceIdTexts})`,
    sql`(${auditLogsTable.actorType} = 'agent' AND ${auditLogsTable.details}->>'rawActorId' IN ${agentIds})`
  )!;
}

function buildFilterConditions(
  orgCond: SQL | undefined,
  filters: { user?: string; action?: string; resource?: string; from?: string; to?: string; excludeActions?: string; siteId?: string }
): SQL | undefined {
  const conditions: SQL[] = [];

  if (orgCond) conditions.push(orgCond);

  if (filters.user) {
    const term = `%${escapeIlike(filters.user)}%`;
    // Name match via subquery, not the `users` join: countRows() selects from
    // audit_logs alone, so referencing users.name there was a SQL error
    // ("missing FROM-clause entry") whenever the User filter was applied.
    conditions.push(
      or(
        ilike(auditLogsTable.actorEmail, term),
        sql`${auditLogsTable.actorId} IN (SELECT u.id FROM users u WHERE u.name ILIKE ${term})`
      )!
    );
  }

  if (filters.siteId) {
    conditions.push(siteActivityCondition(filters.siteId));
  }

  if (filters.action) {
    conditions.push(ilike(auditLogsTable.action, `%${escapeIlike(filters.action)}%`));
  }

  if (filters.resource) {
    const term = `%${escapeIlike(filters.resource)}%`;
    conditions.push(
      or(
        ilike(auditLogsTable.resourceType, term),
        ilike(auditLogsTable.resourceName, term)
      )!
    );
  }

  if (filters.from) {
    conditions.push(gte(auditLogsTable.timestamp, new Date(filters.from)));
  }

  if (filters.to) {
    conditions.push(lte(auditLogsTable.timestamp, new Date(filters.to)));
  }

  const excludeList = parseExcludeActions(filters.excludeActions);
  if (excludeList.length > 0) {
    conditions.push(not(inArray(auditLogsTable.action, excludeList)));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

// ============================================
// Partner-level account activity (scope=partner)
// ============================================

type PartnerAccountsAccess =
  | { ok: true; partnerId: string | null }
  | { ok: false };

/**
 * Who may read partner-level account activity. Partner-scope callers need
 * org_access 'all' (a 'selected' member must not see sign-ins/invites of
 * colleagues who manage orgs outside their selection); system scope may read
 * every NULL-org row. Organization-scope callers never qualify.
 */
export function resolvePartnerAccountsAccess(auth: {
  scope: string;
  partnerId: string | null;
  partnerOrgAccess?: 'all' | 'selected' | 'none' | null;
}): PartnerAccountsAccess {
  if (auth.scope === 'system') return { ok: true, partnerId: null };
  if (auth.scope === 'partner' && auth.partnerId && auth.partnerOrgAccess === 'all') {
    return { ok: true, partnerId: auth.partnerId };
  }
  return { ok: false };
}

/**
 * Rows with no org_id that a member of `partnerId` performed, or that were
 * written about a member (e.g. a failed sign-in recorded with an anonymous
 * actor and the target user as the resource). `partnerId` null (system scope)
 * returns every NULL-org row.
 */
export function partnerAccountsCondition(partnerId: string | null): SQL {
  const noOrg = isNull(auditLogsTable.orgId);
  if (!partnerId) return noOrg;
  const members = sql`(SELECT pu.user_id FROM partner_users pu WHERE pu.partner_id = ${partnerId}::uuid)`;
  return and(
    noOrg,
    or(
      sql`${auditLogsTable.actorId} IN ${members}`,
      sql`${auditLogsTable.resourceId} IN ${members}`
    )
  )!;
}

/**
 * RLS hides every NULL-org audit row from partner callers, so the
 * partner-accounts read runs under a short system context on its own
 * connection. The WHERE clause above is the only tenant boundary here, so
 * callers MUST always pass partnerAccountsCondition() through.
 */
function withPartnerAccountsRead<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, 'audit-logs.partner-accounts'));
}

function buildSearchCondition(q: string): SQL {
  const term = `%${escapeIlike(q)}%`;
  return or(
    ilike(auditLogsTable.action, term),
    ilike(auditLogsTable.actorEmail, term),
    ilike(auditLogsTable.resourceType, term),
    ilike(auditLogsTable.resourceName, term),
    sql`${auditLogsTable.details}::text ILIKE ${term}`
  )!;
}

async function queryRows(where: SQL | undefined, limit: number, offset: number): Promise<DbRow[]> {
  return db
    .select({
      log: auditLogsTable,
      userName: users.name,
      deviceHostname: devices.hostname,
      deviceDisplayName: devices.displayName,
    })
    .from(auditLogsTable)
    .leftJoin(users, eq(auditLogsTable.actorId, users.id))
    .leftJoin(
      devices,
      sql`${devices.agentId} = ${auditLogsTable.details}->>'rawActorId' AND ${auditLogsTable.actorType} = 'agent'`
    )
    .where(where)
    .orderBy(desc(auditLogsTable.timestamp), desc(auditLogsTable.id))
    .limit(limit)
    .offset(offset);
}

// Fast path for the dashboard widget (RecentActivity): the RLS CASE in
// breeze_has_org_access() cannot be pushed into audit_logs_org_timestamp_idx,
// so a plain ORDER BY timestamp DESC LIMIT N degrades to a Parallel Seq Scan
// over the whole table (~28s in prod). LATERAL per-org index scans gather N
// rows per accessible org, then top-N sort. ~9ms under RLS.
interface LateralAuditRow extends Record<string, unknown> {
  id: string;
  org_id: string | null;
  timestamp: Date | string;
  actor_type: ActorType;
  actor_id: string;
  actor_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  resource_name: string | null;
  details: unknown;
  ip_address: string | null;
  user_agent: string | null;
  result: AuditResult;
  error_message: string | null;
  checksum: string | null;
  initiated_by: string | null;
  user_name: string | null;
  device_hostname: string | null;
  device_display_name: string | null;
}

async function queryLatestPerOrg(
  orgIds: string[],
  limit: number,
  excludeActions: string[] = []
): Promise<DbRow[]> {
  const orgIdsSql = sql.join(orgIds.map((id) => sql`${id}::uuid`), sql`, `);
  // Apply the exclude filter INSIDE the LATERAL subquery so the per-org
  // LIMIT N kicks in after filtering noise — otherwise we fetch N noisy rows
  // per org and drop them all.
  const excludeFilter = excludeActions.length > 0
    ? sql` AND audit_logs.action <> ALL(ARRAY[${sql.join(excludeActions.map((a) => sql`${a}`), sql`, `)}]::text[])`
    : sql``;
  const rows = await db.execute<LateralAuditRow>(sql`
    SELECT
      al.id, al.org_id, al.timestamp, al.actor_type, al.actor_id,
      al.actor_email, al.action, al.resource_type, al.resource_id,
      al.resource_name, al.details, al.ip_address, al.user_agent,
      al.result, al.error_message, al.checksum, al.initiated_by,
      u.name AS user_name,
      d.hostname AS device_hostname,
      d.display_name AS device_display_name
    FROM unnest(ARRAY[${orgIdsSql}]::uuid[]) AS o(org_id)
    CROSS JOIN LATERAL (
      SELECT * FROM audit_logs
      WHERE audit_logs.org_id = o.org_id${excludeFilter}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    ) al
    LEFT JOIN users u ON al.actor_id = u.id
    LEFT JOIN devices d
      ON al.actor_type = 'agent'
      AND d.agent_id = al.details->>'rawActorId'
    ORDER BY al.timestamp DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    log: {
      id: r.id,
      orgId: r.org_id,
      timestamp: r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp),
      actorType: r.actor_type,
      actorId: r.actor_id,
      actorEmail: r.actor_email,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      resourceName: r.resource_name,
      details: r.details,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      result: r.result,
      errorMessage: r.error_message,
      checksum: r.checksum,
      initiatedBy: r.initiated_by,
    } as DbRow['log'],
    userName: r.user_name ?? null,
    deviceHostname: r.device_hostname ?? null,
    deviceDisplayName: r.device_display_name ?? null,
  }));
}

async function countRows(where: SQL | undefined): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLogsTable)
    .where(where);
  return row?.count ?? 0;
}

async function fetchAllForReports(orgCond: SQL | undefined, filters: { from?: string; to?: string }): Promise<DbRow[]> {
  const where = buildFilterConditions(orgCond, filters);
  return queryRows(where, 5000, 0);
}

function normalizeExportColumns(columns: AuditExportColumn[] | undefined, includeDetails: boolean): AuditExportColumn[] {
  const requested = columns === undefined ? [...auditExportColumns] : columns;
  return requested.filter((column) => includeDetails || column !== 'details');
}

function toExportRecord(row: DbRow, includeDetails: boolean): Record<AuditExportColumn, string> {
  const log = row.log;
  const actorName = resolveActorName(row, log.details as Record<string, unknown> | null);
  return {
    id: log.id,
    timestamp: log.timestamp.toISOString(),
    actorId: log.actorId,
    actorName,
    actorEmail: log.actorEmail ?? '',
    action: log.action,
    resourceType: log.resourceType,
    resourceId: log.resourceId ?? '',
    resourceName: log.resourceName ?? '',
    category: deriveCategory(log.action),
    result: log.result,
    ipAddress: log.ipAddress ?? '',
    userAgent: log.userAgent ?? '',
    details: includeDetails ? JSON.stringify(log.details ?? {}) : ''
  };
}

function pickExportColumns(
  row: DbRow,
  columns: AuditExportColumn[],
  includeDetails: boolean
): Record<string, string> {
  const record = toExportRecord(row, includeDetails);
  return Object.fromEntries(columns.map((column) => [column, record[column]]));
}

function toCsv(rows: DbRow[], options: { columns?: AuditExportColumn[]; includeDetails?: boolean } = {}): string {
  const includeDetails = options.includeDetails ?? true;
  const headers = normalizeExportColumns(options.columns, includeDetails);

  const csvRows = rows.map((row) => {
    const record = toExportRecord(row, includeDetails);
    return csvRow(headers.map((header) => record[header]));
  });

  return [csvRow(headers), ...csvRows].join('\n');
}

function summarizeUsers(rows: DbRow[]) {
  const byUser = new Map<string, { userId: string; userName: string; userEmail: string; actionCount: number; lastActiveAt: string }>();

  for (const row of rows) {
    const userId = row.log.actorId;
    const details = row.log.details as Record<string, unknown> | null;
    const actorName = resolveActorName(row, details);
    const existing = byUser.get(userId);
    if (!existing) {
      byUser.set(userId, {
        userId,
        userName: actorName,
        userEmail: row.log.actorEmail ?? '',
        actionCount: 1,
        lastActiveAt: row.log.timestamp.toISOString()
      });
      continue;
    }
    existing.actionCount += 1;
    if (row.log.timestamp.getTime() > new Date(existing.lastActiveAt).getTime()) {
      existing.lastActiveAt = row.log.timestamp.toISOString();
    }
  }

  return Array.from(byUser.values()).sort((a, b) => b.actionCount - a.actionCount);
}

function summarizeActions(rows: DbRow[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.log.action, (counts.get(row.log.action) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count);
}

function summarizeCategories(rows: DbRow[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const cat = deriveCategory(row.log.action);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

// ============================================
// Routes
// ============================================

function paginatedListHandler(
  dataKey: string,
  mapFn: (row: DbRow) => unknown
) {
  return async (c: any) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    if (query.scope === 'partner') {
      const access = resolvePartnerAccountsAccess(auth);
      if (!access.ok) {
        return c.json({ error: 'Partner account activity requires partner access to all organizations' }, 403);
      }
      const where = buildFilterConditions(partnerAccountsCondition(access.partnerId), { ...query, siteId: undefined });
      const skipCount = query.skipCount === 'true';
      const [total, rows] = await withPartnerAccountsRead(() => Promise.all([
        skipCount ? Promise.resolve(-1) : countRows(where),
        queryRows(where, limit, offset)
      ]));
      return c.json({
        [dataKey]: rows.map(mapFn),
        pagination: {
          page,
          limit,
          total,
          totalPages: total < 0 ? -1 : Math.ceil(total / limit)
        }
      });
    }

    // Explicit per-request org scope from the org-selector dropdown. If the
    // caller asks for an org they cannot access, return 403 — do NOT silently
    // fall back to the full accessible-org set.
    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied' }, 403);
    }
    if (query.siteId && auth.canAccessSite && !auth.canAccessSite(query.siteId)) {
      return c.json({ error: 'Access denied' }, 403);
    }
    // BY DESIGN: the audit-log list is scoped to the org only, NOT the caller's
    // site allowlist. Audit trails are an org-level compliance record and must
    // stay complete for any org member with audit-read permission; partitioning
    // them by site would hide legitimate entries (and the loose details->>
    // 'rawActorId' device join is not a reliable site key anyway). The by-id
    // detail view applies an agent-actor site check as defence-in-depth; the
    // list intentionally does not. (Site-scope review decision, 2026-05-31.)
    // A pinned ?orgId= narrows to that single (accessible) org; otherwise the
    // standard condition spans every accessible org.
    const orgCond = query.orgId
      ? eq(auditLogsTable.orgId, query.orgId)
      : auth.orgCondition(auditLogsTable.orgId);
    const where = buildFilterConditions(orgCond, query);
    // count(*) on audit_logs is 2-3s under RLS even with the org_timestamp
    // index. The dashboard widget that calls /logs?limit=5 doesn't need the
    // count — it never displays "X of Y total". Pass skipCount=true there.
    const skipCount = query.skipCount === 'true';
    const hasFilters = !!(query.user || query.action || query.resource || query.from || query.to || query.siteId);
    // excludeActions is compatible with the fast path — it's applied inside the
    // LATERAL subquery before the per-org LIMIT. The standard path picks it up
    // via buildFilterConditions(orgCond, query) above.
    const excludeActions = parseExcludeActions(query.excludeActions);
    // Fast-path org list: a pinned ?orgId= scopes the LATERAL per-org scan to
    // that single org; otherwise it spans every accessible org.
    const fastPathOrgIds: string[] | null = query.orgId
      ? [query.orgId]
      : (Array.isArray(auth.accessibleOrgIds) ? (auth.accessibleOrgIds as string[]) : null);
    const canUseFastPath =
      skipCount &&
      offset === 0 &&
      !hasFilters &&
      fastPathOrgIds !== null &&
      fastPathOrgIds.length > 0;
    const [total, rows] = await Promise.all([
      skipCount ? Promise.resolve(-1) : countRows(where),
      canUseFastPath
        ? queryLatestPerOrg(fastPathOrgIds as string[], limit, excludeActions)
        : queryRows(where, limit, offset)
    ]);

    return c.json({
      [dataKey]: rows.map(mapFn),
      pagination: {
        page,
        limit,
        total,
        totalPages: total < 0 ? -1 : Math.ceil(total / limit)
      }
    });
  };
}

// GET / — used by AuditLogViewer (returns flattenEntry shape)
auditLogRoutes.get(
  '/',
  requireAuditLogRead,
  zValidator('query', listLogsSchema),
  paginatedListHandler('entries', flattenEntry)
);

// GET /logs — used by RecentActivity, UserActivityReport (returns full entry shape)
auditLogRoutes.get(
  '/logs',
  requireAuditLogRead,
  zValidator('query', listLogsSchema),
  paginatedListHandler('data', toFullEntry)
);

// GET /logs/:id — single entry detail
auditLogRoutes.get(
  '/logs/:id',
  requireAuditLogRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const orgCond = auth.orgCondition(auditLogsTable.orgId);
    const conditions: SQL[] = [eq(auditLogsTable.id, id)];
    if (orgCond) conditions.push(orgCond);

    const [row] = await db
      .select({
        log: auditLogsTable,
        userName: users.name,
        deviceHostname: devices.hostname,
        deviceDisplayName: devices.displayName,
        deviceSiteId: devices.siteId,
      })
      .from(auditLogsTable)
      .leftJoin(users, eq(auditLogsTable.actorId, users.id))
      .leftJoin(
        devices,
        sql`${devices.agentId} = ${auditLogsTable.details}->>'rawActorId' AND ${auditLogsTable.actorType} = 'agent'`
      )
      .where(and(...conditions));

    if (!row) {
      return c.json({ error: 'Audit log not found' }, 404);
    }

    const perms = c.get('permissions') as UserPermissions | undefined;
    if (
      perms?.allowedSiteIds
      && row.log.actorType === 'agent'
      && (typeof row.deviceSiteId !== 'string' || !canAccessSite(perms, row.deviceSiteId))
    ) {
      return c.json({ error: 'Audit log not found or access denied' }, 403);
    }

    return c.json(toFullEntry(row));
  }
);

// GET /search
auditLogRoutes.get(
  '/search',
  requireAuditLogRead,
  zValidator('query', searchSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    let partnerAccess: PartnerAccountsAccess | null = null;
    if (query.scope === 'partner') {
      partnerAccess = resolvePartnerAccountsAccess(auth);
      if (!partnerAccess.ok) {
        return c.json({ error: 'Partner account activity requires partner access to all organizations' }, 403);
      }
    }

    if (!partnerAccess) {
      if (query.orgId && !auth.canAccessOrg(query.orgId)) {
        return c.json({ error: 'Access denied' }, 403);
      }
      if (query.siteId && auth.canAccessSite && !auth.canAccessSite(query.siteId)) {
        return c.json({ error: 'Access denied' }, 403);
      }
    }

    // Same org pinning as the list: a search must stay inside the org picked
    // in the switcher instead of spanning every accessible org.
    const orgCond = partnerAccess?.ok
      ? partnerAccountsCondition(partnerAccess.partnerId)
      : query.orgId
        ? eq(auditLogsTable.orgId, query.orgId)
        : auth.orgCondition(auditLogsTable.orgId);
    const filterWhere = buildFilterConditions(
      orgCond,
      partnerAccess?.ok ? { ...query, siteId: undefined } : query
    );
    const searchCond = buildSearchCondition(query.q);
    const where = filterWhere ? and(filterWhere, searchCond) : searchCond;

    const runQueries = () => Promise.all([
      countRows(where),
      queryRows(where, limit, offset)
    ]);
    const [total, rows] = partnerAccess?.ok
      ? await withPartnerAccountsRead(runQueries)
      : await runQueries();

    return c.json({
      data: rows.map((row) => toFullEntry(row)),
      query: query.q,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  }
);

// POST /export — used by AuditExport component
auditLogRoutes.post(
  '/export',
  requireAuditLogExport,
  requireMfa(),
  zValidator('json', exportSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const orgCond = auth.orgCondition(auditLogsTable.orgId);
    const where = buildFilterConditions(orgCond, {
      ...(body.filters ?? {}),
      from: body.dateRange?.from,
      to: body.dateRange?.to
    });

    const rows = await queryRows(where, 10000, 0);
    const exportColumns = normalizeExportColumns(body.columns, body.includeDetails);

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'audit_logs.export',
      resourceType: 'audit_log',
      details: {
        format: body.format,
        rowCount: rows.length,
        filters: body.filters ?? {},
        dateRange: body.dateRange ?? {},
        columns: exportColumns,
        includeDetails: body.includeDetails
      }
    });

    if (body.format === 'csv') {
      c.header('Content-Type', 'text/csv');
      c.header('Content-Disposition', 'attachment; filename="audit-logs.csv"');
      return c.body(toCsv(rows, { columns: exportColumns, includeDetails: body.includeDetails }));
    }

    const data = body.columns === undefined
      ? rows.map((row) => toFullEntry(row, body.includeDetails))
      : rows.map((row) => pickExportColumns(row, exportColumns, body.includeDetails));

    return c.json({ data, total: rows.length });
  }
);

// GET /export — used by AuditLogViewer export button (CSV download)
const exportGetSchema = z.object({
  userId: z.string().guid().optional(),
  columns: z.string().optional(),
  includeDetails: z.enum(['true', 'false']).optional().default('true'),
  scope: z.enum(['org', 'partner']).optional()
});

auditLogRoutes.get(
  '/export',
  requireAuditLogExport,
  requireMfa(),
  zValidator('query', exportGetSchema),
  async (c) => {
    const auth = c.get('auth');
    const { userId, columns, includeDetails: includeDetailsRaw, scope } = c.req.valid('query');

    let partnerAccess: PartnerAccountsAccess | null = null;
    if (scope === 'partner') {
      partnerAccess = resolvePartnerAccountsAccess(auth);
      if (!partnerAccess.ok) {
        return c.json({ error: 'Partner account activity requires partner access to all organizations' }, 403);
      }
    }
    const orgCond = partnerAccess?.ok
      ? partnerAccountsCondition(partnerAccess.partnerId)
      : auth.orgCondition(auditLogsTable.orgId);

    const includeDetails = includeDetailsRaw !== 'false';
    const parsedColumns = columns
      ?.split(',')
      .map((column) => column.trim())
      .filter((column): column is AuditExportColumn => (auditExportColumns as readonly string[]).includes(column));
    const exportColumns = normalizeExportColumns(parsedColumns, includeDetails);
    const conditions: SQL[] = [];
    if (orgCond) conditions.push(orgCond);
    if (userId) conditions.push(eq(auditLogsTable.actorId, userId));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = partnerAccess?.ok
      ? await withPartnerAccountsRead(() => queryRows(where, 10000, 0))
      : await queryRows(where, 10000, 0);

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'audit_logs.export',
      resourceType: 'audit_log',
      details: {
        format: 'csv',
        rowCount: rows.length,
        filters: { userId: userId ?? null, scope: scope ?? 'org' },
        columns: exportColumns,
        includeDetails
      }
    });

    c.header('Content-Type', 'text/csv');
    c.header('Content-Disposition', 'attachment; filename="audit-logs.csv"');
    return c.body(toCsv(rows, { columns: exportColumns, includeDetails }));
  }
);

// GET /reports/user-activity
auditLogRoutes.get(
  '/reports/user-activity',
  requireAuditLogRead,
  zValidator('query', reportQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgCond = auth.orgCondition(auditLogsTable.orgId);
    const rows = await fetchAllForReports(orgCond, query);

    const actionsPerUser = summarizeUsers(rows);
    const recentActivity = rows.slice(0, 10).map((row) => toFullEntry(row));

    return c.json({
      totalUsers: actionsPerUser.length,
      totalEvents: rows.length,
      actionsPerUser,
      topUsers: actionsPerUser.slice(0, 5),
      recentActivity
    });
  }
);

// GET /reports/security-events
auditLogRoutes.get(
  '/reports/security-events',
  requireAuditLogRead,
  zValidator('query', reportQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgCond = auth.orgCondition(auditLogsTable.orgId);
    const allRows = await fetchAllForReports(orgCond, query);

    const securityRows = allRows.filter((r) => securityActions.has(r.log.action));
    const byAction = summarizeActions(securityRows);
    const loginAttempts = securityRows.filter((r) => r.log.action.startsWith('user.login')).length;
    const failedLogins = securityRows.filter((r) => r.log.action === 'user.login.failed').length;
    const permissionChanges = securityRows.filter((r) => r.log.action === 'user.permission.change').length;

    return c.json({
      totalEvents: securityRows.length,
      loginAttempts,
      failedLogins,
      permissionChanges,
      byAction,
      recentEvents: securityRows.slice(0, 10).map((row) => toFullEntry(row))
    });
  }
);

// GET /reports/compliance
auditLogRoutes.get(
  '/reports/compliance',
  requireAuditLogRead,
  zValidator('query', reportQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgCond = auth.orgCondition(auditLogsTable.orgId);
    const allRows = await fetchAllForReports(orgCond, query);

    const complianceRows = allRows.filter((r) =>
      complianceActions.has(r.log.action) || deriveCategory(r.log.action) === 'compliance'
    );
    const byAction = summarizeActions(complianceRows);
    const dataAccess = complianceRows.filter((r) => dataAccessActions.has(r.log.action)).length;
    const dataChanges = complianceRows.filter((r) => dataChangeActions.has(r.log.action)).length;
    const exports = complianceRows.filter((r) => exportActions.has(r.log.action)).length;

    return c.json({
      totalEvents: complianceRows.length,
      dataAccess,
      dataChanges,
      exports,
      byAction,
      recentEvents: complianceRows.slice(0, 10).map((row) => toFullEntry(row))
    });
  }
);

// GET /stats
auditLogRoutes.get(
  '/stats',
  requireAuditLogRead,
  zValidator('query', reportQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgCond = auth.orgCondition(auditLogsTable.orgId);
    const rows = await fetchAllForReports(orgCond, query);

    const byCategory = summarizeCategories(rows);
    const byUser = summarizeUsers(rows).map((entry) => ({
      userId: entry.userId,
      userName: entry.userName,
      actionCount: entry.actionCount
    }));

    return c.json({
      totalEvents: rows.length,
      byCategory,
      byUser,
      range: {
        from: query.from ?? null,
        to: query.to ?? null
      }
    });
  }
);
