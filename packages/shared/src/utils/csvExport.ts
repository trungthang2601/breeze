/**
 * Shared CSV/TSV cell helpers + row serializers, with spreadsheet-formula-injection
 * neutralization. Kept free of heavy deps (no jsPDF) so both the API (server-side
 * report download) and the web app can import them. `apps/web/src/lib/csvExport.ts`
 * re-exports these for back-compat, and `apps/api/src/services/spreadsheetExport.ts`
 * is a thin compat shim over this module — this file is the single implementation.
 *
 * Every CSV/TSV cell Breeze emits goes through `escapeCsvCell` /
 * `escapeTsvCell` (directly or via `csvRow` / `tsvRow` / `toCsv` / `rowsToCsv` /
 * `rowsToTsv`) — **header cells included**. Headers are not always static
 * literals: `rowsToCsv`/`rowsToTsv` derive them from `Object.keys` of report
 * rows and arbitrary exported datasets, so a custom-field name or SQL alias can
 * end up in the header row.
 */

const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r', '\n']);

/**
 * Neutralize a value a spreadsheet would interpret as a formula by prefixing a
 * single quote when it starts with a dangerous character. Standard CSV-injection
 * mitigation for dynamic content (e.g. agent-supplied event-log text).
 */
export function neutralizeSpreadsheetFormula(value: string): string {
  if (value.length === 0) return value;
  return FORMULA_PREFIXES.has(value[0]!) ? `'${value}` : value;
}

/**
 * Coerce an arbitrary cell value to its display string. `Date` becomes an ISO
 * timestamp; `null`/`undefined` become an empty cell. Objects intentionally
 * stringify the JS way (`[object Object]`) — callers that export jsonb columns
 * JSON-encode them first (see `aiToolsExportWriter`), and doing it here would
 * double-encode those.
 */
export function csvCellToString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

/** Neutralize then RFC-4180-quote a CSV cell. */
export function escapeCsvCell(value: unknown): string {
  const safe = neutralizeSpreadsheetFormula(csvCellToString(value));
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Neutralize then quote a TSV cell only when it contains tab/quote/newline. */
export function escapeTsvCell(value: unknown): string {
  const safe = neutralizeSpreadsheetFormula(csvCellToString(value));
  return /[\t\r\n"]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Render one CSV line, escaping every field. Use this for header rows too. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(escapeCsvCell).join(',');
}

/** Render one TSV line, escaping every field. Use this for header rows too. */
export function tsvRow(values: readonly unknown[]): string {
  return values.map(escapeTsvCell).join('\t');
}

/**
 * Serialize a header row + body rows to a CSV string, neutralizing every cell.
 * Cells are coerced to strings first.
 */
export function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  return [header, ...rows].map(csvRow).join('\n');
}

/** Derive headers from the first row's keys and a string[][] body. */
function extractTable(rows: unknown[]): { headers: string[]; body: string[][] } {
  const headers = Object.keys(rows[0] as Record<string, unknown>);
  const body = rows.map((row) => {
    const record = row as Record<string, unknown>;
    return headers.map((h) => csvCellToString(record[h]));
  });
  return { headers, body };
}

/** Serialize report rows to CSV (header from first row's keys). Empty input → ''. */
export function rowsToCsv(rows: unknown[]): string {
  if (rows.length === 0) return '';
  const { headers, body } = extractTable(rows);
  return [csvRow(headers), ...body.map(csvRow)].join('\n');
}

/** Serialize report rows to TSV (Excel-compatible). Empty input → ''. */
export function rowsToTsv(rows: unknown[]): string {
  if (rows.length === 0) return '';
  const { headers, body } = extractTable(rows);
  return [tsvRow(headers), ...body.map(tsvRow)].join('\n');
}

/**
 * Excel guesses the encoding of a CSV/TSV it opens. Without a byte-order mark
 * it assumes the Windows ANSI code page, so UTF-8 Vietnamese ("ICOOL BÌNH PHÚ")
 * turns into mojibake ("ICOOL BÃŒNH PHÃš"). These helpers make the bytes say
 * what they are.
 */
export const UTF8_BOM = '\uFEFF';

/** CSV text with a UTF-8 BOM (idempotent). Encode the result as UTF-8. */
export function withUtf8Bom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text : UTF8_BOM + text;
}

/**
 * Tab-separated text as UTF-16LE with a BOM — the "Unicode Text" format Excel
 * opens directly, tabs split into columns and every accent intact (Excel
 * ignores a UTF-8 BOM on tab-separated files served as .xls).
 */
export function toUtf16LeWithBom(text: string): Uint8Array {
  const body = text.startsWith(UTF8_BOM) ? text.slice(1) : text;
  const out = new Uint8Array(2 + body.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < body.length; i += 1) {
    const code = body.charCodeAt(i);
    out[2 + i * 2] = code & 0xff;
    out[3 + i * 2] = code >> 8;
  }
  return out;
}
