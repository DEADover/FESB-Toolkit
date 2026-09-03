import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { HelpCircle, Plug, Sparkles, Terminal } from "lucide-react";
import PublisherView from "./components/views/PublisherView";
import SubscriberView from "./components/views/SubscriberView";
import HistoryView from "./components/views/HistoryView";
import StatsView, { StatsData, emptyStats, trackSentInStats, trackReceivedInStats, trackSendErrorInStats } from "./components/views/StatsView";
import ConsoleView from "./components/views/ConsoleView";
import BrowserView from "./components/views/BrowserView";
import InspectorView from "./components/views/InspectorView";
import CommandPalette, { PaletteAction } from "./components/CommandPalette";
import HelpModal from "./components/help/HelpModal";
import ConfirmDialog from "./components/ConfirmDialog";
import { useAmqpText } from "./i18n";
import { errorText } from "../lib/errors";
import { LogEntry, View, Profile } from "./types";
import { invoke } from "@tauri-apps/api/core";
import "./amqpush.css";

let logId = 0;

const VIEW_KEYS: Record<string, View> = {
  "1": "publisher", "2": "subscriber", "3": "browser", "4": "inspector",
  "5": "history",   "6": "stats",      "7": "console",
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
/**
 * Место в шапке приложения, куда раздел кладёт своё.
 *
 * Узел шапки появляется в том же кадре, что и раздел, поэтому ищем его
 * после отрисовки, а до тех пор не показываем ничего.
 */
function HeaderChip({ children }: { children: React.ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.getElementById("header-chip")), []);
  return host ? createPortal(children, host) : null;
}

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
export function AmqpushScreen({ view, visible, onView, stand, stands, onConfigure }: {
  /** Какой экран показывать. Выбирается боковой панелью приложения. */
  view: View;
  /**
   * Открыт ли раздел сейчас. После первого открытия он остаётся в дереве,
   * чтобы не терять принятые сообщения, — но подключаться к брокеру, пока
   * его не видно, незачем.
   */
  visible: boolean;
  /** Смена экрана изнутри: горячие клавиши и ссылки «отправить сюда». */
  onView: (view: View) => void;
  /**
   * Брокер выбранного стенда. Раздел не заводит своих профилей: стенд один
   * на приложение, и брокер — его часть, а не отдельная сущность.
   */
  stand: Profile | null;
  /** Остальные стенды — для переливки сообщений между брокерами. */
  stands: Profile[];
  /** Куда отправить за настройками, когда брокер не задан. */
  onConfigure: () => void;
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
  // Профилей у раздела своих нет: стенд приходит снаружи, его имя и служит
  // ключом для статистики по стендам.
  const activeProfile = stand?.name ?? "";
  /** Статистика по стендам: `""` — ведро «стенд неизвестен» (быстрая
   *  отправка из палитры). Всё, что считается, пишется в ведро текущего
   *  стенда, чтобы в «Статистике» дев и прод стояли рядом. */
  const [statsByProfile, setStatsByProfile] = useState<Record<string, StatsData>>({});

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

  /**
   * Подключение к брокеру стенда.
   *
   * Параметры целиком приходят из профиля: свои поля раздел больше не
   * держит. Без стенда подключаться не к чему — отправляем настраивать.
   */
  const [connecting, setConnecting] = useState(false);
  async function connectStand() {
    if (!stand || !stand.host) { onConfigure(); return; }
    setConnecting(true);
    try {
      await invoke("connect", {
        host: stand.host,
        port: stand.port,
        address: stand.queue,
        username: stand.username,
        password: stand.password,
        useTls: stand.use_tls,
        containerId: stand.container_id ?? "",
        heartbeatSecs: stand.heartbeat_secs ?? 0,
        connectTimeoutSecs: stand.connect_timeout_secs ?? 10,
        saslAnonymous: stand.sasl_anonymous ?? false,
        tlsSkipVerify: stand.tls_skip_verify ?? false,
        reconnectBaseMs: stand.reconnect_base_ms ?? 1000,
        reconnectMaxMs: stand.reconnect_max_ms ?? 30000,
        reconnectMultiplier: stand.reconnect_multiplier ?? 2,
        sendRetryAttempts: stand.send_retry_attempts ?? 1,
        sendRetryDelayMs: stand.send_retry_delay_ms ?? 250,
        clientCertPath: stand.client_cert_path ?? null,
        clientKeyPath: stand.client_key_path ?? null,
        clientKeyPassphrase: stand.client_key_passphrase ?? null,
        useWs: stand.use_ws ?? false,
        wsPath: stand.ws_path ?? null,
      });
      handleConnected(stand.queue);
      addLog("ok", t("shell.connected") + ` → ${stand.host}:${stand.port}`);
    } catch (e) {
      addLog("err", `${t("shell.connect.failed")}: ${errorText(e)}`);
    } finally {
      setConnecting(false);
    }
  }

  /** Чем стенд отличается от прежнего: имя брокера, порт и очередь. */
  const standKey = stand ? `${stand.host}:${stand.port}/${stand.queue}` : "";

  async function disconnectStand() {
    try {
      await invoke("disconnect");
      setConnected(false);
      addLog("info", t("shell.disconnected"));
    } catch (e) {
      addLog("err", String(e));
    }
  }

  /**
   * Открыли раздел — подключаемся к брокеру выбранного стенда.
   *
   * Стенд уже выбран в шапке приложения, и брокер — его часть: спрашивать
   * «подключиться?» второй раз значит переспрашивать того, кто уже ответил.
   * Одна попытка на стенд: если она не удалась или пользователь отключился
   * сам, навязываться снова не нужно — рядом есть кнопка.
   */
  const autoTried = useRef("");
  useEffect(() => {
    if (!visible || !stand?.host || connected || connecting) return;
    if (autoTried.current === standKey) return;
    autoTried.current = standKey;
    void connectStand();
    // Хватает ключа стенда и того, открыт ли раздел.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, standKey, connected, connecting]);

  /**
   * Сменили стенд — отключаемся от прежнего брокера.
   *
   * Иначе шапка называла бы новый стенд, а сокет вёл бы к старому: отправки
   * уходили бы не туда, куда написано. Подключение к новому брокеру остаётся
   * осознанным действием, само оно не происходит.
   */
  useEffect(() => {
    if (!connected) return;
    void invoke("disconnect")
      .then(() => { setConnected(false); addLog("info", t("shell.stand.changed")); })
      .catch((e) => addLog("err", String(e)));
    // Реагируем на смену стенда, а не на само подключение.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standKey]);

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
      latencyMs={brokerLatencyMs}
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

  return (
    // Раздел занимает то, что осталось от окна, а не всё окно: над ним
    // шапка приложения с переключателем стенда и ходом работы.
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-6 pb-4 select-none">
      {/*
        Своей строки у раздела больше нет: она повторяла переключатель стенда
        из шапки приложения и занимала место над каждым экраном. В шапку
        уезжает то, чего в переключателе нет, — состояние брокера и справка.
      */}
      <HeaderChip>
        {/*
          Адреса брокера в шапке нет: стенд назван переключателем рядом,
          а состояние подключения видно там, где оно нужно, — в строке
          состояния экрана отправки и приёма. Остаётся справка.
        */}
        <button
          type="button"
          onClick={() => setShowHelp(true)}
          title={t("shell.help.hint")}
          aria-label={t("shell.help")}
          className="grid size-9 shrink-0 place-items-center rounded-lg border border-t-line2 bg-t-panel text-t-ink4 transition hover:bg-t-hover hover:text-t-ink"
        >
          <HelpCircle className="w-4 h-4" />
        </button>
      </HeaderChip>

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
              <BrowserView connected={connected} visible={view === "browser"} onLog={addLog} onPublishTo={handlePublishTo} onSubscribeTo={handleSubscribeTo} profiles={stands} activeProfile={activeProfile} />
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

          </div>
        </div>
      </div>

      {/* ─── COMMAND PALETTE ─── */}
      {paletteOpen && (
        <CommandPalette
          actions={buildPaletteActions({
            view,
            connected,
            changeView,
            triggerSend: () => setSendTrigger(n => n + 1),
            connect: connectStand,
            disconnect: disconnectStand,
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
  changeView: (v: View) => void;
  triggerSend: () => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  clearLogs: () => void;
  showHelp: () => void;
}): PaletteAction[] {
  const out: PaletteAction[] = [];

  // ── Navigation ──
  const VIEWS: { id: View; label: string; kbd: string; icon: React.ReactNode }[] = [
    { id: "publisher",  label: "Go to Send",     kbd: "⌘1", icon: <Sparkles  className="w-3.5 h-3.5" /> },
    { id: "subscriber", label: "Go to Receive",  kbd: "⌘2", icon: <Sparkles  className="w-3.5 h-3.5" /> },
    { id: "browser",    label: "Go to Browser",  kbd: "⌘3", icon: <Sparkles  className="w-3.5 h-3.5" /> },
    { id: "inspector",  label: "Go to Clients",  kbd: "⌘4", icon: <Sparkles  className="w-3.5 h-3.5" /> },
    { id: "history",    label: "Go to History",  kbd: "⌘5", icon: <Sparkles  className="w-3.5 h-3.5" /> },
    { id: "stats",      label: "Go to Stats",    kbd: "⌘6", icon: <Sparkles  className="w-3.5 h-3.5" /> },
    { id: "console",    label: "Go to Logs",     kbd: "⌘7", icon: <Terminal  className="w-3.5 h-3.5" /> },
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
      label:   "Connect to broker",
      hint:    "Uses the broker of the selected stand",
      category: "Actions",
      icon:    <Plug className="w-3.5 h-3.5" />,
      run:     () => { void opts.connect(); },
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
  return out;
}
