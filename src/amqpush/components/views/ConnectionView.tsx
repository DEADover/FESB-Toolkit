import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Save, Trash2, Plug, Unplug, Loader2, Settings2, Plus, Copy, CheckCircle, XCircle, Info, Activity, SlidersHorizontal, Sliders, FolderOpen, AlertTriangle, MoreVertical, Download as DownloadIcon, Upload, Zap, X } from "lucide-react";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { Profile, LogEntry } from "../../types";
import Tabs, { TabItem } from "../Tabs";
import ViewTopBar from "../ViewTopBar";
import SectionLabel from "../SectionLabel";
import { useAmqpText } from "../../i18n";
import Toggle from "../Toggle";
import Callout from "../Callout";
import Dropdown, { DropdownItem, DropdownFooter } from "../Dropdown";

type MainTab = "main" | "advanced";

export interface ConnForm {
  host: string;
  port: string;
  username: string;
  password: string;
  queue: string;          // optional — empty allowed
  useTls: boolean;

  // Advanced
  containerId: string;            // empty = auto-generated UUID
  heartbeatSecs: string;          // 0 / empty = disabled
  connectTimeoutSecs: string;     // 0 = no timeout
  tlsSkipVerify: boolean;
  saslAnonymous: boolean;

  /** Workspace / grouping label. Empty resolves to "Default". */
  workspace: string;

  // Reconnect backoff (subscriber). String-typed for the form; parsed
  // to numbers on save / connect. Empty → backend defaults.
  reconnectBaseMs: string;
  reconnectMaxMs: string;
  reconnectMultiplier: string;

  // Send retry budget (publisher). attempts = 1 disables retry.
  sendRetryAttempts: string;
  sendRetryDelayMs: string;

  // mTLS client certificate (optional). Empty strings = no client cert.
  // Cert path is either a PEM `.crt` (in which case key path is required)
  // or a PKCS#12 `.p12`/`.pfx` bundle (in which case passphrase is used and
  // key path is ignored).
  clientCertPath: string;
  clientKeyPath: string;
  clientKeyPassphrase: string;

  // WebSocket transport (ws:// or wss://) — opt-in, defaults to plain TCP.
  useWs: boolean;
  wsPath: string;
}

interface Props {
  connected: boolean;
  form: ConnForm;
  setForm: React.Dispatch<React.SetStateAction<ConnForm>>;
  logs: LogEntry[];
  profiles: Profile[];
  activeProfile: string;
  onProfilesChanged: () => Promise<void> | void;
  onProfileSelected: (name: string) => void;
  onConnected: (addr: string) => void;
  onDisconnected: () => void;
  onLog: (kind: "info" | "ok" | "err", text: string) => void;
}

// Canonical form-label class: matches `<SectionLabel>` typography
// (`font-semibold tracking-wider`) so labels never drift from section headings.
const LABEL = "block text-[10.5px] font-semibold text-t-ink4 uppercase tracking-wider mb-1.5";
const INPUT = "w-full bg-t-field border border-t-line2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-t-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-all placeholder:text-t-ink5";

const DEFAULTS: ConnForm = {
  host: "127.0.0.1",
  port: "61616",
  username: "",
  password: "",
  queue: "",
  useTls: false,
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
};

// Heuristic: which log entries are "connection-related" — to filter the activity panel
const CONN_KEYWORDS = /connect|disconnect|broker|listen|subscriber|reconnect|profile|amqp|tls|auth|reachable|verify|discover/i;

