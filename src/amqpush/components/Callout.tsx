import { ReactNode } from "react";

export type CalloutVariant = "info" | "success" | "warn" | "error";

const VARIANT_CLASSES: Record<CalloutVariant, { wrap: string; text: string }> = {
  info:    { wrap: "bg-accent/5 border-accent/20",   text: "text-accent-content" },
  success: { wrap: "bg-positive/5 border-positive/20", text: "text-positive" },
  warn:    { wrap: "bg-caution/5 border-caution/20", text: "text-caution" },
  error:   { wrap: "bg-negative/5 border-negative/20",     text: "text-negative" },
};

/**
 * Compact tinted alert box used for inline status / hints / confirms across
 * the app. Replaces ~8 hand-rolled instances that all followed the pattern
 *   `p-2.5 bg-{color}-500/5 border border-{color}-500/20 rounded-lg`
 * but with subtle drift (some `p-2.5`, some `p-3`, mixed border widths,
 * mixed text shades).
 *
 * Designed to be small — caller controls the children, optional icon, and an
 * optional right-aligned action slot (typically a Copy or Dismiss button).
 * Title is optional; for purely textual callouts pass children directly.
 */
export default function Callout({
  variant = "info", icon, title, action, children, className = "",
}: {
  variant?: CalloutVariant;
  icon?: ReactNode;
  title?: ReactNode;
  /** Right-aligned slot inside the callout header (e.g. small Copy button). */
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const v = VARIANT_CLASSES[variant];
  const hasHeader = !!(icon || title || action);
  return (
    <div className={`rounded-lg border ${v.wrap} ${className}`}>
      {hasHeader && (
        <div className={`flex items-center gap-2 px-2.5 py-1.5 ${children ? "border-b border-current/10" : ""}`}>
          {icon && <span className={`shrink-0 ${v.text}`}>{icon}</span>}
          {title && <span className={`text-xs font-medium ${v.text}`}>{title}</span>}
          {action && <span className="ml-auto">{action}</span>}
        </div>
      )}
      {children && (
        <div className={`px-2.5 py-1.5 text-xs ${hasHeader ? "text-t-ink2" : v.text}`}>
          {children}
        </div>
      )}
    </div>
  );
}
