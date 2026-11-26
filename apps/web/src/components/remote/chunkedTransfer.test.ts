// @vitest-environment node
// Node 22 provides Blob, atob/btoa and WebCrypto (crypto.subtle) as globals;
// jsdom adds nothing this module needs.
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: fetchWithAuthMock }));

import {
  ChunkedTransferError,
  base64ToBytes,
  bytesToBase64,
  downloadFileChunked,
  sha256Hex,
  uploadFileChunked,
} from './chunkedTransfer';

const DEVICE = 'dev-1';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function bytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

function hex(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
});

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes, including sizes above the fromCharCode step', () => {
    const b = bytes(100_003);
    expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
    expect(bytesToBase64(b)).toBe(Buffer.from(b).toString('base64'));
  });

  it('hashes like node:crypto', async () => {
    const b = bytes(1234);
    expect(await sha256Hex(b.slice().buffer)).toBe(hex(b));
  });
});

describe('uploadFileChunked', () => {
  it('sends ordered chunks and the whole-file hash only on the final chunk', async () => {
    const data = bytes(25);
    const sent: Array<Record<string, unknown>> = [];
    fetchWithAuthMock.mockImplementation(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return json(200, { success: true, data: { path: '/remote/f.bin' } });
    });
    const progress: number[] = [];

    const result = await uploadFileChunked(DEVICE, new Blob([data]), '/remote/f.bin', {
      chunkSize: 10,
      onProgress: (done) => progress.push(done),
    });

    expect(result.path).toBe('/remote/f.bin');
    expect(sent.map((c) => c.offset)).toEqual([0, 10, 20]);
    expect(sent.map((c) => c.final)).toEqual([false, false, true]);
    expect(sent.every((c) => c.transferId === sent[0]!.transferId && c.totalSize === 25)).toBe(true);
    expect(sent[2]!.sha256).toBe(hex(data));
    expect(sent[0]!.sha256).toBeUndefined();
    const reassembled = new Uint8Array(sent.flatMap((c) => [...base64ToBytes(String(c.content))]));
    expect(reassembled).toEqual(data);
    expect(progress).toEqual([10, 20, 25]);
  });

  it('sends a single final chunk for an empty file', async () => {
    fetchWithAuthMock.mockResolvedValue(json(200, { success: true, data: {} }));
    await uploadFileChunked(DEVICE, new Blob([]), '/remote/empty', { chunkSize: 10 });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchWithAuthMock.mock.calls[0]![1].body))).toMatchObject({ offset: 0, final: true, totalSize: 0 });
  });

  it('retries a chunk after a 5xx, then continues', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(json(503, { error: 'busy' }))
      .mockResolvedValue(json(200, { success: true, data: {} }));

    await uploadFileChunked(DEVICE, new Blob([bytes(5)]), '/remote/f', { chunkSize: 10 });

    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });

  it('stops on a 4xx without retrying and discards the partial upload', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) =>
      url.endsWith('/upload-abort') ? json(200, { success: true }) : json(422, { error: 'chunk offset mismatch' }));

    await expect(uploadFileChunked(DEVICE, new Blob([bytes(5)]), '/remote/f', { chunkSize: 10 }))
      .rejects.toThrow('chunk offset mismatch');

    const urls = fetchWithAuthMock.mock.calls.map((c) => c[0] as string);
    expect(urls.filter((u) => u.endsWith('/upload-chunk'))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith('/upload-abort'))).toHaveLength(1);
  });

  it('reports an old agent as agent_update_required and sends no abort', async () => {
    fetchWithAuthMock.mockResolvedValue(json(409, { error: 'too old', code: 'agent_update_required' }));

    const err = await uploadFileChunked(DEVICE, new Blob([bytes(5)]), '/remote/f', { chunkSize: 10 }).catch((e) => e);

    expect(err).toBeInstanceOf(ChunkedTransferError);
    expect((err as ChunkedTransferError).code).toBe('agent_update_required');
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('honours a cancel between chunks', async () => {
    const controller = new AbortController();
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/upload-chunk')) controller.abort();
      return json(200, { success: true, data: {} });
    });

    const err = await uploadFileChunked(DEVICE, new Blob([bytes(25)]), '/remote/f', {
      chunkSize: 10,
      signal: controller.signal,
    }).catch((e) => e);

    expect((err as { name?: string }).name).toBe('AbortError');
    const urls = fetchWithAuthMock.mock.calls.map((c) => c[0] as string);
    expect(urls.filter((u) => u.endsWith('/upload-chunk'))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith('/upload-abort'))).toHaveLength(1);
  });
});

describe('downloadFileChunked', () => {
  function serve(data: Uint8Array, opts: { modifiedAfterFirst?: string; hash?: string } = {}) {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      const q = new URL(url, 'http://x').searchParams;
      const offset = Number(q.get('offset'));
      const length = Number(q.get('length'));
      const slice = data.slice(offset, offset + length);
      return json(200, {
        data: {
          size: data.length,
          offset,
          content: Buffer.from(slice).toString('base64'),
          modified: offset > 0 && opts.modifiedAfterFirst ? opts.modifiedAfterFirst : '2026-11-26T10:00:00Z',
          eof: offset + slice.length >= data.length,
          ...(q.get('withHash') === 'true' ? { sha256: opts.hash ?? hex(data) } : {}),
        },
      });
    });
  }

  it('reassembles the file and verifies it against the device hash', async () => {
    const data = bytes(27);
    serve(data);

    const blob = await downloadFileChunked(DEVICE, '/remote/f', { chunkSize: 10 });

    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data);
    const offsets = fetchWithAuthMock.mock.calls.map((c) => new URL(c[0] as string, 'http://x').searchParams.get('offset'));
    expect(offsets).toEqual(['0', '10', '20']);
  });

  it('rejects a file whose bytes do not match the hash', async () => {
    serve(bytes(27), { hash: 'f'.repeat(64) });
    const err = await downloadFileChunked(DEVICE, '/remote/f', { chunkSize: 10 }).catch((e) => e);
    expect((err as ChunkedTransferError).code).toBe('checksum_mismatch');
  });

  it('rejects a file that changed mid-download', async () => {
    serve(bytes(27), { modifiedAfterFirst: '2026-11-26T11:00:00Z' });
    const err = await downloadFileChunked(DEVICE, '/remote/f', { chunkSize: 10 }).catch((e) => e);
    expect((err as ChunkedTransferError).code).toBe('file_changed');
  });
});
