import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { executeCommandMock, getDeviceMock, createAuditLogMock, auditSensitiveReadMock, requireDevicesExecuteMock } =
  vi.hoisted(() => ({
    executeCommandMock: vi.fn(),
    getDeviceMock: vi.fn(),
    createAuditLogMock: vi.fn(),
    auditSensitiveReadMock: vi.fn(),
    requireDevicesExecuteMock: vi.fn(),
  }));

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const TRANSFER_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HASH = 'a'.repeat(64);

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', {
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'tech@example.com' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
    });
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  // The scripts:execute gate is covered by fileWriteRequiresScriptsExecute.test.ts.
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: executeCommandMock,
  CommandTypes: { FILE_WRITE_CHUNK: 'file_write_chunk', FILE_READ_CHUNK: 'file_read_chunk' },
}));

vi.mock('../../services/auditService', () => ({ createAuditLog: createAuditLogMock }));
vi.mock('../../services/sensitiveReadAudit', () => ({ auditSensitiveRead: auditSensitiveReadMock }));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));

vi.mock('./helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./helpers')>();
  return {
    ...actual,
    getDeviceWithOrgAndSiteCheck: getDeviceMock,
    requireDevicesExecute: requireDevicesExecuteMock,
  };
});

import { fileBrowserChunkedRoutes } from './fileBrowserChunked';
import { SITE_ACCESS_DENIED } from './helpers';

function app() {
  const instance = new Hono();
  instance.route('/', fileBrowserChunkedRoutes);
  return instance;
}

function postChunk(body: Record<string, unknown>) {
  return app().request(`/devices/${DEVICE_ID}/files/upload-chunk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getChunk(query: Record<string, string>) {
  return app().request(`/devices/${DEVICE_ID}/files/download-chunk?${new URLSearchParams(query)}`);
}

const CHUNK = {
  path: '/tmp/big.bin',
  transferId: TRANSFER_ID,
  offset: 0,
  totalSize: 10,
  content: 'aGVsbG8=', // "hello"
};

beforeEach(() => {
  vi.clearAllMocks();
  getDeviceMock.mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'device-1' });
  requireDevicesExecuteMock.mockResolvedValue(true);
  createAuditLogMock.mockResolvedValue(undefined);
});

describe('POST /files/upload-chunk', () => {
  it('relays a middle chunk without auditing it', async () => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ path: '/tmp/big.bin', received: 5 }) });

    const res = await postChunk(CHUNK);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, data: { received: 5, complete: false } });
    expect(executeCommandMock).toHaveBeenCalledWith(
      DEVICE_ID,
      'file_write_chunk',
      expect.objectContaining({ path: '/tmp/big.bin', transferId: TRANSFER_ID, offset: 0, totalSize: 10, final: false }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(createAuditLogMock).not.toHaveBeenCalled();
  });

  it('audits the final chunk once, with the whole-file size and hash', async () => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ path: '/tmp/big.bin', complete: true }) });

    const res = await postChunk({ ...CHUNK, offset: 5, final: true, sha256: HASH.toUpperCase() });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { complete: true } });
    expect(executeCommandMock.mock.calls[0]![2]).toMatchObject({ final: true, sha256: HASH });
    expect(createAuditLogMock).toHaveBeenCalledTimes(1);
    expect(createAuditLogMock.mock.calls[0]![0]).toMatchObject({
      action: 'file_upload',
      result: 'success',
      details: expect.objectContaining({ sizeBytes: 10, chunked: true, sha256: HASH }),
    });
  });

  it('requires sha256 on the final chunk', async () => {
    const res = await postChunk({ ...CHUNK, final: true });
    expect(res.status).toBe(400);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('refuses a file over the chunked cap before dispatch', async () => {
    const res = await postChunk({ ...CHUNK, totalSize: 100 * 1024 * 1024 + 1 });
    expect(res.status).toBe(400);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('refuses an invalid transferId and non-base64 content', async () => {
    expect((await postChunk({ ...CHUNK, transferId: '../x' })).status).toBe(400);
    expect((await postChunk({ ...CHUNK, content: 'not base64!' })).status).toBe(400);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('denies the agent config directory', async () => {
    const res = await postChunk({ ...CHUNK, path: String.raw`C:\ProgramData\Breeze\secrets.yaml` });
    expect(res.status).toBe(403);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('answers 404 / 403 for an inaccessible device', async () => {
    getDeviceMock.mockResolvedValueOnce(null);
    expect((await postChunk(CHUNK)).status).toBe(404);
    getDeviceMock.mockResolvedValueOnce(SITE_ACCESS_DENIED);
    expect((await postChunk(CHUNK)).status).toBe(403);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('maps an agent that predates the chunked commands to 409 agent_update_required', async () => {
    executeCommandMock.mockResolvedValue({ status: 'failed', error: 'unknown command type: file_write_chunk' });

    const res = await postChunk(CHUNK);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'agent_update_required' });
    expect(createAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ result: 'failure' }));
  });

  it('surfaces an agent refusal (checksum mismatch) as a 4xx with the agent text', async () => {
    executeCommandMock.mockResolvedValue({
      status: 'failed',
      error: 'upload checksum mismatch: expected sha256 x, got y; the partial file was discarded',
      errorCode: 'invalid_argument',
    });

    const res = await postChunk({ ...CHUNK, offset: 5, final: true, sha256: HASH });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/checksum mismatch/);
  });
});

describe('POST /files/upload-abort', () => {
  it('dispatches an abort for the transfer', async () => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout: '{}' });

    const res = await app().request(`/devices/${DEVICE_ID}/files/upload-abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/big.bin', transferId: TRANSFER_ID }),
    });

    expect(res.status).toBe(200);
    expect(executeCommandMock.mock.calls[0]![2]).toEqual({ path: '/tmp/big.bin', transferId: TRANSFER_ID, abort: true });
  });
});

