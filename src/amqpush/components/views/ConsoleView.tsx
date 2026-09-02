import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle, XCircle, Info, Trash2, Terminal, Search, X, Filter,
  Pause, Play, Calendar, Download, ChevronUp, ChevronDown, ArrowDownToLine,
} from "lucide-react";
import { LogEntry } from "../../types";
import ViewTopBar from "../ViewTopBar";
import EmptyState from "../EmptyState";
import SegmentedControl from "../SegmentedControl";
import Dropdown, { DropdownItem } from "../Dropdown";
import SectionLabel from "../SectionLabel";
import ConfirmDialog from "../ConfirmDialog";
import { csvEscape } from "../../utils/format";

interface Props {
  logs: LogEntry[];
  onClear: () => void;
}

type LevelFilter = "all" | LogEntry["kind"];
type DatePreset  = "all" | "today" | "1h" | "24h" | "7d";
type SortKey     = "time" | "level" | "message";
type SortDir     = "asc" | "desc";

const LEVEL_LABEL: Record<LogEntry["kind"], string> = {
  ok:   "OK",
  err:  "Err",
  info: "Info",
};

const LEVEL_RANK: Record<LogEntry["kind"], number> = { err: 0, ok: 1, info: 2 };

const DATE_PRESETS: { id: DatePreset; label: string }[] = [
  { id: "all",   label: "All time" },
  { id: "today", label: "Today" },
  { id: "1h",    label: "Last hour" },
  { id: "24h",   label: "Last 24 hours" },
  { id: "7d",    label: "Last 7 days" },
];

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** Compact display: `YYYY-MM-DD HH:MM:SS`. Shows `—` for legacy entries with
 *  no recoverable date (`tsMs === 0` after migration of HH:MM:SS-only logs). */
