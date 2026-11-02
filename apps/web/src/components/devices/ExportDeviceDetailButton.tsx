import { useEffect, useRef, useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { isDeviceDetailSummary } from "@breeze/shared";
import { fetchWithAuth } from "../../stores/auth";
import { usePermissions } from "@/lib/permissions";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

type Props = {
  deviceId: string;
  orgId?: string | null;
  hostname?: string | null;
};

/**
 * "Export PDF" on the device page: runs the Device Detail report
 * (device_inventory, layout 'detail') for this one device and downloads the
 * one-page PDF. Software list is opt-in. Hidden without reports:export —
 * the API re-checks it on POST /reports/generate.
 */
export default function ExportDeviceDetailButton({ deviceId, orgId, hostname }: Props) {
  const { t } = useTranslation("devices");
  const { can } = usePermissions();
  const [open, setOpen] = useState(false);
  const [includeSoftware, setIncludeSoftware] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!can("reports", "export")) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithAuth("/reports/generate", {
        method: "POST",
        body: JSON.stringify({
          type: "device_inventory",
          format: "pdf",
          ...(orgId ? { orgId } : {}),
          config: {
            layout: "detail",
            includeSoftware,
            filters: { deviceIds: [deviceId] },
          },
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        data?: { rows?: unknown[]; summary?: unknown };
      };
      if (!res.ok) throw new Error(payload.error || t("exportDeviceDetail.failed"));
      const summary = payload.data?.summary;
      if (!isDeviceDetailSummary(summary) || summary.devices.length === 0) {
        throw new Error(t("exportDeviceDetail.failed"));
      }
      // Loaded lazily: jsPDF is only needed when someone actually exports.
      const { exportReport, getBrowserTimezone } = await import("../reports/reportExport");
      await exportReport(payload.data?.rows ?? [], {
        format: "pdf",
        reportType: "device_inventory",
        timezone: getBrowserTimezone(),
        summary,
        filename: `device-detail-${(hostname || deviceId).replace(/[^A-Za-z0-9._-]+/g, "_")}`,
      });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("exportDeviceDetail.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted"
        data-testid="export-device-detail"
      >
        <FileDown className="h-4 w-4" />
        {t("exportDeviceDetail.button")}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-72 rounded-md border bg-card p-3 shadow-lg">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeSoftware}
              onChange={(e) => setIncludeSoftware(e.target.checked)}
              className="h-4 w-4 rounded border"
            />
            {t("exportDeviceDetail.includeSoftware")}
          </label>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy}
            className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? t("exportDeviceDetail.working") : t("exportDeviceDetail.download")}
          </button>
        </div>
      )}
    </div>
  );
}
