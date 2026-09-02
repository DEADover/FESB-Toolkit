import { ReactNode } from "react";

export interface SegmentOption<T extends string> {
  value: T;
  /** Visible content — string or ReactNode for label + count badge etc. */
  label: ReactNode;
  /** Hover tooltip. */
  title?: string;
}

/**
 * Canonical segmented pill control — `bg-t-card border border-t-line rounded`
 * group with `bg-blue-500/15 text-blue-500` for the selected segment. This is
 * the same visual pattern already used by Subscriber/Browser/History for the
 * AUTO|RAW|HEX body-view toggle, lifted into a shared component so other
 * views (Send body-mode, Console level filter, etc.) can adopt it.
 *
 * Default uppercase mono styling matches the body-mode toggles. Pass
 * `casing="normal"` for a non-uppercase variant when needed (e.g. proper-noun
 * labels). The component is generic over the value type so call sites get
 * type-safe `onChange` callbacks.
 */
export default function SegmentedControl<T extends string>({
  value, onChange, options, casing = "uppercase", size = "md", className = "",
}: {
  value: T;
  onChange: (next: T) => void;
  options: SegmentOption<T>[];
  /** Whether segment labels are uppercase (default) or kept as-given. */
  casing?: "uppercase" | "normal";
  /** `sm` = `px-1.5 py-0.5 text-[10px]`, `md` = `px-2 py-0.5 text-[11px]`. */
  size?: "sm" | "md";
  className?: string;
}) {
  const sizeClasses =
    size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]";
  const casingClass = casing === "uppercase" ? "uppercase tracking-wider" : "";
  return (
    <div className={`inline-flex items-center bg-t-card border border-t-line rounded overflow-hidden ${className}`}>
      {options.map((opt, i) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={(e) => { e.stopPropagation(); onChange(opt.value); }}
            title={opt.title}
            className={`${sizeClasses} ${casingClass} font-mono font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-blue-500/40 ${
              isActive
                ? "bg-blue-500/15 text-blue-500"
                : "text-t-ink4 hover:text-t-ink2 hover:bg-t-hover"
            } ${i > 0 ? "border-l border-t-line" : ""}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function renderSegmentLabelWithBadge(label: ReactNode, count?: number): ReactNode {
  if (!count || count <= 0) return label;
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <span className="text-t-ink5 font-mono normal-case">{count}</span>
    </span>
  );
}
