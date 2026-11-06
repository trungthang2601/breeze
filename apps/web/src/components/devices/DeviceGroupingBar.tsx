/**
 * Fork: "Group by" chips for the Devices & Assets list. Each chip (Site, CPU,
 * RAM, Disks, Mainboard) opens a menu with a "group by this" switch and a
 * checkbox per value to show or hide those devices.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import type { Device } from "./DeviceList";
import {
  GROUP_DIMENSIONS,
  UNKNOWN_VALUE,
  bucketCounts,
  type ExcludedValues,
  type GroupDimension,
  type GroupingConfig,
  type HardwareDimension,
} from "./deviceGrouping";

type Props = {
  /** Devices after every other filter, before these value filters (for counts). */
  devices: readonly Device[];
  config: GroupingConfig;
  excluded: ExcludedValues;
  onConfigChange: (next: GroupingConfig) => void;
  onExcludedChange: (next: ExcludedValues) => void;
};

export const dimensionLabelKey: Record<GroupDimension, string> = {
  site: "deviceGrouping.dimension.site",
  cpu: "deviceGrouping.dimension.cpu",
  ram: "deviceGrouping.dimension.ram",
  disk: "deviceGrouping.dimension.disk",
  board: "deviceGrouping.dimension.board",
};

export function DeviceGroupingBar({ devices, config, excluded, onConfigChange, onExcludedChange }: Props) {
  const { t } = useTranslation("devices");
  const [open, setOpen] = useState<GroupDimension | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const counts = useMemo(
    () => (open ? bucketCounts(devices, open) : []),
    [devices, open],
  );

  const isGrouped = (dim: GroupDimension) =>
    dim === "site" ? config.bySite : config.hardware.includes(dim as HardwareDimension);
  const order = (dim: GroupDimension) => {
    if (dim === "site") return config.bySite ? 1 : 0;
    const i = config.hardware.indexOf(dim as HardwareDimension);
    return i < 0 ? 0 : i + 1 + (config.bySite ? 1 : 0);
  };
  const toggleGroup = (dim: GroupDimension) => {
    if (dim === "site") {
      onConfigChange({ ...config, bySite: !config.bySite });
      return;
    }
    const h = dim as HardwareDimension;
    onConfigChange({
      ...config,
      hardware: config.hardware.includes(h)
        ? config.hardware.filter((x) => x !== h)
        : [...config.hardware, h],
    });
  };
  const setExcluded = (dim: GroupDimension, values: string[]) =>
    onExcludedChange({ ...excluded, [dim]: values });

  const valueLabel = (v: string) => (v === UNKNOWN_VALUE ? t("deviceGrouping.unknown") : v);

  return (
    <div
      ref={rootRef}
      className="flex flex-wrap items-center gap-2"
      data-testid="device-grouping-bar"
    >
      <span className="text-sm text-muted-foreground">{t("deviceGrouping.groupBy")}</span>
      {GROUP_DIMENSIONS.map((dim) => {
        const grouped = isGrouped(dim);
        const ex = excluded[dim] ?? [];
        const isOpen = open === dim;
        const label = t(/* i18n-dynamic */ dimensionLabelKey[dim]);
        const n = order(dim);
        return (
          <div key={dim} className="relative">
            <button
              type="button"
              data-testid={`device-grouping-chip-${dim}`}
              aria-haspopup="dialog"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : dim)}
              className={`flex h-8 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-sm font-medium ${
                grouped
                  ? "border-primary bg-primary text-primary-foreground"
                  : ex.length > 0
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {grouped && n > 0 ? `${n}. ` : ""}
              {label}
              {ex.length > 0 ? ` (${t("deviceGrouping.filteredBadge", { count: ex.length })})` : ""}
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {isOpen && (
              <div
                role="dialog"
                aria-label={label}
                data-testid={`device-grouping-menu-${dim}`}
                className="absolute left-0 top-10 z-30 flex max-h-96 w-72 flex-col gap-0.5 overflow-hidden rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg"
              >
                <label className="flex cursor-pointer items-center justify-between gap-2 rounded-md bg-muted px-2 py-2 text-sm font-medium">
                  <span>{t("deviceGrouping.groupByThis", { name: label })}</span>
                  <input
                    type="checkbox"
                    checked={grouped}
                    onChange={() => toggleGroup(dim)}
                    data-testid={`device-grouping-toggle-${dim}`}
                    className="h-4 w-4"
                  />
                </label>
                <div className="flex items-center justify-between px-2 pb-1 pt-2 text-xs text-muted-foreground">
                  <span>{t("deviceGrouping.show")}</span>
                  <span className="flex gap-3">
                    <button type="button" className="text-primary hover:underline" onClick={() => setExcluded(dim, [])}>
                      {t("deviceGrouping.selectAll")}
                    </button>
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onClick={() => setExcluded(dim, counts.map((c) => c.value))}
                    >
                      {t("deviceGrouping.selectNone")}
                    </button>
                  </span>
                </div>
                <div className="flex flex-col overflow-y-auto">
                  {counts.length === 0 && (
                    <span className="px-2 py-2 text-sm text-muted-foreground">{t("deviceGrouping.noValues")}</span>
                  )}
                  {counts.map(({ value, count }) => {
                    const checked = !ex.includes(value);
                    return (
                      <label
                        key={value}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setExcluded(dim, checked ? [...ex, value] : ex.filter((x) => x !== value))
                          }
                          className="h-4 w-4"
                        />
                        <span className={`flex-1 truncate ${value === UNKNOWN_VALUE ? "italic text-muted-foreground" : ""}`}>
                          {valueLabel(value)}
                        </span>
                        <span className="tabular-nums text-muted-foreground">{count}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
