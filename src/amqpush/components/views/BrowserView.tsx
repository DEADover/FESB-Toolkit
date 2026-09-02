import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Radar, RotateCcw, Inbox, Send, X, Loader2, Eye,
  Tag, MessageSquare, Search, Trash2, AlertTriangle, CornerUpLeft, ShieldAlert,
  Users, CheckSquare, Square, Edit3, ChevronLeft, ChevronRight, ChevronDown, SkipForward,
  ArrowRightLeft, Loader2 as Spinner,
} from "lucide-react";
import CollapsibleSection from "../CollapsibleSection";
import PropsList from "../PropsList";
import EmptyState from "../EmptyState";
import { useAmqpText } from "../../i18n";
import ViewTopBar from "../ViewTopBar";
import CopyButton from "../CopyButton";
import CodeEditor from "../CodeEditor";
import { fmtBytes, fmtDuration } from "../../utils/format";
import { tryPrettyJson, tryPrettyXml, hexDump, detectFormat } from "../../utils/bodyView";
import type { BrokerConnection, BrokerConsumer, Profile } from "../../types";

interface BrokerQueue {
  name: string;
  address: string;
  message_count: number;
  consumer_count: number;
  routing_type: string;
}

interface PeekedMessage {
  message_id: string | null;
  user_id: string | null;
  to: string | null;
  subject: string | null;
  reply_to: string | null;
  correlation_id: string | null;
  content_type: string | null;
  content_encoding: string | null;
  absolute_expiry_time: number | null;
  creation_time: number | null;
  group_id: string | null;
  group_sequence: number | null;
  reply_to_group_id: string | null;
  application_properties: Record<string, string>;
  body_text: string | null;
  body_kind: string;
  body_size: number;
  priority: number | null;
  durable: boolean | null;
  ttl_ms: number | null;
  delivery_count: number;
}

interface Props {
  connected: boolean;
  visible: boolean;
  onLog: (kind: "info" | "ok" | "err", text: string) => void;
  onPublishTo: (address: string) => void;
  onSubscribeTo: (address: string) => void;
  /** Saved profiles list — used by the Shovel modal to pick a target
   *  profile. Optional so existing call sites that don't shovel can omit it. */
  profiles?: Profile[];
  /** Currently active profile name — shown as "source" in the Shovel modal. */
  activeProfile?: string;
}

const PEEK_DEFAULT_MAX = 20;
const PEEK_DEFAULT_TIMEOUT_MS = 1500;
/** Hard ceiling on a single peek when "All" is requested — protects the UI
 *  from accidentally trying to fetch a million messages on a giant queue.
 *  Power users with legitimately huge queues can re-peek to pick up more. */
const PEEK_HARD_CAP = 50_000;
/** Discrete preset values in the peek-max dropdown. `0` means "All" (resolves
 *  dynamically from the queue's broker-reported message_count, capped at
 *  `PEEK_HARD_CAP`). */
const PEEK_PRESETS: number[] = [10, 50, 100, 500, 1000, 5000, 0];
const QUEUE_POLL_INTERVAL_MS = 2500;

type SortKey = "name" | "messages" | "consumers" | "type";
type SortDir = "asc" | "desc";

// ── DLQ detection & requeue helpers ──────────────────────────────────────────
//
// Heuristic queue-name match — we treat anything that looks like a dead-letter
// or expiry queue as a DLQ for the purposes of showing the requeue UI. The
// detection is liberal on purpose; the worst case is that the user sees a
// "Requeue" button on a non-DLQ queue and the requeue still works (it just
// republishes to wherever `_AMQ_ORIG_ADDRESS` points, or no-ops if absent).
function isDlqQueueName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "dlq" ||
    n === "expiryqueue" ||
    n === "activemq.dlq" ||
    n.endsWith(".dlq") ||
    n.endsWith("_dlq") ||
    n.includes("dlq") ||
    n.includes("dead")
  );
}

/** Property keys Artemis / Classic / Solace stamp on DLQ messages with the
 *  original delivery target. We try them in priority order. */
const DLQ_ORIGIN_KEYS = [
  "_AMQ_ORIG_ADDRESS",     // Artemis (most common)
  "_AMQ_ORIG_QUEUE",       // Artemis fallback (queue-level)
  "originalDestination",   // ActiveMQ Classic
  "JMSXOriginalDestination",
];

/** Internal app properties to strip when republishing — otherwise the broker
 *  may immediately re-DLQ the message (it sees the original-address marker
 *  and treats the requeue as another failed delivery). */
const DLQ_STRIP_KEYS = new Set([
  ..._dlqStripBaseKeys(),
]);

function _dlqStripBaseKeys(): string[] {
  return [
    "_AMQ_ORIG_ADDRESS",
    "_AMQ_ORIG_QUEUE",
    "_AMQ_ORIG_REASON",
    "_AMQ_ORIG_BINDINGS",
    "_AMQ_DLA_HISTORY",
    "originalDestination",
    "JMSXOriginalDestination",
    // _AMQ_ROUTING_TYPE will be re-added by the backend on send, so strip
    // here too to avoid stale ANYCAST/MULTICAST hints from the dropped
    // delivery.
    "_AMQ_ROUTING_TYPE",
  ];
}

/** Return the original destination from a peeked message's app properties,
 *  or `null` if none of the known keys is present / non-empty. */
