import { ReactNode } from "react";

/**
 * Заголовок панели экрана — общий для всех экранов раздела.
 *
 * Standard top bar for split-pane / list views (Connection, Receive, Browser,
 * History, Stats, Logs, Send). Locks the canonical token set:
 *   `h-10 px-3 border-b border-t-line bg-t-panel`
 *   icon `w-3.5 h-3.5 text-t-ink4`
 *   title `text-[13px] font-semibold text-t-ink`
 *   count `text-[11.5px] text-t-ink5 font-mono`
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
    // Заголовок панели — как у таблиц приложения: подложка на тон светлее
    // содержимого, тонкая черта снизу, подпись мелким шрифтом рядом с именем.
    <div className="shrink-0 h-10 px-4 border-b border-line bg-surface-2 flex items-center gap-2">
      {icon && <span className="text-content-subtle shrink-0">{icon}</span>}
      <span className="text-[12.5px] font-semibold text-content shrink-0">{title}</span>
      {count !== undefined && count !== null && (
        <span className="text-[11.5px] text-content-subtle tabular-nums">{count}</span>
      )}
      {status}
      {children && <div className="ml-auto flex items-center gap-1">{children}</div>}
    </div>
  );
}
