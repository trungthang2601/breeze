// Chunked File Browser transfers: files above the single-shot caps, up to
// AGENT_MAX_CHUNKED_TRANSFER_BYTES. The browser drives one chunk per request.
// The agent assembles uploads in a temp file and renames it into place only
// once the SHA-256 of the whole file matches, so a failed or cancelled upload
// never leaves a partial file at the destination. Downloads are verified the
// same way here before anything is saved. Protocol:
// agent/internal/remote/tools/fileops_chunked.go.
import { fetchWithAuth } from '@/stores/auth';

/** Machine-readable reasons a chunked transfer stops, for localized copy. */
export type ChunkedTransferErrorCode =
  | 'agent_update_required'
  | 'checksum_mismatch'
  | 'file_changed'
  | 'secure_context_required';

export class ChunkedTransferError extends Error {
  readonly code: ChunkedTransferErrorCode;
  constructor(code: ChunkedTransferErrorCode, message: string) {
    super(message);
    this.name = 'ChunkedTransferError';
    this.code = code;
  }
}

/** Per-request watchdog. A chunk is ~2.8MB of base64; the final upload chunk
 * also hashes the whole file on the device before renaming it. */
export const CHUNK_REQUEST_TIMEOUT_MS = 90_000;
/** Retries for a chunk that failed for a transient reason (network, 5xx). */
export const CHUNK_MAX_RETRIES = 2;

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  // SubtleCrypto exists only in secure contexts (HTTPS or localhost).
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new ChunkedTransferError(
      'secure_context_required',
      'Large file transfers need a secure (HTTPS) connection to verify the file.',
    );
  }
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

class RetryableChunkError extends Error {}

function abortError(): DOMException {
  return new DOMException('The transfer was cancelled.', 'AbortError');
}

// DOMException is not `instanceof Error` in every runtime, so match the name.
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * One chunk request with a watchdog and bounded retries. Retries only what can
 * succeed on a second attempt: network errors, watchdog timeouts and 5xx. A 4xx
 * is a definitive answer (permission, validation, agent refusal) and is thrown.
 * Every chunk is idempotent on the agent (a replayed upload chunk is
 * acknowledged, a read has no side effect), so a retry after a lost reply is
 * safe.
 */
async function chunkRequest(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  fallbackError: string,
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CHUNK_MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const watchdog = setTimeout(() => controller.abort(), CHUNK_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchWithAuth(url, { ...init, signal: controller.signal });
      const json = await response.json().catch(() => ({}));
      if (response.ok) return json as Record<string, unknown>;
      const message = typeof json?.error === 'string' && json.error ? json.error : fallbackError;
      if (json?.code === 'agent_update_required') {
        throw new ChunkedTransferError('agent_update_required', message);
      }
      if (response.status >= 500) throw new RetryableChunkError(message);
      throw new Error(message);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      // Watchdog abort, network failure (TypeError from fetch) or a 5xx.
      const retryable = error instanceof RetryableChunkError || isAbort(error) || error instanceof TypeError;
      if (!retryable) throw error;
      lastError = error;
    } finally {
      clearTimeout(watchdog);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  if (lastError instanceof RetryableChunkError) throw new Error(lastError.message);
  throw new Error(fallbackError);
}

export type ChunkProgress = (transferredBytes: number, totalBytes: number) => void;

export type ChunkedTransferOptions = {
  chunkSize: number;
  signal?: AbortSignal;
  onProgress?: ChunkProgress;
};

export async function uploadFileChunked(
  deviceId: string,
  file: Blob,
  remotePath: string,
  opts: ChunkedTransferOptions,
): Promise<{ path: string }> {
  const transferId = crypto.randomUUID();
  const url = `/system-tools/devices/${deviceId}/files/upload-chunk`;
  const total = file.size;
  const hash = await sha256Hex(await file.arrayBuffer());
  let path = remotePath;
  let started = false;

  try {
    let offset = 0;
    do {
      if (opts.signal?.aborted) throw abortError();
      const end = Math.min(offset + opts.chunkSize, total);
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      const final = end >= total;
      started = true;
      const json = await chunkRequest(url, {
        method: 'POST',
        body: JSON.stringify({
          path: remotePath,
          transferId,
          offset,
          totalSize: total,
          content: bytesToBase64(bytes),
          final,
          ...(final ? { sha256: hash } : {}),
        }),
      }, opts.signal, 'Upload failed');
      const data = json.data as { path?: unknown } | undefined;
      if (typeof data?.path === 'string') path = data.path;
      offset = end;
      opts.onProgress?.(offset, total);
    } while (offset < total);
    return { path };
  } catch (error) {
    // Best effort: drop the device-side temp file. The agent also sweeps
    // abandoned ones after 24h, so a failure here is harmless.
    const unsupported = error instanceof ChunkedTransferError && error.code === 'agent_update_required';
    if (started && !unsupported) {
      fetchWithAuth(`/system-tools/devices/${deviceId}/files/upload-abort`, {
        method: 'POST',
        body: JSON.stringify({ path: remotePath, transferId }),
      }).catch(() => undefined);
    }
    throw error;
  }
}

export async function downloadFileChunked(
  deviceId: string,
  remotePath: string,
  opts: ChunkedTransferOptions,
): Promise<Blob> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let expected: { size: number; modified: unknown; sha256: string } | null = null;

  for (;;) {
    const params = new URLSearchParams({
      path: remotePath,
      offset: String(offset),
      length: String(opts.chunkSize),
      ...(offset === 0 ? { withHash: 'true' } : {}),
    });
    const json = await chunkRequest(
      `/system-tools/devices/${deviceId}/files/download-chunk?${params}`,
      { method: 'GET' },
      opts.signal,
      'Download failed',
    );
    const data = json.data as
      | { size?: unknown; modified?: unknown; content?: unknown; eof?: unknown; sha256?: unknown }
      | undefined;
    if (!data || typeof data.size !== 'number' || typeof data.content !== 'string') {
      throw new Error('Invalid file payload from device');
    }
    if (expected === null) {
      if (typeof data.sha256 !== 'string') throw new Error('Invalid file payload from device');
      expected = { size: data.size, modified: data.modified, sha256: data.sha256 };
    } else if (data.size !== expected.size || data.modified !== expected.modified) {
      throw new ChunkedTransferError('file_changed', 'The file changed on the device during the download.');
    }
    const bytes = base64ToBytes(data.content);
    parts.push(bytes);
    offset += bytes.length;
    opts.onProgress?.(offset, expected.size);
    if (data.eof === true || offset >= expected.size) break;
    if (bytes.length === 0) throw new Error('Invalid file payload from device');
  }

  const blob = new Blob(parts as BlobPart[]);
  if (blob.size !== expected.size || (await sha256Hex(await blob.arrayBuffer())) !== expected.sha256) {
    throw new ChunkedTransferError(
      'checksum_mismatch',
      'The downloaded file did not match the checksum on the device.',
    );
  }
  return blob;
}