function originalDestination(props: Record<string, string>): string | null {
  for (const k of DLQ_ORIGIN_KEYS) {
    const v = props[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export default function BrowserView({ connected, visible, onLog, onPublishTo, onSubscribeTo, profiles = [], activeProfile = "" }: Props) {
  const t = useAmqpText();
  const [queues,    setQueues]    = useState<BrokerQueue[]>([]);
  const [loading,   setLoading]   = useState(false);
  const [err,       setErr]       = useState<string | null>(null);
  const [search,    setSearch]    = useState("");
  const [loaded,    setLoaded]    = useState(false);
  const [sortKey,   setSortKey]   = useState<SortKey>("name");
  const [sortDir,   setSortDir]   = useState<SortDir>("asc");
  const [hideEmpty, setHideEmpty] = useState(false);
  const [autoOn,    setAutoOn]    = useState(true);
  const [pollErr,   setPollErr]   = useState<string | null>(null);

  // Peek state — selected queue and messages
  const [selectedQueue, setSelectedQueue] = useState<string | null>(null);
  const [messages,      setMessages]      = useState<PeekedMessage[]>([]);
  const [peekLoading,   setPeekLoading]   = useState(false);
  const [peekErr,       setPeekErr]       = useState<string | null>(null);
  const [peekMax,       setPeekMax]       = useState(PEEK_DEFAULT_MAX);
  const [openMessageIdx, setOpenMessageIdx] = useState<number | null>(null);
  /** Set to a queue address while a Purge-confirm modal is open for it. */
  const [purgeConfirm,  setPurgeConfirm]  = useState<string | null>(null);
  const [purging,       setPurging]       = useState(false);
  /** Requeue progress — `null` when idle, `{done, total}` while running. */
  const [requeueProgress, setRequeueProgress] = useState<{ done: number; total: number } | null>(null);
  /** Bulk-selection of peeked DLQ messages — set of indices into `messages`.
   *  Cleared on every peek refresh / queue switch so stale indices can't
   *  point at messages that aren't there anymore. */
  const [selectedIdxs, setSelectedIdxs] = useState<Set<number>>(new Set());
  /** When non-null, the Edit & Requeue modal walks through these messages,
   *  letting the user tweak body and target address before resubmit. */
  const [editRequeueMsgs, setEditRequeueMsgs] = useState<PeekedMessage[] | null>(null);
  /** When non-null, the Shovel modal is open and walks this exact list.
   *  Set from the header button (= full peek snapshot) or from the
   *  selection bar (= only the selected subset). Closing frees the
   *  transient target connection in the Rust side. */
  const [shovelMsgs, setShovelMsgs] = useState<PeekedMessage[] | null>(null);
  /** Confirm modal state for selective purge — list of message-ids to
   *  remove via `remove_messages_by_ids`. */
  const [purgeSelectedConfirm, setPurgeSelectedConfirm] = useState<{ ids: string[]; total: number } | null>(null);

  // ─── Auto-refresh queue list (cheap call: only metrics, no message bodies) ──
  useEffect(() => {
    if (!connected || !visible || !autoOn) return;

    if (!loaded && !loading) refreshQueues(false);

    const id = setInterval(() => { refreshQueues(true); }, QUEUE_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [connected, visible, autoOn, loaded]);

  /** Reload queue list. `silent` = no spinner / no log entries (used by polling). */
  async function refreshQueues(silent: boolean) {
    if (!connected) { setErr(t("browser.notConnectedLog")); return; }
    if (!silent) {
      setLoading(true);
      setErr(null);
    }
    try {
      const list = await invoke<BrokerQueue[]>("list_broker_queues");
      setQueues(list);
      setLoaded(true);
      setPollErr(null);
      if (!silent) {
        setErr(null);
        onLog("ok", `Discovered ${list.length} queue${list.length !== 1 ? "s" : ""} on broker`);
      }
    } catch (e) {
      const msg = String(e);
      if (silent) {
        setPollErr(msg);
      } else {
        setErr(msg);
        onLog("err", `Browse failed: ${msg}`);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }

  /**
   * Peek messages from `queue`. The optional `maxOverride` lets callers
   * supply a specific cap when the React state hasn't yet caught up — e.g.
   * the Max dropdown's onChange fires `setPeekMax(N)` and immediately
   * triggers `peekQueue(q, N)` because the new state value wouldn't be
   * visible in the same closure.
   */
  async function peekQueue(queue: string, maxOverride?: number) {
    setSelectedQueue(queue);
    setPeekLoading(true);
    setPeekErr(null);
    setMessages([]);
    setOpenMessageIdx(null);
    setSelectedIdxs(new Set());
    try {
      // `peekMax === 0` is the UI's "All" sentinel — resolve to the queue's
      // reported message_count at peek time, capped at PEEK_HARD_CAP so a
      // queue of one million doesn't hang the UI for half an hour. If the
      // queue isn't in our list (yet?) we fall back to PEEK_DEFAULT_MAX.
      const queueRow = queues.find(q => q.address === queue);
      const requestedMax = maxOverride ?? peekMax;
      const effectiveMax = requestedMax === 0
        ? Math.min(PEEK_HARD_CAP, Math.max(PEEK_DEFAULT_MAX, queueRow?.message_count ?? PEEK_DEFAULT_MAX))
        : requestedMax;
      const msgs = await invoke<PeekedMessage[]>("peek_messages", {
        queue, max: effectiveMax, timeoutMs: PEEK_DEFAULT_TIMEOUT_MS,
      });
      setMessages(msgs);
      onLog("ok", `Peeked ${msgs.length} message${msgs.length !== 1 ? "s" : ""} from '${queue}' (released back)`);
    } catch (e) {
      const msg = String(e);
      setPeekErr(msg);
      onLog("err", `Peek failed on '${queue}': ${msg}`);
    } finally {
      setPeekLoading(false);
    }
  }

  function closePeek() {
    setSelectedQueue(null);
    setMessages([]);
    setPeekErr(null);
    setOpenMessageIdx(null);
  }

  /**
   * Invoke the destructive `purge_queue` Tauri command. Caller is expected
   * to have already shown a confirm dialog. On success we re-peek to show
   * the (now empty) queue so the user immediately sees the result.
   */
  async function purgeQueue(queue: string) {
    setPurging(true);
    try {
      const removed = await invoke<number>("purge_queue", { queue });
      onLog("ok", `Purged ${removed} message${removed !== 1 ? "s" : ""} from '${queue}'`);
      setPurgeConfirm(null);
      // Refresh both: the queue list (msg count went to 0) and the peek pane.
      await refreshQueues(true);
      await peekQueue(queue);
    } catch (e) {
      onLog("err", `Purge failed: ${e}`);
    } finally {
      setPurging(false);
    }
  }

  /**
   * Republish one or more peeked DLQ messages to their original destinations.
   * Each message keeps its body text and (most of) its application properties
   * — internal markers like `_AMQ_ORIG_ADDRESS` are stripped so the broker
   * doesn't immediately re-DLQ the requeued copy.
   *
   * Messages without an original-destination property are skipped (we can't
   * know where to send them). The caller is responsible for purging the DLQ
   * separately if they want to clean up — we don't delete from DLQ here
   * because the broker's per-message remove API would need the broker-side
   * message id, which AMQP peek doesn't expose.
   */
  async function requeueMessages(msgs: PeekedMessage[]): Promise<void> {
    const targets = msgs
      .map(m => ({ msg: m, origin: originalDestination(m.application_properties) }))
      .filter((x): x is { msg: PeekedMessage; origin: string } => !!x.origin);

    if (targets.length === 0) {
      onLog("err", t("browser.noOrigin"));
      return;
    }

    setRequeueProgress({ done: 0, total: targets.length });
    let ok = 0;
    let failed = 0;

    for (let i = 0; i < targets.length; i++) {
      const { msg, origin } = targets[i];
      try {
        await resubmitOne(msg, origin, msg.body_text ?? "");
        ok++;
      } catch (e) {
        failed++;
        onLog("err", `Requeue → ${origin} failed: ${e}`);
      }
      setRequeueProgress({ done: i + 1, total: targets.length });
    }

    setRequeueProgress(null);
    const skipped = msgs.length - targets.length;
    onLog(failed === 0 ? "ok" : "err",
      `Requeued ${ok}/${targets.length} message${targets.length !== 1 ? "s" : ""}` +
      (failed > 0 ? ` · ${failed} failed` : "") +
      (skipped > 0 ? ` · ${skipped} skipped (no origin)` : ""));
  }

  /**
   * Send one DLQ message to `target` with `body` text, carrying its
   * non-internal application properties. Used both by the no-edit Requeue
   * flow (original body, origin target) and by the Edit & Requeue modal
   * (potentially-edited body, possibly-overridden target). Throws on send
   * failure so the caller can surface a per-message error.
   */
  async function resubmitOne(msg: PeekedMessage, target: string, body: string): Promise<void> {
    // Strip DLQ-internal markers; keep the rest of the original app props.
    const customProps: Record<string, string> = {};
    for (const [k, v] of Object.entries(msg.application_properties)) {
      if (!DLQ_STRIP_KEYS.has(k)) customProps[k] = v;
    }
    await invoke("send_message", {
      address: target,
      text: body,
      fileName: null,
      fileDataB64: null,
      customProps,
      replyTo: msg.reply_to ?? null,
      profile: null,
    });
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  }

  function skipIfSelecting(): boolean {
    const sel = window.getSelection?.()?.toString();
    return !!sel && sel.length > 0;
  }

  // Filter + sort
  let filtered = queues;
  if (search.trim()) {
    const q = search.toLowerCase();
    filtered = filtered.filter(it =>
      it.name.toLowerCase().includes(q) || it.address.toLowerCase().includes(q));
  }
  if (hideEmpty) filtered = filtered.filter(it => it.message_count > 0);
  filtered = [...filtered].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    switch (sortKey) {
      case "name":      return a.name.localeCompare(b.name) * dir;
      case "type":      return a.routing_type.localeCompare(b.routing_type) * dir;
      case "messages":  return (a.message_count - b.message_count) * dir;
      case "consumers": return (a.consumer_count - b.consumer_count) * dir;
    }
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">

      {/* ─── TOP BAR ─── */}
      <ViewTopBar
        icon={<Radar className="w-3.5 h-3.5" />}
        title={t("browser.title")}
        count={loaded ? (
          filtered.length === queues.length
            ? t("browser.queues", { count: queues.length })
            : `${filtered.length} / ${queues.length}`
        ) : null}
        status={connected && autoOn && pollErr ? (
          <span className="flex items-center gap-1 text-[10.5px] text-caution font-mono" title={t("browser.pollError.hint", { error: pollErr })}>
            <span className="w-1.5 h-1.5 rounded-full bg-caution" />
            {t("browser.pollError")}
          </span>
        ) : connected && autoOn && loaded ? (
          <span className="flex items-center gap-1 text-[10.5px] text-t-ink5 font-mono" title={`Auto-refresh every ${QUEUE_POLL_INTERVAL_MS / 1000}s`}>
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            live
          </span>
        ) : null}
      >
        <button
          onClick={() => setAutoOn(a => !a)}
          aria-pressed={autoOn}
          className={`text-[11.5px] transition-colors px-1.5 py-0.5 rounded-md ${
            autoOn ? "text-accent bg-accent/10" : "text-t-ink4 hover:text-t-ink3"
          }`}
          title={autoOn ? t("browser.auto.on") : t("browser.auto.off")}
        >
          {autoOn ? `● ${t("browser.auto")}` : `○ ${t("browser.auto")}`}
        </button>
        <button
          onClick={() => setHideEmpty(h => !h)}
          aria-pressed={hideEmpty}
          className={`text-[11.5px] transition-colors px-1.5 py-0.5 rounded-md ${
            hideEmpty ? "text-accent bg-accent/10" : "text-t-ink4 hover:text-t-ink3"
          }`}
          title={t("browser.hideEmpty.hint")}
        >
          {t("browser.hideEmpty")}
        </button>
        <button onClick={() => refreshQueues(false)} disabled={!connected || loading}
          className="h-7 px-2.5 rounded-lg text-[12px] font-medium text-t-ink4 hover:text-accent hover:bg-accent/10 transition-colors flex items-center gap-1 disabled:opacity-40">
          <RotateCcw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} /> {t("browser.refresh")}
        </button>
      </ViewTopBar>

      {/* ─── FILTER BAR — only when there are queues to filter ─── */}
      {loaded && queues.length > 0 && (
        <div className="shrink-0 px-3 py-1 border-b border-t-line bg-t-panel flex items-center gap-2">
          <Search className="w-3.5 h-3.5 text-t-ink5 shrink-0" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t("browser.search")}
            className="flex-1 bg-transparent text-xs text-t-ink outline-none placeholder:text-t-ink5" />
          {search && (
            <button onClick={() => setSearch("")} className="text-t-ink5 hover:text-t-ink3 transition-colors">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      {/* ─── BODY: split — left list / right peek ─── */}
      <div className="flex-1 min-h-0 flex overflow-hidden">

        {/* ─── LEFT: QUEUE TABLE ─── */}
        <div className={`${selectedQueue ? "w-[45%] border-r border-t-line" : "flex-1"} flex flex-col min-w-0 min-h-0 overflow-hidden`}>
          {!connected ? (
            <EmptyState icon={<Radar className="w-8 h-8" />} title={t("browser.notConnected")} subtitle={t("browser.notConnected.hint")} />
          ) : loading && queues.length === 0 ? (
            <EmptyState icon={<Loader2 className="w-8 h-8 animate-spin" />} title={t("browser.querying")} />
          ) : err ? (
            <EmptyState
              variant="error"
              title={t("browser.failed")}
              subtitle={<>
                {err}
                <p className="text-[10.5px] mt-3 text-t-ink5">{t("browser.failed.hint")}</p>
              </>}
              action={
                <button onClick={() => refreshQueues(false)}
                  className="h-7 px-2.5 rounded-lg text-[12px] font-medium bg-t-card border border-t-line text-t-ink2 hover:bg-t-hover transition-colors">
                  {t("browser.retry")}
                </button>
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState icon={<Radar className="w-8 h-8" />} title={search || hideEmpty ? t("browser.nothing") : t("browser.none")} />
          ) : (
            <div className="flex-1 overflow-auto min-h-0">
              <table className="w-full text-[12.5px] font-mono table-fixed">
                <thead className="sticky top-0 z-10 bg-t-panel border-b border-t-line">
                  <tr className="text-[11px] tracking-wide text-content-subtle select-none">
                    <SortableHeader label={t("browser.column.name")}  sortKey="name"      current={sortKey} dir={sortDir} onClick={toggleSort} className="text-left  pl-3" />
                    <SortableHeader label={t("browser.column.type")}  sortKey="type"      current={sortKey} dir={sortDir} onClick={toggleSort} className="text-left  w-24" />
                    <SortableHeader label={t("browser.column.msgs")}  sortKey="messages"  current={sortKey} dir={sortDir} onClick={toggleSort} className="text-right w-14" />
                    <SortableHeader label={t("browser.column.cons")}  sortKey="consumers" current={sortKey} dir={sortDir} onClick={toggleSort} className="text-right w-12" />
                    {!selectedQueue && <th className="text-left w-44 font-semibold py-1.5 px-2">{t("browser.column.address")}</th>}
                    <th className="w-24 pr-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(bq => {
                    const isSel = selectedQueue === bq.address;
                    return (
                      <tr key={bq.name}
                        onClick={() => { if (skipIfSelecting()) return; peekQueue(bq.address); }}
                        className={`group cursor-pointer border-b border-t-line/40 transition-colors ${
                          isSel ? "bg-accent/10" : "hover:bg-t-hover/50"
                        }`}>
                        <td className="py-1.5 px-3 truncate">
                          <span className="text-t-ink">{bq.name}</span>
                        </td>
                        <td className="py-1.5 px-2">
                          <span className={`text-[10.5px] px-1 rounded-md font-medium ${
                            bq.routing_type === "ANYCAST" ? "bg-accent/15 text-accent" : "bg-accent-content/15 text-accent-content"
                          }`}>{bq.routing_type === "ANYCAST" ? "ANY" : "MULTI"}</span>
                        </td>
                        <td className={`py-1.5 px-2 text-right ${bq.message_count > 0 ? "text-t-ink font-medium" : "text-t-ink5"}`}>
                          {bq.message_count}
                        </td>
                        <td className={`py-1.5 px-2 text-right ${bq.consumer_count > 0 ? "text-positive" : "text-t-ink5"}`}>
                          {bq.consumer_count}
                        </td>
                        {!selectedQueue && (
                          <td className="py-1.5 px-2 truncate text-t-ink4 text-[11.5px]">{bq.address}</td>
                        )}
                        <td className="py-1.5 pr-2">
                          <div className="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <IconBtn title={t("browser.publishTo")} onClick={(e) => { e.stopPropagation(); onPublishTo(bq.address); }} colorClass="hover:text-accent hover:bg-accent/10">
                              <Send className="w-3 h-3" />
                            </IconBtn>
                            <IconBtn title={t("browser.subscribeTo")} onClick={(e) => { e.stopPropagation(); onSubscribeTo(bq.address); }} colorClass="hover:text-positive hover:bg-positive/10">
                              <Inbox className="w-3 h-3" />
                            </IconBtn>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ─── RIGHT: PEEK PANE ─── */}
        {selectedQueue && (
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            {/* Peek pane header — matches SubscriberView preview header style */}
            <div className="shrink-0 px-3 py-1.5 border-b border-t-line bg-t-panel flex items-center gap-2">
              <Eye className="w-3.5 h-3.5 text-t-ink4 shrink-0" />
              <span className="text-[12.5px] text-t-ink font-mono truncate" title={selectedQueue}>{selectedQueue}</span>
              {!peekLoading && !peekErr && (
                <span className="text-[11.5px] text-t-ink5 font-mono">{messages.length} peeked</span>
              )}

              <div className="ml-auto flex items-center gap-1">
                <select value={peekMax}
                  onChange={e => {
                    // Changing the cap immediately re-peeks the current queue,
                    // so the user doesn't have to follow up with a Refresh
                    // click. The override is needed because `setPeekMax` is
                    // async and the just-captured closure still has the old
                    // value.
                    const next = Number(e.target.value);
                    setPeekMax(next);
                    if (selectedQueue && !peekLoading) {
                      peekQueue(selectedQueue, next);
                    }
                  }}
                  className="bg-t-field border border-t-line2 rounded-md px-1.5 py-0.5 text-[11.5px] text-t-ink2 outline-none"
                  title={t("browser.peekMax")}>
                  {PEEK_PRESETS.map(n => (
                    <option key={n} value={n}>{n === 0 ? t("browser.all") : n}</option>
                  ))}
                </select>
                <button onClick={() => peekQueue(selectedQueue)}
                  title={t("browser.refresh")}
                  className="flex items-center gap-1 h-7 px-2.5 rounded-lg text-[12px] font-medium text-t-ink4 hover:text-accent hover:bg-accent/10 transition-colors">
                  <RotateCcw className={`w-3 h-3 ${peekLoading ? "animate-spin" : ""}`} /> {t("browser.refresh")}
                </button>
                <button
                  onClick={() => setShovelMsgs(messages)}
                  disabled={messages.length === 0 || peekLoading || profiles.length < 2}
                  title={profiles.length < 2
                    ? t("browser.shovel.needsProfiles")
                    : messages.length === 0
                      ? t("browser.shovel.empty")
                      : t("browser.shovel.hint")}
                  className="flex items-center gap-1 h-7 px-2.5 rounded-lg text-[12px] font-medium text-t-ink4 hover:text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <ArrowRightLeft className="w-3 h-3" /> {t("browser.shovel")}
                </button>
                {/* On DLQ queues we always render the Requeue-all button so
                    its location is discoverable even when the queue is
                    currently empty — the action banner above mentions it, so
                    a hidden button is confusing. Disabled + tooltip when
                    there's nothing to requeue. */}
                {isDlqQueueName(selectedQueue) && (
                  <button
                    onClick={() => requeueMessages(messages)}
                    disabled={!!requeueProgress || peekLoading || messages.length === 0}
                    title={
                      messages.length === 0
                        ? t("browser.requeue.empty")
                        : t("browser.requeue.hint", { count: messages.length })
                    }
                    className="flex items-center gap-1 h-7 px-2.5 rounded-lg text-[12px] font-medium text-accent bg-accent/10 hover:bg-accent/20 transition-colors disabled:opacity-40 disabled:hover:bg-accent/10"
                  >
                    {requeueProgress
                      ? <><Loader2 className="w-3 h-3 animate-spin" /> {t("browser.requeue.progress", { done: requeueProgress.done, total: requeueProgress.total })}</>
                      : <><CornerUpLeft className="w-3 h-3" /> {t("browser.requeue.all")}</>}
                  </button>
                )}
                <button
                  onClick={() => setPurgeConfirm(selectedQueue)}
                  disabled={messages.length === 0 || peekLoading}
                  title={messages.length === 0
                    ? t("browser.purge.empty")
                    : t("browser.purge.hint")}
                  className="flex items-center gap-1 h-7 px-2.5 rounded-lg text-[12px] font-medium text-t-ink4 hover:text-negative hover:bg-negative/10 transition-colors disabled:opacity-40 disabled:hover:text-t-ink4 disabled:hover:bg-transparent"
                >
                  <Trash2 className="w-3 h-3" /> {t("browser.purge")}
                </button>
                <button onClick={closePeek}
                  title={t("browser.close")}
                  className="p-1 rounded-md text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors">
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* DLQ banner — shown for queues whose names match common dead-letter
                patterns. Surfaces the requeue feature without forcing the user
                to dig through Help. */}
            {isDlqQueueName(selectedQueue) && (
              <div className="shrink-0 px-3 py-2 border-b border-t-line bg-caution/5 flex items-start gap-2 text-[11.5px]">
                <ShieldAlert className="w-3.5 h-3.5 text-caution shrink-0 mt-0.5" />
                <div className="text-t-ink2 leading-relaxed">
                  <span className="text-caution font-medium">{t("browser.dlq")}</span>{" "}
                  {t("browser.dlq.note")}
                </div>
              </div>
            )}

            {peekLoading ? (
              <EmptyState icon={<Loader2 className="w-8 h-8 animate-spin" />} title={t("browser.peeking")} subtitle={t("browser.peeking.hint")} />
            ) : peekErr ? (
              <EmptyState variant="error" title={t("browser.peekFailed")} subtitle={peekErr} />
            ) : messages.length === 0 ? (
              <EmptyState icon={<Inbox className="w-8 h-8" />} title={t("browser.empty")} />
            ) : (
              <>
                {/* Selection bar — shown on any queue when ≥1 row is picked.
                    Universal actions: Purge selected, Shovel selected. DLQ
                    queues additionally get Edit & Requeue / Requeue selected. */}
                {selectedIdxs.size > 0 && (() => {
                  const picked = [...selectedIdxs].sort((a, b) => a - b).map(i => messages[i]).filter(Boolean) as PeekedMessage[];
                  const withId = picked.filter(m => m.message_id && m.message_id.trim()).length;
                  const isDlq = isDlqQueueName(selectedQueue);
                  return (
                    <div className="shrink-0 px-3 py-1.5 border-b border-t-line bg-accent/5 flex items-center gap-2 flex-wrap">
                      <span className="text-[11.5px] text-accent font-medium">
                        {t("browser.selected", { count: selectedIdxs.size })}
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedIdxs(new Set())}
                        className="text-[11.5px] text-t-ink4 hover:text-t-ink2 transition-colors"
                      >
                        {t("browser.clear")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedIdxs(new Set(messages.map((_, i) => i)))}
                        disabled={selectedIdxs.size === messages.length}
                        className="text-[11.5px] text-t-ink4 hover:text-t-ink2 transition-colors disabled:opacity-40"
                      >
                        {t("browser.selectAll")}
                      </button>

                      <div className="ml-auto flex items-center gap-1">
                        {/* DLQ-only: Edit & Requeue (modal) + Requeue selected (no edit). */}
                        {isDlq && (
                          <>
                            <button
                              type="button"
                              onClick={() => setEditRequeueMsgs(picked)}
                              disabled={!!requeueProgress}
                              title={t("browser.editRequeue.hint")}
                              className="flex items-center gap-1 h-7 px-2.5 rounded-lg text-[12px] font-medium text-accent bg-accent/10 hover:bg-accent/20 transition-colors disabled:opacity-40"
                            >
                              <Edit3 className="w-3 h-3" /> {t("browser.editRequeue")}
                            </button>
                            <button
                              type="button"
                              onClick={() => requeueMessages(picked)}
                              disabled={!!requeueProgress}
                              title={t("browser.requeue.selected.hint")}
                              className="flex items-center gap-1 h-7 px-2.5 rounded-lg text-[12px] font-medium text-t-ink2 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
                            >
                              <CornerUpLeft className="w-3 h-3" /> {t("browser.requeue.selected")}
                            </button>
                          </>
                        )}
                        {/* Universal: Shovel selected. Need ≥2 profiles. */}
                        <button
                          type="button"
                          onClick={() => setShovelMsgs(picked)}
                          disabled={profiles.length < 2}
                          title={profiles.length < 2
                            ? t("browser.shovel.needsProfiles")
                            : t("browser.shovel.selected.hint")}
                          className="flex items-center gap-1 h-7 px-2.5 rounded-lg text-[12px] font-medium text-t-ink2 hover:text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                          <ArrowRightLeft className="w-3 h-3" /> {t("browser.shovel.selected")}
                        </button>
                        {/* Universal: Purge selected. Requires message-ids on
                            every picked message (Artemis removeMessages selector
                            uses AMQUserID); button disabled + tooltip when any
                            selected lacks a message-id. */}
                        <button
                          type="button"
                          onClick={() => setPurgeSelectedConfirm({
                            ids: picked.map(m => m.message_id ?? "").filter(s => !!s),
                            total: picked.length,
                          })}
                          disabled={withId !== picked.length || withId === 0}
                          title={withId === picked.length
                            ? t("browser.purge.selected.hint", { count: picked.length })
                            : t("browser.purge.selected.noIds", { count: picked.length - withId })}
                          className="flex items-center gap-1 h-7 px-2.5 rounded-lg text-[12px] font-medium text-t-ink4 hover:text-negative hover:bg-negative/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-t-ink4"
                        >
                          <Trash2 className="w-3 h-3" /> {t("browser.purge.selected")}
                        </button>
                      </div>
                    </div>
                  );
                })()}

                {/* List of peeked messages — visually matches SubscriberView's received list.
                    Sorted newest-first by AMQP `creation_time` (falls back to broker-delivery
                    order for messages that don't carry one). `origIdx` is the position in the
                    backend's response and is what `selectedIdxs` / `openMessageIdx` reference. */}
                <div className="flex-1 overflow-auto min-h-0 border-b border-t-line">
                  {/* Column header — sticky on scroll. Second-row chips are
                      heterogeneous so no label is useful there. */}
                  <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1 bg-t-panel/95 backdrop-blur-sm border-b border-t-line text-[11px] tracking-wide text-content-subtle select-none">
                    <span className="w-3.5 shrink-0" /> {/* checkbox column */}
                    <span className="w-3 shrink-0" />   {/* message-icon column */}
                    <span className="w-6 shrink-0 font-semibold">#</span>
                    <span className="font-semibold flex-1">{t("browser.column.messageId")}</span>
                    <span className="font-semibold shrink-0">{t("browser.column.time")}</span>
                  </div>
                  {[...messages]
                    .map((m, origIdx) => ({ m, origIdx }))
                    .sort((a, b) => (b.m.creation_time ?? 0) - (a.m.creation_time ?? 0))
                    .map(({ m: msg, origIdx }) => {
                    const isOpen = openMessageIdx === origIdx;
                    const isSel = selectedIdxs.has(origIdx);
                    const idShort = msg.message_id ?? "—";
                    const ct = msg.content_type ?? msg.body_kind;
                    // Compact ISO-like local date-time (YYYY-MM-DD HH:MM:SS) —
                    // matches the format used by Receive so users can correlate
                    // peek and receive timestamps without mental conversion.
                    const timeText = msg.creation_time
                      ? (() => {
                          const d = new Date(msg.creation_time);
                          const pad = (n: number) => String(n).padStart(2, "0");
                          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
                            + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
                        })()
                      : "—";
                    return (
                      <div
                        key={origIdx}
                        className={`group flex items-start border-b border-t-line/40 transition-colors border-l-2 border-l-transparent ${
                          isOpen ? "bg-accent/10" : "hover:bg-t-hover/50"
                        }`}
                      >
                        {/* Selection checkbox column — shown on every queue
                            so the user can multi-select for Purge / Shovel /
                            (DLQ) Edit & Requeue. `pt-2` matches the content
                            button's `py-2` so the checkbox icon lines up
                            with the message icon on the first text line. */}
                        <button
                          type="button"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setSelectedIdxs(prev => {
                              const next = new Set(prev);
                              if (next.has(origIdx)) next.delete(origIdx); else next.add(origIdx);
                              return next;
                            });
                          }}
                          className="shrink-0 pl-3 pr-1 pt-[10px] flex items-start text-t-ink5 hover:text-accent transition-colors"
                          aria-label={isSel ? `Unselect #${origIdx + 1}` : `Select #${origIdx + 1}`}
                        >
                          {isSel
                            ? <CheckSquare className="w-3.5 h-3.5 text-accent" />
                            : <Square className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => { if (skipIfSelecting()) return; setOpenMessageIdx(isOpen ? null : origIdx); }}
                          className="flex-1 min-w-0 text-left flex flex-col gap-0.5 pl-1 pr-3 py-2"
                        >
                          <div className="flex items-center gap-2 text-[11.5px]">
                            <MessageSquare className="w-3 h-3 text-t-ink5 shrink-0" />
                            <span className="text-t-ink5 font-mono shrink-0 w-6">#{origIdx + 1}</span>
                            <span className="text-t-ink2 font-mono truncate flex-1" title={msg.message_id ?? ""}>{idShort}</span>
                            <span className="text-t-ink5 font-mono shrink-0">{timeText}</span>
                          </div>
                          <div className="flex items-center gap-2 text-[10.5px] pl-5">
                            <span className="px-1 rounded-md bg-t-hover text-t-ink3 font-mono">{ct}</span>
                            <span className="text-t-ink5 font-mono">{fmtBytes(msg.body_size)}</span>
                            {msg.priority !== null && msg.priority !== 4 && (
                              <span className="text-t-ink4 font-mono">P{msg.priority}</span>
                            )}
                            {msg.delivery_count > 0 && (
                              <span className="text-t-ink4 font-mono" title={t("browser.delivery")}>↻ {msg.delivery_count}</span>
                            )}
                          </div>
                        </button>
                      </div>
                    );
                  })}
                </div>

                {/* Selected message details */}
                {openMessageIdx !== null && messages[openMessageIdx] && (
                  <div className="shrink-0 max-h-[55%] overflow-auto p-3 bg-t-card/40 border-t border-t-line">
                    <MessageDetails
                      msg={messages[openMessageIdx]}
                      idx={openMessageIdx}
                      queue={selectedQueue}
                      onLog={onLog}
                      onRequeue={isDlqQueueName(selectedQueue) ? () => requeueMessages([messages[openMessageIdx]!]) : undefined}
                      onEditRequeue={isDlqQueueName(selectedQueue) ? () => setEditRequeueMsgs([messages[openMessageIdx]!]) : undefined}
                      requeueDisabled={!!requeueProgress}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ─── PURGE CONFIRM MODAL ─── */}
      {purgeConfirm && (
        <PurgeConfirmModal
          queue={purgeConfirm}
          messageCount={queues.find(q => q.address === purgeConfirm)?.message_count ?? messages.length}
          purging={purging}
          onConfirm={() => purgeQueue(purgeConfirm)}
          onCancel={() => setPurgeConfirm(null)}
        />
      )}

      {/* ─── EDIT & REQUEUE MODAL ─── */}
      {editRequeueMsgs && (
        <EditRequeueModal
          messages={editRequeueMsgs}
          onResubmit={resubmitOne}
          onLog={onLog}
          onClose={() => setEditRequeueMsgs(null)}
        />
      )}

      {/* ─── SHOVEL MODAL ─── */}
      {shovelMsgs && selectedQueue && (
        <ShovelModal
          messages={shovelMsgs}
          sourceQueue={selectedQueue}
          profiles={profiles}
          activeProfile={activeProfile}
          onLog={onLog}
          onClose={() => setShovelMsgs(null)}
        />
      )}

      {/* ─── SELECTIVE-PURGE CONFIRM MODAL ─── */}
      {purgeSelectedConfirm && selectedQueue && (
        <SelectivePurgeModal
          queue={selectedQueue}
          ids={purgeSelectedConfirm.ids}
          total={purgeSelectedConfirm.total}
          purging={purging}
          onCancel={() => setPurgeSelectedConfirm(null)}
          onConfirm={async () => {
            setPurging(true);
            try {
              const removed = await invoke<number>("remove_messages_by_ids", {
                queue: selectedQueue,
                messageIds: purgeSelectedConfirm.ids,
              });
              onLog("ok", `Removed ${removed} message${removed === 1 ? "" : "s"} from '${selectedQueue}'`);
              setSelectedIdxs(new Set());
              setPurgeSelectedConfirm(null);
              await peekQueue(selectedQueue);
              refreshQueues(true);
            } catch (e) {
              onLog("err", `Selective purge failed: ${e}`);
            } finally {
              setPurging(false);
            }
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function PurgeConfirmModal({ queue, messageCount, purging, onConfirm, onCancel }: {
  queue: string;
  messageCount: number;
  purging: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useAmqpText();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onCancel}>
      <div onClick={e => e.stopPropagation()}
        className="bg-t-bg border border-t-line rounded-xl shadow-2xl w-[460px] max-w-[90vw] flex flex-col overflow-hidden">

        <div className="shrink-0 px-4 py-2.5 border-b border-t-line bg-t-panel flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-negative" />
          <span className="text-[13px] font-semibold text-t-ink">{t("browser.purge.title")}</span>
          <button onClick={onCancel} className="ml-auto p-1 rounded-md hover:bg-t-hover text-t-ink4 hover:text-t-ink">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-2 text-[13px] text-t-ink2">
          <p>{t("browser.purge.body", { count: messageCount.toLocaleString(), queue })}</p>
          <p className="text-[11.5px] text-t-ink5">{t("browser.purge.note")}</p>
        </div>

        <div className="shrink-0 px-3 py-2 border-t border-t-line bg-t-panel flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={purging}
            className="px-3 py-1 rounded-lg text-[11.5px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={purging}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-negative hover:bg-negative text-white text-[11.5px] font-semibold transition-colors disabled:opacity-40"
          >
            {purging ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            {purging ? t("browser.purging") : t("browser.purge.confirm", { count: messageCount.toLocaleString() })}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confirmation dialog for selective purge — deletes only the picked messages
 * (by AMQP message-id) via Artemis's `removeMessages(filter)` management op.
 * `total` is the number the user selected; `ids` is the subset that has a
 * non-empty message-id and is therefore eligible for selective delete (the
 * caller already filtered, but we show both numbers for clarity).
 */
function SelectivePurgeModal({ queue, ids, total, purging, onConfirm, onCancel }: {
  queue: string;
  ids: string[];
  total: number;
  purging: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useAmqpText();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onCancel}>
      <div onClick={e => e.stopPropagation()}
        className="bg-t-bg border border-t-line rounded-xl shadow-2xl w-[460px] max-w-[90vw] flex flex-col overflow-hidden">
        <div className="shrink-0 px-4 py-2.5 border-b border-t-line bg-t-panel flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-negative" />
          <span className="text-[13px] font-semibold text-t-ink">{t("browser.purgeSel.title")}</span>
          <button onClick={onCancel} className="ml-auto p-1 rounded-md hover:bg-t-hover text-t-ink4 hover:text-t-ink">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-2 text-[13px] text-t-ink2">
          <p>{t("browser.purgeSel.body", { count: ids.length.toLocaleString(), queue })}</p>
          {ids.length !== total && (
            <p className="text-[11.5px] text-caution">
              {t("browser.purgeSel.partial", { count: total - ids.length, total })}
            </p>
          )}
          <p className="text-[11.5px] text-t-ink5">{t("browser.purgeSel.note")}</p>
        </div>
        <div className="shrink-0 px-3 py-2 border-t border-t-line bg-t-panel flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={purging}
            className="px-3 py-1 rounded-lg text-[11.5px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={purging || ids.length === 0}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-negative hover:bg-negative text-white text-[11.5px] font-semibold transition-colors disabled:opacity-40"
          >
            {purging ? <Spinner className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            {purging ? t("browser.deleting") : t("browser.purge.confirm", { count: ids.length.toLocaleString() })}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function SortableHeader({ label, sortKey, current, dir, onClick, className }: {
  label: string; sortKey: SortKey; current: SortKey; dir: SortDir;
  onClick: (k: SortKey) => void; className?: string;
}) {
  const active = current === sortKey;
  return (
    <th onClick={() => onClick(sortKey)}
      className={`font-semibold py-1.5 px-2 cursor-pointer select-none hover:text-t-ink2 ${className ?? ""}`}>
      {label}{active && (dir === "asc" ? " ↑" : " ↓")}
    </th>
  );
}

function IconBtn({ title, onClick, colorClass, children }: {
  title: string; onClick: (e: React.MouseEvent) => void; colorClass: string; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} title={title}
      className={`p-1 rounded-md text-t-ink4 transition-colors ${colorClass}`}>
      {children}
    </button>
  );
}

function MessageDetails({ msg, idx, queue, onLog, onRequeue, onEditRequeue, requeueDisabled }: {
  msg: PeekedMessage;
  idx: number;
  /** Queue address this message was peeked from — needed by the "who holds
   *  it?" drill-down to filter the consumer list. */
  queue: string;
  onLog: (k: "info" | "ok" | "err", t: string) => void;
  /** When set, render a "Requeue this message" button — passed in only for
   *  DLQ queues, so non-DLQ peeks don't grow this UI. */
  onRequeue?: () => void;
  /** When set, render an "Edit & Requeue…" button that opens the modal in
   *  single-message mode (body editable, target overridable before send). */
  onEditRequeue?: () => void;
  requeueDisabled?: boolean;
}) {
  const t = useAmqpText();
  const [bodyOpen,  setBodyOpen]  = useState(true);
  const [propsOpen, setPropsOpen] = useState(true);
  const [appOpen,   setAppOpen]   = useState(true);
  const [bodyMode,  setBodyMode]  = useState<"auto" | "raw" | "hex">("auto");

  // "Who holds this message?" — lazy-loaded consumer list filtered by queue.
  // Artemis doesn't expose a per-message lock owner via management, but it
  // does report which consumers have credit currently outstanding against
  // the queue. That's the practical answer: any consumer with non-zero
  // `messages_in_transit` against this queue is sitting on (some) messages.
  const [holderOpen,    setHolderOpen]    = useState(false);
  const [holderLoading, setHolderLoading] = useState(false);
  const [holderErr,     setHolderErr]     = useState<string | null>(null);
  const [holderCons,    setHolderCons]    = useState<BrokerConsumer[]>([]);
  const [holderConns,   setHolderConns]   = useState<BrokerConnection[]>([]);
  const [holderAt,      setHolderAt]      = useState<number>(0);

  async function loadHolders() {
    setHolderLoading(true);
    setHolderErr(null);
    try {
      const [ks, cs] = await Promise.all([
        invoke<BrokerConsumer[]>("list_broker_consumers"),
        invoke<BrokerConnection[]>("list_broker_connections"),
      ]);
      setHolderCons(ks.filter(k => k.queue === queue || k.address === queue || k.address === `[${queue}]`));
      setHolderConns(cs);
      setHolderAt(Date.now());
    } catch (e) {
      setHolderErr(String(e));
    } finally {
      setHolderLoading(false);
    }
  }

  function toggleHolders() {
    const next = !holderOpen;
    setHolderOpen(next);
    if (next && holderAt === 0) {
      void loadHolders();
    }
  }

  // Reset body view-mode + close holder panel when switching message.
  useEffect(() => {
    setBodyMode("auto");
    setHolderOpen(false);
    setHolderAt(0);
    setHolderCons([]);
    setHolderErr(null);
  }, [idx, queue]);

  // Rust's HashMap doesn't preserve insertion order, so sort alphabetically
  // for a stable display — otherwise the same message peeked twice can show
  // its properties in different orders, which looks like a UI bug.
  const appProps = Object.entries(msg.application_properties)
    .sort(([a], [b]) => a.localeCompare(b));
  const detected = detectFormat({ contentType: msg.content_type, bodyText: msg.body_text });

  const bodyContent = (() => {
    const raw = msg.body_text ?? "";
    if (!raw) return null;
    if (bodyMode === "hex") return hexDump(raw);
    if (bodyMode === "raw") return raw;
    if (detected === "json") return tryPrettyJson(raw) ?? raw;
    if (detected === "xml")  return tryPrettyXml(raw)  ?? raw;
    return raw;
  })();

  return (
    <div className="space-y-3">
      {/* Header chips — match Subscriber/History */}
      <div className="flex items-center gap-2 text-[11.5px] flex-wrap">
        <span className="text-t-ink5 font-mono">#{idx + 1}</span>
        <span className="text-[10.5px] px-1.5 py-0.5 rounded-md bg-t-hover text-t-ink3 font-medium uppercase">{msg.body_kind}</span>
        <span className="text-t-ink5 font-mono">{fmtBytes(msg.body_size)}</span>
        {msg.delivery_count > 0 && (
          <span className="text-t-ink4" title={t("browser.delivery")}>↻ {msg.delivery_count}</span>
        )}
        {msg.priority !== null && msg.priority !== 4 && <span className="text-t-ink4">P{msg.priority}</span>}
        {msg.durable && <span className="text-accent">{t("browser.durable")}</span>}
        <button
          type="button"
          onClick={toggleHolders}
          title={t("browser.whoHolds.hint")}
          className={`ml-auto flex items-center gap-1 text-[11.5px] transition-colors px-1.5 py-0.5 rounded-md ${
            holderOpen
              ? "text-accent bg-accent/10"
              : "text-t-ink4 hover:text-accent hover:bg-accent/10"
          }`}
        >
          <Users className="w-3 h-3" /> {t("clients.whoHolds")}
        </button>
        {onEditRequeue && (
          // Edit & Requeue chip is shown on DLQ for every peeked message —
          // independent of whether the origin can be auto-detected, since
          // the modal lets the user pick a target explicitly.
          <button
            type="button"
            onClick={onEditRequeue}
            disabled={requeueDisabled}
            title={t("browser.edit")}
            className="flex items-center gap-1 text-[11.5px] font-medium text-t-ink3 hover:text-accent disabled:opacity-40 transition-colors"
          >
            <Edit3 className="w-3 h-3" /> {t("browser.editRequeue")}
          </button>
        )}
        {onRequeue && (() => {
          // Discoverable per-message Requeue: shown only on DLQ queues, and
          // only when this message has an origin we can read. Disabled while
          // a bulk-requeue pass is in flight to avoid clobbering the progress
          // counter.
          const origin = originalDestination(msg.application_properties);
          if (!origin) return null;
          return (
            <button
              type="button"
              onClick={onRequeue}
              disabled={requeueDisabled}
              title={t("browser.requeueOne", { origin })}
              className="flex items-center gap-1 text-[11.5px] font-medium text-accent hover:text-accent-content disabled:opacity-40 transition-colors"
            >
              <CornerUpLeft className="w-3 h-3" /> Requeue → <span className="font-mono">{origin}</span>
            </button>
          );
        })()}
      </div>

      {/* "Who holds this message?" panel — lazy-loaded consumer drill-down */}
      {holderOpen && (
        <div className="rounded-md border border-t-line bg-t-card/40 p-2">
          <div className="flex items-center gap-2 mb-2 text-[11.5px]">
            <Users className="w-3 h-3 text-t-ink4" />
            <span className="text-t-ink2 font-medium">{t("browser.consumers")}</span>
            <span className="text-t-ink5 font-mono">{holderCons.length}</span>
            <button
              type="button"
              onClick={loadHolders}
              disabled={holderLoading}
              title={t("browser.refresh")}
              className="ml-auto flex items-center gap-1 text-[10.5px] text-t-ink4 hover:text-t-ink2 transition-colors px-1 py-0.5 rounded-md hover:bg-t-hover disabled:opacity-40"
            >
              <RotateCcw className={`w-3 h-3 ${holderLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
          {holderLoading && holderCons.length === 0 ? (
            <div className="text-[11.5px] text-t-ink5 italic">{t("browser.consumers.loading")}</div>
          ) : holderErr ? (
            <div className="text-[11.5px] text-negative">{t("browser.consumers.failed", { error: holderErr })}</div>
          ) : holderCons.length === 0 ? (
            <div className="text-[11.5px] text-t-ink5">
              {t("browser.consumers.noneNow")}{" "}
              {msg.delivery_count > 0
                ? t("browser.consumers.redelivered", { count: msg.delivery_count })
                : t("browser.consumers.none")}
            </div>
          ) : (
            <table className="w-full text-[11.5px] font-mono">
              <thead className="text-[10px] uppercase tracking-wide text-content-subtle">
                <tr className="border-b border-t-line/60">
                  <th className="text-left pb-1 font-semibold">{t("browser.consumers.client")}</th>
                  <th className="text-left pb-1 font-semibold w-24">{t("browser.consumers.user")}</th>
                  <th className="text-right pb-1 font-semibold w-12" title={t("browser.consumers.credit.hint")}>{t("browser.consumers.credit")}</th>
                  <th className="text-right pb-1 font-semibold w-20">{t("browser.consumers.lastRx")}</th>
                </tr>
              </thead>
              <tbody>
                {holderCons.map(k => {
                  const conn = holderConns.find(c => c.connection_id === k.connection_id);
                  const isHolding = k.messages_in_transit > 0;
                  const lastRx = k.last_delivered_time > 0
                    ? `${fmtDuration(Math.max(0, Date.now() - k.last_delivered_time))} ago`
                    : "—";
                  return (
                    <tr key={k.id} className={isHolding ? "bg-accent/5" : ""}>
                      <td className="py-1 text-t-ink2 truncate" title={conn?.client_address ?? k.connection_id}>
                        {conn?.client_address || k.connection_id || "—"}
                      </td>
                      <td className="py-1 text-t-ink3 truncate" title={conn?.users ?? ""}>{conn?.users || "—"}</td>
                      <td className={`py-1 text-right ${isHolding ? "text-accent font-medium" : "text-t-ink5"}`}>
                        {k.messages_in_transit}
                      </td>
                      <td className="py-1 text-right text-t-ink5">{lastRx}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {holderCons.some(k => k.messages_in_transit > 0) && (
            <div className="mt-2 text-[10.5px] text-t-ink5 leading-relaxed">
              {t("browser.holders.note")}
            </div>
          )}
        </div>
      )}

      <CollapsibleSection title={t("browser.props")} icon={<Tag className="w-3 h-3" />} open={propsOpen} onToggle={() => setPropsOpen(o => !o)}>
        <PropsList onLog={onLog} items={[
          ["message-id",       msg.message_id],
          ["correlation-id",   msg.correlation_id],
          ["reply-to",         msg.reply_to],
          ["to",               msg.to],
          ["subject",          msg.subject],
          ["content-type",     msg.content_type],
          ["content-encoding", msg.content_encoding],
          ["user-id",          msg.user_id],
          ["group-id",         msg.group_id],
          ["group-sequence",   msg.group_sequence?.toString() ?? null],
          ["reply-to-group-id", msg.reply_to_group_id],
          ["creation-time",    msg.creation_time ? new Date(msg.creation_time).toISOString() : null],
          ["absolute-expiry",  msg.absolute_expiry_time ? new Date(msg.absolute_expiry_time).toISOString() : null],
          ["priority",         msg.priority?.toString() ?? null],
          ["durable",          msg.durable?.toString() ?? null],
          ["ttl-ms",           msg.ttl_ms?.toString() ?? null],
          ["delivery-count",   msg.delivery_count.toString()],
        ]} />
      </CollapsibleSection>

      {appProps.length > 0 && (
        <CollapsibleSection title={`Application Properties (${appProps.length})`} icon={<Tag className="w-3 h-3" />} open={appOpen} onToggle={() => setAppOpen(o => !o)}>
          <PropsList onLog={onLog} items={appProps} />
        </CollapsibleSection>
      )}

      <CollapsibleSection
        title={t("browser.body")}
        icon={<MessageSquare className="w-3 h-3" />}
        open={bodyOpen}
        onToggle={() => setBodyOpen(o => !o)}
        action={
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center bg-t-card border border-t-line rounded-md overflow-hidden">
              {(["auto", "raw", "hex"] as const).map(m => (
                <button
                  key={m}
                  onClick={(e) => { e.stopPropagation(); setBodyMode(m); }}
                  className={`px-1.5 py-0.5 text-[10.5px] font-mono transition-colors ${
                    bodyMode === m ? "bg-accent/15 text-accent" : "text-t-ink4 hover:text-t-ink2 hover:bg-t-hover"
                  }`}
                  title={
                    m === "auto" ? t("history.body.auto", { kind: detected }) :
                    m === "raw"  ? t("browser.body.raw") : t("browser.body.hex")
                  }
                >
                  {m === "auto" ? "Auto" : m === "raw" ? "Raw" : "Hex"}
                </button>
              ))}
            </div>
            {msg.body_text && (
              <CopyButton
                value={msg.body_text}
                onCopied={() => onLog("info", t("browser.copied"))}
                label={t("history.copy")}
                className="flex items-center gap-1 text-[10.5px] text-t-ink4 hover:text-t-ink2 transition-colors px-1.5 py-0.5 rounded-md hover:bg-t-hover"
              />
            )}
          </div>
        }
      >
        <pre className="text-[11.5px] text-t-ink2 font-mono bg-t-field border border-t-line rounded-lg p-2.5 overflow-x-auto whitespace-pre break-all max-h-64 overflow-y-auto select-text">
          {bodyContent ?? <em className="text-t-ink5">{t("browser.body.none")}</em>}
        </pre>
      </CollapsibleSection>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Edit & Requeue walkthrough modal.
 *
 * Steps through `messages` one at a time. For each, the user sees the
 * body in a CodeMirror editor (JSON / XML / text auto-detected) and can
 * tweak it; the target address defaults to the message's
 * original-destination property (`_AMQ_ORIG_ADDRESS`, `originalDestination`,
 * ...) but can be overridden to send to any other queue. Buttons:
 *   - **Skip** — move on without sending; the message stays on the DLQ.
 *   - **Resubmit & next** — send the (possibly edited) message to the
 *     target, then move to the next step.
 *   - **Cancel** — close the modal without doing anything else.
 * The last step swaps "& next" for "& finish".
 *
 * Resubmit operations are delegated to the caller via `onResubmit(msg,
 * target, body)` so the modal stays agnostic about the send pipeline.
 */
function EditRequeueModal({ messages, onResubmit, onLog, onClose }: {
  messages: PeekedMessage[];
  onResubmit: (msg: PeekedMessage, target: string, body: string) => Promise<void>;
  onLog: (k: "info" | "ok" | "err", t: string) => void;
  onClose: () => void;
}) {
  const t = useAmqpText();
  // Step index in the walkthrough — bounded to [0, messages.length].
  const [step, setStep] = useState(0);
  // Per-message draft (body + target). Initialised lazily from the message
  // on first visit so editing one and going back to it preserves the edit.
  const [drafts, setDrafts] = useState<Record<number, { body: string; target: string }>>({});
  // Running results per index — used for the summary on the final step.
  const [results, setResults] = useState<Record<number, "sent" | "skipped" | "failed">>({});
  const [sending, setSending] = useState(false);

  const finished = step >= messages.length;
  const msg = finished ? null : messages[step];

  // Build / fetch the current draft for the active step.
  const draft = (() => {
    if (!msg) return null;
    const existing = drafts[step];
    if (existing) return existing;
    const initialTarget = originalDestination(msg.application_properties) ?? "";
    const initialBody = msg.body_text ?? "";
    return { body: initialBody, target: initialTarget };
  })();

  function updateDraft(patch: Partial<{ body: string; target: string }>) {
    setDrafts(prev => ({
      ...prev,
      [step]: { ...(prev[step] ?? draft!), ...patch },
    }));
  }

  function detectedLang(body: string): "json" | "xml" | undefined {
    const f = detectFormat({ contentType: msg?.content_type, bodyText: body });
    return f === "json" ? "json" : f === "xml" ? "xml" : undefined;
  }

  async function doResubmit() {
    if (!msg || !draft) return;
    const target = draft.target.trim();
    if (!target) {
      onLog("err", t("browser.targetRequired"));
      return;
    }
    setSending(true);
    try {
      await onResubmit(msg, target, draft.body);
      onLog("ok", `Resubmitted #${step + 1} → ${target}`);
      setResults(r => ({ ...r, [step]: "sent" }));
      setStep(s => s + 1);
    } catch (e) {
      onLog("err", `Resubmit #${step + 1} failed: ${e}`);
      setResults(r => ({ ...r, [step]: "failed" }));
    } finally {
      setSending(false);
    }
  }

  function doSkip() {
    setResults(r => ({ ...r, [step]: "skipped" }));
    setStep(s => s + 1);
  }

  const sentCount    = Object.values(results).filter(v => v === "sent").length;
  const skippedCount = Object.values(results).filter(v => v === "skipped").length;
  const failedCount  = Object.values(results).filter(v => v === "failed").length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-t-bg border border-t-line rounded-xl shadow-2xl w-[720px] max-w-[95vw] max-h-[88vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="shrink-0 px-4 py-2.5 border-b border-t-line bg-t-panel flex items-center gap-2">
          <Edit3 className="w-3.5 h-3.5 text-accent" />
          <span className="text-[13px] font-semibold text-t-ink">
            {messages.length === 1 ? t("browser.edit.title") : t("browser.edit.titleBulk")}
          </span>
          {!finished && (
            <span className="text-[11.5px] text-t-ink5 font-mono">
              {step + 1} / {messages.length}
            </span>
          )}
          <button onClick={onClose} className="ml-auto p-1 rounded-md hover:bg-t-hover text-t-ink4 hover:text-t-ink">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        {finished ? (
          // ── Summary screen ───────────────────────────────────────────────
          <div className="flex-1 overflow-auto px-4 py-4 space-y-2 text-[13px] text-t-ink2">
            <p className="text-t-ink font-semibold">{t("browser.edit.done")}</p>
            <ul className="text-[12.5px] space-y-0.5">
              <li>✓ {t("browser.edit.sent")} <span className="font-mono text-positive">{sentCount}</span></li>
              <li>○ {t("browser.edit.skipped")} <span className="font-mono text-t-ink4">{skippedCount}</span></li>
              {failedCount > 0 && (
                <li>✗ {t("browser.edit.failed")} <span className="font-mono text-negative">{failedCount}</span></li>
              )}
            </ul>
            <p className="text-[11.5px] text-t-ink5 leading-relaxed">{t("browser.edit.note")}</p>
          </div>
        ) : msg && draft ? (
          <div className="flex-1 overflow-auto px-4 py-3 space-y-3 min-h-0">
            {/* Metadata strip */}
            <div className="flex items-center gap-2 text-[11.5px] text-t-ink4 flex-wrap">
              <span className="px-1.5 py-0.5 rounded-md bg-t-hover text-t-ink3 font-mono">
                {msg.message_id ?? t("browser.edit.noId")}
              </span>
              {msg.content_type && (
                <span className="font-mono">content-type: <span className="text-t-ink3">{msg.content_type}</span></span>
              )}
              {msg.delivery_count > 0 && (
                <span className="font-mono" title={t("browser.delivery")}>↻ {msg.delivery_count}</span>
              )}
              <span className="font-mono">{fmtBytes(msg.body_size)}</span>
            </div>

            {/* Target address */}
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-content-subtle mb-1">
                {t("browser.edit.target")}
              </label>
              <div className="flex items-center gap-1">
                <input
                  value={draft.target}
                  onChange={e => updateDraft({ target: e.target.value })}
                  placeholder={t("browser.edit.target.placeholder")}
                  spellCheck={false}
                  className="flex-1 h-9 rounded-lg border border-line-strong bg-surface px-3 text-[12.5px] text-content outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/25 placeholder:text-content-subtle font-mono"
                />
                {(() => {
                  const origin = originalDestination(msg.application_properties);
                  if (!origin || origin === draft.target) return null;
                  return (
                    <button
                      type="button"
                      onClick={() => updateDraft({ target: origin })}
                      title={t("browser.edit.reset.hint", { origin })}
                      className="shrink-0 px-2 py-1 rounded-md text-[10.5px] font-medium text-t-ink4 hover:text-accent hover:bg-accent/10 transition-colors"
                    >
                      {t("browser.edit.reset")}
                    </button>
                  );
                })()}
              </div>
              <p className="text-[10.5px] text-t-ink5 mt-1">{t("browser.edit.target.note")}</p>
            </div>

            {/* Body editor */}
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-content-subtle mb-1">
                {t("browser.body")}
              </label>
              <CodeEditor
                value={draft.body}
                onChange={(v) => updateDraft({ body: v })}
                language={detectedLang(draft.body)}
                minHeight="220px"
                className="bg-t-field border border-t-line2 rounded-lg overflow-hidden"
              />
              <p className="text-[10.5px] text-t-ink5 mt-1">
                {t("browser.edit.propsNote")}
              </p>
            </div>

            {/* Per-step result indicator (if user came back to a completed step) */}
            {results[step] && (
              <div className="text-[11.5px] flex items-center gap-1">
                {results[step] === "sent" && <span className="text-positive">{t("browser.edit.already")}</span>}
                {results[step] === "skipped" && <span className="text-t-ink4">○ Previously skipped</span>}
                {results[step] === "failed" && <span className="text-negative">{t("browser.edit.prevFailed")}</span>}
              </div>
            )}
          </div>
        ) : null}

        {/* Footer */}
        <div className="shrink-0 px-3 py-2 border-t border-t-line bg-t-panel flex items-center gap-2">
          {!finished && messages.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => setStep(s => Math.max(0, s - 1))}
                disabled={step === 0 || sending}
                title={t("browser.edit.prev")}
                className="p-1 rounded-md text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setStep(s => Math.min(messages.length, s + 1))}
                disabled={step >= messages.length - 1 || sending}
                title={t("browser.edit.next")}
                className="p-1 rounded-md text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <span className="text-[11.5px] text-t-ink5 font-mono">
                ✓ {sentCount} · ○ {skippedCount}{failedCount > 0 ? ` · ✗ ${failedCount}` : ""}
              </span>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={sending}
              className="px-3 py-1 rounded-lg text-[11.5px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
            >
              {finished ? t("browser.close.short") : t("browser.cancel")}
            </button>
            {!finished && (
              <>
                <button
                  type="button"
                  onClick={doSkip}
                  disabled={sending}
                  title={t("browser.edit.skip")}
                  className="flex items-center gap-1 h-7 px-2.5 rounded-lg text-[12px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
                >
                  <SkipForward className="w-3 h-3" /> Skip
                </button>
                <button
                  type="button"
                  onClick={doResubmit}
                  disabled={sending || !draft || !draft.target.trim()}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-accent hover:bg-accent-strong text-white text-[11.5px] font-semibold transition-colors disabled:opacity-40"
                >
                  {sending
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <CornerUpLeft className="w-3 h-3" />}
                  {sending
                    ? t("browser.edit.sending")
                    : step === messages.length - 1 ? t("browser.edit.finish") : t("browser.edit.nextSend")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cross-broker shovel modal.
 *
 * Walks every peeked source message (snapshot taken when the modal opens),
 * sends each one through a transient target connection that lives in the
 * Rust side under `AppState::shovel_target`. Optional JS transform runs in
 * the WebView between peek and send — same `new AsyncFunction(...)` pattern
 * as Pre-script in Send view.
 *
 * Source is the currently-active broker (we already have those messages
 * peeked); target is any other saved profile. We don't ack the source —
 * this is copy-mode, the originals stay put. Move-mode would need a real
 * consumer-side ack flow which is bigger surgery; deferred.
 */
function ShovelModal({ messages, sourceQueue, profiles, activeProfile, onLog, onClose }: {
  messages: PeekedMessage[];
  sourceQueue: string;
  profiles: Profile[];
  activeProfile: string;
  onLog: (k: "info" | "ok" | "err", t: string) => void;
  onClose: () => void;
}) {
  const t = useAmqpText();
  // Target profile picker — default to the first saved profile that isn't
  // the active one (most common case: "I'm on prod, shovel to dev").
  const defaultTarget = useMemo(() => {
    const other = profiles.find(p => p.name !== activeProfile);
    return other?.name ?? profiles[0]?.name ?? "";
  }, [profiles, activeProfile]);
  const [targetProfile, setTargetProfile] = useState(defaultTarget);
  const [targetQueue, setTargetQueue] = useState(sourceQueue);
  const [transformOn, setTransformOn] = useState(false);
  const [transformSrc, setTransformSrc] = useState(
`// Mutate ctx (or return false to skip this message).
// ctx.body     — string, current body (may be JSON / XML / plain text)
// ctx.properties — object, current application properties (string→string)
// Examples:
//   ctx.properties.shovelled_from = "prod";
//   ctx.body = JSON.stringify({ ...JSON.parse(ctx.body), _origin: "prod" });
//   if (ctx.properties.type === "skip") return false;
`);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ step: number; total: number; ok: number; failed: number; skipped: number } | null>(null);
  // Latch flag so the user can cancel mid-run.
  const cancelRef = useRef(false);
  // Lazy-built transform function, recompiled on demand.
  function buildTransform(): null | ((ctx: { body: string; properties: Record<string, string> }) => Promise<boolean | void>) {
    if (!transformOn || !transformSrc.trim()) return null;
    try {
      const AsyncFunc: new (...args: string[]) => (...args: unknown[]) => Promise<unknown> =
        Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFunc("ctx", `"use strict";\n${transformSrc}`);
      return async (ctx) => {
        const r = await fn(ctx);
        // Match Pre-script semantics: explicit false = skip; anything else = ship.
        return r === false ? false : undefined;
      };
    } catch (e) {
      onLog("err", `Transform compile error: ${e}`);
      return null;
    }
  }

  async function run() {
    if (!targetProfile) { onLog("err", t("browser.shovel.pickProfile")); return; }
    if (!targetQueue.trim()) { onLog("err", t("browser.shovel.pickQueue")); return; }
    const profile = profiles.find(p => p.name === targetProfile);
    if (!profile) { onLog("err", `Profile '${targetProfile}' not found`); return; }
    const transform = buildTransform();
    if (transformOn && !transform) return; // compile error already logged
    cancelRef.current = false;
    setRunning(true);
    setProgress({ step: 0, total: messages.length, ok: 0, failed: 0, skipped: 0 });

    try {
      await invoke("shovel_open_target", { profile });
    } catch (e) {
      onLog("err", `Open target: ${e}`);
      setRunning(false);
      setProgress(null);
      return;
    }

    let ok = 0;
    let failed = 0;
    let skipped = 0;
    for (let i = 0; i < messages.length; i++) {
      if (cancelRef.current) break;
      const m = messages[i];
      const ctx = {
        body: m.body_text ?? "",
        properties: { ...m.application_properties },
      };
      if (transform) {
        try {
          const shouldShip = await transform(ctx);
          if (shouldShip === false) {
            skipped++;
            setProgress({ step: i + 1, total: messages.length, ok, failed, skipped });
            continue;
          }
        } catch (e) {
          failed++;
          onLog("err", `Transform error #${i + 1}: ${e}`);
          setProgress({ step: i + 1, total: messages.length, ok, failed, skipped });
          continue;
        }
      }
      try {
        await invoke("shovel_send_to_target", {
          target: targetQueue.trim(),
          body: ctx.body,
          customProps: ctx.properties,
        });
        ok++;
      } catch (e) {
        failed++;
        onLog("err", `Shovel #${i + 1} failed: ${e}`);
      }
      setProgress({ step: i + 1, total: messages.length, ok, failed, skipped });
    }

    try { await invoke("shovel_close_target"); } catch { /* no-op */ }
    setRunning(false);
    const cancelled = cancelRef.current;
    onLog(failed === 0 && !cancelled ? "ok" : "info",
      `Shovel${cancelled ? " (cancelled)" : ""}: ${ok} sent · ${skipped} skipped${failed > 0 ? ` · ${failed} failed` : ""} → ${targetProfile}/${targetQueue}`);
  }

  function close() {
    if (running) {
      cancelRef.current = true;
      // Leave the modal open — the run loop will set running=false on next tick.
      return;
    }
    // Best-effort close on the Rust side in case Run was never pressed.
    invoke("shovel_close_target").catch(() => {});
    onClose();
  }

  const otherProfiles = profiles.filter(p => p.name !== activeProfile);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={close}>
      <div onClick={e => e.stopPropagation()}
        className="bg-t-bg border border-t-line rounded-xl shadow-2xl w-[640px] max-w-[95vw] max-h-[88vh] flex flex-col overflow-hidden">

        <div className="shrink-0 px-4 py-2.5 border-b border-t-line bg-t-panel flex items-center gap-2">
          <ArrowRightLeft className="w-3.5 h-3.5 text-accent" />
          <span className="text-[13px] font-semibold text-t-ink">{t("browser.shovel.title")}</span>
          <span className="text-[11.5px] text-t-ink5 font-mono">{messages.length} peeked</span>
          <button onClick={close} className="ml-auto p-1 rounded-md hover:bg-t-hover text-t-ink4 hover:text-t-ink">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-4 py-3 space-y-3">
          {/* Source — fixed, just informational */}
          <div className="rounded-md border border-t-line bg-t-card/40 p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-content-subtle mb-1">{t("browser.shovel.source")}</div>
            <div className="text-[12.5px] text-t-ink font-mono">
              <span className="text-t-ink3">{activeProfile || "(no profile)"}</span>
              <span className="mx-1 text-t-ink5">/</span>
              <span>{sourceQueue}</span>
            </div>
            <div className="text-[10.5px] text-t-ink5 mt-0.5">
              {messages.length} message{messages.length === 1 ? "" : "s"} from the current peek snapshot
            </div>
          </div>

          {/* Target — profile + queue */}
          <div className="rounded-md border border-t-line bg-t-card/40 p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-content-subtle mb-1">{t("browser.shovel.target")}</div>
            {otherProfiles.length === 0 ? (
              <div className="text-[11.5px] text-caution">
                {t("browser.shovel.onlyOne")}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10.5px] text-t-ink5 mb-1">{t("browser.shovel.profile")}</label>
                  {/* `appearance-none` + explicit `h-8` + `box-border` defeat
                      WebKit's default <select> sizing so it matches the
                      adjacent <input> pixel-for-pixel. The chevron is
                      hand-positioned because dropping `appearance-none`
                      reintroduces the height mismatch. */}
                  <div className="relative">
                    <select
                      value={targetProfile}
                      onChange={e => setTargetProfile(e.target.value)}
                      disabled={running}
                      className="w-full bg-t-field border border-t-line2 rounded-lg px-2 pr-7 py-1 text-[12.5px] font-mono text-t-ink outline-none focus:border-accent disabled:opacity-50 h-8 box-border appearance-none"
                    >
                      {otherProfiles.map(p => (
                        <option key={p.name} value={p.name}>{p.name}  ({p.host}:{p.port})</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-t-ink4 pointer-events-none" />
                  </div>
                </div>
                <div>
                  <label className="block text-[10.5px] text-t-ink5 mb-1">{t("browser.shovel.queue")}</label>
                  <input
                    value={targetQueue}
                    onChange={e => setTargetQueue(e.target.value)}
                    disabled={running}
                    placeholder={t("browser.shovel.queue.placeholder")}
                    spellCheck={false}
                    className="w-full bg-t-field border border-t-line2 rounded-lg px-2 py-1 text-[12.5px] font-mono text-t-ink outline-none focus:border-accent disabled:opacity-50 h-8 box-border appearance-none"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Optional transform */}
          <div className="rounded-md border border-t-line bg-t-card/40 p-2.5">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={transformOn}
                onChange={e => setTransformOn(e.target.checked)}
                disabled={running}
                className="amqp-checkbox"
              />
              <span className="text-[12.5px] text-t-ink2 font-medium">{t("browser.shovel.transform")}</span>
              <span className="text-[10.5px] text-t-ink5">— optional, async</span>
            </label>
            {transformOn && (
              <textarea
                value={transformSrc}
                onChange={e => setTransformSrc(e.target.value)}
                disabled={running}
                spellCheck={false}
                rows={6}
                className="mt-2 w-full bg-t-field border border-t-line2 rounded-md px-2 py-1.5 text-[11.5px] font-mono text-t-ink outline-none focus:border-accent disabled:opacity-50"
              />
            )}
            <p className="text-[10.5px] text-t-ink5 leading-relaxed mt-1.5">
              Runs in the WebView; one call per source message before send. Mutate{" "}
              <span className="font-mono">ctx.body</span> and{" "}
              <span className="font-mono">ctx.properties</span> in place, or{" "}
              <span className="font-mono">return false</span> to skip a message.
            </p>
          </div>

          {/* Progress */}
          {progress && (
            <div>
              <div className="flex items-center gap-2 text-[11.5px] font-mono text-t-ink4 mb-1">
                <span>{progress.step} / {progress.total}</span>
                <span className="text-positive">✓ {progress.ok}</span>
                {progress.skipped > 0 && <span className="text-t-ink4">○ {progress.skipped}</span>}
                {progress.failed > 0 && <span className="text-negative">✗ {progress.failed}</span>}
              </div>
              <div className="h-1 bg-t-card rounded-md overflow-hidden">
                <div className="h-full bg-accent transition-all"
                  style={{ width: progress.total > 0 ? `${(progress.step / progress.total) * 100}%` : "0%" }} />
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 px-3 py-2 border-t border-t-line bg-t-panel flex items-center gap-2">
          <span className="text-[10.5px] text-t-ink5">{t("browser.shovel.note")}</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={close}
              className="px-3 py-1 rounded-lg text-[11.5px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors"
            >
              {running ? t("browser.cancel") : t("browser.close.short")}
            </button>
            <button
              onClick={run}
              disabled={running || otherProfiles.length === 0 || messages.length === 0 || !targetProfile || !targetQueue.trim()}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-accent hover:bg-accent-strong text-white text-[11.5px] font-semibold transition-colors disabled:opacity-40"
            >
              {running
                ? <><Spinner className="w-3 h-3 animate-spin" /> {t("browser.shovel.running")}</>
                : <><ArrowRightLeft className="w-3 h-3" /> {t("browser.shovel.run")}</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
