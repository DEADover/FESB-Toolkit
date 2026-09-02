import { useEffect, ReactNode } from "react";
import { AlertTriangle, X, Loader2 } from "lucide-react";

/**
 * Generic destructive-action confirm dialog. Used everywhere a Clear / Delete /
 * Wipe action needs a "are you really sure?" gate so a single misclick can't
 * lose data. Centralised here so the visual style (red header bar, danger
 * triangle, monospace count chip in the body) stays consistent across the app.
 *
 * Esc cancels; Enter confirms. The confirm button auto-focuses on open so a
 * user who's sure can just hit Enter without reaching for the mouse.
 */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  destructive = true,
  busy = false,
  busyLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  /** Shown under the title. Plain string or rich JSX (use it for a count
   *  chip + sentence). */
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true (default) the confirm button is red. Set false for
   *  not-quite-destructive confirms (e.g. resetting a form). */
  destructive?: boolean;
  /** When true, the confirm button shows a spinner and is disabled. Use for
   *  async flows where the wipe takes a moment. */
  busy?: boolean;
  /** Optional label override while `busy` is true (e.g. "Deleting…"). */
  busyLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Esc cancels; Enter confirms (when not busy).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && !busy) {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onConfirm, onCancel]);

  if (!open) return null;

  const confirmClass = destructive
    ? "bg-red-500 hover:bg-red-600 text-white"
    : "bg-blue-600 hover:bg-blue-500 text-white";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-t-bg border border-t-line rounded-lg shadow-2xl w-[460px] max-w-[90vw] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="shrink-0 px-4 py-2.5 border-b border-t-line bg-t-panel flex items-center gap-2">
          <AlertTriangle className={`w-3.5 h-3.5 ${destructive ? "text-red-500" : "text-blue-500"}`} />
          <span className="text-[13px] font-semibold text-t-ink">{title}</span>
          <button
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
            className="ml-auto p-1 rounded hover:bg-t-hover text-t-ink4 hover:text-t-ink disabled:opacity-40"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 text-[13px] text-t-ink2 space-y-2">
          {body}
        </div>

        {/* Footer */}
        <div className="shrink-0 px-3 py-2 border-t border-t-line bg-t-panel flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1 rounded-md text-[11px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
          >
            {cancelLabel}
          </button>
          <button
            autoFocus
            onClick={onConfirm}
            disabled={busy}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-40 ${confirmClass}`}
          >
            {busy
              ? <><Loader2 className="w-3 h-3 animate-spin" /> {busyLabel ?? "Working…"}</>
              : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
