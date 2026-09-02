import { ReactNode, useEffect, useRef, useState, useContext, createContext, KeyboardEvent } from "react";
import { Check } from "lucide-react";

/** Context lets `DropdownItem` (and any other inner control) close its parent menu. */
const DropdownCtx = createContext<{ close: () => void }>({ close: () => {} });

/**
 * Headless dropdown wrapper. Provides outside-click + Escape close behaviour
 * and standard panel positioning. Caller composes the trigger and the panel
 * contents — no opinions about what goes inside the trigger button.
 *
 * Replaces five hand-rolled menu implementations that drifted on radius,
 * shadow, panel width and the styling of selected items.
 *
 * Usage:
 *   <Dropdown trigger={({open, toggle}) => (
 *     <button onClick={toggle} aria-expanded={open}>...</button>
 *   )}>
 *     <DropdownSection title="Color theme">
 *       <DropdownItem active={mode === "dark"} onClick={...}>Dark</DropdownItem>
 *     </DropdownSection>
 *   </Dropdown>
 */
export default function Dropdown({
  trigger, children, align = "left", width = "w-72", panelClassName = "",
}: {
  trigger: (api: { open: boolean; toggle: () => void; close: () => void }) => ReactNode;
  children: ReactNode;
  /** Alignment of the panel relative to the trigger. */
  align?: "left" | "right";
  /** Tailwind width class for the panel. */
  width?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => setOpen(o => !o);
  const close = () => setOpen(false);

  return (
    <div ref={wrapRef} className="relative">
      {trigger({ open, toggle, close })}
      {open && (
        <DropdownCtx.Provider value={{ close }}>
          <div className={`absolute ${align === "right" ? "right-0" : "left-0"} top-full mt-1 z-50 ${width} bg-t-card border border-t-line rounded-md shadow-lg overflow-hidden ${panelClassName}`}>
            {children}
          </div>
        </DropdownCtx.Provider>
      )}
    </div>
  );
}

/**
 * Section container inside a Dropdown panel. Renders an optional
 * SectionLabel-style header strip and a scroll-capped item list.
 */
export function DropdownSection({
  title, children, maxHeight = "max-h-72",
}: {
  title?: ReactNode;
  children: ReactNode;
  maxHeight?: string;
}) {
  return (
    <>
      {title && (
        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-t-ink4 font-semibold border-b border-t-line">
          {title}
        </div>
      )}
      <div className={`${maxHeight} overflow-y-auto py-1`}>
        {children}
      </div>
    </>
  );
}

/**
 * Footer row inside a Dropdown panel — separated by a thin top border.
 * Use for actions like "Manage profiles…" that aren't part of the main list.
 */
export function DropdownFooter({ children }: { children: ReactNode }) {
  return (
    <div className="border-t border-t-line">{children}</div>
  );
}

/**
 * A single selectable row inside a Dropdown. When `active` is true the row is
 * tinted with `bg-blue-500/10` (canonical selected-state) and a Check is
 * rendered in the leading slot — otherwise an invisible spacer keeps text
 * alignment consistent across rows.
 */
export function DropdownItem({
  active = false, onClick, disabled = false, closeOnSelect = true, children, trailing,
}: {
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  /** Auto-close the parent menu on click (default true — matches typical menu UX). */
  closeOnSelect?: boolean;
  children: ReactNode;
  /** Right-aligned content (e.g. host:port for a profile, kbd shortcut). */
  trailing?: ReactNode;
}) {
  const { close } = useContext(DropdownCtx);

  function handleClick() {
    onClick?.();
    if (closeOnSelect) close();
  }

  function handleKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      onKeyDown={handleKey}
      disabled={disabled}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors text-[12px] ${
        active ? "bg-blue-500/10" : "hover:bg-t-hover"
      } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      {active
        ? <Check className="w-3 h-3 text-blue-500 shrink-0" />
        : <span className="w-3 shrink-0" />}
      <span className="flex-1 text-t-ink truncate">{children}</span>
      {trailing && <span className="ml-auto text-[10px] text-t-ink5 font-mono shrink-0">{trailing}</span>}
    </button>
  );
}
