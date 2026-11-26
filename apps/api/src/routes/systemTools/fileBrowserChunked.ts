/**
 * Chunked File Browser transfers — files above the single-shot caps
 * (4MB upload / 1MB download) up to AGENT_MAX_CHUNKED_TRANSFER_BYTES.
 *
 * The browser drives the transfer one chunk per request; this router is
 * stateless and simply relays each chunk as a `file_write_chunk` /
 * `file_read_chunk` command. The agent owns all transfer state (an in-order
 * temp file it verifies by SHA-256 before renaming into place), so a request
 * that fails half-way leaves the destination untouched. See
 * agent/internal/remote/tools/fileops_chunked.go for the protocol.
 *
 * Permissions match the single-shot routes in fileBrowser.ts: upload needs
 * scripts:execute, download needs devices:execute, and the agent's own
 * config/secrets directory is refused outright. The router-wide gates in
 * index.ts (devices:execute, MFA, org/site check, remote-tools policy) apply.
 *
 * Auditing: one audit row per TRANSFER, not per chunk — the final chunk (or
 * the first failure) of an upload, and the first chunk of a download.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { executeCommand, CommandTypes, type CommandResult } from '../../services/commandQueue';
import { createAuditLog } from '../../services/auditService';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { auditSensitiveRead } from '../../services/sensitiveReadAudit';
import { getDeviceWithOrgAndSiteCheck, requireDevicesExecute, SITE_ACCESS_DENIED } from './helpers';
import { isAgentConfigPath } from './sensitiveTargets';
import {
  isCommandFailure,
  mapCommandFailure,
  buildSingleItemUploadBody,
  auditErrorMessage,
} from './fileBrowserHelpers';
import {
  deviceIdParamSchema,
  fileUploadChunkBodySchema,
  fileUploadAbortBodySchema,
  fileDownloadChunkQuerySchema,
} from './schemas';

export const fileBrowserChunkedRoutes = new Hono();

const requireScriptsExecute = requirePermission(
  PERMISSIONS.SCRIPTS_EXECUTE.resource,
  PERMISSIONS.SCRIPTS_EXECUTE.action,
);

// One chunk is ~2.8MB of base64; 60s covers a slow uplink, and the final chunk
// also hashes up to 100MB on the device before renaming.
const CHUNK_TIMEOUT_MS = 60_000;

export const AGENT_UPDATE_REQUIRED_CODE = 'agent_update_required';
const AGENT_UPDATE_REQUIRED_MESSAGE =
  'The agent on this device is too old for large file transfers. Update the agent, or transfer files under 4MB (upload) / 1MB (download).';

/** An agent that predates the chunked commands refuses them by name. */
export function isUnknownChunkCommand(result: CommandResult): boolean {
  return result.status === 'failed'
    && typeof result.error === 'string'
    && result.error.trimStart().startsWith('unknown command type:');
}

async function resolveDevice(c: Context, deviceId: string) {
  const auth = c.get('auth');
  const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
  if (device === SITE_ACCESS_DENIED) {
    return { response: c.json({ error: 'Access to this site denied' }, 403) } as const;
  }
  if (!device) {
    return { response: c.json({ error: 'Device not found or access denied' }, 404) } as const;
  }
  return { device } as const;
}

function parseStdout(result: CommandResult): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// POST /devices/:deviceId/files/upload-chunk - Write one chunk of a large upload
fileBrowserChunkedRoutes.post(
  '/devices/:deviceId/files/upload-chunk',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  requireScriptsExecute,
  zValidator('param', deviceIdParamSchema),
  zValidator('json', fileUploadChunkBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');
    const resolved = await resolveDevice(c, deviceId);
    if ('response' in resolved) return resolved.response;
    const { device } = resolved;

    const body = c.req.valid('json');
    if (isAgentConfigPath(body.path)) {
      return c.json({ error: 'Access to this path is not permitted', code: 'sensitive_path_denied' }, 403);
    }

    const result = await executeCommand(deviceId, CommandTypes.FILE_WRITE_CHUNK, {
      path: body.path,
      transferId: body.transferId,
      offset: body.offset,
      totalSize: body.totalSize,
      content: body.content,
      final: body.final,
      ...(body.sha256 ? { sha256: body.sha256.toLowerCase() } : {}),
    }, { userId: auth.user?.id, timeoutMs: CHUNK_TIMEOUT_MS });

    const failed = isCommandFailure(result);
    if (body.final || failed) {
      await createAuditLog({
        orgId: device.orgId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'file_upload',
        resourceType: 'device',
        resourceId: deviceId,
        resourceName: device.hostname ?? device.id,
        details: {
          path: body.path,
          encoding: 'base64',
          sizeBytes: body.totalSize,
          chunked: true,
          transferId: body.transferId,
          ...(body.sha256 ? { sha256: body.sha256.toLowerCase() } : {}),
          ...(failed ? { failedAtOffset: body.offset } : {}),
        },
        ipAddress: getTrustedClientIpOrUndefined(c),
        result: failed ? 'failure' : 'success',
        errorMessage: failed ? auditErrorMessage(result) : undefined,
      });
    }

    if (failed) {
      if (isUnknownChunkCommand(result)) {
        return c.json({ error: AGENT_UPDATE_REQUIRED_MESSAGE, code: AGENT_UPDATE_REQUIRED_CODE }, 409);
      }
      const { status, ...payload } = buildSingleItemUploadBody(result, 'Failed to write file chunk.');
      return c.json(payload, status);
    }

    const data = parseStdout(result) ?? {};
    return c.json({
      success: true,
      data: {
        path: typeof data.path === 'string' ? data.path : body.path,
        received: body.offset + Buffer.from(body.content, 'base64').length,
        complete: data.complete === true,
      },
    });
  }
);

