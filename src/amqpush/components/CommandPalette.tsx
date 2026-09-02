import { useEffect, useMemo, useRef, useState, ReactNode, KeyboardEvent } from "react";
import { Search, X, ArrowRight } from "lucide-react";

export interface PaletteAction {
  /** Stable id used for React keys; never displayed. */
  id: string;
  /** Visible primary text. Should describe an action ("Go to Send", "Connect"). */
  label: string;
  /** Optional secondary line shown muted under the label. */
  hint?: string;
  /** Group heading shown in the list; pass the same string across related actions. */
  category?: string;
  /** Lucide icon node. Should already be sized (`w-3.5 h-3.5` etc). */
  icon?: ReactNode;
  /** Right-aligned keyboard shortcut text, e.g. "⌘1". Cosmetic only. */
  kbd?: string;
  /** Whether the action is currently disabled — greyed out, can't be selected. */
  disabled?: boolean;
  /** Called when the user picks the action. */
  run: () => void;
}

/**
 * Subsequence fuzzy match. Returns a score where higher is a better match,
 * or `null` if `needle` doesn't fit. Heavy bonus on word-start matches,
 * smaller bonus on consecutive matches — that way "gss" matches
 * "Go-to Send" better than it matches "Logs Stats Subscriber".
 */
function fuzzyScore(needle: string, haystack: string): number | null {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let i = 0;
  let j = 0;
  let score = 0;
  let lastMatch = -1;
  while (i < n.length && j < h.length) {
    if (n[i] === h[j]) {
      const prev = h[j - 1];
      if (j === 0 || prev === " " || prev === "-" || prev === "_" || prev === ".") {
        score += 10;
      } else if (lastMatch === j - 1) {
        score += 5;
      } else {
        score += 1;
      }
      lastMatch = j;
      i++;
    }
    j++;
  }
  return i === n.length ? score : null;
}

/**
 * `Cmd+K` overlay with a fuzzy-searchable list of every meaningful action
 * the app exposes — navigation (`Go to …`), commands (`Connect`,
 * `Clear logs`, `Send now`), profile switches, theme switches.
 *
 * Actions are passed in by the caller (App.tsx owns the closures that
 * actually execute), so the palette is purely presentational + keyboard
 * navigation. Esc closes; Enter runs the highlighted action; Up/Down move.
 */
export default function CommandPalette({ actions, onClose }: {
  actions: PaletteAction[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Score + sort, dropping non-matches when query is non-empty.
  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return actions;
    const scored = actions
      .map(a => {
        const s = Math.max(
          fuzzyScore(q, a.label) ?? -Infinity,
          ((fuzzyScore(q, a.hint ?? "") ?? -Infinity) - 5),
          ((fuzzyScore(q, a.category ?? "") ?? -Infinity) - 10),
        );
        return Number.isFinite(s) ? { a, s } : null;
      })
      .filter((x): x is { a: PaletteAction; s: number } => x !== null);
    scored.sort((a, b) => b.s - a.s);
    return scored.map(x => x.a);
  }, [actions, query]);

  // Keep `activeIdx` valid as the filtered list changes.
  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(0);
  }, [filtered.length, activeIdx]);

  // Scroll the active row into view when navigating with arrows.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  function handleKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx(i => {
        // Skip disabled rows
        for (let n = i + 1; n < filtered.length; n++) if (!filtered[n].disabled) return n;
        return i;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(i => {
        for (let n = i - 1; n >= 0; n--) if (!filtered[n].disabled) return n;
        return i;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = filtered[activeIdx];
      if (a && !a.disabled) {
        a.run();
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  // Group rendered list by category so "Go to" / "Connection" / "Theme" etc.
  // get visual section headers without the caller having to interleave them.
  const groups: { category: string; items: PaletteAction[] }[] = useMemo(() => {
    const map = new Map<string, PaletteAction[]>();
    for (const a of filtered) {
      const cat = a.category ?? "";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(a);
    }
    return Array.from(map.entries()).map(([category, items]) => ({ category, items }));
  }, [filtered]);

  // Compute the running global index per item for activeIdx comparison.
  let runningIdx = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm pt-[10vh]"
      onClick={onClose}
      onKeyDown={handleKey}
    >
      <div onClick={e => e.stopPropagation()}
        className="bg-t-bg border border-t-line rounded-lg shadow-2xl w-[640px] max-w-[90vw] max-h-[70vh] flex flex-col overflow-hidden">

        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-t-line bg-t-panel">
          <Search className="w-3.5 h-3.5 text-t-ink5 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveIdx(0); }}
            placeholder="Type a command or search…"
            className="flex-1 bg-transparent text-[13px] text-t-ink outline-none placeholder:text-t-ink5"
          />
          <kbd className="text-[10px] text-t-ink5 font-mono px-1.5 py-0.5 border border-t-line rounded">Esc</kbd>
          <button onClick={onClose} className="p-1 rounded text-t-ink4 hover:text-t-ink hover:bg-t-hover" aria-label="Close">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="text-[12px] text-t-ink5 text-center py-8">No matching commands</p>
          ) : groups.map(g => (
            <div key={g.category}>
              {g.category && (
                <div className="sticky top-0 px-3 py-1 text-[10px] uppercase tracking-wider text-t-ink4 font-semibold bg-t-card/80 backdrop-blur-sm border-b border-t-line">
                  {g.category}
                </div>
              )}
              {g.items.map(a => {
                runningIdx++;
                const idx = runningIdx;
                const isActive = idx === activeIdx;
                return (
                  <button
                    key={a.id}
                    data-idx={idx}
                    type="button"
                    disabled={a.disabled}
                    onMouseMove={() => setActiveIdx(idx)}
                    onClick={() => { a.run(); onClose(); }}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                      isActive ? "bg-blue-500/15" : "hover:bg-t-hover/50"
                    } ${a.disabled ? "opacity-40 cursor-not-allowed" : ""}`}
                  >
                    {a.icon && <span className="shrink-0 text-t-ink4">{a.icon}</span>}
                    <div className="flex-1 min-w-0">
                      <div className={`text-[13px] truncate ${isActive ? "text-blue-500" : "text-t-ink"}`}>
                        {a.label}
                      </div>
                      {a.hint && (
                        <div className="text-[10px] text-t-ink5 truncate">{a.hint}</div>
                      )}
                    </div>
                    {a.kbd && (
                      <kbd className="text-[10px] text-t-ink5 font-mono px-1.5 py-0.5 border border-t-line rounded shrink-0">
                        {a.kbd}
                      </kbd>
                    )}
                    {isActive && !a.kbd && <ArrowRight className="w-3 h-3 text-blue-500 shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="shrink-0 px-3 py-1.5 border-t border-t-line bg-t-panel flex items-center gap-3 text-[10px] text-t-ink5">
          <span className="flex items-center gap-1">
            <kbd className="font-mono px-1 py-0.5 border border-t-line rounded">↑↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono px-1 py-0.5 border border-t-line rounded">↵</kbd> run
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono px-1 py-0.5 border border-t-line rounded">Esc</kbd> close
          </span>
          <span className="ml-auto">{filtered.length} of {actions.length}</span>
        </div>
      </div>
    </div>
  );
}
