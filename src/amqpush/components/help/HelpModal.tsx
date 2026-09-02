import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ChevronRight, Search, X } from "lucide-react";

import { useAmqpText } from "../../i18n";
import { useI18n } from "../../../i18n";
import { Kbd, type HelpSection } from "./primitives";
import { SECTIONS_EN } from "./sections.en";
import { SECTIONS_RU } from "./sections.ru";

/**
 * Встроенное руководство.
 *
 * Текст живёт двумя наборами разделов — английским и русским — и берётся
 * по языку приложения. Так проза остаётся прозой: разложить её по ключам
 * словаря значило бы разорвать каждую фразу на куски вокруг выделений
 * и ссылок, а собрать обратно на другом языке — уже не получилось бы.
 */
/* ────────────────────────────────────────────────────────────────────────── */
/*  Modal                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

export default function HelpModal({
  initialSection,
  onClose,
}: {
  initialSection?: string;
  onClose: () => void;
}) {
  const t = useAmqpText();
  const { language } = useI18n();
  // Тот же набор разделов, но на выбранном языке: идентификаторы и порядок
  // совпадают, поэтому открытый раздел переживает смену языка.
  const SECTIONS: HelpSection[] = language === "ru" ? SECTIONS_RU : SECTIONS_EN;
  const [activeId, setActiveId] = useState(initialSection ?? SECTIONS[0].id);
  const [query, setQuery] = useState("");
  /** Set of parent ids the user has explicitly collapsed. Default empty =
   *  every parent shows its children. We track collapses (rather than
   *  expansions) so a fresh install doesn't have to enumerate the parent
   *  list, and adding a new parent later doesn't require a state migration. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const contentRef = useRef<HTMLDivElement>(null);

  /** Lookup of parentId → child sections, ordered as they appear in SECTIONS.
   *  Drives the chevron-on-parent rendering and the "has children" check. */
  const childrenByParent = useMemo(() => {
    const m = new Map<string, HelpSection[]>();
    for (const s of SECTIONS) {
      if (s.parentId) {
        if (!m.has(s.parentId)) m.set(s.parentId, []);
        m.get(s.parentId)!.push(s);
      }
    }
    return m;
  }, []);

  function toggleCollapse(parentId: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }

  // Esc to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Reset scroll when section changes
  useEffect(() => { contentRef.current?.scrollTo({ top: 0 }); }, [activeId]);

  const filteredSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.filter(s =>
      s.title.toLowerCase().includes(q) || s.searchText.toLowerCase().includes(q)
    );
  }, [query]);

  // If the active section gets filtered out, jump to the first match.
  useEffect(() => {
    if (!filteredSections.some(s => s.id === activeId) && filteredSections.length > 0) {
      setActiveId(filteredSections[0].id);
    }
  }, [filteredSections, activeId]);

  const active = SECTIONS.find(s => s.id === activeId) ?? SECTIONS[0];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        // `select-text` opts the whole Help modal out of the global
        // `body { user-select: none; }` rule — every paragraph, list item,
        // code span, and table row inside Help becomes selectable so users
        // can copy snippets (paths, token names, broker URLs, etc.) directly
        // out of the docs.
        className="bg-t-bg border border-t-line rounded-xl shadow-2xl w-[920px] max-w-[95vw] h-[78vh] flex flex-col overflow-hidden select-text"
      >
        {/* Header */}
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-t-line bg-t-panel">
          <BookOpen className="w-3.5 h-3.5 text-accent shrink-0" />
          <div className="text-[13px] text-t-ink font-medium">{t("shell.help")}</div>
          <span className="text-[11.5px] text-t-ink5">{t("help.subtitle")}</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto p-1 rounded-md text-t-ink4 hover:text-t-ink hover:bg-t-hover"
            aria-label="Close help"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex-1 min-h-0 flex">
          {/* Sidebar */}
          <div className="shrink-0 w-[220px] border-r border-t-line bg-t-panel/40 flex flex-col">
            <div className="shrink-0 px-2.5 py-2 border-b border-t-line">
              <div className="flex items-center gap-2 bg-t-field border border-t-line2 rounded-lg px-2 py-1.5">
                <Search className="w-3 h-3 text-t-ink5 shrink-0" />
                <input
                  autoFocus
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder={t("help.search")}
                  className="flex-1 bg-transparent text-[12.5px] text-t-ink outline-none placeholder:text-t-ink5 min-w-0"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {filteredSections.length === 0 ? (
                <div className="px-3 py-2 text-[12.5px] text-t-ink5">{t("help.nothing")}</div>
              ) : filteredSections.map(s => {
                const isChild = !!s.parentId;
                const childList = childrenByParent.get(s.id) ?? [];
                const hasChildren = childList.length > 0;
                // Active section's parent is force-expanded so the chain to
                // the highlighted entry is always visible. Search mode is also
                // force-expanded — collapsed children would just hide matches.
                const activeIsChildHere = hasChildren && childList.some(c => c.id === activeId);
                const searching = !!query.trim();
                const expanded = !collapsed.has(s.id) || activeIsChildHere || searching;

                // Hide a child whose parent is collapsed (and the active /
                // search overrides above don't apply).
                if (isChild) {
                  const parent = SECTIONS.find(p => p.id === s.parentId);
                  const parentSearching = searching;
                  const parentActive = parent && childrenByParent.get(parent.id)?.some(c => c.id === activeId);
                  const parentExpanded = parent && (!collapsed.has(parent.id) || parentActive || parentSearching);
                  if (!parentExpanded) return null;
                }

                return (
                  <div
                    key={s.id}
                    className={`w-full flex items-stretch ${isChild ? "pl-4" : ""}`}
                  >
                    {/* Section button — clicking activates and (for parents) does NOT toggle collapse */}
                    <button
                      type="button"
                      onClick={() => setActiveId(s.id)}
                      className={`flex-1 flex items-center gap-2 ${isChild ? "pl-3 pr-3" : "pl-3 pr-2"} py-1.5 text-left text-[12.5px] transition-colors ${
                        s.id === active.id
                          ? "bg-accent/15 text-accent"
                          : isChild
                            ? "text-t-ink3 hover:bg-t-hover/50 hover:text-t-ink"
                            : "text-t-ink2 hover:bg-t-hover/50 hover:text-t-ink"
                      }`}
                    >
                      <span className="shrink-0">{s.icon}</span>
                      <span className="truncate">{s.title}</span>
                    </button>
                    {/* Chevron — only on parents with children. Decoupled from
                        the activate-on-click target so users can collapse a
                        section without leaving their current page. */}
                    {hasChildren && (
                      <button
                        type="button"
                        onClick={() => toggleCollapse(s.id)}
                        aria-label={expanded ? t("help.collapse") : t("help.expand")}
                        title={expanded ? t("help.collapse") : t("help.expand")}
                        className={`shrink-0 px-2 transition-colors ${
                          s.id === active.id
                            ? "text-accent hover:bg-accent/20"
                            : "text-t-ink5 hover:text-t-ink hover:bg-t-hover/50"
                        }`}
                      >
                        <ChevronRight
                          className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
                        />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Content */}
          <div ref={contentRef} className="flex-1 min-w-0 overflow-y-auto px-6 py-5">
            {active.content}
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 px-3 py-1.5 border-t border-t-line bg-t-panel flex items-center gap-3 text-[10.5px] text-t-ink5">
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd> {t("help.close")}
          </span>
          <span className="ml-auto">{t("help.count", { shown: filteredSections.length, total: SECTIONS.length })}</span>
        </div>
      </div>
    </div>
  );
}