// POST /devices/:deviceId/files/upload-abort - Discard a partial upload
fileBrowserChunkedRoutes.post(
  '/devices/:deviceId/files/upload-abort',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  requireScriptsExecute,
  zValidator('param', deviceIdParamSchema),
  zValidator('json', fileUploadAbortBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');
    const resolved = await resolveDevice(c, deviceId);
    if ('response' in resolved) return resolved.response;

    const body = c.req.valid('json');
    if (isAgentConfigPath(body.path)) {
      return c.json({ error: 'Access to this path is not permitted', code: 'sensitive_path_denied' }, 403);
    }

    const result = await executeCommand(deviceId, CommandTypes.FILE_WRITE_CHUNK, {
      path: body.path,
      transferId: body.transferId,
      abort: true,
    }, { userId: auth.user?.id, timeoutMs: 30_000 });

    if (isCommandFailure(result)) {
      if (isUnknownChunkCommand(result)) {
        return c.json({ error: AGENT_UPDATE_REQUIRED_MESSAGE, code: AGENT_UPDATE_REQUIRED_CODE }, 409);
      }
      const { message, status, code } = mapCommandFailure(result, 'Failed to discard partial upload.');
      return c.json({ error: message, code }, status);
    }
    return c.json({ success: true });
  }
);

// GET /devices/:deviceId/files/download-chunk - Read one chunk of a large download
fileBrowserChunkedRoutes.get(
  '/devices/:deviceId/files/download-chunk',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', fileDownloadChunkQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const query = c.req.valid('query');
    const auth = c.get('auth');
    const resolved = await resolveDevice(c, deviceId);
    if ('response' in resolved) return resolved.response;
    const { device } = resolved;

    // Same parity rule as the single-shot download (requireDevicesExecute).
    if (!(await requireDevicesExecute(c, auth))) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    if (isAgentConfigPath(query.path)) {
      return c.json({ error: 'Access to this path is not permitted', code: 'sensitive_path_denied' }, 403);
    }

    const result = await executeCommand(deviceId, CommandTypes.FILE_READ_CHUNK, {
      path: query.path,
      offset: query.offset,
      ...(query.length ? { length: query.length } : {}),
      withHash: query.withHash,
    }, { userId: auth.user?.id, timeoutMs: CHUNK_TIMEOUT_MS });

    if (isCommandFailure(result)) {
      if (isUnknownChunkCommand(result)) {
        return c.json({ error: AGENT_UPDATE_REQUIRED_MESSAGE, code: AGENT_UPDATE_REQUIRED_CODE }, 409);
      }
      const { message, status, code } = mapCommandFailure(result, 'Failed to read file.');
      return c.json({ error: message, code }, status);
    }

    const data = parseStdout(result);
    const content = typeof data?.content === 'string' ? data.content : null;
    const size = typeof data?.size === 'number' ? data.size : null;
    if (
      !data || content === null || size === null
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)
    ) {
      // 500, not 502: Cloudflare replaces an origin 502 body with its own page.
      return c.json({ error: 'Invalid file payload from agent', code: 'invalid_agent_response' }, 500);
    }

    if (query.offset === 0) {
      auditSensitiveRead(c, {
        action: 'file.download',
        orgId: device.orgId,
        resourceType: 'device_file',
        resourceId: deviceId,
        format: 'binary',
        rowCount: 1,
        byteCount: size,
      });
    }

    return c.json({
      data: {
        path: typeof data.path === 'string' ? data.path : query.path,
        size,
        offset: query.offset,
        content,
        modified: typeof data.modified === 'string' ? data.modified : null,
        eof: data.eof === true,
        ...(typeof data.sha256 === 'string' ? { sha256: data.sha256 } : {}),
      },
    });
  }
);
