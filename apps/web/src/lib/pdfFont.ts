// Fork: Unicode font + UI language for PDF exports. jsPDF's built-in Helvetica
// has no Vietnamese glyphs, so the PDF builders embed Be Vietnam Pro (OFL,
// served from /fonts/pdf/) when it loads; if it does not, they fall back to
// Helvetica with diacritics folded to ASCII, as before.
import i18next from 'i18next';
import type { PdfFont } from '@breeze/shared/reportPdf';

export const PDF_FONT_URLS = {
  regular: '/fonts/pdf/BeVietnamPro-Regular.ttf',
  bold: '/fonts/pdf/BeVietnamPro-Bold.ttf',
} as const;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function fetchFont(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`font ${url}: HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  // A TrueType file starts 00 01 00 00; anything else (an HTML error page) is not a font.
  const head = new Uint8Array(buffer.slice(0, 4));
  if (!(head[0] === 0 && head[1] === 1 && head[2] === 0 && head[3] === 0)) throw new Error(`font ${url}: not a TrueType file`);
  return toBase64(buffer);
}

let cached: Promise<PdfFont | null> | null = null;

/** The embedded PDF font, fetched once per page; null when it cannot be loaded. */
export function loadPdfFont(): Promise<PdfFont | null> {
  if (!cached) {
    cached = Promise.all([fetchFont(PDF_FONT_URLS.regular), fetchFont(PDF_FONT_URLS.bold)])
      .then(([regular, bold]) => ({ regular, bold }))
      .catch((err) => {
        console.warn('[pdf] Unicode font unavailable; exporting with ASCII-folded text', err);
        cached = null; // retry on the next export
        return null;
      });
  }
  return cached;
}

/** The UI language the PDF should be written in. */
export function pdfLocale(): string {
  return i18next.resolvedLanguage ?? i18next.language ?? 'en';
}

/** Test hook. */
export function resetPdfFontCache(): void {
  cached = null;
}
