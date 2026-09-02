/**
 * Inspector view — "who's connected to the broker right now?".
 *
 * Two side-by-side panes:
 *   LEFT  — list of active client connections (host, user, protocol, age).
 *   RIGHT — consumers belonging to the selected connection (queue, address,
 *           credit currently outstanding, last-delivered / last-acked, age).
 *
 * Backed by two Artemis management RPCs:
 *   `list_broker_connections` → `listConnectionsAsJSON`
 *   `list_broker_consumers`   → `listAllConsumersAsJSON`
 *
 * Polls every 3 s while the view is visible. Survives transient broker
 * errors gracefully — the prior snapshot stays on screen until the next
 * successful refresh.
 *
 * Used by Operational Visibility (1.4.0). Same `list_broker_consumers`
 * RPC powers the "who holds this message?" drill-down on the Browser's
 * peek pane.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Network, RotateCcw, Loader2, Users, Search, X, Plug, Inbox, Code, Info,
  ChevronRight, ChevronDown,
} from "lucide-react";
import EmptyState from "../EmptyState";
import { useAmqpText } from "../../i18n";
import ViewTopBar from "../ViewTopBar";
import { fmtDuration } from "../../utils/format";
import type { BrokerConnection, BrokerConsumer } from "../../types";

const POLL_INTERVAL_MS = 3000;

interface Props {
  connected: boolean;
  visible: boolean;
  onLog: (kind: "info" | "ok" | "err", msg: string) => void;
}

/** "12s ago" / "5m ago" / "1h 02m ago" — coarsened relative timestamp. */
function fmtAgo(ms: number, now: number): string {
  if (!ms || ms <= 0) return "—";
  const delta = Math.max(0, now - ms);
  return `${fmtDuration(delta)} ago`;
}

/**
 * Strip the `:port` suffix from `host:port` / `[ipv6]:port` so connections
 * that share the same machine but use different ephemeral ports group
 * under one host header.
 */
function extractHost(addr: string): string {
  if (!addr) return "(unknown)";
  // IPv6 with brackets: [::1]:5672 → [::1]
  if (addr.startsWith("[")) {
    const i = addr.lastIndexOf("]:");
    if (i >= 0) return addr.slice(0, i + 1);
  }
  const i = addr.lastIndexOf(":");
  return i > 0 ? addr.slice(0, i) : addr;
}

/** Drop the `[…]` brackets around Artemis's address representation. */
function cleanAddress(a: string): string {
  if (!a) return "";
  if (a.startsWith("[") && a.endsWith("]")) return a.slice(1, -1);
  return a;
}

