/**
 * Tiny inline SVG sparkline — used by the Send view during Batch / CSV runs
 * to surface live throughput (messages per second). The chart is purely
 * visual; the numeric counts already live next to it.
 *
 * Behavior:
 *   - Auto-scales Y to the max value in `values` (so a slow run still
 *     fills the box).
 *   - When fewer values exist than `width / step`, the rest is empty —
 *     the chart "fills up" as the run progresses.
 *   - Renders nothing if `values` is empty or all zero.
 */
export default function Sparkline({
  values,
  width = 120,
  height = 18,
  color = "rgb(var(--t-ink4))",
  fillColor = "rgb(var(--t-ink4) / 0.15)",
  className = "",
  title,
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fillColor?: string;
  className?: string;
  title?: string;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = width / Math.max(1, values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - (v / max) * (height - 2) - 1; // leave 1 px padding
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const fillPath = `M0,${height} L${points.replace(/ /g, " L")} L${width},${height} Z`;
  const linePath = `M${points.replace(/ /g, " L")}`;

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <path d={fillPath} fill={fillColor} stroke="none" />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
