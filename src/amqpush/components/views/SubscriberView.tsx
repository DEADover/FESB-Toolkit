import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import {
  Play, Square, Trash2, Inbox, Search, X, Loader2, Pause, CornerUpLeft,
  Tag, MessageSquare, Download, Palette, Plus, Edit3,
  Database, GitCompare, ChevronDown, Filter, Hash, Circle, Save, BookMarked,
} from "lucide-react";
import CopyButton from "../CopyButton";
import { ReceivedMessage, SubEvent } from "../../types";
import QueuePicker from "../QueuePicker";
import CollapsibleSection from "../CollapsibleSection";
import PropsList from "../PropsList";
import EmptyState from "../EmptyState";
import SectionLabel from "../SectionLabel";
import ViewTopBar from "../ViewTopBar";
import ConfirmDialog from "../ConfirmDialog";
import { fmtBytes, fmtDuration, csvEscape } from "../../utils/format";
import { recordRecentQueue } from "../../utils/recentQueues";
import { tryPrettyJson, tryPrettyXml, hexDump, detectFormat } from "../../utils/bodyView";
import { diffLines } from "../../utils/diff";

interface ReplyArg {
  address: string;
  body?: string;
  properties?: Record<string, string>;
  correlationId?: string;
}

interface Props {
  connected: boolean;
  defaultAddress: string;
  /** Active profile name — used to scope the per-profile Recent queues MRU. */
  activeProfile?: string;
  pendingAddress?: { address: string; nonce: number } | null;
  onLog: (kind: "info" | "ok" | "err", text: string) => void;
  onMessageReceived?: (bytes: number, queue: string) => void;
  onReply?: (arg: ReplyArg) => void;
}

/**
 * Display a subscriber timestamp as `YYYY-MM-DD HH:MM:SS`. The Rust backend
 * has formatted the field this way since the date-time switch; older
 * persisted messages still in localStorage carry the legacy `HH:MM:SS`
 * form, which we promote to today's date so the column doesn't render
 * inconsistently mid-session.
 */
function fmtTimestamp(ts: string): string {
  if (!ts) return "";
  // New-format value already has a date — leave alone.
  if (ts.includes("-")) return ts;
  // Legacy `HH:MM:SS` — synthesise today's date prefix.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${ts}`;
}

// ── highlight rules ──────────────────────────────────────────────────────────

const HIGHLIGHT_COLORS = ["red", "amber", "green", "blue", "purple", "pink"] as const;
type HighlightColor = typeof HIGHLIGHT_COLORS[number];

interface HighlightRule {
  id: string;
  name: string;
  pattern: string;
  color: HighlightColor;
  enabled: boolean;
}

const SELECTORS_STORAGE_KEY = "amqpush.subscriber.savedSelectors";
const RULES_STORAGE_KEY   = "amqpush.subscriber.highlightRules";

/** A named JMS-style selector saved across sessions for quick reuse. */
interface SavedSelector {
  id: string;
  name: string;
  selector: string;
}

function loadSavedSelectors(): SavedSelector[] {
  try {
    const raw = localStorage.getItem(SELECTORS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is SavedSelector =>
      !!s && typeof s.id === "string" && typeof s.name === "string" && typeof s.selector === "string");
  } catch { return []; }
}
function persistSavedSelectors(list: SavedSelector[]) {
  try { localStorage.setItem(SELECTORS_STORAGE_KEY, JSON.stringify(list)); } catch {}
}
const PERSIST_FLAG_KEY    = "amqpush.subscriber.persistEnabled";
const PERSIST_DATA_KEY    = "amqpush.subscriber.persistedMessages";
const PERSIST_MAX_ENTRIES = 500;

function loadRules(): HighlightRule[] {
  try {
    const raw = localStorage.getItem(RULES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(r => r && typeof r.id === "string");
  } catch { return []; }
}
function saveRules(rules: HighlightRule[]) {
  try { localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(rules)); } catch {}
}

const COLOR_BORDER: Record<HighlightColor, string> = {
  red:    "border-l-red-500",
  amber:  "border-l-amber-500",
  green:  "border-l-green-500",
  blue:   "border-l-blue-500",
  purple: "border-l-purple-500",
  pink:   "border-l-pink-500",
};
const COLOR_DOT: Record<HighlightColor, string> = {
  red:    "bg-negative",
  amber:  "bg-caution",
  green:  "bg-positive",
  blue:   "bg-accent",
  purple: "bg-accent-content",
  pink:   "bg-negative",
};

// ── helpers ──────────────────────────────────────────────────────────────────

function matchesFilter(msg: ReceivedMessage, filter: string): boolean {
  if (!filter.trim()) return true;
  const meta = msg.meta;
  const haystack = [
    msg.body, msg.queue,
    meta.message_id ?? "",
    meta.correlation_id ?? "",
    meta.content_type ?? "",
    ...Object.entries(meta.application_properties).map(([k, v]) => `${k}=${v}`),
  ].join("\n");
  try { return new RegExp(filter, "i").test(haystack); }
  catch { return haystack.toLowerCase().includes(filter.toLowerCase()); }
}

function ruleHaystack(msg: ReceivedMessage): string {
  const meta = msg.meta;
  return [
    msg.body, msg.queue,
    meta.message_id ?? "",
    meta.correlation_id ?? "",
    meta.content_type ?? "",
    ...Object.entries(meta.application_properties).map(([k, v]) => `${k}=${v}`),
  ].join("\n");
}

/**
 * Per-queue connection status tracked from the per-queue lifecycle events.
 * The Rust subscriber emits events with a `queue` field and we mirror state
 * here so the UI can show separate spinners / dots per subscription.
 */
interface QueueState {
  queue: string;
  reconnecting: boolean;
  /** JMS selector this subscription was started with (if any). Drives a
   *  small filter-chip on the active-subscription pill. */
  selector?: string;
  /** Topic-pattern wildcard this subscription was started with (if any).
   *  Sent as `apache.org:legacy-amqp-topic-binding:string` source filter. */
  topicPattern?: string;
  /** Set when the subscriber backend hit a permanent failure (auth refused,
   *  address not found, etc.) — retry would just loop. Chip turns red, the
   *  X stays visible for user dismissal. */
  unrecoverable?: { reason: string };
}

// ── component ────────────────────────────────────────────────────────────────