export default function ConnectionView({ connected, form, setForm, logs, profiles, activeProfile, onProfilesChanged, onProfileSelected, onConnected, onDisconnected, onLog }: Props) {
  const t = useAmqpText();
  const sel = activeProfile;
  const setSel = onProfileSelected;
  const [loaded,      setLoaded]      = useState<Profile | null>(null); // last loaded — to detect unsaved changes
  const [connecting,  setConnecting]  = useState(false);
  const [savingAs,    setSavingAs]    = useState(false);       // showing inline name prompt
  const [newName,     setNewName]     = useState("");
  const [confirmDel,  setConfirmDel]  = useState(false);       // delete confirmation
  const [quickConnectOpen, setQuickConnectOpen] = useState(false);

  // Form value shorthands — pull from props
  const { host, port, username, password, queue, useTls } = form;
  const { containerId, heartbeatSecs, connectTimeoutSecs, tlsSkipVerify, saslAnonymous, workspace } = form;
  const { reconnectBaseMs, reconnectMaxMs, reconnectMultiplier } = form;
  const { sendRetryAttempts, sendRetryDelayMs } = form;
  const setSendRetryAttempts = (v: string) => setForm(f => ({ ...f, sendRetryAttempts: v }));
  const setSendRetryDelayMs  = (v: string) => setForm(f => ({ ...f, sendRetryDelayMs: v }));
  const { clientCertPath, clientKeyPath, clientKeyPassphrase } = form;
  const setClientCertPath       = (v: string) => setForm(f => ({ ...f, clientCertPath: v }));
  const setClientKeyPath        = (v: string) => setForm(f => ({ ...f, clientKeyPath: v }));
  const setClientKeyPassphrase  = (v: string) => setForm(f => ({ ...f, clientKeyPassphrase: v }));
  const { useWs, wsPath } = form;
  const setUseWs                = (v: boolean) => setForm(f => ({ ...f, useWs: v }));
  const setWsPath               = (v: string)  => setForm(f => ({ ...f, wsPath: v }));
  const setHost     = (v: string) => setForm(f => ({ ...f, host: v }));
  const setPort     = (v: string) => setForm(f => ({ ...f, port: v }));
  const setUsername = (v: string) => setForm(f => ({ ...f, username: v }));
  const setPassword = (v: string) => setForm(f => ({ ...f, password: v }));
  const setQueue    = (v: string) => setForm(f => ({ ...f, queue: v }));
  const setUseTls   = (v: boolean) => setForm(f => ({ ...f, useTls: v }));
  const setContainerId        = (v: string)  => setForm(f => ({ ...f, containerId: v }));
  const setHeartbeatSecs      = (v: string)  => setForm(f => ({ ...f, heartbeatSecs: v }));
  const setConnectTimeoutSecs = (v: string)  => setForm(f => ({ ...f, connectTimeoutSecs: v }));
  const setTlsSkipVerify      = (v: boolean) => setForm(f => ({ ...f, tlsSkipVerify: v }));
  const setSaslAnonymous      = (v: boolean) => setForm(f => ({ ...f, saslAnonymous: v }));
  const setWorkspace          = (v: string)  => setForm(f => ({ ...f, workspace: v }));
  const setReconnectBaseMs    = (v: string)  => setForm(f => ({ ...f, reconnectBaseMs: v }));
  const setReconnectMaxMs     = (v: string)  => setForm(f => ({ ...f, reconnectMaxMs: v }));
  const setReconnectMult      = (v: string)  => setForm(f => ({ ...f, reconnectMultiplier: v }));

  // Existing workspace labels (deduped) + how many profiles each one holds.
  // Counts drive the workspace combobox's delete affordance — deleting a
  // workspace moves all its profiles back to "Default" rather than removing
  // them, so the user needs to see the headcount before confirming.
  const workspaceUsage = useMemo(() => {
    const counts = new Map<string, number>();
    counts.set("Default", 0); // always show even when no profile uses it
    for (const p of profiles) {
      const ws = ((p.workspace ?? "").trim() || "Default");
      counts.set(ws, (counts.get(ws) ?? 0) + 1);
    }
    return counts;
  }, [profiles]);
  const workspaceSuggestions = useMemo(() => {
    return [...workspaceUsage.keys()].sort(
      (a, b) => a === "Default" ? 1 : b === "Default" ? -1 : a.localeCompare(b),
    );
  }, [workspaceUsage]);

  // Delete a workspace by moving every profile under it back to "Default".
  // Called from WorkspaceCombobox; iterates through profiles and saves each
  // updated copy, then refreshes the list. Also rewrites the open form's
  // workspace field if it happened to match — otherwise saving the current
  // edit would re-create the workspace immediately.
  async function deleteWorkspace(name: string): Promise<void> {
    const affected = profiles.filter(p => ((p.workspace ?? "").trim() || "Default") === name);
    for (const p of affected) {
      try {
        await invoke("save_profile", { profile: { ...p, workspace: "Default" } });
      } catch (e) {
        onLog("err", `Workspace move (${p.name}): ${String(e)}`);
      }
    }
    if ((workspace.trim() || "Default") === name) {
      setWorkspace("Default");
    }
    await onProfilesChanged();
    onLog("info", `Workspace '${name}' deleted — ${affected.length} profile${affected.length === 1 ? "" : "s"} moved to Default`);
  }

  const [tab, setTab] = useState<MainTab>("main");
  // Detect if any "Advanced" field has a non-default value — show a dot on the Advanced tab
  const advancedDirty =
    !!queue ||
    useTls ||
    tlsSkipVerify ||
    !!containerId ||
    (Number(heartbeatSecs) || 0) > 0 ||
    (Number(connectTimeoutSecs) || 10) !== 10 ||
    !!clientCertPath ||
    !!clientKeyPath ||
    !!clientKeyPassphrase ||
    (Number(sendRetryAttempts) || 1) !== 1 ||
    (Number(sendRetryDelayMs) || 250) !== 250;

  const logsBottomRef = useRef<HTMLDivElement>(null);

  // Auto-select first profile when list arrives and nothing's selected yet
  useEffect(() => {
    if (profiles.length > 0 && !sel) {
      apply(profiles[0]);
      setSel(profiles[0].name);
      setLoaded(profiles[0]);
    }
    // Sync `loaded` when activeProfile changes externally (e.g. via status bar)
    if (sel) {
      const p = profiles.find(p => p.name === sel);
      if (p && (!loaded || loaded.name !== sel)) {
        setLoaded(p);
      }
    }
  }, [profiles, sel]);

  function apply(p: Profile) {
    setForm({
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
  }

  function selectProfile(p: Profile) {
    apply(p);
    setSel(p.name);
    setLoaded(p);
  }

  function newProfile() {
    setForm(DEFAULTS);
    setSel("");
    setLoaded(null);
  }

  // Detect unsaved changes by comparing current form to loaded profile
  const dirty = useMemo(() => {
    if (!loaded) return false;
    return loaded.host !== host
        || loaded.port !== Number(port)
        || loaded.username !== username
        || loaded.password !== password
        || loaded.queue !== queue
        || loaded.use_tls !== useTls
        || (loaded.container_id ?? "") !== containerId
        || (loaded.heartbeat_secs ?? 0) !== (Number(heartbeatSecs) || 0)
        || (loaded.connect_timeout_secs ?? 10) !== (Number(connectTimeoutSecs) || 0)
        || (loaded.tls_skip_verify ?? false) !== tlsSkipVerify
        || (loaded.sasl_anonymous ?? false) !== saslAnonymous
        || ((loaded.workspace ?? "").trim() || "Default") !== (workspace.trim() || "Default")
        || (loaded.reconnect_base_ms ?? 1000) !== (Number(reconnectBaseMs) || 1000)
        || (loaded.reconnect_max_ms ?? 30000) !== (Number(reconnectMaxMs) || 30000)
        || (loaded.reconnect_multiplier ?? 2) !== (Number(reconnectMultiplier) || 2)
        || (loaded.send_retry_attempts ?? 1) !== (Number(sendRetryAttempts) || 1)
        || (loaded.send_retry_delay_ms ?? 250) !== (Number(sendRetryDelayMs) || 250)
        || (loaded.client_cert_path ?? "") !== clientCertPath
        || (loaded.client_key_path ?? "") !== clientKeyPath
        || (loaded.client_key_passphrase ?? "") !== clientKeyPassphrase
        || (loaded.use_ws ?? false) !== useWs
        || (loaded.ws_path ?? "") !== wsPath;
  }, [loaded, host, port, username, password, queue, useTls,
      containerId, heartbeatSecs, connectTimeoutSecs, tlsSkipVerify, saslAnonymous, workspace,
      reconnectBaseMs, reconnectMaxMs, reconnectMultiplier,
      sendRetryAttempts, sendRetryDelayMs,
      clientCertPath, clientKeyPath, clientKeyPassphrase,
      useWs, wsPath]);

  function buildProfile(name: string): Profile {
    return {
      name,
      host,
      port: Number(port) || 0,
      username,
      password,
      queue,
      use_tls: useTls,
      container_id: containerId,
      heartbeat_secs: Number(heartbeatSecs) || 0,
      connect_timeout_secs: Number(connectTimeoutSecs) || 0,
      tls_skip_verify: tlsSkipVerify,
      sasl_anonymous: saslAnonymous,
      workspace: workspace.trim() || "Default",
      reconnect_base_ms: Math.max(0, Number(reconnectBaseMs) || 1000),
      reconnect_max_ms: Math.max(0, Number(reconnectMaxMs) || 30000),
      reconnect_multiplier: Math.max(1.01, Number(reconnectMultiplier) || 2),
      send_retry_attempts: Math.max(1, Math.floor(Number(sendRetryAttempts) || 1)),
      send_retry_delay_ms: Math.max(0, Number(sendRetryDelayMs) || 250),
      client_cert_path: clientCertPath.trim(),
      client_key_path: clientKeyPath.trim(),
      client_key_passphrase: clientKeyPassphrase,
      use_ws: useWs,
      ws_path: wsPath.trim(),
    };
  }

  // Save changes to currently selected profile
  async function saveChanges() {
    if (!sel) return startSaveAs();
    const p = buildProfile(sel);
    try {
      await invoke("save_profile", { profile: p });
      setLoaded(p);
      await onProfilesChanged();
      onLog("ok", `Profile '${sel}' updated`);
    } catch (e) { onLog("err", `Save failed: ${e}`); }
  }

  // Open inline "Save as…" prompt
  function startSaveAs(suggestedName?: string) {
    const existing = new Set(profiles.map(p => p.name));
    let baseName = suggestedName ?? (sel ? `${sel} (copy)` : `Profile ${profiles.length + 1}`);
    while (existing.has(baseName)) baseName += " (1)";
    setNewName(baseName);
    setSavingAs(true);
    setConfirmDel(false);
  }

  // Confirm new profile creation from inline prompt
  async function confirmSaveAs() {
    const name = newName.trim();
    if (!name) { setSavingAs(false); return; }
    const p = buildProfile(name);
    try {
      await invoke("save_profile", { profile: p });
      await onProfilesChanged();
      setSel(name);
      setLoaded(p);
      setSavingAs(false);
      setNewName("");
      onLog("ok", `Profile '${name}' saved`);
    } catch (e) { onLog("err", `Save failed: ${e}`); }
  }

  function duplicateProfile() {
    if (!sel) return;
    startSaveAs(`${sel} (copy)`);
  }

  function startDelete() {
    if (!sel) return;
    setConfirmDel(true);
    setSavingAs(false);
  }

  async function confirmDelete() {
    if (!sel) return;
    try {
      await invoke("delete_profile", { name: sel });
      onLog("info", `Profile '${sel}' deleted`);
      newProfile();
      await onProfilesChanged();
    } catch (e) { onLog("err", String(e)); }
    setConfirmDel(false);
  }

  async function toggle() {
    if (connected) {
      try { await invoke("disconnect"); onDisconnected(); onLog("info", "Disconnected"); }
      catch (e) { onLog("err", String(e)); }
      return;
    }
    setConnecting(true);
    onLog("info", `Connecting to ${host}:${port}…`);
    try {
      await invoke("connect", {
        host,
        port: Number(port),
        address: queue,
        username,
        password,
        useTls,
        containerId,
        heartbeatSecs:      Number(heartbeatSecs) || 0,
        connectTimeoutSecs: Number(connectTimeoutSecs) || 0,
        saslAnonymous,
        tlsSkipVerify,
        reconnectBaseMs:    Math.max(0, Number(reconnectBaseMs) || 1000),
        reconnectMaxMs:     Math.max(0, Number(reconnectMaxMs) || 30000),
        reconnectMultiplier: Math.max(1.01, Number(reconnectMultiplier) || 2),
        sendRetryAttempts:  Math.max(1, Math.floor(Number(sendRetryAttempts) || 1)),
        sendRetryDelayMs:   Math.max(0, Number(sendRetryDelayMs) || 250),
        clientCertPath: clientCertPath.trim() || null,
        clientKeyPath: clientKeyPath.trim() || null,
        clientKeyPassphrase: clientKeyPassphrase || null,
        useWs,
        wsPath: wsPath.trim() || null,
      });
      onConnected(queue);
      onLog("ok", `Connected → ${host}:${port}${queue ? `  (${queue})` : ""}`);
    } catch (e) {
      onLog("err", `Connection failed: ${e}`);
    } finally { setConnecting(false); }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">

      {/* ─── TOP BAR ─── */}
      <ViewTopBar
        icon={<Settings2 className="w-3.5 h-3.5" />}
        title={t("conn.title")}
      >
        <button
          onClick={toggle}
          disabled={connecting}
          className={`px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shrink-0 flex items-center gap-1.5 ${
            connected
              ? "bg-negative/10 border border-negative/30 text-negative hover:bg-negative/20"
              : "bg-accent-strong hover:bg-accent text-white"
          }`}
        >
          {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : connected ? <Unplug className="w-3.5 h-3.5" /> : <Plug className="w-3.5 h-3.5" />}
          {connecting ? t("conn.connecting") : connected ? t("conn.disconnect") : t("conn.connect")}
        </button>
      </ViewTopBar>

      {/* ─── TABS — Main / Advanced ─── */}
      <Tabs
        tabs={[
          { id: "main",     label: t("conn.tab.main"),     icon: <SlidersHorizontal className="w-3.5 h-3.5" /> },
          { id: "advanced", label: t("conn.tab.advanced"), icon: <Sliders className="w-3.5 h-3.5" />, dot: advancedDirty },
        ] as TabItem[]}
        active={tab}
        onChange={(id) => setTab(id as MainTab)}
      />

      {/* ─── FORM ─── */}
      <div className="flex-1 overflow-y-auto min-h-0 p-3">

        {tab === "main" && <>
        {/* ─── PROFILE PICKER ROW ─── */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-1.5 h-4">
            <SectionLabel className="leading-none">{t("conn.profile")}</SectionLabel>
            {dirty && sel && !savingAs && !confirmDel && (
              <span className="text-[10.5px] text-caution flex items-center gap-1 normal-case font-normal leading-none">
                <span className="w-1 h-1 rounded-full bg-caution" /> {t("conn.profile.dirty", { name: sel })}
              </span>
            )}
          </div>
          <div className="flex gap-1.5 items-stretch">

            {/* Profile dropdown — full-width via shared Dropdown primitive */}
            <div className="flex-1">
              <Dropdown
                width="w-full"
                trigger={({ open, toggle }) => (
                  <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={open}
                    className="w-full flex items-center gap-2 bg-t-field border border-t-line2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-t-ink hover:border-t-line2 transition-colors"
                  >
                    {sel ? (
                      <>
                        <span className="font-medium truncate">{sel}</span>
                        {dirty && <span className="w-1.5 h-1.5 rounded-full bg-caution shrink-0" title={t("conn.profile.dirtyShort")} />}
                        <span className="ml-auto text-[11.5px] text-t-ink5 font-mono shrink-0">{loaded?.host}:{loaded?.port}</span>
                      </>
                    ) : (
                      <span className="text-t-ink4 italic">{t("conn.profile.none")}</span>
                    )}
                    <ChevronDown className="w-3.5 h-3.5 text-t-ink4 shrink-0" />
                  </button>
                )}
              >
                <div className="max-h-64 overflow-y-auto">
                  {profiles.length === 0 ? (
                    <p className="text-[11.5px] text-t-ink5 text-center py-4">{t("conn.profile.empty")}</p>
                  ) : profiles.map(p => (
                    <DropdownItem
                      key={p.name}
                      active={p.name === sel}
                      onClick={() => selectProfile(p)}
                      trailing={`${p.host}:${p.port}${p.use_tls ? " · TLS" : ""}`}
                    >
                      {p.name}
                    </DropdownItem>
                  ))}
                </div>
                <DropdownFooter>
                  <button
                    type="button"
                    onClick={newProfile}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-t-hover transition-colors text-accent"
                  >
                    <Plus className="w-3 h-3 shrink-0" />
                    <span className="text-[12.5px] font-medium">{t("conn.profile.new")}</span>
                  </button>
                </DropdownFooter>
              </Dropdown>
            </div>

            {/* Action buttons */}
            <button
              onClick={saveChanges}
              disabled={!sel || !dirty}
              title={sel ? (dirty ? t("conn.save.hint") : t("conn.save.clean")) : t("conn.save.needsName")}
              className="px-2.5 py-1.5 rounded-lg bg-t-card border border-t-line text-t-ink4 hover:text-accent hover:border-accent/50 disabled:opacity-30 disabled:hover:text-t-ink4 disabled:hover:border-t-line transition-colors flex items-center gap-1 text-[11.5px] font-medium"
            >
              <Save className="w-3.5 h-3.5" />
              {t("conn.save")}
            </button>
            <button
              onClick={() => startSaveAs()}
              title={t("conn.saveAs.hint")}
              className="px-2.5 py-1.5 rounded-lg bg-t-card border border-t-line text-t-ink4 hover:text-accent hover:border-accent/50 transition-colors text-[11.5px] font-medium"
            >
              {t("conn.saveAs")}
            </button>
            <button
              onClick={duplicateProfile}
              disabled={!sel}
              title={t("conn.duplicate")}
              className="px-2.5 py-1.5 rounded-lg bg-t-card border border-t-line text-t-ink4 hover:text-accent hover:border-accent/50 disabled:opacity-30 disabled:hover:text-t-ink4 disabled:hover:border-t-line transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={startDelete}
              disabled={!sel}
              title={t("conn.delete")}
              className="px-2.5 py-1.5 rounded-lg bg-t-card border border-t-line text-t-ink4 hover:text-negative hover:border-negative/50 disabled:opacity-30 disabled:hover:text-t-ink4 disabled:hover:border-t-line transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            {/* Overflow menu — bulk profile operations.
                Quick-connect parses an `amqp://user:pass@host:port/queue`
                URL straight into the form; Import/Export round-trip the
                profiles list as JSON for dotfile sharing. */}
            <Dropdown
              align="right"
              width="w-64"
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  aria-expanded={open}
                  title={t("conn.more")}
                  className="px-2.5 py-1.5 rounded-lg bg-t-card border border-t-line text-t-ink4 hover:text-t-ink hover:border-t-line2 transition-colors"
                >
                  <MoreVertical className="w-3.5 h-3.5" />
                </button>
              )}
            >
              <DropdownItem onClick={() => setQuickConnectOpen(true)}>
                <span className="flex items-center gap-2"><Zap className="w-3 h-3 shrink-0" /> {t("conn.quick")}</span>
              </DropdownItem>
              <DropdownItem
                onClick={async () => {
                  try {
                    const f = await openFileDialog({
                      multiple: false,
                      directory: false,
                      title: t("conn.import.title"),
                      filters: [{ name: "JSON", extensions: ["json"] }],
                    });
                    if (typeof f !== "string") return;
                    // Ask overwrite only when there's something that could collide.
                    const collide = profiles.length > 0
                      ? window.confirm(t("conn.import.overwrite"))
                      : false;
                    const r = await invoke<{ added: number; overwritten: number; skipped: number; failed: number }>("import_profiles", { path: f, overwrite: collide });
                    await onProfilesChanged();
                    onLog("ok", t("conn.import.done", { added: r.added, overwritten: r.overwritten, skipped: r.skipped }));
                  } catch (e) {
                    onLog("err", t("conn.import.failed", { error: String(e) }));
                  }
                }}
              >
                <span className="flex items-center gap-2"><Upload className="w-3 h-3 shrink-0" /> {t("conn.import")}</span>
              </DropdownItem>
              <DropdownItem
                onClick={async () => {
                  try {
                    const f = await saveFileDialog({
                      title: t("conn.export.title"),
                      defaultPath: "amqpush-profiles.json",
                      filters: [{ name: "JSON", extensions: ["json"] }],
                    });
                    if (!f) return;
                    const n = await invoke<number>("export_profiles", { path: f });
                    onLog("ok", t("conn.export.done", { count: n, path: f }));
                  } catch (e) {
                    onLog("err", t("conn.export.failed", { error: String(e) }));
                  }
                }}
              >
                <span className="flex items-center gap-2"><DownloadIcon className="w-3 h-3 shrink-0" /> {t("conn.export")}</span>
              </DropdownItem>
            </Dropdown>
          </div>

          {/* Inline name prompt for "Save as…" / Duplicate */}
          {savingAs && (
            <div className="mt-2">
              <Callout variant="info">
                <div className="flex items-center gap-2">
                  <span className="text-accent font-medium shrink-0">{t("conn.newName")}</span>
                  <input
                    autoFocus
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") confirmSaveAs();
                      if (e.key === "Escape") { setSavingAs(false); setNewName(""); }
                    }}
                    placeholder={t("conn.newName.placeholder")}
                    className={`${INPUT} flex-1`}
                  />
                  <button onClick={confirmSaveAs} disabled={!newName.trim()}
                    className="px-2.5 py-1.5 rounded-lg bg-accent-strong text-white text-[11.5px] font-semibold hover:bg-accent disabled:opacity-40 transition-colors">
                    {t("conn.save")}
                  </button>
                  <button onClick={() => { setSavingAs(false); setNewName(""); }}
                    className="px-2 py-1.5 rounded-lg text-t-ink4 hover:text-t-ink hover:bg-t-hover text-[11.5px] transition-colors">
                    {t("conn.cancel")}
                  </button>
                </div>
              </Callout>
            </div>
          )}

          {/* Inline delete confirmation */}
          {confirmDel && sel && (
            <div className="mt-2">
              <Callout variant="error">
                <div className="flex items-center gap-2">
                  <span className="text-negative font-medium shrink-0">
                    {t("conn.delete.confirm", { name: sel })}
                  </span>
                  <div className="ml-auto flex gap-1">
                    <button onClick={confirmDelete}
                      className="px-2.5 py-1 rounded-lg bg-negative text-white text-[11.5px] font-semibold hover:bg-negative transition-colors">
                      {t("conn.delete.yes")}
                    </button>
                    <button onClick={() => setConfirmDel(false)}
                      className="px-2 py-1 rounded-lg text-t-ink4 hover:text-t-ink hover:bg-t-hover text-[11.5px] transition-colors">
                      {t("conn.cancel")}
                    </button>
                  </div>
                </div>
              </Callout>
            </div>
          )}

        </div>

        {/* Server section */}
        <div className="mb-4">
          <SectionLabel className="block mb-2">{t("conn.server")}</SectionLabel>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={LABEL}>{t("conn.host")} <span className="text-negative">*</span></label><input value={host} onChange={e => setHost(e.target.value)} placeholder="127.0.0.1" className={INPUT} /></div>
            <div><label className={LABEL}>{t("conn.port")} <span className="text-negative">*</span></label><input value={port} onChange={e => setPort(e.target.value)} placeholder="5672" className={INPUT} /></div>
          </div>
          {/* Workspace — groups this profile under a named bucket in the
              header picker and Cmd+K palette. Free-form text with autocomplete
              from existing workspaces; "Default" is the canonical fallback.
              We avoid the native `<datalist>` here because WebKit (Tauri's
              renderer) styles its dropdown unreadably — white-on-white text.
              Custom combobox matches the rest of the app's look. */}
          <div className="mt-3">
            <label className={LABEL} htmlFor="profile-workspace">{t("conn.workspace")}</label>
            <WorkspaceCombobox
              value={workspace}
              onChange={setWorkspace}
              suggestions={workspaceSuggestions}
              usage={workspaceUsage}
              onDelete={deleteWorkspace}
            />
            <p className="text-[10.5px] text-t-ink5 mt-1">{t("conn.workspace.hint")}</p>
          </div>
        </div>

        {/* Auth section */}
        <div className="mb-4">
          <SectionLabel className="block mb-2">{t("conn.auth")}</SectionLabel>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={LABEL}>{t("conn.username")}</label><input value={username} disabled={saslAnonymous} onChange={e => setUsername(e.target.value)} placeholder={t("conn.optional")} className={`${INPUT} disabled:opacity-50`} /></div>
            <div><label className={LABEL}>{t("conn.password")}</label><input type="password" value={password} disabled={saslAnonymous} onChange={e => setPassword(e.target.value)} placeholder={t("conn.optional")} className={`${INPUT} disabled:opacity-50`} /></div>
          </div>
        </div>

        {/* Security section */}
        <div className="mb-4">
          <SectionLabel className="block mb-2">{t("conn.security")}</SectionLabel>

          {/* TLS / AMQPS toggle card */}
          <div className="flex items-center justify-between p-2.5 rounded-xl bg-t-card border border-t-line mb-2">
            <div className="flex flex-col">
              <span className="text-[13px] text-t-ink2">{t("conn.tls")}</span>
              <span className="text-[10.5px] text-t-ink5">{t("conn.tls.hint")}</span>
            </div>
            <Toggle checked={useTls} onChange={setUseTls} ariaLabel={t("conn.tls")} />
          </div>

          {/* Skip cert verification — sub-option, only when TLS on */}
          {useTls && (
            <label className="flex items-center gap-2 cursor-pointer text-[11.5px] text-t-ink3 px-2.5 mb-2">
              <input type="checkbox" checked={tlsSkipVerify} onChange={e => setTlsSkipVerify(e.target.checked)}
                className="w-3.5 h-3.5 accent-accent-strong cursor-pointer" />
              {t("conn.tls.skip")}
              <span className="text-caution text-[10.5px]">{t("conn.tls.skip.hint")}</span>
            </label>
          )}

          {/* Force SASL ANONYMOUS — same toggle-card style */}
          <div className="flex items-center justify-between p-2.5 rounded-xl bg-t-card border border-t-line mb-2">
            <div className="flex flex-col">
              <span className="text-[13px] text-t-ink2">{t("conn.sasl")}</span>
              <span className="text-[10.5px] text-t-ink5">{t("conn.sasl.hint")}</span>
            </div>
            <Toggle checked={saslAnonymous} onChange={setSaslAnonymous} ariaLabel={t("conn.sasl")} />
          </div>

          {/* WebSocket transport — opt-in. AMQP rides over ws:// (or wss://
              when TLS is also on). Useful behind firewalls that block raw
              5671/5672, and for cloud brokers (Azure SB, Amazon MQ, etc.). */}
          <div className="flex items-center justify-between p-2.5 rounded-xl bg-t-card border border-t-line">
            <div className="flex flex-col">
              <span className="text-[13px] text-t-ink2">{t("conn.ws")}</span>
              <span className="text-[10.5px] text-t-ink5">
                {t("conn.ws.hint", { scheme: useTls ? "wss" : "ws", path: wsPath ? `/${wsPath}` : "" })}
              </span>
            </div>
            <Toggle checked={useWs} onChange={setUseWs} ariaLabel={t("conn.ws")} />
          </div>

          {/* WebSocket URL path — sub-option, only when WS on */}
          {useWs && (
            <div className="px-2.5 mt-2">
              <label className="flex flex-col gap-1">
                <span className="text-[10.5px] font-semibold text-t-ink4 uppercase tracking-wider">
                  {t("conn.ws.path")}
                  <span className="text-t-ink5 normal-case font-normal">{t("conn.ws.path.hint")}</span>
                </span>
                <input
                  value={wsPath}
                  onChange={e => setWsPath(e.target.value)}
                  placeholder={t("conn.ws.path.placeholder")}
                  spellCheck={false}
                  className={`${INPUT} font-mono`}
                />
              </label>
            </div>
          )}
        </div>
        </>}

        {tab === "advanced" && <>
        {/* Default Queue (optional) */}
        <div className="mb-4">
          <label className={LABEL}>{t("conn.queue")} <span className="text-t-ink5 normal-case font-normal">{t("conn.queue.hint")}</span></label>
          <input value={queue} onChange={e => setQueue(e.target.value)} placeholder={t("conn.queue.placeholder")} className={INPUT} />
        </div>

        {/* Connection options */}
        <div className="mb-4">
          <SectionLabel className="block mb-2">{t("conn.options")}</SectionLabel>
          <div className="space-y-3">
            <div>
              <label className={LABEL}>
                {t("conn.containerId")}
                <span className="text-t-ink5 normal-case font-normal">{t("conn.containerId.hint")}</span>
              </label>
              <input value={containerId} onChange={e => setContainerId(e.target.value)}
                placeholder="auto: amqpush-<uuid>" className={`${INPUT} font-mono`} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={LABEL}>
                  {t("conn.heartbeat")}
                  <span className="text-t-ink5 normal-case font-normal">{t("conn.heartbeat.unit")}</span>
                </label>
                <input type="number" min="0" value={heartbeatSecs}
                  onChange={e => setHeartbeatSecs(e.target.value)}
                  placeholder="0" className={INPUT} />
              </div>
              <div>
                <label className={LABEL}>
                  {t("conn.timeout")}
                  <span className="text-t-ink5 normal-case font-normal">{t("conn.timeout.unit")}</span>
                </label>
                <input type="number" min="0" value={connectTimeoutSecs}
                  onChange={e => setConnectTimeoutSecs(e.target.value)}
                  placeholder="10" className={INPUT} />
              </div>
            </div>
            <p className="text-[10.5px] text-t-ink5 leading-relaxed">{t("conn.options.note")}</p>
          </div>
        </div>

        {/* Reconnect backoff — used by subscribers when the broker drops the
            link. Each step waits backoff_ms, then multiplies by the
            multiplier, capped at max. Bigger ceilings save log volume during
            long outages; small starting delays react fast on flaky networks. */}
        <div className="mb-4">
          <SectionLabel className="block mb-2">{t("conn.backoff")}</SectionLabel>
          <div className="bg-t-card border border-t-line rounded-xl p-3 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={LABEL}>
                  {t("conn.backoff.initial")}
                  <span className="text-t-ink5 normal-case font-normal">{t("conn.backoff.ms")}</span>
                </label>
                <input type="number" min="0" value={reconnectBaseMs}
                  onChange={e => setReconnectBaseMs(e.target.value)}
                  placeholder="1000" className={INPUT} />
              </div>
              <div>
                <label className={LABEL}>
                  {t("conn.backoff.max")}
                  <span className="text-t-ink5 normal-case font-normal">{t("conn.backoff.ms")}</span>
                </label>
                <input type="number" min="0" value={reconnectMaxMs}
                  onChange={e => setReconnectMaxMs(e.target.value)}
                  placeholder="30000" className={INPUT} />
              </div>
              <div>
                <label className={LABEL}>
                  {t("conn.backoff.mult")}
                  <span className="text-t-ink5 normal-case font-normal">{t("conn.backoff.step")}</span>
                </label>
                <input type="number" min="1.01" step="0.1" value={reconnectMultiplier}
                  onChange={e => setReconnectMult(e.target.value)}
                  placeholder="2" className={INPUT} />
              </div>
            </div>
            <p className="text-[10.5px] text-t-ink5 leading-relaxed">{t("conn.backoff.note")}</p>
          </div>
        </div>

        {/* Send-retry budget — wraps send_message in N attempts with a
            fixed delay. Transient broker hiccups (rate limiting, replica
            failover) get absorbed instead of bubbling up to the user. */}
        <div className="mb-4">
          <SectionLabel className="block mb-2">{t("conn.retry")}</SectionLabel>
          <div className="bg-t-card border border-t-line rounded-xl p-3 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={LABEL}>
                  {t("conn.retry.attempts")}
                  <span className="text-t-ink5 normal-case font-normal">{t("conn.retry.attempts.hint")}</span>
                </label>
                <input type="number" min="1" max="20" value={sendRetryAttempts}
                  onChange={e => setSendRetryAttempts(e.target.value)}
                  placeholder="1" className={INPUT} />
              </div>
              <div>
                <label className={LABEL}>
                  {t("conn.retry.delay")}
                  <span className="text-t-ink5 normal-case font-normal">{t("conn.backoff.ms")}</span>
                </label>
                <input type="number" min="0" value={sendRetryDelayMs}
                  onChange={e => setSendRetryDelayMs(e.target.value)}
                  placeholder="250" className={INPUT} />
              </div>
            </div>
            <p className="text-[10.5px] text-t-ink5 leading-relaxed">{t("conn.retry.note")}</p>
          </div>
        </div>

        {/* mTLS client certificate — opt-in mutual TLS. Only meaningful with
            server-side TLS on; otherwise the cert has no transport to ride. */}
        <div className="mb-4">
          <SectionLabel className="block mb-2">{t("conn.mtls")}</SectionLabel>
          {!useTls && (
            // Inline warning instead of silently dimming the card — makes
            // it obvious *why* the fields are inert and exactly which toggle
            // unlocks them.
            <div className="flex items-start gap-2 px-3 py-2 mb-2 rounded-lg bg-caution/10 border border-caution/30 text-[11.5px] text-caution leading-relaxed">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{t("conn.mtls.needsTls")}</span>
            </div>
          )}
          <div className={`bg-t-card border border-t-line rounded-xl p-3 space-y-3 ${useTls ? "" : "opacity-50"}`}>
            <div>
              <label className={LABEL}>
                {t("conn.mtls.cert")}
                <span className="text-t-ink5 normal-case font-normal">{t("conn.mtls.cert.hint")}</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  value={clientCertPath}
                  onChange={e => setClientCertPath(e.target.value)}
                  disabled={!useTls}
                  placeholder={t("conn.mtls.cert.placeholder")}
                  spellCheck={false}
                  className={`${INPUT} font-mono disabled:opacity-50 flex-1`}
                />
                <button
                  type="button"
                  disabled={!useTls}
                  onClick={async () => {
                    const f = await openFileDialog({
                      multiple: false,
                      directory: false,
                      title: t("conn.mtls.cert.pick"),
                      filters: [
                        { name: t("conn.mtls.certificates"), extensions: ["crt", "pem", "cer", "p12", "pfx"] },
                        { name: t("conn.mtls.allFiles"), extensions: ["*"] },
                      ],
                    });
                    if (typeof f === "string") setClientCertPath(f);
                  }}
                  title={t("conn.mtls.cert.browse")}
                  aria-label={t("conn.mtls.cert.browse")}
                  className="shrink-0 h-9 px-2.5 rounded-lg border border-t-line2 bg-t-card text-t-ink3 hover:text-t-ink hover:bg-t-hover transition-colors text-[12.5px] flex items-center disabled:opacity-50"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={LABEL}>
                  {t("conn.mtls.key")}
                  <span className="text-t-ink5 normal-case font-normal">{t("conn.mtls.key.hint")}</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    value={clientKeyPath}
                    onChange={e => setClientKeyPath(e.target.value)}
                    disabled={!useTls}
                    placeholder={t("conn.mtls.key.placeholder")}
                    spellCheck={false}
                    className={`${INPUT} font-mono disabled:opacity-50 flex-1`}
                  />
                  <button
                    type="button"
                    disabled={!useTls}
                    onClick={async () => {
                      const f = await openFileDialog({
                        multiple: false,
                        directory: false,
                        title: t("conn.mtls.key.pick"),
                        filters: [
                          { name: t("conn.mtls.keys"), extensions: ["key", "pem"] },
                          { name: t("conn.mtls.allFiles"), extensions: ["*"] },
                        ],
                      });
                      if (typeof f === "string") setClientKeyPath(f);
                    }}
                    title={t("conn.mtls.key.browse")}
                    aria-label={t("conn.mtls.key.browse")}
                    className="shrink-0 h-9 px-2.5 rounded-lg border border-t-line2 bg-t-card text-t-ink3 hover:text-t-ink hover:bg-t-hover transition-colors text-[12.5px] flex items-center disabled:opacity-50"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div>
                <label className={LABEL}>
                  {t("conn.mtls.pass")}
                  <span className="text-t-ink5 normal-case font-normal">{t("conn.mtls.pass.hint")}</span>
                </label>
                <input
                  type="password"
                  value={clientKeyPassphrase}
                  onChange={e => setClientKeyPassphrase(e.target.value)}
                  disabled={!useTls}
                  placeholder={t("conn.optional")}
                  className={`${INPUT} disabled:opacity-50`}
                />
              </div>
            </div>
            <p className="text-[10.5px] text-t-ink5 leading-relaxed">{t("conn.mtls.note")}</p>
          </div>
        </div>
        </>}
      </div>

      {/* Activity panel stays in fixed position — independent of tab switching */}

      {/* ─── ACTIVITY LOG (footer panel) — last connection-related logs ─── */}
      <ActivityPanel logs={logs} bottomRef={logsBottomRef} />

      {/* ─── QUICK-CONNECT MODAL ─── */}
      {quickConnectOpen && (
        <QuickConnectModal
          onLog={onLog}
          onClose={() => setQuickConnectOpen(false)}
          onApply={(patch) => {
            // Patch the form in-place and close the modal. We don't save
            // the profile yet — user can preview the parsed fields, hit
            // Save as… to persist or Connect to try immediately.
            setForm(f => ({ ...f, ...patch }));
            setQuickConnectOpen(false);
            onLog("info", `Quick-connect parsed — form updated`);
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const LOG_ICON = {
  ok:   <CheckCircle className="w-3 h-3 text-positive shrink-0" />,
  err:  <XCircle     className="w-3 h-3 text-negative   shrink-0" />,
  info: <Info        className="w-3 h-3 text-t-ink4    shrink-0" />,
};
const LOG_COLOR = { ok: "text-positive", err: "text-negative", info: "text-t-ink3" };

function ActivityPanel({ logs, bottomRef }: { logs: LogEntry[]; bottomRef: React.RefObject<HTMLDivElement | null> }) {
  const t = useAmqpText();
  const [open, setOpen] = useState(true);

  // Filter to connection-related entries only, last 30
  const filtered = useMemo(
    () => logs.filter(l => CONN_KEYWORDS.test(l.text)).slice(-30),
    [logs]
  );

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [filtered.length, open]);

  return (
    <div className="shrink-0 border-t border-t-line bg-t-panel">
      <button onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-t-hover/50 transition-colors">
        <SectionLabel icon={<Activity className="w-3 h-3" />}>{t("conn.activity")}</SectionLabel>
        <span className="ml-auto text-[10.5px] text-t-ink5">
          {t("conn.activity.count", { count: filtered.length })}{!open && t("conn.activity.expand")}
        </span>
      </button>
      {open && (
        <div className="border-t border-t-line h-[120px] overflow-y-auto p-2 space-y-0.5 font-mono log-selectable">
          {filtered.length === 0 ? (
            <p className="text-[11.5px] text-t-ink5 text-center py-4">{t("conn.activity.empty")}</p>
          ) : (
            <>
              {filtered.map(entry => {
                const d = new Date(entry.tsMs);
                const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
                return (
                  <div key={entry.id} className="flex items-center gap-2 text-[11.5px] leading-5">
                    <span className="text-t-ink5 shrink-0 font-mono">{time}</span>
                    {LOG_ICON[entry.kind]}
                    <span className={`${LOG_COLOR[entry.kind]} break-all`}>{entry.text}</span>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Tiny combobox for the Workspace field — free-form text input with a
 * dropdown of known workspaces. Built by hand instead of `<datalist>`
 * because WebKit renders datalist options as white-on-white in Tauri's
 * theme, which is unusable.
 *
 * Behavior:
 *   - Clicking the input or the caret opens the suggestion list.
 *   - Typing filters the suggestion list by substring.
 *   - Clicking a suggestion fills the input and closes the list.
 *   - Click outside or Escape closes the list.
 *   - The list is always anchored under the input with absolute positioning
 *     and a `z-30` so it floats above the form below.
 */
function WorkspaceCombobox({ value, onChange, suggestions, usage, onDelete }: {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  /** Per-workspace profile count — drives the count badge and decides
   *  whether a delete confirmation needs to mention reassigning profiles. */
  usage: Map<string, number>;
  /** Move every profile in this workspace back to "Default" and refresh. */
  onDelete: (name: string) => Promise<void>;
}) {
  const t = useAmqpText();
  const [open, setOpen] = useState(false);
  // Workspace name currently in "are you sure?" mode. Inline confirm avoids
  // pulling in a modal for a tiny destructive-ish action.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirmDelete(null);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const q = value.trim().toLowerCase();
  const filtered = q
    ? suggestions.filter(s => s.toLowerCase().includes(q))
    : suggestions;

  async function doDelete(name: string) {
    setDeleting(true);
    try {
      await onDelete(name);
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={e => { if (e.key === "Escape") { setOpen(false); setConfirmDelete(null); } }}
        placeholder={t("conn.workspace.default")}
        // Same INPUT classes as everywhere else in this view, plus padding
        // on the right to make room for the caret button.
        className="w-full bg-t-field border border-t-line2 rounded-lg pl-3 pr-8 py-1.5 text-[13px] text-t-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-all placeholder:text-t-ink5 box-border h-9 appearance-none"
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setOpen(o => !o)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-t-ink4 hover:text-t-ink2 transition-colors"
        aria-label={t("conn.workspace.toggle")}
      >
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && filtered.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 z-30 bg-t-card border border-t-line rounded-lg shadow-lg overflow-hidden max-h-56 overflow-y-auto">
          {filtered.map(w => {
            const isCurrent = w === value;
            const count = usage.get(w) ?? 0;
            // "Default" is the canonical fallback bucket — it can't be
            // deleted (there's nowhere to reassign its profiles to).
            const deletable = w !== "Default";

            // Confirm row replaces the regular row in-place.
            if (confirmDelete === w) {
              return (
                <div
                  key={w}
                  onMouseDown={e => e.preventDefault()}
                  className="flex items-center gap-2 px-3 py-2 text-[11.5px] bg-negative/5 border-b border-negative/20"
                >
                  <span className="text-t-ink2 flex-1 min-w-0 truncate">
                    {t("conn.workspace.delete", { name: w })}
                    {count > 0 && t("conn.workspace.moves", { count })}
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(null)}
                    disabled={deleting}
                    className="px-2 py-0.5 rounded-md text-t-ink4 hover:text-t-ink2 hover:bg-t-hover transition-colors disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => doDelete(w)}
                    disabled={deleting}
                    className="px-2 py-0.5 rounded-md text-negative bg-negative/10 hover:bg-negative/20 transition-colors disabled:opacity-40 flex items-center gap-1"
                  >
                    {deleting && <Loader2 className="w-3 h-3 animate-spin" />}
                    Delete
                  </button>
                </div>
              );
            }

            return (
              <div
                key={w}
                onMouseDown={e => e.preventDefault()}
                className={`group flex items-center gap-2 px-3 py-1.5 text-[12.5px] transition-colors ${
                  isCurrent ? "bg-accent/10" : "hover:bg-t-hover"
                }`}
              >
                <button
                  type="button"
                  onClick={() => { onChange(w); setOpen(false); }}
                  className={`flex-1 min-w-0 text-left truncate ${
                    isCurrent ? "text-accent" : "text-t-ink2 group-hover:text-t-ink"
                  }`}
                >
                  {w}
                </button>
                <span className="shrink-0 text-[10.5px] font-mono text-t-ink5 tabular-nums">
                  {count}
                </span>
                {deletable ? (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(w)}
                    title={`Delete workspace '${w}'`}
                    aria-label={`Delete workspace ${w}`}
                    className="shrink-0 opacity-0 group-hover:opacity-100 text-t-ink5 hover:text-negative transition-all"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                ) : (
                  // Placeholder keeps the count column aligned with the
                  // deletable rows. Same intrinsic size as the Trash2 icon.
                  <span aria-hidden className="shrink-0 w-3 h-3" />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an AMQP connection URL into a partial `ConnForm` patch. Accepts:
 *   - `amqp://user:pass@host:port/queue` (plain TCP, queue path optional)
 *   - `amqps://user:pass@host:port/queue` (TLS)
 *   - `ws://` / `wss://` (WebSocket transport)
 *   - host:port without scheme (assumes amqp://)
 * Returns null on parse failure so the caller can surface an inline error.
 */
function parseAmqpUrl(raw: string): null | Partial<ConnForm> {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `amqp://${trimmed}`;
  let u: URL;
  try { u = new URL(candidate); } catch { return null; }
  const scheme = u.protocol.replace(":", "").toLowerCase();
  const tls = scheme === "amqps" || scheme === "wss";
  const ws  = scheme === "ws" || scheme === "wss";
  const host = u.hostname;
  if (!host) return null;
  const port = u.port || (tls ? "5671" : "5672");
  const username = u.username ? decodeURIComponent(u.username) : "";
  const password = u.password ? decodeURIComponent(u.password) : "";
  let queue = "";
  let wsPath = "";
  if (ws) {
    wsPath = u.pathname.replace(/^\/+/, "");
  } else {
    const seg = u.pathname.replace(/^\/+/, "");
    if (seg) queue = decodeURIComponent(seg);
  }
  return {
    host,
    port,
    username,
    password,
    queue,
    useTls: tls,
    useWs: ws,
    wsPath: wsPath || "",
  };
}

function QuickConnectModal({ onApply, onLog, onClose }: {
  onApply: (patch: Partial<ConnForm>) => void;
  onLog: (kind: "info" | "ok" | "err", text: string) => void;
  onClose: () => void;
}) {
  const t = useAmqpText();
  const [url, setUrl] = useState("");
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const preview = useMemo(() => {
    if (!url.trim()) { return null; }
    const p = parseAmqpUrl(url);
    if (!p) return null;
    return p;
  }, [url]);

  useEffect(() => {
    setPreviewErr(url.trim() && !preview ? t("conn.quick.bad") : null);
  }, [url, preview]);

  function apply() {
    if (!preview) { onLog("err", t("conn.quick.empty")); return; }
    onApply(preview);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="bg-t-bg border border-t-line rounded-xl shadow-2xl w-[560px] max-w-[95vw] flex flex-col overflow-hidden">

        <div className="shrink-0 px-4 py-2.5 border-b border-t-line bg-t-panel flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-accent" />
          <span className="text-[13px] font-semibold text-t-ink">{t("conn.quick.title")}</span>
          <button onClick={onClose} className="ml-auto p-1 rounded-md hover:bg-t-hover text-t-ink4 hover:text-t-ink">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3 text-[13px]">
          <p className="text-t-ink5 text-[11.5px] leading-relaxed">{t("conn.quick.note")}</p>
          <textarea
            value={url}
            onChange={e => setUrl(e.target.value)}
            autoFocus
            placeholder={"amqp://user:pass@host:5672/orders\nor amqps://user:pass@broker.example.com:5671/queue\nor wss://host:port/path"}
            spellCheck={false}
            rows={5}
            className={`w-full bg-t-field border rounded-lg px-2.5 py-2 text-[12.5px] font-mono text-t-ink outline-none focus:ring-1 transition-all placeholder:text-t-ink5 leading-relaxed resize-y min-h-[88px] ${
              previewErr
                ? "border-negative/50 focus:border-negative focus:ring-negative/30"
                : "border-t-line2 focus:border-accent focus:ring-accent/30"
            }`}
          />
          {previewErr && <p className="text-[11.5px] text-negative">{previewErr}</p>}
          {preview && (
            <div className="rounded-md border border-t-line bg-t-card/40 p-2.5 space-y-1 text-[11.5px] font-mono">
              <div className="text-[10.5px] uppercase tracking-wider text-t-ink4 font-semibold mb-1">{t("conn.quick.preview")}</div>
              <PreviewRow label={t("conn.host")}>{preview.host}</PreviewRow>
              <PreviewRow label={t("conn.port")}>{preview.port}</PreviewRow>
              {preview.username && <PreviewRow label={t("conn.quick.user")}>{preview.username}</PreviewRow>}
              {preview.password && <PreviewRow label={t("conn.quick.pass")}>{"•".repeat(Math.min(8, preview.password.length))}</PreviewRow>}
              {preview.queue && <PreviewRow label={t("conn.quick.queue")}>{preview.queue}</PreviewRow>}
              <PreviewRow label="TLS">{preview.useTls ? t("conn.quick.yes") : t("conn.quick.no")}</PreviewRow>
              {preview.useWs && <PreviewRow label={t("conn.quick.ws")}>{preview.wsPath ? t("conn.quick.wsPath", { path: preview.wsPath }) : t("conn.quick.wsRoot")}</PreviewRow>}
            </div>
          )}
          <p className="text-[10.5px] text-t-ink5 leading-relaxed">{t("conn.quick.schemes")}</p>
        </div>

        <div className="shrink-0 px-3 py-2 border-t border-t-line bg-t-panel flex items-center justify-end gap-2">
          <button onClick={onClose}
            className="px-3 py-1 rounded-lg text-[11.5px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors">
            {t("conn.cancel")}
          </button>
          <button onClick={apply} disabled={!preview}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-accent hover:bg-accent-strong text-white text-[11.5px] font-semibold transition-colors disabled:opacity-40">
            <Zap className="w-3 h-3" /> {t("conn.quick.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-16 text-t-ink5 shrink-0">{label}</span>
      <span className="text-t-ink2 truncate">{children}</span>
    </div>
  );
}
