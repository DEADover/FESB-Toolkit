import CopyButton from "./CopyButton";

/**
 * Standard property list shown inside CollapsibleSection bodies. Each row is
 * a 3-col grid `[140px_1fr_auto]` (key locked at 140px across the app),
 * mono `text-[11px]`, with a hover-revealed Copy button per value.
 *
 * Pass items as `[key, value | null]` — null/empty values are filtered out.
 * `onLog` is used to confirm copy actions in the global Logs view.
 */
export default function PropsList({ items, onLog }: {
  items: Array<[string, string | null | undefined]>;
  onLog: (k: "info" | "ok" | "err", t: string) => void;
}) {
  const visible = items.filter(([_, v]) => v !== null && v !== undefined && v !== "");
  if (visible.length === 0) return <p className="text-[11px] text-t-ink5">—</p>;
  return (
    <div className="text-[11px] font-mono select-text">
      {visible.map(([k, v]) => {
        const value = String(v);
        return (
          <div key={k}
            className="group grid grid-cols-[140px_1fr_auto] gap-x-3 items-start py-0.5 px-1 -mx-1 rounded hover:bg-t-hover/50 transition-colors">
            <span className="text-t-ink4 truncate select-text">{k}</span>
            <span className="text-t-ink2 break-all select-text">{value}</span>
            <CopyButton
              value={value}
              onCopied={() => onLog("info", `Copied ${k}`)}
              title={`Copy ${k}`}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-t-ink5 hover:text-t-ink2 hover:bg-t-hover"
            />
          </div>
        );
      })}
    </div>
  );
}
