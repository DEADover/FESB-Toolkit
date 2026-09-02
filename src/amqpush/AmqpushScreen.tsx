import { useState, useCallback, useEffect, useRef } from "react";
import { ChevronDown, HelpCircle, Plug, Sparkles, Terminal, User } from "lucide-react";
import ConnectionView from "./components/views/ConnectionView";
import PublisherView from "./components/views/PublisherView";
import SubscriberView from "./components/views/SubscriberView";
import HistoryView from "./components/views/HistoryView";
import StatsView, { StatsData, emptyStats, trackSentInStats, trackReceivedInStats, trackSendErrorInStats } from "./components/views/StatsView";
import ConsoleView from "./components/views/ConsoleView";
import BrowserView from "./components/views/BrowserView";
import InspectorView from "./components/views/InspectorView";
import Dropdown, { DropdownItem, DropdownSection, DropdownFooter } from "./components/Dropdown";
import CommandPalette, { PaletteAction } from "./components/CommandPalette";
import HelpModal from "./components/HelpModal";
import ConfirmDialog from "./components/ConfirmDialog";
import { useAmqpText } from "./i18n";
import { LogEntry, View, Profile } from "./types";
import { invoke } from "@tauri-apps/api/core";
import "./amqpush.css";

let logId = 0;

const VIEW_KEYS: Record<string, View> = {
  "1": "connection", "2": "publisher", "3": "subscriber", "4": "browser",
  "5": "inspector",  "6": "history",   "7": "stats",     "8": "console",
};

/**
 * Map the user's current location (view + Publisher tab) to a Help section
 * id. Used to open the in-app guide directly on whatever the user is
 * looking at — clicking ? on the CSV tab opens "CSV bulk send", on Receive
 * opens "Receive", and so on.
 *
 * Tab strings come from PublisherView's TabKey union; everything else just
 * keys off `view`. Unknown combos fall back to "getting-started".
 */
function helpSectionFor(view: View, pubTab: string): string {
  if (view === "publisher") {
    switch (pubTab) {
      case "variables": return "variables";
      case "prescript": return "prescript";
      case "batch":     return "batch";
      case "csv":       return "csv";
      case "reply":     return "reply";
      case "templates": return "templates";
      // body / properties / anything else → main Send page; users tweaking
      // schema validation are usually inside the Body tab too.
      default:          return "send";
    }
  }
  switch (view) {
    case "connection": return "connection";
    case "subscriber": return "receive";
    case "browser":    return "browser";
    case "inspector":  return "inspector";
    case "history":    return "history";
    case "stats":      return "stats";
    case "console":    return "logs";
    default:           return "getting-started";
  }
}


/**
 * Раздел AMQP: клиент брокеров AMQP 1.0 внутри FESB Toolkit.
 *
 * Перенесён из отдельного приложения целиком — восемь экранов, все
 * возможности. Своя навигация осталась при нём: экраны переключаются
 * вкладками внутри раздела и не покидают дерево, поэтому живой подписчик
 * продолжает слушать очередь, пока смотришь историю отправок.
 *
 * Тему, заголовок окна и обновления раздел не трогает: этим занят хозяин.
 */