function formatTimestamp(tsMs: number): string {
  if (!tsMs) return "—";
  const d = new Date(tsMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Tooltip with millisecond precision — shown on hover of the time cell. */
function formatTimestampPrecise(tsMs: number): string {
  if (!tsMs) return "—";
  const d = new Date(tsMs);
  return `${formatTimestamp(tsMs)}.${String(d.getMilliseconds()).padStart(3, "0")} ` +
    `(${d.toISOString()})`;
}

function dateInRange(tsMs: number, preset: DatePreset, now: number): boolean {
  if (preset === "all" || !tsMs) return preset === "all";
  if (preset === "today") {
    const d  = new Date(tsMs);
    const nd = new Date(now);
    return d.getFullYear() === nd.getFullYear()
        && d.getMonth()    === nd.getMonth()
        && d.getDate()     === nd.getDate();
  }
  if (preset === "1h")  return tsMs >= now -  60 * 60 * 1000;
  if (preset === "24h") return tsMs >= now -  24 * 60 * 60 * 1000;
  if (preset === "7d")  return tsMs >= now - 7 * 24 * 60 * 60 * 1000;
  return true;
}

const LEVEL_ICONS = {
  ok:   <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />,
  err:  <XCircle     className="w-3 h-3 text-red-500   shrink-0" />,
  info: <Info        className="w-3 h-3 text-t-ink4    shrink-0" />,
};

const LEVEL_TEXT_COLOR = {
  ok:   "text-green-500",
  err:  "text-red-500",
  info: "text-t-ink3",
};

// Three-column grid template — keep both header and body rows in lockstep.
const COLS = "grid grid-cols-[170px_70px_1fr] gap-3 items-start";

export default function ConsoleView({ logs, onClear }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [search,     setSearch]     = useState("");
  const [level,      setLevel]      = useState<LevelFilter>("all");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [sortKey,    setSortKey]    = useState<SortKey>("time");
  const [sortDir,    setSortDir]    = useState<SortDir>("desc");
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused,     setPaused]     = useState(false);
  const [snapshot,   setSnapshot]   = useState<LogEntry[] | null>(null);

  // Use frozen snapshot when paused so the table stops auto-updating while
  // the user is reading. Resume returns to live `logs`.
  const sourceLogs = paused && snapshot ? snapshot : logs;

  // Filter + sort. Search matches in the message column case-insensitively;
  // an active search also matches against formatted time so users can paste
  // `2026-05-08 14:32` and find that exact moment quickly.
  const filtered = useMemo(() => {
    const now = Date.now();
    const q   = search.trim().toLowerCase();
    let out = sourceLogs.filter(e => {
      if (level !== "all" && e.kind !== level) return false;
      if (!dateInRange(e.tsMs, datePreset, now)) return false;
      if (!q) return true;
      const msgMatch  = e.text.toLowerCase().includes(q);
      const timeMatch = formatTimestamp(e.tsMs).toLowerCase().includes(q);
      const levelMatch = LEVEL_LABEL[e.kind].toLowerCase().includes(q);
      return msgMatch || timeMatch || levelMatch;
    });

    out = [...out].sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      switch (sortKey) {
        case "time":    return (a.tsMs - b.tsMs) * dir;
        case "level":   return (LEVEL_RANK[a.kind] - LEVEL_RANK[b.kind]) * dir;
        case "message": return a.text.localeCompare(b.text) * dir;
      }
    });
    return out;
  }, [sourceLogs, search, level, datePreset, sortKey, sortDir]);

  // Auto-scroll: only meaningful when sorted by time-desc → newest at bottom.
  // (Or when sort-asc, scroll bottom is also "newest at bottom".) We scroll
  // to whichever end the new items appear at — for time-desc that's the top;
  // for everything else it's the bottom. To keep it simple we just scroll to
  // bottomRef; if user picks a non-time sort, autoScroll is less useful.
  useEffect(() => {
    if (!autoScroll || paused) return;
    if (sortKey === "time" && sortDir === "desc") {
      // Newest is at row 0 — no need to scroll, content is already on top.
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [filtered.length, autoScroll, paused, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(key === "time" ? "desc" : "asc"); }
  }

  function togglePause() {
    if (paused) {
      setPaused(false);
      setSnapshot(null);
    } else {
      setSnapshot([...logs]);
      setPaused(true);
    }
  }

  function resetFilters() {
    setSearch("");
    setLevel("all");
    setDatePreset("all");
  }

  function downloadBlob(content: string, mime: string, ext: string) {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `amqpush-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportJson() {
    downloadBlob(JSON.stringify(filtered, null, 2), "application/json", "json");
  }

  function exportCsv() {
    const header = "timestamp,level,message\n";
    const rows = filtered.map(e =>
      [csvEscape(formatTimestamp(e.tsMs)), csvEscape(LEVEL_LABEL[e.kind]), csvEscape(e.text)].join(",")
    ).join("\n");
    downloadBlob(header + rows, "text/csv", "csv");
  }

  function exportPlain() {
    const lines = filtered.map(e =>
      `${formatTimestamp(e.tsMs)}  [${LEVEL_LABEL[e.kind].toUpperCase()}]  ${e.text}`
    );
    downloadBlob(lines.join("\n") + "\n", "text/plain", "log");
  }

  // Counts per level, computed off the SOURCE (not filtered) so the
  // segmented control reflects how many of each kind exist regardless
  // of the current text/date filter.
  const counts = useMemo(() => ({
    all:  sourceLogs.length,
    ok:   sourceLogs.filter(e => e.kind === "ok").length,
    info: sourceLogs.filter(e => e.kind === "info").length,
    err:  sourceLogs.filter(e => e.kind === "err").length,
  }), [sourceLogs]);

  const filtersActive = !!search.trim() || level !== "all" || datePreset !== "all";
  const presetLabel = DATE_PRESETS.find(p => p.id === datePreset)?.label ?? "All time";

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">

      {/* ─── TOP BAR ─── */}
      <ViewTopBar
        icon={<Terminal className="w-3.5 h-3.5" />}
        title="System Logs"
        count={
          filtered.length === sourceLogs.length
            ? `${sourceLogs.length} event${sourceLogs.length !== 1 ? "s" : ""}`
            : `${filtered.length} / ${sourceLogs.length}`
        }
        status={paused
          ? <span className="flex items-center gap-1 text-[10px] text-amber-500 font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> paused
            </span>
          : <span className="flex items-center gap-1 text-[10px] text-t-ink5 font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" /> live
            </span>}
      >
        <button
          onClick={togglePause}
          aria-pressed={paused}
          title={paused
            ? "Resume — keep showing new logs as they arrive"
            : "Pause — freeze the table at its current state. New logs still get recorded; they just don't appear until you resume."
          }
          className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
            paused
              ? "text-amber-500 bg-amber-500/10 hover:bg-amber-500/20"
              : "text-t-ink4 hover:text-t-ink hover:bg-t-hover"
          }`}
        >
          {paused ? <><Play className="w-3 h-3" /> Resume</> : <><Pause className="w-3 h-3" /> Pause</>}
        </button>

        <Dropdown
          align="right"
          width="w-40"
          trigger={({ open, toggle }) => (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              disabled={filtered.length === 0}
              title="Export filtered logs"
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-t-ink4 hover:text-blue-500 hover:bg-blue-500/10 transition-colors disabled:opacity-40"
            >
              <Download className="w-3 h-3" /> Export
              <ChevronDown className="w-3 h-3" />
            </button>
          )}
        >
          <DropdownItem onClick={exportJson}>JSON</DropdownItem>
          <DropdownItem onClick={exportCsv}>CSV</DropdownItem>
          <DropdownItem onClick={exportPlain}>Plain text (.log)</DropdownItem>
        </Dropdown>

        <button
          onClick={() => setConfirmClear(true)}
          disabled={logs.length === 0}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium text-t-ink4 hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:hover:text-t-ink4 disabled:hover:bg-transparent"
        >
          <Trash2 className="w-3 h-3" /> Clear
        </button>
      </ViewTopBar>

      <ConfirmDialog
        open={confirmClear}
        title="Clear all logs"
        body={
          <p>
            Permanently delete{" "}
            <span className="font-mono font-bold text-t-ink">{logs.length.toLocaleString()}</span>{" "}
            log entr{logs.length === 1 ? "y" : "ies"}?
            This wipes the in-memory buffer <i>and</i> the persisted copy in <code className="text-t-ink4">localStorage</code> —
            past activity won't be recoverable.
          </p>
        }
        confirmLabel={`Delete ${logs.length.toLocaleString()} entr${logs.length === 1 ? "y" : "ies"}`}
        onConfirm={() => { onClear(); setConfirmClear(false); }}
        onCancel={() => setConfirmClear(false)}
      />

      {/* ─── FILTER BAR ─── */}
      <div className="shrink-0 px-3 py-1 border-b border-t-line bg-t-panel flex items-center gap-2">
        <Search className="w-3.5 h-3.5 text-t-ink5 shrink-0" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search logs by message, time or level…"
          className="flex-1 bg-transparent text-xs text-t-ink outline-none placeholder:text-t-ink5"
        />
        {search && (
          <button onClick={() => setSearch("")} className="text-t-ink5 hover:text-t-ink3 transition-colors" title="Clear search">
            <X className="w-3 h-3" />
          </button>
        )}

        {/* Level filter — column-scoped */}
        <SegmentedControl<LevelFilter>
          size="sm"
          value={level}
          onChange={setLevel}
          options={[
            { value: "all",  label: <span className="inline-flex items-center gap-1">All  {counts.all  > 0 && <span className="text-t-ink5 normal-case font-mono">{counts.all}</span>}</span> },
            { value: "ok",   label: <span className="inline-flex items-center gap-1">OK   {counts.ok   > 0 && <span className="text-t-ink5 normal-case font-mono">{counts.ok}</span>}</span> },
            { value: "info", label: <span className="inline-flex items-center gap-1">Info {counts.info > 0 && <span className="text-t-ink5 normal-case font-mono">{counts.info}</span>}</span> },
            { value: "err",  label: <span className="inline-flex items-center gap-1">Err  {counts.err  > 0 && <span className="text-t-ink5 normal-case font-mono">{counts.err}</span>}</span> },
          ]}
        />

        {/* Date preset filter — column-scoped to Time */}
        <Dropdown
          align="right"
          width="w-40"
          trigger={({ open, toggle }) => (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              title="Filter by date range"
              className={`flex items-center gap-1 text-[11px] transition-colors px-1.5 py-0.5 rounded shrink-0 ${
                datePreset !== "all" ? "text-blue-500 bg-blue-500/10" : "text-t-ink4 hover:text-t-ink3"
              }`}
            >
              <Calendar className="w-3 h-3" /> {presetLabel}
              <ChevronDown className="w-3 h-3" />
            </button>
          )}
        >
          {DATE_PRESETS.map(p => (
            <DropdownItem
              key={p.id}
              active={p.id === datePreset}
              onClick={() => setDatePreset(p.id)}
            >
              {p.label}
            </DropdownItem>
          ))}
        </Dropdown>

        {/* Follow toggle — controls viewport behaviour, NOT whether new logs
            arrive. When on, the table stays scrolled to the newest entry.
            Distinct from the top-bar Pause button, which freezes the
            displayed list entirely. */}
        <button
          onClick={() => setAutoScroll(a => !a)}
          aria-pressed={autoScroll}
          className={`flex items-center gap-1 text-[11px] transition-colors px-1.5 py-0.5 rounded shrink-0 ${
            autoScroll ? "text-blue-500 bg-blue-500/10" : "text-t-ink4 hover:text-t-ink3"
          }`}
          title={autoScroll
            ? "Follow on — viewport scrolls to the newest log. Click to keep your scroll position when new logs arrive."
            : "Follow off — your scroll position stays put when new logs arrive. Click to follow newest again."
          }
        >
          <ArrowDownToLine className="w-3 h-3" />
          Follow
        </button>
      </div>

      {/* ─── TABLE HEADER (sortable) ─── */}
      {sourceLogs.length > 0 && (
        <div className={`${COLS} shrink-0 px-3 py-1.5 border-b border-t-line bg-t-panel sticky top-0 z-10`}>
          <SortableHeader label="Time"    col="time"    current={sortKey} dir={sortDir} onClick={toggleSort} />
          <SortableHeader label="Level"   col="level"   current={sortKey} dir={sortDir} onClick={toggleSort} />
          <SortableHeader label="Message" col="message" current={sortKey} dir={sortDir} onClick={toggleSort} />
        </div>
      )}

      {/* ─── ROWS ─── */}
      <div className="flex-1 overflow-y-auto min-h-0 log-selectable font-mono">
        {sourceLogs.length === 0 ? (
          <EmptyState
            icon={<Terminal className="w-8 h-8" />}
            title="No events yet"
            subtitle="Application logs will appear here"
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Filter className="w-8 h-8" />}
            title="No logs match the active filters"
            action={filtersActive && (
              <button onClick={resetFilters}
                className="text-[11px] text-blue-500 hover:text-blue-400 transition-colors">
                Reset filters
              </button>
            )}
          />
        ) : (
          <>
            {filtered.map(entry => (
              <div
                key={entry.id}
                className={`${COLS} px-3 py-1 border-b border-t-line/40 hover:bg-t-hover/50 text-[11px]`}
              >
                <span
                  className="text-t-ink5 truncate"
                  title={formatTimestampPrecise(entry.tsMs)}
                >
                  {formatTimestamp(entry.tsMs)}
                </span>
                <span className={`flex items-center gap-1 ${LEVEL_TEXT_COLOR[entry.kind]}`}>
                  {LEVEL_ICONS[entry.kind]}
                  <span>{LEVEL_LABEL[entry.kind]}</span>
                </span>
                <span className={`${LEVEL_TEXT_COLOR[entry.kind]} break-all whitespace-pre-wrap leading-5`}>
                  {entry.text}
                </span>
              </div>
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>
    </div>
  );
}

// ─── Sortable column header ───────────────────────────────────────────────────

function SortableHeader({ label, col, current, dir, onClick }: {
  label: string;
  col: SortKey;
  current: SortKey;
  dir: SortDir;
  onClick: (k: SortKey) => void;
}) {
  const active = current === col;
  return (
    <button
      type="button"
      onClick={() => onClick(col)}
      className="flex items-center gap-1 text-left hover:text-t-ink2 transition-colors"
    >
      <SectionLabel>{label}</SectionLabel>
      {active && (
        dir === "asc"
          ? <ChevronUp   className="w-3 h-3 text-t-ink3" />
          : <ChevronDown className="w-3 h-3 text-t-ink3" />
      )}
    </button>
  );
}
