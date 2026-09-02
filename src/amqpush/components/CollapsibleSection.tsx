import { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * Standard expandable section used inside preview panes (Browser peek,
 * Subscriber preview, History preview). Header strip is `bg-t-card/60` with a
 * `text-[10px] uppercase tracking-wider text-t-ink4 font-semibold` label —
 * this is the canonical token set; do not drift these per-view.
 */
export default function CollapsibleSection({
  title, icon, open, onToggle, action, children,
}: {
  title: string;
  icon?: ReactNode;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border border-t-line rounded-md overflow-hidden bg-t-panel">
      <div className="flex items-center justify-between px-2 py-1 bg-t-card/60">
        <button onClick={onToggle}
          className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-t-ink4 font-semibold hover:text-t-ink2 transition-colors">
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {icon}
          {title}
        </button>
        {action}
      </div>
      {open && <div className="p-2">{children}</div>}
    </div>
  );
}
