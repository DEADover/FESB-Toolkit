import { ReactNode } from "react";

/**
 * Standard top bar for split-pane / list views (Connection, Receive, Browser,
 * History, Stats, Logs, Send). Locks the canonical token set:
 *   `h-10 px-3 border-b border-t-line bg-t-panel`
 *   icon `w-3.5 h-3.5 text-t-ink4`
 *   title `text-[13px] font-semibold text-t-ink`
 *   count `text-[11px] text-t-ink5 font-mono`
 *
 * **Fixed height (`h-10` = 40px)** is critical here. Without it, the row's
 * height grows to fit its tallest child — which means a Connection title
 * with a primary `py-1.5` Connect button is several pixels taller than a
 * History title with small `py-1` ghost buttons, and the apparent rhythm
 * of the app breaks across views. Locking the height makes every title bar
 * visually identical regardless of what actions are inside it.
 *
 * `status` slot sits inline between the count and the actions — used for
 * "live" pulse dots, "reconnecting…" spinners, etc. `children` is the
 * right-aligned action group (`ml-auto` is applied automatically).
 */
export default function ViewTopBar({
  icon, title, count, status, children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  count?: ReactNode;
  status?: ReactNode;
  /** Right-aligned action group. */
  children?: ReactNode;
}) {
  return (
    <div className="shrink-0 h-10 px-3 border-b border-t-line bg-t-panel flex items-center gap-2">
      {icon && <span className="text-t-ink4 shrink-0">{icon}</span>}
      <span className="text-[13px] font-semibold text-t-ink shrink-0">{title}</span>
      {count !== undefined && count !== null && (
        <span className="text-[11px] text-t-ink5 font-mono">{count}</span>
      )}
      {status}
      {children && <div className="ml-auto flex items-center gap-1">{children}</div>}
    </div>
  );
}