/** UUID v4 pattern — Artemis assigns UUID names to dynamic-source receivers
 *  (used by AMQPush itself for management RPC, request/reply, and the
 *  notifications drainer). Those consumers exist on the broker but represent
 *  AMQPush internals rather than real user subscribers, so the inspector
 *  hides them with a count-of-hidden footer. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isInternalConsumer(k: { queue: string; address: string }): boolean {
  const q = k.queue || "";
  const a = (k.address || "").replace(/^\[|\]$/g, "");
  if (UUID_RE.test(q) || UUID_RE.test(a)) return true;
  if (q.startsWith("activemq.") || q.startsWith("$sys.") || q.startsWith("$.artemis.")) return true;
  if (a.startsWith("activemq.") || a.startsWith("$sys.") || a.startsWith("$.artemis.")) return true;
  return false;
}

export default function InspectorView({ connected, visible, onLog }: Props) {
  const t = useAmqpText();
  const [conns, setConns] = useState<BrokerConnection[]>([]);
  const [cons, setCons] = useState<BrokerConsumer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [autoOn, setAutoOn] = useState(true);
  // re-render the "ago" timestamps every second so they don't go stale.
  const [now, setNow] = useState(Date.now());
  // Raw JSON debug overlay — toggled from the top bar. Surfaces exactly
  // what the broker returned so users can diagnose field-name mismatches
  // across Artemis versions.
  const [showRaw, setShowRaw] = useState(false);
  const [rawConns, setRawConns] = useState<string>("");
  const [rawCons, setRawCons] = useState<string>("");
  const [rawLoading, setRawLoading] = useState(false);
  const [rawErr, setRawErr] = useState<string | null>(null);

  async function loadRaw() {
    setRawLoading(true);
    setRawErr(null);
    try {
      const [c, k] = await Promise.all([
        invoke<string>("fetch_broker_connections_raw"),
        invoke<string>("fetch_broker_consumers_raw"),
      ]);
      // Pretty-print for readability.
      const pretty = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
      setRawConns(pretty(c));
      setRawCons(pretty(k));
    } catch (e) {
      setRawErr(String(e));
    } finally {
      setRawLoading(false);
    }
  }

  function toggleRaw() {
    const next = !showRaw;
    setShowRaw(next);
    if (next && !rawConns && !rawCons) void loadRaw();
  }

  async function refresh(silent: boolean) {
    if (!connected) return;
    if (!silent) setLoading(true);
    try {
      const [cs, ks] = await Promise.all([
        invoke<BrokerConnection[]>("list_broker_connections"),
        invoke<BrokerConsumer[]>("list_broker_consumers"),
      ]);
      setConns(cs);
      setCons(ks);
      setErr(null);
      setLoaded(true);
    } catch (e) {
      const msg = String(e);
      setErr(msg);
      if (!silent) onLog("err", `Inspector: ${msg}`);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  // Initial load + auto-refresh when visible.
  useEffect(() => {
    if (!visible || !connected) return;
    refresh(false);
    if (!autoOn) return;
    const t = setInterval(() => refresh(true), POLL_INTERVAL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, connected, autoOn]);

  // 1 Hz tick so the relative timestamps refresh in place.
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [visible]);

  // Reset selection when disconnected so the right pane doesn't dangle.
  useEffect(() => {
    if (!connected) {
      setConns([]);
      setCons([]);
      setSelected(null);
      setLoaded(false);
    }
  }, [connected]);

  // Filter connections by search; "filter" matches user, host, protocol, id.
  const filteredConns = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conns;
    return conns.filter(c =>
      c.users.toLowerCase().includes(q)
      || c.client_address.toLowerCase().includes(q)
      || c.protocol.toLowerCase().includes(q)
      || c.connection_id.toLowerCase().includes(q),
    );
  }, [conns, search]);

  // Group filtered connections by client host (IP / hostname, port stripped).
  // Connections from the same machine with different ephemeral ports collapse
  // into one header row. Single-connection hosts are rendered flat — grouping
  // only makes sense when there's actually something to fold.
  const groupedConns = useMemo(() => {
    const m = new Map<string, BrokerConnection[]>();
    for (const c of filteredConns) {
      const host = extractHost(c.client_address);
      const arr = m.get(host) ?? [];
      arr.push(c);
      m.set(host, arr);
    }
    // Within each group, sort by port ascending so the order is stable.
    for (const [, arr] of m) {
      arr.sort((a, b) => {
        const portOf = (addr: string) => Number(addr.split(":").pop()) || 0;
        return portOf(a.client_address) - portOf(b.client_address);
      });
    }
    // Group ordering: biggest first, ties broken alphabetically by host.
    return [...m.entries()].sort((a, b) => {
      if (b[1].length !== a[1].length) return b[1].length - a[1].length;
      return a[0].localeCompare(b[0]);
    });
  }, [filteredConns]);

  // Set of hosts the user has collapsed. Default: every multi-connection host
  // is collapsed on first render — primary value of grouping is reducing visual
  // noise on shared-machine setups. Single-connection hosts have no header.
  const [collapsedHosts, setCollapsedHosts] = useState<Set<string>>(new Set());
  function toggleHost(host: string) {
    setCollapsedHosts(prev => {
      const next = new Set(prev);
      if (next.has(host)) next.delete(host); else next.add(host);
      return next;
    });
  }
  // Auto-collapse every multi-connection group the first time we see it,
  // so on first mount the view is compact. Tracked via a ref so a host the
  // user has explicitly expanded doesn't re-collapse on the next poll.
  const seenHostsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    setCollapsedHosts(prev => {
      const next = new Set(prev);
      for (const [host, arr] of groupedConns) {
        if (!seenHostsRef.current.has(host)) {
          seenHostsRef.current.add(host);
          if (arr.length > 1) next.add(host);
        }
      }
      return next;
    });
  }, [groupedConns]);

  // Show-internals toggle. Off by default — AMQPush spawns 2-3 of its own
  // dynamic-source receivers (management RPC, notif drainer, await-reply)
  // with UUID queue names, which are technically consumers on the broker
  // but visually noisy and not what most users came to debug.
  const [showInternal, setShowInternal] = useState(false);

  const visibleCons = useMemo(
    () => (showInternal ? cons : cons.filter(k => !isInternalConsumer(k))),
    [cons, showInternal],
  );
  const hiddenCount = cons.length - visibleCons.length;

  // Group visible consumers by connection_id for fast lookup + per-row count.
  const consByConn = useMemo(() => {
    const m = new Map<string, BrokerConsumer[]>();
    for (const k of visibleCons) {
      const arr = m.get(k.connection_id) ?? [];
      arr.push(k);
      m.set(k.connection_id, arr);
    }
    return m;
  }, [visibleCons]);

  const selectedConsumers = selected ? (consByConn.get(selected) ?? []) : [];

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-t-bg overflow-hidden">
      <ViewTopBar
        icon={<Network className="w-3.5 h-3.5" />}
        title={t("clients.title")}
        count={loaded && !err
          ? t("clients.count", { conns: conns.length, cons: visibleCons.length })
            + (hiddenCount > 0 && !showInternal ? t("clients.count.hidden", { count: hiddenCount }) : "")
          : undefined}
        status={
          connected && autoOn && loaded ? (
            <span className="flex items-center gap-1 text-[10.5px] text-t-ink5 font-mono" title={t("clients.auto.hint", { sec: POLL_INTERVAL_MS / 1000 })}>
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              {t("clients.live")}
            </span>
          ) : null
        }
      >
        <button
          onClick={() => setAutoOn(a => !a)}
          aria-pressed={autoOn}
          className={`text-[11.5px] transition-colors px-1.5 py-0.5 rounded-md ${
            autoOn ? "text-accent bg-accent/10" : "text-t-ink4 hover:text-t-ink3"
          }`}
          title={autoOn ? t("clients.auto.on") : t("clients.auto.off")}
        >
          {autoOn ? `● ${t("clients.auto")}` : `○ ${t("clients.auto")}`}
        </button>
        <button
          onClick={() => setShowInternal(s => !s)}
          aria-pressed={showInternal}
          disabled={!connected}
          className={`text-[11.5px] transition-colors px-1.5 py-0.5 rounded-md ${
            showInternal ? "text-caution bg-caution/10" : "text-t-ink4 hover:text-t-ink3"
          } disabled:opacity-40`}
          title={t("clients.internal.hint")}
        >
          {showInternal ? `● ${t("clients.internal")}` : `○ ${t("clients.internal")}`}
        </button>
        <button
          onClick={toggleRaw}
          aria-pressed={showRaw}
          disabled={!connected}
          className={`text-[11.5px] transition-colors px-1.5 py-0.5 rounded-md flex items-center gap-1 ${
            showRaw ? "text-accent bg-accent/10" : "text-t-ink4 hover:text-t-ink3"
          } disabled:opacity-40`}
          title={t("clients.raw.hint")}
        >
          <Code className="w-3 h-3" /> {t("clients.raw")}
        </button>
        <button
          onClick={() => refresh(false)}
          disabled={!connected || loading}
          className="h-7 px-2.5 rounded-lg text-[12px] font-medium text-t-ink4 hover:text-accent hover:bg-accent/10 transition-colors flex items-center gap-1 disabled:opacity-40"
        >
          <RotateCcw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} /> {t("clients.refresh")}
        </button>
      </ViewTopBar>

      {/* ─── INTRO HINT — shown until the user selects a connection ─── */}
      {connected && loaded && !selected && conns.length > 0 && (
        <div className="shrink-0 px-3 py-2 border-b border-t-line bg-accent/5 flex items-start gap-2 text-[11.5px]">
          <Info className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />
          <div className="text-t-ink2 leading-relaxed">{t("clients.intro")}</div>
        </div>
      )}

      {/* ─── FILTER BAR ─── */}
      {loaded && conns.length > 0 && (
        <div className="shrink-0 px-3 py-1 border-b border-t-line bg-t-panel flex items-center gap-2">
          <Search className="w-3.5 h-3.5 text-t-ink5 shrink-0" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t("clients.search")}
            className="flex-1 bg-transparent text-xs text-t-ink outline-none placeholder:text-t-ink5"
          />
          {search && (
            <button onClick={() => setSearch("")} className="text-t-ink5 hover:text-t-ink3 transition-colors">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      {/* ─── RAW DEBUG OVERLAY ─── */}
      {showRaw && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="shrink-0 px-3 py-2 border-b border-t-line bg-caution/5 flex items-start gap-2 text-[11.5px]">
            <Info className="w-3.5 h-3.5 text-caution shrink-0 mt-0.5" />
            <div className="text-t-ink2 leading-relaxed flex-1">
              <span className="text-caution font-medium">{t("clients.debug")}</span>{" "}
              {t("clients.debug.note")}
            </div>
            <button
              onClick={loadRaw}
              disabled={rawLoading}
              className="text-[11.5px] flex items-center gap-1 text-t-ink4 hover:text-accent transition-colors px-1.5 py-0.5 rounded-md hover:bg-accent/10 disabled:opacity-40"
            >
              <RotateCcw className={`w-3 h-3 ${rawLoading ? "animate-spin" : ""}`} /> Refresh
            </button>
          </div>
          {rawErr && (
            <div className="shrink-0 px-3 py-2 text-[11.5px] text-negative border-b border-t-line bg-negative/5">
              {rawErr}
            </div>
          )}
          <div className="flex-1 grid grid-cols-2 gap-px bg-t-line overflow-hidden min-h-0">
            <div className="flex flex-col bg-t-bg min-h-0 overflow-hidden">
              <div className="shrink-0 px-3 py-1.5 text-[10px] uppercase tracking-wide text-content-subtle bg-t-panel border-b border-t-line font-semibold">
                listConnectionsAsJSON
              </div>
              <pre className="flex-1 overflow-auto p-3 text-[11.5px] font-mono text-t-ink2 whitespace-pre">
                {rawLoading && !rawConns ? "Loading…" : rawConns || "(empty)"}
              </pre>
            </div>
            <div className="flex flex-col bg-t-bg min-h-0 overflow-hidden">
              <div className="shrink-0 px-3 py-1.5 text-[10px] uppercase tracking-wide text-content-subtle bg-t-panel border-b border-t-line font-semibold">
                listAllConsumersAsJSON
              </div>
              <pre className="flex-1 overflow-auto p-3 text-[11.5px] font-mono text-t-ink2 whitespace-pre">
                {rawLoading && !rawCons ? "Loading…" : rawCons || "(empty)"}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* ─── BODY: split — left connections / right consumers ─── */}
      {!showRaw && (
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* LEFT: connections table */}
        <div className={`${selected ? "w-[55%] border-r border-t-line" : "flex-1"} flex flex-col min-w-0 min-h-0 overflow-hidden`}>
          {!connected ? (
            <EmptyState icon={<Plug className="w-8 h-8" />} title={t("clients.notConnected")} subtitle={t("clients.notConnected.hint")} />
          ) : loading && conns.length === 0 ? (
            <EmptyState icon={<Loader2 className="w-8 h-8 animate-spin" />} title={t("clients.querying")} />
          ) : err && conns.length === 0 ? (
            <EmptyState
              variant="error"
              title={t("clients.failed")}
              subtitle={<>
                {err}
                <p className="text-[10.5px] mt-3 text-t-ink5">{t("clients.failed.hint")}</p>
              </>}
              action={
                <button onClick={() => refresh(false)}
                  className="h-7 px-2.5 rounded-lg text-[12px] font-medium bg-t-card border border-t-line text-t-ink2 hover:bg-t-hover transition-colors">
                  {t("clients.retry")}
                </button>
              }
            />
          ) : filteredConns.length === 0 ? (
            <EmptyState icon={<Network className="w-8 h-8" />} title={search ? t("clients.nothing") : t("clients.none")} />
          ) : (
            <div className="flex-1 overflow-auto min-h-0">
              <table className="w-full text-[12.5px] font-mono table-fixed">
                <thead className="sticky top-0 z-10 bg-t-panel border-b border-t-line">
                  {/* Percentage widths sum to 100% so the table fills its
                      container without a trailing spacer, while keeping the
                      relative column sizes the user picked (Client narrow,
                      Age wider). With `table-fixed` these are honored exactly. */}
                  <tr className="text-[11px] tracking-wide text-content-subtle select-none">
                    <th className="text-left pl-3 py-1.5 font-semibold w-[24%]">{t("clients.column.client")}</th>
                    <th className="text-left px-2 py-1.5 font-semibold w-[28%]">{t("clients.column.user")}</th>
                    <th className="text-left px-2 py-1.5 font-semibold w-[12%]">{t("clients.column.proto")}</th>
                    <th className="text-left px-2 py-1.5 font-semibold w-[8%]">{t("clients.column.cons")}</th>
                    <th className="text-left px-2 py-1.5 font-semibold w-[8%]">{t("clients.column.sess")}</th>
                    <th className="text-left pr-3 px-2 py-1.5 font-semibold w-[20%]">{t("clients.column.age")}</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedConns.flatMap(([host, group]) => {
                    // Single-connection host — render flat, no group header.
                    if (group.length < 2) {
                      const c = group[0];
                      const isSel = selected === c.connection_id;
                      const consCount = consByConn.get(c.connection_id)?.length ?? 0;
                      return [(
                        <tr
                          key={c.connection_id}
                          onClick={() => setSelected(isSel ? null : c.connection_id)}
                          className={`cursor-pointer border-b border-t-line/40 transition-colors ${
                            isSel ? "bg-accent/10" : "hover:bg-t-hover/50"
                          }`}
                        >
                          <td className="py-1.5 pl-3 truncate text-t-ink" title={c.client_address}>{c.client_address || c.connection_id}</td>
                          <td className="py-1.5 px-2 truncate text-t-ink2" title={c.users}>{c.users || "—"}</td>
                          <td className="py-1.5 px-2 truncate text-t-ink3">{c.protocol || "—"}</td>
                          <td className={`py-1.5 px-2 text-left ${consCount > 0 ? "text-positive" : "text-t-ink5"}`}>{consCount}</td>
                          <td className="py-1.5 px-2 text-left text-t-ink4">{c.session_count}</td>
                          <td className="py-1.5 pr-3 px-2 text-left text-t-ink5 whitespace-nowrap">{fmtAgo(c.creation_time, now)}</td>
                        </tr>
                      )];
                    }
                    // Multi-connection group — render a header row with chevron
                    // + aggregate stats. Header is clickable to collapse/expand;
                    // child rows are full connection rows (clickable to select).
                    const isCollapsed = collapsedHosts.has(host);
                    const totalCons = group.reduce((s, c) => s + (consByConn.get(c.connection_id)?.length ?? 0), 0);
                    const totalSess = group.reduce((s, c) => s + c.session_count, 0);
                    // Oldest connection in the group drives the "age" for the header.
                    const oldest = group.reduce((m, c) => (c.creation_time > 0 && (m === 0 || c.creation_time < m) ? c.creation_time : m), 0);
                    // Aggregate user / protocol: show the value if all match, else "—".
                    const allSame = (xs: string[]) => xs.length > 0 && xs.every(x => x === xs[0]);
                    const users    = group.map(c => c.users    || "").filter(Boolean);
                    const protos   = group.map(c => c.protocol || "").filter(Boolean);
                    const groupUser  = users.length && allSame(users) ? users[0] : (users.length ? "mixed" : "—");
                    const groupProto = protos.length && allSame(protos) ? protos[0] : (protos.length ? "mixed" : "—");
                    const rows: React.ReactElement[] = [(
                      <tr
                        key={`group:${host}`}
                        onClick={() => toggleHost(host)}
                        className="cursor-pointer border-b border-t-line/40 bg-t-panel/60 hover:bg-t-hover/50 transition-colors"
                        title={isCollapsed ? `Expand ${group.length} connections from ${host}` : `Collapse ${host}`}
                      >
                        <td className="py-1.5 pl-3 truncate text-t-ink font-medium">
                          <span className="inline-flex items-center gap-1">
                            {isCollapsed
                              ? <ChevronRight className="w-3 h-3 text-t-ink4 shrink-0" />
                              : <ChevronDown className="w-3 h-3 text-t-ink4 shrink-0" />}
                            <span title={host}>{host}</span>
                            <span className="text-[10.5px] text-t-ink5 font-mono ml-1">({group.length})</span>
                          </span>
                        </td>
                        <td className="py-1.5 px-2 truncate text-t-ink3" title={groupUser}>{groupUser}</td>
                        <td className="py-1.5 px-2 truncate text-t-ink3">{groupProto}</td>
                        <td className={`py-1.5 px-2 text-left ${totalCons > 0 ? "text-positive" : "text-t-ink5"}`}>{totalCons}</td>
                        <td className="py-1.5 px-2 text-left text-t-ink4">{totalSess}</td>
                        <td className="py-1.5 pr-3 px-2 text-left text-t-ink5 whitespace-nowrap">{fmtAgo(oldest, now)}</td>
                      </tr>
                    )];
                    if (!isCollapsed) {
                      for (const c of group) {
                        const isSel = selected === c.connection_id;
                        const consCount = consByConn.get(c.connection_id)?.length ?? 0;
                        // Show the port (or full address if extractHost failed).
                        const portText = c.client_address.startsWith(host + ":")
                          ? `:${c.client_address.slice(host.length + 1)}`
                          : (c.client_address || c.connection_id);
                        rows.push(
                          <tr
                            key={c.connection_id}
                            onClick={() => setSelected(isSel ? null : c.connection_id)}
                            className={`cursor-pointer border-b border-t-line/40 transition-colors ${
                              isSel ? "bg-accent/10" : "hover:bg-t-hover/50"
                            }`}
                          >
                            <td className="py-1.5 pl-3 truncate text-t-ink2" title={c.client_address}>
                              {/* Indent under the group header — visually
                                  signals child-of relationship without nesting
                                  the actual DOM. */}
                              <span className="inline-block w-4" />
                              <span className="text-t-ink5">└</span>{" "}
                              <span className="font-mono">{portText}</span>
                            </td>
                            <td className="py-1.5 px-2 truncate text-t-ink2" title={c.users}>{c.users || "—"}</td>
                            <td className="py-1.5 px-2 truncate text-t-ink3">{c.protocol || "—"}</td>
                            <td className={`py-1.5 px-2 text-left ${consCount > 0 ? "text-positive" : "text-t-ink5"}`}>{consCount}</td>
                            <td className="py-1.5 px-2 text-left text-t-ink4">{c.session_count}</td>
                            <td className="py-1.5 pr-3 px-2 text-left text-t-ink5 whitespace-nowrap">{fmtAgo(c.creation_time, now)}</td>
                          </tr>
                        );
                      }
                    }
                    return rows;
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* RIGHT: consumers for the selected connection */}
        {selected && (
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            <div className="shrink-0 px-3 py-1.5 border-b border-t-line bg-t-panel flex items-center gap-2">
              <Users className="w-3.5 h-3.5 text-t-ink4 shrink-0" />
              <span className="text-[12.5px] text-t-ink font-mono truncate">
                {conns.find(c => c.connection_id === selected)?.client_address || selected}
              </span>
              <span className="text-[11.5px] text-t-ink5 font-mono">
                {t("clients.consumers", { count: selectedConsumers.length })}
              </span>
              <button
                onClick={() => setSelected(null)}
                title={t("clients.close")}
                className="ml-auto text-t-ink5 hover:text-t-ink3 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto min-h-0">
              {selectedConsumers.length === 0 ? (
                <EmptyState icon={<Inbox className="w-8 h-8" />} title={t("clients.noConsumers")} subtitle={t("clients.noConsumers.hint")} />
              ) : (
                <table className="w-full text-[12.5px] font-mono table-fixed">
                  <thead className="sticky top-0 z-10 bg-t-panel border-b border-t-line">
                    <tr className="text-[11px] tracking-wide text-content-subtle select-none">
                      <th className="text-left pl-3 py-1.5 font-semibold w-[30%]">{t("clients.column.queue")}</th>
                      <th className="text-left px-2 py-1.5 font-semibold w-[30%]">{t("clients.column.address")}</th>
                      <th className="text-left px-2 py-1.5 font-semibold w-[10%]" title={t("clients.column.credit.hint")}>{t("clients.column.credit")}</th>
                      <th className="text-left px-2 py-1.5 font-semibold w-[15%]" title={t("clients.column.lastRx.hint")}>{t("clients.column.lastRx")}</th>
                      <th className="text-left pr-3 px-2 py-1.5 font-semibold w-[15%]">{t("clients.column.age")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedConsumers.map(k => (
                      <tr key={k.id} className="border-b border-t-line/40 hover:bg-t-hover/30">
                        <td className="py-1.5 pl-3 truncate text-t-ink" title={k.queue}>
                          {k.queue}
                          {k.browse_only && (
                            <span className="ml-1.5 text-[10.5px] px-1 rounded-md font-medium bg-caution/15 text-caution" title={t("clients.browse.hint")}>{t("clients.browse")}</span>
                          )}
                        </td>
                        <td className="py-1.5 px-2 truncate text-t-ink3" title={cleanAddress(k.address)}>{cleanAddress(k.address)}</td>
                        <td className={`py-1.5 px-2 text-left ${k.messages_in_transit > 0 ? "text-accent font-medium" : "text-t-ink5"}`}>
                          {k.messages_in_transit}
                        </td>
                        <td className="py-1.5 px-2 text-left text-t-ink4 whitespace-nowrap">{fmtAgo(k.last_delivered_time, now)}</td>
                        <td className="py-1.5 pr-3 px-2 text-left text-t-ink5 whitespace-nowrap">{fmtAgo(k.creation_time, now)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
