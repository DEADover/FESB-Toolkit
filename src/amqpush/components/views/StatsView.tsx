import { useEffect, useState, useMemo } from "react";
import { BarChart2, Send, Inbox, Clock, Zap, FileText, Layers, AlertTriangle, TrendingUp, Activity, ShieldCheck } from "lucide-react";
import ViewTopBar from "../ViewTopBar";
import SectionLabel from "../SectionLabel";
import EmptyState from "../EmptyState";

export interface QueueStat {
  count: number;
  bytes: number;
  lastAt: number;
}

export interface StatsData {
  sentCount: number;
  sentBytes: number;
  receivedCount: number;
  receivedBytes: number;
  sessionStart: number;
  sendTimestamps: number[];   // rolling-window for rate
  recvTimestamps: number[];

  // ── Extended analytics ──
  sentByQueue: Record<string, QueueStat>;
  receivedByQueue: Record<string, QueueStat>;

  sentByKind: Record<string, number>;        // "json" | "xml" | "text" | "binary" | "none"
  sentSizes: number[];                       // up to last N for distribution / min/max
  recvSizes: number[];

  peakSendRate: number;                      // msgs/sec
  peakRecvRate: number;

  lastSentAt: number | null;
  lastReceivedAt: number | null;

  sendErrorCount: number;
  reconnectCount: number;
}

const SIZES_RING_MAX = 500; // limit memory of size history

