// Fork: PDF export of the Devices & Assets list, split into the groups the
// list is showing. Loaded on demand (jsPDF is heavy).
import { buildDeviceListPdf, pdfTranslator, type DeviceListPdfSection, type PdfTranslator } from '@breeze/shared/reportPdf';
import { loadPdfFont, pdfLocale } from '@/lib/pdfFont';
import { loadPartnerBranding } from '../reports/reportExport';
import { formatDateTime } from '@/lib/dateTimeFormat';
import type { Device } from './DeviceList';
import {
  UNKNOWN_VALUE,
  buildGroupedItems,
  type GroupDimension,
  type GroupingConfig,
} from './deviceGrouping';

type Input = {
  table: { header: string[]; rows: Array<Array<string | number>> };
  /** The exported devices, same order as `table.rows`. */
  devices: readonly Device[];
  grouping: GroupingConfig | null;
  unknownLabel: string;
  dimensionLabel: (d: GroupDimension) => string;
  title: string;
  timezone?: string;
  /** UI language; defaults to the current one. */
  locale?: string;
};

/** Translator for the PDF's column headers, in the current UI language. */
export function deviceListPdfTranslator(): PdfTranslator {
  return pdfTranslator(pdfLocale());
}

const countsLabel = (T: PdfTranslator, count: number, online: number, sep: string): string =>
  `${T(count === 1 ? '{count} device' : '{count} devices', { count })}${sep}${T('{count} online', { count: online })}`;

export function buildDeviceListPdfSections(input: Input): DeviceListPdfSection[] {
  const T = pdfTranslator(input.locale ?? pdfLocale());
  const rowById = new Map<string, string[]>();
  input.devices.forEach((d, i) => rowById.set(d.id, (input.table.rows[i] ?? []).map((c) => String(c ?? ''))));
  if (!input.grouping) {
    return [{ title: null, rows: input.devices.map((d) => rowById.get(d.id) ?? []) }];
  }
  const label = (values: string[]) => values.map((v) => (v === UNKNOWN_VALUE ? input.unknownLabel : v)).join(' · ');
  const sections: DeviceListPdfSection[] = [];
  let current: DeviceListPdfSection | null = null;
  for (const item of buildGroupedItems(input.devices, input.grouping, new Set())) {
    if (item.type === 'header') {
      const h = item.header;
      current = {
        title: `${label(h.values)}   ·   ${countsLabel(T, h.count, h.online, ', ')}`,
        level: h.level,
        rows: [],
      };
      sections.push(current);
    } else if (current) {
      current.rows.push(rowById.get(item.device.id) ?? []);
    }
  }
  return sections;
}

export async function buildDeviceListPdfBlob(input: Input): Promise<Blob> {
  const branding = await loadPartnerBranding().catch(() => undefined);
  const locale = input.locale ?? pdfLocale();
  const T = pdfTranslator(locale);
  const font = await loadPdfFont();
  const timezone = input.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const g = input.grouping;
  const groupedBy = g
    ? [...(g.bySite ? (['site'] as const) : []), ...g.hardware].map((d) => input.dimensionLabel(d)).join(' + ')
    : '';
  const online = input.devices.filter((d) => d.status === 'online').length;
  const meta = countsLabel(T, input.devices.length, online, '   ·   ')
    + (groupedBy ? `   ·   ${T('grouped by {groups}', { groups: groupedBy })}` : '');
  const doc = buildDeviceListPdf(
    { title: input.title, meta, columns: input.table.header, sections: buildDeviceListPdfSections(input) },
    { generatedAt: formatDateTime(new Date(), { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }), timezone, branding, font, locale },
  );
  return doc.output('blob');
}
