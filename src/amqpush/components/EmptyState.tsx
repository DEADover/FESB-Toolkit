import { ReactNode } from "react";
import { XCircle } from "lucide-react";

/**
 * Standard placeholder shown in lists / preview panes when there's nothing
 * to display. Default variant is informational; `error` variant flips the
 * icon to a red XCircle and renders the title in red.
 *
 * Icon size is locked at `w-8 h-8 opacity-40` across the app — pass a
 * pre-sized icon node as `icon`, or use the default error icon for `error`
 * variant. Do NOT pass `w-10` etc. — that's how drift starts.
 */
export default function EmptyState({
  icon, title, subtitle, action, variant = "default",
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  variant?: "default" | "error";
}) {
  const isErr = variant === "error";
  const finalIcon = icon ?? (isErr ? <XCircle className="w-8 h-8 text-red-500/60" /> : null);
  return (
    <div className="flex flex-col items-center justify-center h-full text-t-ink5 text-center max-w-md mx-auto px-4">
      {finalIcon && <div className={`mb-3 ${isErr ? "" : "opacity-40"}`}>{finalIcon}</div>}
      <p className={`text-[13px] ${isErr ? "text-red-500" : ""}`}>{title}</p>
      {subtitle && <div className="text-[11px] mt-1 break-all">{subtitle}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
