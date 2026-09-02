import { useState, useRef, useCallback, useEffect, useMemo, ChangeEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Send, Plus, X, FileUp, Type, Repeat2,
  Wand2, BookMarked, Save, Trash2, Braces, CornerDownLeft, Loader2, Tag,
  CheckCircle, XCircle, Clock, ChevronDown, Pencil, CornerUpLeft, Code2,
  ShieldCheck, AlertTriangle, FileSpreadsheet, Square, Bug,
} from "lucide-react";
import Papa from "papaparse";
import { PropertyRow, SendResult, Template, HistoryEntry } from "../../types";
import QueuePicker from "../QueuePicker";
import AutocompleteInput from "../AutocompleteInput";
import { mineHistoryProps, PropSuggestions } from "../../utils/historyProps";
import { applyVariables, runPreScript, VARIABLE_HINTS, UserVariable } from "../../utils/variables";
import { fmtBytes, fmtDuration } from "../../utils/format";
import { recordRecentQueue } from "../../utils/recentQueues";
import Ajv, { ErrorObject } from "ajv";
import CodeEditor, { VariableSuggestion } from "../CodeEditor";
import TokenInput from "../TokenInput";
import Sparkline from "../Sparkline";
import Tabs, { TabItem } from "../Tabs";
import ViewTopBar from "../ViewTopBar";
import EmptyState from "../EmptyState";
import SectionLabel from "../SectionLabel";
import { useAmqpText } from "../../i18n";
import Toggle from "../Toggle";
import SegmentedControl from "../SegmentedControl";
import Callout from "../Callout";
import ConfirmDialog from "../ConfirmDialog";
import Dropdown, { DropdownItem } from "../Dropdown";
import CopyButton from "../CopyButton";

interface Props {
  connected: boolean;
  defaultAddress: string;
  activeProfile: string;
  resendPayload?: {
    address: string;
    body: string;
    fileName?: string;
    fileDataB64?: string;
    properties?: Record<string, string>;
    /** When set, becomes a `correlation-id` custom property pre-filled in Properties. */
    correlationId?: string;
    nonce: number;
  } | null;
  sendTrigger?: number;
  onLog: (kind: "info" | "ok" | "err", text: string) => void;
  onSent: (bytes: number, queue: string, kind?: string) => void;
  onSendError?: () => void;
  /** Notifies the parent of tab changes so context-aware features (like
   *  the in-app Help, which jumps to the matching section when opened from
   *  the current tab) can react. Optional — passing nothing keeps the
   *  view's behaviour identical to before. */
  onTabChange?: (tab: string) => void;
}

const INPUT = "h-9 rounded-lg border border-line-strong bg-surface px-3 text-[12.5px] text-content outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/25 placeholder:text-content-subtle";

type BodyMode = "none" | "raw" | "binary";
type RawType  = "text" | "json" | "xml";
type ContentHint = "text" | "json" | "xml";
type TabKey = "body" | "properties" | "variables" | "prescript" | "batch" | "csv" | "reply" | "templates" | "chaos";

/** Single Ajv instance reused across renders — keeps the underlying compile
 *  cache warm so re-validating after a tiny edit doesn't re-compile from
 *  scratch. */
const ajv = new Ajv({ allErrors: true, strict: false });

const RAW_TYPE_LABEL: Record<RawType, string> = { text: "Text", json: "JSON", xml: "XML" };
const RAW_TYPE_CT:    Record<RawType, string | null> = {
  text: null, // no content-type
  json: "application/json",
  xml:  "application/xml",
};

/**
 * Generate a unique numeric id for a Property / Variable / CSV row. We
 * deliberately avoid a module-level `let counter = 0` because Vite's HMR
 * resets module state on every reload while React preserves component
 * state across the same reload — the combination produced id collisions
 * after a few hot-reloads (two rows ending up with the same `key`),
 * which React reconciled by merging their DOM nodes. Editing one input
 * then mutated the other.
 *
 * Math.random over the safe-integer range gives ≈53 bits of entropy per
 * id; collision probability across hundreds of rows is effectively zero.
 */
function newRowId(): number {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

function detectHint(s: string): ContentHint {
  const t = s.trim();
  if (!t) return "text";
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  if (t.startsWith("<")) return "xml";
  return "text";
}

/** Sleep for `ms`, but reject with an AbortError if `signal` aborts during
 *  the wait. Used by the Schedule feature so the user can cancel a pending
 *  send instead of being forced to wait it out. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function isValidJson(s: string) { try { JSON.parse(s); return true; } catch { return false; } }

/**
 * Beautify JSON while preserving `{{token}}` placeholders. Standard
 * `JSON.parse` chokes on tokens in non-string positions (e.g. `"n": {{x}}`),
 * so we first substitute every token with a unique sentinel string, parse +
 * format, then restore — quoted tokens get quotes back, bare tokens don't.
 */
function formatJson(s: string): string {
  const tokens: { token: string; quoted: boolean }[] = [];

  // Phase 1: tokens already wrapped in quotes — `"{{x}}"`. Replace the whole
  // `"…"` with a quoted sentinel string so we don't end up with `""…""`.
  let sentinelized = s.replace(/"(\{\{[^}]+\}\})"/g, (_, token) => {
    tokens.push({ token, quoted: true });
    return `"__TPL_${tokens.length - 1}__"`;
  });

  // Phase 2: bare tokens in non-string positions — wrap in quotes so the
  // result is still parseable.
  sentinelized = sentinelized.replace(/\{\{[^}]+\}\}/g, (match) => {
    tokens.push({ token: match, quoted: false });
    return `"__TPL_${tokens.length - 1}__"`;
  });

  try {
    const obj = JSON.parse(sentinelized);
    let formatted = JSON.stringify(obj, null, 2);
    tokens.forEach((info, i) => {
      const placeholder = `"__TPL_${i}__"`;
      const replacement = info.quoted ? `"${info.token}"` : info.token;
      formatted = formatted.replace(placeholder, replacement);
    });
    return formatted;
  } catch {
    return s;
  }
}

function isValidXml(s: string) {
  try {
    const doc = new DOMParser().parseFromString(s, "application/xml");
    return !doc.querySelector("parsererror");
  } catch { return false; }
}

function formatXml(raw: string): string {
  try {
    const doc = new DOMParser().parseFromString(raw.trim(), "application/xml");
    if (doc.querySelector("parsererror")) return raw;
    const serial = new XMLSerializer().serializeToString(doc);
    let depth = 0;
    return serial
      .replace(/>\s*</g, ">\n<")
      .split("\n")
      .map(line => {
        const t = line.trim();
        if (!t) return "";
        if (t.startsWith("</")) depth = Math.max(0, depth - 1);
        const out = "  ".repeat(depth) + t;
        if (t.startsWith("<") && !t.startsWith("</") && !t.startsWith("<?") && !t.endsWith("/>") && !t.includes("</")) depth++;
        return out;
      })
      .filter(Boolean)
      .join("\n");
  } catch { return raw; }
}

