import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPdfFont, resetPdfFontCache } from './pdfFont';

const ttf = () => new Uint8Array([0, 1, 0, 0, 65, 66]).buffer;
const ok = (body: ArrayBuffer) => ({ ok: true, status: 200, arrayBuffer: async () => body }) as unknown as Response;

afterEach(() => {
  resetPdfFontCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('loadPdfFont (fork)', () => {
  it('fetches both weights once and returns them base64-encoded', async () => {
    const fetchMock = vi.fn(async (_url: string) => ok(ttf()));
    vi.stubGlobal('fetch', fetchMock);
    const font = await loadPdfFont();
    expect(font).toEqual({ regular: 'AAEAAEFC', bold: 'AAEAAEFC' });
    await loadPdfFont();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/fonts/pdf/BeVietnamPro-Regular.ttf', '/fonts/pdf/BeVietnamPro-Bold.ttf']);
  });

  it('returns null (and retries later) when the font is missing or not a font', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as Response));
    expect(await loadPdfFont()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => ok(new TextEncoder().encode('<html>').buffer as ArrayBuffer)));
    expect(await loadPdfFont()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => ok(ttf())));
    expect(await loadPdfFont()).not.toBeNull();
  });
});
