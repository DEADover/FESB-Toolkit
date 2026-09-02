import { ReactNode } from "react";
import { AlertTriangle, Lightbulb } from "lucide-react";

/**
 * Кирпичики встроенного руководства — общие для обоих языков.
 *
 * Руководство существует в двух видах, английском и русском, и оба
 * набраны одной и той же разметкой: заголовок, абзац, врезка, список.
 * Держать эти кирпичики рядом с текстом значило бы иметь их в двух
 * экземплярах и однажды разойтись.
 */

export interface HelpSection {
  id: string;
  title: string;
  icon: ReactNode;
  /** Текст для поиска по руководству — без разметки. */
  searchText: string;
  content: ReactNode;
  /**
   * Раздел показывается с отступом под названным родителем. Порядок
   * в массиве задаёт положение по вертикали, поэтому дети идут сразу
   * за родителем. Поиск при этом плоский: ребёнок находится сам по себе.
   */
  parentId?: string;
}

export function H({ children }: { children: ReactNode }) {
  return <h2 className="text-[16px] font-semibold text-t-ink mb-3 flex items-center gap-2">{children}</h2>;
}

export function H3({ children }: { children: ReactNode }) {
  return <h3 className="text-[13px] font-semibold text-t-ink mt-5 mb-2">{children}</h3>;
}

export function P({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-t-ink2 leading-relaxed mb-2.5">{children}</p>;
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-accent/10 border border-accent/30 text-[12.5px] text-accent mb-3">
      <Lightbulb className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <div className="text-t-ink2 leading-relaxed">{children}</div>
    </div>
  );
}

export function Warn({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-caution/10 border border-caution/30 text-[12.5px] mb-3">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-caution" />
      <div className="text-t-ink2 leading-relaxed">{children}</div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="font-mono text-[11.5px] px-1.5 py-0.5 mx-0.5 border border-t-line rounded-md bg-t-card text-t-ink2 align-middle">
      {children}
    </kbd>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[12.5px] px-1 py-0.5 rounded-md bg-t-card text-t-ink border border-t-line">
      {children}
    </code>
  );
}

export function UL({ children }: { children: ReactNode }) {
  return <ul className="list-disc pl-5 mb-3 space-y-1.5 text-[13px] text-t-ink2 leading-relaxed">{children}</ul>;
}

export function Li({ children }: { children: ReactNode }) {
  return <li>{children}</li>;
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[200px_1fr] gap-4 py-1.5 border-b border-t-line/60 last:border-0">
      <div className="text-[12.5px] text-t-ink4 break-all min-w-0">{label}</div>
      <div className="text-[12.5px] text-t-ink2 min-w-0">{children}</div>
    </div>
  );
}
