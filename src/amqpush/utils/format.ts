/**
 * Display-formatting helpers shared by all views — sizes, durations, CSV
 * escaping. Putting them in one place avoids per-view drift in number rounding
 * and unit thresholds.
 */

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Compact duration. Three regimes by magnitude:
 *  - `< 1 s`   → `"345ms"`   (millisecond precision)
 *  - `< 60 s`  → `"2.05s"`   (two-decimal seconds — used by send result)
 *  - `≥ 60 s` → `"2m 05s"`  (minute / second — used by session duration)
 */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r.toString().padStart(2, "0")}s`;
}

/** Quote a CSV field — doubles internal quotes, strips line breaks. */
export function csvEscape(s: string): string {
  return `"${s.replace(/"/g, '""').replace(/\n/g, " ").replace(/\r/g, "")}"`;
}