export default function PublisherView({ connected, defaultAddress, activeProfile, resendPayload, sendTrigger, onLog, onSent, onSendError, onTabChange }: Props) {
  const t = useAmqpText();
  const [address,    setAddress]    = useState(defaultAddress);
  const [tab,        setTab]        = useState<TabKey>("body");
  // Push tab changes to the parent so it can keep context-aware features
  // (Help) in sync. Effect (not wrapping setTab) so every code path that
  // mutates `tab` — including auto-switches on resend / Reply — broadcasts
  // without needing to remember to call the callback at each site.
  useEffect(() => { onTabChange?.(tab); }, [tab, onTabChange]);
  const [mode,       setMode]       = useState<BodyMode>("raw");
  const [rawType,    setRawType]    = useState<RawType>("json");
  const [text,       setText]       = useState("");
  /** True when the user explicitly picked a Raw subtype from the dropdown.
   *  Disables the auto-detect-from-content effect so we don't fight the user.
   *  Reset whenever the editor becomes empty or new content is loaded
   *  (template / resend), so auto-detect is a fresh start each time. */
  const [userPickedRawType, setUserPickedRawType] = useState(false);
  const [file,       setFile]       = useState<File | null>(null);
  const [props,      setProps]      = useState<PropertyRow[]>([]);
  /** Poison-pill helpers — opt-in mutations applied to the outgoing
   *  message right before the actual send. Designed for testing how a
   *  consumer reacts to broken inputs (oversized body, wrong content-type,
   *  malformed JSON, a missing required header) without manually crafting
   *  the malformed payload. All four are independent toggles. */
  const [chaosPadBody, setChaosPadBody] = useState(false);
  const [chaosPadSizeMb, setChaosPadSizeMb] = useState("1");
  const [chaosWrongCt, setChaosWrongCt] = useState(false);
  const [chaosWrongCtValue, setChaosWrongCtValue] = useState("application/octet-stream");
  const [chaosCorruptJson, setChaosCorruptJson] = useState(false);
  const [chaosDropProp, setChaosDropProp] = useState(false);
  const [chaosDropPropKey, setChaosDropPropKey] = useState("");
  const chaosActive = chaosPadBody || chaosWrongCt || chaosCorruptJson || chaosDropProp;

  /** History-mined key/value suggestions for the Properties tab. Refreshed
   *  lazily whenever the user opens the Properties tab so the dropdown
   *  reflects recent sends without polling continuously. */
  const [historyProps, setHistoryProps] = useState<PropSuggestions>({ keys: [], valuesByKey: new Map() });
  async function refreshHistoryProps() {
    try {
      const h = await invoke<HistoryEntry[]>("get_history");
      setHistoryProps(mineHistoryProps(h));
    } catch { /* not connected yet — leave empty */ }
  }
  useEffect(() => {
    if (tab === "properties") refreshHistoryProps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  const [userVars,   setUserVars]   = useState<UserVariable[]>([]);
  const [batchEnabled,    setBatchEnabled]    = useState(false);
  const [repeat,          setRepeat]          = useState("1");
  const [delayMs,         setDelayMs]         = useState("0");
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  /** Seconds to wait before the first message is actually sent. */
  const [scheduleDelay,   setScheduleDelay]   = useState("30");
  /** While > 0, the schedule countdown is being shown to the user. */
  const [scheduleRemaining, setScheduleRemaining] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [sending,    setSending]    = useState(false);

  // ── CSV bulk send ────────────────────────────────────────────────────────
  // Loaded CSV rows + headers. Each row is sent as a separate message; the
  // column values are layered on top of user-defined Variables (CSV wins on
  // key collision) for that one iteration. `csvDryRunIdx` selects which row
  // is rendered in the substitution preview so users can sanity-check that
  // their `{{column_name}}` tokens resolve before kicking off the batch.
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [csvHeaders,  setCsvHeaders]  = useState<string[]>([]);
  const [csvRows,     setCsvRows]     = useState<string[][]>([]);
  const [csvParseError, setCsvParseError] = useState<string | null>(null);
  const [csvDryRunIdx,  setCsvDryRunIdx]  = useState(0);
  const [csvDelay,    setCsvDelay]    = useState("0");
  const [csvProgress, setCsvProgress] = useState<{ done: number; total: number; ok: number; failed: number } | null>(null);
  /** Per-second throughput sample bucket for the live sparkline. Pushed once
   *  per wall-clock second from the send loop; resets between runs. Capped
   *  at 60 samples so a long batch doesn't grow this unboundedly. */
  const [sendRateHistory, setSendRateHistory] = useState<number[]>([]);
  /** Sampler state — current second and count of sends in it. We bucket
   *  per second instead of using a moving window for simplicity; one
   *  data point per second is plenty for a 120-px wide sparkline. */
  const sampleRef = useRef<{ secondKey: number; countInSecond: number }>({ secondKey: 0, countInSecond: 0 });
  const csvAbortRef = useRef<AbortController | null>(null);

  /** Call once after each successful send. Bucks sends into per-second
   *  totals and pushes the previous second's total into history when the
   *  wall-clock second flips. */
  function sampleSend() {
    const sec = Math.floor(Date.now() / 1000);
    if (sampleRef.current.secondKey === 0) {
      sampleRef.current.secondKey = sec;
    } else if (sec !== sampleRef.current.secondKey) {
      // Bucket the previous second; carry zero-rate gaps for skipped seconds.
      const gap = Math.max(0, sec - sampleRef.current.secondKey - 1);
      setSendRateHistory(prev => {
        const next = [...prev, sampleRef.current.countInSecond];
        for (let i = 0; i < gap; i++) next.push(0);
        return next.slice(-60);
      });
      sampleRef.current.secondKey = sec;
      sampleRef.current.countInSecond = 0;
    }
    sampleRef.current.countInSecond++;
  }

  /** Reset sampler + history. Call at the start of every batch / CSV run. */
  function resetSampler() {
    sampleRef.current = { secondKey: 0, countInSecond: 0 };
    setSendRateHistory([]);
  }
  const csvFileInputRef = useRef<HTMLInputElement>(null);
  /** True while a file is being dragged over the CSV dropzone — drives the
   *  visual feedback. */
  const [csvDragOver, setCsvDragOver] = useState(false);
  /** Confirm gate before wiping a loaded CSV (rows + headers + filename). */
  const [confirmClearCsv, setConfirmClearCsv] = useState(false);
  /** JavaScript source that runs before each send. Set vars via `ctx.set(name, value)`. */
  const [preScript,  setPreScript]  = useState("");
  /** Per-language schema sources. The active schema for the current Raw
   *  subtype is what drives validation and the indicator pill in the Body
   *  toolbar. Two fields so users don't lose their JSON Schema when switching
   *  to XML and back. */
  const [bodySchemaJson, setBodySchemaJson] = useState("");
  const [bodySchemaXsd,  setBodySchemaXsd]  = useState("");
  const [schemaModalOpen, setSchemaModalOpen] = useState(false);
  /** Async XML validation result — null when not applicable; ok/errors/error
   *  when xmllint has produced a verdict. */
  const [xsdResult, setXsdResult] = useState<{ ok: boolean; errors: { message: string; line?: number }[]; schemaError?: string } | null>(null);
  const [xsdValidating, setXsdValidating] = useState(false);

  // Send progress / status
  const [progress,   setProgress]   = useState<{ current: number; total: number } | null>(null);
  const [lastSend,   setLastSend]   = useState<{
    ok: boolean;
    count?: number;
    bytes?: number;
    durationMs?: number;
    error?: string;
    ts: string;
  } | null>(null);

  // Request-Reply
  const [rrEnabled,  setRrEnabled]  = useState(false);
  const [rrAddress,  setRrAddress]  = useState("");
  const [rrTimeout,  setRrTimeout]  = useState("5000");
  const [rrWaiting,  setRrWaiting]  = useState(false);
  const [rrReply,    setRrReply]    = useState<string | null>(null);
  const [rrTimedOut, setRrTimedOut] = useState(false);

  // Templates
  const [templates,  setTemplates]  = useState<Template[]>([]);
  const [savingTpl,  setSavingTpl]  = useState(false);
  const [newTplName, setNewTplName] = useState("");
  /** Name of the template currently being inline-renamed; null when none. */
  const [renamingTpl, setRenamingTpl] = useState<string | null>(null);
  const [renamingDraft, setRenamingDraft] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);
  /** True while a file is being dragged over the binary dropzone — drives the
   *  highlight ring + bg tint so users get immediate "yes, drop here" feedback. */
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => { loadTemplates(); }, []);

  async function loadTemplates() {
    try { setTemplates(await invoke<Template[]>("get_templates")); } catch { /* ignore */ }
  }

  // ─── Auto-detect Raw subtype from body content ─────────────────────────────
  // When the user pastes / types content starting with `{`/`[` we switch to
  // JSON; with `<` to XML. Skipped when the user has explicitly picked a
  // subtype from the dropdown (so manual choices stick). Clearing a
  // previously non-empty editor resets the override, so the next paste is
  // auto-detected fresh — but picking a type in an already-empty editor
  // keeps the choice (so users can pre-set the language before typing).
  const prevTextRef = useRef("");
  useEffect(() => {
    const wasNonEmpty = !!prevTextRef.current.trim();
    const isEmpty = !text.trim();
    prevTextRef.current = text;

    if (mode !== "raw") return;

    // Editor went non-empty → empty: release the manual override so the next
    // paste can auto-detect. Don't change rawType — the user keeps seeing
    // their last pick until content arrives.
    if (wasNonEmpty && isEmpty && userPickedRawType) {
      setUserPickedRawType(false);
      return;
    }

    // Manual pick is sticky — never auto-overridden while it's set.
    if (userPickedRawType) return;

    // No content yet and no manual pick → leave rawType alone (don't force
    // it back to "text" just because the buffer is empty).
    if (isEmpty) return;

    const detected = detectHint(text);
    setRawType(prev => prev === detected ? prev : detected);
  }, [text, mode, userPickedRawType]);

  /** Wraps `setRawType` for explicit dropdown picks — sticks until editor empties. */
  const userSetRawType = useCallback((t: RawType) => {
    setRawType(t);
    setUserPickedRawType(true);
  }, []);

  // Resend payload from history
  useEffect(() => {
    if (!resendPayload) return;
    setAddress(resendPayload.address);

    // File resend — reconstruct File object from base64
    if (resendPayload.fileName && resendPayload.fileDataB64) {
      try {
        const bin = atob(resendPayload.fileDataB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const reconstructed = new File([bytes], resendPayload.fileName);
        setFile(reconstructed);
        setMode("binary");
        setText("");
      } catch (e) {
        onLog("err", `Failed to restore file: ${e}`);
      }
    } else {
      setText(resendPayload.body);
      setMode("raw");
      setFile(null);
      // Let the auto-detect effect pick JSON/XML/text from the resent body.
      setUserPickedRawType(false);
    }

    // Restore custom properties (excluding internal markers)
    const propRows: PropertyRow[] = [];
    if (resendPayload.properties) {
      for (const [k, v] of Object.entries(resendPayload.properties)) {
        if (k === "is_file" || k === "_AMQ_ROUTING_TYPE" || k === "file_name") continue;
        // Skip correlation-id from resendPayload.properties since we set it
        // explicitly below (avoids duplicate row when Reply provides it).
        if (k === "correlation-id" && resendPayload.correlationId) continue;
        propRows.push({ id: newRowId(), enabled: true, key: k, value: v, description: "" });
      }
    }
    // Reply flow: pre-fill correlation-id as a custom property so the upstream
    // request-reply pattern keeps its tracking id.
    if (resendPayload.correlationId) {
      propRows.unshift({
        id: newRowId(), enabled: true,
        key: "correlation-id", value: resendPayload.correlationId,
        description: t("send.replyFrom"),
      });
    }
    setProps(propRows);

    setTab("body");
  }, [resendPayload?.nonce]);

  // Cmd+Enter trigger from App
  useEffect(() => {
    if (!sendTrigger) return;
    doSend();
  }, [sendTrigger]);

  const addProp    = useCallback(() => { setProps(p => [...p, { id: newRowId(), enabled: true, key: "", value: "", description: "" }]); }, []);
  const removeProp = useCallback((id: number) => setProps(p => p.filter(r => r.id !== id)), []);
  const updateProp = useCallback((id: number, f: keyof PropertyRow, v: string | boolean) =>
    setProps(p => p.map(r => r.id === id ? { ...r, [f]: v } : r)), []);
  function collectProps() {
    return Object.fromEntries(
      props.filter(r => r.enabled !== false && r.key.trim()).map(r => [r.key.trim(), r.value])
    );
  }
  const enabledPropsCount = props.filter(r => r.enabled !== false && r.key.trim()).length;

  // User variables CRUD
  const addUserVar    = useCallback(() => { setUserVars(p => [...p, { id: newRowId(), enabled: true, key: "", value: "", description: "" }]); }, []);
  const removeUserVar = useCallback((id: number) => setUserVars(p => p.filter(r => r.id !== id)), []);
  const updateUserVar = useCallback((id: number, f: keyof UserVariable, v: string | boolean) =>
    setUserVars(p => p.map(r => r.id === id ? { ...r, [f]: v } : r)), []);
  const insertPresetVar = useCallback((token: string, description: string) => {
    const key = token.replace(/^\{\{|\}\}$/g, "");
    setUserVars(p => p.find(r => r.key === key) ? p : [...p, { id: newRowId(), enabled: true, key, value: token, description }]);
  }, []);
  const enabledUserVarsCount = userVars.filter(v => v.enabled && v.key.trim()).length;

  async function toBase64(f: File): Promise<string> {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res((r.result as string).split(",")[1]); r.onerror = rej; r.readAsDataURL(f); });
  }

  // Content type validation — based on explicit rawType
  // Validate the template against the active subtype WITHOUT depending on
  // actual variable values — replace each `{{…}}` token with a neutral
  // placeholder that is structurally valid in any position. For JSON we use
  // `0` (a primitive that's valid as a value, array element, etc.); for XML
  // we use `_X_` (a valid name / text / attribute-value sequence). This
  // way `{"count": {{n}}}` reports as valid even though `{{n}}` is unquoted.
  const textForValidation =
    rawType === "json" ? text.replace(/\{\{[^}]+\}\}/g, "0") :
    rawType === "xml"  ? text.replace(/\{\{[^}]+\}\}/g, "_X_") :
                         text;
  const jsonValid = rawType !== "json" || !textForValidation.trim() || isValidJson(textForValidation);
  const xmlValid  = rawType !== "xml"  || !textForValidation.trim() || isValidXml(textForValidation);

  // ── JSON Schema validation (sync, ajv) ──────────────────────────────────
  // Active only when Raw + JSON subtype + body parses + schema set.
  const jsonSchemaResult = useMemo<{ ok: boolean; errors: ErrorObject[]; schemaError?: string } | null>(() => {
    if (rawType !== "json" || !bodySchemaJson.trim() || !text.trim() || !jsonValid) return null;
    let parsedSchema: object;
    try {
      parsedSchema = JSON.parse(bodySchemaJson);
    } catch (e) {
      return { ok: false, errors: [], schemaError: `Invalid schema JSON: ${(e as Error).message}` };
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(textForValidation);
    } catch {
      return null;
    }
    try {
      const validate = ajv.compile(parsedSchema);
      const ok = validate(parsedBody);
      return { ok, errors: ok ? [] : (validate.errors ?? []) };
    } catch (e) {
      return { ok: false, errors: [], schemaError: `Schema compile failed: ${(e as Error).message}` };
    }
  }, [rawType, bodySchemaJson, text, textForValidation, jsonValid]);

  // ── XSD validation (async via lazy-loaded xmllint-wasm) ─────────────────
  // We debounce + dynamic-import so the WASM blob (~500KB) is only fetched
  // when the user actually has an XSD to validate against.
  useEffect(() => {
    if (rawType !== "xml" || !bodySchemaXsd.trim() || !text.trim() || !xmlValid) {
      setXsdResult(null);
      setXsdValidating(false);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setXsdValidating(true);
      try {
        const { validateXML } = await import("xmllint-wasm");
        const result = await validateXML({
          xml: textForValidation,
          schema: bodySchemaXsd,
        });
        if (cancelled) return;
        setXsdResult({
          ok: result.valid,
          errors: result.errors.map(e => ({ message: e.message, line: e.loc?.lineNumber })),
        });
      } catch (e) {
        if (cancelled) return;
        setXsdResult({ ok: false, errors: [], schemaError: (e as Error).message });
      } finally {
        if (!cancelled) setXsdValidating(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [rawType, bodySchemaXsd, text, textForValidation, xmlValid]);

  // Active result for the current language — used to drive the Body toolbar
  // pill and the modal footer.
  const activeSchemaResult: null | { ok: boolean; errors: { message: string; instancePath?: string; line?: number }[]; schemaError?: string } =
    rawType === "json" && jsonSchemaResult
      ? { ok: jsonSchemaResult.ok, errors: jsonSchemaResult.errors.map(e => ({ message: e.message ?? "(no message)", instancePath: e.instancePath })), schemaError: jsonSchemaResult.schemaError }
      : rawType === "xml" && xsdResult
        ? xsdResult
        : null;

  const activeSchema = rawType === "json" ? bodySchemaJson : rawType === "xml" ? bodySchemaXsd : "";

  const textOk = jsonValid && xmlValid && (activeSchemaResult ? activeSchemaResult.ok : true);

  function handleFormat() {
    if (rawType === "json") setText(formatJson(text));
    else if (rawType === "xml") setText(formatXml(text));
  }

  // Templates
  async function saveAsTemplate() {
    if (!newTplName.trim()) return;
    const tpl: Template = {
      name: newTplName.trim(),
      address: address.trim(),
      body: text,
      properties: collectProps(),
      raw_type: rawType,
      batch_enabled: batchEnabled,
      repeat: Number(repeat) || 1,
      delay_ms: Number(delayMs) || 0,
      schedule_enabled: scheduleEnabled,
      schedule_delay_secs: Number(scheduleDelay) || 0,
      reply_enabled: rrEnabled,
      reply_to: rrAddress,
      reply_timeout_ms: Number(rrTimeout) || 5000,
      // Persist Variables tab + Pre-script so the template fully captures the
      // current Send setup. Strip our internal `id` (renumbered on load).
      user_vars: userVars.map(v => ({
        enabled: v.enabled,
        key: v.key,
        value: v.value,
        description: v.description,
      })),
      pre_script: preScript,
      body_schema_json: bodySchemaJson,
      body_schema_xsd:  bodySchemaXsd,
    };
    try {
      await invoke("save_template", { template: tpl });
      await loadTemplates();
      setNewTplName("");
      setSavingTpl(false);
      onLog("ok", `Template "${tpl.name}" saved`);
    } catch (e) { onLog("err", String(e)); }
  }

  async function deleteTemplate(name: string) {
    try {
      await invoke("delete_template", { name });
      await loadTemplates();
      onLog("info", `Template "${name}" deleted`);
    } catch (e) { onLog("err", String(e)); }
  }

  async function renameTemplate(oldName: string, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    try {
      await invoke("rename_template", { oldName, newName: trimmed });
      await loadTemplates();
      onLog("ok", `Template "${oldName}" renamed to "${trimmed}"`);
    } catch (e) { onLog("err", `Rename failed: ${e}`); }
  }

  function loadTemplate(tpl: Template) {
    setAddress(tpl.address);
    setText(tpl.body);
    setMode("raw");
    // Restore Raw subtype: explicit save wins, otherwise let auto-detect pick.
    if (tpl.raw_type) {
      setRawType(tpl.raw_type as RawType);
      setUserPickedRawType(true);
    } else {
      setUserPickedRawType(false);
    }
    const rows = Object.entries(tpl.properties).map(([k, v]) => ({ id: newRowId(), enabled: true, key: k, value: v, description: "" }));
    setProps(rows);
    // Restore Batch / Reply state — for old templates without these fields
    // we fall back to defaults (off / off) rather than leaving them as the
    // current form values.
    setBatchEnabled(tpl.batch_enabled ?? false);
    if (tpl.repeat   !== undefined && tpl.repeat   !== null) setRepeat(String(tpl.repeat));
    if (tpl.delay_ms !== undefined && tpl.delay_ms !== null) setDelayMs(String(tpl.delay_ms));
    setScheduleEnabled(tpl.schedule_enabled ?? false);
    if (tpl.schedule_delay_secs !== undefined && tpl.schedule_delay_secs !== null)
      setScheduleDelay(String(tpl.schedule_delay_secs));
    setRrEnabled(tpl.reply_enabled ?? false);
    if (tpl.reply_to         !== undefined && tpl.reply_to         !== null) setRrAddress(tpl.reply_to);
    if (tpl.reply_timeout_ms !== undefined && tpl.reply_timeout_ms !== null) setRrTimeout(String(tpl.reply_timeout_ms));
    // Variables tab — restore the full list (renumbering ids so they don't
    // collide with anything currently allocated in the form).
    if (tpl.user_vars && tpl.user_vars.length > 0) {
      setUserVars(tpl.user_vars.map(v => ({
        id: newRowId(),
        enabled: v.enabled,
        key: v.key,
        value: v.value,
        description: v.description ?? "",
      })));
    } else {
      // Older templates (or template explicitly saved without vars) → clear,
      // so previously-loaded vars from a different template don't bleed in.
      setUserVars([]);
    }
    setPreScript(tpl.pre_script ?? "");
    // Restore per-language schemas. Legacy templates only had `body_schema` —
    // assume it was the JSON Schema since that was the only kind we supported,
    // and migrate accordingly. Templates saved with the new fields take
    // precedence.
    setBodySchemaJson(tpl.body_schema_json ?? tpl.body_schema ?? "");
    setBodySchemaXsd(tpl.body_schema_xsd ?? "");
    onLog("info", `Template "${tpl.name}" loaded`);
    setTab("body");
  }

  // ── CSV: parsing ─────────────────────────────────────────────────────────
  function loadCsvFile(file: File) {
    setCsvFileName(file.name);
    setCsvParseError(null);
    Papa.parse<string[]>(file, {
      skipEmptyLines: true,
      complete(results) {
        const data = results.data as string[][];
        if (results.errors.length > 0) {
          setCsvParseError(results.errors[0]?.message ?? t("send.csv.parseError"));
        }
        if (data.length === 0) {
          setCsvHeaders([]);
          setCsvRows([]);
          setCsvParseError(t("send.csv.empty"));
          return;
        }
        // First row is the header row. Empty headers fall back to "col_N".
        const rawHeaders = data[0] ?? [];
        const headers = rawHeaders.map((h, i) => h?.trim() || `col_${i + 1}`);
        const rows = data.slice(1).filter(r => r.some(c => c?.length > 0));
        setCsvHeaders(headers);
        setCsvRows(rows);
        setCsvDryRunIdx(0);
        onLog("info", `CSV loaded: ${rows.length} rows, ${headers.length} columns`);
      },
      error(err) {
        setCsvParseError(err.message);
        onLog("err", `CSV parse failed: ${err.message}`);
      },
    });
  }

  function clearCsv() {
    setCsvFileName(null);
    setCsvHeaders([]);
    setCsvRows([]);
    setCsvParseError(null);
    setCsvDryRunIdx(0);
  }

  /** Build a UserVariable[] for a single CSV row. Column headers become keys,
   *  cell values become values; we mark them with a description so the user
   *  knows where a token resolved from when they look at logs. */
  function csvRowToVars(row: string[]): UserVariable[] {
    return csvHeaders.map((h, i) => ({
      id: -(i + 1), // negative ids so they don't collide with form-allocated ones
      enabled: true,
      key: h,
      value: row[i] ?? "",
      description: "(csv)",
    }));
  }

  /** Resolve the body text for a given CSV row index, layering CSV columns on
   *  top of user-defined Variables. Used for the dry-run preview AND the
   *  actual send loop, so the preview reflects exactly what will go out. */
  function resolveBodyForCsvRow(idx: number): string {
    if (mode !== "raw" || !text.trim()) return "";
    const row = csvRows[idx];
    if (!row) return text;
    const merged = [...csvRowToVars(row), ...userVars];
    return applyVariables(text.trim(), merged);
  }

  // ── CSV: bulk-send loop ──────────────────────────────────────────────────
  async function sendCsvBatch() {
    if (!connected)        { onLog("err", t("send.needConnection")); return; }
    if (!address.trim())   { onLog("err", t("send.needQueue")); return; }
    if (mode !== "raw")    { onLog("err", t("send.csv.needRaw")); return; }
    if (!text.trim())      { onLog("err", t("send.needBody")); return; }
    if (csvRows.length === 0) { onLog("err", t("send.csv.needFile")); return; }

    const ctrl = new AbortController();
    csvAbortRef.current = ctrl;
    const total = csvRows.length;
    const delayMs = Math.max(0, Number(csvDelay) || 0);
    let ok = 0;
    let failed = 0;
    setCsvProgress({ done: 0, total, ok: 0, failed: 0 });
    resetSampler();

    const startedAt = Date.now();
    let totalBytes = 0;

    try {
      for (let i = 0; i < total; i++) {
        if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (i > 0 && delayMs > 0) await abortableDelay(delayMs, ctrl.signal);

        const row = csvRows[i];
        const csvVars = csvRowToVars(row);

        // Pre-script: each row gets a fresh run with CSV vars merged in,
        // so scripts can read columns via `ctx.get("col_name")`.
        let varsForRow: UserVariable[] = [...csvVars, ...userVars];
        if (preScript.trim()) {
          const r = await runPreScript(preScript, varsForRow);
          for (const line of r.logs) onLog("info", `pre-script (row ${i + 1}): ${line}`);
          if (r.error) {
            failed++;
            setCsvProgress({ done: i + 1, total, ok, failed });
            onLog("err", `Pre-script error on row ${i + 1}: ${r.error}`);
            continue;
          }
          const overrides: UserVariable[] = Object.entries(r.vars).map(([k, v]) => ({
            id: -1000 - i, enabled: true, key: k, value: v, description: "(pre-script)",
          }));
          varsForRow = [...overrides, ...csvVars, ...userVars];
        }

        const body = applyVariables(text.trim(), varsForRow);
        const customProps: Record<string, string> = {};
        for (const [k, v] of Object.entries(collectProps())) {
          customProps[k] = applyVariables(v, varsForRow);
        }
        if (RAW_TYPE_CT[rawType] && !customProps["content-type"]) {
          customProps["content-type"] = RAW_TYPE_CT[rawType]!;
        }

        try {
          const result = await invoke<SendResult>("send_message", {
            address: address.trim(),
            text: body,
            fileName: null,
            fileDataB64: null,
            customProps,
            replyTo: null,
            profile: activeProfile || null,
          });
          ok++;
          const rowBytes = new TextEncoder().encode(body).length;
          totalBytes += rowBytes;
          sampleSend();
          // Per-row Stats tracking, mirroring the regular batch path —
          // otherwise a 500-row CSV reads as a single send in the dashboard.
          onSent(rowBytes, address.trim(), rawType);
          if (i < 5 || i === total - 1) {
            onLog("ok", `CSV row ${i + 1}/${total} → ${result.address}  |  ${result.message_id}`);
          }
        } catch (e) {
          failed++;
          onLog("err", `CSV row ${i + 1}/${total} failed: ${e}`);
        }
        setCsvProgress({ done: i + 1, total, ok, failed });
      }

      // CSV bulk batch counts as one usage of this destination.
      if (ok > 0) recordRecentQueue(activeProfile, address.trim());
      const durationMs = Date.now() - startedAt;
      onLog(failed === 0 ? "ok" : "err",
        `CSV batch done: ${ok}/${total} sent` +
        (failed > 0 ? `, ${failed} failed` : "") +
        ` in ${(durationMs / 1000).toFixed(1)}s`);
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        onLog("info", `CSV batch cancelled at row ${ok + failed + 1}/${total}`);
      } else {
        onLog("err", `CSV batch failed: ${err.message ?? err}`);
      }
    } finally {
      setCsvProgress(null);
      csvAbortRef.current = null;
    }
  }

  function cancelCsvBatch() {
    csvAbortRef.current?.abort();
  }

  async function doSend() {
    if (!connected)       { onLog("err", t("send.needConnection")); return; }
    if (!address.trim())  { onLog("err", t("send.needQueue")); return; }
    if (mode === "raw" && !text.trim()) { onLog("err", t("send.needBody")); return; }
    if (mode === "raw" && !textOk)      { onLog("err", rawType === "json" ? t("send.badJson") : t("send.badXml")); return; }
    if (mode === "binary" && !file)     { onLog("err", t("send.needFile")); return; }
    // Batch parameters only apply when the toggle on the Batch tab is on.
    // Otherwise we send exactly once with no delay, regardless of leftover
    // values in the inputs.
    const n     = batchEnabled ? Math.max(1, Number(repeat)  || 1) : 1;
    const delay = batchEnabled ? Math.max(0, Number(delayMs) || 0) : 0;
    // `rawProps` holds the unsubstituted template — `{{token}}` resolution
    // happens per-iteration below so `{{counter}}` / `{{uuid}}` / faker
    // tokens update each send the same way they do in the body.
    const rawProps = collectProps();
    const replyTo = rrEnabled && rrAddress.trim() ? rrAddress.trim() : null;
    const startedAt = Date.now();
    setSending(true);
    setProgress({ current: 0, total: n });
    setLastSend(null);
    setRrReply(null);
    setRrTimedOut(false);
    resetSampler();

    // ── Schedule (delayed start) ────────────────────────────────────────
    // Wrap the send in an AbortController so the user can cancel the
    // pending wait. Without abort there'd be no way to back out short of
    // killing the app — clearly user-hostile for a 30-minute schedule.
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      if (scheduleEnabled) {
        const totalSecs = Math.max(0, Number(scheduleDelay) || 0);
        if (totalSecs > 0) {
          onLog("info", `Send scheduled in ${totalSecs}s`);
          // Tick the countdown each second so the status bar can show
          // remaining time. The actual wait uses one big abortable timeout
          // — the ticker is purely cosmetic.
          setScheduleRemaining(totalSecs);
          let remaining = totalSecs;
          const interval = setInterval(() => {
            remaining = Math.max(0, remaining - 1);
            setScheduleRemaining(remaining);
            if (remaining <= 0) clearInterval(interval);
          }, 1000);
          try {
            await abortableDelay(totalSecs * 1000, ctrl.signal);
          } finally {
            clearInterval(interval);
            setScheduleRemaining(null);
          }
        }
      }

      let totalBytes = 0;
      for (let i = 0; i < n; i++) {
        if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (i > 0 && delay > 0) await abortableDelay(delay, ctrl.signal);
        setProgress({ current: i + 1, total: n });
        // Run the Pre-script (if any) before each iteration so dynamic
        // values like timestamps / counters update per-message. Variables
        // it sets layer on top of user-defined Variables tab entries
        // (script wins on key collision).
        let scriptVars: UserVariable[] = userVars;
        if (preScript.trim()) {
          const r = await runPreScript(preScript, userVars);
          for (const line of r.logs) onLog("info", `pre-script: ${line}`);
          if (r.error) {
            onLog("err", `Pre-script error: ${r.error}`);
            throw new Error(`Pre-script error: ${r.error}`);
          }
          // Build a merged var list: script-set keys take precedence.
          const overrides = Object.entries(r.vars).map(([key, value]) => ({
            id: -1, enabled: true, key, value, description: "(pre-script)",
          }));
          scriptVars = [...overrides, ...userVars];
        }
        const resolvedText =
          mode === "raw"  ? applyVariables(text.trim(), scriptVars) :
          mode === "none" ? "" :
          null;

        // Resolve property values per iteration so they pick up the same
        // dynamic tokens (counter, uuid, faker, pre-script vars) that the
        // body sees. Keys are kept verbatim — substitution there is more
        // surprising than useful, and AMQP property names are usually
        // fixed by the consumer's contract.
        const customProps: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawProps)) {
          customProps[k] = applyVariables(v, scriptVars);
        }
        // Auto content-type from rawType, applied here so a user-set
        // `{{content-type}}` token in Properties wins.
        if (mode === "raw" && RAW_TYPE_CT[rawType] && !customProps["content-type"]) {
          customProps["content-type"] = RAW_TYPE_CT[rawType]!;
        }

        // ── Chaos helpers — applied last so they override normal logic.
        let chaosText = resolvedText;
        if (chaosWrongCt && chaosWrongCtValue.trim()) {
          customProps["content-type"] = chaosWrongCtValue.trim();
        }
        if (chaosDropProp && chaosDropPropKey.trim()) {
          delete customProps[chaosDropPropKey.trim()];
        }
        if (chaosCorruptJson && chaosText) {
          // Strip the LAST closing brace/bracket so consumers using strict
          // JSON.parse blow up. If neither character is present, leave as-is.
          const lastBrace = Math.max(chaosText.lastIndexOf("}"), chaosText.lastIndexOf("]"));
          if (lastBrace >= 0) chaosText = chaosText.slice(0, lastBrace) + chaosText.slice(lastBrace + 1);
        }
        if (chaosPadBody && (chaosText !== null && chaosText !== undefined)) {
          const targetBytes = Math.max(1, Math.round((Number(chaosPadSizeMb) || 1) * 1024 * 1024));
          const have = new TextEncoder().encode(chaosText).length;
          if (have < targetBytes) {
            const padLen = targetBytes - have;
            // Append a marker comment so the padding is recognisable on the
            // consumer side without confusing it with payload data.
            chaosText = chaosText + `\n/* AMQPush chaos pad ${padLen} bytes */ ` + "x".repeat(Math.max(0, padLen - 40));
          }
        }

        const result = await invoke<SendResult>("send_message", mode === "binary" && file
          ? { address: address.trim(), text: null, fileName: file.name, fileDataB64: await toBase64(file), customProps, replyTo, profile: activeProfile || null }
          : { address: address.trim(), text: chaosText, fileName: null, fileDataB64: null, customProps, replyTo, profile: activeProfile || null }
        );
        const bytes =
          mode === "raw" && chaosText ? new TextEncoder().encode(chaosText).length :
          mode === "binary" ? (file?.size ?? 0) : 0;
        totalBytes += bytes;
        sampleSend();
        // Bump Stats per-message rather than once-per-batch — otherwise
        // a batch of 100 reads as a single send in the dashboard, and the
        // size distribution / per-queue chart lose all resolution.
        const perMsgKind = mode === "binary" ? "binary" : mode === "none" ? "none" : rawType;
        onSent(bytes, address.trim(), perMsgKind);
        onLog("ok", `Sent → ${result.address}  |  ${result.message_id}  |  ${result.timestamp}`);
      }
      // Bump the per-profile Recent queues MRU so this address shows up
      // at the top of the picker dropdown next time.
      recordRecentQueue(activeProfile, address.trim());
      const durationMs = Date.now() - startedAt;
      setLastSend({ ok: true, count: n, bytes: totalBytes, durationMs, ts: new Date().toLocaleTimeString() });
      setProgress(null);

      if (rrEnabled && replyTo) {
        setRrWaiting(true);
        setSending(false);
        setTab("reply");
        try {
          const timeoutMs = Math.max(500, Number(rrTimeout) || 5000);
          const reply = await invoke<string | null>("await_reply", { address: replyTo, timeoutMs });
          if (reply === null) {
            setRrTimedOut(true);
            onLog("info", `Request-Reply: timed out waiting on '${replyTo}'`);
          } else {
            setRrReply(reply);
            onLog("ok", `Request-Reply: received reply on '${replyTo}'`);
          }
        } catch (e) {
          onLog("err", `Request-Reply error: ${e}`);
        } finally {
          setRrWaiting(false);
        }
        return;
      }
    } catch (e) {
      // The user cancelled a scheduled / batched send — treat as a clean
      // exit, don't bump the error counter.
      if (e instanceof DOMException && e.name === "AbortError") {
        onLog("info", t("send.aborted"));
        setProgress(null);
        setScheduleRemaining(null);
        return;
      }
      const msg = String(e);
      onLog("err", `Send failed: ${msg}`);
      setLastSend({ ok: false, error: msg, ts: new Date().toLocaleTimeString() });
      setProgress(null);
      onSendError?.();
    }
    finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  /** Abort any in-flight scheduled / batch send. Wired to the Cancel button
   *  that shows up in the status bar while a wait is active. */
  function cancelSend() {
    abortRef.current?.abort();
  }

  const hasVars = mode === "raw" && /\{\{.+?\}\}/.test(text);
  const batchActive = batchEnabled;

  const preScriptActive = preScript.trim().length > 0;
  const tabs: TabItem[] = [
    { id: "body",       label: t("send.tab.body"),      icon: <Type className="w-3.5 h-3.5" /> },
    { id: "properties", label: t("send.tab.props"),     icon: <Tag className="w-3.5 h-3.5" />, badge: enabledPropsCount },
    { id: "variables",  label: t("send.tab.vars"),      icon: <Braces className="w-3.5 h-3.5" />, badge: enabledUserVarsCount, dot: hasVars && enabledUserVarsCount === 0 },
    { id: "prescript",  label: t("send.tab.prescript"), icon: <Code2 className="w-3.5 h-3.5" />, dot: preScriptActive },
    { id: "batch",      label: t("send.tab.batch"),     icon: <Repeat2 className="w-3.5 h-3.5" />, dot: batchActive },
    { id: "csv",        label: t("send.tab.csv"),       icon: <FileSpreadsheet className="w-3.5 h-3.5" />, badge: csvRows.length || undefined, dot: !!csvRows.length },
    { id: "reply",      label: t("send.tab.reply"),     icon: <CornerDownLeft className="w-3.5 h-3.5" />, dot: rrEnabled },
    { id: "chaos",      label: t("send.tab.chaos"),     icon: <Bug className="w-3.5 h-3.5" />, dot: chaosActive },
    { id: "templates",  label: t("send.tab.templates"), icon: <BookMarked className="w-3.5 h-3.5" />, badge: templates.length },
  ];

  // Combined autocomplete list for the Body editor: user-defined variables
  // (Variables tab) layered on top of the built-in token catalogue. Built-ins
  // always work in the Body whether the user has "registered" them or not, so
  // they're surfaced in the dropdown unconditionally — that way `{{uuid}}`,
  // `{{timestamp}}` etc. are discoverable without leaving the editor.
  const variableSuggestions: VariableSuggestion[] = (() => {
    const out: VariableSuggestion[] = [];
    // User vars first so they appear at the top of the popup.
    for (const v of userVars) {
      if (!v.enabled || !v.key.trim()) continue;
      out.push({
        name: v.key.trim(),
        description: v.description || `User variable — current value: ${v.value || "(empty)"}`,
        group: "user variable",
      });
    }
    for (const h of VARIABLE_HINTS) {
      const bare = h.token.replace(/^\{\{|\}\}$/g, "");
      // Skip if a user var has the same key — user var shadows the built-in.
      if (out.some(s => s.name === bare)) continue;
      out.push({ name: bare, description: h.description, group: "built-in" });
    }
    return out;
  })();

  const sendDisabled = !connected || sending || (mode === "raw" && !!text && !textOk);

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">

      {/* ─── TITLE ROW ─── */}
      <ViewTopBar
        icon={<Send className="w-3.5 h-3.5" />}
        title={t("send.title")}
      >
        <button
          onClick={doSend}
          disabled={sendDisabled}
          className="shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold bg-accent-strong hover:bg-accent text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
        >
          <Send className="w-3.5 h-3.5" />
          {sending ? t("send.sending") : t("send.send")}
        </button>
      </ViewTopBar>

      {/* ─── QUEUE PICKER ROW ─── */}
      <div className="shrink-0 px-3 py-1.5 border-b border-t-line bg-t-panel flex items-center gap-2">
        <SectionLabel className="shrink-0">{t("send.to")}</SectionLabel>
        <QueuePicker value={address} onChange={setAddress} connected={connected} profileName={activeProfile} showSave className="flex-1" />
      </div>

      {/* ─── TABS ─── */}
      <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id as TabKey)} />

      {/* ─── TAB CONTENT (flex-1, fills all available space) ─── */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">

        {/* BODY TAB */}
        {tab === "body" && (
          <div className="flex-1 min-h-0 flex flex-col">

            {/* Body sub-toolbar — segmented mode picker + raw subtype dropdown + validation/format */}
            <div className="shrink-0 h-9 px-3 flex items-center gap-3 border-b border-t-line bg-t-panel">

              {/* Body mode: none / raw / binary */}
              <SegmentedControl<BodyMode>
                value={mode}
                onChange={setMode}
                casing="normal"
                options={[
                  { value: "none",   label: t("send.mode.none"),   title: t("send.mode.none.hint") },
                  { value: "raw",    label: t("send.mode.raw"),    title: t("send.mode.raw.hint") },
                  { value: "binary", label: t("send.mode.binary"), title: t("send.mode.binary.hint") },
                ]}
              />

              {/* Raw type dropdown — visible only when raw is selected */}
              {mode === "raw" && (
                <Dropdown
                  width="w-32"
                  trigger={({ open, toggle }) => (
                    <button
                      type="button"
                      onClick={toggle}
                      aria-expanded={open}
                      className="flex items-center gap-1 text-[12.5px] text-accent hover:text-accent-content font-medium transition-colors"
                    >
                      {RAW_TYPE_LABEL[rawType]}
                      <ChevronDown className="w-3 h-3" />
                    </button>
                  )}
                >
                  {(["text", "json", "xml"] as RawType[]).map(t => (
                    <DropdownItem
                      key={t}
                      active={rawType === t}
                      onClick={() => userSetRawType(t)}
                    >
                      {RAW_TYPE_LABEL[t]}
                    </DropdownItem>
                  ))}
                </Dropdown>
              )}

              {/* Right side: validation + vars + Beautify */}
              <div className="ml-auto flex items-center gap-3">
                {mode === "raw" && rawType === "json" && text.trim() && (
                  <span className={`flex items-center gap-1 text-[11.5px] font-medium ${jsonValid ? "text-positive" : "text-negative"}`}>
                    {jsonValid
                      ? <><CheckCircle className="w-3 h-3" /> {t("send.valid")}</>
                      : <><XCircle className="w-3 h-3" /> {t("send.invalid")}</>}
                  </span>
                )}
                {mode === "raw" && rawType === "xml" && text.trim() && (
                  <span className={`flex items-center gap-1 text-[11.5px] font-medium ${xmlValid ? "text-positive" : "text-negative"}`}>
                    {xmlValid
                      ? <><CheckCircle className="w-3 h-3" /> {t("send.valid")}</>
                      : <><XCircle className="w-3 h-3" /> {t("send.invalid")}</>}
                  </span>
                )}
                {hasVars && (
                  <span className="flex items-center gap-1 text-[11.5px] text-accent font-medium">
                    <Braces className="w-3 h-3" /> {t("send.vars")}
                  </span>
                )}
                {/* Schema button — opens schema modal. Only shown for JSON / XML
                    subtypes. Status pill (✓ / ✗) is rendered when a schema is
                    configured AND the validator has produced a verdict. */}
                {(rawType === "json" || rawType === "xml") && (
                  <button
                    type="button"
                    onClick={() => setSchemaModalOpen(true)}
                    className={`flex items-center gap-1 text-[11.5px] font-medium transition-colors ${
                      activeSchemaResult
                        ? activeSchemaResult.ok
                          ? "text-positive hover:text-positive"
                          : "text-negative hover:text-negative"
                        : activeSchema.trim()
                          ? "text-accent hover:text-accent-content"
                          : "text-t-ink4 hover:text-accent"
                    }`}
                    title={
                      xsdValidating
                        ? t("send.schema.validating")
                        : activeSchemaResult
                          ? activeSchemaResult.ok
                            ? t("send.schema.ok", { kind: t(rawType === "json" ? "send.schema.jsonKind" : "send.schema.xsdKind") })
                            : t("send.schema.errors", { count: activeSchemaResult.errors.length || 1 })
                          : activeSchema.trim()
                            ? t("send.schema.set", { kind: t(rawType === "json" ? "send.schema.jsonKind" : "send.schema.xsdKind") })
                            : t("send.schema.none", { kind: t(rawType === "json" ? "send.schema.jsonKind" : "send.schema.xsdKind") })
                    }
                  >
                    {xsdValidating
                      ? <><Loader2 className="w-3 h-3 animate-spin" /> {t("send.schema")}…</>
                      : activeSchemaResult
                        ? activeSchemaResult.ok
                          ? <><ShieldCheck className="w-3 h-3" /> {t("send.schema")} ✓</>
                          : <><ShieldCheck className="w-3 h-3" /> {t("send.schema")} ✗{activeSchemaResult.errors.length > 0 && ` (${activeSchemaResult.errors.length})`}</>
                        : activeSchema.trim()
                          ? <><ShieldCheck className="w-3 h-3" /> {t("send.schema")}</>
                          : <><ShieldCheck className="w-3 h-3" /> {t("send.schema.open")}</>}
                  </button>
                )}
                {mode === "raw" && rawType !== "text" && (
                  <button onClick={handleFormat}
                    className="flex items-center gap-1 text-[11.5px] text-t-ink4 hover:text-accent transition-colors font-medium">
                    <Wand2 className="w-3 h-3" /> {t("send.beautify")}
                  </button>
                )}
              </div>
            </div>

            {/* None mode — empty body indicator */}
            {mode === "none" && (
              <div className="flex-1 min-h-0">
                <EmptyState
                  icon={<Type className="w-8 h-8" />}
                  title={t("send.body.none")}
                  subtitle={t("send.body.none.hint")}
                />
              </div>
            )}

            {/* Raw editor — flush, full-width, Postman style */}
            {mode === "raw" && (
              <div className="flex-1 min-h-0 flex flex-col">
                <CodeEditor
                  value={text}
                  onChange={v => setText(v)}
                  language={rawType === "json" ? "json" : rawType === "xml" ? "xml" : "text"}
                  placeholder={t("send.body.placeholder", { kind: RAW_TYPE_LABEL[rawType] })}
                  minHeight="120px"
                  className={`flex-1 ${text && !textOk ? "ring-1 ring-negative/30" : ""}`}
                  variables={variableSuggestions}
                />
              </div>
            )}

            {/* Binary file picker — click to browse OR drag from Finder/Explorer */}
            {mode === "binary" && (
              <div className="flex-1 min-h-0 p-3">
                <div
                  onClick={() => fileRef.current?.click()}
                  onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
                  onDragOver={(e)  => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
                  onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOver(false);
                    const dropped = e.dataTransfer?.files;
                    if (dropped && dropped.length > 0) setFile(dropped[0]);
                  }}
                  className={`h-full flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-xl cursor-pointer transition-all ${
                    dragOver
                      ? "border-accent bg-accent/5"
                      : "border-t-line2 hover:border-accent/50 hover:bg-t-hover"
                  }`}
                >
                  <FileUp className={`w-8 h-8 transition-colors ${dragOver ? "text-accent" : "text-t-ink5"}`} />
                  {file ? (
                    <div className="text-center">
                      <p className="text-[13px] text-t-ink font-medium">{file.name}</p>
                      <p className="text-[11.5px] text-t-ink4 mt-1">{(file.size / 1024).toFixed(1)} KB</p>
                      <button onClick={(e) => { e.stopPropagation(); setFile(null); if (fileRef.current) fileRef.current.value = ""; }}
                        className="mt-2 text-[11.5px] text-t-ink5 hover:text-negative transition-colors">{t("send.file.clear")}</button>
                    </div>
                  ) : (
                    <div className="text-center">
                      <p className={`text-[13px] transition-colors ${dragOver ? "text-accent font-medium" : "text-t-ink5"}`}>
                        {dragOver ? t("send.file.drop") : t("send.file.pick")}
                      </p>
                      {!dragOver && (
                        <p className="text-[11.5px] text-t-ink5 mt-1">{t("send.file.or")}</p>
                      )}
                    </div>
                  )}
                </div>
                <input ref={fileRef} type="file" className="hidden" onChange={e => setFile(e.target.files?.[0] ?? null)} />
              </div>
            )}
          </div>
        )}

        {/* PROPERTIES TAB */}
        {tab === "properties" && (
          <div className="flex-1 min-h-0 flex flex-col">

            {/* Sub-toolbar */}
            <div className="shrink-0 h-9 px-3 flex items-center gap-2 border-b border-t-line bg-t-panel">
              <span className="text-[11.5px] text-t-ink4">
                {t("send.props.note")}
              </span>
              <button onClick={addProp}
                className="ml-auto h-7 px-2.5 rounded-lg text-[12px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors flex items-center gap-1">
                <Plus className="w-3 h-3" /> {t("send.add")}
              </button>
            </div>

            {/* Table */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {/* Column headers */}
              <div className="sticky top-0 z-10 grid grid-cols-[28px_1fr_1fr_1fr_28px] items-center gap-2 px-3 py-1.5 border-b border-t-line bg-t-panel">
                <div></div>
                {/* Header labels match the row inputs' inner padding (px-1.5)
                    so KEY / VALUE / DESCRIPTION line up with the placeholder
                    text below, not 6 px to the left of it. */}
                <SectionLabel className="px-1.5">{t("send.props.key")}</SectionLabel>
                <SectionLabel className="px-1.5">{t("send.props.value")}</SectionLabel>
                <SectionLabel className="px-1.5">{t("send.props.desc")}</SectionLabel>
                <div></div>
              </div>

              {/* Rows */}
              {props.length === 0 ? (
                <EmptyState
                  icon={<Tag className="w-8 h-8" />}
                  title={t("send.props.none")}
                  action={
                    <button onClick={addProp}
                      className="text-[11.5px] text-accent hover:text-accent-content transition-colors">
                      {t("send.props.first")}
                    </button>
                  }
                />
              ) : (
                props.map(row => (
                  <div key={row.id}
                    className="grid grid-cols-[28px_1fr_1fr_1fr_28px] items-center gap-2 px-3 py-1 border-b border-t-line/40 hover:bg-t-hover/50 group">
                    <label className="flex items-center justify-center cursor-pointer">
                      <input type="checkbox" checked={row.enabled !== false}
                        onChange={e => updateProp(row.id, "enabled", e.target.checked)}
                        className="amqp-checkbox" />
                    </label>
                    {/* Key — autocomplete from previously-sent property names
                        in History. Particularly useful for the long Artemis
                        `_AMQ_*` markers no one remembers exactly. */}
                    <AutocompleteInput
                      value={row.key}
                      onChange={v => updateProp(row.id, "key", v)}
                      suggestions={historyProps.keys}
                      placeholder={t("send.props.keyPlaceholder")}
                      className="bg-transparent text-[12.5px] leading-4 h-7 w-full box-border appearance-none text-t-ink outline-none placeholder:text-t-ink5 font-mono py-1.5 px-1.5 rounded-md hover:bg-t-card focus:bg-t-field focus:ring-2 focus:ring-accent/25"
                    />
                    {/* Value — keeps TokenInput for the `{{var}}` flow; on
                        focus we additionally show a small history-picker
                        button when the current key has known values. Both
                        layered in a relative wrapper so the autocomplete
                        popups don't clip. */}
                    <ValueWithHistoryPick
                      row={row}
                      historyValues={historyProps.valuesByKey.get(row.key.trim()) ?? []}
                      variableSuggestions={variableSuggestions}
                      onChange={v => updateProp(row.id, "value", v)}
                    />
                    <input value={row.description ?? ""} onChange={e => updateProp(row.id, "description", e.target.value)}
                      placeholder={t("send.props.descPlaceholder")}
                      className="bg-transparent text-[12.5px] leading-4 h-7 box-border appearance-none text-t-ink3 outline-none placeholder:text-t-ink5 font-mono py-1.5 px-1.5 rounded-md hover:bg-t-card focus:bg-t-field focus:ring-2 focus:ring-accent/25" />
                    <button onClick={() => removeProp(row.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 text-t-ink5 hover:text-negative transition-all rounded-md">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* VARIABLES TAB */}
        {tab === "variables" && (
          <div className="flex-1 min-h-0 flex flex-col">

            {/* Sub-toolbar: caption + Presets dropdown + Add */}
            <div className="shrink-0 h-9 px-3 border-b border-t-line bg-t-panel flex items-center gap-2">
              <span className="text-[11.5px] text-t-ink4">
                {t("send.vars.note")}
              </span>

              {/* Presets dropdown — click-to-open via shared Dropdown */}
              <div className="ml-auto">
                <Dropdown
                  align="right"
                  width="w-72"
                  trigger={({ open, toggle }) => (
                    <button
                      type="button"
                      onClick={toggle}
                      aria-expanded={open}
                      className="h-7 px-2.5 rounded-lg text-[12px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors flex items-center gap-1 border border-t-line"
                    >
                      <Braces className="w-3 h-3" /> Built-in presets
                      <ChevronDown className="w-3 h-3" />
                    </button>
                  )}
                >
                  <div className="px-3 py-1.5 border-b border-t-line">
                    <SectionLabel>{t("send.vars.add")}</SectionLabel>
                  </div>
                  <div className="max-h-64 overflow-y-auto py-1">
                    {VARIABLE_HINTS.map(v => (
                      <button key={v.token} onClick={() => insertPresetVar(v.token, v.description)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-t-hover transition-colors text-left">
                        <code className="text-[11.5px] text-accent font-mono shrink-0">{v.token}</code>
                        <span className="text-[10.5px] text-t-ink4 truncate">{v.description}</span>
                      </button>
                    ))}
                  </div>
                </Dropdown>
              </div>

              <button onClick={addUserVar}
                className="h-7 px-2.5 rounded-lg text-[12px] font-medium text-t-ink4 hover:text-t-ink hover:bg-t-hover transition-colors flex items-center gap-1">
                <Plus className="w-3 h-3" /> {t("send.add")}
              </button>
            </div>

            {/* Table-style variables list */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {/* Column headers */}
              <div className="sticky top-0 z-10 grid grid-cols-[28px_1fr_1fr_1fr_28px] items-center gap-2 px-3 py-1.5 border-b border-t-line bg-t-panel">
                <div></div>
                {/* Header labels match the row inputs' inner padding (px-1.5)
                    so KEY / VALUE / DESCRIPTION line up with the placeholder
                    text below, not 6 px to the left of it. */}
                <SectionLabel className="px-1.5">{t("send.props.key")}</SectionLabel>
                <SectionLabel className="px-1.5">{t("send.props.value")}</SectionLabel>
                <SectionLabel className="px-1.5">{t("send.props.desc")}</SectionLabel>
                <div></div>
              </div>

              {/* Rows */}
              {userVars.length === 0 ? (
                <EmptyState
                  icon={<Braces className="w-8 h-8" />}
                  title={t("send.vars.none")}
                  subtitle={t("send.vars.none.hint")}
                  action={
                    <button onClick={addUserVar}
                      className="text-[11.5px] text-accent hover:text-accent-content transition-colors">
                      {t("send.vars.first")}
                    </button>
                  }
                />
              ) : (
                userVars.map(v => (
                  <div key={v.id}
                    className="grid grid-cols-[28px_1fr_1fr_1fr_28px] items-center gap-2 px-3 py-1 border-b border-t-line/40 hover:bg-t-hover/50 group">
                    {/* Enabled checkbox */}
                    <label className="flex items-center justify-center cursor-pointer">
                      <input type="checkbox" checked={v.enabled}
                        onChange={e => updateUserVar(v.id, "enabled", e.target.checked)}
                        className="amqp-checkbox" />
                    </label>
                    <input value={v.key} onChange={e => updateUserVar(v.id, "key", e.target.value)}
                      placeholder={t("send.props.keyPlaceholder")}
                      className="bg-transparent text-[12.5px] leading-4 h-7 box-border appearance-none text-t-ink outline-none placeholder:text-t-ink5 font-mono py-1.5 px-1.5 rounded-md hover:bg-t-card focus:bg-t-field focus:ring-2 focus:ring-accent/25" />
                    <input value={v.value} onChange={e => updateUserVar(v.id, "value", e.target.value)}
                      placeholder={t("send.vars.valuePlaceholder")}
                      className="bg-transparent text-[12.5px] leading-4 h-7 box-border appearance-none text-t-ink outline-none placeholder:text-t-ink5 font-mono py-1.5 px-1.5 rounded-md hover:bg-t-card focus:bg-t-field focus:ring-2 focus:ring-accent/25" />
                    <input value={v.description} onChange={e => updateUserVar(v.id, "description", e.target.value)}
                      placeholder={t("send.props.descPlaceholder")}
                      className="bg-transparent text-[12.5px] leading-4 h-7 box-border appearance-none text-t-ink3 outline-none placeholder:text-t-ink5 font-mono py-1.5 px-1.5 rounded-md hover:bg-t-card focus:bg-t-field focus:ring-2 focus:ring-accent/25" />
                    <button onClick={() => removeUserVar(v.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 text-t-ink5 hover:text-negative transition-all rounded-md">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* PRE-SCRIPT TAB */}
        {tab === "prescript" && (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="shrink-0 h-9 px-3 flex items-center border-b border-t-line bg-t-panel">
              <span className="text-[11.5px] text-t-ink4">
                JavaScript that runs before each send. Set variables via{" "}
                <code className="text-accent font-mono">ctx.set(name, value)</code>{" "}
                — they become available as <code className="text-accent font-mono">{`{{name}}`}</code>{" "}
                in the body.
              </span>
            </div>

            <div className="flex-1 min-h-0 flex flex-col">
              <CodeEditor
                value={preScript}
                onChange={v => setPreScript(v)}
                language="text"
                placeholder={`// Available API:\n//   ctx.set(name, value)   — set a variable\n//   ctx.get(name)          — read a variable\n//   ctx.log(...args)       — write to AMQPush logs\n//   ctx.now                — Date.now() at script start\n//   ctx.uuid()             — random UUID v4\n// Globals: Date, Math, JSON, crypto\n\nctx.set("orderId", "ord-" + Math.floor(Math.random() * 100000));\nctx.set("submittedAt", new Date(ctx.now).toISOString());`}
                minHeight="160px"
                className="flex-1"
              />
            </div>

            <div className="shrink-0 px-3 py-1.5 border-t border-t-line bg-t-panel flex items-center gap-2">
              <span className="text-[10.5px] text-t-ink5">
                {t("send.prescript.note")}
              </span>
              <button
                onClick={async () => {
                  const r = await runPreScript(preScript, userVars);
                  for (const line of r.logs) onLog("info", `pre-script: ${line}`);
                  if (r.error) onLog("err", `Pre-script error: ${r.error}`);
                  else {
                    const count = Object.keys(r.vars).length;
                    onLog("ok", `Pre-script ran — ${count} variable${count === 1 ? "" : "s"} set${count > 0 ? `: ${Object.keys(r.vars).join(", ")}` : ""}`);
                  }
                }}
                disabled={!preScript.trim()}
                className="ml-auto h-7 px-2.5 rounded-lg text-[12px] font-medium text-t-ink4 hover:text-accent hover:bg-accent/10 transition-colors flex items-center gap-1 disabled:opacity-40"
                title={t("send.prescript.run")}
              >
                <Code2 className="w-3 h-3" /> Test run
              </button>
            </div>
          </div>
        )}

        {/* BATCH TAB */}
        {tab === "batch" && (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="shrink-0 h-9 px-3 flex items-center border-b border-t-line bg-t-panel">
              <span className="text-[11.5px] text-t-ink4">{t("send.batch.note")}</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">

              {/* Enable toggle — same toggle-card pattern as Reply / Connection's TLS. */}
              <div className="flex items-center justify-between p-2.5 rounded-xl bg-t-card border border-t-line">
                <div className="flex flex-col">
                  <span className="text-[13px] text-t-ink2">{t("send.batch.title")}</span>
                  <span className="text-[10.5px] text-t-ink5">{t("send.batch.hint")}</span>
                </div>
                <Toggle checked={batchEnabled} onChange={setBatchEnabled} ariaLabel={t("send.batch.enable")} />
              </div>

              {/* Batch parameters — disabled when the toggle is off (visual + form-level). */}
              <div>
                <SectionLabel className="block mb-2">{t("send.batch.params")}</SectionLabel>
                <div className={`bg-t-card border border-t-line rounded-xl p-3 space-y-3 ${batchEnabled ? "" : "opacity-50"}`}>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-content-subtle mb-1.5">
                      {t("send.batch.count")}
                      <span className="text-t-ink5 normal-case font-normal">{t("send.batch.count.hint")}</span>
                    </label>
                    <input type="number" min="1" value={repeat} onChange={e => setRepeat(e.target.value)} disabled={!batchEnabled}
                      className={`${INPUT} w-32`} />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-content-subtle mb-1.5">
                      {t("send.batch.delayLabel")}
                      <span className="text-t-ink5 normal-case font-normal">{t("send.batch.delay.hint")}</span>
                    </label>
                    <input type="number" min="0" value={delayMs} onChange={e => setDelayMs(e.target.value)} disabled={!batchEnabled}
                      className={`${INPUT} w-32`} />
                  </div>
                </div>
              </div>

              {batchEnabled && (
                <Callout variant="info">
                  {t("send.batch.summary", { count: repeat })}
                  {Number(delayMs) > 0 && t("send.batch.summaryDelay", { delay: delayMs })}.
                </Callout>
              )}

              {/* ── Schedule (delayed start) ───────────────────────────────────── */}
              <div className="flex items-center justify-between p-2.5 rounded-xl bg-t-card border border-t-line">
                <div className="flex flex-col">
                  <span className="text-[13px] text-t-ink2">{t("send.schedule.title")}</span>
                  <span className="text-[10.5px] text-t-ink5">{t("send.schedule.hint")}</span>
                </div>
                <Toggle checked={scheduleEnabled} onChange={setScheduleEnabled} ariaLabel={t("send.schedule.enable")} />
              </div>

              <div>
                <SectionLabel className="block mb-2">{t("send.schedule.params")}</SectionLabel>
                <div className={`bg-t-card border border-t-line rounded-xl p-3 space-y-3 ${scheduleEnabled ? "" : "opacity-50"}`}>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-content-subtle mb-1.5">
                      {t("send.schedule.delay")}
                      <span className="text-t-ink5 normal-case font-normal">{t("send.schedule.delay.hint")}</span>
                    </label>
                    <input type="number" min="0" value={scheduleDelay} onChange={e => setScheduleDelay(e.target.value)} disabled={!scheduleEnabled}
                      className={`${INPUT} w-32`} />
                  </div>
                </div>
              </div>

              {scheduleEnabled && Number(scheduleDelay) > 0 && (
                <Callout variant="info">
                  {t("send.schedule.summary", { delay: scheduleDelay })}
                </Callout>
              )}
            </div>
          </div>
        )}

        {/* CSV TAB ─────────────────────────────────────────────────────────
            Bulk-send mode: load a CSV, each row becomes one message. Column
            values are layered on top of user Variables for that iteration so
            `{{column_name}}` tokens in Body / Properties resolve from the row. */}
        {tab === "csv" && (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="shrink-0 h-9 px-3 flex items-center border-b border-t-line bg-t-panel">
              <span className="text-[11.5px] text-t-ink4">
                {t("send.csv.note")}
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">

              {/* ── File picker / dropzone ──────────────────────────────── */}
              {!csvFileName ? (
                <div
                  onDragOver={e => { e.preventDefault(); setCsvDragOver(true); }}
                  onDragLeave={() => setCsvDragOver(false)}
                  onDrop={e => {
                    e.preventDefault();
                    setCsvDragOver(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) loadCsvFile(f);
                  }}
                  onClick={() => csvFileInputRef.current?.click()}
                  className={`flex flex-col items-center justify-center gap-2 px-4 py-10 rounded-xl border-2 border-dashed cursor-pointer transition-all ${
                    csvDragOver
                      ? "border-accent bg-accent/10"
                      : "border-t-line2 bg-t-card hover:border-accent/40 hover:bg-t-hover"
                  }`}
                >
                  <FileSpreadsheet className="w-8 h-8 text-t-ink4" />
                  <div className="text-[13px] text-t-ink2">{t("send.csv.pick")}</div>
                  <div className="text-[11.5px] text-t-ink5">{t("send.csv.or")}</div>
                  <input
                    ref={csvFileInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={e => { const f = e.target.files?.[0]; if (f) loadCsvFile(f); e.target.value = ""; }}
                    className="hidden"
                  />
                </div>
              ) : (
                <>
                  {/* Loaded-file summary card */}
                  <div className="flex items-center gap-2 p-2.5 rounded-xl bg-t-card border border-t-line">
                    <FileSpreadsheet className="w-4 h-4 text-accent shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] text-t-ink truncate">{csvFileName}</div>
                      <div className="text-[10.5px] text-t-ink5">
                        {csvRows.length.toLocaleString()} rows · {csvHeaders.length} columns
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => csvFileInputRef.current?.click()}
                      className="text-[11.5px] text-t-ink4 hover:text-accent px-2 py-1 rounded-md hover:bg-t-hover transition-colors"
                      title={t("send.csv.replace")}
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmClearCsv(true)}
                      className="p-1 rounded-md text-t-ink4 hover:text-negative hover:bg-t-hover transition-colors"
                      title={t("send.csv.clear")}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                    <input
                      ref={csvFileInputRef}
                      type="file"
                      accept=".csv,text/csv"
                      onChange={e => { const f = e.target.files?.[0]; if (f) loadCsvFile(f); e.target.value = ""; }}
                      className="hidden"
                    />
                  </div>

                  {csvParseError && (
                    <Callout variant="error">CSV parse error: {csvParseError}</Callout>
                  )}

                  {csvHeaders.length > 0 && (
                    <>
                      {/* Column tokens — clicking copies `{{name}}` into clipboard for paste into Body. */}
                      <div>
                        <SectionLabel className="block mb-2">
                          Column tokens
                          <span className="text-t-ink5 normal-case font-normal">
                            {" — paste into Body / Properties; values come from the current row"}
                          </span>
                        </SectionLabel>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {csvHeaders.map(h => (
                            <button
                              key={h}
                              type="button"
                              onClick={() => navigator.clipboard.writeText(`{{${h}}}`).then(
                                () => onLog("info", `Copied {{${h}}} to clipboard`),
                                () => {/* clipboard might be denied — silently ignore */}
                              )}
                              className="font-mono text-[11.5px] px-2 py-0.5 rounded-md border border-t-line2 bg-t-card hover:border-accent/40 hover:text-accent hover:bg-accent/5 text-t-ink2 transition-colors"
                              title={`Click to copy {{${h}}} to clipboard`}
                            >
                              {`{{${h}}}`}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Preview table — first 5 rows so the user can verify what columns look like. */}
                      <div>
                        <SectionLabel className="block mb-2">{t("send.csv.preview")} <span className="text-t-ink5 normal-case font-normal">{t("send.csv.previewHint", { shown: Math.min(5, csvRows.length), total: csvRows.length })}</span></SectionLabel>
                        <div className="bg-t-card border border-t-line rounded-lg overflow-auto max-h-48">
                          <table className="w-full text-[11.5px] font-mono">
                            <thead className="sticky top-0 bg-t-panel">
                              <tr>
                                <th className="text-left px-2 py-1 text-t-ink5 font-semibold">#</th>
                                {csvHeaders.map(h => (
                                  <th key={h} className="text-left px-2 py-1 text-t-ink3 font-semibold whitespace-nowrap">{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {csvRows.slice(0, 5).map((row, i) => (
                                <tr key={i}
                                  onClick={() => setCsvDryRunIdx(i)}
                                  className={`cursor-pointer border-t border-t-line/40 ${
                                    csvDryRunIdx === i ? "bg-accent/10" : "hover:bg-t-hover/50"
                                  }`}
                                >
                                  <td className="px-2 py-1 text-t-ink5">{i + 1}</td>
                                  {csvHeaders.map((_, j) => (
                                    <td key={j} className="px-2 py-1 text-t-ink2 truncate max-w-[200px]">
                                      {row[j] ?? ""}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {/* Dry-run preview — show how the Body resolves for the highlighted row. */}
                      {mode === "raw" && text.trim() && (
                        <div>
                          <SectionLabel className="block mb-2">
                            Dry-run preview
                            <span className="text-t-ink5 normal-case font-normal"> — body for row {csvDryRunIdx + 1} after substitution</span>
                          </SectionLabel>
                          <pre className="bg-t-card border border-t-line rounded-lg p-2.5 text-[11.5px] font-mono text-t-ink2 max-h-40 overflow-auto whitespace-pre-wrap">
                            {resolveBodyForCsvRow(csvDryRunIdx) || "(empty)"}
                          </pre>
                        </div>
                      )}

                      {/* Per-row delay control */}
                      <div>
                        <SectionLabel className="block mb-2">{t("send.params")}</SectionLabel>
                        <div className="bg-t-card border border-t-line rounded-xl p-3">
                          <label className="block text-[10px] uppercase tracking-wide text-content-subtle mb-1.5">
                            Delay between rows
                            <span className="text-t-ink5 normal-case font-normal"> — milliseconds, 0 = as fast as possible</span>
                          </label>
                          <input type="number" min="0" value={csvDelay} onChange={e => setCsvDelay(e.target.value)}
                            className={`${INPUT} w-32`} />
                        </div>
                      </div>

                      {/* Bulk-send action — replaces the regular Send for this batch. */}
                      <div className="flex items-center gap-2 pt-1">
                        {!csvProgress ? (
                          <button
                            type="button"
                            onClick={sendCsvBatch}
                            disabled={!connected || !text.trim() || mode !== "raw" || !address.trim()}
                            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[13px] font-semibold bg-accent-strong hover:bg-accent text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Send className="w-3.5 h-3.5" />
                            Send {csvRows.length.toLocaleString()} message{csvRows.length !== 1 ? "s" : ""}
                          </button>
                        ) : (
                          <>
                            <div className="flex-1 flex items-center gap-2">
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-accent shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 text-[12.5px]">
                                  <span className="text-t-ink2 font-mono">
                                    {csvProgress.done}/{csvProgress.total}
                                  </span>
                                  <span className="text-positive text-[11.5px] font-mono">{csvProgress.ok} ok</span>
                                  {csvProgress.failed > 0 && (
                                    <span className="text-negative text-[11.5px] font-mono">{csvProgress.failed} fail</span>
                                  )}
                                  {sendRateHistory.length > 0 && (
                                    <>
                                      <Sparkline
                                        values={sendRateHistory}
                                        width={96}
                                        height={14}
                                        color="rgb(var(--t-ink3))"
                                        fillColor="rgb(var(--t-ink4) / 0.18)"
                                        title={t("send.rate")}
                                        className="ml-auto"
                                      />
                                      <span className="text-[10.5px] text-t-ink5 font-mono shrink-0">
                                        {sendRateHistory[sendRateHistory.length - 1]}/s
                                      </span>
                                    </>
                                  )}
                                </div>
                                <div className="mt-1 h-1.5 rounded-full bg-t-line overflow-hidden">
                                  <div
                                    className="h-full bg-accent transition-all"
                                    style={{ width: `${(csvProgress.done / Math.max(1, csvProgress.total)) * 100}%` }}
                                  />
                                </div>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={cancelCsvBatch}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-medium bg-negative/10 border border-negative/30 text-negative hover:bg-negative/20 transition-colors"
                            >
                              <Square className="w-3 h-3" /> Cancel
                            </button>
                          </>
                        )}
                      </div>

                      <Callout variant="info">
                        {t("send.csv.prescriptNote")}
                      </Callout>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* REPLY TAB */}
        {tab === "reply" && (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="shrink-0 h-9 px-3 flex items-center border-b border-t-line bg-t-panel">
              <span className="text-[11.5px] text-t-ink4">{t("send.reply.note")}</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">

              {/* Enable toggle — same toggle-card pattern as Connection's TLS / SASL ANONYMOUS. */}
              <div className="flex items-center justify-between p-2.5 rounded-xl bg-t-card border border-t-line">
                <div className="flex flex-col">
                  <span className="text-[13px] text-t-ink2">{t("send.reply.title")}</span>
                  <span className="text-[10.5px] text-t-ink5">{t("send.reply.hint")}</span>
                </div>
                <Toggle checked={rrEnabled} onChange={setRrEnabled} ariaLabel={t("send.reply.enable")} />
              </div>

              {/* Reply-target settings card — fields are disabled when the toggle is off. */}
              <div>
                <SectionLabel className="block mb-2">{t("send.reply.target")}</SectionLabel>
                <div className={`bg-t-card border border-t-line rounded-xl p-3 space-y-3 ${rrEnabled ? "" : "opacity-50"}`}>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-content-subtle mb-1.5">
                      Reply-to address
                      <span className="text-t-ink5 normal-case font-normal"> — queue we'll listen on</span>
                    </label>
                    <QueuePicker
                      value={rrAddress}
                      onChange={setRrAddress}
                      connected={connected}
                      profileName={activeProfile}
                      disabled={!rrEnabled}
                      placeholder={t("send.reply.placeholder")}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-content-subtle mb-1.5">
                      Timeout
                      <span className="text-t-ink5 normal-case font-normal"> — milliseconds before giving up</span>
                    </label>
                    <input type="number" min="500" value={rrTimeout} onChange={e => setRrTimeout(e.target.value)} disabled={!rrEnabled}
                      className={`${INPUT} w-32`} />
                  </div>
                </div>
              </div>

              {rrWaiting && (
                <Callout
                  variant="info"
                  icon={<Loader2 className="w-3.5 h-3.5 animate-spin" />}
                >
                  Waiting for reply on <span className="font-mono">{rrAddress}</span>…
                </Callout>
              )}
              {rrTimedOut && !rrWaiting && (
                <Callout variant="warn" icon={<Clock className="w-3.5 h-3.5" />}>
                  Timed out — no reply received within {rrTimeout}ms
                </Callout>
              )}
              {rrReply !== null && !rrWaiting && (
                <Callout
                  variant="success"
                  icon={<CheckCircle className="w-3.5 h-3.5" />}
                  title={t("send.reply.received")}
                  action={
                    <CopyButton
                      value={rrReply ?? ""}
                      onCopied={() => onLog("info", t("send.reply.copied"))}
                      label={t("send.copy")}
                      title={t("send.reply.copy")}
                      className="flex items-center gap-1 text-[10.5px] text-t-ink4 hover:text-t-ink2 transition-colors px-1.5 py-0.5 rounded-md hover:bg-t-hover"
                    />
                  }
                >
                  <pre className="font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
                    {(() => { try { return JSON.stringify(JSON.parse(rrReply!), null, 2); } catch { return rrReply!; } })()}
                  </pre>
                </Callout>
              )}
            </div>
          </div>
        )}

        {/* TEMPLATES TAB */}
        {tab === "templates" && (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="shrink-0 h-9 px-3 border-b border-t-line bg-t-panel flex items-center gap-2">
              <span className="text-[11.5px] text-t-ink4">{t("send.tpl.title")}</span>
              <div className="ml-auto">
                {savingTpl ? (
                  <div className="flex gap-1.5">
                    <input autoFocus value={newTplName} onChange={e => setNewTplName(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") saveAsTemplate(); if (e.key === "Escape") setSavingTpl(false); }}
                      placeholder={t("send.tpl.name")} className={`${INPUT} text-xs py-1 w-40`} />
                    <button onClick={saveAsTemplate} className="px-2 py-1 bg-accent-strong text-white text-xs rounded-md hover:bg-accent">{t("send.tpl.save")}</button>
                    <button onClick={() => setSavingTpl(false)} className="px-2 py-1 text-t-ink4 text-xs hover:text-t-ink rounded-md hover:bg-t-hover">✕</button>
                  </div>
                ) : (
                  <button onClick={() => setSavingTpl(true)}
                    className="flex items-center gap-1 h-7 px-2.5 rounded-lg text-[12px] font-medium text-t-ink3 hover:text-t-ink hover:bg-t-hover transition-colors">
                    <Save className="w-3 h-3" /> Save current
                  </button>
                )}
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              {templates.length === 0 ? (
                <EmptyState
                  icon={<BookMarked className="w-8 h-8" />}
                  title={t("send.tpl.none")}
                  subtitle={t("send.tpl.saveHint")}
                />
              ) : (
                // Columns chosen for at-a-glance triage of saved templates.
                // The Features column collapses six boolean configuration
                // flags (batch / schedule / reply / pre-script / schema /
                // user-vars) into one icon row — each present icon = that
                // feature is configured, no icon = it's not. Single fixed
                // height per row, monospace alignment for the numeric
                // columns, vertical-center on every cell so chips and
                // counts line up regardless of row content.
                <table className="w-full text-[12.5px] table-fixed">
                  <colgroup>
                    <col className="w-[24%]" />{/* Name */}
                    <col className="w-[24%]" />{/* Address */}
                    <col className="w-[60px]" />{/* Kind */}
                    <col className="w-[72px]" />{/* Size */}
                    <col className="w-[220px]" />{/* Features */}
                    <col className="w-[64px]" />{/* Actions */}
                  </colgroup>
                  <thead className="sticky top-0 bg-t-panel border-b border-t-line z-10">
                    <tr className="text-[10px] uppercase tracking-wide text-content-subtle">
                      <th className="px-3 py-2 text-left font-semibold">{t("send.tpl.column.name")}</th>
                      <th className="px-2 py-2 text-left font-semibold">{t("send.tpl.column.address")}</th>
                      <th className="px-2 py-2 text-left font-semibold">{t("send.tpl.column.kind")}</th>
                      <th className="px-2 py-2 text-left font-semibold">{t("send.tpl.column.size")}</th>
                      <th className="px-2 py-2 text-left font-semibold" title={t("send.tpl.features.hint")}>{t("send.tpl.column.features")}</th>
                      <th className="px-2 py-2" aria-label={t("send.tpl.actions")} />
                    </tr>
                  </thead>
                  <tbody>
                    {templates.map(tpl => {
                      const isRenaming = renamingTpl === tpl.name;
                      const kind: "json" | "xml" | "text" =
                        tpl.raw_type === "json" || tpl.raw_type === "xml" || tpl.raw_type === "text"
                          ? tpl.raw_type
                          : tpl.body.trimStart().startsWith("{") || tpl.body.trimStart().startsWith("[")
                            ? "json"
                            : tpl.body.trimStart().startsWith("<")
                              ? "xml"
                              : "text";
                      const sizeBytes = new TextEncoder().encode(tpl.body).length;
                      const propsCount = Object.keys(tpl.properties).length;
                      const batchOn = tpl.batch_enabled === true
                        || ((tpl.repeat ?? 1) > 1)
                        || ((tpl.delay_ms ?? 0) > 0);
                      const scheduleOn = tpl.schedule_enabled === true
                        || ((tpl.schedule_delay_secs ?? 0) > 0);
                      const replyOn = tpl.reply_enabled === true
                        || !!(tpl.reply_to && tpl.reply_to.trim());
                      const preScriptOn = !!(tpl.pre_script && tpl.pre_script.trim());
                      const schemaOn = !!((tpl.body_schema_json && tpl.body_schema_json.trim())
                        || (tpl.body_schema_xsd && tpl.body_schema_xsd.trim())
                        || (tpl.body_schema && tpl.body_schema.trim()));
                      const userVarsCount = tpl.user_vars?.length ?? 0;
                      // Plain text colour for the Kind column — no chip
                      // background. JSON / XML stay tinted so the body
                      // subtype is still scannable; text falls back to
                      // the default ink colour.
                      const kindColor =
                        kind === "json" ? "text-accent" :
                        kind === "xml"  ? "text-accent-content" :
                                          "text-t-ink3";

                      // Renaming mode — render a single full-width row that
                      // captures the input + Save/Cancel; spans all columns
                      // so the table layout doesn't reflow under the user.
                      if (isRenaming) {
                        return (
                          <tr key={tpl.name} className="border-b border-t-line/40 bg-accent/5">
                            <td colSpan={6} className="px-3 py-1.5">
                              <div className="flex items-center gap-2">
                                <input
                                  autoFocus
                                  value={renamingDraft}
                                  onChange={e => setRenamingDraft(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === "Enter") {
                                      renameTemplate(tpl.name, renamingDraft);
                                      setRenamingTpl(null);
                                    }
                                    if (e.key === "Escape") setRenamingTpl(null);
                                  }}
                                  className={`${INPUT} flex-1 text-[13px] py-1`}
                                />
                                <button
                                  onClick={() => { renameTemplate(tpl.name, renamingDraft); setRenamingTpl(null); }}
                                  className="px-2 py-1 bg-accent-strong text-white text-[11.5px] font-semibold rounded-md hover:bg-accent"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => setRenamingTpl(null)}
                                  className="px-2 py-1 text-t-ink4 text-[11.5px] hover:text-t-ink hover:bg-t-hover rounded-md"
                                >
                                  Cancel
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      }

                      return (
                        <tr key={tpl.name}
                          onClick={() => loadTemplate(tpl)}
                          className="h-9 border-b border-t-line/40 hover:bg-t-hover/50 cursor-pointer group transition-colors">
                          <td className="px-3 align-middle">
                            <span className="text-t-ink font-medium truncate block" title={tpl.name}>
                              {tpl.name}
                            </span>
                          </td>
                          <td className="px-2 align-middle">
                            <span className="font-mono text-t-ink3 truncate block"
                              title={tpl.address || "no address"}>
                              {tpl.address || <span className="italic text-t-ink5">—</span>}
                            </span>
                          </td>
                          <td className="px-2 align-middle">
                            <span className={`text-[11.5px] font-mono font-medium uppercase ${kindColor}`}>
                              {kind}
                            </span>
                          </td>
                          <td className="px-2 align-middle text-t-ink4 font-mono">{fmtBytes(sizeBytes)}</td>
                          <td className="px-2 align-middle">
                            {/* Icon-only flag row. Order mirrors the Send
                                view's tab strip — Body (schema), Properties,
                                Variables, Pre-script, Batch (+ Schedule),
                                Reply — so users can scan the table with the
                                same left-to-right model they edit templates. */}
                            <div className="flex items-center justify-start gap-2 text-t-ink5">
                              <FeatureFlag
                                on={schemaOn}
                                icon={<ShieldCheck className="w-3.5 h-3.5" />}
                                color="text-accent-content"
                                title={schemaOn ? t("send.tpl.hasSchema") : t("send.tpl.noSchema")}
                              />
                              <FeatureFlag
                                on={propsCount > 0}
                                icon={<Tag className="w-3.5 h-3.5" />}
                                color="text-t-ink2"
                                title={propsCount > 0 ? t("send.tpl.props", { count: propsCount }) : t("send.tpl.noProps")}
                                badge={propsCount > 0 ? propsCount : undefined}
                              />
                              <FeatureFlag
                                on={userVarsCount > 0}
                                icon={<Braces className="w-3.5 h-3.5" />}
                                color="text-accent"
                                title={userVarsCount > 0 ? t("send.tpl.vars", { count: userVarsCount }) : t("send.tpl.noVars")}
                                badge={userVarsCount > 0 ? userVarsCount : undefined}
                              />
                              <FeatureFlag
                                on={preScriptOn}
                                icon={<Code2 className="w-3.5 h-3.5" />}
                                color="text-positive"
                                title={preScriptOn ? t("send.tpl.hasScript") : t("send.tpl.noScript")}
                              />
                              <FeatureFlag
                                on={batchOn}
                                icon={<Repeat2 className="w-3.5 h-3.5" />}
                                color="text-caution"
                                title={batchOn
                                  ? t("send.tpl.batch", {
                                      count: tpl.repeat ?? 1,
                                      delay: tpl.delay_ms ? t("send.tpl.batchDelay", { delay: tpl.delay_ms }) : "",
                                    })
                                  : t("send.tpl.noBatch")}
                              />
                              <FeatureFlag
                                on={scheduleOn}
                                icon={<Clock className="w-3.5 h-3.5" />}
                                color="text-caution"
                                title={scheduleOn ? t("send.tpl.schedule", { delay: tpl.schedule_delay_secs ?? 0 }) : t("send.tpl.noSchedule")}
                              />
                              <FeatureFlag
                                on={replyOn}
                                icon={<CornerUpLeft className="w-3.5 h-3.5" />}
                                color="text-accent-content"
                                title={replyOn
                                  ? (tpl.reply_to ? t("send.tpl.reply", { queue: tpl.reply_to }) : t("send.tpl.replyDynamic"))
                                  : t("send.tpl.noReply")}
                              />
                            </div>
                          </td>
                          <td className="px-2 align-middle whitespace-nowrap">
                            <button
                              onClick={(e) => { e.stopPropagation(); setRenamingTpl(tpl.name); setRenamingDraft(tpl.name); }}
                              title={t("send.tpl.rename")}
                              className="opacity-0 group-hover:opacity-100 p-1 text-t-ink5 hover:text-accent transition-all rounded-md"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); deleteTemplate(tpl.name); }}
                              title={t("send.tpl.delete")}
                              className="opacity-0 group-hover:opacity-100 p-1 text-t-ink5 hover:text-negative transition-all rounded-md"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* CHAOS TAB — poison-pill helpers for testing consumer error paths. */}
        {tab === "chaos" && (
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
            <div className="text-[11.5px] text-t-ink5 leading-relaxed">
              {t("send.chaos.intro")}
              <span className="block mt-1 text-caution">{t("send.chaos.warn")}</span>
            </div>

            {/* 1) Oversized body — pad to N MB */}
            <div className="bg-t-card border border-t-line rounded-xl p-3 space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={chaosPadBody} onChange={e => setChaosPadBody(e.target.checked)}
                  className="amqp-checkbox" />
                <span className="text-[13px] text-t-ink2 font-medium">{t("send.chaos.oversized")}</span>
              </label>
              <div className={`pl-5 space-y-1 text-[11.5px] ${chaosPadBody ? "" : "opacity-50"}`}>
                <p className="text-t-ink5">{t("send.chaos.oversized.note")}</p>
                <div className="flex items-center gap-2">
                  <label className="text-[10px] uppercase tracking-wide text-content-subtle">{t("send.chaos.size")}</label>
                  <input type="number" min="0.1" step="0.5" value={chaosPadSizeMb}
                    disabled={!chaosPadBody}
                    onChange={e => setChaosPadSizeMb(e.target.value)}
                    className="bg-t-field border border-t-line2 rounded-md px-1.5 py-0.5 text-[12.5px] text-t-ink w-20 outline-none focus:border-accent disabled:opacity-50" />
                  <span className="text-t-ink5">MB</span>
                </div>
              </div>
            </div>

            {/* 2) Wrong content-type */}
            <div className="bg-t-card border border-t-line rounded-xl p-3 space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={chaosWrongCt} onChange={e => setChaosWrongCt(e.target.checked)}
                  className="amqp-checkbox" />
                <span className="text-[13px] text-t-ink2 font-medium">{t("send.chaos.contentType")}</span>
              </label>
              <div className={`pl-5 space-y-1 text-[11.5px] ${chaosWrongCt ? "" : "opacity-50"}`}>
                <p className="text-t-ink5">{t("send.chaos.contentType.note")}</p>
                <input value={chaosWrongCtValue}
                  disabled={!chaosWrongCt}
                  onChange={e => setChaosWrongCtValue(e.target.value)}
                  placeholder={t("send.chaos.contentTypePlaceholder")}
                  className="w-full bg-t-field border border-t-line2 rounded-md px-2 py-1 text-[12.5px] font-mono text-t-ink outline-none focus:border-accent disabled:opacity-50" />
              </div>
            </div>

            {/* 3) Corrupt JSON */}
            <div className="bg-t-card border border-t-line rounded-xl p-3 space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={chaosCorruptJson} onChange={e => setChaosCorruptJson(e.target.checked)}
                  className="amqp-checkbox" />
                <span className="text-[13px] text-t-ink2 font-medium">{t("send.chaos.malformed")}</span>
              </label>
              <p className={`pl-5 text-[11.5px] text-t-ink5 ${chaosCorruptJson ? "" : "opacity-50"}`}>
                {t("send.chaos.malformed.note")}
              </p>
            </div>

            {/* 4) Drop a property */}
            <div className="bg-t-card border border-t-line rounded-xl p-3 space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={chaosDropProp} onChange={e => setChaosDropProp(e.target.checked)}
                  className="amqp-checkbox" />
                <span className="text-[13px] text-t-ink2 font-medium">{t("send.chaos.strip")}</span>
              </label>
              <div className={`pl-5 space-y-1 text-[11.5px] ${chaosDropProp ? "" : "opacity-50"}`}>
                <p className="text-t-ink5">{t("send.chaos.strip.note")}</p>
                <input value={chaosDropPropKey}
                  disabled={!chaosDropProp}
                  onChange={e => setChaosDropPropKey(e.target.value)}
                  placeholder={t("send.chaos.stripPlaceholder")}
                  className="w-full bg-t-field border border-t-line2 rounded-md px-2 py-1 text-[12.5px] font-mono text-t-ink outline-none focus:border-accent disabled:opacity-50" />
              </div>
            </div>

            {chaosActive && (
              <div className="rounded-md border border-caution/30 bg-caution/5 p-2 text-[11.5px] text-caution flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{t("send.chaos.warning")}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── STATUS BAR ─────────────────────────────────────────────────── */}
      <div className="shrink-0 px-3 py-1.5 border-t border-t-line bg-t-panel flex items-center gap-2 text-[11.5px] font-mono">
        {scheduleRemaining !== null ? (
          // Schedule countdown — sending is delayed but the user can bail.
          <>
            <Clock className="w-3 h-3 text-caution shrink-0" />
            <span className="text-caution">{t("send.status.scheduled", { sec: scheduleRemaining })}</span>
            <button
              onClick={cancelSend}
              className="ml-2 px-2 py-0.5 rounded-md text-[10.5px] font-medium text-negative hover:bg-negative/10 transition-colors"
            >
              {t("send.status.cancel")}
            </button>
          </>
        ) : sending && progress ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin text-accent shrink-0" />
            <span className="text-accent">
              Sending {progress.current} / {progress.total}
              {progress.total > 1 && (
                <span className="text-accent/60 ml-1">
                  ({Math.round((progress.current / progress.total) * 100)}%)
                </span>
              )}
            </span>
            {progress.total > 1 && (
              <div className="ml-2 flex-1 max-w-[200px] h-1 bg-accent/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                />
              </div>
            )}
            {progress.total > 1 && sendRateHistory.length > 0 && (
              <>
                <Sparkline
                  values={sendRateHistory}
                  width={80}
                  height={12}
                  color="rgb(var(--t-ink3))"
                  fillColor="rgb(var(--t-ink4) / 0.18)"
                  title={t("send.rate")}
                />
                <span className="text-[10.5px] text-t-ink5 font-mono">
                  {sendRateHistory[sendRateHistory.length - 1]}/s
                </span>
              </>
            )}
            {progress.total > 1 && (
              <button
                onClick={cancelSend}
                className="ml-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium text-negative hover:bg-negative/10 transition-colors"
              >
                Cancel
              </button>
            )}
          </>
        ) : rrWaiting ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin text-caution shrink-0" />
            <span className="text-caution">{t("send.status.waiting")} <span className="text-caution">{rrAddress}</span> …</span>
          </>
        ) : rrReply !== null ? (
          <>
            <CheckCircle className="w-3 h-3 text-positive shrink-0" />
            <span className="text-positive">{t("send.status.replied")}</span>
            <span className="text-t-ink5">·</span>
            <span className="text-t-ink4">{new TextEncoder().encode(rrReply).length} B</span>
          </>
        ) : rrTimedOut ? (
          <>
            <Clock className="w-3 h-3 text-caution shrink-0" />
            <span className="text-caution">{t("send.status.timeout", { ms: rrTimeout })}</span>
          </>
        ) : lastSend?.ok ? (
          <>
            <CheckCircle className="w-3 h-3 text-positive shrink-0" />
            <span className="text-positive">
              Sent {lastSend.count} message{(lastSend.count ?? 0) > 1 ? "s" : ""}
            </span>
            {(lastSend.bytes ?? 0) > 0 && (
              <>
                <span className="text-t-ink5">·</span>
                <span className="text-t-ink3">{fmtBytes(lastSend.bytes!)}</span>
              </>
            )}
            {lastSend.durationMs !== undefined && (
              <>
                <span className="text-t-ink5">·</span>
                <span className="text-t-ink3">{fmtDuration(lastSend.durationMs)}</span>
              </>
            )}
            <span className="text-t-ink5">at {lastSend.ts}</span>
          </>
        ) : lastSend && !lastSend.ok ? (
          <>
            <XCircle className="w-3 h-3 text-negative shrink-0" />
            <span className="text-negative truncate" title={lastSend.error}>
              {lastSend.error}
            </span>
            <span className="text-t-ink5 shrink-0">at {lastSend.ts}</span>
          </>
        ) : (
          <>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${connected ? "bg-t-ink4" : "bg-caution"}`} />
            <span className="text-t-ink4">
              {connected ? t("send.ready") : t("send.notConnected")}
            </span>
          </>
        )}

        {/* Right side: dest + connection indicator */}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {address && (
            <>
              <span className="text-t-ink5">→</span>
              <span className="text-t-ink3 truncate max-w-[200px]" title={address}>{address}</span>
            </>
          )}
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-positive" : "bg-t-ink5"}`} />
        </div>
      </div>

      {/* ─── SCHEMA MODAL ─── */}
      {schemaModalOpen && (rawType === "json" || rawType === "xml") && (
        <SchemaModal
          language={rawType}
          value={rawType === "json" ? bodySchemaJson : bodySchemaXsd}
          onChange={v => rawType === "json" ? setBodySchemaJson(v) : setBodySchemaXsd(v)}
          result={activeSchemaResult}
          validating={xsdValidating}
          bodyEmpty={!text.trim()}
          onClose={() => setSchemaModalOpen(false)}
          onLog={onLog}
        />
      )}

      {/* ─── CLEAR-CSV CONFIRM ─── */}
      <ConfirmDialog
        open={confirmClearCsv}
        title={t("send.csv.clear")}
        body={<p>{t("send.csv.clearBody", { file: csvFileName ?? "", count: csvRows.length.toLocaleString() })}</p>}
        confirmLabel={t("send.csv.clear")}
        onConfirm={() => { clearCsv(); setConfirmClearCsv(false); }}
        onCancel={() => setConfirmClearCsv(false)}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SchemaModal — reusable modal for editing the active body-validation schema
// (JSON Schema for JSON bodies, XSD for XML bodies). Supports paste-or-upload
// of schema text and shows live validation results from the parent.
// ─────────────────────────────────────────────────────────────────────────────

interface SchemaModalProps {
  language: "json" | "xml";
  value: string;
  onChange: (v: string) => void;
  result: null | { ok: boolean; errors: { message: string; instancePath?: string; line?: number }[]; schemaError?: string };
  validating: boolean;
  bodyEmpty: boolean;
  onClose: () => void;
  onLog: (kind: "info" | "ok" | "err", text: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// FeatureFlag — one icon slot in the Templates table's Features column.
//
// Renders the icon in `color` when `on`, or as a dimmed/faded placeholder
// when off — so the column has a stable grid of slots in the same order
// across rows. Optional `badge` shows a small number next to the icon
// (used for the user-variables count).
// ─────────────────────────────────────────────────────────────────────────────
function FeatureFlag({
  on, icon, color, title, badge,
}: {
  on: boolean;
  icon: ReactNode;
  color: string;
  title: string;
  badge?: number;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-0.5 font-mono text-[10.5px] transition-colors ${
        on ? color : "text-t-line2/60"
      }`}
    >
      {icon}
      {on && badge !== undefined && badge > 0 && (
        <span className="leading-none">{badge}</span>
      )}
    </span>
  );
}

function SchemaModal({
  language, value, onChange, result, validating, bodyEmpty, onClose, onLog,
}: SchemaModalProps) {
  const t = useAmqpText();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const isJson = language === "json";
  const title = isJson ? t("send.schemaModal.title.json") : t("send.schemaModal.title.xsd");
  const kind = isJson ? t("send.schema.jsonKind") : t("send.schema.xsdKind");
  const editorLang = isJson ? "json" : "xml";
  const placeholder = isJson
    ? `{\n  "type": "object",\n  "required": ["id"],\n  "properties": {\n    "id": { "type": "string" }\n  }\n}`
    : `<?xml version="1.0" encoding="UTF-8"?>\n<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">\n  <xs:element name="root" type="xs:string"/>\n</xs:schema>`;
  const acceptAttr = isJson ? ".json,application/json" : ".xsd,.xml,application/xml,text/xml";

  // Esc to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleFile(file: File) {
    try {
      const text = await file.text();
      onChange(text);
      onLog("info", t("send.schemaModal.loaded", { kind, file: file.name }));
    } catch (e) {
      onLog("err", `Failed to read ${file.name}: ${e}`);
    }
  }

  function pickFile() {
    fileInputRef.current?.click();
  }

  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) await handleFile(f);
    e.target.value = "";
  }

  function clearSchema() {
    onChange("");
  }

  // Status banner content
  let statusBanner: ReactNode = null;
  if (!value.trim()) {
    statusBanner = (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-t-card border border-t-line text-[12.5px] text-t-ink4">
        <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
        <span>{t("send.schemaModal.none", { kind })}</span>
      </div>
    );
  } else if (validating) {
    statusBanner = (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-t-card border border-t-line text-[12.5px] text-t-ink3">
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        <span>{t("send.schemaModal.validating")}</span>
      </div>
    );
  } else if (bodyEmpty) {
    statusBanner = (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-t-card border border-t-line text-[12.5px] text-t-ink4">
        <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
        <span>{t("send.schemaModal.emptyBody")}</span>
      </div>
    );
  } else if (result?.schemaError) {
    statusBanner = (
      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-negative/10 border border-negative/30 text-[12.5px] text-negative">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <div>
          <div className="font-medium">{t("send.schemaModal.bad")}</div>
          <div className="text-negative mt-0.5">{result.schemaError}</div>
        </div>
      </div>
    );
  } else if (result?.ok) {
    statusBanner = (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-positive/10 border border-positive/30 text-[12.5px] text-positive">
        <CheckCircle className="w-3.5 h-3.5 shrink-0" />
        <span>{t("send.schemaModal.ok", { kind })}</span>
      </div>
    );
  } else if (result && !result.ok) {
    statusBanner = (
      <div className="flex flex-col gap-1.5 px-3 py-2 rounded-lg bg-negative/10 border border-negative/30 text-[12.5px] text-negative">
        <div className="flex items-center gap-2">
          <XCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="font-medium">
            {result.errors.length} validation error{result.errors.length !== 1 ? "s" : ""}
          </span>
        </div>
        <ul className="ml-5 list-disc space-y-0.5 max-h-[160px] overflow-y-auto">
          {result.errors.slice(0, 50).map((err, i) => (
            <li key={i} className="text-negative break-words">
              {err.instancePath && <span className="font-mono mr-1">{err.instancePath}:</span>}
              {err.line !== undefined && <span className="font-mono mr-1">line {err.line}:</span>}
              <span>{err.message}</span>
            </li>
          ))}
          {result.errors.length > 50 && (
            <li className="text-negative">…and {result.errors.length - 50} more</li>
          )}
        </ul>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-t-bg border border-t-line rounded-xl shadow-2xl w-[760px] max-w-[92vw] max-h-[85vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-t-line bg-t-panel">
          <ShieldCheck className="w-3.5 h-3.5 text-accent shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] text-t-ink font-medium">{title}</div>
            <div className="text-[10.5px] text-t-ink5">
              {t("send.schemaModal.note")}
            </div>
          </div>
          <button
            type="button"
            onClick={pickFile}
            className="flex items-center gap-1 text-[11.5px] text-t-ink3 hover:text-accent px-2 py-1 rounded-md transition-colors border border-t-line2 hover:border-accent/50"
            title={t("send.schemaModal.upload", { kind })}
          >
            <FileUp className="w-3 h-3" /> Upload…
          </button>
          {value.trim() && (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="flex items-center gap-1 text-[11.5px] text-t-ink4 hover:text-negative px-2 py-1 rounded-md transition-colors"
              title={t("send.schemaModal.clear")}
            >
              <Trash2 className="w-3 h-3" /> Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-t-ink4 hover:text-t-ink hover:bg-t-hover"
            aria-label={t("send.schemaModal.close")}
          >
            <X className="w-3.5 h-3.5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={acceptAttr}
            className="hidden"
            onChange={onFileChange}
          />
        </div>

        {/* Editor */}
        <div className="flex-1 min-h-0 flex flex-col p-3 gap-2 overflow-hidden">
          <div className="flex-1 min-h-[240px] overflow-hidden border border-t-line2 rounded-lg">
            <CodeEditor
              value={value}
              onChange={onChange}
              language={editorLang}
              placeholder={placeholder}
              minHeight="240px"
              className="h-full"
            />
          </div>
          {statusBanner}
        </div>

        {/* Footer */}
        <div className="shrink-0 px-3 py-2 border-t border-t-line bg-t-panel flex items-center gap-3 text-[10.5px] text-t-ink5">
          <span>
            {isJson
              ? t("send.schemaModal.draft")
              : t("send.schemaModal.xsdNote")}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <kbd className="font-mono px-1 py-0.5 border border-t-line rounded-md">Esc</kbd> {t("send.schemaModal.esc")}
          </span>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title={t("send.schemaModal.clearOne", { kind })}
        body={
          <p>
            Discard the current {isJson ? "JSON Schema" : "XSD"}? You'll lose any unsaved
            edits — the schema textarea will be emptied. This doesn't affect the schema saved
            in the active template.
          </p>
        }
        confirmLabel={t("send.schemaModal.clear")}
        onConfirm={() => { clearSchema(); setConfirmClear(false); }}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Value field for one row of the Properties tab — wraps the existing
 * TokenInput (which handles `{{var}}` autocomplete) and adds a small icon
 * button on the right that opens a dropdown of previously-used values for
 * the current key. The picker only appears when there's actually history
 * to pick from, so it stays invisible for first-time users.
 */
function ValueWithHistoryPick({ row, historyValues, variableSuggestions, onChange }: {
  row: PropertyRow;
  historyValues: string[];
  variableSuggestions: VariableSuggestion[];
  onChange: (v: string) => void;
}) {
  const t = useAmqpText();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function click(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", click);
    return () => document.removeEventListener("mousedown", click);
  }, [open]);

  const hasValues = historyValues.length > 0;
  return (
    <div ref={wrapRef} className="relative flex items-center gap-1">
      <TokenInput
        value={row.value}
        onChange={onChange}
        suggestions={variableSuggestions}
        placeholder={t("send.props.valuePlaceholder")}
        className="flex-1 min-w-0 text-[12.5px] leading-4 h-7 box-border py-1.5 px-1.5 rounded-md hover:bg-t-card focus-within:bg-t-field focus-within:ring-1 focus-within:ring-accent/30"
      />
      {hasValues && (
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          title={t("send.history.hint", { count: historyValues.length, key: row.key })}
          aria-label={t("send.history.pick")}
          className={`shrink-0 p-1 rounded-md transition-colors ${
            open ? "text-accent bg-accent/10" : "text-t-ink5 hover:text-t-ink2 hover:bg-t-hover"
          }`}
        >
          <ChevronDown className="w-3 h-3" />
        </button>
      )}
      {open && hasValues && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-t-card border border-t-line rounded-lg shadow-lg overflow-hidden w-72 max-h-64 overflow-y-auto">
          <div className="px-3 py-1 border-b border-t-line bg-t-panel text-[10px] uppercase tracking-wide text-content-subtle">
            History values for <span className="font-mono normal-case text-t-ink3">{row.key || "(empty key)"}</span>
          </div>
          {historyValues.map(v => (
            <button
              key={v}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { onChange(v); setOpen(false); }}
              className={`w-full text-left px-3 py-1 text-[12.5px] font-mono truncate transition-colors ${
                v === row.value
                  ? "bg-accent/10 text-accent"
                  : "text-t-ink2 hover:bg-t-hover hover:text-t-ink"
              }`}
              title={v}
            >
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
