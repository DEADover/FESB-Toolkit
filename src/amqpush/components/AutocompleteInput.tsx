/**
 * Small single-line input with a substring-filter autocomplete dropdown.
 * Used by the Send view's Properties tab to suggest previously-used keys
 * and per-key values from History. Generic enough for any "free-form
 * input that benefits from a known-values dropdown".
 *
 * Looks indistinguishable from a regular `<input>` until focused / typed:
 *   - Focus → shows the full suggestion list (when available).
 *   - Typing → narrows by case-insensitive substring match.
 *   - Click a row → applies the value, closes the dropdown.
 *   - Click outside → closes; the typed value is kept.
 *   - Esc → closes without applying.
 *   - ↑ / ↓ navigate highlighted item, Enter applies.
 *
 * Why custom instead of native `<datalist>`: WebKit (Tauri) renders
 * datalist options as white-on-white in our themes, unreadable. The
 * Workspace combobox in ConnectionView ran into the same issue.
 */
import { useEffect, useMemo, useRef, useState, KeyboardEvent, InputHTMLAttributes, ReactNode } from "react";

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value">;

interface Props extends InputProps {
  value: string;
  onChange: (v: string) => void;
  /** Pool of values to filter against. Empty / undefined disables the popup. */
  suggestions?: string[];
  /** Hint shown in the empty state when there are no suggestions yet. */
  emptyHint?: ReactNode;
  /** Max rows in the popup; defaults to 12 (matches Codemirror's autocomplete cap). */
  maxRows?: number;
}

export default function AutocompleteInput({
  value, onChange, suggestions = [], emptyHint, maxRows = 12,
  className = "", placeholder, onFocus, onBlur, onKeyDown,
  ...rest
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Substring filter (case-insensitive). Empty input → show full list.
  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return suggestions.slice(0, maxRows);
    return suggestions
      .filter(s => s.toLowerCase().includes(q))
      .slice(0, maxRows);
  }, [value, suggestions, maxRows]);

  // Re-clamp the highlighted index when the filtered list shrinks.
  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1));
  }, [filtered.length, active]);

  // Close on outside click. Using mousedown so the popup closes before any
  // click target inside it fires onClick.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open || filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(i => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(i => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      const pick = filtered[active];
      if (pick !== undefined && pick !== value) {
        e.preventDefault();
        onChange(pick);
        setOpen(false);
      }
    }
  }

  function apply(v: string) {
    onChange(v);
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        {...rest}
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={(e) => { setOpen(true); onFocus?.(e); }}
        onBlur={onBlur}
        onKeyDown={handleKey}
        placeholder={placeholder}
        className={className}
      />
      {open && (filtered.length > 0 || (emptyHint && suggestions.length === 0)) && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-t-card border border-t-line rounded-md shadow-lg overflow-hidden max-h-64 overflow-y-auto">
          {filtered.length === 0 && emptyHint ? (
            <div className="px-3 py-2 text-[11px] text-t-ink5">{emptyHint}</div>
          ) : (
            filtered.map((s, i) => (
              <button
                key={s}
                type="button"
                onMouseDown={e => e.preventDefault()} // keep focus on the input so Tab/Esc still work after click
                onClick={() => apply(s)}
                onMouseEnter={() => setActive(i)}
                className={`w-full text-left px-3 py-1 text-[12px] font-mono truncate transition-colors ${
                  i === active
                    ? "bg-blue-500/10 text-blue-500"
                    : "text-t-ink2 hover:bg-t-hover hover:text-t-ink"
                }`}
                title={s}
              >
                {s}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
