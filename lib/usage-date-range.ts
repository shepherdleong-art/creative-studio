export const USAGE_DATE_PRESETS = [
  { key: 'today', label: '今天' },
  { key: 'last7', label: '近 7 天' },
  { key: 'week', label: '本周' },
  { key: 'last30', label: '近 30 天' },
  { key: 'month', label: '本月' },
] as const;

export type UsageDatePreset = typeof USAGE_DATE_PRESETS[number]['key'];

export function usageDateLabel(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function addUsageDays(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Inclusive calendar dates in UTC+8; rolling ranges include today. */
export function usagePresetRange(preset: UsageDatePreset, now = new Date()): { from: string; to: string } {
  const today = usageDateLabel(now);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const from = preset === 'last7' ? addUsageDays(today, -6)
    : preset === 'last30' ? addUsageDays(today, -29)
      : preset === 'week' ? addUsageDays(today, -((weekday + 6) % 7))
        : preset === 'month' ? `${today.slice(0, 7)}-01`
          : today;
  return { from, to: today };
}