export default function SubscriberView({ connected, defaultAddress, activeProfile, pendingAddress, onLog, onMessageReceived, onReply }: Props) {
  const [picker,       setPicker]       = useState(defaultAddress);
  /** JMS-style broker-side selector, e.g. `priority > 5 AND type = 'order'`.
   *  Empty = no filter. Sent to start_subscriber as the `selector` arg.
   *  Persists per-subscription so the chips can show whether a queue is
   *  filtered. */
  const [selector,     setSelector]     = useState("");
  const [showSelector, setShowSelector] = useState(false);
  /** Saved-selector library — named JMS expressions reusable across
   *  sessions and queues. Persisted in localStorage; managed via a small
   *  dropdown next to the selector input. */
  const [savedSelectors, setSavedSelectors] = useState<SavedSelector[]>(() => loadSavedSelectors());
  const [savedSelectorsOpen, setSavedSelectorsOpen] = useState(false);
  const [saveSelectorPrompt, setSaveSelectorPrompt] = useState<string | null>(null); // pending name input, null = closed
  const savedSelectorWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => { persistSavedSelectors(savedSelectors); }, [savedSelectors]);
  // Close the dropdown on outside click.
  useEffect(() => {
    if (!savedSelectorsOpen) return;
    function onClick(e: MouseEvent) {
      if (savedSelectorWrapRef.current && !savedSelectorWrapRef.current.contains(e.target as Node)) {
        setSavedSelectorsOpen(false);
        setSaveSelectorPrompt(null);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [savedSelectorsOpen]);
  /** Topic-pattern wildcard (e.g. `orders.*`, `events.>`). Attached as
   *  `apache.org:legacy-amqp-topic-binding:string` source filter. Lets users
   *  subscribe to wildcards on brokers that don't honour pattern-in-address
   *  (Solace topic hierarchies, Qpid Broker-J), and works alongside the JMS
   *  selector — both filters apply if both are set. */
  const [topicPattern, setTopicPattern] = useState("");
  const [showTopicPattern, setShowTopicPattern] = useState(false);
  const [paused,       setPaused]       = useState(false);
  const [messages,     setMessages]     = useState<ReceivedMessage[]>([]);
  /** Recording mode — when on, each received message is captured to an
   *  in-memory buffer along with its arrival timestamp. Save flushes the
   *  buffer to `~/.amqpush/recordings/<name>.json` via the Tauri backend. */
  const [recording,    setRecording]    = useState(false);
  const [recordSaveOpen, setRecordSaveOpen] = useState(false);
  const [recordSaveName, setRecordSaveName] = useState("");
  /** Replay modal state. Open via the "Replay…" button in the top bar. */
  const [replayOpen, setReplayOpen] = useState(false);
  /** Captured messages while recording. Cleared on Stop / save. */
  const recordBufferRef = useRef<Array<{ ts: number; msg: ReceivedMessage }>>([]);
  const [recordCount, setRecordCount] = useState(0);
  /** Mirror of `recording` state, kept in a ref so the long-lived
   *  `message_received` listener (registered once on mount) reads the
   *  current value instead of the closure-captured `false`. Updated in
   *  the same micro-task as the React state via `toggleRecording`. */
  const recordingRef = useRef(false);
  function toggleRecording() {
    setRecording(prev => {
      const next = !prev;
      recordingRef.current = next;
      return next;
    });
  }
  const [confirmClearMsgs, setConfirmClearMsgs] = useState(false);
  const [filter,       setFilter]       = useState("");
  const [filterErr,    setFilterErr]    = useState(false);
  const [autoScroll,   setAutoScroll]   = useState(true);
  const [selectedId,   setSelectedId]   = useState<string | null>(null);
  const [droppedCount, setDroppedCount] = useState(0);

  // Active queue subscriptions (multi-queue)
  const [queues, setQueues] = useState<QueueState[]>([]);
  const listening = queues.length > 0;

  // Diff feature: id of message marked as comparison reference + visible flag
  const [refId,         setRefId]         = useState<string | null>(null);
  const [diffOpen,      setDiffOpen]      = useState(false);

  // Session stats
  const [sessionStart, setSessionStart] = useState<number | null>(null);
  const [sessionBytes, setSessionBytes] = useState(0);
  const [now,          setNow]          = useState(Date.now());
  const recentTsRef = useRef<number[]>([]);

  // Highlight rules
  const [rules,        setRules]        = useState<HighlightRule[]>(() => loadRules());
  const [rulesOpen,    setRulesOpen]    = useState(false);

  // Persistence toggle
  const [persistEnabled, setPersistEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem(PERSIST_FLAG_KEY) === "1"; } catch { return false; }
  });

  // Export menu
  const [exportOpen,   setExportOpen]   = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // Body viewer mode
  const [bodyMode,     setBodyMode]     = useState<"auto" | "raw" | "hex">("auto");

  const listEndRef = useRef<HTMLDivElement>(null);
  const pausedRef  = useRef(paused);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  const pendingNotif = useRef(0);
  const notifTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { saveRules(rules); }, [rules]);

  // Restore persisted messages on mount (opt-in)
  useEffect(() => {
    if (!persistEnabled) return;
    try {
      const raw = localStorage.getItem(PERSIST_DATA_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        setMessages(parsed);
        onLog("info", `Restored ${parsed.length} persisted message${parsed.length !== 1 ? "s" : ""}`);
      }
    } catch { /* ignore */ }
  }, []);

  // Persist messages to localStorage (debounced, capped to PERSIST_MAX_ENTRIES)
  useEffect(() => {
    if (!persistEnabled) return;
    const t = setTimeout(() => {
      try {
        const sliced = messages.slice(-PERSIST_MAX_ENTRIES);
        localStorage.setItem(PERSIST_DATA_KEY, JSON.stringify(sliced));
      } catch (e) {
        // localStorage quota errors are common with large bodies — log and disable
        onLog("err", `Persistence failed (storage full?): ${e}`);
      }
    }, 800);
    return () => clearTimeout(t);
  }, [messages, persistEnabled]);

  // Toggle handler — also clears the stored snapshot when turning off
  function togglePersist() {
    setPersistEnabled(p => {
      const next = !p;
      try {
        localStorage.setItem(PERSIST_FLAG_KEY, next ? "1" : "0");
        if (!next) localStorage.removeItem(PERSIST_DATA_KEY);
      } catch {}
      onLog("info", next ? "Persistence enabled — messages saved across restarts" : "Persistence disabled");
      return next;
    });
  }

  // Reset body viewer mode when selection changes
  useEffect(() => { setBodyMode("auto"); }, [selectedId]);

  // Tick `now` every second while listening
  useEffect(() => {
    if (!listening) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [listening]);

  // Close export dropdown on outside click
  useEffect(() => {
    if (!exportOpen) return;
    function onClick(e: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) setExportOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [exportOpen]);

  useEffect(() => { if (!pendingAddress) return; setPicker(pendingAddress.address); }, [pendingAddress?.nonce]);
  useEffect(() => { if (autoScroll) listEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length, autoScroll]);

  useEffect(() => {
    if (!filter) { setFilterErr(false); return; }
    try { new RegExp(filter); setFilterErr(false); }
    catch { setFilterErr(true); }
  }, [filter]);

  async function maybeNotify() {
    if (document.hasFocus()) return;
    pendingNotif.current += 1;
    if (notifTimer.current) clearTimeout(notifTimer.current);
    notifTimer.current = setTimeout(async () => {
      const count = pendingNotif.current;
      pendingNotif.current = 0;
      try {
        let permitted = await isPermissionGranted();
        if (!permitted) {
          const result = await requestPermission();
          permitted = result === "granted";
        }
        if (permitted) {
          sendNotification({
            title: "AMQPush",
            body: count === 1 ? "New message received" : `${count} new messages received`,
          });
        }
      } catch { /* notifications not available */ }
    }, 800);
  }

  // Refresh subscriber list from backend (after start/stop or on reconnects)
  async function refreshSubscriberList() {
    try {
      const list = await invoke<string[]>("list_subscribers");
      setQueues(prev => list.map(q => ({
        queue: q,
        reconnecting: prev.find(p => p.queue === q)?.reconnecting ?? false,
      })));
    } catch { /* ignore */ }
  }

  useEffect(() => {
    const u1 = listen<ReceivedMessage>("message_received", e => {
      if (pausedRef.current) {
        setDroppedCount(c => c + 1);
        return;
      }
      const t = Date.now();
      recentTsRef.current = recentTsRef.current.filter(x => t - x <= 5000);
      recentTsRef.current.push(t);

      setMessages(prev => [...prev, e.payload]);
      // Recording: capture wall-clock time so replay can reproduce gaps.
      // We buffer in a ref (not state) to avoid re-rendering on every msg.
      if (recordingRef.current) {
        recordBufferRef.current.push({ ts: Date.now(), msg: e.payload });
        setRecordCount(recordBufferRef.current.length);
      }
      setSessionBytes(b => b + e.payload.meta.body_size);
      maybeNotify();
      if (onMessageReceived) {
        onMessageReceived(e.payload.meta.body_size, e.payload.queue || "(unknown)");
      }
    });
    const u2 = listen<SubEvent>("subscriber_error", e => {
      onLog("err", `Subscriber error on '${e.payload.queue}': ${e.payload.message ?? "unknown"}`);
      setQueues(prev => prev.filter(q => q.queue !== e.payload.queue));
    });
    const u3 = listen<SubEvent>("subscriber_reconnecting", e => {
      setQueues(prev => prev.map(q => q.queue === e.payload.queue ? { ...q, reconnecting: true } : q));
      const ms = Number(e.payload.message ?? "0");
      onLog("info", `'${e.payload.queue}': lost connection, reconnecting in ${(ms / 1000).toFixed(0)}s…`);
    });
    const u4 = listen<SubEvent>("subscriber_reconnected", e => {
      setQueues(prev => prev.map(q => q.queue === e.payload.queue ? { ...q, reconnecting: false } : q));
      onLog("ok", `'${e.payload.queue}': reconnected`);
    });
    const u5 = listen<SubEvent>("subscriber_stopped", e => {
      // Keep the chip when the stop was triggered by an unrecoverable
      // failure (the unrecoverable handler below tagged the queue first).
      // Removing it would hide the error from the user.
      setQueues(prev => prev.filter(q => q.queue !== e.payload.queue || q.unrecoverable));
    });
    const u6 = listen<SubEvent>("subscriber_unrecoverable", e => {
      const reason = e.payload.message ?? "unknown";
      onLog("err", `'${e.payload.queue}': stopped permanently — ${reason}. Fix the upstream issue and re-subscribe.`);
      setQueues(prev => prev.map(q =>
        q.queue === e.payload.queue
          ? { ...q, reconnecting: false, unrecoverable: { reason } }
          : q
      ));
    });
    return () => {
      u1.then(f => f()); u2.then(f => f()); u3.then(f => f());
      u4.then(f => f()); u5.then(f => f()); u6.then(f => f());
      if (notifTimer.current) clearTimeout(notifTimer.current);
    };
  }, []);

  // Refresh subscriber list when component mounts or connection state changes,
  // so re-entering the view reflects what the backend actually has.
  useEffect(() => { if (connected) refreshSubscriberList(); }, [connected]);

  /**
   * Flush the in-memory recording buffer to a file via the backend. The
   * file ends up in `~/.amqpush/recordings/<name>.json` and is immediately
   * pickable in the Replay view. Buffer is cleared on success.
   */
  async function saveRecording(name: string): Promise<void> {
    const buf = recordBufferRef.current;
    if (buf.length === 0) { onLog("err", "Recording buffer is empty"); return; }
    const startTs = buf[0].ts;
    // Group by source queue — use the first observed one if mixed (rare).
    const sourceQueue = buf[0].msg.queue || "";
    const recMsgs = buf.map(({ ts, msg }) => ({
      offset_ms: Math.max(0, ts - startTs),
      body: msg.meta.body_text ?? msg.body ?? "",
      content_type: msg.meta.content_type ?? null,
      properties: msg.meta.application_properties ?? {},
    }));
    try {
      await invoke("save_recording", {
        recording: {
          version: 1,
          name: name.trim(),
          source_queue: sourceQueue,
          started_at_ms: startTs,
          messages: recMsgs,
        },
      });
      onLog("ok", `Saved recording '${name.trim()}' — ${recMsgs.length} messages`);
      recordBufferRef.current = [];
      setRecordCount(0);
      setRecordSaveOpen(false);
    } catch (e) {
      onLog("err", `Save recording: ${e}`);
    }
  }

  async function addSubscription() {
    if (!connected)        { onLog("err", "Not connected to broker"); return; }
    const addr = picker.trim();
    if (!addr)             { onLog("err", "Queue address is required"); return; }
    if (queues.some(q => q.queue === addr)) { onLog("err", `Already subscribed to '${addr}'`); return; }
    try {
      const sel = selector.trim();
      const topic = topicPattern.trim();
      await invoke("start_subscriber", {
        address: addr,
        selector: sel || null,
        topicPattern: topic || null,
      });
      setQueues(prev => [...prev, {
        queue: addr,
        reconnecting: false,
        selector: sel || undefined,
        topicPattern: topic || undefined,
      }]);
      // Bump per-profile Recent queues MRU so subscribing once surfaces the
      // queue in the picker dropdown next time.
      recordRecentQueue(activeProfile ?? "", addr);
      if (sessionStart === null) {
        setSessionStart(Date.now());
        setSessionBytes(0);
        recentTsRef.current = [];
      }
      onLog("ok", `Listening on '${addr}'…`);
    } catch (e) { onLog("err", `Subscriber failed: ${e}`); }
  }

  async function removeSubscription(addr: string) {
    try {
      await invoke("stop_subscriber", { address: addr });
      setQueues(prev => {
        const next = prev.filter(q => q.queue !== addr);
        if (next.length === 0) setSessionStart(null);
        return next;
      });
      onLog("info", `Stopped '${addr}'`);
    } catch (e) { onLog("err", String(e)); }
  }

  async function stopAll() {
    try {
      await invoke("stop_subscriber", { address: null });
      setQueues([]);
      setSessionStart(null);
      setPaused(false);
      setDroppedCount(0);
      onLog("info", "All subscribers stopped");
    } catch (e) { onLog("err", String(e)); }
  }

  function togglePause() {
    setPaused(p => {
      const next = !p;
      if (!next) setDroppedCount(0);
      onLog("info", next ? "Paused — incoming messages will be dropped" : "Resumed");
      return next;
    });
  }

  function clearMessages() {
    setMessages([]);
    setSelectedId(null);
    setRefId(null);
    setFilter("");
    setDroppedCount(0);
    setSessionBytes(0);
    setSessionStart(listening ? Date.now() : null);
    recentTsRef.current = [];
    if (persistEnabled) {
      try { localStorage.removeItem(PERSIST_DATA_KEY); } catch {}
    }
  }

  function downloadBlob(content: string, mime: string, ext: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `amqpush-received-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportJson() {
    setExportOpen(false);
    downloadBlob(JSON.stringify(messages, null, 2), "application/json", "json");
    onLog("ok", `Exported ${messages.length} message${messages.length !== 1 ? "s" : ""} to JSON`);
  }

  function exportCsv() {
    setExportOpen(false);
    const header = [
      "id", "timestamp", "queue", "message_id", "correlation_id", "reply_to",
      "content_type", "body_size", "priority", "durable",
      "delivery_count", "creation_time", "body",
    ].join(",");
    const rows = messages.map(m => [
      csvEscape(m.id),
      csvEscape(fmtTimestamp(m.timestamp)),
      csvEscape(m.queue),
      csvEscape(m.meta.message_id ?? ""),
      csvEscape(m.meta.correlation_id ?? ""),
      csvEscape(m.meta.reply_to ?? ""),
      csvEscape(m.meta.content_type ?? ""),
      csvEscape(String(m.meta.body_size)),
      csvEscape(m.meta.priority?.toString() ?? ""),
      csvEscape(m.meta.durable?.toString() ?? ""),
      csvEscape(String(m.meta.delivery_count)),
      csvEscape(m.meta.creation_time ? new Date(m.meta.creation_time).toISOString() : ""),
      csvEscape(m.meta.body_text ?? m.body),
    ].join(",")).join("\n");
    downloadBlob(header + "\n" + rows, "text/csv", "csv");
    onLog("ok", `Exported ${messages.length} message${messages.length !== 1 ? "s" : ""} to CSV`);
  }

  function handleReply(msg: ReceivedMessage) {
    const replyTarget = msg.meta.reply_to;
    if (!replyTarget) {
      onLog("err", "This message has no reply-to address — cannot Reply");
      return;
    }
    if (!onReply) return;
    onReply({
      address: replyTarget,
      body: "",
      correlationId: msg.meta.correlation_id ?? msg.meta.message_id ?? undefined,
    });
    onLog("info", `Reply → ${replyTarget}${msg.meta.correlation_id ? `  (correlation-id: ${msg.meta.correlation_id})` : ""}`);
  }

  // Compile rules once
  const compiledRules = useMemo(() => rules
    .filter(r => r.enabled && r.pattern.trim())
    .map(r => {
      try { return { ...r, regex: new RegExp(r.pattern, "i") }; }
      catch { return null; }
    })
    .filter((r): r is HighlightRule & { regex: RegExp } => r !== null), [rules]);

  function matchRule(msg: ReceivedMessage): (HighlightRule & { regex: RegExp }) | null {
    const hay = ruleHaystack(msg);
    return compiledRules.find(r => r.regex.test(hay)) ?? null;
  }

  // Newest-first display order. The underlying `messages` array stays in
  // chronological order (so persistence, CSV export, and the "previous to
  // same queue" diff still work) — we only reverse for the rendered list.
  const filtered = (filter && !filterErr
    ? messages.filter(m => matchesFilter(m, filter))
    : messages
  ).slice().reverse();
  const isFiltering = filter.trim().length > 0 && !filterErr;
  const selected = selectedId ? messages.find(m => m.id === selectedId) ?? null : null;
  const refMsg   = refId      ? messages.find(m => m.id === refId)      ?? null : null;

  // Session stats
  const sessionDurationMs = sessionStart ? now - sessionStart : 0;
  const recentRate = (() => {
    if (recentTsRef.current.length < 2) return 0;
    const window = (recentTsRef.current[recentTsRef.current.length - 1] - recentTsRef.current[0]) / 1000;
    return window > 0 ? recentTsRef.current.length / Math.max(window, 1) : 0;
  })();
  const avgSize = messages.length > 0 ? sessionBytes / messages.length : 0;

  const rulesActiveCount = rules.filter(r => r.enabled && r.pattern.trim()).length;
  const anyReconnecting = queues.some(q => q.reconnecting);

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">

      {/* ─── TITLE ROW ─── */}
      <ViewTopBar
        icon={<Inbox className="w-3.5 h-3.5" />}
        title="Receive Messages"
      >
        {listening && (
          <button
            onClick={togglePause}
            className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors border ${
              paused
                ? "bg-caution/10 border-caution/30 text-caution hover:bg-caution/20"
                : "border-t-line text-t-ink3 hover:text-t-ink hover:bg-t-hover"
            }`}
            title={paused ? "Resume" : "Pause — drop incoming messages"}
          >
            {paused ? <><Play className="w-3 h-3" /> Resume</> : <><Pause className="w-3 h-3" /> Pause</>}
          </button>
        )}

        <button
          onClick={addSubscription}
          disabled={!connected}
          className="shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold bg-positive hover:bg-positive text-white transition-all whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
          title={listening ? "Add another queue to listen to" : "Start listening on this queue"}
        >
          {listening ? <><Plus className="w-3.5 h-3.5" /> Add</> : <><Play className="w-3.5 h-3.5" /> Start</>}
        </button>

        <button
          onClick={() => setReplayOpen(true)}
          disabled={!connected}
          className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12.5px] font-medium border border-t-line text-t-ink2 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40"
          title={connected ? "Pick a saved recording and replay it to a queue" : "Connect to broker first"}
        >
          <Play className="w-3 h-3" /> Replay…
        </button>
        {listening && (
          <button
            onClick={stopAll}
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12.5px] font-medium bg-negative/10 border border-negative/30 text-negative hover:bg-negative/20 transition-colors"
            title="Stop all subscribers"
          >
            <Square className="w-3 h-3" /> Stop all
          </button>
        )}
      </ViewTopBar>

      {/* ─── QUEUE PICKER ROW ─── */}
      <div className="shrink-0 px-3 py-1.5 border-b border-t-line bg-t-panel flex items-center gap-2">
        <SectionLabel className="shrink-0 w-12">From</SectionLabel>
        <QueuePicker value={picker} onChange={setPicker} connected={connected} profileName={activeProfile} disabled={false} showSave className="flex-1" />
        <button
          type="button"
          onClick={() => setShowSelector(s => !s)}
          className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11.5px] font-medium border transition-colors ${
            selector.trim()
              ? "border-accent/40 text-accent bg-accent/10 hover:bg-accent/20"
              : showSelector
                ? "border-t-line2 text-t-ink bg-t-card"
                : "border-t-line text-t-ink4 hover:text-t-ink hover:bg-t-hover"
          }`}
          title={selector.trim() ? `Selector active: ${selector}` : "Add a JMS-style broker-side selector"}
        >
          <Filter className="w-3 h-3" />
          Selector
          {selector.trim() && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
        </button>
        <button
          type="button"
          onClick={() => setShowTopicPattern(s => !s)}
          className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11.5px] font-medium border transition-colors ${
            topicPattern.trim()
              ? "border-accent-content/40 text-accent-content bg-accent-content/10 hover:bg-accent-content/20"
              : showTopicPattern
                ? "border-t-line2 text-t-ink bg-t-card"
                : "border-t-line text-t-ink4 hover:text-t-ink hover:bg-t-hover"
          }`}
          title={topicPattern.trim() ? `Pattern active: ${topicPattern}` : "Subscribe to a topic pattern with wildcards"}
        >
          <Hash className="w-3 h-3" />
          Pattern
          {topicPattern.trim() && <span className="w-1.5 h-1.5 rounded-full bg-accent-content" />}
        </button>
      </div>

      {/* ─── SELECTOR INPUT ROW (collapsible) ─── */}
      {showSelector && (
        <div className="shrink-0 px-3 py-1.5 border-b border-t-line bg-t-panel/60 flex items-start gap-2">
          <SectionLabel className="shrink-0 mt-1.5 w-12">Where</SectionLabel>
          <div className="flex-1 min-w-0">
            <input
              value={selector}
              onChange={e => setSelector(e.target.value)}
              placeholder="priority > 5 AND application_property:type = 'order'"
              spellCheck={false}
              className="w-full font-mono text-[12.5px] bg-t-field border border-t-line2 rounded-lg px-2.5 py-1.5 text-t-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-all placeholder:text-t-ink5"
            />
            <p className="text-[10.5px] text-t-ink5 mt-1">
              JMS-style selector applied broker-side via <span className="font-mono">apache.org:selector-filter:string</span>.
              Supported on Artemis / ActiveMQ / Qpid. Empty = receive everything.
            </p>
          </div>
          {/* Saved-selectors library — click to apply, "Save current as…"
              persists the current input under a name. */}
          <div ref={savedSelectorWrapRef} className="relative shrink-0 mt-0.5">
            <button
              type="button"
              onClick={() => { setSavedSelectorsOpen(o => !o); setSaveSelectorPrompt(null); }}
              title="Saved selectors"
              aria-label="Saved selectors"
              className={`p-1.5 rounded-md transition-colors ${
                savedSelectorsOpen
                  ? "text-accent bg-accent/10"
                  : "text-t-ink4 hover:text-t-ink2 hover:bg-t-hover"
              }`}
            >
              <BookMarked className="w-3.5 h-3.5" />
            </button>
            {savedSelectorsOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-t-card border border-t-line rounded-lg shadow-lg overflow-hidden w-72">
                <div className="px-3 py-1.5 border-b border-t-line bg-t-panel text-[10.5px] uppercase tracking-wider text-t-ink4 font-semibold">
                  Saved selectors
                </div>
                <div className="max-h-56 overflow-y-auto">
                  {savedSelectors.length === 0 ? (
                    <p className="px-3 py-3 text-[11.5px] text-t-ink5 text-center">
                      No saved selectors yet. Type a selector and click "Save current as…".
                    </p>
                  ) : savedSelectors.map(s => (
                    <div key={s.id} className="group flex items-center gap-2 px-3 py-1.5 border-b border-t-line/40 hover:bg-t-hover/50 transition-colors">
                      <button
                        type="button"
                        onClick={() => { setSelector(s.selector); setSavedSelectorsOpen(false); }}
                        className="flex-1 min-w-0 text-left"
                        title={s.selector}
                      >
                        <div className="text-[12.5px] text-t-ink truncate">{s.name}</div>
                        <div className="text-[10.5px] text-t-ink5 font-mono truncate">{s.selector}</div>
                      </button>
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setSavedSelectors(prev => prev.filter(x => x.id !== s.id));
                        }}
                        title={`Forget '${s.name}'`}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-t-ink5 hover:text-negative transition-all"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="border-t border-t-line bg-t-panel/60">
                  {saveSelectorPrompt === null ? (
                    <button
                      type="button"
                      onClick={() => { if (selector.trim()) setSaveSelectorPrompt(""); }}
                      disabled={!selector.trim()}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-accent hover:bg-t-hover transition-colors text-[12.5px] font-medium disabled:opacity-40 disabled:hover:bg-transparent"
                      title={selector.trim() ? "Save current selector under a name" : "Type a selector first"}
                    >
                      <Save className="w-3 h-3 shrink-0" /> Save current as…
                    </button>
                  ) : (
                    <div className="flex items-center gap-1 px-2 py-1.5">
                      <input
                        autoFocus
                        value={saveSelectorPrompt}
                        onChange={e => setSaveSelectorPrompt(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter" && saveSelectorPrompt.trim()) {
                            const name = saveSelectorPrompt.trim();
                            const newSel: SavedSelector = { id: `${Date.now()}`, name, selector: selector.trim() };
                            // Overwrite by name if already exists.
                            setSavedSelectors(prev => {
                              const without = prev.filter(x => x.name !== name);
                              return [...without, newSel].sort((a, b) => a.name.localeCompare(b.name));
                            });
                            setSaveSelectorPrompt(null);
                            onLog("ok", `Saved selector '${name}'`);
                          }
                          if (e.key === "Escape") setSaveSelectorPrompt(null);
                        }}
                        placeholder="Name (e.g. VIP priority)"
                        className="flex-1 min-w-0 bg-t-field border border-t-line2 rounded-md px-2 py-0.5 text-[11.5px] text-t-ink outline-none focus:border-accent"
                      />
                      <button
                        type="button"
                        onClick={() => setSaveSelectorPrompt(null)}
                        title="Cancel"
                        className="p-1 rounded-md text-t-ink5 hover:text-t-ink2"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          {selector && (
            <button
              type="button"
              onClick={() => setSelector("")}
              className="shrink-0 mt-1 p-1 rounded-md text-t-ink4 hover:text-negative hover:bg-t-hover transition-colors"
              title="Clear selector"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      {/* ─── TOPIC-PATTERN INPUT ROW (collapsible) ─── */}
      {showTopicPattern && (
        <div className="shrink-0 px-3 py-1.5 border-b border-t-line bg-t-panel/60 flex items-start gap-2">
          <SectionLabel className="shrink-0 mt-1.5 w-12">Topic</SectionLabel>
          <div className="flex-1 min-w-0">
            <input
              value={topicPattern}
              onChange={e => setTopicPattern(e.target.value)}
              placeholder="orders.*  or  events.>  or  notifications.#"
              spellCheck={false}
              className="w-full font-mono text-[12.5px] bg-t-field border border-t-line2 rounded-lg px-2.5 py-1.5 text-t-ink outline-none focus:border-accent-content focus:ring-1 focus:ring-accent-content/30 transition-all placeholder:text-t-ink5"
            />
            <p className="text-[10.5px] text-t-ink5 mt-1">
              Wildcard pattern applied via <span className="font-mono">apache.org:legacy-amqp-topic-binding:string</span>.
              Wildcard syntax is broker-specific — Artemis multicast: <span className="font-mono">*</span> (one word) / <span className="font-mono">#</span> (zero+ words).
              Solace: <span className="font-mono">*</span> / <span className="font-mono">&gt;</span>. Works alongside Selector if both are set.
            </p>
          </div>
          {topicPattern && (
            <button
              type="button"
              onClick={() => setTopicPattern("")}
              className="shrink-0 mt-1 p-1 rounded-md text-t-ink4 hover:text-negative hover:bg-t-hover transition-colors"
              title="Clear pattern"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      {/* ─── ACTIVE SUBSCRIPTIONS BAR ─── */}
      {listening && (
        <div className={`shrink-0 px-3 py-1.5 border-b flex items-center gap-2 flex-wrap ${
          paused
            ? "bg-caution/5 border-caution/20"
            : anyReconnecting
              ? "bg-caution/5 border-caution/20"
              : "bg-positive/5 border-positive/15"
        }`}>
          {paused && (
            <span className="flex items-center gap-1 text-[11.5px] text-caution">
              <Pause className="w-3 h-3" /> Paused
              {droppedCount > 0 && <span className="text-caution/70">· {droppedCount} dropped</span>}
            </span>
          )}
          {!paused && (
            <span className="text-[11.5px] text-t-ink4 uppercase tracking-wider font-semibold mr-1">
              Listening
            </span>
          )}
          {/* Per-queue chips */}
          <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
            {queues.map(q => {
              // Three visual states: live (green), reconnecting (amber),
              // permanently failed (red — auth refused / address gone / etc).
              const failedClass = q.unrecoverable
                ? "bg-negative/10 border-negative/40 text-negative"
                : q.reconnecting
                  ? "bg-caution/10 border-caution/30 text-caution"
                  : "bg-t-card border-t-line text-t-ink2";
              const titleText =
                (q.unrecoverable
                  ? `'${q.queue}': stopped permanently — ${q.unrecoverable.reason}`
                  : q.reconnecting
                    ? `Reconnecting to '${q.queue}'…`
                    : `Listening on '${q.queue}'`) +
                (q.selector ? ` · selector: ${q.selector}` : "") +
                (q.topicPattern ? ` · pattern: ${q.topicPattern}` : "");
              const dismiss = () => {
                if (q.unrecoverable) {
                  // No backend to stop — already stopped. Just drop the
                  // chip from local state.
                  setQueues(prev => prev.filter(x => x.queue !== q.queue));
                } else {
                  removeSubscription(q.queue);
                }
              };
              return (
                <span key={q.queue}
                  className={`group flex items-center gap-1.5 px-2 py-0.5 rounded-lg border font-mono text-[11.5px] ${failedClass}`}
                  title={titleText}
                >
                  {q.unrecoverable
                    ? <span className="w-1.5 h-1.5 rounded-full bg-negative" />
                    : q.reconnecting
                      ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
                      : <span className="w-1.5 h-1.5 rounded-full bg-positive animate-pulse" />}
                  {q.queue}
                  {q.selector && (
                    <Filter className="w-2.5 h-2.5 text-accent" />
                  )}
                  {q.topicPattern && (
                    <Hash className="w-2.5 h-2.5 text-accent-content" />
                  )}
                  <button
                    onClick={dismiss}
                    className={`${q.unrecoverable ? "" : "opacity-50 group-hover:opacity-100"} hover:text-negative transition-opacity`}
                    title={q.unrecoverable ? `Dismiss '${q.queue}'` : `Stop '${q.queue}'`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              );
            })}
          </div>

          {/* Record toggle — small "REC" button. While on, all incoming
              messages are captured to an in-memory buffer; Save flushes to
              `~/.amqpush/recordings/<name>.json`. Buffer is preserved when
              recording is paused so you can review counts before saving. */}
          <button
            onClick={toggleRecording}
            className={`shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[11.5px] font-medium transition-colors ${
              recording
                ? "bg-negative/10 border-negative/40 text-negative"
                : "border-t-line text-t-ink4 hover:text-t-ink hover:bg-t-hover"
            }`}
            title={recording
              ? `Recording — ${recordCount} messages captured. Click to pause.`
              : recordCount > 0
                ? `Resume recording (${recordCount} buffered)`
                : "Start recording incoming messages for later replay"}
          >
            <Circle className={`w-2.5 h-2.5 ${recording ? "fill-negative text-negative animate-pulse" : ""}`} />
            REC{recordCount > 0 && <span className="font-mono opacity-80">{recordCount}</span>}
          </button>
          {/* Save is always rendered next to REC so the user never has to
              hunt for it. Disabled with a clear tooltip when the buffer is
              empty (no messages captured yet). Clicking saves whatever's in
              the buffer — works mid-recording too (snapshots the buffer,
              recording continues with a fresh one). */}
          <button
            onClick={() => { setRecordSaveName(""); setRecordSaveOpen(true); }}
            disabled={recordCount === 0}
            title={recordCount === 0
              ? "Save — nothing captured yet (click REC first, then receive some messages)"
              : recording
                ? `Snapshot the ${recordCount} buffered messages (recording continues with a fresh buffer)`
                : `Save the ${recordCount} buffered messages as a recording for later replay`}
            className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-lg border border-accent/30 text-accent text-[11.5px] font-medium hover:bg-accent/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:border-t-line disabled:text-t-ink5"
          >
            <Save className="w-3 h-3" /> Save…{recordCount > 0 && <span className="font-mono opacity-80">{recordCount}</span>}
          </button>

          {/* Session stats */}
          <div className="ml-auto flex items-center gap-3 text-[11.5px] font-mono text-t-ink4 shrink-0">
            <span title="Total received this session"><span className="text-t-ink3">{messages.length}</span> msg</span>
            {sessionBytes > 0 && (
              <span title="Total bytes received"><span className="text-t-ink3">{fmtBytes(sessionBytes)}</span></span>
            )}
            {avgSize > 0 && (
              <span title="Average message size"><span className="text-t-ink5">avg</span> {fmtBytes(avgSize)}</span>
            )}
            {recentRate > 0 && (
              <span title="Rate over last 5s"><span className="text-t-ink3">{recentRate.toFixed(1)}</span><span className="text-t-ink5">/s</span></span>
            )}
            {sessionStart && (
              <span title="Session duration" className="text-t-ink5">{fmtDuration(sessionDurationMs)}</span>
            )}
          </div>
        </div>
      )}

      {/* ─── FILTER BAR ─── */}
      {messages.length > 0 && (
        <div className="shrink-0 px-3 py-1 border-b border-t-line bg-t-panel flex items-center gap-2">
          <Search className={`w-3.5 h-3.5 shrink-0 ${filterErr ? "text-negative" : "text-t-ink5"}`} />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter by body, queue, id, content-type, app-property…"
            className={`flex-1 bg-transparent text-xs text-t-ink outline-none placeholder:text-t-ink5 ${filterErr ? "text-negative" : ""}`}
          />
          {filter && (
            <button onClick={() => setFilter("")} className="text-t-ink5 hover:text-t-ink3 transition-colors">
              <X className="w-3 h-3" />
            </button>
          )}
          {isFiltering && <span className="text-[11.5px] text-t-ink4 shrink-0">{filtered.length} / {messages.length}</span>}
          {filterErr && <span className="text-[11.5px] text-negative shrink-0">invalid regex</span>}
          <button
            onClick={() => setAutoScroll(a => !a)}
            className={`text-[11.5px] transition-colors px-1.5 py-0.5 rounded-md shrink-0 ${autoScroll ? "text-accent bg-accent/10" : "text-t-ink5 hover:text-t-ink3"}`}
            title="Auto-scroll to newest"
          >
            {autoScroll ? "● Auto" : "○ Auto"}
          </button>

          <button
            onClick={togglePersist}
            className={`flex items-center gap-1 text-[11.5px] transition-colors px-1.5 py-0.5 rounded-md shrink-0 ${
              persistEnabled ? "text-accent bg-accent/10" : "text-t-ink4 hover:text-t-ink3"
            }`}
            title={persistEnabled
              ? `Persistence on — last ${PERSIST_MAX_ENTRIES} messages saved across restarts`
              : `Click to save messages across app restarts (max ${PERSIST_MAX_ENTRIES})`
            }
          >
            <Database className="w-3 h-3" /> Persist
          </button>

          <button
            onClick={() => setRulesOpen(true)}
            className={`flex items-center gap-1 text-[11.5px] transition-colors px-1.5 py-0.5 rounded-md shrink-0 ${
              rulesActiveCount > 0 ? "text-accent bg-accent/10" : "text-t-ink4 hover:text-t-ink3"
            }`}
            title={`Highlight rules ${rulesActiveCount > 0 ? `(${rulesActiveCount} active)` : ""}`}
          >
            <Palette className="w-3 h-3" /> Rules{rulesActiveCount > 0 && <span className="font-mono">{rulesActiveCount}</span>}
          </button>

          <div ref={exportMenuRef} className="relative shrink-0">
            <button onClick={() => setExportOpen(o => !o)}
              className="flex items-center gap-1 text-[11.5px] text-t-ink4 hover:text-accent transition-colors px-1.5 py-0.5"
              title="Export received messages">
              <Download className="w-3 h-3" /> Export
              <ChevronDown className="w-3 h-3" />
            </button>
            {exportOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-32 bg-t-card border border-t-line rounded-lg shadow-lg overflow-hidden">
                <button onClick={exportJson}
                  className="w-full text-left px-3 py-1.5 text-[12.5px] text-t-ink2 hover:bg-t-hover transition-colors">
                  JSON
                </button>
                <button onClick={exportCsv}
                  className="w-full text-left px-3 py-1.5 text-[12.5px] text-t-ink2 hover:bg-t-hover transition-colors border-t border-t-line">
                  CSV
                </button>
              </div>
            )}
          </div>

          <button onClick={() => setConfirmClearMsgs(true)}
            disabled={messages.length === 0}
            className="flex items-center gap-1 text-[11.5px] text-t-ink4 hover:text-negative transition-colors shrink-0 disabled:opacity-40 disabled:hover:text-t-ink4">
            <Trash2 className="w-3 h-3" /> Clear
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirmClearMsgs}
        title="Clear received messages"
        body={
          <p>
            Discard{" "}
            <span className="font-mono font-bold text-t-ink">{messages.length.toLocaleString()}</span>{" "}
            received message{messages.length === 1 ? "" : "s"} from this session?
            {persistEnabled && <> The persisted copy in <code className="text-t-ink4">localStorage</code> will also be wiped.</>}
            {" "}Subscription stays active — new arrivals will continue to populate the list.
          </p>
        }
        confirmLabel={`Clear ${messages.length.toLocaleString()} message${messages.length === 1 ? "" : "s"}`}
        onConfirm={() => { clearMessages(); setConfirmClearMsgs(false); }}
        onCancel={() => setConfirmClearMsgs(false)}
      />

      {/* ─── REFERENCE / DIFF BAR ─── */}
      {refMsg && (
        <div className="shrink-0 px-3 py-1 border-b border-t-line bg-accent/5 flex items-center gap-2 text-[11.5px]">
          <GitCompare className="w-3 h-3 text-accent" />
          <span className="text-t-ink4">Reference for diff:</span>
          <span className="font-mono text-t-ink2 truncate max-w-[300px]" title={refMsg.meta.message_id ?? ""}>
            {refMsg.meta.message_id ?? "(no message-id)"}
          </span>
          <span className="text-t-ink5 font-mono">{refMsg.queue}</span>
          {selected && selected.id !== refMsg.id && (
            <button
              onClick={() => setDiffOpen(true)}
              className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-lg bg-accent-strong hover:bg-accent text-white text-[11.5px] font-medium transition-colors"
            >
              <GitCompare className="w-3 h-3" /> Compare with selected
            </button>
          )}
          <button
            onClick={() => setRefId(null)}
            className={`${selected && selected.id !== refMsg.id ? "" : "ml-auto"} text-t-ink4 hover:text-negative transition-colors`}
            title="Clear reference"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* ─── BODY: split — left list / right preview ─── */}
      <div className="flex-1 min-h-0 flex overflow-hidden">

        {/* ─── LEFT: MESSAGE LIST ─── */}
        <div className={`${selected ? "w-[42%] border-r border-t-line" : "flex-1"} flex flex-col min-w-0 min-h-0 overflow-hidden`}>
          {messages.length === 0 ? (
            <EmptyState
              icon={<Inbox className="w-8 h-8" />}
              title="No messages received"
              subtitle={listening ? "Send something to a subscribed queue" : "Pick a queue and click Start"}
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Search className="w-8 h-8" />}
              title="No messages match filter"
              action={<button onClick={() => setFilter("")} className="text-[11.5px] text-accent hover:text-accent-content transition-colors">Clear filter</button>}
            />
          ) : (
            <div className="flex-1 overflow-y-auto min-h-0">
              {/* Column header row — mirrors the first line of every message
                  card so the user sees what each column means. Stays pinned
                  on scroll. Second line is heterogeneous chips (queue / type /
                  size / priority / reply-to) so no labels are useful there. */}
              <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1 bg-t-panel/95 backdrop-blur-sm border-b border-t-line text-[10.5px] uppercase tracking-wider text-t-ink4 select-none">
                <span className="w-3 shrink-0" />
                <span className="font-semibold flex-1">Message ID</span>
                <span className="font-semibold shrink-0">Date-Time</span>
              </div>
              {filtered.map(msg => {
                const isSel = selectedId === msg.id;
                const isRef = refId === msg.id;
                const idShort = msg.meta.message_id ?? "—";
                const ct = msg.meta.content_type ?? msg.meta.body_kind;
                const rule = matchRule(msg);
                const borderClass = rule
                  ? `border-l-2 ${COLOR_BORDER[rule.color]}`
                  : isRef
                    ? "border-l-2 border-l-blue-500"
                    : "border-l-2 border-l-transparent";
                return (
                  <button
                    key={msg.id}
                    onClick={() => setSelectedId(msg.id)}
                    className={`w-full text-left flex flex-col gap-0.5 px-3 py-2 border-b border-t-line/40 transition-colors ${borderClass} ${
                      isSel ? "bg-accent/10" : isRef ? "bg-accent/5" : "hover:bg-t-hover/50"
                    }`}
                  >
                    <div className="flex items-center gap-2 text-[11.5px]">
                      {rule
                        ? <span className={`w-2 h-2 rounded-full shrink-0 ${COLOR_DOT[rule.color]}`} title={`Rule: ${rule.name}`} />
                        : <MessageSquare className="w-3 h-3 text-t-ink5 shrink-0" />
                      }
                      <span className="text-t-ink2 font-mono truncate flex-1">{idShort}</span>
                      {isRef && <span className="text-[9px] uppercase tracking-wider text-accent font-bold shrink-0">REF</span>}
                      <span className="text-t-ink5 font-mono shrink-0">{fmtTimestamp(msg.timestamp)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10.5px] pl-5">
                      {/* Queue chip — only show when multiple queues are subscribed */}
                      {queues.length > 1 && (
                        <span className="px-1 rounded-md bg-accent/15 text-accent font-mono font-medium" title={`From queue: ${msg.queue}`}>
                          {msg.queue}
                        </span>
                      )}
                      <span className="px-1 rounded-md bg-t-hover text-t-ink3 font-mono">{ct}</span>
                      <span className="text-t-ink5 font-mono">{fmtBytes(msg.meta.body_size)}</span>
                      {msg.meta.priority !== null && msg.meta.priority !== 4 && (
                        <span className="text-t-ink4 font-mono">P{msg.meta.priority}</span>
                      )}
                      {msg.meta.reply_to && (
                        <span className="text-t-ink4 font-mono truncate" title={`reply-to: ${msg.meta.reply_to}`}>
                          ↩ {msg.meta.reply_to}
                        </span>
                      )}
                      {rule && (
                        <span className="ml-auto text-[10.5px] font-medium uppercase tracking-wider text-t-ink3"
                          title={`Rule: ${rule.name} — pattern /${rule.pattern}/`}>
                          {rule.name}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
              <div ref={listEndRef} />
            </div>
          )}
        </div>

        {/* ─── RIGHT: PREVIEW ─── */}
        {selected && (
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            <div className="shrink-0 px-3 py-1.5 border-b border-t-line bg-t-panel flex items-center gap-2">
              <MessageSquare className="w-3.5 h-3.5 text-t-ink4 shrink-0" />
              <span className="text-[12.5px] text-t-ink font-mono truncate" title={selected.meta.message_id ?? ""}>
                {selected.meta.message_id ?? "(no message-id)"}
              </span>
              <span className="text-[11.5px] text-t-ink5 font-mono shrink-0">{fmtTimestamp(selected.timestamp)}</span>
              <span className="text-[10.5px] px-1 py-0.5 rounded-md bg-accent/15 text-accent font-mono shrink-0" title={`Queue: ${selected.queue}`}>
                {selected.queue}
              </span>

              <div className="ml-auto flex items-center gap-1">
                {/* Diff: mark as ref OR compare to ref */}
                {refMsg && refMsg.id !== selected.id ? (
                  <button
                    onClick={() => setDiffOpen(true)}
                    title={`Compare to '${refMsg.meta.message_id ?? "ref"}'`}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] font-medium text-accent hover:bg-accent/10 transition-colors"
                  >
                    <GitCompare className="w-3 h-3" /> Diff
                  </button>
                ) : (
                  <button
                    onClick={() => setRefId(refId === selected.id ? null : selected.id)}
                    title={refId === selected.id ? "Clear reference" : "Mark as comparison reference"}
                    className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] font-medium transition-colors ${
                      refId === selected.id ? "text-accent bg-accent/10" : "text-t-ink4 hover:text-t-ink hover:bg-t-hover"
                    }`}
                  >
                    <GitCompare className="w-3 h-3" /> {refId === selected.id ? "Ref ✓" : "Ref"}
                  </button>
                )}

                {selected.meta.reply_to && onReply && (
                  <button
                    onClick={() => handleReply(selected)}
                    title={`Send a reply to '${selected.meta.reply_to}'${selected.meta.correlation_id ? ` (correlation-id: ${selected.meta.correlation_id})` : ""}`}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] font-medium text-accent hover:bg-accent/10 transition-colors"
                  >
                    <CornerUpLeft className="w-3 h-3" /> Reply
                  </button>
                )}
                {/* Top-level Copy button removed — there's already a Copy
                    action inside the Body section header that copies the
                    same content. Two buttons in arm's reach were redundant. */}
                <button
                  onClick={() => setSelectedId(null)}
                  title="Close preview"
                  className="p-1 rounded-md text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              <PreviewDetails msg={selected} bodyMode={bodyMode} setBodyMode={setBodyMode} onLog={onLog} />
            </div>
          </div>
        )}
      </div>

      {rulesOpen && (
        <RulesModal
          rules={rules}
          onChange={setRules}
          onClose={() => setRulesOpen(false)}
        />
      )}

      {diffOpen && refMsg && selected && (
        <DiffModal
          left={refMsg}
          right={selected}
          onClose={() => setDiffOpen(false)}
        />
      )}

      {/* ─── REPLAY MODAL ─── */}
      {replayOpen && (
        <ReplayModal
          connected={connected}
          activeProfile={activeProfile}
          onLog={onLog}
          onClose={() => setReplayOpen(false)}
        />
      )}

      {/* ─── SAVE RECORDING MODAL ─── */}
      {recordSaveOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setRecordSaveOpen(false)}
        >
          <div onClick={e => e.stopPropagation()}
            className="bg-t-bg border border-t-line rounded-xl shadow-2xl w-[440px] max-w-[90vw] flex flex-col overflow-hidden">
            <div className="shrink-0 px-4 py-2.5 border-b border-t-line bg-t-panel flex items-center gap-2">
              <Save className="w-3.5 h-3.5 text-accent" />
              <span className="text-[13px] font-semibold text-t-ink">Save recording</span>
              <button onClick={() => setRecordSaveOpen(false)}
                className="ml-auto p-1 rounded-md hover:bg-t-hover text-t-ink4 hover:text-t-ink">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="px-4 py-3 space-y-2 text-[13px] text-t-ink2">
              <p>
                Save the {recordCount} captured message{recordCount === 1 ? "" : "s"} as a
                recording — replayable later from the History view.
              </p>
              <input
                autoFocus
                value={recordSaveName}
                onChange={e => setRecordSaveName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && recordSaveName.trim()) saveRecording(recordSaveName);
                  if (e.key === "Escape") setRecordSaveOpen(false);
                }}
                placeholder="recording name"
                className="w-full bg-t-field border border-t-line2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-t-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-all"
              />
              <p className="text-[10.5px] text-t-ink5">
                Stored as <span className="font-mono">~/.amqpush/recordings/{recordSaveName.trim() || "<name>"}.json</span>.
                Existing files with the same name are overwritten.
              </p>
            </div>
            <div className="shrink-0 px-3 py-2 border-t border-t-line bg-t-panel flex items-center justify-end gap-2">
              <button onClick={() => setRecordSaveOpen(false)}
                className="px-3 py-1 rounded-lg text-[11.5px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors">
                Cancel
              </button>
              <button
                onClick={() => saveRecording(recordSaveName)}
                disabled={!recordSaveName.trim()}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-accent hover:bg-accent-strong text-white text-[11.5px] font-semibold transition-colors disabled:opacity-40"
              >
                <Save className="w-3 h-3" /> Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function PreviewDetails({ msg, bodyMode, setBodyMode, onLog }: {
  msg: ReceivedMessage;
  bodyMode: "auto" | "raw" | "hex";
  setBodyMode: (m: "auto" | "raw" | "hex") => void;
  onLog: (k: "info" | "ok" | "err", t: string) => void;
}) {
  const [propsOpen, setPropsOpen] = useState(true);
  const [appOpen,   setAppOpen]   = useState(true);
  const [bodyOpen,  setBodyOpen]  = useState(true);

  const meta = msg.meta;
  // Sort alphabetically for stable display — Rust's HashMap iteration order
  // is non-deterministic, so without this the same message can show its
  // application properties in different orders on each render.
  const appProps = Object.entries(meta.application_properties)
    .sort(([a], [b]) => a.localeCompare(b));

  const detected = detectFormat({ contentType: meta.content_type, bodyText: meta.body_text });
  const bodyContent = (() => {
    const raw = meta.body_text ?? "";
    if (!raw) return null;
    if (bodyMode === "hex") return hexDump(raw);
    if (bodyMode === "raw") return raw;
    if (detected === "json") return tryPrettyJson(raw) ?? raw;
    if (detected === "xml")  return tryPrettyXml(raw)  ?? raw;
    return raw;
  })();

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[11.5px] flex-wrap">
        <span className="text-[10.5px] px-1.5 py-0.5 rounded-md bg-t-hover text-t-ink3 font-medium uppercase">{meta.body_kind}</span>
        <span className="text-t-ink5 font-mono">{fmtBytes(meta.body_size)}</span>
        {meta.delivery_count > 0 && (
          <span className="text-t-ink4" title="Delivery count">↻ {meta.delivery_count}</span>
        )}
        {meta.priority !== null && meta.priority !== 4 && (
          <span className="text-t-ink4">P{meta.priority}</span>
        )}
        {meta.durable && <span className="text-accent">durable</span>}
      </div>

      <CollapsibleSection
        title="Properties"
        icon={<Tag className="w-3 h-3" />}
        open={propsOpen}
        onToggle={() => setPropsOpen(o => !o)}
      >
        <PropsList onLog={onLog} items={[
          ["message-id",        meta.message_id],
          ["correlation-id",    meta.correlation_id],
          ["reply-to",          meta.reply_to],
          ["to",                meta.to],
          ["subject",           meta.subject],
          ["content-type",      meta.content_type],
          ["content-encoding",  meta.content_encoding],
          ["user-id",           meta.user_id],
          ["group-id",          meta.group_id],
          ["group-sequence",    meta.group_sequence?.toString() ?? null],
          ["reply-to-group-id", meta.reply_to_group_id],
          ["creation-time",     meta.creation_time ? new Date(meta.creation_time).toISOString() : null],
          ["absolute-expiry",   meta.absolute_expiry_time ? new Date(meta.absolute_expiry_time).toISOString() : null],
          ["priority",          meta.priority?.toString() ?? null],
          ["durable",           meta.durable?.toString() ?? null],
          ["ttl-ms",            meta.ttl_ms?.toString() ?? null],
          ["delivery-count",    meta.delivery_count.toString()],
        ]} />
      </CollapsibleSection>

      {appProps.length > 0 && (
        <CollapsibleSection
          title={`Application Properties (${appProps.length})`}
          icon={<Tag className="w-3 h-3" />}
          open={appOpen}
          onToggle={() => setAppOpen(o => !o)}
        >
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
            <div className="flex items-center bg-t-card border border-t-line rounded-md overflow-hidden">
              {(["auto", "raw", "hex"] as const).map(m => (
                <button
                  key={m}
                  onClick={(e) => { e.stopPropagation(); setBodyMode(m); }}
                  className={`px-1.5 py-0.5 text-[10.5px] font-mono transition-colors ${
                    bodyMode === m ? "bg-accent/15 text-accent" : "text-t-ink4 hover:text-t-ink2 hover:bg-t-hover"
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
            {meta.body_text && (
              <CopyButton
                value={meta.body_text}
                onCopied={() => onLog("info", "Body copied")}
                label="Copy"
                className="flex items-center gap-1 text-[10.5px] text-t-ink4 hover:text-t-ink2 transition-colors px-1.5 py-0.5 rounded-md hover:bg-t-hover"
              />
            )}
          </div>
        }
      >
        <pre className="text-[11.5px] text-t-ink2 font-mono bg-t-field border border-t-line rounded-lg p-2.5 overflow-x-auto whitespace-pre break-all max-h-80 overflow-y-auto select-text">
          {bodyContent ?? <em className="text-t-ink5">no body</em>}
        </pre>
        {msg.is_truncated && (
          <p className="text-[10.5px] text-caution mt-1">⚠ Truncated for list display.</p>
        )}
      </CollapsibleSection>
    </div>
  );
}

// ── highlight rules modal ───────────────────────────────────────────────────

function RulesModal({ rules, onChange, onClose }: {
  rules: HighlightRule[];
  onChange: (r: HighlightRule[]) => void;
  onClose: () => void;
}) {
  function update(id: string, patch: Partial<HighlightRule>) {
    onChange(rules.map(r => r.id === id ? { ...r, ...patch } : r));
  }
  function remove(id: string) {
    onChange(rules.filter(r => r.id !== id));
  }
  function add() {
    const id = `r-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    onChange([...rules, { id, name: "New rule", pattern: "", color: "blue", enabled: true }]);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="bg-t-bg border border-t-line rounded-xl shadow-2xl w-[560px] max-w-[90vw] max-h-[80vh] flex flex-col overflow-hidden">

        <div className="shrink-0 px-4 py-2.5 border-b border-t-line bg-t-panel flex items-center gap-2">
          <Palette className="w-3.5 h-3.5 text-t-ink4" />
          <span className="text-[13px] font-semibold text-t-ink">Highlight rules</span>
          <span className="text-[11.5px] text-t-ink5">— colour-tag matching messages in the list</span>
          <button onClick={onClose} className="ml-auto p-1 rounded-md hover:bg-t-hover text-t-ink4 hover:text-t-ink">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[120px]">
          {rules.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-t-ink5 py-8">
              <Edit3 className="w-7 h-7 opacity-40 mb-3" />
              <p className="text-[13px]">No rules defined</p>
              <p className="text-[11.5px] mt-1">Each rule paints matching messages with its colour</p>
              <button onClick={add}
                className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-strong hover:bg-accent text-white text-[11.5px] font-medium">
                <Plus className="w-3 h-3" /> Add first rule
              </button>
            </div>
          ) : (
            rules.map(r => {
              let regexErr = "";
              if (r.enabled && r.pattern.trim()) {
                try { new RegExp(r.pattern); } catch (e) { regexErr = String(e).replace(/^SyntaxError:\s*/, ""); }
              }
              return (
                <div key={r.id} className={`border rounded-lg p-2 bg-t-card/40 transition-colors ${
                  regexErr ? "border-negative/40" : "border-t-line"
                }`}>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={e => update(r.id, { enabled: e.target.checked })}
                      className="w-3.5 h-3.5 accent-accent-strong cursor-pointer"
                    />
                    <input
                      value={r.name}
                      onChange={e => update(r.id, { name: e.target.value })}
                      placeholder="Rule name"
                      className="bg-transparent text-[12.5px] text-t-ink outline-none placeholder:text-t-ink5 px-1.5 py-1 rounded-md hover:bg-t-card focus:bg-t-field focus:ring-1 focus:ring-accent/30 flex-1 font-medium"
                    />
                    <div className="flex items-center gap-0.5 shrink-0">
                      {HIGHLIGHT_COLORS.map(c => (
                        <button key={c}
                          onClick={() => update(r.id, { color: c })}
                          title={c}
                          className={`w-4 h-4 rounded-full transition-all ${COLOR_DOT[c]} ${
                            r.color === c ? "ring-2 ring-offset-1 ring-offset-t-bg ring-accent scale-110" : "opacity-60 hover:opacity-100"
                          }`} />
                      ))}
                    </div>
                    <button onClick={() => remove(r.id)}
                      className="p-1 text-t-ink5 hover:text-negative transition-colors rounded-md">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="mt-1.5 pl-6">
                    <input
                      value={r.pattern}
                      onChange={e => update(r.id, { pattern: e.target.value })}
                      placeholder="Regex pattern (case-insensitive) — matches body / queue / id / content-type / app-property values"
                      className="w-full bg-t-field border border-t-line2 rounded-lg px-2 py-1 text-[11.5px] text-t-ink font-mono outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
                    />
                    {regexErr && <p className="text-[10.5px] text-negative mt-1 font-mono">⚠ {regexErr}</p>}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="shrink-0 px-3 py-2 border-t border-t-line bg-t-panel flex items-center gap-2">
          {rules.length > 0 && (
            <button onClick={add}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] font-medium text-t-ink3 hover:text-t-ink hover:bg-t-hover transition-colors">
              <Plus className="w-3 h-3" /> Add rule
            </button>
          )}
          <span className="ml-auto text-[10.5px] text-t-ink5">Saved automatically</span>
          <button onClick={onClose}
            className="px-3 py-1 rounded-lg bg-accent-strong hover:bg-accent text-white text-[11.5px] font-medium">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ── diff modal ──────────────────────────────────────────────────────────────
// (diffLines is shared with HistoryView's compare flow — see utils/diff.ts)

function DiffModal({ left, right, onClose }: { left: ReceivedMessage; right: ReceivedMessage; onClose: () => void }) {
  // Properties diff — collect union of keys, mark equal/different/only-left/only-right
  const allKeys = useMemo(() => {
    const std = [
      "message-id", "correlation-id", "reply-to", "to", "subject", "content-type",
      "content-encoding", "user-id", "group-id", "group-sequence",
      "reply-to-group-id", "creation-time", "absolute-expiry", "priority",
      "durable", "ttl-ms", "delivery-count",
    ];
    const appKeys = new Set([
      ...Object.keys(left.meta.application_properties),
      ...Object.keys(right.meta.application_properties),
    ]);
    return { std, app: Array.from(appKeys).sort() };
  }, [left, right]);

  function stdProp(m: ReceivedMessage, k: string): string {
    const x = m.meta as any;
    switch (k) {
      case "message-id":        return x.message_id ?? "";
      case "correlation-id":    return x.correlation_id ?? "";
      case "reply-to":          return x.reply_to ?? "";
      case "to":                return x.to ?? "";
      case "subject":           return x.subject ?? "";
      case "content-type":      return x.content_type ?? "";
      case "content-encoding":  return x.content_encoding ?? "";
      case "user-id":           return x.user_id ?? "";
      case "group-id":          return x.group_id ?? "";
      case "group-sequence":    return x.group_sequence?.toString() ?? "";
      case "reply-to-group-id": return x.reply_to_group_id ?? "";
      case "creation-time":     return x.creation_time ? new Date(x.creation_time).toISOString() : "";
      case "absolute-expiry":   return x.absolute_expiry_time ? new Date(x.absolute_expiry_time).toISOString() : "";
      case "priority":          return x.priority?.toString() ?? "";
      case "durable":           return x.durable?.toString() ?? "";
      case "ttl-ms":            return x.ttl_ms?.toString() ?? "";
      case "delivery-count":    return x.delivery_count.toString();
      default:                  return "";
    }
  }

  // Body diff — try pretty-format both to align json/xml structure better
  const fmt = (m: ReceivedMessage) => {
    const raw = m.meta.body_text ?? "";
    const fmtType = detectFormat({ contentType: m.meta.content_type, bodyText: m.meta.body_text });
    if (fmtType === "json") return tryPrettyJson(raw) ?? raw;
    if (fmtType === "xml")  return tryPrettyXml(raw)  ?? raw;
    return raw;
  };
  const leftFmt  = fmt(left);
  const rightFmt = fmt(right);
  const ops = useMemo(() => diffLines(leftFmt, rightFmt), [leftFmt, rightFmt]);

  // Counts
  const propDiffCount = (() => {
    let n = 0;
    for (const k of allKeys.std) { if (stdProp(left, k) !== stdProp(right, k)) n++; }
    for (const k of allKeys.app) {
      const lv = left.meta.application_properties[k]  ?? "";
      const rv = right.meta.application_properties[k] ?? "";
      if (lv !== rv) n++;
    }
    return n;
  })();
  const bodyDiffCount = ops.filter(o => o.kind !== "eq").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="bg-t-bg border border-t-line rounded-xl shadow-2xl w-[1040px] max-w-[95vw] max-h-[90vh] flex flex-col overflow-hidden">

        <div className="shrink-0 px-4 py-2.5 border-b border-t-line bg-t-panel flex items-center gap-2">
          <GitCompare className="w-3.5 h-3.5 text-t-ink4" />
          <span className="text-[13px] font-semibold text-t-ink">Compare messages</span>
          <span className="text-[11.5px] text-t-ink5">— {propDiffCount} property difference{propDiffCount !== 1 ? "s" : ""}, {bodyDiffCount} body line{bodyDiffCount !== 1 ? "s" : ""} differ</span>
          <button onClick={onClose} className="ml-auto p-1 rounded-md hover:bg-t-hover text-t-ink4 hover:text-t-ink">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Side-by-side headers */}
        <div className="shrink-0 grid grid-cols-2 gap-px bg-t-line border-b border-t-line">
          <div className="bg-t-panel px-3 py-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] uppercase tracking-wider text-accent font-bold">Reference</span>
              <span className="text-[11.5px] font-mono text-t-ink2 truncate">{left.meta.message_id ?? "(no id)"}</span>
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-[10.5px] text-t-ink5 font-mono">
              <span>{left.queue}</span>
              <span>{fmtTimestamp(left.timestamp)}</span>
              <span>{fmtBytes(left.meta.body_size)}</span>
            </div>
          </div>
          <div className="bg-t-panel px-3 py-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] uppercase tracking-wider text-caution font-bold">Selected</span>
              <span className="text-[11.5px] font-mono text-t-ink2 truncate">{right.meta.message_id ?? "(no id)"}</span>
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-[10.5px] text-t-ink5 font-mono">
              <span>{right.queue}</span>
              <span>{fmtTimestamp(right.timestamp)}</span>
              <span>{fmtBytes(right.meta.body_size)}</span>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">

          {/* Properties diff */}
          <div className="px-3 py-2">
            <p className="text-[10.5px] uppercase tracking-wider text-t-ink4 font-semibold mb-1.5">Properties</p>
            <div className="font-mono text-[11.5px] space-y-px">
              {allKeys.std.map(k => {
                const lv = stdProp(left, k);
                const rv = stdProp(right, k);
                if (!lv && !rv) return null;
                const same = lv === rv;
                return (
                  <div key={k} className={`grid grid-cols-[120px_1fr_1fr] gap-2 py-0.5 px-1 rounded-md ${
                    same ? "" : "bg-caution/5"
                  }`}>
                    <span className="text-t-ink4">{k}</span>
                    <span className={`break-all ${same ? "text-t-ink3" : "text-accent"}`}>{lv || <em className="text-t-ink5">—</em>}</span>
                    <span className={`break-all ${same ? "text-t-ink3" : "text-caution"}`}>{rv || <em className="text-t-ink5">—</em>}</span>
                  </div>
                );
              })}
              {allKeys.app.length > 0 && (
                <p className="text-[10.5px] uppercase tracking-wider text-t-ink4 font-semibold mt-3 mb-1.5">Application properties</p>
              )}
              {allKeys.app.map(k => {
                const lv = left.meta.application_properties[k]  ?? "";
                const rv = right.meta.application_properties[k] ?? "";
                const same = lv === rv;
                return (
                  <div key={k} className={`grid grid-cols-[120px_1fr_1fr] gap-2 py-0.5 px-1 rounded-md ${
                    same ? "" : "bg-caution/5"
                  }`}>
                    <span className="text-t-ink4 truncate">{k}</span>
                    <span className={`break-all ${same ? "text-t-ink3" : "text-accent"}`}>{lv || <em className="text-t-ink5">—</em>}</span>
                    <span className={`break-all ${same ? "text-t-ink3" : "text-caution"}`}>{rv || <em className="text-t-ink5">—</em>}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Body diff */}
          <div className="px-3 pb-3">
            <p className="text-[10.5px] uppercase tracking-wider text-t-ink4 font-semibold mb-1.5">Body (line diff, formatted)</p>
            <div className="font-mono text-[11.5px] bg-t-field border border-t-line rounded-lg overflow-x-auto select-text">
              {ops.length === 0 ? (
                <p className="p-3 text-t-ink5 italic">Both bodies are empty</p>
              ) : (
                ops.map((o, i) => {
                  const cls =
                    o.kind === "eq"  ? "text-t-ink3" :
                    o.kind === "del" ? "bg-accent/15  text-accent-content border-l-2 border-accent" :
                                       "bg-caution/15 text-caution border-l-2 border-caution";
                  const prefix = o.kind === "eq" ? "  " : o.kind === "del" ? "− " : "+ ";
                  const text = o.kind === "del" ? o.left : o.kind === "add" ? o.right : o.left;
                  return (
                    <div key={i} className={`px-2 whitespace-pre ${cls}`}>
                      <span className="text-t-ink5">{prefix}</span>{text}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="shrink-0 px-3 py-2 border-t border-t-line bg-t-panel flex items-center justify-end gap-2">
          <button onClick={onClose}
            className="px-3 py-1 rounded-lg bg-accent-strong hover:bg-accent text-white text-[11.5px] font-medium">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface RecordingSummary {
  name: string;
  source_queue: string;
  started_at_ms: number;
  message_count: number;
  bytes: number;
}

/**
 * Replay modal. Two-pane: a recordings list on the left (loaded from the
 * `~/.amqpush/recordings/` directory via `list_recordings`), and a target /
 * speed picker on the right. Click Play and the backend walks the captured
 * messages, calling `send_message` for each with delays scaled by the speed
 * multiplier. Progress updates arrive via the `replay_progress` event.
 *
 * Source messages aren't modified; replay is a peek-and-republish pattern.
 */
function ReplayModal({ connected, activeProfile, onLog, onClose }: {
  connected: boolean;
  activeProfile?: string;
  onLog: (kind: "info" | "ok" | "err", text: string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<RecordingSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [speed, setSpeed] = useState("1");
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState<{ step: number; total: number } | null>(null);

  async function refresh() {
    try {
      const list = await invoke<RecordingSummary[]>("list_recordings");
      setItems(list);
      if (!selected && list.length > 0) setSelected(list[0].name);
    } catch (e) {
      onLog("err", `List recordings: ${e}`);
    }
  }

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    if (!selected) return;
    const hit = items.find(r => r.name === selected);
    if (hit && !target) setTarget(hit.source_queue);
  }, [selected, items]);

  useEffect(() => {
    if (!playing) return;
    let unlisten: (() => void) | undefined;
    listen<{ step: number; total: number; ok: boolean; error?: string }>("replay_progress", e => {
      setProgress({ step: e.payload.step, total: e.payload.total });
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, [playing]);

  async function play() {
    if (!selected) return;
    const t = target.trim();
    if (!t) { onLog("err", "Target queue is required"); return; }
    const sp = Math.max(0, Number(speed) || 1);
    setPlaying(true);
    setProgress({ step: 0, total: 0 });
    try {
      await invoke("play_recording", { name: selected, target: t, speed: sp });
      onLog("ok", `Replayed '${selected}' → ${t}`);
      setProgress(null);
      setPlaying(false);
    } catch (e) {
      onLog("err", `Replay failed: ${e}`);
      setPlaying(false);
      setProgress(null);
    }
  }

  async function deleteSelected() {
    if (!selected) return;
    try {
      await invoke("delete_recording", { name: selected });
      onLog("info", `Deleted recording '${selected}'`);
      setSelected(null);
      await refresh();
    } catch (e) {
      onLog("err", `Delete recording: ${e}`);
    }
  }

  const sel = items.find(r => r.name === selected) || null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="bg-t-bg border border-t-line rounded-xl shadow-2xl w-[760px] max-w-[95vw] h-[480px] flex flex-col overflow-hidden">

        <div className="shrink-0 px-4 py-2.5 border-b border-t-line bg-t-panel flex items-center gap-2">
          <Play className="w-3.5 h-3.5 text-accent" />
          <span className="text-[13px] font-semibold text-t-ink">Replay recording</span>
          <span className="text-[11.5px] text-t-ink5 font-mono">{items.length}</span>
          <button onClick={onClose} className="ml-auto p-1 rounded-md hover:bg-t-hover text-t-ink4 hover:text-t-ink">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 flex min-h-0 overflow-hidden">
          <div className="w-[45%] border-r border-t-line overflow-y-auto">
            {items.length === 0 ? (
              <EmptyState
                icon={<Database className="w-8 h-8" />}
                title="No recordings yet"
                subtitle="Start a subscription, click REC, then Save…"
              />
            ) : items.map(r => {
              const isSel = selected === r.name;
              return (
                <button key={r.name} onClick={() => setSelected(r.name)}
                  className={`w-full text-left px-3 py-2 border-b border-t-line/40 transition-colors ${
                    isSel ? "bg-accent/10" : "hover:bg-t-hover/50"
                  }`}>
                  <div className="text-[12.5px] font-medium text-t-ink truncate">{r.name}</div>
                  <div className="flex items-center gap-2 text-[10.5px] text-t-ink5 font-mono mt-0.5">
                    <span>{r.message_count} msg</span>
                    <span>·</span>
                    <span>{fmtBytes(r.bytes)}</span>
                    {r.source_queue && <><span>·</span><span className="truncate">{r.source_queue}</span></>}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            {sel ? (
              <div className="flex-1 overflow-auto px-4 py-3 space-y-3">
                <div>
                  <div className="text-[10.5px] font-semibold text-t-ink4 uppercase tracking-wider mb-1">Recording</div>
                  <div className="text-[13px] text-t-ink font-mono truncate">{sel.name}</div>
                  <div className="text-[11.5px] text-t-ink5 mt-0.5">
                    {sel.message_count} message{sel.message_count === 1 ? "" : "s"} · {fmtBytes(sel.bytes)}
                    {sel.source_queue && <> · captured from <span className="font-mono text-t-ink4">{sel.source_queue}</span></>}
                  </div>
                </div>

                <div>
                  <label className="block text-[10.5px] font-semibold text-t-ink4 uppercase tracking-wider mb-1">Target queue</label>
                  <QueuePicker value={target} onChange={setTarget} connected={connected} profileName={activeProfile} />
                </div>

                <div>
                  <label className="block text-[10.5px] font-semibold text-t-ink4 uppercase tracking-wider mb-1">
                    Speed
                    <span className="text-t-ink5 normal-case font-normal"> — 1 = real-time, 0 = max speed (no delays)</span>
                  </label>
                  <div className="flex items-center gap-1">
                    {["0.5", "1", "2", "5", "0"].map(s => (
                      <button key={s} type="button"
                        onClick={() => setSpeed(s)}
                        className={`px-2 py-1 rounded-md text-[11.5px] font-mono transition-colors ${
                          speed === s ? "bg-accent/15 text-accent" : "text-t-ink4 hover:text-t-ink2 hover:bg-t-hover"
                        }`}>
                        {s === "0" ? "max" : `${s}×`}
                      </button>
                    ))}
                    <input type="number" min="0" step="0.1" value={speed}
                      onChange={e => setSpeed(e.target.value)}
                      className="w-20 bg-t-field border border-t-line2 rounded-md px-2 py-0.5 text-[11.5px] text-t-ink outline-none focus:border-accent ml-auto" />
                  </div>
                </div>

                {progress && (
                  <div>
                    <div className="text-[10.5px] text-t-ink5 font-mono mb-1">
                      {progress.step} / {progress.total}
                    </div>
                    <div className="h-1 bg-t-card rounded-md overflow-hidden">
                      <div className="h-full bg-accent transition-all"
                        style={{ width: progress.total > 0 ? `${(progress.step / progress.total) * 100}%` : "0%" }} />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              // Default panel — short explainer of how Replay works so a
              // first-time user understands what they're configuring.
              <div className="flex-1 flex flex-col items-center justify-center px-6 text-[12.5px] text-t-ink4 space-y-2 max-w-md mx-auto text-center">
                <Play className="w-7 h-7 text-t-ink5 mb-1" />
                <p className="text-t-ink2 font-medium">How Replay works</p>
                <p>
                  Pick a saved recording on the left → choose a <b>target queue</b>{" "}
                  on the broker you're currently connected to → pick a{" "}
                  <b>speed multiplier</b> → <b>Play</b>.
                </p>
                <p className="text-t-ink5 leading-relaxed">
                  AMQPush walks the file message-by-message, re-sends each one
                  to the target with delays scaled by the speed
                  (<span className="font-mono text-t-ink4">1×</span> = real-time,{" "}
                  <span className="font-mono text-t-ink4">0</span> = no delays
                  at all). The recording file is untouched; consumers on the
                  target queue receive the messages just like a live producer
                  was publishing them.
                </p>
                <p className="text-t-ink5">
                  Make a recording first: subscribe in Receive, click{" "}
                  <b>REC</b>, then <b>Save…</b>.
                </p>
              </div>
            )}

            <div className="shrink-0 px-3 py-2 border-t border-t-line bg-t-panel flex items-center gap-2">
              {sel && (
                <button onClick={deleteSelected} disabled={playing}
                  title="Delete this recording from disk"
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] font-medium text-t-ink4 hover:text-negative hover:bg-negative/10 transition-colors disabled:opacity-40">
                  <Trash2 className="w-3 h-3" /> Delete
                </button>
              )}
              <button onClick={onClose} disabled={playing}
                className="ml-auto px-3 py-1 rounded-lg text-[11.5px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors disabled:opacity-40">
                Close
              </button>
              <button onClick={play}
                disabled={!sel || playing || !target.trim() || !connected}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-accent hover:bg-accent-strong text-white text-[11.5px] font-semibold transition-colors disabled:opacity-40">
                {playing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                {playing ? "Replaying…" : "Play"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
