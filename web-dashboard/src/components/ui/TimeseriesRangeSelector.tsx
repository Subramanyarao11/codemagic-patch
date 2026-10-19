// Shared 7d / 30d / 90d / 1y presets for deployment timeseries charts.
// Callers share query keys, so a range loaded on one screen is a cache hit on
// the other. Only the selected range is fetched: the other presets are not
// prefetched, because each one is a full scan of the deployment's events for
// its window (the 90d / 1y windows take tens of seconds on a busy
// deployment) and together they held the server's whole connection pool for
// data most visits never looked at. Switching ranges keeps the previous
// chart on screen (`keepPreviousData`) while the new window loads.

import { useState } from "react";

import {
  NO_BINARY_VERSION_FILTER,
  useAdoptionTimeseries,
  type BinaryVersionFilterState,
} from "./BinaryVersionSelect";

export const TIMESERIES_RANGE_OPTIONS = [
  { days: 7, label: "7d", name: "Last 7 days" },
  { days: 30, label: "30d", name: "Last 30 days" },
  { days: 90, label: "90d", name: "Last 90 days" },
  { days: 365, label: "1y", name: "Last year" },
] as const;

export const DEFAULT_TIMESERIES_RANGE_DAYS = 30;

const SEGMENTED =
  "inline-flex shrink-0 gap-[3px] rounded-control border border-border p-[3px]";
const SEGMENTED_BTN =
  "rounded-[8px] border-0 px-2.5 py-1 text-[12px] font-semibold [transition:.13s]";
const SEGMENTED_BTN_IDLE = "bg-transparent text-fg-2";
const SEGMENTED_BTN_ACTIVE = "bg-surface-3 text-fg";

export function TimeseriesRangeSelector({
  rangeDays,
  onChange,
}: {
  rangeDays: number;
  onChange: (days: number) => void;
}) {
  return (
    <div className={SEGMENTED} role="group" aria-label="Time range">
      {TIMESERIES_RANGE_OPTIONS.map((option) => {
        const active = option.days === rangeDays;
        return (
          <button
            key={option.days}
            type="button"
            aria-label={option.name}
            aria-pressed={active}
            className={`${SEGMENTED_BTN} ${active ? SEGMENTED_BTN_ACTIVE : SEGMENTED_BTN_IDLE}`}
            onClick={() => {
              onChange(option.days);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function useTimeseriesRange(
  deploymentId: string,
  filterState: BinaryVersionFilterState = NO_BINARY_VERSION_FILTER,
) {
  const [rangeDays, setRangeDays] = useState(DEFAULT_TIMESERIES_RANGE_DAYS);
  const timeseriesQuery = useAdoptionTimeseries(deploymentId, filterState, {
    rangeDays,
  });

  return {
    rangeDays,
    setRangeDays,
    timeseriesQuery,
  };
}
