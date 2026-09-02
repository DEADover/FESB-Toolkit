import { Copy, Check } from "lucide-react";
import { useState, useRef, useEffect, MouseEvent } from "react";

interface Props {
  /** Text to write to clipboard. Function form is computed lazily on click. */
  value: string | (() => string);
  /** Fired after a successful copy — typically used to write to the app log. */
  onCopied?: () => void;
  /** Optional visible label (e.g. "Copy"). When omitted, button is icon-only. */
  label?: string;
  /** Tooltip / `aria-label`. Default `"Copy"` (becomes `"Copied!"` post-click). */
  title?: string;
  /** Wrapper button class — caller controls appearance for the local context. */
  className?: string;
  /** Lucide icon size — defaults to `w-3 h-3`. */
  iconClassName?: string;
  /** How long the "copied" feedback is shown, ms. Default 1500. */
  feedbackMs?: number;
}

/**
 * Copy-to-clipboard button with a short visual confirmation:
 *   - icon flips from `Copy` → `Check` (green) for ~1.5s
 *   - the `Check` is rendered with a 320ms pulse animation, so a quick
 *     subsequent click still produces a visible bounce instead of a no-op
 *   - the optional label switches "Copy" → "Copied" in green for the same window
 *   - the tooltip / aria-label updates to "Copied!" so screen readers announce
 *     the success state
 *
 * Caller controls the button's outer styling via `className` — this component
 * only owns the state machine and the icon swap.
 */
export default function CopyButton({
  value,
  onCopied,
  label,
  title = "Copy",
  className,
  iconClassName = "w-3 h-3",
  feedbackMs = 1500,
}: Props) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Make sure we don't leave a setState-on-unmounted-component warning if
  // the button vanishes (e.g. row goes off-screen) before the timer fires.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  function handleClick(e: MouseEvent) {
    e.stopPropagation();
    const text = typeof value === "function" ? value() : value;
    navigator.clipboard.writeText(text)
      .then(() => {
        setCopied(true);
        onCopied?.();
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), feedbackMs);
      })
      .catch(() => { /* clipboard not available — silent */ });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={copied ? "Copied!" : title}
      aria-label={copied ? "Copied" : title}
      className={className}
    >
      {copied ? (
        // `key` makes React remount the icon each time `copied` flips to true,
        // which restarts the CSS pulse animation — back-to-back clicks each
        // get their own bounce instead of the animation only firing once.
        <Check key={Date.now()} className={`${iconClassName} text-green-500 animate-copy-pulse`} />
      ) : (
        <Copy className={iconClassName} />
      )}
      {label && <span className={copied ? "text-green-500" : ""}>{copied ? "Copied" : label}</span>}
    </button>
  );
}