export function emptyStats(): StatsData {
  return {
    sentCount: 0,
    sentBytes: 0,
    receivedCount: 0,
    receivedBytes: 0,
    sessionStart: Date.now(),
    sendTimestamps: [],
    recvTimestamps: [],
    sentByQueue: {},
    receivedByQueue: {},
    sentByKind: {},
    sentSizes: [],
    recvSizes: [],
    peakSendRate: 0,
    peakRecvRate: 0,
    lastSentAt: null,
    lastReceivedAt: null,
    sendErrorCount: 0,
    reconnectCount: 0,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function rateNumber(timestamps: number[], windowMs = 60_000): number {
  const now = Date.now();
  const count = timestamps.filter(t => now - t < windowMs).length;
  return count / (windowMs / 1000);
}
function rateLabel(r: number): string {
  return r < 0.1 ? "—" : `${r.toFixed(1)}/s`;
}

function elapsed(start: number): string {
  const s = Math.floor((Date.now() - start) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Bucket timestamps into 1-second slots over the last N seconds (for sparkline). */
function bucketize(timestamps: number[], windowSec = 60): number[] {
  const now = Date.now();
  const buckets = new Array(windowSec).fill(0);
  for (const t of timestamps) {
    const ageSec = Math.floor((now - t) / 1000);
    if (ageSec >= 0 && ageSec < windowSec) {
      buckets[windowSec - 1 - ageSec]++; // newest at the right
    }
  }
  return buckets;
}

function minMaxAvg(arr: number[]): { min: number; max: number; avg: number } | null {
  if (arr.length === 0) return null;
  let min = arr[0], max = arr[0], sum = 0;
  for (const v of arr) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, avg: Math.round(sum / arr.length) };
}

// ── Public API for tracking — exported so App.tsx can use immutably ──────────

export function trackSentInStats(
  s: StatsData,
  bytes: number,
  queue: string,
  kind: string = "text",
): StatsData {
  const now = Date.now();
  const newTs = pruneAndAppend(s.sendTimestamps, now);
  const r = newTs.length / 60; // 60s window
  return {
    ...s,
    sentCount: s.sentCount + 1,
    sentBytes: s.sentBytes + bytes,
    sendTimestamps: newTs,
    sentSizes: pushBounded(s.sentSizes, bytes, SIZES_RING_MAX),
    sentByQueue: bumpQueue(s.sentByQueue, queue, bytes, now),
    sentByKind: { ...s.sentByKind, [kind]: (s.sentByKind[kind] ?? 0) + 1 },
    peakSendRate: Math.max(s.peakSendRate, r),
    lastSentAt: now,
  };
}

export function trackReceivedInStats(
  s: StatsData,
  bytes: number,
  queue: string = "(unknown)",
): StatsData {
  const now = Date.now();
  const newTs = pruneAndAppend(s.recvTimestamps, now);
  const r = newTs.length / 60;
  return {
    ...s,
    receivedCount: s.receivedCount + 1,
    receivedBytes: s.receivedBytes + bytes,
    recvTimestamps: newTs,
    recvSizes: pushBounded(s.recvSizes, bytes, SIZES_RING_MAX),
    receivedByQueue: bumpQueue(s.receivedByQueue, queue, bytes, now),
    peakRecvRate: Math.max(s.peakRecvRate, r),
    lastReceivedAt: now,
  };
}

export function trackSendErrorInStats(s: StatsData): StatsData {
  return { ...s, sendErrorCount: s.sendErrorCount + 1 };
}

export function trackReconnectInStats(s: StatsData): StatsData {
  return { ...s, reconnectCount: s.reconnectCount + 1 };
}

function pruneAndAppend(arr: number[], now: number): number[] {
  return [...arr.filter(t => now - t < 60_000), now];
}
function pushBounded(arr: number[], v: number, max: number): number[] {
  const out = [...arr, v];
  return out.length > max ? out.slice(out.length - max) : out;
}
function bumpQueue(map: Record<string, QueueStat>, queue: string, bytes: number, now: number): Record<string, QueueStat> {
  const cur = map[queue] ?? { count: 0, bytes: 0, lastAt: 0 };
  return { ...map, [queue]: { count: cur.count + 1, bytes: cur.bytes + bytes, lastAt: now } };
}

// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  /** Stats keyed by profile name (empty string for the no-profile bucket). */
  statsByProfile: Record<string, StatsData>;
  /** Currently-active profile; used as the default-selected view. */
  activeProfile: string;
}

/** Merge multiple per-profile buckets into a single aggregate. Order-
 *  preserving for queue / kind maps; takes the max session start (so
 *  "elapsed" reflects the longest-running observation). */
function mergeStats(buckets: StatsData[]): StatsData {
  if (buckets.length === 0) return emptyStats();
  if (buckets.length === 1) return buckets[0];
  const out = emptyStats();
  out.sessionStart = Math.min(...buckets.map(b => b.sessionStart));
  for (const b of buckets) {
    out.sentCount += b.sentCount;
    out.sentBytes += b.sentBytes;
    out.receivedCount += b.receivedCount;
    out.receivedBytes += b.receivedBytes;
    out.sendTimestamps.push(...b.sendTimestamps);
    out.recvTimestamps.push(...b.recvTimestamps);
    out.sentSizes.push(...b.sentSizes);
    out.recvSizes.push(...b.recvSizes);
    out.peakSendRate = Math.max(out.peakSendRate, b.peakSendRate);
    out.peakRecvRate = Math.max(out.peakRecvRate, b.peakRecvRate);
    out.sendErrorCount += b.sendErrorCount;
    out.reconnectCount += b.reconnectCount;
    out.lastSentAt = Math.max(out.lastSentAt ?? 0, b.lastSentAt ?? 0) || null;
    out.lastReceivedAt = Math.max(out.lastReceivedAt ?? 0, b.lastReceivedAt ?? 0) || null;
    for (const [q, s] of Object.entries(b.sentByQueue)) {
      const cur = out.sentByQueue[q];
      out.sentByQueue[q] = cur
        ? { count: cur.count + s.count, bytes: cur.bytes + s.bytes, lastAt: Math.max(cur.lastAt, s.lastAt) }
        : { ...s };
    }
    for (const [q, s] of Object.entries(b.receivedByQueue)) {
      const cur = out.receivedByQueue[q];
      out.receivedByQueue[q] = cur
        ? { count: cur.count + s.count, bytes: cur.bytes + s.bytes, lastAt: Math.max(cur.lastAt, s.lastAt) }
        : { ...s };
    }
    for (const [k, n] of Object.entries(b.sentByKind)) {
      out.sentByKind[k] = (out.sentByKind[k] ?? 0) + n;
    }
  }
  // Sizes are FIFO ring-bounded — trim to keep memory bounded.
  if (out.sentSizes.length > SIZES_RING_MAX) out.sentSizes = out.sentSizes.slice(-SIZES_RING_MAX);
  if (out.recvSizes.length > SIZES_RING_MAX) out.recvSizes = out.recvSizes.slice(-SIZES_RING_MAX);
  return out;
}

export default function StatsView({ statsByProfile, activeProfile }: Props) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Profile selector — defaults to the active profile if it has data,
  // otherwise to "All" (aggregate). Special sentinel "__all__" represents
  // the aggregate view; empty string is the unknown-profile bucket.
  const profileBuckets = useMemo(
    () => Object.entries(statsByProfile).filter(([, s]) => s.sentCount + s.receivedCount > 0),
    [statsByProfile],
  );
  const [viewProfile, setViewProfile] = useState<string>(activeProfile || "__all__");
  useEffect(() => {
    // When profile switches in the main header and we have data for it,
    // follow that switch in Stats — feels natural, matches the rest of
    // the app's per-profile views.
    if (statsByProfile[activeProfile]) setViewProfile(activeProfile);
  }, [activeProfile, statsByProfile]);

  const stats: StatsData = viewProfile === "__all__"
    ? mergeStats(profileBuckets.map(([, s]) => s))
    : (statsByProfile[viewProfile] ?? emptyStats());

  const sendRate = rateNumber(stats.sendTimestamps);
  const recvRate = rateNumber(stats.recvTimestamps);
  const empty = stats.sentCount === 0 && stats.receivedCount === 0;

  const sentSizeStats = useMemo(() => minMaxAvg(stats.sentSizes), [stats.sentSizes]);
  const recvSizeStats = useMemo(() => minMaxAvg(stats.recvSizes), [stats.recvSizes]);

  const sentBuckets = useMemo(() => bucketize(stats.sendTimestamps), [stats.sendTimestamps]);
  const recvBuckets = useMemo(() => bucketize(stats.recvTimestamps), [stats.recvTimestamps]);

  const topSentQueues = useMemo(
    () => Object.entries(stats.sentByQueue).sort((a, b) => b[1].count - a[1].count).slice(0, 5),
    [stats.sentByQueue]
  );
  const topRecvQueues = useMemo(
    () => Object.entries(stats.receivedByQueue).sort((a, b) => b[1].count - a[1].count).slice(0, 5),
    [stats.receivedByQueue]
  );
  const kindEntries = useMemo(
    () => Object.entries(stats.sentByKind).sort((a, b) => b[1] - a[1]),
    [stats.sentByKind]
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">

      {/* ─── TOP BAR ─── */}
      <ViewTopBar
        icon={<BarChart2 className="w-3.5 h-3.5" />}
        title="Session Statistics"
        count={elapsed(stats.sessionStart)}
      >
        {/* Profile selector — shown only when there's more than one bucket
            with data. Single-profile users get the unchanged simple top bar. */}
        {profileBuckets.length > 1 && (
          <select
            value={viewProfile}
            onChange={e => setViewProfile(e.target.value)}
            className="bg-t-field border border-t-line2 rounded px-1.5 py-0.5 text-[11px] text-t-ink2 outline-none focus:border-blue-500 mr-1"
            title="Switch which profile's stats are shown — 'All' merges every bucket."
          >
            <option value="__all__">All ({profileBuckets.length})</option>
            {profileBuckets.map(([name]) => (
              <option key={name} value={name}>{name || "(no profile)"}</option>
            ))}
          </select>
        )}
        <span className="text-[11px] text-t-ink5 font-mono">
          ↑{stats.sentCount.toLocaleString()} ↓{stats.receivedCount.toLocaleString()}
          {stats.sendErrorCount > 0 && <span className="text-red-500 ml-2">⚠ {stats.sendErrorCount}</span>}
        </span>
      </ViewTopBar>

      {/* ─── CONTENT ─── */}
      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-3">

        {/* OVERVIEW — 6 stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-2">
          <Card icon={<Send  className="w-4 h-4 text-blue-500" />} label="Sent"
            value={stats.sentCount.toLocaleString()} sub={fmt(stats.sentBytes)}
            footer={stats.lastSentAt ? `last ${timeAgo(stats.lastSentAt)}` : undefined} />
          <Card icon={<Inbox className="w-4 h-4 text-green-500" />} label="Received"
            value={stats.receivedCount.toLocaleString()} sub={fmt(stats.receivedBytes)}
            footer={stats.lastReceivedAt ? `last ${timeAgo(stats.lastReceivedAt)}` : undefined} />
          <Card icon={<Zap className="w-4 h-4 text-amber-500" />} label="Throughput"
            value={`${rateLabel(sendRate)} ↑`} sub={`${rateLabel(recvRate)} ↓`}
            footer={`peak ${stats.peakSendRate.toFixed(1)}/s ↑ · ${stats.peakRecvRate.toFixed(1)}/s ↓`} />
          <Card icon={<FileText className="w-4 h-4 text-violet-500" />} label="Avg size"
            value={sentSizeStats ? fmt(sentSizeStats.avg) : "—"}
            sub={`min ${sentSizeStats ? fmt(sentSizeStats.min) : "—"} · max ${sentSizeStats ? fmt(sentSizeStats.max) : "—"}`}
            footer="of sent messages" />
          <Card icon={<Clock className="w-4 h-4 text-t-ink4" />} label="Uptime"
            value={elapsed(stats.sessionStart)}
            sub={new Date(stats.sessionStart).toLocaleTimeString()}
            footer={stats.reconnectCount > 0 ? `${stats.reconnectCount} reconnect${stats.reconnectCount !== 1 ? "s" : ""}` : "stable"} />

          {/* RELIABILITY — success rate + errors + reconnects */}
          {(() => {
            const totalAttempts = stats.sentCount + stats.sendErrorCount;
            const successPct = totalAttempts > 0
              ? ((stats.sentCount / totalAttempts) * 100)
              : null;
            const hasIssues = stats.sendErrorCount > 0 || stats.reconnectCount > 0;
            const valueText = successPct !== null
              ? `${successPct >= 99.95 ? "100" : successPct.toFixed(1)}%`
              : "—";
            const valueColor =
              successPct === null            ? "text-t-ink" :
              successPct >= 99.5             ? "text-green-500" :
              successPct >= 95               ? "text-amber-500" :
                                               "text-red-500";
            const subText = totalAttempts === 0
              ? "no sends yet"
              : stats.sendErrorCount === 0
                ? `${stats.sentCount} ok · 0 err`
                : `${stats.sentCount} ok · ${stats.sendErrorCount} err`;
            const footer = stats.reconnectCount > 0
              ? `${stats.reconnectCount} reconnect${stats.reconnectCount !== 1 ? "s" : ""}`
              : hasIssues
                ? ""
                : "no issues";
            return (
              <Card
                icon={<ShieldCheck className={`w-4 h-4 ${hasIssues ? "text-amber-500" : "text-green-500"}`} />}
                label="Reliability"
                value={<span className={valueColor}>{valueText}</span>}
                sub={subText}
                footer={footer}
              />
            );
          })()}
        </div>

        {/* THROUGHPUT — sparkline charts */}
        <Section title="Throughput · last 60s" icon={<TrendingUp className="w-3.5 h-3.5" />}>
          <div className="grid grid-cols-2 gap-3">
            <Sparkline buckets={sentBuckets}  label="Sent"     color="bg-blue-500"  rate={sendRate} count={stats.sentCount} />
            <Sparkline buckets={recvBuckets} label="Received" color="bg-green-500" rate={recvRate} count={stats.receivedCount} />
          </div>
        </Section>

        {/* TOP QUEUES */}
        <Section title="Top queues" icon={<Layers className="w-3.5 h-3.5" />}>
          <div className="grid grid-cols-2 gap-3">
            <QueueLeaderboard title="Sent → " entries={topSentQueues} totalCount={stats.sentCount} accent="blue" />
            <QueueLeaderboard title="Received ← " entries={topRecvQueues} totalCount={stats.receivedCount} accent="green" />
          </div>
        </Section>

        {/* SIZE DISTRIBUTION + CONTENT KIND */}
        <Section title="Distribution" icon={<Activity className="w-3.5 h-3.5" />}>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-t-card border border-t-line rounded-lg p-3">
              <SectionLabel className="block mb-2">Sent message size</SectionLabel>
              <SizeBar stats={sentSizeStats} />
            </div>
            <div className="bg-t-card border border-t-line rounded-lg p-3">
              <SectionLabel className="block mb-2">Received message size</SectionLabel>
              <SizeBar stats={recvSizeStats} />
            </div>
            {kindEntries.length > 0 && (
              <div className="col-span-2 bg-t-card border border-t-line rounded-lg p-3">
                <SectionLabel className="block mb-2">Sent by content type</SectionLabel>
                <KindBar entries={kindEntries} total={stats.sentCount} />
              </div>
            )}
          </div>
        </Section>

        {/* ERRORS */}
        {(stats.sendErrorCount > 0 || stats.reconnectCount > 0) && (
          <Section title="Issues" icon={<AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}>
            <div className="bg-t-card border border-t-line rounded-lg p-3 grid grid-cols-2 gap-3 text-[12px]">
              <div>
                <SectionLabel className="block mb-1">Send errors</SectionLabel>
                <p className="text-xl font-bold font-mono text-red-500">{stats.sendErrorCount}</p>
              </div>
              <div>
                <SectionLabel className="block mb-1">Reconnects</SectionLabel>
                <p className="text-xl font-bold font-mono text-amber-500">{stats.reconnectCount}</p>
              </div>
            </div>
          </Section>
        )}

        {empty && (
          <EmptyState
            icon={<BarChart2 className="w-8 h-8" />}
            title="No statistics yet"
            subtitle="Send or receive messages to see throughput, distribution and reliability."
          />
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Card({ icon, label, value, sub, footer }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string; footer?: string }) {
  return (
    <div className="bg-t-card border border-t-line rounded-lg p-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {icon}
        <SectionLabel className="truncate">{label}</SectionLabel>
      </div>
      <p className="text-2xl font-bold text-t-ink font-mono leading-none mt-1">{value}</p>
      {sub && <p className="text-[11px] text-t-ink4 mt-1 truncate">{sub}</p>}
      {footer && <p className="text-[10px] text-t-ink5 mt-auto pt-1 truncate">{footer}</p>}
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <SectionLabel icon={icon} className="mb-2">{title}</SectionLabel>
      {children}
    </div>
  );
}

function Sparkline({ buckets, label, color, rate, count }: { buckets: number[]; label: string; color: string; rate: number; count: number }) {
  const max = Math.max(1, ...buckets);
  return (
    <div className="bg-t-card border border-t-line rounded-lg p-3">
      <div className="flex items-baseline justify-between mb-2">
        <SectionLabel>{label}</SectionLabel>
        <span className="text-[11px] font-mono text-t-ink2">
          <span className="text-[14px] font-bold text-t-ink">{rateLabel(rate)}</span>
          <span className="text-t-ink5 ml-1">· {count.toLocaleString()} total</span>
        </span>
      </div>
      <div className="flex items-end gap-px h-12">
        {buckets.map((b, i) => (
          <div key={i}
            className={`flex-1 ${color} rounded-sm transition-all min-h-[1px] ${b === 0 ? "opacity-20" : ""}`}
            style={{ height: `${Math.max(2, (b / max) * 100)}%` }}
            title={`${b} msg, ${60 - i}s ago`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-t-ink5 font-mono mt-1">
        <span>−60s</span>
        <span>−30s</span>
        <span>now</span>
      </div>
    </div>
  );
}

function QueueLeaderboard({ title, entries, totalCount, accent }: {
  title: string; entries: Array<[string, QueueStat]>; totalCount: number; accent: "blue" | "green";
}) {
  const accentBg = accent === "blue" ? "bg-blue-500" : "bg-green-500";
  return (
    <div className="bg-t-card border border-t-line rounded-lg p-3">
      <SectionLabel className="block mb-2">{title}</SectionLabel>
      {entries.length === 0 ? (
        <p className="text-[11px] text-t-ink5 py-2">No data yet</p>
      ) : (
        <div className="space-y-1.5">
          {entries.map(([name, st]) => {
            const pct = totalCount > 0 ? (st.count / totalCount) * 100 : 0;
            return (
              <div key={name}>
                <div className="flex items-center justify-between text-[11px] mb-0.5 gap-2">
                  <span className="font-mono text-t-ink2 truncate" title={name}>{name}</span>
                  <span className="text-t-ink4 font-mono shrink-0 text-right">
                    {st.count} <span className="text-t-ink5">· {fmt(st.bytes)}</span>
                  </span>
                </div>
                <div className="h-1 bg-t-hover rounded-full overflow-hidden">
                  <div className={`h-full ${accentBg} rounded-full transition-all`}
                    style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SizeBar({ stats }: { stats: { min: number; max: number; avg: number } | null }) {
  if (!stats) return <p className="text-[11px] text-t-ink5 py-2">No data yet</p>;
  const range = stats.max - stats.min;
  const avgPct = range > 0 ? ((stats.avg - stats.min) / range) * 100 : 50;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] font-mono mb-2">
        <div>
          <span className="text-t-ink5 mr-1">min</span>
          <span className="text-t-ink2">{fmt(stats.min)}</span>
        </div>
        <div>
          <span className="text-t-ink5 mr-1">avg</span>
          <span className="text-t-ink font-bold">{fmt(stats.avg)}</span>
        </div>
        <div>
          <span className="text-t-ink5 mr-1">max</span>
          <span className="text-t-ink2">{fmt(stats.max)}</span>
        </div>
      </div>
      <div className="relative h-2 bg-t-hover rounded-full overflow-hidden">
        <div className="absolute h-full bg-blue-500/30 rounded-full" style={{ width: "100%" }} />
        <div className="absolute top-0 bottom-0 w-0.5 bg-blue-600 rounded-full" style={{ left: `${avgPct}%` }} />
      </div>
    </div>
  );
}

const KIND_COLORS: Record<string, string> = {
  json:   "bg-blue-500",
  xml:    "bg-violet-500",
  text:   "bg-amber-500",
  binary: "bg-pink-500",
  none:   "bg-t-ink5",
};

function KindBar({ entries, total }: { entries: Array<[string, number]>; total: number }) {
  return (
    <div>
      <div className="flex h-3 rounded-full overflow-hidden bg-t-hover">
        {entries.map(([kind, count]) => {
          const pct = (count / total) * 100;
          return (
            <div key={kind}
              className={`${KIND_COLORS[kind] ?? "bg-t-ink4"} h-full transition-all`}
              style={{ width: `${pct}%` }}
              title={`${kind}: ${count} (${pct.toFixed(0)}%)`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11px]">
        {entries.map(([kind, count]) => (
          <div key={kind} className="flex items-center gap-1">
            <span className={`w-2 h-2 rounded-full ${KIND_COLORS[kind] ?? "bg-t-ink4"}`} />
            <span className="text-t-ink2 font-mono">{kind}</span>
            <span className="text-t-ink5">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
