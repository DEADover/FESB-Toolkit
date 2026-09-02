import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, RotateCcw, Radar, X, AlertCircle, Check, Clock } from "lucide-react";
import SectionLabel from "./SectionLabel";
import { readRecentQueues, forgetRecentQueue, type RecentQueueEntry } from "../utils/recentQueues";

interface BrokerQueue {
  name: string;
  address: string;
  message_count: number;
  consumer_count: number;
  routing_type: string;
  kind: string; // "queue" | "address"
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  connected?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Active profile name — drives the per-profile Recent queues MRU list.
   *  Omitted/empty → Recent section is hidden. */
  profileName?: string;
  /** @deprecated — bookmarks were removed; prop kept for backward compatibility */
  showSave?: boolean;
  /** @deprecated — kept for backward compatibility */
  onQueuesChange?: () => void;
}

export default function QueuePicker({
  value, onChange, connected = false, disabled,
  placeholder = "queue or address",
  className = "",
  profileName = "",
}: Props) {
  const [brokerQueues,   setBrokerQueues]   = useState<BrokerQueue[]>([]);
  const [open,           setOpen]           = useState(false);
  const [brokerLoading,  setBrokerLoading]  = useState(false);
  const [brokerErr,      setBrokerErr]      = useState<string | null>(null);
  const [brokerLoadedAt, setBrokerLoadedAt] = useState<number | null>(null);
  // Recent queues MRU — loaded from localStorage on open and after the
  // user forgets one. Filtered by the input query alongside broker queues.
  const [recent, setRecent] = useState<RecentQueueEntry[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Refresh the recent list whenever we open the dropdown or switch profile,
  // so a queue that was just sent shows up immediately next time the picker
  // is opened.
  useEffect(() => {
    if (open) setRecent(readRecentQueues(profileName));
  }, [open, profileName]);

  async function loadBroker(silent = false) {
    if (!connected) return;
    if (!silent) setBrokerLoading(true);
    setBrokerErr(null);
    try {
      const list = await invoke<BrokerQueue[]>("list_broker_queues");
      setBrokerQueues(list);
      setBrokerLoadedAt(Date.now());
    } catch (e) {
      setBrokerErr(String(e));
    } finally {
      setBrokerLoading(false);
    }
  }

  // Auto-load broker queues when dropdown first opens (and connected)
  useEffect(() => {
    if (open && connected && brokerLoadedAt === null && !brokerLoading) {
      loadBroker();
    }
  }, [open, connected]);

  // Re-fetch broker queues when reconnecting
  useEffect(() => {
    if (!connected) {
      setBrokerQueues([]);
      setBrokerErr(null);
      setBrokerLoadedAt(null);
    }
  }, [connected]);

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const q = value.trim().toLowerCase();
  const filtered = useMemo(
    () => q
      ? brokerQueues.filter(it => it.address.toLowerCase().includes(q) || it.name.toLowerCase().includes(q))
      : brokerQueues,
    [brokerQueues, q]
  );

  // Recent queues filtered by current query. We also drop recent entries
  // that the broker has just confirmed (so the same address doesn't appear
  // twice in the dropdown — broker listing wins, recent is for things not
  // yet discovered).
  const filteredRecent = useMemo(() => {
    const brokerAddrs = new Set(brokerQueues.map(b => b.address));
    return recent
      .filter(e => !brokerAddrs.has(e.address))
      .filter(e => !q || e.address.toLowerCase().includes(q));
  }, [recent, brokerQueues, q]);

  const showLiveBadge = connected && brokerLoadedAt !== null;

  function forget(addr: string) {
    forgetRecentQueue(profileName, addr);
    setRecent(readRecentQueues(profileName));
  }

  return (
    <div ref={containerRef} className={`relative flex items-center gap-1 ${className}`}>
      <div className="relative flex-1">
        <input
          value={value}
          onChange={e => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full bg-t-field border border-t-line2 rounded-md pl-2.5 pr-12 py-1.5 text-[12px] text-t-ink font-mono outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-all placeholder:text-t-ink5 disabled:opacity-50"
        />
        {!disabled && value && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => { onChange(""); setOpen(true); }}
            title="Clear"
            className="absolute right-6 top-1/2 -translate-y-1/2 text-t-ink5 hover:text-t-ink2 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        )}
        {!disabled && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setOpen(o => !o)}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-t-ink4 hover:text-t-ink2 transition-colors"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>

      {/* DROPDOWN */}
      {open && !disabled && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-t-card border border-t-line rounded-md shadow-lg overflow-hidden">

          {/* Top bar — status + refresh */}
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-t-line bg-t-panel">
            <SectionLabel icon={<Radar className="w-3 h-3" />}>
              {connected ? "Broker queues" : "Not connected"}
            </SectionLabel>
            {showLiveBadge && (
              <span className="text-[10px] text-t-ink5 font-mono">{brokerQueues.length}</span>
            )}
            <button
              type="button"
              onClick={() => loadBroker()}
              disabled={!connected || brokerLoading}
              className="ml-auto p-1 text-t-ink4 hover:text-blue-500 transition-colors disabled:opacity-40"
              title={connected ? "Refresh queue list" : "Connect to a broker first"}
              aria-label="Refresh broker queue list"
            >
              <RotateCcw className={`w-3 h-3 ${brokerLoading ? "animate-spin" : ""}`} />
            </button>
          </div>

          {/* Broker error */}
          {brokerErr && (
            <div className="px-3 py-2 text-[11px] text-amber-500 bg-amber-500/5 border-b border-amber-500/20 flex items-start gap-2">
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
              <span className="break-all">{brokerErr}</span>
            </div>
          )}

          {/* Recent — MRU list of addresses the user has actually sent to /
              subscribed from with this profile. Hidden when empty or when
              the picker has no profile context. Each row has a × forget
              button (hover) so stale entries can be pruned. */}
          {filteredRecent.length > 0 && (
            <>
              <div className="flex items-center gap-2 px-3 py-1 border-b border-t-line bg-t-panel/60">
                <SectionLabel icon={<Clock className="w-3 h-3" />}>Recent</SectionLabel>
                <span className="text-[10px] text-t-ink5 font-mono">{filteredRecent.length}</span>
              </div>
              <div className="max-h-40 overflow-y-auto border-b border-t-line">
                {filteredRecent.map(e => {
                  const isCurrent = value === e.address;
                  return (
                    <div key={e.address}
                      className={`group flex items-center gap-2 px-3 py-1.5 transition-colors ${
                        isCurrent ? "bg-blue-500/10" : "hover:bg-t-hover/50"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => { onChange(e.address); setOpen(false); }}
                        className={`flex-1 min-w-0 text-left text-[12px] font-mono truncate ${
                          isCurrent ? "text-blue-500" : "text-t-ink2 group-hover:text-t-ink"
                        }`}
                        title={e.address}
                      >
                        {e.address}
                      </button>
                      <button
                        type="button"
                        onClick={(ev) => { ev.stopPropagation(); forget(e.address); }}
                        title="Forget this recent queue"
                        aria-label={`Forget ${e.address}`}
                        className="shrink-0 opacity-0 group-hover:opacity-100 text-t-ink5 hover:text-red-500 transition-all p-0.5"
                      >
                        <X className="w-3 h-3" />
                      </button>
                      {isCurrent && <Check className="w-3 h-3 text-blue-500 shrink-0" />}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Table header — visible when there are entries */}
          {filtered.length > 0 && (
            <div className="grid grid-cols-[1fr_50px_50px_50px_18px] items-center gap-2 px-3 py-1 border-b border-t-line bg-t-panel/60">
              <SectionLabel>Name</SectionLabel>
              <SectionLabel className="justify-center">Type</SectionLabel>
              <SectionLabel className="justify-end">Msgs</SectionLabel>
              <SectionLabel className="justify-end">Cons</SectionLabel>
              <div></div>
            </div>
          )}

          {/* List */}
          <div className="max-h-72 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-[11px] text-t-ink5 text-center">
                {q ? "No matches" : connected ? "No queues on broker" : "Connect to a broker to discover queues"}
              </p>
            ) : (
              filtered.map(it => {
                const isCurrent = value === it.address;
                const isAddress = it.kind === "address";
                return (
                  <button key={it.address}
                    type="button"
                    onClick={() => { onChange(it.address); setOpen(false); }}
                    className={`w-full text-left grid grid-cols-[1fr_50px_50px_50px_18px] items-center gap-2 px-3 py-1.5 border-b border-t-line/40 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-blue-500/40 focus-visible:ring-inset ${
                      isCurrent ? "bg-blue-500/10" : "hover:bg-t-hover/50"
                    }`}
                  >
                    {/* Name */}
                    <span className="text-[12px] font-mono text-t-ink truncate" title={it.address}>
                      {it.address}
                    </span>

                    {/* Type */}
                    <span className="text-[10px] flex justify-center">
                      <span className={`px-1 py-0 rounded font-medium ${
                        isAddress
                          ? "bg-t-hover text-t-ink4"
                          : it.routing_type === "ANYCAST"
                            ? "bg-blue-500/15 text-blue-500"
                            : "bg-violet-500/15 text-violet-500"
                      }`}>
                        {isAddress ? "ADDR" : it.routing_type === "ANYCAST" ? "ANY" : "MULTI"}
                      </span>
                    </span>

                    {/* Messages */}
                    <span className={`text-[11px] font-mono text-right tabular-nums ${
                      isAddress ? "text-t-ink5" :
                      it.message_count > 0 ? "text-t-ink2" : "text-t-ink5"
                    }`}>
                      {isAddress ? "—" : it.message_count}
                    </span>

                    {/* Consumers */}
                    <span className={`text-[11px] font-mono text-right tabular-nums ${
                      isAddress ? "text-t-ink5" :
                      it.consumer_count > 0 ? "text-green-500" : "text-t-ink5"
                    }`}>
                      {isAddress ? "—" : it.consumer_count}
                    </span>

                    {/* Selected check */}
                    <span className="flex justify-center">
                      {isCurrent && <Check className="w-3 h-3 text-blue-500" />}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* Footer hint for custom address */}
          {value.trim() && !brokerQueues.some(it => it.address === value.trim()) && (
            <div className="px-3 py-1.5 border-t border-t-line text-[10px] text-t-ink5 bg-t-panel">
              Press <kbd className="px-1 bg-t-card border border-t-line rounded text-[9px]">Enter</kbd> to use <span className="font-mono text-t-ink3">{value.trim()}</span> (custom address)
            </div>
          )}
        </div>
      )}
    </div>
  );
}
