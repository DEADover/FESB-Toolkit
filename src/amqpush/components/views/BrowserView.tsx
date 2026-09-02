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
    if (!connected) { setErr("Not connected to broker"); return; }
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
      onLog("err", "No messages have an original-destination property to requeue to.");
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
        title="Broker Browser"
        count={loaded ? (
          filtered.length === queues.length
            ? `${queues.length} queue${queues.length !== 1 ? "s" : ""}`
            : `${filtered.length} / ${queues.length}`
        ) : null}
        status={connected && autoOn && pollErr ? (
          <span className="flex items-center gap-1 text-[10px] text-amber-500 font-mono" title={`Polling error: ${pollErr}`}>
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            poll error
          </span>
        ) : connected && autoOn && loaded ? (
          <span className="flex items-center gap-1 text-[10px] text-t-ink5 font-mono" title={`Auto-refresh every ${QUEUE_POLL_INTERVAL_MS / 1000}s`}>
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
            live
          </span>
        ) : null}
      >
        <button
          onClick={() => setAutoOn(a => !a)}
          aria-pressed={autoOn}
          className={`text-[11px] transition-colors px-1.5 py-0.5 rounded ${
            autoOn ? "text-blue-500 bg-blue-500/10" : "text-t-ink4 hover:text-t-ink3"
          }`}
          title={autoOn ? "Auto-refresh on — click to pause" : "Auto-refresh paused"}
        >
          {autoOn ? "● Auto" : "○ Auto"}
        </button>
        <button
          onClick={() => setHideEmpty(h => !h)}
          aria-pressed={hideEmpty}
          className={`text-[11px] transition-colors px-1.5 py-0.5 rounded ${
            hideEmpty ? "text-blue-500 bg-blue-500/10" : "text-t-ink4 hover:text-t-ink3"
          }`}
          title="Hide queues with zero messages"
        >
          Hide empty
        </button>
        <button onClick={() => refreshQueues(false)} disabled={!connected || loading}
          className="px-2 py-1 rounded text-[11px] font-medium text-t-ink4 hover:text-blue-500 hover:bg-blue-500/10 transition-colors flex items-center gap-1 disabled:opacity-40">
          <RotateCcw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </ViewTopBar>

      {/* ─── FILTER BAR — only when there are queues to filter ─── */}
      {loaded && queues.length > 0 && (
        <div className="shrink-0 px-3 py-1 border-b border-t-line bg-t-panel flex items-center gap-2">
          <Search className="w-3.5 h-3.5 text-t-ink5 shrink-0" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Filter queues by name or address…"
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
            <EmptyState icon={<Radar className="w-8 h-8" />} title="Not connected" subtitle="Connect to a broker to discover queues" />
          ) : loading && queues.length === 0 ? (
            <EmptyState icon={<Loader2 className="w-8 h-8 animate-spin" />} title="Querying broker…" />
          ) : err ? (
            <EmptyState
              variant="error"
              title="Discovery failed"
              subtitle={<>
                {err}
                <p className="text-[10px] mt-3 text-t-ink5">Requires Artemis or ActiveMQ Classic with AMQP management enabled</p>
              </>}
              action={
                <button onClick={() => refreshQueues(false)}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-t-card border border-t-line text-t-ink2 hover:bg-t-hover transition-colors">
                  Retry
                </button>
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState icon={<Radar className="w-8 h-8" />} title={search || hideEmpty ? "No queues match" : "No queues on broker"} />
          ) : (
            <div className="flex-1 overflow-auto min-h-0">
              <table className="w-full text-[12px] font-mono table-fixed">
                <thead className="sticky top-0 z-10 bg-t-panel border-b border-t-line">
                  <tr className="text-[10px] uppercase tracking-wider text-t-ink4 select-none">
                    <SortableHeader label="Name"  sortKey="name"      current={sortKey} dir={sortDir} onClick={toggleSort} className="text-left  pl-3" />
                    <SortableHeader label="Type"  sortKey="type"      current={sortKey} dir={sortDir} onClick={toggleSort} className="text-left  w-24" />
                    <SortableHeader label="Msgs"  sortKey="messages"  current={sortKey} dir={sortDir} onClick={toggleSort} className="text-right w-14" />
                    <SortableHeader label="Cons"  sortKey="consumers" current={sortKey} dir={sortDir} onClick={toggleSort} className="text-right w-12" />
                    {!selectedQueue && <th className="text-left w-44 font-semibold py-1.5 px-2">Address</th>}
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
                          isSel ? "bg-blue-500/10" : "hover:bg-t-hover/50"
                        }`}>
                        <td className="py-1.5 px-3 truncate">
                          <span className="text-t-ink">{bq.name}</span>
                        </td>
                        <td className="py-1.5 px-2">
                          <span className={`text-[10px] px-1 rounded font-medium ${
                            bq.routing_type === "ANYCAST" ? "bg-blue-500/15 text-blue-500" : "bg-violet-500/15 text-violet-500"
                          }`}>{bq.routing_type === "ANYCAST" ? "ANY" : "MULTI"}</span>
                        </td>
                        <td className={`py-1.5 px-2 text-right ${bq.message_count > 0 ? "text-t-ink font-medium" : "text-t-ink5"}`}>
                          {bq.message_count}
                        </td>
                        <td className={`py-1.5 px-2 text-right ${bq.consumer_count > 0 ? "text-green-500" : "text-t-ink5"}`}>
                          {bq.consumer_count}
                        </td>
                        {!selectedQueue && (
                          <td className="py-1.5 px-2 truncate text-t-ink4 text-[11px]">{bq.address}</td>
                        )}
                        <td className="py-1.5 pr-2">
                          <div className="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <IconBtn title="Publish to" onClick={(e) => { e.stopPropagation(); onPublishTo(bq.address); }} colorClass="hover:text-blue-500 hover:bg-blue-500/10">
                              <Send className="w-3 h-3" />
                            </IconBtn>
                            <IconBtn title="Subscribe" onClick={(e) => { e.stopPropagation(); onSubscribeTo(bq.address); }} colorClass="hover:text-green-500 hover:bg-green-500/10">
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
              <span className="text-[12px] text-t-ink font-mono truncate" title={selectedQueue}>{selectedQueue}</span>
              {!peekLoading && !peekErr && (
                <span className="text-[11px] text-t-ink5 font-mono">{messages.length} peeked</span>
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
                  className="bg-t-field border border-t-line2 rounded px-1.5 py-0.5 text-[11px] text-t-ink2 outline-none"
                  title="Max messages to peek (All resolves to the queue's broker-reported message_count)">
                  {PEEK_PRESETS.map(n => (
                    <option key={n} value={n}>{n === 0 ? "All" : n}</option>
                  ))}
                </select>
                <button onClick={() => peekQueue(selectedQueue)}
                  title="Refresh"
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-t-ink4 hover:text-blue-500 hover:bg-blue-500/10 transition-colors">
                  <RotateCcw className={`w-3 h-3 ${peekLoading ? "animate-spin" : ""}`} /> Refresh
                </button>
                <button
                  onClick={() => setShovelMsgs(messages)}
                  disabled={messages.length === 0 || peekLoading || profiles.length < 2}
                  title={profiles.length < 2
                    ? "Need at least two saved profiles to shovel between brokers"
                    : messages.length === 0
                      ? "Queue is empty — nothing to shovel"
                      : "Copy peeked messages to a queue on another broker"}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-t-ink4 hover:text-blue-500 hover:bg-blue-500/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <ArrowRightLeft className="w-3 h-3" /> Shovel…
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
                        ? "Queue is empty — nothing to requeue"
                        : `Republish all ${messages.length} peeked message${messages.length !== 1 ? "s" : ""} to their original destinations`
                    }
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-blue-500 bg-blue-500/10 hover:bg-blue-500/20 transition-colors disabled:opacity-40 disabled:hover:bg-blue-500/10"
                  >
                    {requeueProgress
                      ? <><Loader2 className="w-3 h-3 animate-spin" /> Requeue {requeueProgress.done}/{requeueProgress.total}</>
                      : <><CornerUpLeft className="w-3 h-3" /> Requeue all</>}
                  </button>
                )}
                <button
                  onClick={() => setPurgeConfirm(selectedQueue)}
                  disabled={messages.length === 0 || peekLoading}
                  title={messages.length === 0
                    ? "Queue is empty — nothing to purge"
                    : "Permanently delete all messages from this queue"}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-t-ink4 hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:hover:text-t-ink4 disabled:hover:bg-transparent"
                >
                  <Trash2 className="w-3 h-3" /> Purge
                </button>
                <button onClick={closePeek}
                  title="Close peek"
                  className="p-1 rounded text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors">
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* DLQ banner — shown for queues whose names match common dead-letter
                patterns. Surfaces the requeue feature without forcing the user
                to dig through Help. */}
            {isDlqQueueName(selectedQueue) && (
              <div className="shrink-0 px-3 py-2 border-b border-t-line bg-amber-500/5 flex items-start gap-2 text-[11px]">
                <ShieldAlert className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                <div className="text-t-ink2 leading-relaxed">
                  <span className="text-amber-500 font-medium">Dead-letter queue.</span>{" "}
                  Messages here usually carry an original-destination property
                  (<span className="font-mono text-[10px]">_AMQ_ORIG_ADDRESS</span>{" "}
                  on Artemis, <span className="font-mono text-[10px]">originalDestination</span>{" "}
                  on Classic). <b>Requeue all</b> republishes each message to
                  its origin so consumers get another delivery attempt.
                </div>
              </div>
            )}

            {peekLoading ? (
              <EmptyState icon={<Loader2 className="w-8 h-8 animate-spin" />} title="Peeking messages…" subtitle="Reading from queue without consuming" />
            ) : peekErr ? (
              <EmptyState variant="error" title="Peek failed" subtitle={peekErr} />
            ) : messages.length === 0 ? (
              <EmptyState icon={<Inbox className="w-8 h-8" />} title="Queue is empty" />
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
                    <div className="shrink-0 px-3 py-1.5 border-b border-t-line bg-blue-500/5 flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] text-blue-500 font-medium">
                        {selectedIdxs.size} selected
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedIdxs(new Set())}
                        className="text-[11px] text-t-ink4 hover:text-t-ink2 transition-colors"
                      >
                        Clear
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedIdxs(new Set(messages.map((_, i) => i)))}
                        disabled={selectedIdxs.size === messages.length}
                        className="text-[11px] text-t-ink4 hover:text-t-ink2 transition-colors disabled:opacity-40"
                      >
                        Select all
                      </button>

                      <div className="ml-auto flex items-center gap-1">
                        {/* DLQ-only: Edit & Requeue (modal) + Requeue selected (no edit). */}
                        {isDlq && (
                          <>
                            <button
                              type="button"
                              onClick={() => setEditRequeueMsgs(picked)}
                              disabled={!!requeueProgress}
                              title="Walk through selected messages, edit body / target per-message, resubmit"
                              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-blue-500 bg-blue-500/10 hover:bg-blue-500/20 transition-colors disabled:opacity-40"
                            >
                              <Edit3 className="w-3 h-3" /> Edit & Requeue…
                            </button>
                            <button
                              type="button"
                              onClick={() => requeueMessages(picked)}
                              disabled={!!requeueProgress}
                              title="Republish selected messages to their original destinations without editing"
                              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-t-ink2 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
                            >
                              <CornerUpLeft className="w-3 h-3" /> Requeue selected
                            </button>
                          </>
                        )}
                        {/* Universal: Shovel selected. Need ≥2 profiles. */}
                        <button
                          type="button"
                          onClick={() => setShovelMsgs(picked)}
                          disabled={profiles.length < 2}
                          title={profiles.length < 2
                            ? "Need at least two saved profiles to shovel between brokers"
                            : "Copy selected messages to a queue on another broker"}
                          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-t-ink2 hover:text-blue-500 hover:bg-blue-500/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                          <ArrowRightLeft className="w-3 h-3" /> Shovel selected…
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
                            ? `Permanently delete the ${picked.length} selected message${picked.length === 1 ? "" : "s"} from the broker`
                            : `${picked.length - withId} of the selected messages have no message-id — selective delete needs message-ids (Artemis removeMessages selector uses them)`}
                          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-t-ink4 hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-t-ink4"
                        >
                          <Trash2 className="w-3 h-3" /> Purge selected
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
                  <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1 bg-t-panel/95 backdrop-blur-sm border-b border-t-line text-[10px] uppercase tracking-wider text-t-ink4 select-none">
                    <span className="w-3.5 shrink-0" /> {/* checkbox column */}
                    <span className="w-3 shrink-0" />   {/* message-icon column */}
                    <span className="w-6 shrink-0 font-semibold">#</span>
                    <span className="font-semibold flex-1">Message ID</span>
                    <span className="font-semibold shrink-0">Date-Time</span>
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
                          isOpen ? "bg-blue-500/10" : "hover:bg-t-hover/50"
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
                          className="shrink-0 pl-3 pr-1 pt-[10px] flex items-start text-t-ink5 hover:text-blue-500 transition-colors"
                          aria-label={isSel ? `Unselect #${origIdx + 1}` : `Select #${origIdx + 1}`}
                        >
                          {isSel
                            ? <CheckSquare className="w-3.5 h-3.5 text-blue-500" />
                            : <Square className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => { if (skipIfSelecting()) return; setOpenMessageIdx(isOpen ? null : origIdx); }}
                          className="flex-1 min-w-0 text-left flex flex-col gap-0.5 pl-1 pr-3 py-2"
                        >
                          <div className="flex items-center gap-2 text-[11px]">
                            <MessageSquare className="w-3 h-3 text-t-ink5 shrink-0" />
                            <span className="text-t-ink5 font-mono shrink-0 w-6">#{origIdx + 1}</span>
                            <span className="text-t-ink2 font-mono truncate flex-1" title={msg.message_id ?? ""}>{idShort}</span>
                            <span className="text-t-ink5 font-mono shrink-0">{timeText}</span>
                          </div>
                          <div className="flex items-center gap-2 text-[10px] pl-5">
                            <span className="px-1 rounded bg-t-hover text-t-ink3 font-mono">{ct}</span>
                            <span className="text-t-ink5 font-mono">{fmtBytes(msg.body_size)}</span>
                            {msg.priority !== null && msg.priority !== 4 && (
                              <span className="text-t-ink4 font-mono">P{msg.priority}</span>
                            )}
                            {msg.delivery_count > 0 && (
                              <span className="text-t-ink4 font-mono" title="Delivery count">↻ {msg.delivery_count}</span>
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onCancel}>
      <div onClick={e => e.stopPropagation()}
        className="bg-t-bg border border-t-line rounded-lg shadow-2xl w-[460px] max-w-[90vw] flex flex-col overflow-hidden">

        <div className="shrink-0 px-4 py-2.5 border-b border-t-line bg-t-panel flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
          <span className="text-[13px] font-semibold text-t-ink">Purge queue</span>
          <button onClick={onCancel} className="ml-auto p-1 rounded hover:bg-t-hover text-t-ink4 hover:text-t-ink">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-2 text-[13px] text-t-ink2">
          <p>
            Permanently delete <span className="font-mono font-bold text-t-ink">{messageCount.toLocaleString()}</span>{" "}
            message{messageCount !== 1 ? "s" : ""} from queue{" "}
            <span className="font-mono text-blue-500">{queue}</span>?
          </p>
          <p className="text-[11px] text-t-ink5">
            This calls Artemis's <code className="text-t-ink4">removeAllMessages</code> management
            operation. The action cannot be undone — drained messages do <em>not</em> go to the DLQ.
          </p>
        </div>

        <div className="shrink-0 px-3 py-2 border-t border-t-line bg-t-panel flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={purging}
            className="px-3 py-1 rounded-md text-[11px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={purging}
            className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-red-500 hover:bg-red-600 text-white text-[11px] font-semibold transition-colors disabled:opacity-40"
          >
            {purging ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            {purging ? "Purging…" : `Delete ${messageCount.toLocaleString()} message${messageCount !== 1 ? "s" : ""}`}
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onCancel}>
      <div onClick={e => e.stopPropagation()}
        className="bg-t-bg border border-t-line rounded-lg shadow-2xl w-[460px] max-w-[90vw] flex flex-col overflow-hidden">
        <div className="shrink-0 px-4 py-2.5 border-b border-t-line bg-t-panel flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
          <span className="text-[13px] font-semibold text-t-ink">Delete selected messages</span>
          <button onClick={onCancel} className="ml-auto p-1 rounded hover:bg-t-hover text-t-ink4 hover:text-t-ink">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-2 text-[13px] text-t-ink2">
          <p>
            Permanently delete <span className="font-mono font-bold text-t-ink">{ids.length.toLocaleString()}</span>{" "}
            message{ids.length === 1 ? "" : "s"} from queue{" "}
            <span className="font-mono text-blue-500">{queue}</span>?
          </p>
          {ids.length !== total && (
            <p className="text-[11px] text-amber-500">
              {total - ids.length} of {total} selected message{total === 1 ? " has" : "s have"} no message-id
              and will be left in place — selective delete needs message-ids.
            </p>
          )}
          <p className="text-[11px] text-t-ink5">
            Calls Artemis's <code className="text-t-ink4">queue.removeMessages</code> with a JMS selector
            matching the message-ids of the selected rows. Cannot be undone — deleted messages do{" "}
            <em>not</em> go to the DLQ.
          </p>
        </div>
        <div className="shrink-0 px-3 py-2 border-t border-t-line bg-t-panel flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={purging}
            className="px-3 py-1 rounded-md text-[11px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={purging || ids.length === 0}
            className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-red-500 hover:bg-red-600 text-white text-[11px] font-semibold transition-colors disabled:opacity-40"
          >
            {purging ? <Spinner className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            {purging ? "Deleting…" : `Delete ${ids.length.toLocaleString()} message${ids.length === 1 ? "" : "s"}`}
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
      className={`p-1 rounded text-t-ink4 transition-colors ${colorClass}`}>
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
      <div className="flex items-center gap-2 text-[11px] flex-wrap">
        <span className="text-t-ink5 font-mono">#{idx + 1}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-t-hover text-t-ink3 font-medium uppercase">{msg.body_kind}</span>
        <span className="text-t-ink5 font-mono">{fmtBytes(msg.body_size)}</span>
        {msg.delivery_count > 0 && (
          <span className="text-t-ink4" title="Delivery count">↻ {msg.delivery_count}</span>
        )}
        {msg.priority !== null && msg.priority !== 4 && <span className="text-t-ink4">P{msg.priority}</span>}
        {msg.durable && <span className="text-blue-500">durable</span>}
        <button
          type="button"
          onClick={toggleHolders}
          title="Show consumers currently attached to this queue (Artemis doesn't expose a per-message lock owner — the practical answer is which clients have credit outstanding)"
          className={`ml-auto flex items-center gap-1 text-[11px] transition-colors px-1.5 py-0.5 rounded ${
            holderOpen
              ? "text-blue-500 bg-blue-500/10"
              : "text-t-ink4 hover:text-blue-500 hover:bg-blue-500/10"
          }`}
        >
          <Users className="w-3 h-3" /> Who holds it?
        </button>
        {onEditRequeue && (
          // Edit & Requeue chip is shown on DLQ for every peeked message —
          // independent of whether the origin can be auto-detected, since
          // the modal lets the user pick a target explicitly.
          <button
            type="button"
            onClick={onEditRequeue}
            disabled={requeueDisabled}
            title="Open the message in an editor — tweak body / target, then resubmit"
            className="flex items-center gap-1 text-[11px] font-medium text-t-ink3 hover:text-blue-500 disabled:opacity-40 transition-colors"
          >
            <Edit3 className="w-3 h-3" /> Edit & Requeue…
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
              title={`Republish this message to ${origin} without editing`}
              className="flex items-center gap-1 text-[11px] font-medium text-blue-500 hover:text-blue-400 disabled:opacity-40 transition-colors"
            >
              <CornerUpLeft className="w-3 h-3" /> Requeue → <span className="font-mono">{origin}</span>
            </button>
          );
        })()}
      </div>

      {/* "Who holds this message?" panel — lazy-loaded consumer drill-down */}
      {holderOpen && (
        <div className="rounded border border-t-line bg-t-card/40 p-2">
          <div className="flex items-center gap-2 mb-2 text-[11px]">
            <Users className="w-3 h-3 text-t-ink4" />
            <span className="text-t-ink2 font-medium">Consumers on this queue</span>
            <span className="text-t-ink5 font-mono">{holderCons.length}</span>
            <button
              type="button"
              onClick={loadHolders}
              disabled={holderLoading}
              title="Refresh"
              className="ml-auto flex items-center gap-1 text-[10px] text-t-ink4 hover:text-t-ink2 transition-colors px-1 py-0.5 rounded hover:bg-t-hover disabled:opacity-40"
            >
              <RotateCcw className={`w-3 h-3 ${holderLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
          {holderLoading && holderCons.length === 0 ? (
            <div className="text-[11px] text-t-ink5 italic">Loading consumers…</div>
          ) : holderErr ? (
            <div className="text-[11px] text-red-500">Failed: {holderErr}</div>
          ) : holderCons.length === 0 ? (
            <div className="text-[11px] text-t-ink5">
              No consumers are currently attached to this queue.{" "}
              {msg.delivery_count > 0
                ? <>Message has been redelivered <b>{msg.delivery_count}×</b>, so a previous consumer may have given up.</>
                : <>Messages will sit here until a consumer subscribes.</>}
            </div>
          ) : (
            <table className="w-full text-[11px] font-mono">
              <thead className="text-[10px] uppercase tracking-wider text-t-ink5">
                <tr className="border-b border-t-line/60">
                  <th className="text-left pb-1 font-semibold">Client</th>
                  <th className="text-left pb-1 font-semibold w-24">User</th>
                  <th className="text-right pb-1 font-semibold w-12" title="Credit currently outstanding">Credit</th>
                  <th className="text-right pb-1 font-semibold w-20">Last RX</th>
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
                    <tr key={k.id} className={isHolding ? "bg-blue-500/5" : ""}>
                      <td className="py-1 text-t-ink2 truncate" title={conn?.client_address ?? k.connection_id}>
                        {conn?.client_address || k.connection_id || "—"}
                      </td>
                      <td className="py-1 text-t-ink3 truncate" title={conn?.users ?? ""}>{conn?.users || "—"}</td>
                      <td className={`py-1 text-right ${isHolding ? "text-blue-500 font-medium" : "text-t-ink5"}`}>
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
            <div className="mt-2 text-[10px] text-t-ink5 leading-relaxed">
              Rows highlighted in blue have unacked credit. They're the most likely
              candidates for holding this message — but Artemis doesn't expose a per-message
              lock owner via management, so this is an inference, not a guarantee.
            </div>
          )}
        </div>
      )}

      <CollapsibleSection title="Properties" icon={<Tag className="w-3 h-3" />} open={propsOpen} onToggle={() => setPropsOpen(o => !o)}>
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
            {msg.body_text && (
              <CopyButton
                value={msg.body_text}
                onCopied={() => onLog("info", "Body copied")}
                label="Copy"
                className="flex items-center gap-1 text-[10px] text-t-ink4 hover:text-t-ink2 transition-colors px-1.5 py-0.5 rounded hover:bg-t-hover"
              />
            )}
          </div>
        }
      >
        <pre className="text-[11px] text-t-ink2 font-mono bg-t-field border border-t-line rounded-md p-2.5 overflow-x-auto whitespace-pre break-all max-h-64 overflow-y-auto select-text">
          {bodyContent ?? <em className="text-t-ink5">no body</em>}
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
      onLog("err", "Target address is required");
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
        className="bg-t-bg border border-t-line rounded-lg shadow-2xl w-[720px] max-w-[95vw] max-h-[88vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="shrink-0 px-4 py-2.5 border-b border-t-line bg-t-panel flex items-center gap-2">
          <Edit3 className="w-3.5 h-3.5 text-blue-500" />
          <span className="text-[13px] font-semibold text-t-ink">
            {messages.length === 1 ? "Edit & Requeue" : "Edit & Requeue — bulk"}
          </span>
          {!finished && (
            <span className="text-[11px] text-t-ink5 font-mono">
              {step + 1} / {messages.length}
            </span>
          )}
          <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-t-hover text-t-ink4 hover:text-t-ink">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        {finished ? (
          // ── Summary screen ───────────────────────────────────────────────
          <div className="flex-1 overflow-auto px-4 py-4 space-y-2 text-[13px] text-t-ink2">
            <p className="text-t-ink font-semibold">All done.</p>
            <ul className="text-[12px] space-y-0.5">
              <li>✓ Resubmitted: <span className="font-mono text-green-500">{sentCount}</span></li>
              <li>○ Skipped: <span className="font-mono text-t-ink4">{skippedCount}</span></li>
              {failedCount > 0 && (
                <li>✗ Failed: <span className="font-mono text-red-500">{failedCount}</span></li>
              )}
            </ul>
            <p className="text-[11px] text-t-ink5 leading-relaxed">
              Source messages stay on the DLQ — this is a peek-and-republish flow.
              Use <b>Purge</b> on the DLQ to drop the originals after you're satisfied
              with the resubmit.
            </p>
          </div>
        ) : msg && draft ? (
          <div className="flex-1 overflow-auto px-4 py-3 space-y-3 min-h-0">
            {/* Metadata strip */}
            <div className="flex items-center gap-2 text-[11px] text-t-ink4 flex-wrap">
              <span className="px-1.5 py-0.5 rounded bg-t-hover text-t-ink3 font-mono">
                {msg.message_id ?? "no message-id"}
              </span>
              {msg.content_type && (
                <span className="font-mono">content-type: <span className="text-t-ink3">{msg.content_type}</span></span>
              )}
              {msg.delivery_count > 0 && (
                <span className="font-mono" title="Delivery count">↻ {msg.delivery_count}</span>
              )}
              <span className="font-mono">{fmtBytes(msg.body_size)}</span>
            </div>

            {/* Target address */}
            <div>
              <label className="block text-[10px] font-semibold text-t-ink4 uppercase tracking-wider mb-1">
                Resubmit to
              </label>
              <div className="flex items-center gap-1">
                <input
                  value={draft.target}
                  onChange={e => updateDraft({ target: e.target.value })}
                  placeholder="queue.or.address"
                  spellCheck={false}
                  className="flex-1 bg-t-field border border-t-line2 rounded-md px-2.5 py-1.5 text-[12px] font-mono text-t-ink outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-all placeholder:text-t-ink5"
                />
                {(() => {
                  const origin = originalDestination(msg.application_properties);
                  if (!origin || origin === draft.target) return null;
                  return (
                    <button
                      type="button"
                      onClick={() => updateDraft({ target: origin })}
                      title={`Reset to original destination: ${origin}`}
                      className="shrink-0 px-2 py-1 rounded text-[10px] font-medium text-t-ink4 hover:text-blue-500 hover:bg-blue-500/10 transition-colors"
                    >
                      Reset to origin
                    </button>
                  );
                })()}
              </div>
              <p className="text-[10px] text-t-ink5 mt-1">
                Default is the message's original destination from <span className="font-mono">_AMQ_ORIG_ADDRESS</span> /
                <span className="font-mono"> originalDestination</span>. Type any address to redirect.
              </p>
            </div>

            {/* Body editor */}
            <div>
              <label className="block text-[10px] font-semibold text-t-ink4 uppercase tracking-wider mb-1">
                Body
              </label>
              <CodeEditor
                value={draft.body}
                onChange={(v) => updateDraft({ body: v })}
                language={detectedLang(draft.body)}
                minHeight="220px"
                className="bg-t-field border border-t-line2 rounded-md overflow-hidden"
              />
              <p className="text-[10px] text-t-ink5 mt-1">
                Application properties are preserved automatically (minus DLQ-internal markers
                like <span className="font-mono">_AMQ_ORIG_*</span>). Only the body is editable here.
              </p>
            </div>

            {/* Per-step result indicator (if user came back to a completed step) */}
            {results[step] && (
              <div className="text-[11px] flex items-center gap-1">
                {results[step] === "sent" && <span className="text-green-500">✓ Already resubmitted this step</span>}
                {results[step] === "skipped" && <span className="text-t-ink4">○ Previously skipped</span>}
                {results[step] === "failed" && <span className="text-red-500">✗ Previous attempt failed — try again</span>}
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
                title="Previous message"
                className="p-1 rounded text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setStep(s => Math.min(messages.length, s + 1))}
                disabled={step >= messages.length - 1 || sending}
                title="Next message (without resubmitting)"
                className="p-1 rounded text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <span className="text-[11px] text-t-ink5 font-mono">
                ✓ {sentCount} · ○ {skippedCount}{failedCount > 0 ? ` · ✗ ${failedCount}` : ""}
              </span>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={sending}
              className="px-3 py-1 rounded-md text-[11px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
            >
              {finished ? "Close" : "Cancel"}
            </button>
            {!finished && (
              <>
                <button
                  type="button"
                  onClick={doSkip}
                  disabled={sending}
                  title="Skip without sending; message stays on DLQ"
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
                >
                  <SkipForward className="w-3 h-3" /> Skip
                </button>
                <button
                  type="button"
                  onClick={doResubmit}
                  disabled={sending || !draft || !draft.target.trim()}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-blue-500 hover:bg-blue-600 text-white text-[11px] font-semibold transition-colors disabled:opacity-40"
                >
                  {sending
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <CornerUpLeft className="w-3 h-3" />}
                  {sending
                    ? "Resubmitting…"
                    : step === messages.length - 1 ? "Resubmit & finish" : "Resubmit & next"}
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
    if (!targetProfile) { onLog("err", "Pick a target profile"); return; }
    if (!targetQueue.trim()) { onLog("err", "Pick a target queue"); return; }
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
        className="bg-t-bg border border-t-line rounded-lg shadow-2xl w-[640px] max-w-[95vw] max-h-[88vh] flex flex-col overflow-hidden">

        <div className="shrink-0 px-4 py-2.5 border-b border-t-line bg-t-panel flex items-center gap-2">
          <ArrowRightLeft className="w-3.5 h-3.5 text-blue-500" />
          <span className="text-[13px] font-semibold text-t-ink">Cross-broker shovel</span>
          <span className="text-[11px] text-t-ink5 font-mono">{messages.length} peeked</span>
          <button onClick={close} className="ml-auto p-1 rounded hover:bg-t-hover text-t-ink4 hover:text-t-ink">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-4 py-3 space-y-3">
          {/* Source — fixed, just informational */}
          <div className="rounded border border-t-line bg-t-card/40 p-2.5">
            <div className="text-[10px] font-semibold text-t-ink4 uppercase tracking-wider mb-1">Source</div>
            <div className="text-[12px] text-t-ink font-mono">
              <span className="text-t-ink3">{activeProfile || "(no profile)"}</span>
              <span className="mx-1 text-t-ink5">/</span>
              <span>{sourceQueue}</span>
            </div>
            <div className="text-[10px] text-t-ink5 mt-0.5">
              {messages.length} message{messages.length === 1 ? "" : "s"} from the current peek snapshot
            </div>
          </div>

          {/* Target — profile + queue */}
          <div className="rounded border border-t-line bg-t-card/40 p-2.5">
            <div className="text-[10px] font-semibold text-t-ink4 uppercase tracking-wider mb-1">Target</div>
            {otherProfiles.length === 0 ? (
              <div className="text-[11px] text-amber-500">
                Only the active profile is saved — add another profile to shovel between brokers.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] text-t-ink5 mb-1">Profile</label>
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
                      className="w-full bg-t-field border border-t-line2 rounded-md px-2 pr-7 py-1 text-[12px] font-mono text-t-ink outline-none focus:border-blue-500 disabled:opacity-50 h-8 box-border appearance-none"
                    >
                      {otherProfiles.map(p => (
                        <option key={p.name} value={p.name}>{p.name}  ({p.host}:{p.port})</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-t-ink4 pointer-events-none" />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-t-ink5 mb-1">Queue / address</label>
                  <input
                    value={targetQueue}
                    onChange={e => setTargetQueue(e.target.value)}
                    disabled={running}
                    placeholder="target queue"
                    spellCheck={false}
                    className="w-full bg-t-field border border-t-line2 rounded-md px-2 py-1 text-[12px] font-mono text-t-ink outline-none focus:border-blue-500 disabled:opacity-50 h-8 box-border appearance-none"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Optional transform */}
          <div className="rounded border border-t-line bg-t-card/40 p-2.5">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={transformOn}
                onChange={e => setTransformOn(e.target.checked)}
                disabled={running}
                className="w-3.5 h-3.5 accent-blue-600 cursor-pointer"
              />
              <span className="text-[12px] text-t-ink2 font-medium">Transform body / properties (JS)</span>
              <span className="text-[10px] text-t-ink5">— optional, async</span>
            </label>
            {transformOn && (
              <textarea
                value={transformSrc}
                onChange={e => setTransformSrc(e.target.value)}
                disabled={running}
                spellCheck={false}
                rows={6}
                className="mt-2 w-full bg-t-field border border-t-line2 rounded px-2 py-1.5 text-[11px] font-mono text-t-ink outline-none focus:border-blue-500 disabled:opacity-50"
              />
            )}
            <p className="text-[10px] text-t-ink5 leading-relaxed mt-1.5">
              Runs in the WebView; one call per source message before send. Mutate{" "}
              <span className="font-mono">ctx.body</span> and{" "}
              <span className="font-mono">ctx.properties</span> in place, or{" "}
              <span className="font-mono">return false</span> to skip a message.
            </p>
          </div>

          {/* Progress */}
          {progress && (
            <div>
              <div className="flex items-center gap-2 text-[11px] font-mono text-t-ink4 mb-1">
                <span>{progress.step} / {progress.total}</span>
                <span className="text-green-500">✓ {progress.ok}</span>
                {progress.skipped > 0 && <span className="text-t-ink4">○ {progress.skipped}</span>}
                {progress.failed > 0 && <span className="text-red-500">✗ {progress.failed}</span>}
              </div>
              <div className="h-1 bg-t-card rounded overflow-hidden">
                <div className="h-full bg-blue-500 transition-all"
                  style={{ width: progress.total > 0 ? `${(progress.step / progress.total) * 100}%` : "0%" }} />
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 px-3 py-2 border-t border-t-line bg-t-panel flex items-center gap-2">
          <span className="text-[10px] text-t-ink5">
            Source messages are <b className="text-t-ink4">not</b> deleted — this is a copy.
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={close}
              className="px-3 py-1 rounded-md text-[11px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors"
            >
              {running ? "Cancel" : "Close"}
            </button>
            <button
              onClick={run}
              disabled={running || otherProfiles.length === 0 || messages.length === 0 || !targetProfile || !targetQueue.trim()}
              className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-blue-500 hover:bg-blue-600 text-white text-[11px] font-semibold transition-colors disabled:opacity-40"
            >
              {running
                ? <><Spinner className="w-3 h-3 animate-spin" /> Shovelling…</>
                : <><ArrowRightLeft className="w-3 h-3" /> Run</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