export function AmqpushScreen({ view, onView }: {
  /** Какой экран показывать. Выбирается боковой панелью приложения. */
  view: View;
  /** Смена экрана изнутри: горячие клавиши и ссылки «отправить сюда». */
  onView: (view: View) => void;
}) {
  const t = useAmqpText();

  const [prevView,       setPrevView]       = useState<View>("publisher");
  const [connected,      setConnected]      = useState(false);
  const [defaultAddress, setDefaultAddress] = useState("test_queue");
  // Logs persist across restarts via localStorage (last 500 entries).
  const [logs, setLogs] = useState<LogEntry[]>(() => {
    try {
      const raw = localStorage.getItem("amqpush.logs");
      if (!raw) return [];
      const parsed = JSON.parse(raw) as Array<LogEntry & { ts?: string }>;
      // Migrate legacy entries that only had `ts: "HH:MM:SS"` and no `tsMs`.
      // We can't recover the original date, so we synthesise today's date at
      // the recorded time — at least sorting and filtering remain coherent.
      const migrated: LogEntry[] = parsed.map(l => {
        if (typeof l.tsMs === "number" && l.tsMs > 0) return l as LogEntry;
        const m = typeof l.ts === "string" && /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(l.ts);
        if (m) {
          const d = new Date();
          d.setHours(+m[1], +m[2], +m[3], 0);
          return { ...l, tsMs: d.getTime() };
        }
        return { ...l, tsMs: 0 };
      });
      // Bring logId past restored entries to avoid duplicate ids
      const maxId = migrated.reduce((m, l) => Math.max(m, l.id ?? 0), 0);
      logId = maxId;
      return migrated;
    } catch { return []; }
  });
  const [sendTrigger,    setSendTrigger]    = useState(0);
  // Profile state — declared early because the per-profile stats map
  // (below) keys off `activeProfile`. The setter is still used way down
  // by the profile-picker logic.
  const [profiles,      setProfiles]      = useState<Profile[]>([]);
  const [activeProfile, setActiveProfile] = useState<string>("");
  /** Per-profile stats — `""` is the unknown-profile bucket (used by the
   *  CommandPalette quick-send path that doesn't carry a profile). All
   *  tracking functions write into the bucket for the currently-active
   *  profile so users can compare prod vs dev side-by-side in StatsView. */
  const [statsByProfile, setStatsByProfile] = useState<Record<string, StatsData>>({});
  // Convenience accessor: the active profile's bucket, or an empty one
  // for first-render code paths that want stat numbers (sentCount, etc).
  const stats: StatsData = statsByProfile[activeProfile] ?? emptyStats();

  const [resendPayload,  setResendPayload]  = useState<{
    address: string;
    body: string;
    fileName?: string;
    fileDataB64?: string;
    properties?: Record<string, string>;
    /** Pre-fill standard AMQP correlation-id (used by Reply flow). */
    correlationId?: string;
    nonce: number;
  } | null>(null);
  const [pendingSubAddr, setPendingSubAddr] = useState<{ address: string; nonce: number } | null>(null);

  // Sidebar collapsed/expanded — persisted across sessions
  // Connection form state — lifted to App so values persist across view switches
  const [connForm, setConnForm] = useState({
    host:     "127.0.0.1",
    port:     "5672",
    username: "",
    password: "",
    queue:    "",
    useTls:   false,
    containerId: "",
    heartbeatSecs: "",
    connectTimeoutSecs: "10",
    tlsSkipVerify: false,
    saslAnonymous: false,
    workspace: "Default",
    reconnectBaseMs: "1000",
    reconnectMaxMs: "30000",
    reconnectMultiplier: "2",
    sendRetryAttempts: "1",
    sendRetryDelayMs: "250",
    clientCertPath: "",
    clientKeyPath: "",
    clientKeyPassphrase: "",
    useWs: false,
    wsPath: "",
  });

  // Прошлый экран помнится ради ⌘L: он переключает журнал и обратно.
  function changeView(v: View) {
    setPrevView(view);
    onView(v);
  }

  const addLog = useCallback((kind: LogEntry["kind"], text: string) => {
    setLogs(prev => [...prev.slice(-499), { id: ++logId, tsMs: Date.now(), kind, text }]);
  }, []);

  // Persist logs to localStorage — debounced, last 500 entries only
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem("amqpush.logs", JSON.stringify(logs.slice(-500)));
      } catch {}
    }, 500);
    return () => clearTimeout(t);
  }, [logs]);

  // History refresh trigger — increments after every successful send so HistoryView reloads
  const [historyVersion, setHistoryVersion] = useState(0);

  // Track stats — extended payload (queue, content kind) feeds richer Stats view.
  // Writes into the bucket for the currently-active profile via a closure
  // over `activeProfile`. The map uses the profile name as key; the unknown
  // / no-profile case ends up in the empty-string bucket.
  const trackSent = useCallback((bytes: number, queue: string, kind: string = "text") => {
    setStatsByProfile(m => {
      const cur = m[activeProfile] ?? emptyStats();
      return { ...m, [activeProfile]: trackSentInStats(cur, bytes, queue, kind) };
    });
    setHistoryVersion(v => v + 1);
  }, [activeProfile]);

  const trackReceived = useCallback((bytes: number, queue: string = "(unknown)") => {
    setStatsByProfile(m => {
      const cur = m[activeProfile] ?? emptyStats();
      return { ...m, [activeProfile]: trackReceivedInStats(cur, bytes, queue) };
    });
  }, [activeProfile]);

  const trackSendError = useCallback(() => {
    setStatsByProfile(m => {
      const cur = m[activeProfile] ?? emptyStats();
      return { ...m, [activeProfile]: trackSendErrorInStats(cur) };
    });
  }, [activeProfile]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Bare-key `?` opens Help, but only when the user isn't typing into a
      // form field / editor — otherwise it would swallow the literal "?".
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        const editable = tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable
          || !!t?.closest?.(".cm-editor"); // CodeMirror catches its own keys, but be defensive
        if (!editable) {
          e.preventDefault();
          setShowHelp(true);
          return;
        }
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const targetView = VIEW_KEYS[e.key];
      if (targetView) { e.preventDefault(); changeView(targetView); return; }

      if (e.key === "Enter" && view === "publisher") {
        e.preventDefault(); setSendTrigger(n => n + 1); return;
      }
      // Cmd+L: toggle to/from console
      if (e.key === "l") {
        e.preventDefault();
        changeView(view === "console" ? prevView : "console");
        return;
      }
      // Cmd+K: open command palette
      if (e.key === "k") {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [view, prevView]);

  // Suppress the WebView's default behaviour of navigating to dropped files.
  // Tauri's OS-level drag-drop interception is disabled (see tauri.conf.json
  // `dragDropEnabled: false`) so HTML5 drag events fire normally — without
  // this guard the entire WebView would replace itself with the dropped file
  // when it lands outside any registered dropzone.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop     = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  function handleConnected(addr: string) {
    setConnected(true);
    setDefaultAddress(addr);
    // Reset only the active-profile bucket on a fresh connect — keeps any
    // numbers we have for other profiles around for cross-comparison.
    setStatsByProfile(m => ({ ...m, [activeProfile]: emptyStats() }));
  }
  function handleResend(arg: { address: string; body?: string; fileName?: string; fileDataB64?: string; properties?: Record<string, string>; correlationId?: string }) {
    setResendPayload({
      address: arg.address,
      body: arg.body ?? "",
      fileName: arg.fileName,
      fileDataB64: arg.fileDataB64,
      properties: arg.properties,
      correlationId: arg.correlationId,
      nonce: Date.now(),
    });
    changeView("publisher");
  }
  function handlePublishTo(address: string) { setResendPayload({ address, body: "", nonce: Date.now() }); changeView("publisher"); }
  function handleSubscribeTo(address: string) { setPendingSubAddr({ address, nonce: Date.now() }); changeView("subscriber"); }

  // ─── Profile management (lifted to App so status bar can switch quickly) ──
  // `profiles` / `activeProfile` state moved up to keep the per-profile
  // stats map declaration order-correct. Setters stay used here for the
  // profile-picker.
  const loadProfiles = useCallback(async () => {
    try { setProfiles(await invoke<Profile[]>("get_profiles")); }
    catch (e) { addLog("err", `Load profiles: ${e}`); }
  }, [addLog]);

  useEffect(() => { loadProfiles(); }, []);

  // Broker-latency polling. Runs while connected, hits ping_broker every
  // 5 s. Cheapest possible management RPC (broker.getName) — reuses the
  // long-lived ManagementChannel, so a healthy ping costs the broker
  // effectively zero. Failure clears the indicator; the next attempt will
  // try to reopen the channel automatically.
  useEffect(() => {
    if (!connected) { setBrokerLatencyMs(null); return; }
    let cancelled = false;
    async function probe() {
      try {
        const ms = await invoke<number>("ping_broker");
        if (!cancelled) setBrokerLatencyMs(ms);
      } catch {
        if (!cancelled) setBrokerLatencyMs(null);
      }
    }
    probe();
    const interval = setInterval(probe, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [connected]);

  function applyProfile(p: Profile) {
    setConnForm({
      host: p.host,
      port: String(p.port),
      username: p.username,
      password: p.password,
      queue: p.queue,
      useTls: p.use_tls,
      containerId:        p.container_id ?? "",
      heartbeatSecs:      p.heartbeat_secs ? String(p.heartbeat_secs) : "",
      connectTimeoutSecs: p.connect_timeout_secs !== undefined ? String(p.connect_timeout_secs) : "10",
      tlsSkipVerify:      p.tls_skip_verify ?? false,
      saslAnonymous:      p.sasl_anonymous ?? false,
      workspace:          (p.workspace ?? "").trim() || "Default",
      reconnectBaseMs:    p.reconnect_base_ms !== undefined ? String(p.reconnect_base_ms) : "1000",
      reconnectMaxMs:     p.reconnect_max_ms !== undefined ? String(p.reconnect_max_ms) : "30000",
      reconnectMultiplier: p.reconnect_multiplier !== undefined ? String(p.reconnect_multiplier) : "2",
      sendRetryAttempts:  p.send_retry_attempts !== undefined ? String(p.send_retry_attempts) : "1",
      sendRetryDelayMs:   p.send_retry_delay_ms !== undefined ? String(p.send_retry_delay_ms) : "250",
      clientCertPath:     p.client_cert_path ?? "",
      clientKeyPath:      p.client_key_path ?? "",
      clientKeyPassphrase: p.client_key_passphrase ?? "",
      useWs:              p.use_ws ?? false,
      wsPath:             p.ws_path ?? "",
    });
    setActiveProfile(p.name);
  }

  // Persist active profile (any change — via header picker, ConnectionView, etc.)
  useEffect(() => {
    if (activeProfile) {
      try { localStorage.setItem("amqpush.lastProfile", activeProfile); } catch {}
    }
  }, [activeProfile]);

  // ─── Auto-connect to last used profile on startup ─────────────────────────
  // Runs once when profiles are first loaded — applies last-used profile and
  // attempts to connect with it.
  const autoConnectAttempted = useRef(false);
  useEffect(() => {
    if (autoConnectAttempted.current) return;
    if (profiles.length === 0) return;
    autoConnectAttempted.current = true;

    const lastName = localStorage.getItem("amqpush.lastProfile");
    let target: Profile | undefined;
    if (lastName) {
      target = profiles.find(p => p.name === lastName);
      if (!target) {
        addLog("info", `Last-used profile '${lastName}' is gone — picking first available`);
      }
    }
    // Fallback: if no lastProfile saved or it's missing, use the first profile
    if (!target) target = profiles[0];
    if (!target) return;

    applyProfile(target);
    addLog("info", `Auto-connecting to '${target.name}' (${target.host}:${target.port})…`);

    (async () => {
      try {
        await invoke("connect", {
          host: target.host, port: target.port, address: target.queue,
          username: target.username, password: target.password, useTls: target.use_tls,
          containerId: target.container_id ?? "",
          heartbeatSecs: target.heartbeat_secs ?? 0,
          connectTimeoutSecs: target.connect_timeout_secs ?? 10,
          saslAnonymous: target.sasl_anonymous ?? false,
          tlsSkipVerify: target.tls_skip_verify ?? false,
          reconnectBaseMs: target.reconnect_base_ms ?? 1000,
          reconnectMaxMs: target.reconnect_max_ms ?? 30000,
          reconnectMultiplier: target.reconnect_multiplier ?? 2,
          sendRetryAttempts: target.send_retry_attempts ?? 1,
          sendRetryDelayMs: target.send_retry_delay_ms ?? 250,
          clientCertPath: target.client_cert_path || null,
          clientKeyPath: target.client_key_path || null,
          clientKeyPassphrase: target.client_key_passphrase || null,
          useWs: target.use_ws ?? false,
          wsPath: target.ws_path || null,
        });
        handleConnected(target.queue);
        addLog("ok", `Auto-connected → ${target.host}:${target.port}${target.queue ? `  (${target.queue})` : ""}  via '${target.name}'`);
      } catch (e) {
        addLog("err", `Auto-connect to '${target.name}' failed: ${e}`);
      }
    })();
  }, [profiles]);

  const [showHelp, setShowHelp] = useState(false);
  /** Mirrors PublisherView's currently-active tab so we can open Help
   *  directly on the matching section (e.g. clicking ? while on the CSV
   *  tab jumps to "CSV bulk send" instead of dropping the user on the
   *  generic Send page). Updated via PublisherView's onTabChange. */
  const [pubTab, setPubTab] = useState<string>("body");
  /** Latest broker round-trip latency in ms. `null` when we haven't probed
   *  yet (or the broker isn't reachable). Refreshed every 5s by the polling
   *  effect below — surfaces in the header next to the Connected dot. */
  const [brokerLatencyMs, setBrokerLatencyMs] = useState<number | null>(null);
  /** Confirm dialog before wiping the log buffer via the Cmd+K palette.
   *  ConsoleView's in-view Clear button has its own confirm; this one is
   *  the parallel for the palette path so both routes are gated. */
  const [confirmClearLogs, setConfirmClearLogs] = useState(false);
  const [paletteOpen,   setPaletteOpen]   = useState(false);
  const publisherView = (
    <PublisherView
      connected={connected}
      defaultAddress={defaultAddress}
      activeProfile={activeProfile}
      resendPayload={resendPayload}
      sendTrigger={sendTrigger}
      onLog={addLog}
      onSent={trackSent}
      onSendError={trackSendError}
      onTabChange={setPubTab}
    />
  );

  const subscriberView = (
    <SubscriberView
      connected={connected}
      defaultAddress={defaultAddress}
      activeProfile={activeProfile}
      pendingAddress={pendingSubAddr}
      onLog={addLog}
      onMessageReceived={trackReceived}
      onReply={handleResend}
    />
  );

  // Recent log indicator (last entry kind for header dot)
  const lastLog = logs[logs.length - 1];
  const logDotColor = !lastLog ? "" :
    lastLog.kind === "err" ? "bg-negative" :
    lastLog.kind === "ok"  ? "bg-positive" :
    "bg-t-ink4";

  return (
    // Раздел занимает то, что осталось от окна, а не всё окно: над ним
    // шапка приложения с переключателем стенда и ходом работы.
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-6 pb-4 select-none">
      {/*
        Полоса раздела — карточкой, как полоса показателей на остальных
        экранах: профиль и состояние подключения слева, журнал и справка
        справа. Прежде она шла сплошной шапкой во всю ширину и читалась
        второй шапкой приложения.
      */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-5 py-2.5">

        {/* ─── LEFT: Profile + Connection state ─── */}
        <div className="flex items-center gap-2">
          {/* Profile picker — globally visible across all views */}
          <Dropdown
            align="left"
            width="w-72"
            trigger={({ open, toggle }) => (
              <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                aria-label={t("shell.profile.switch")}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-t-ink3 hover:text-t-ink hover:bg-t-hover transition-colors text-[12.5px] border border-t-line"
                title={t("shell.profile.switch")}
              >
                <User className="w-3 h-3 text-t-ink4" />
                <span className="font-medium">{activeProfile || <span className="italic text-t-ink5">{t("shell.profile.none")}</span>}</span>
                <ChevronDown className="w-3 h-3 text-t-ink4" />
              </button>
            )}
          >
            {profiles.length === 0 ? (
              <DropdownSection title={t("shell.profile.section")}>
                <p className="text-[11.5px] text-t-ink5 text-center py-3">{t("shell.profile.empty")}</p>
              </DropdownSection>
            ) : (
              // Group profiles by workspace. Stable workspace order: alphabetical,
              // but "Default" always last so user-named groups float to the top.
              (() => {
                const groups = new Map<string, Profile[]>();
                for (const p of profiles) {
                  const ws = (p.workspace ?? "").trim() || "Default";
                  if (!groups.has(ws)) groups.set(ws, []);
                  groups.get(ws)!.push(p);
                }
                const ordered = [...groups.entries()].sort(([a], [b]) => {
                  if (a === "Default") return 1;
                  if (b === "Default") return -1;
                  return a.localeCompare(b);
                });
                return ordered.map(([ws, items]) => (
                  <DropdownSection key={ws} title={ws}>
                    {items.map(p => (
                      <DropdownItem
                        key={p.name}
                        active={p.name === activeProfile}
                        onClick={() => applyProfile(p)}
                        trailing={`${p.host}:${p.port}${p.use_tls ? " · TLS" : ""}`}
                      >
                        {p.name}
                      </DropdownItem>
                    ))}
                  </DropdownSection>
                ));
              })()
            )}
            <DropdownFooter>
              <button
                onClick={() => changeView("connection")}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-t-hover transition-colors text-[12.5px] text-accent hover:text-accent-content"
              >
                <Plug className="w-3 h-3" />
                Manage profiles…
              </button>
            </DropdownFooter>
          </Dropdown>

          {/* Connection status. When connected, the green dot is followed by
              a live latency chip — broker round-trip every 5 s via the
              cheapest possible management RPC. Visible degradation in network
              or broker health surfaces immediately, before sends/recvs stall. */}
          <div className="flex items-center gap-1.5 px-2">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${connected ? "bg-positive" : "bg-t-ink5"}`} />
            <span className={`text-[11.5px] font-medium hidden sm:inline ${connected ? "text-positive" : "text-t-ink4"}`}>
              {connected ? t("shell.connected") : t("shell.disconnected")}
            </span>
            {connected && brokerLatencyMs !== null && (
              <span
                className={`text-[11.5px] font-mono ${
                  brokerLatencyMs < 100 ? "text-t-ink4"
                  : brokerLatencyMs < 500 ? "text-caution"
                  : "text-negative"
                }`}
                title={t("shell.latency.hint")}
              >
                {brokerLatencyMs}ms
              </span>
            )}
          </div>
        </div>

        {/* ─── RIGHT: stats + console + theme ─── */}
        <div className="flex items-center gap-2">
          {(stats.sentCount > 0 || stats.receivedCount > 0) && (
            <span className="text-[11.5px] text-t-ink5 font-mono">
              ↑{stats.sentCount} ↓{stats.receivedCount}
            </span>
          )}

          {view !== "console" && (
            <button
              onClick={() => changeView("console")}
              title={`${t("shell.logs")} — ${t("shell.logs.count", { count: logs.length })}  ⌘L`}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg transition-colors text-[11.5px] border ${
                lastLog?.kind === "err"
                  ? "border-negative/30 text-negative hover:bg-negative/10"
                  : "border-t-line text-t-ink4 hover:text-t-ink hover:bg-t-hover"
              }`}
            >
              <Terminal className="w-3 h-3" />
              <span>{t("shell.logs")}</span>
              {logs.length > 0 && (
                <>
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${logDotColor}`} />
                  <span className="font-mono text-t-ink5">{logs.length}</span>
                </>
              )}
            </button>
          )}

          {/* Help — opens the in-app guide */}
          <button
            type="button"
            onClick={() => setShowHelp(true)}
            title={t("shell.help.hint")}
            aria-label={t("shell.help")}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors text-[12.5px]"
          >
            <HelpCircle className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{t("shell.help")}</span>
          </button>

        </div>
      </header>

      {/* Body */}
      <div className="isolate flex flex-1 min-h-0 overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {/*
            All views stay mounted — visibility toggled via CSS so state is preserved
            across navigation. The container is a flex-row so split view can show
            publisher + subscriber side-by-side simultaneously.
          */}
          <div className="flex-1 overflow-hidden flex min-h-0">

            {/* Publisher pane */}
            <div className={view === "publisher" ? "flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden" : "hidden"}>
              {publisherView}
            </div>

            {/* Subscriber pane */}
            <div className={view === "subscriber" ? "flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden" : "hidden"}>
              {subscriberView}
            </div>

            {/* Browser */}
            <div className={view === "browser" ? "flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden" : "hidden"}>
              <BrowserView connected={connected} visible={view === "browser"} onLog={addLog} onPublishTo={handlePublishTo} onSubscribeTo={handleSubscribeTo} profiles={profiles} activeProfile={activeProfile} />
            </div>

            {/* Inspector */}
            <div className={view === "inspector" ? "flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden" : "hidden"}>
              <InspectorView connected={connected} visible={view === "inspector"} onLog={addLog} />
            </div>

            {/* History */}
            <div className={view === "history" ? "flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden" : "hidden"}>
              <HistoryView connected={connected} refreshVersion={historyVersion} onLog={addLog} onResend={handleResend} />
            </div>

            {/* Stats */}
            <div className={view === "stats" ? "flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden" : "hidden"}>
              <StatsView statsByProfile={statsByProfile} activeProfile={activeProfile} />
            </div>

            {/* Console */}
            <div className={view === "console" ? "flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden" : "hidden"}>
              <ConsoleView logs={logs} onClear={() => setLogs([])} />
            </div>

            {/* Connection */}
            <div className={view === "connection" ? "flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden" : "hidden"}>
              <ConnectionView
                connected={connected}
                form={connForm}
                setForm={setConnForm}
                logs={logs}
                profiles={profiles}
                activeProfile={activeProfile}
                onProfilesChanged={loadProfiles}
                onProfileSelected={(name) => setActiveProfile(name)}
                onConnected={handleConnected}
                onDisconnected={() => setConnected(false)}
                onLog={addLog}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ─── COMMAND PALETTE ─── */}
      {paletteOpen && (
        <CommandPalette
          actions={buildPaletteActions({
            view,
            connected,
            profiles,
            activeProfile,
            applyProfile,
            changeView,
            triggerSend: () => setSendTrigger(n => n + 1),
            disconnect: async () => {
              try { await invoke("disconnect"); setConnected(false); addLog("info", "Disconnected"); }
              catch (e) { addLog("err", String(e)); }
            },
            clearLogs: () => setConfirmClearLogs(true),
            showHelp: () => setShowHelp(true),
          })}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {/* ─── HELP MODAL ─── */}
      {showHelp && (
        <HelpModal
          initialSection={helpSectionFor(view, pubTab)}
          onClose={() => setShowHelp(false)}
        />
      )}

      {/* ─── CLEAR-LOGS CONFIRM (Cmd+K route) ─── */}
      <ConfirmDialog
        open={confirmClearLogs}
        title={t("shell.logs.clear")}
        body={
          <p>
            Permanently delete{" "}
            <span className="font-mono font-bold text-t-ink">{logs.length.toLocaleString()}</span>{" "}
            log entr{logs.length === 1 ? "y" : "ies"}? This wipes the in-memory
            buffer <i>and</i> the persisted copy in <code className="text-t-ink4">localStorage</code>.
          </p>
        }
        confirmLabel={`Delete ${logs.length.toLocaleString()} entr${logs.length === 1 ? "y" : "ies"}`}
        onConfirm={() => { setLogs([]); setConfirmClearLogs(false); }}
        onCancel={() => setConfirmClearLogs(false)}
      />
    </div>
  );
}

// ─── Command palette action builder ────────────────────────────────────────

/**
 * Build the list of actions exposed in the Cmd+K palette. Pulls everything
 * from a single options bag so the closures all share the up-to-date App
 * state — actions are rebuilt on each render (cheap), so each invocation
 * sees the freshest `view` / `connected` / `profiles` etc.
 */
function buildPaletteActions(opts: {
  view: View;
  connected: boolean;
  profiles: Profile[];
  activeProfile: string;
  applyProfile: (p: Profile) => void;
  changeView: (v: View) => void;
  triggerSend: () => void;
  disconnect: () => Promise<void>;
  clearLogs: () => void;
  showHelp: () => void;
}): PaletteAction[] {
  const out: PaletteAction[] = [];

  // ── Navigation ──
  const VIEWS: { id: View; label: string; kbd: string; icon: React.ReactNode }[] = [
    { id: "connection", label: "Go to Connection", kbd: "⌘1", icon: <Plug      className="w-3.5 h-3.5" /> },
    { id: "publisher",  label: "Go to Send",       kbd: "⌘2", icon: <Sparkles  className="w-3.5 h-3.5" /> },
    { id: "subscriber", label: "Go to Receive",    kbd: "⌘3", icon: <Sparkles  className="w-3.5 h-3.5" /> },
    { id: "browser",    label: "Go to Browser",    kbd: "⌘4", icon: <Sparkles  className="w-3.5 h-3.5" /> },
    { id: "inspector",  label: "Go to Clients",    kbd: "⌘5", icon: <Sparkles  className="w-3.5 h-3.5" /> },
    { id: "history",    label: "Go to History",    kbd: "⌘6", icon: <Sparkles  className="w-3.5 h-3.5" /> },
    { id: "stats",      label: "Go to Stats",      kbd: "⌘7", icon: <Sparkles  className="w-3.5 h-3.5" /> },
    { id: "console",    label: "Go to Logs",       kbd: "⌘8", icon: <Terminal  className="w-3.5 h-3.5" /> },
  ];
  for (const v of VIEWS) {
    out.push({
      id:      `view:${v.id}`,
      label:   v.label,
      hint:    opts.view === v.id ? "Currently active" : undefined,
      category: "Navigation",
      icon:    v.icon,
      kbd:     v.kbd,
      disabled: opts.view === v.id,
      run:     () => opts.changeView(v.id),
    });
  }

  // ── Actions ──
  if (opts.view === "publisher") {
    out.push({
      id:      "send:trigger",
      label:   "Send message now",
      hint:    "Same as Cmd+Enter inside the Send view",
      category: "Actions",
      icon:    <Sparkles className="w-3.5 h-3.5" />,
      kbd:     "⌘↵",
      disabled: !opts.connected,
      run:     opts.triggerSend,
    });
  }
  if (opts.connected) {
    out.push({
      id:      "conn:disconnect",
      label:   "Disconnect from broker",
      category: "Actions",
      icon:    <Plug className="w-3.5 h-3.5" />,
      run:     () => { void opts.disconnect(); },
    });
  } else {
    out.push({
      id:      "conn:connect",
      label:   "Open Connection view to connect",
      category: "Actions",
      icon:    <Plug className="w-3.5 h-3.5" />,
      run:     () => opts.changeView("connection"),
    });
  }
  out.push({
    id:      "logs:clear",
    label:   "Clear all logs",
    category: "Actions",
    icon:    <Terminal className="w-3.5 h-3.5" />,
    run:     opts.clearLogs,
  });
  out.push({
    id:      "help:open",
    label:   "Open Help",
    hint:    "In-app guide for every feature",
    category: "Actions",
    icon:    <HelpCircle className="w-3.5 h-3.5" />,
    kbd:     "?",
    run:     opts.showHelp,
  });
  // ── Profiles — categorise by workspace so the palette mirrors the
  //    grouped header dropdown. "Default" workspace is folded into a plain
  //    "Profiles" header for the common case where no grouping is in use.
  for (const p of opts.profiles) {
    const ws = (p.workspace ?? "").trim() || "Default";
    const cat = ws === "Default" ? "Profiles" : `Profiles · ${ws}`;
    out.push({
      id:      `profile:${p.name}`,
      label:   `Switch to profile: ${p.name}`,
      hint:    `${p.host}:${p.port}${p.use_tls ? " · TLS" : ""}`,
      category: cat,
      icon:    <User className="w-3.5 h-3.5" />,
      disabled: p.name === opts.activeProfile,
      run:     () => opts.applyProfile(p),
    });
  }

  return out;
}
