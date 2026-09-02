import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  History, Search, Trash2, RotateCcw, FileText, Tag, Download, Inbox, Mail,
  MessageSquare, X, GitCompare,
} from "lucide-react";
import { HistoryEntry } from "../../types";
import CollapsibleSection from "../CollapsibleSection";
import PropsList from "../PropsList";
import EmptyState from "../EmptyState";
import ViewTopBar from "../ViewTopBar";
import CopyButton from "../CopyButton";
import ConfirmDialog from "../ConfirmDialog";
import { fmtBytes } from "../../utils/format";
import { tryPrettyJson, tryPrettyXml, hexDump, detectFormat } from "../../utils/bodyView";
import { diffLines } from "../../utils/diff";

interface ResendArg { address: string; body?: string; fileName?: string; fileDataB64?: string; properties?: Record<string, string> }

interface Props {
  connected: boolean;
  refreshVersion?: number;
  onLog: (kind: "info" | "ok" | "err", text: string) => void;
  onResend: (entry: ResendArg) => void;
}

export default function HistoryView({ refreshVersion, onLog, onResend }: Props) {
  const [entries,    setEntries]    = useState<HistoryEntry[]>([]);
  const [search,     setSearch]     = useState("");
  const [loading,    setLoading]    = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setEntries(await invoke<HistoryEntry[]>("get_history")); }
    catch (e) { onLog("err", `History load failed: ${e}`); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, []);

  // Auto-refresh when App signals a new send
  useEffect(() => {
    if (refreshVersion === undefined || refreshVersion === 0) return;
    load();
  }, [refreshVersion]);

  async function clearAllConfirmed() {
    setClearing(true);
    try {
      await invoke("clear_history");
      setEntries([]);
      setSelectedId(null);
      onLog("info", "History cleared");
      setConfirmClear(false);
    } catch (e) {
      onLog("err", String(e));
    } finally {
      setClearing(false);
    }
  }

  async function exportAs(format: "json" | "csv") {
    try {
      const path = await invoke<string>("export_history", { format });
      onLog("ok", `Exported → ${path}`);
    } catch (e) { onLog("err", `Export failed: ${e}`); }
  }

  const q = search.toLowerCase();
  const filtered = useMemo(
    () => entries.filter(e => {
      if (!q) return true;
      // Search across: id, profile, queue, body, file_name
      if (e.id.toLowerCase().includes(q)) return true;
      if (e.profile?.toLowerCase().includes(q)) return true;
      if (e.address.toLowerCase().includes(q)) return true;
      if (e.body_preview.toLowerCase().includes(q)) return true;
      if (e.body_full?.toLowerCase().includes(q)) return true;
      if (e.file_name?.toLowerCase().includes(q)) return true;
      return false;
    }),
    [entries, q]
  );

  // Track whether the user explicitly dismissed the preview pane (clicked
  // the X button). When set, auto-select stays disabled until the user picks
  // a row again — otherwise the close-effect would race the auto-select
  // effect and the preview would never actually close.
  const userClosedRef = useRef(false);

  // Auto-select first entry when list loads / filter changes — but not when
  // the only thing that changed is the user clearing `selectedId`.
  useEffect(() => {
    if (userClosedRef.current) return;
    setSelectedId(prev => {
      if (prev && filtered.some(e => e.id === prev)) return prev;
      return filtered[0]?.id ?? null;
    });
  }, [filtered]);

  // Search input is the user's explicit action to refine the list — treat it
  // as "I want to see results", clearing the dismissed flag so auto-select
  // works again on the new filter.
  useEffect(() => {
    userClosedRef.current = false;
  }, [search]);

  function selectEntry(id: string) {
    userClosedRef.current = false;
    setSelectedId(id);
  }
  function closePreview() {
    userClosedRef.current = true;
    setSelectedId(null);
  }

  const selected = filtered.find(e => e.id === selectedId) ?? null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">

      {/* ─── TOP BAR ─── */}
      <ViewTopBar
        icon={<History className="w-3.5 h-3.5" />}
        title="Message History"
        count={filtered.length === entries.length ? `${entries.length} sent` : `${filtered.length} / ${entries.length}`}
      >
        <button onClick={load}
          className="px-2 py-1 rounded text-[11px] font-medium text-t-ink4 hover:text-blue-500 hover:bg-blue-500/10 transition-colors flex items-center gap-1"
          title="Refresh">
          <RotateCcw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
        <button onClick={() => exportAs("json")} disabled={entries.length === 0}
          className="px-2 py-1 rounded text-[11px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40 disabled:hover:text-t-ink4 disabled:hover:bg-transparent flex items-center gap-1">
          <Download className="w-3 h-3" /> JSON
        </button>
        <button onClick={() => exportAs("csv")} disabled={entries.length === 0}
          className="px-2 py-1 rounded text-[11px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40 disabled:hover:text-t-ink4 disabled:hover:bg-transparent flex items-center gap-1">
          <Download className="w-3 h-3" /> CSV
        </button>
        <button onClick={() => setConfirmClear(true)} disabled={entries.length === 0}
          className="px-2 py-1 rounded text-[11px] font-medium text-t-ink4 hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:hover:text-t-ink4 disabled:hover:bg-transparent flex items-center gap-1">
          <Trash2 className="w-3 h-3" /> Clear
        </button>
      </ViewTopBar>

      <ConfirmDialog
        open={confirmClear}
        title="Clear send history"
        body={
          <p>
            Permanently delete{" "}
            <span className="font-mono font-bold text-t-ink">{entries.length.toLocaleString()}</span>{" "}
            history entr{entries.length === 1 ? "y" : "ies"} from <code className="text-t-ink4">~/.amqpush/history.json</code>?
            This cannot be undone — resending past messages will no longer be possible.
          </p>
        }
        confirmLabel={`Delete ${entries.length.toLocaleString()} entr${entries.length === 1 ? "y" : "ies"}`}
        busy={clearing}
        busyLabel="Deleting…"
        onConfirm={clearAllConfirmed}
        onCancel={() => setConfirmClear(false)}
      />

      {/* ─── FILTER BAR — only when entries exist ─── */}
      {entries.length > 0 && (
        <div className="shrink-0 px-3 py-1 border-b border-t-line bg-t-panel flex items-center gap-2">
          <Search className="w-3.5 h-3.5 text-t-ink5 shrink-0" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter by ID, profile, queue, or body…"
            className="flex-1 bg-transparent text-xs text-t-ink outline-none placeholder:text-t-ink5" />
          {search && (
            <button onClick={() => setSearch("")} className="text-t-ink5 hover:text-t-ink3 transition-colors">
              <X className="w-3 h-3" />
            </button>
          )}
          {filtered.length !== entries.length && (
            <span className="text-[11px] text-t-ink4 shrink-0">{filtered.length} / {entries.length}</span>
          )}
        </div>
      )}

      {/* ─── SPLIT BODY: list (left) + preview (right) ─── */}
      <div className="flex-1 min-h-0 flex overflow-hidden">

        {/* ─── LIST ─── */}
        <div className={`${selected ? "w-[42%] border-r border-t-line" : "flex-1"} flex flex-col min-w-0 min-h-0 overflow-hidden`}>
          {filtered.length === 0 ? (
            <EmptyState
              icon={<History className="w-8 h-8" />}
              title={search ? "No matching entries" : "No sent messages yet"}
              subtitle={search ? undefined : "Messages you send will appear here"}
            />
          ) : (
            <div className="flex-1 overflow-y-auto">
              {filtered.map(entry => (
                <ListItem key={entry.id} entry={entry}
                  selected={entry.id === selectedId}
                  onClick={() => selectEntry(entry.id)} />
              ))}
            </div>
          )}
        </div>

        {/* ─── PREVIEW PANE ─── */}
        {selected && (
          <PreviewPane
            entry={selected}
            entries={entries}
            onResend={onResend}
            onLog={onLog}
            onClose={closePreview}
          />
        )}
        {!selected && filtered.length > 0 && (
          <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
            <EmptyState
              icon={<Inbox className="w-8 h-8" />}
              title="Select a message to preview"
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── List item — compact row in left pane ───────────────────────────────────
//
// Layout matches SubscriberView: row 1 has icon + ID + timestamp (right-aligned);
// row 2 has profile · queue · prop-count, indented `pl-5`. No standalone-row
// timestamp at the top.

function ListItem({ entry, selected, onClick }: { entry: HistoryEntry; selected: boolean; onClick: () => void }) {
  const propCount = Object.keys(entry.properties).length;

  return (
    <button onClick={onClick}
      className={`w-full text-left flex flex-col gap-0.5 px-3 py-2 border-b border-t-line/40 transition-colors border-l-2 border-l-transparent ${
        selected ? "bg-blue-500/10" : "hover:bg-t-hover/50"
      }`}>
      <div className="flex items-center gap-2 text-[11px]">
        {entry.is_file
          ? <FileText className="w-3 h-3 text-amber-500 shrink-0" />
          : <Mail     className="w-3 h-3 text-t-ink5 shrink-0" />}
        <span className="text-t-ink2 font-mono truncate flex-1" title={entry.id}>{entry.id}</span>
        <span className="text-t-ink5 font-mono shrink-0">{entry.timestamp}</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] pl-5">
        {entry.profile && (
          <span className="text-t-ink4 font-mono truncate" title={`Profile: ${entry.profile}`}>
            {entry.profile}
          </span>
        )}
        <span className="px-1 rounded bg-blue-500/15 text-blue-500 font-mono font-medium truncate" title={`Queue: ${entry.address}`}>
          {entry.address}
        </span>
        {propCount > 0 && (
          <span className="text-t-ink5 font-mono">
            {propCount} {propCount === 1 ? "prop" : "props"}
          </span>
        )}
        {entry.is_file && entry.file_name && (
          <span className="text-amber-500 font-mono truncate" title={`File: ${entry.file_name}`}>
            {entry.file_name}
          </span>
        )}
      </div>
    </button>
  );
}

// ─── Preview pane — full details on the right ───────────────────────────────

function PreviewPane({ entry, entries, onResend, onLog, onClose }: {
  entry: HistoryEntry;
  /** Full history list — needed to find a peer for body diff (the most
   *  recent prior send to the same queue). */
  entries: HistoryEntry[];
  onResend: (a: ResendArg) => void;
  onLog: (k: "info" | "ok" | "err", t: string) => void;
  onClose: () => void;
}) {
  const [diffPeer, setDiffPeer] = useState<HistoryEntry | null>(null);

  // The most recent text-body entry sent to the same queue strictly
  // before this one. Used as the default "compare with" target — that's
  // almost always what the user wants when investigating "did this send
  // differ from the last successful one?".
  const previousToSameQueue = useMemo<HistoryEntry | null>(() => {
    if (entry.is_file) return null;
    // entries arrive most-recent first; iterate forward to find a peer
    // that's older AND on the same address.
    const idx = entries.findIndex(e => e.id === entry.id);
    if (idx < 0) return null;
    for (let i = idx + 1; i < entries.length; i++) {
      const peer = entries[i];
      if (peer.address === entry.address && !peer.is_file) return peer;
    }
    return null;
  }, [entry, entries]);
  const [bodyMode,  setBodyMode]  = useState<"auto" | "raw" | "hex">("auto");
  const [propsOpen, setPropsOpen] = useState(true);
  const [autoOpen,  setAutoOpen]  = useState(true);
  const [customOpen, setCustomOpen] = useState(true);
  const [bodyOpen,  setBodyOpen]  = useState(true);

  // Reset body viewer mode when selection changes
  useEffect(() => { setBodyMode("auto"); }, [entry.id]);

  const bodyText = entry.body_full ?? entry.body_preview;

  // Pull content-type out of saved auto/custom properties so format detection
  // works for non-default types (XML, plain text). Auto props win since
  // those are what AMQPush actually sets on send.
  const contentType =
    entry.auto_properties?.["content-type"] ??
    entry.properties?.["content-type"] ??
    null;

  const detected = detectFormat({ contentType, bodyText });
  const hasProps = Object.keys(entry.properties).length > 0;
  const autoEntries = Object.entries(entry.auto_properties ?? {})
    .sort(([a], [b]) => a.localeCompare(b));

  // Compose body content according to view-mode
  const bodyContent = (() => {
    if (entry.is_file || !bodyText) return null;
    if (bodyMode === "hex") return hexDump(bodyText);
    if (bodyMode === "raw") return bodyText;
    if (detected === "json") return tryPrettyJson(bodyText) ?? bodyText;
    if (detected === "xml")  return tryPrettyXml(bodyText)  ?? bodyText;
    return bodyText;
  })();

  const bodyBytes = bodyText ? new TextEncoder().encode(bodyText).length : 0;

  return (
    <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden select-text">

      {/* ─── PREVIEW HEADER (single row, px-3 py-1.5) ─── */}
      <div className="shrink-0 px-3 py-1.5 border-b border-t-line bg-t-panel flex items-center gap-2">
        {entry.is_file
          ? <FileText className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          : <Mail     className="w-3.5 h-3.5 text-t-ink4 shrink-0" />}
        <span className="text-[12px] text-t-ink font-mono truncate" title={entry.id}>{entry.id}</span>
        <span className="text-[11px] text-t-ink5 font-mono shrink-0">{entry.timestamp}</span>
        <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-500 font-mono shrink-0" title={`Queue: ${entry.address}`}>
          {entry.address}
        </span>

        <div className="ml-auto flex items-center gap-1">
          {!entry.is_file ? (
            <>
              <button
                onClick={() => onResend({ address: entry.address, body: bodyText, properties: entry.properties })}
                title="Resend this message"
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-blue-500 hover:bg-blue-500/10 transition-colors"
              >
                <RotateCcw className="w-3 h-3" /> Resend
              </button>
              <button
                onClick={() => previousToSameQueue && setDiffPeer(previousToSameQueue)}
                disabled={!previousToSameQueue}
                title={previousToSameQueue
                  ? `Compare body with the previous send to '${entry.address}' (${previousToSameQueue.timestamp})`
                  : "No earlier send to this queue to compare against"}
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40 disabled:hover:text-t-ink4 disabled:hover:bg-transparent"
              >
                <GitCompare className="w-3 h-3" /> Compare
              </button>
              <CopyButton
                value={bodyText}
                onCopied={() => onLog("info", "Body copied")}
                label="Copy"
                title="Copy body"
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors"
              />
            </>
          ) : entry.file_data_b64 ? (
            <button
              onClick={() => onResend({ address: entry.address, fileName: entry.file_name ?? "file", fileDataB64: entry.file_data_b64!, properties: entry.properties })}
              title="Resend this file"
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-blue-500 hover:bg-blue-500/10 transition-colors"
            >
              <RotateCcw className="w-3 h-3" /> Resend
            </button>
          ) : null}
          <button
            onClick={onClose}
            title="Close preview"
            className="p-1 rounded text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* ─── PREVIEW BODY ─── */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">

        {/* Header chips — match SubscriberView */}
        <div className="flex items-center gap-2 text-[11px] flex-wrap">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-t-hover text-t-ink3 font-medium uppercase">
            {entry.is_file ? "binary" : detected}
          </span>
          {bodyText && <span className="text-t-ink5 font-mono">{fmtBytes(bodyBytes)}</span>}
          {entry.is_file && entry.file_name && (
            <span className="text-amber-500 font-mono">{entry.file_name}</span>
          )}
          {entry.is_file && (
            <span className={`font-mono ${entry.file_data_b64 ? "text-green-500" : "text-t-ink5"}`}>
              {entry.file_data_b64 ? "stored" : "content not retained"}
            </span>
          )}
        </div>

        <CollapsibleSection
          title="Properties"
          icon={<Tag className="w-3 h-3" />}
          open={propsOpen}
          onToggle={() => setPropsOpen(o => !o)}
        >
          <PropsList onLog={onLog} items={[
            ["id",       entry.id],
            ["time",     entry.timestamp],
            ["profile",  entry.profile ?? null],
            ["queue",    entry.address],
            ["file",     entry.file_name],
          ]} />
        </CollapsibleSection>

        {autoEntries.length > 0 && (
          <CollapsibleSection
            title={`Auto-set headers (${autoEntries.length})`}
            icon={<Tag className="w-3 h-3" />}
            open={autoOpen}
            onToggle={() => setAutoOpen(o => !o)}
          >
            <PropsList onLog={onLog} items={autoEntries} />
          </CollapsibleSection>
        )}

        <CollapsibleSection
          title={`Custom properties (${Object.keys(entry.properties).length})`}
          icon={<Tag className="w-3 h-3" />}
          open={customOpen}
          onToggle={() => setCustomOpen(o => !o)}
        >
          {hasProps
            ? <PropsList onLog={onLog} items={Object.entries(entry.properties)} />
            : <p className="text-[11px] text-t-ink5">— none —</p>
          }
        </CollapsibleSection>

        {!entry.is_file && (
          <CollapsibleSection
            title="Body"
            icon={<MessageSquare className="w-3 h-3" />}
            open={bodyOpen}
            onToggle={() => setBodyOpen(o => !o)}
            action={
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center bg-t-card border border-t-line rounded overflow-hidden">
                  {(["auto", "raw", "hex"] as const).map(m => (
                    <button
                      key={m}
                      onClick={(e) => { e.stopPropagation(); setBodyMode(m); }}
                      className={`px-1.5 py-0.5 text-[10px] font-mono transition-colors ${
                        bodyMode === m ? "bg-blue-500/15 text-blue-500" : "text-t-ink4 hover:text-t-ink2 hover:bg-t-hover"
                      }`}
                      title={
                        m === "auto" ? `Auto (${detected})` :
                        m === "raw"  ? "Raw text" : "Hex dump"
                      }
                    >
                      {m === "auto" ? "Auto" : m === "raw" ? "Raw" : "Hex"}
                    </button>
                  ))}
                </div>
                {bodyText && (
                  <CopyButton
                    value={bodyText}
                    onCopied={() => onLog("info", "Body copied")}
                    label="Copy"
                    className="flex items-center gap-1 text-[10px] text-t-ink4 hover:text-t-ink2 transition-colors px-1.5 py-0.5 rounded hover:bg-t-hover"
                  />
                )}
              </div>
            }
          >
            <pre className="text-[11px] text-t-ink2 font-mono bg-t-field border border-t-line rounded-md p-2.5 overflow-x-auto whitespace-pre break-all max-h-80 overflow-y-auto select-text">
              {bodyContent ?? <em className="text-t-ink5">no body</em>}
            </pre>
          </CollapsibleSection>
        )}
      </div>

      {diffPeer && (
        <HistoryDiffModal
          left={diffPeer}
          right={entry}
          onClose={() => setDiffPeer(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HistoryDiffModal — side-by-side body diff between two history entries.
//
// Reuses the LCS-based `diffLines` algorithm from utils/diff.ts (same one
// that powers SubscriberView's compare-two-messages flow). Bodies are
// pretty-formatted before diffing — that way structural diffs in JSON/XML
// align line-for-line instead of showing as one giant changed line.
// ─────────────────────────────────────────────────────────────────────────────

function HistoryDiffModal({ left, right, onClose }: {
  left: HistoryEntry;
  right: HistoryEntry;
  onClose: () => void;
}) {
  // Format each body by its likely subtype before diffing — same trick as
  // Receive's diff modal. Avoids spurious "everything changed" when JSON is
  // re-serialized with different whitespace.
  const fmtBody = (e: HistoryEntry) => {
    const raw = e.body_full ?? e.body_preview ?? "";
    const subtype = detectFormat({ contentType: null, bodyText: raw });
    if (subtype === "json") return tryPrettyJson(raw) ?? raw;
    if (subtype === "xml")  return tryPrettyXml(raw)  ?? raw;
    return raw;
  };
  const leftBody  = fmtBody(left);
  const rightBody = fmtBody(right);
  const ops = useMemo(() => diffLines(leftBody, rightBody), [leftBody, rightBody]);
  const diffCount = ops.filter(o => o.kind !== "eq").length;

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="bg-t-bg border border-t-line rounded-lg shadow-2xl w-[1040px] max-w-[95vw] max-h-[90vh] flex flex-col overflow-hidden">

        <div className="shrink-0 px-4 py-2.5 border-b border-t-line bg-t-panel flex items-center gap-2">
          <GitCompare className="w-3.5 h-3.5 text-t-ink4" />
          <span className="text-[13px] font-semibold text-t-ink">Compare body</span>
          <span className="text-[11px] text-t-ink5">
            — {diffCount} line{diffCount !== 1 ? "s" : ""} differ
          </span>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-t-hover text-t-ink4 hover:text-t-ink">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Side-by-side headers */}
        <div className="shrink-0 grid grid-cols-2 gap-px bg-t-line border-b border-t-line">
          <div className="bg-t-panel px-3 py-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-blue-500 font-bold">Earlier</span>
              <span className="text-[11px] font-mono text-t-ink2 truncate">{left.id}</span>
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-t-ink5 font-mono">
              <span>{left.timestamp}</span>
              <span>{left.address}</span>
            </div>
          </div>
          <div className="bg-t-panel px-3 py-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-amber-500 font-bold">Selected</span>
              <span className="text-[11px] font-mono text-t-ink2 truncate">{right.id}</span>
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-t-ink5 font-mono">
              <span>{right.timestamp}</span>
              <span>{right.address}</span>
            </div>
          </div>
        </div>

        {/* Body diff */}
        <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-5">
          {ops.map((op, i) => {
            const bg =
              op.kind === "del" ? "bg-red-500/10" :
              op.kind === "add" ? "bg-green-500/10" :
                                  "";
            const sign =
              op.kind === "del" ? "−" :
              op.kind === "add" ? "+" : " ";
            const text =
              op.kind === "del" ? op.left :
              op.kind === "add" ? op.right :
                                  op.left;
            const align =
              op.kind === "del" ? "text-red-500"   :
              op.kind === "add" ? "text-green-500" :
                                  "text-t-ink3";
            return (
              <div key={i} className={`grid grid-cols-2 gap-px ${bg}`}>
                <div className={`px-3 py-0.5 whitespace-pre-wrap break-all ${op.kind === "add" ? "text-t-ink5" : align}`}>
                  {op.kind !== "add" ? <><span className="text-t-ink5">{sign} </span>{text}</> : <span className="text-t-ink5">{"  "}</span>}
                </div>
                <div className={`px-3 py-0.5 whitespace-pre-wrap break-all ${op.kind === "del" ? "text-t-ink5" : align}`}>
                  {op.kind !== "del" ? <><span className="text-t-ink5">{sign} </span>{text}</> : <span className="text-t-ink5">{"  "}</span>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="shrink-0 px-3 py-1.5 border-t border-t-line bg-t-panel flex items-center text-[10px] text-t-ink5">
          <span>JSON / XML pretty-printed before diffing so structural changes align by line.</span>
          <span className="ml-auto flex items-center gap-1">
            <kbd className="font-mono px-1 py-0.5 border border-t-line rounded">Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
