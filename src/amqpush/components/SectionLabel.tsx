import { ReactNode } from "react";

/**
 * Мелкий заголовок над блоком — тот же, что на остальных экранах
 * приложения: `text-[10px] uppercase tracking-wide text-content-subtle`.
 * Прежде он был крупнее и жирнее и выделялся среди соседних подписей.
 *
 * Canonical section-label typography used across the app — small uppercase
 * `text-[10.5px] tracking-wider text-t-ink4 font-semibold`. Use this anywhere
 * a screen needs an "uppercase mini-heading" so the spelling stays consistent
 * (`tracking-wider` not `widest`, `font-semibold` not `font-bold`).
 *
 * Composes with optional leading icon and trailing content (e.g. counts,
 * "(N items)" suffixes) — the trailing slot keeps its own casing so a
 * lowercase descriptive note can sit next to an uppercase label without
 * inheriting `uppercase`.
 */
export default function SectionLabel({
  icon, children, trailing, className = "",
}: {
  icon?: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-content-subtle ${className}`}>
      {icon}
      {children}
      {trailing && (
        <span className="normal-case font-normal text-t-ink5 ml-0.5">{trailing}</span>
      )}
    </span>
  );
}