describe('GET /files/download-chunk', () => {
  const agentChunk = {
    path: '/tmp/big.bin',
    size: 10,
    offset: 0,
    length: 5,
    content: 'aGVsbG8=',
    modified: '2026-11-26T10:00:00Z',
    eof: false,
    sha256: HASH,
  };

  it('returns the chunk and audits the download once, on the first chunk', async () => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout: JSON.stringify(agentChunk) });

    const res = await getChunk({ path: '/tmp/big.bin', offset: '0', withHash: 'true' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { size: 10, content: 'aGVsbG8=', sha256: HASH, eof: false } });
    expect(executeCommandMock.mock.calls[0]![2]).toMatchObject({ offset: 0, withHash: true });
    expect(auditSensitiveReadMock).toHaveBeenCalledTimes(1);
    expect(auditSensitiveReadMock.mock.calls[0]![1]).toMatchObject({ action: 'file.download', byteCount: 10 });
  });

  it('does not re-audit later chunks', async () => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ ...agentChunk, offset: 5, eof: true }) });

    const res = await getChunk({ path: '/tmp/big.bin', offset: '5' });

    expect(res.status).toBe(200);
    expect(auditSensitiveReadMock).not.toHaveBeenCalled();
  });

  it('requires devices:execute', async () => {
    requireDevicesExecuteMock.mockResolvedValue(false);
    const res = await getChunk({ path: '/tmp/big.bin', offset: '0' });
    expect(res.status).toBe(403);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('denies the agent config directory', async () => {
    const res = await getChunk({ path: String.raw`C:\ProgramData\Breeze\secrets.yaml`, offset: '0' });
    expect(res.status).toBe(403);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('refuses a chunk length above the cap', async () => {
    const res = await getChunk({ path: '/tmp/big.bin', offset: '0', length: String(2 * 1024 * 1024 + 1) });
    expect(res.status).toBe(400);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('maps an old agent to 409 agent_update_required', async () => {
    executeCommandMock.mockResolvedValue({ status: 'failed', error: 'unknown command type: file_read_chunk' });
    const res = await getChunk({ path: '/tmp/big.bin', offset: '0' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'agent_update_required' });
  });

  it('answers 500 for a malformed agent payload', async () => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ ...agentChunk, content: '%%%' }) });
    const res = await getChunk({ path: '/tmp/big.bin', offset: '0' });
    expect(res.status).toBe(500);
  });
});
