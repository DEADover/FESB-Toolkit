/**
 * Standard on/off pill switch used for boolean settings (TLS, SASL anonymous,
 * Reply-enabled, etc). Pure-CSS slider matching the Postman/JetBrains-style
 * minimal toggle.
 *
 * Replaces two hand-rolled implementations that had:
 *   - inline `style={{ height: "22px", width: "40px" }}` (ConnectionView)
 *   - bare `relative w-8 h-4 rounded-full ...` (PublisherView)
 *
 * Both produced near-identical visuals; this component locks the size and the
 * blue-600 / t-active palette in one place. Click the whole track to toggle.
 */
export default function Toggle({
  checked, onChange, disabled = false, ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex w-8 h-4 rounded-full shrink-0 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${
        checked ? "bg-blue-600" : "bg-t-active"
      } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}
