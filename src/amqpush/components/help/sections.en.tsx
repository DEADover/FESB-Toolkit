import { BarChart3, BookMarked, BookOpen, Braces, Bug, ChevronRight, Code2, CornerDownLeft, Database, FileSpreadsheet, Filter, Hash, History as HistoryIcon, Inbox, Keyboard, ListTree, Network, Palette, Plug, Repeat2, Send, ShieldCheck, Sparkles, Terminal } from "lucide-react";

import { Code, H, H3, Kbd, Li, Note, P, Row, UL, Warn, type HelpSection } from "./primitives";

/**
 * Встроенное руководство, английский текст.
 *
 * Разделы перенесены из отдельного приложения как есть. Русская версия
 * лежит рядом, в `sections.ru.tsx`, и повторяет ту же структуру: те же
 * идентификаторы разделов, тот же порядок, те же кирпичики разметки.
 */
export const SECTIONS_EN: HelpSection[] = [
  /* ── Getting Started ──────────────────────────────────────────────────── */
  {
    id: "getting-started",
    title: "Getting started",
    icon: <BookOpen className="w-3.5 h-3.5" />,
    searchText: "getting started overview connect first message stand broker amqp 1.0 artemis",
    content: (
      <>
        <H><BookOpen className="w-4 h-4 text-accent" />Getting started</H>
        <P>
          AMQPush is a desktop client for AMQP&nbsp;1.0 brokers (ActiveMQ Artemis, Azure Service Bus,
          Solace, RabbitMQ with the AMQP&nbsp;1.0 plugin, etc.). Use it to publish messages, subscribe
          to queues, browse pending messages, replay history, and inspect broker state.
        </P>
        <H3>The 60-second tour</H3>
        <UL>
          <Li>Open <b>Connections</b> in the sidebar, fill in the <b>Broker</b> block at the bottom of the stand form, then hit <b>Connect</b> in this section's header.</Li>
          <Li>Switch to <b>Send Messages</b>, type a queue name (autocompletes from broker), put text in the Body, hit <b>Send</b> or <Kbd>⌘</Kbd><Kbd>Enter</Kbd>.</Li>
          <Li><b>Receive Messages</b> shows live messages; <b>REC</b> captures them to a recording, <b>Replay…</b> plays one back to any queue.</Li>
          <Li><b>Browser</b> peeks at queue contents without consuming — checkboxes enable selective <b>Purge</b>, <b>Shovel</b> (cross-broker copy) and DLQ <b>Edit &amp; Requeue</b>.</Li>
          <Li><b>Broker Clients</b> (⌘4) shows every client connected to the broker and what each one is consuming.</Li>
          <Li><b>History</b> keeps the last 200 sends with full payload for resend.</Li>
        </UL>
        <Note>
          Press <Kbd>⌘</Kbd><Kbd>K</Kbd> anywhere in this section to open its command palette —
          every action and view is reachable from there.
        </Note>
        <H3>Where data lives</H3>
        <P>
          Templates and send history are stored as JSON under <Code>~/.amqpush/</Code>; broker
          settings belong to the stand and live with the rest of the app's settings. Logs and view
          preferences are in the window's storage. No telemetry, no cloud sync — everything is on
          your machine.
        </P>
      </>
    ),
  },

  /* ── Connection ───────────────────────────────────────────────────────── */
  {
    id: "connection",
    title: "Connection",
    icon: <Plug className="w-3.5 h-3.5" />,
    searchText: "connection stand broker host port queue username password tls ssl amqps heartbeat container id sasl anonymous certificate skip verify websocket ws wss reconnect backoff multiplier send retry mtls client certificate pem pkcs12 p12 pfx latency settings",
    content: (
      <>
        <H><Plug className="w-4 h-4 text-accent" />Broker &amp; stand</H>
        <P>
          The broker belongs to a <b>stand</b>, right next to the bus address: one stand, one
          set of settings. Open <b>Connections</b> in the sidebar — the <b>AMQP</b> block sits
          at the bottom of the stand form. The stand chip in this section's header opens the
          very same screen.
        </P>
        <P>
          Which stand is active is decided in the app header, the same one the API section
          works against. This section's header names it and connects to its broker; there is no
          second list of profiles to keep in sync.
        </P>

        <P>
          <b>Test Broker</b> in the block header opens its own short-lived connection: it logs
          in with these very settings and asks the broker its name. The section's live
          subscriber is not disturbed, and nothing is created on the broker — the default
          queue is deliberately left alone, since checking it would create it on a broker with
          auto-create on.
        </P>

        <H3>The three fields that matter</H3>
        <Row label="Broker host">Leave it empty and the bus host is used — the broker usually lives on the same machine. Fill it in when it doesn't.</Row>
        <Row label="Port">Default <Code>5672</Code> without TLS, <Code>5671</Code> with it.</Row>
        <Row label="Default queue">Optional. Pre-fills the destination in the Send view. Independent of the <b>Recent</b> queues in the queue picker.</Row>

        <H3>Toggles</H3>
        <Row label="TLS / AMQPS">Encrypt the connection. Turning it on reveals <b>Skip certificate check</b> for self-signed and test brokers — keep it off in production.</Row>
        <Row label="SASL ANONYMOUS">Connect without credentials at all; the broker has to allow anonymous logins.</Row>
        <Row label="Over WebSocket">Tunnel AMQP through <Code>ws://</Code> (or <Code>wss://</Code> with TLS on) instead of raw TCP. Reaches brokers that publish AMQP over a WebSocket binding — RabbitMQ with <Code>rabbitmq_web_amqp</Code>, Azure Service Bus, Amazon MQ, Solace — and gets through firewalls that block 5671 and 5672.</Row>

        <H3>More Settings</H3>
        <P>Set once per broker; <b>More Settings</b> at the top right of the block unfolds them, grouped by what they are for. A question mark next to a label opens what that field does.</P>
        <Row label="Broker user / password">Empty means the bus credentials — same as the host. Fill them in when the broker has its own account.</Row>
        <Row label="WebSocket path">The path in the URL when the WebSocket transport is on; empty is the root.</Row>
        <Row label="Container id">How the client introduces itself to the broker; defaults to <Code>amqpush-&lt;uuid&gt;</Code>. Set it when the broker authorises connections by container name, or to make yourself recognisable in broker logs.</Row>
        <Row label="Heartbeat">Seconds between keep-alive frames; <Code>0</Code> is off. Needed when a firewall or NAT drops idle connections — most brokers use 30 s.</Row>
        <Row label="Connect timeout">Abort the first attempt after N seconds. <Code>0</Code> removes the limit.</Row>
        <Row label="Reconnect delays">Three knobs for a dropped subscriber: <b>first delay</b> (ms), <b>longest delay</b> (ms) and <b>multiplier</b>. Defaults 1000 / 30000 / 2 — start at a second, double each attempt, cap at thirty. Lower the first delay for fast iteration; raise the cap to spare broker logs during a long outage.</Row>
        <Row label="Send attempts / delay">A budget for sporadic send failures: attempts (<Code>1</Code> means no retry) and the pause between them. Wraps every send — useful when the broker rate-limits or fails over a replica. Reconnecting after a drop happens on its own and doesn't spend this budget.</Row>
        <Row label="mTLS certificate / key / passphrase">
          Mutual TLS, where the broker recognises the client by certificate. Give a path to a
          PEM <Code>.crt</Code> plus a separate unencrypted PKCS#8 <Code>.key</Code>, or to a
          PKCS#12 <Code>.p12</Code>/<Code>.pfx</Code> bundle with its passphrase. The folder
          icon inside each field opens the system file picker. PEM keys must be unencrypted —
          convert with <Code>openssl pkcs8 -topk8 -nocrypt</Code>, or use a
          PKCS#12 bundle. The fields stay disabled until <b>TLS / AMQPS</b> is on: a certificate
          has nothing to ride on without server TLS. <b>Not supported over WebSocket</b> — with
          both enabled the connection errors out.
        </Row>

        <H3>The section header</H3>
        <UL>
          <Li><b>Stand name and host:port</b> — click it to open the stand settings. Says <i>broker not set</i> when the stand has no host to connect to; Connect then takes you to the settings instead of failing.</Li>
          <Li><b>Connect / Disconnect</b> — connects to the broker of the selected stand. Also on Cmd+K.</Li>
          <Li><b>Green dot and latency</b> — round-trip to the broker, measured every 5 s by the cheapest management ping. Amber past 100 ms, red past 500 ms. Degrading network or broker health shows up <i>before</i> a send or a subscribe stalls.</Li>
        </UL>

        <Note>
          Stands live with the rest of the app's settings, and the broker password follows the
          same rule as the bus password: it is only written down when <b>Remember password</b>
          is on for that stand. The mTLS key passphrase goes with it.
        </Note>
      </>
    ),
  },

  /* ── Send view ────────────────────────────────────────────────────────── */
  {
    id: "send",
    title: "Send",
    icon: <Send className="w-3.5 h-3.5" />,
    searchText: "send publish publisher message body json xml text binary file properties application properties tabs subtype raw beautify format codemirror autocomplete history key value chaos poison pill malformed oversized content-type drop header retry",
    content: (
      <>
        <H><Send className="w-4 h-4 text-accent" />Send (publisher)</H>
        <P>
          The Send view is organized as tabs. Body and Properties are the essentials; everything
          else (Variables, Pre-script, Batch, CSV, Reply, Templates) is opt-in.
        </P>
        <H3>Queue picker</H3>
        <P>
          The destination field at the top of Send (and the equivalent on Receive) drops down a
          combined list. The <b>Recent</b> section is the 10 most recently used queues for the
          current stand — anything you've successfully sent to or subscribed from. Hover a
          recent row to reveal a small × that forgets that entry; the rest fills up automatically.
          Below it is the <b>broker queues</b> table, refreshed when you open the dropdown.
        </P>
        <H3>Body</H3>
        <UL>
          <Li><b>None</b> — empty payload. Useful for queue probes / wake-up signals.</Li>
          <Li><b>Raw</b> — text body with subtype <Code>text</Code> / <Code>json</Code> / <Code>xml</Code>. The subtype drives editor highlighting, validation and the Beautify button.</Li>
          <Li><b>Binary</b> — file upload (click or drag from Finder/Explorer). Sent as <Code>Body::Data</Code>.</Li>
        </UL>
        <P>
          The subtype is auto-detected from the first non-whitespace character (<Code>{"{"}</Code>/<Code>[</Code> → JSON,
          <Code>&lt;</Code> → XML). Picking from the dropdown overrides auto-detect; clearing the editor
          releases the override so the next paste is detected fresh.
        </P>
        <H3>Properties</H3>
        <P>
          Application properties (key/value) attached to every send. Toggle a row off to keep the
          values handy without sending them. AMQPush also auto-sets standard AMQP properties on
          every message — see <i>Auto-set properties</i> below.
        </P>
        <P>
          Both <b>key</b> and <b>value</b> fields autocomplete from the send history. Start typing
          a key name and a dropdown surfaces every property you've ever sent — useful for the long
          Artemis <Code>_AMQ_*</Code> markers no one remembers exactly. When a known key is in
          the row, a small <ChevronRight className="w-3 h-3 inline-block align-middle" /> caret
          appears next to the value field — click it to pick a previously-used value for that key.
        </P>

        <H3>Chaos helpers (poison-pill testing)</H3>
        <P>
          New <Bug className="w-3 h-3 inline-block align-middle" /> <b>Chaos</b> tab — four opt-in
          mutations applied just before send, for stress-testing consumer error paths:
        </P>
        <UL>
          <Li><b>Send oversized body</b> — pads the body with random ASCII to N MB. Triggers broker max-message-size limits and tests how the consumer streams large frames.</Li>
          <Li><b>Override content-type</b> — forces the <Code>content-type</Code> property regardless of body subtype, exposing consumers that trust the header instead of sniffing the body.</Li>
          <Li><b>Send malformed JSON</b> — strips the last closing <Code>{"}"}</Code> / <Code>]</Code> so strict <Code>JSON.parse</Code> blows up. Ignored when the body isn't JSON.</Li>
          <Li><b>Strip application property</b> — removes a named property from the outgoing message. Test how the consumer handles a missing required header (<Code>tenant_id</Code>, <Code>trace_id</Code>, etc.).</Li>
        </UL>
        <Note>
          Toggles are independent — combine them to stress multiple paths. The Send tab strip
          shows a dot on the Chaos tab while any toggle is active so you can't forget. Untick
          everything before going back to normal smoke testing.
        </Note>
        <H3>Auto-set properties</H3>
        <P>Every send adds these without you having to type them:</P>
        <Row label="message-id">Random UUID per send.</Row>
        <Row label="creation-time">Wall-clock at send.</Row>
        <Row label="priority / durable">Defaults to <Code>4</Code> / <Code>false</Code>.</Row>
        <Row label="reply-to">Set when the Reply tab is on.</Row>
        <Row label="_AMQ_ROUTING_TYPE">App property <Code>1</Code> (ANYCAST) — Artemis routing hint.</Row>
        <Row label="is_file / file_name">App properties set when sending Binary.</Row>
      </>
    ),
  },

  /* ── Variables ────────────────────────────────────────────────────────── */
  {
    id: "variables",
    title: "Variables",
    icon: <Braces className="w-3.5 h-3.5" />,
    parentId: "send",
    searchText: "variables substitution placeholders user variables built-in uuid timestamp now date prebuilt template tokens curly braces faker email name address credit card iban lorem ipsum phone username password",
    content: (
      <>
        <H><Braces className="w-4 h-4 text-accent" />Variables</H>
        <P>
          Anywhere in the Body and Properties you can reference variables with double-brace tokens:
          <Code>{"{{name}}"}</Code>. The autocompletion in the editor surfaces both your user
          variables and the built-in catalogue.
        </P>
        <H3>Built-in tokens</H3>
        <P>Always available in the body, no registration needed:</P>
        <UL>
          <Li><Code>{"{{uuid}}"}</Code> — random UUID v4.</Li>
          <Li><Code>{"{{timestamp}}"}</Code> — Unix epoch milliseconds.</Li>
          <Li><Code>{"{{date}}"}</Code> — ISO 8601 timestamp.</Li>
          <Li><Code>{"{{now}}"}</Code> — same as <Code>{"{{date}}"}</Code>.</Li>
          <Li><Code>{"{{random}}"}</Code> / <Code>{"{{int}}"}</Code> — pseudo-random integer.</Li>
        </UL>
        <H3>User variables</H3>
        <P>
          Defined on the <b>Variables</b> tab. Each row has an enabled toggle, a key, a value, and a
          description. Disabled rows don't substitute. The value itself can reference other tokens
          (chained), so <Code>{"{{order_id}}"}</Code> with value <Code>{"ORD-{{uuid}}"}</Code>
          expands per-send.
        </P>
        <Note>
          Tokens work fine inside JSON. AMQPush replaces them <i>after</i> validating the structural
          template — so <Code>{"\"id\": \"{{uuid}}\""}</Code> stays valid JSON during validation.
        </Note>

        <H3>Faker tokens (realistic test data)</H3>
        <P>
          The <Code>{"{{faker.<path>}}"}</Code> namespace wraps the
          {" "}<Code>@faker-js/faker</Code> library so you can fill bodies with realistic-looking
          dummy data. All tokens auto-complete from the editor like the built-ins.
        </P>
        <UL>
          <Li><b>People</b> — <Code>{"{{faker.firstName}}"}</Code>, <Code>{"{{faker.lastName}}"}</Code>, <Code>{"{{faker.fullName}}"}</Code>, <Code>{"{{faker.jobTitle}}"}</Code>, <Code>{"{{faker.gender}}"}</Code></Li>
          <Li><b>Internet / contact</b> — <Code>{"{{faker.email}}"}</Code>, <Code>{"{{faker.username}}"}</Code>, <Code>{"{{faker.url}}"}</Code>, <Code>{"{{faker.domain}}"}</Code>, <Code>{"{{faker.phone}}"}</Code>, <Code>{"{{faker.ip}}"}</Code>, <Code>{"{{faker.ipv6}}"}</Code>, <Code>{"{{faker.macAddress}}"}</Code>, <Code>{"{{faker.userAgent}}"}</Code>, <Code>{"{{faker.password}}"}</Code></Li>
          <Li><b>Address</b> — <Code>{"{{faker.streetAddress}}"}</Code>, <Code>{"{{faker.city}}"}</Code>, <Code>{"{{faker.state}}"}</Code>, <Code>{"{{faker.country}}"}</Code>, <Code>{"{{faker.countryCode}}"}</Code>, <Code>{"{{faker.zipCode}}"}</Code>, <Code>{"{{faker.latitude}}"}</Code>, <Code>{"{{faker.longitude}}"}</Code></Li>
          <Li><b>Finance</b> — <Code>{"{{faker.creditCardNumber}}"}</Code> (Luhn-valid), <Code>{"{{faker.creditCardCvv}}"}</Code>, <Code>{"{{faker.creditCardExpiry}}"}</Code> (YYYY-MM), <Code>{"{{faker.iban}}"}</Code>, <Code>{"{{faker.bic}}"}</Code>, <Code>{"{{faker.currency}}"}</Code>, <Code>{"{{faker.amount}}"}</Code></Li>
          <Li><b>Commerce</b> — <Code>{"{{faker.companyName}}"}</Code>, <Code>{"{{faker.productName}}"}</Code>, <Code>{"{{faker.productPrice}}"}</Code>, <Code>{"{{faker.department}}"}</Code></Li>
          <Li><b>Text</b> — <Code>{"{{faker.lorem}}"}</Code> (sentence), <Code>{"{{faker.lorem(N)}}"}</Code> (N words), <Code>{"{{faker.loremParagraph}}"}</Code>, <Code>{"{{faker.word}}"}</Code></Li>
        </UL>
        <Note>
          Faker values are <b>not stable</b> — each substitution produces a fresh value. If you
          need a repeatable pseudo-random for the same key across a request, set it once via a
          Pre-script (<Code>ctx.set("user_id", ctx.uuid())</Code>) and reuse the variable.
        </Note>
      </>
    ),
  },

  /* ── Pre-script ───────────────────────────────────────────────────────── */
  {
    id: "prescript",
    title: "Pre-script",
    icon: <Code2 className="w-3.5 h-3.5" />,
    parentId: "send",
    searchText: "pre-script javascript sandbox dynamic variables ctx.set ctx.get ctx.log ctx.uuid ctx.now runtime per-send counter sequence base64 hash timestamp routing key examples",
    content: (
      <>
        <H><Code2 className="w-4 h-4 text-accent" />Pre-script</H>
        <P>
          Pre-script is a small JavaScript snippet that runs <i>once before every send</i>. It
          lets you compute dynamic variable values that simple <Code>{"{{token}}"}</Code>{" "}
          substitution can't express on its own — derived IDs, conditional routing keys,
          encoded payloads, anything where you need a tiny bit of logic instead of a static
          string.
        </P>
        <H3>When it runs</H3>
        <UL>
          <Li><b>Once per Send click</b> for a single message.</Li>
          <Li><b>Once per Batch iteration</b> — variables recompute, so <Code>{"{{counter}}"}</Code> or your own sequence shows fresh values each message.</Li>
          <Li><b>Once per CSV row</b> — column values are available via <Code>ctx.get("col_name")</Code>; the script can derive further fields from them.</Li>
        </UL>
        <P>
          Any variables you set with <Code>ctx.set(...)</Code> are available as{" "}
          <Code>{"{{name}}"}</Code> tokens in the Body and Properties tabs for that iteration's
          send. They do <i>not</i> persist between sends — each iteration starts fresh and
          re-runs the script.
        </P>

        <H3>API reference</H3>
        <Row label={<Code>ctx.set(key, value)</Code>}>
          Register a variable for this iteration. <Code>value</Code> is coerced to a string —
          objects are stringified, <Code>null</Code> / <Code>undefined</Code> become <Code>""</Code>.
        </Row>
        <Row label={<Code>ctx.get(key)</Code>}>
          Read a variable. Looks first at values set earlier in <i>this</i> run, then at
          enabled rows on the Variables tab. Returns <Code>undefined</Code> if neither has it.
        </Row>
        <Row label={<Code>ctx.log(...args)</Code>}>
          Append a line to the AMQPush log (prefixed{" "}
          <Code>pre-script: …</Code>). Each arg is stringified individually then joined with
          spaces. Useful for debugging without running every send through the editor.
        </Row>
        <Row label={<Code>ctx.now</Code>}>
          <Code>Date.now()</Code> snapshot at the start of this run. Stable across the whole
          script invocation so all <Code>ctx.set</Code> values that derive from it agree.
        </Row>
        <Row label={<Code>ctx.uuid()</Code>}>
          Generates a fresh UUID v4 (via <Code>crypto.randomUUID()</Code>). Each call returns
          a new id — useful for correlation-ids you want to repeat across multiple variables.
        </Row>
        <Row label={<Code>ctx.iter</Code>}>
          1-based loop index in Batch and CSV modes; always <Code>1</Code> for a single send.
          Use it for "every Nth message do X" branches.
        </Row>
        <P>
          Standard JS built-ins are available too: <Code>Date</Code>, <Code>Math</Code>,
          <Code>JSON</Code>, <Code>crypto</Code> (full Web Crypto API including{" "}
          <Code>crypto.subtle.digest</Code>), <Code>btoa</Code> / <Code>atob</Code>,
          <Code>String</Code>, <Code>Array</Code>, <Code>Object</Code>, and friends.
        </P>

        <H3>Worked examples</H3>

        <H3>Sequence counter that persists across batch</H3>
        <P>Increment a saved counter, derive a partition key from it:</P>
        <pre className="text-[12.5px] font-mono bg-t-card border border-t-line rounded-lg p-2.5 overflow-x-auto mb-3">{`const n = (ctx.get("seq") | 0) + 1;
ctx.set("seq", n);
ctx.set("partition", "us-east." + (n % 4));
ctx.set("ordinal", n.toString().padStart(6, "0"));`}</pre>
        <P>
          In Body: <Code>{`{"seq": {{seq}}, "partition": "{{partition}}", "id": "ORD-{{ordinal}}"}`}</Code>
        </P>

        <H3>Conditional routing key by environment</H3>
        <P>Pick a different routing target depending on a user var:</P>
        <pre className="text-[12.5px] font-mono bg-t-card border border-t-line rounded-lg p-2.5 overflow-x-auto mb-3">{`const env = ctx.get("env") ?? "dev";
const target = {
  dev:     "queue.dev.orders",
  staging: "queue.stg.orders",
  prod:    "queue.prod.orders",
}[env] ?? "queue.dev.orders";
ctx.set("destination", target);
ctx.log("routing to", target);`}</pre>

        <H3>Weighted random pick</H3>
        <P>70% A, 20% B, 10% C — handy for synthetic load tests:</P>
        <pre className="text-[12.5px] font-mono bg-t-card border border-t-line rounded-lg p-2.5 overflow-x-auto mb-3">{`const r = Math.random();
ctx.set("variant",
  r < 0.7 ? "A"
  : r < 0.9 ? "B"
  : "C");`}</pre>

        <H3>Timestamp in a non-standard format</H3>
        <P>
          Built-in <Code>{"{{date}}"}</Code> is ISO 8601. If the consumer wants RFC 3339 with
          a millisecond stamp or a custom layout, compute it:
        </P>
        <pre className="text-[12.5px] font-mono bg-t-card border border-t-line rounded-lg p-2.5 overflow-x-auto mb-3">{`const d = new Date(ctx.now);
const pad = (n, w = 2) => String(n).padStart(w, "0");
ctx.set("ts_local",
  d.getFullYear() + "-" +
  pad(d.getMonth() + 1) + "-" +
  pad(d.getDate()) + " " +
  pad(d.getHours()) + ":" +
  pad(d.getMinutes()) + ":" +
  pad(d.getSeconds()) + "." +
  pad(d.getMilliseconds(), 3));`}</pre>

        <H3>SHA-256 over a payload field for tamper-detection</H3>
        <P>Web Crypto API works directly:</P>
        <pre className="text-[12.5px] font-mono bg-t-card border border-t-line rounded-lg p-2.5 overflow-x-auto mb-3">{`const payload = ctx.get("order_id") + "|" + ctx.now;
const buf  = new TextEncoder().encode(payload);
const hash = await crypto.subtle.digest("SHA-256", buf);
const hex  = [...new Uint8Array(hash)]
  .map(b => b.toString(16).padStart(2, "0"))
  .join("");
ctx.set("signature", hex);`}</pre>
        <Note>
          The script body is wrapped in an async-friendly invocation — <Code>await</Code>{" "}
          works at the top level. Pre-script returns after all promises resolve, so the
          send waits for your hash to complete.
        </Note>

        <H3>Base64-encode a property</H3>
        <pre className="text-[12.5px] font-mono bg-t-card border border-t-line rounded-lg p-2.5 overflow-x-auto mb-3">{`const json = JSON.stringify({
  user:  ctx.get("username"),
  tier:  ctx.get("tier"),
  iat:   Math.floor(ctx.now / 1000),
});
ctx.set("auth_b64", btoa(json));`}</pre>

        <H3>Per-row transform from CSV</H3>
        <P>
          When CSV mode is active, every column header is available via{" "}
          <Code>ctx.get("col_name")</Code>. Use the script to derive computed fields
          before substitution:
        </P>
        <pre className="text-[12.5px] font-mono bg-t-card border border-t-line rounded-lg p-2.5 overflow-x-auto mb-3">{`// CSV columns: customer_email, amount_usd
const email = ctx.get("customer_email") ?? "";
ctx.set("email_domain", email.split("@")[1] ?? "unknown");

const usd = parseFloat(ctx.get("amount_usd") ?? "0");
ctx.set("amount_cents", String(Math.round(usd * 100)));`}</pre>

        <H3>Best practices</H3>
        <UL>
          <Li><b>Keep scripts short.</b> One iteration runs the whole script for every send — heavy logic slows your batch loop. If you need ten lines of setup, build it inline; if you need fifty, you're probably writing the wrong tool.</Li>
          <Li><b>Use <Code>ctx.log</Code> liberally during development</b>, then remove the calls before bulk runs — log entries don't dedupe and a 10 000-row CSV would flood the Logs view.</Li>
          <Li><b>Don't rely on global state.</b> A new script context is built for every send; closures over outer scope (<Code>let x = …</Code>) reset between iterations.</Li>
          <Li><b>Stick to pure computation.</b> No network calls, no Tauri APIs, no DOM. The script runs in the WebView's JS context but the sandbox intentionally omits them; if you need to call out, do it ahead of time and paste the result.</Li>
        </UL>

        <H3>Errors</H3>
        <P>
          A thrown exception aborts the send with the exception message in the log
          (<Code>err: Pre-script error: …</Code>). The script's already-set variables are
          still applied to the body (so a half-failed run can still produce a partial
          message), but most users prefer to fix the script and retry.
        </P>
        <P>
          Syntax errors are caught at the same moment — the script doesn't run, and the
          error shows up in the log before any send is attempted.
        </P>

        <Warn>
          Pre-script is a usability sandbox, not a security boundary. Loading templates
          from untrusted sources can run arbitrary JavaScript in the AMQPush WebView. Treat
          shared <Code>templates.json</Code> files the same way you'd treat shared shell
          scripts.
        </Warn>
      </>
    ),
  },

  /* ── Batch + Schedule ─────────────────────────────────────────────────── */
  {
    id: "batch",
    title: "Batch & Schedule",
    icon: <Repeat2 className="w-3.5 h-3.5" />,
    parentId: "send",
    searchText: "batch repeat delay schedule delayed first send loop count throughput cancel abort",
    content: (
      <>
        <H><Repeat2 className="w-4 h-4 text-accent" />Batch &amp; Schedule</H>
        <H3>Batch</H3>
        <P>
          Sends the same message <b>N times</b> with a configurable delay between sends. Variables
          and the Pre-script re-evaluate per iteration, so each iteration can carry a fresh UUID or
          counter.
        </P>
        <Row label="Repeat">Number of sends. <Code>1</Code> = single send (toggle off).</Row>
        <Row label="Delay">Milliseconds between sends. <Code>0</Code> = as fast as possible.</Row>
        <H3>Schedule</H3>
        <P>
          Delays the <i>first</i> send by N seconds. Combine with Batch to schedule a burst.
          The countdown is shown in the Send button; clicking <b>Cancel</b> aborts the wait via an
          <Code>AbortController</Code> — nothing is sent.
        </P>
        <Note>
          Schedule runs entirely client-side. If you need broker-side scheduled delivery, set the
          <Code>_AMQ_SCHEDULED_DELIVERY_TIME</Code> application property in the Properties tab
          (Artemis-specific).
        </Note>
      </>
    ),
  },

  /* ── CSV bulk send ────────────────────────────────────────────────────── */
  {
    id: "csv",
    title: "CSV bulk send",
    icon: <FileSpreadsheet className="w-3.5 h-3.5" />,
    parentId: "send",
    searchText: "csv bulk import spreadsheet excel rows columns headers tokens substitution per-row papaparse load drop preview dry run progress cancel",
    content: (
      <>
        <H><FileSpreadsheet className="w-4 h-4 text-accent" />CSV bulk send</H>
        <P>
          Open the <b>CSV</b> tab in the Send view. Drop a CSV file (or click to browse); the
          first row is treated as the header. Each subsequent row turns into one outgoing message,
          with column values substituted into <Code>{"{{column_name}}"}</Code> tokens in Body and
          Properties.
        </P>
        <H3>Workflow</H3>
        <UL>
          <Li><b>Load</b> — drop a <Code>.csv</Code> file or click the dropzone. Header row populates the column-token chips.</Li>
          <Li><b>Compose your Body</b> on the regular Body tab using <Code>{"{{column_name}}"}</Code> placeholders. Click any chip in the CSV tab to copy its token to clipboard.</Li>
          <Li><b>Preview</b> the first 5 rows in the table; click a row to drive the <i>Dry-run preview</i> below — that pane shows exactly how the Body resolves for that row, so you can confirm before sending.</Li>
          <Li><b>Send N messages</b> kicks off the loop. Live progress bar, ok / fail counters, and a <b>Cancel</b> button that aborts cleanly at the next iteration boundary.</Li>
        </UL>

        <H3>Example</H3>
        <P>Save the following as <Code>orders.csv</Code> and load it from the CSV tab:</P>
        <pre className="text-[12.5px] font-mono bg-t-card border border-t-line rounded-lg p-2.5 overflow-x-auto mb-3">{`order_id,customer,amount,currency,country
1001,Alice Smith,49.99,USD,US
1002,Bob Müller,150.00,EUR,DE
1003,Charlie Park,2750,KRW,KR
1004,Dana Patel,89.50,INR,IN`}</pre>
        <P>Compose the Body on the Body tab as JSON with column tokens:</P>
        <pre className="text-[12.5px] font-mono bg-t-card border border-t-line rounded-lg p-2.5 overflow-x-auto mb-3">{`{
  "id": "ORD-{{order_id}}",
  "customer": "{{customer}}",
  "total": {{amount}},
  "currency": "{{currency}}",
  "country": "{{country}}",
  "request_id": "{{uuid}}",
  "received_at": "{{timestamp}}"
}`}</pre>
        <P>
          For row 1 the dry-run preview will show <Code>"id": "ORD-1001"</Code>, <Code>"customer": "Alice Smith"</Code>,
          <Code>"total": 49.99</Code>, etc. <Code>{"{{uuid}}"}</Code> and <Code>{"{{timestamp}}"}</Code>
          are <i>not</i> CSV columns — they're built-ins that re-evaluate per row, so each message
          gets a fresh request id and sent timestamp.
        </P>
        <Note>
          Numeric columns work as JSON values without quoting — <Code>{"{{amount}}"}</Code> resolves
          to <Code>49.99</Code>, which is valid JSON. For string-typed values keep the quotes
          around the token (<Code>{"\"{{customer}}\""}</Code>) so the rendered result is a proper
          JSON string. AMQPush validates the Body template (with tokens replaced by neutral
          placeholders) so an invalid pattern is flagged before any rows go out.
        </Note>
        <H3>Token resolution per row</H3>
        <P>
          For each row AMQPush stacks variables in this order — first match wins:
        </P>
        <UL>
          <Li>Pre-script <Code>ctx.set(...)</Code> values (script runs once per row; column values are accessible via <Code>ctx.get("col_name")</Code>)</Li>
          <Li>CSV column values for the current row</Li>
          <Li>User-defined Variables tab entries</Li>
          <Li>Built-in tokens (<Code>{"{{uuid}}"}</Code>, <Code>{"{{faker.email}}"}</Code>, etc.)</Li>
        </UL>
        <Row label="Per-row delay">Milliseconds between rows. <Code>0</Code> = as fast as possible (rate-limited only by broker / network).</Row>
        <Note>
          Schema validation is intentionally skipped in CSV mode for throughput. Validate your
          template against a single representative row in the regular Send view first; once it
          passes, switch to CSV mode for the bulk run.
        </Note>
        <Warn>
          Sending thousands of messages is destructive on production queues. Always test against
          a dev stand first; the dry-run preview is your friend.
        </Warn>
      </>
    ),
  },

  /* ── Reply ────────────────────────────────────────────────────────────── */
  {
    id: "reply",
    title: "Request-Reply",
    icon: <CornerDownLeft className="w-3.5 h-3.5" />,
    parentId: "send",
    searchText: "request reply correlation id reply-to dynamic source temporary queue rpc round trip",
    content: (
      <>
        <H><CornerDownLeft className="w-4 h-4 text-accent" />Request-Reply</H>
        <P>
          Toggle <b>Reply</b> in the Send tabs to wait for a response after publishing. AMQPush
          sets <Code>reply-to</Code> on the outgoing message and opens a temporary receiver to
          listen for the matching <Code>correlation-id</Code>.
        </P>
        <Row label="Reply-to">Address the receiver attaches to. Leave blank for a dynamic source (broker-assigned temp queue).</Row>
        <Row label="Timeout">Milliseconds to wait before flagging the reply as timed-out.</Row>
        <P>
          When a reply arrives, it's shown inline below the send result and gets a <b>Resend with
          context</b> action that pre-fills the Send form with the reply's <Code>correlation-id</Code>.
        </P>
      </>
    ),
  },

  /* ── Templates ────────────────────────────────────────────────────────── */
  {
    id: "templates",
    title: "Templates",
    icon: <BookMarked className="w-3.5 h-3.5" />,
    parentId: "send",
    searchText: "templates save load rename delete preset reuse json file",
    content: (
      <>
        <H><BookMarked className="w-4 h-4 text-accent" />Templates</H>
        <P>
          Save the entire Send setup — destination, body + subtype, properties, variables,
          pre-script, batch / schedule / reply settings, and the validation schema — under a name.
          Loading a template restores everything in one click.
        </P>
        <UL>
          <Li><b>Save current</b> — type a name and confirm. Existing names are overwritten.</Li>
          <Li><b>Load</b> — click a template row.</Li>
          <Li><b>Rename / Delete</b> — pencil and trash icons on hover.</Li>
        </UL>
        <Note>
          Templates are stored at <Code>~/.amqpush/templates.json</Code>. You can hand-edit or
          version-control that file; the new <Code>body_schema_json</Code> /
          <Code>body_schema_xsd</Code> fields are optional.
        </Note>
      </>
    ),
  },

  /* ── Schema validation ────────────────────────────────────────────────── */
  {
    id: "schema",
    title: "Body validation",
    icon: <ShieldCheck className="w-3.5 h-3.5" />,
    parentId: "send",
    searchText: "schema validation json schema ajv xsd xml validation xmllint draft 2020 upload paste error file",
    content: (
      <>
        <H><ShieldCheck className="w-4 h-4 text-accent" />Body validation (JSON Schema / XSD)</H>
        <P>
          The <b>schema pill</b> in the Body sub-toolbar opens a modal where you can paste or
          upload a schema. The active schema is automatically picked based on the Raw subtype:
          JSON Schema for JSON, XSD for XML.
        </P>
        <H3>Status indicator</H3>
        <UL>
          <Li><b>Schema…</b> (grey) — no schema configured.</Li>
          <Li><b>schema</b> (blue) — schema set, body empty or not yet validated.</Li>
          <Li><b>schema ✓</b> (green) — body matches.</Li>
          <Li><b>schema ✗ (N)</b> (red) — N validation errors. Click to inspect.</Li>
          <Li><b>schema…</b> with spinner — XSD validation in progress (xmllint-wasm runs async).</Li>
        </UL>
        <H3>JSON Schema</H3>
        <P>
          Validated synchronously with <Code>ajv</Code>. Supports Draft-07 and 2020-12. Errors
          show with their <Code>instancePath</Code>, e.g. <Code>/order/lines/0/qty</Code>.
        </P>
        <H3>XSD</H3>
        <P>
          Validated asynchronously via <Code>xmllint-wasm</Code> (libxml2 compiled to WebAssembly,
          ~500&nbsp;KB). The WASM blob is lazy-loaded only when both an XSD and a non-empty body
          are present, so it doesn't slow startup. Errors include <Code>line N</Code> from the
          parser.
        </P>
        <Note>
          Both schemas are saved per-language in the same template, so switching subtypes doesn't
          lose the other one.
        </Note>
      </>
    ),
  },

  /* ── Receive ─────────────────────────────────────────────────────────── */
  {
    id: "receive",
    title: "Receive",
    icon: <Inbox className="w-3.5 h-3.5" />,
    searchText: "receive subscriber subscribe live messages filter consume credit reconnect drainer notifications dla selector jms broker filter expression where priority topic pattern wildcard multicast solace artemis hierarchy hash dot star record recording replay capture save buffer speed multiplier playback timing rules highlight regex color border pattern json xml header property body keyword",
    content: (
      <>
        <H><Inbox className="w-4 h-4 text-accent" />Receive (subscriber)</H>
        <P>
          Subscribes to a queue and shows messages as they arrive — live, with auto-reconnect on
          network blips. Each row expands to show the full AMQP frame: standard properties,
          application properties, body, body kind, size, delivery count.
        </P>
        <H3>Controls</H3>
        <UL>
          <Li><b>Subscribe</b> opens the receiver. The queue field accepts comma-separated names to subscribe to multiple at once.</Li>
          <Li><b>Stop</b> detaches and stops accumulating messages.</Li>
          <Li><b>Filter</b> restricts the visible list to rows matching a substring (case-insensitive across body + properties).</Li>
          <Li><b>Reply</b> on a message pre-fills Send with the original's <Code>correlation-id</Code>.</Li>
        </UL>
        <P>
          The message list has a sticky <b>Message ID / Date-Time</b> header at the top and is
          sorted <b>newest-first</b> — fresh messages appear above older ones. The timestamp
          column shows full local <Code>YYYY-MM-DD HH:MM:SS</Code> so it lines up with the
          Browser peek timestamps for cross-view correlation.
        </P>
        <H3>Highlight rules (colour-code matching messages)</H3>
        <P>
          The <Palette className="w-3 h-3 inline-block align-middle" /> <b>Rules</b> button next
          to the active-subscription bar opens the rule manager. Each rule is a regex pattern
          + a colour; messages whose <b>haystack</b> matches get a colored left-border and a
          colored dot in the row. Rules are applied client-side after a message arrives — the
          broker still delivers everything; rules just visually segregate the stream. Use them
          together with <b>Selector</b> / <b>Pattern</b> when you want narrowed delivery and
          colour-coded triage in one go.
        </P>
        <P>
          The <b>haystack</b> a rule's regex runs against is the concatenation (newline-joined) of:
        </P>
        <UL>
          <Li>The message body (decoded as text).</Li>
          <Li>The source queue name.</Li>
          <Li>Standard properties: <Code>message-id</Code>, <Code>correlation-id</Code>, <Code>content-type</Code>.</Li>
          <Li>Every application property as <Code>key=value</Code> line.</Li>
        </UL>
        <P>
          Patterns are JavaScript regex (case-insensitive by default — the match runs via{" "}
          <Code>new RegExp(pattern, "i")</Code>). First matching rule wins; later rules are
          skipped for the same message.
        </P>

        <H3>Rule pattern recipes</H3>
        <P>
          Some patterns that pay rent:
        </P>
        <Row label={<Code>error|failed|timeout</Code>}>
          Matches any of those three words anywhere in body, queue, properties — useful first-pass
          "something's wrong" red highlight.
        </Row>
        <Row label={<Code>{`"status"\\s*:\\s*"FAILED"`}</Code>}>
          JSON field match — finds <Code>{`"status": "FAILED"`}</Code> with any whitespace. Use{" "}
          <Code>{`"orderId"\\s*:\\s*"42"`}</Code> for an exact value, or{" "}
          <Code>{`"amount"\\s*:\\s*\\d{5,}`}</Code> for "5+ digit numeric amount".
        </Row>
        <Row label={<Code>{`<status>FAILED</status>`}</Code>}>
          XML element match — finds an exact element value. For attribute matches use{" "}
          <Code>{`<order\\s[^>]*priority="high"`}</Code>.
        </Row>
        <Row label={<Code>{`<\\?xml`}</Code>}>
          Tag every XML message (anything starting with the XML declaration). Pair with a different
          colour for <Code>{`^\\s*\\{`}</Code> to colour-code JSON vs XML at a glance.
        </Row>
        <Row label={<Code>{`event\\s*=\\s*order\\.created`}</Code>}>
          Application property match — finds the line <Code>event=order.created</Code> in the
          haystack. Use this to colour-code by <Code>JMSType</Code>, <Code>_AMQ_*</Code>, custom
          headers, etc.
        </Row>
        <Row label={<Code>{`priority\\s*=\\s*([7-9]|10)`}</Code>}>
          High-priority messages — application property <Code>priority</Code> ≥ 7. Useful when the
          broker doesn't honour AMQP priority but apps set their own header.
        </Row>
        <Row label={<Code>{`correlation-id=\\s*req-7b9a`}</Code>}>
          Pick out responses to a specific correlation-id you sent earlier — narrows hundreds of
          replies down to the one you care about.
        </Row>
        <Row label={<Code>{`tenant_id=\\s*acme-corp\\b`}</Code>}>
          Tenant-scoped highlight — message header carries the tenant identifier. The{" "}
          <Code>\b</Code> word boundary avoids accidentally matching{" "}
          <Code>acme-corporation</Code>.
        </Row>
        <Row label={<Code>{`^.{2000,}`}</Code>}>
          Big bodies — body 2000+ chars. Useful for spotting outliers in a feed of small messages.
        </Row>
        <Row label={<Code>{`(?i)\\bdebug\\b`}</Code>}>
          Whole-word match — matches <Code>debug</Code> but not <Code>debugger</Code>. The
          <Code>(?i)</Code> prefix forces case-insensitivity if you ever drop the default flag
          via a more complex pattern.
        </Row>
        <Note>
          Need a more aggressive filter than highlight-only? <b>Filter by</b> (top of message list)
          runs the same regex but <i>hides</i> non-matches instead of colouring matches. Same
          haystack, same regex flavour.
        </Note>

        <H3>Broker-side selectors (filter on the wire)</H3>
        <P>
          Click the <Filter className="w-3 h-3 inline-block align-middle" /> <b>Selector</b>{" "}
          button next to the queue picker to expand the filter input. Enter a JMS-style
          expression like{" "}
          <Code>{"priority > 5 AND application_property:type = 'order'"}</Code>{" "}
          and the broker will only deliver matching messages — non-matches stay on the queue
          for other consumers.
        </P>
        <P>
          AMQPush packages the expression as an AMQP 1.0 source filter under the descriptor
          {" "}<Code>apache.org:selector-filter:string</Code>, which is the de-facto standard
          accepted by Artemis, ActiveMQ Classic, Qpid Broker-J, and most JMS-compatible
          brokers. Active subscriptions with a selector get a small{" "}
          <Filter className="w-3 h-3 inline-block align-middle text-accent" /> badge on
          their chip, and the tooltip shows the selector text.
        </P>
        <Note>
          Selectors only see what the broker exposes — typically standard AMQP properties and
          application properties. They cannot match on body content. Empty selector = no filter
          (broker delivers everything, same as before).
        </Note>

        <H3>Saved selectors</H3>
        <P>
          The bookmark icon at the right edge of the selector input opens a small library of
          named selectors. Type a useful expression once, hit <b>Save current as…</b>, give it a
          name (e.g. "VIP priority", "Orders only"), and from then on pick it from the dropdown
          to refill the input in one click. Saves are persisted in <Code>localStorage</Code>{" "}
          (<Code>amqpush.subscriber.savedSelectors</Code>), survive restarts, and are shared
          across all stands. Saving under an existing name overwrites it. Hover a saved row
          to reveal a × that forgets it.
        </P>

        <H3>Topic-pattern subscribe (wildcards)</H3>
        <P>
          Click the <b>#</b> <b>Pattern</b> button next to Selector to expand a second filter
          input. Enter a wildcard pattern matching the broker's topic / multicast address syntax
          and only messages whose routing key matches will be delivered.
        </P>
        <UL>
          <Li><b>Artemis</b> (multicast addresses): <Code>orders.*</Code> matches one word, <Code>orders.#</Code> matches zero or more words.</Li>
          <Li><b>Solace</b>: <Code>orders/*</Code> matches one level, <Code>orders/&gt;</Code> matches one or more levels.</Li>
          <Li><b>Qpid Broker-J / ActiveMQ Classic</b>: <Code>orders.*</Code> / <Code>orders.#</Code>.</Li>
        </UL>
        <P>
          The pattern is attached as the AMQP 1.0 source filter under descriptor{" "}
          <Code>apache.org:legacy-amqp-topic-binding:string</Code>. Active subscriptions with a
          pattern show a small <Hash className="w-3 h-3 inline-block align-middle text-accent-content" /> badge.
          <b>Pattern</b> and <b>Selector</b> stack — set both and both filters apply.
        </P>
        <Note>
          Some brokers (notably Artemis multicast) honour wildcards directly in the source
          address — you can also just type <Code>orders.*</Code> in the queue field. The
          dedicated Pattern filter is the portable option that works with Solace topic
          hierarchies, Qpid, and any broker that recognises the legacy AMQP topic-binding
          descriptor.
        </Note>

        <H3>Recording & Replay</H3>
        <P>
          Recording captures a stream of incoming messages with their relative timings, saves
          it as a file on disk, and lets you re-play it later to any queue at any speed. The
          typical use case: sample live production traffic, then replay it against new code
          on a dev stand as many times as you need.
        </P>
        <H3>How to record</H3>
        <ol className="list-decimal list-inside text-[13px] text-t-ink2 space-y-1 ml-1">
          <li>Subscribe to a queue in Receive — messages start arriving.</li>
          <li>Click the red <b>REC</b> chip on the active-subscription bar. Every new message is captured into an in-memory buffer along with its arrival timestamp. A counter next to <b>REC</b> tracks how many are buffered.</li>
          <li><b>Save…</b> appears next to <b>REC</b> as soon as the buffer has anything in it. Click it any time — even while <b>REC</b> is still active — give the recording a name, confirm. The buffer flushes to <Code>~/.amqpush/recordings/&lt;name&gt;.json</Code> as a small JSON file with bodies, content-types, application properties, and inter-message offsets in ms.</li>
          <li>Clicking <b>REC</b> again pauses capture without losing the buffer. Saving mid-recording snapshots whatever's there and starts a fresh buffer for the next save.</li>
        </ol>
        <H3>How to replay</H3>
        <ol className="list-decimal list-inside text-[13px] text-t-ink2 space-y-1 ml-1">
          <li>Click <b>Replay…</b> in the Receive top bar. Modal lists every saved recording.</li>
          <li>Pick a recording on the left.</li>
          <li>Pick a <b>target queue</b> on the broker you're currently connected to. Default is the recording's original source queue, but you can pick anything — that's how you "promote prod traffic to dev".</li>
          <li>Pick a <b>speed multiplier</b>: <Code>1×</Code> reproduces the original timing exactly; <Code>2×</Code> / <Code>5×</Code> compress it; <Code>0</Code> (<b>max</b>) drops all delays and fires as fast as possible.</li>
          <li>Click <b>Play</b>. Progress bar shows step / total. Cancel by closing the modal.</li>
        </ol>
        <Note>
          Replay uses the normal <Code>send_message</Code> pipeline. Each replayed message gets
          a fresh AMQP <Code>message-id</Code> and <Code>creation-time</Code>, so consumers
          can deduplicate on the original <Code>message-id</Code> in{" "}
          <Code>application_properties</Code> if your contract demands it. The recording file
          itself is never modified by Replay — same recording can be played many times,
          to many different targets.
        </Note>

        <Note>
          On Artemis with <Code>send-to-dla-on-no-route</Code> enabled, AMQPush silently drains the
          internal <Code>activemq.notifications</Code> address so unrouted notifications don't pile
          up in the DLQ.
        </Note>
      </>
    ),
  },

  /* ── Browser ─────────────────────────────────────────────────────────── */
  {
    id: "browser",
    title: "Browser",
    icon: <ListTree className="w-3.5 h-3.5" />,
    searchText: "browser queue browser peek messages purge delete management rpc artemis remove all messages refresh dlq dead letter requeue redeliver original destination who holds message consumer credit unacked edit body repair bulk select inline modal walkthrough resubmit target shovel cross broker copy promote prod dev transform js select all max checkbox selective amquserid filter",
    content: (
      <>
        <H><ListTree className="w-4 h-4 text-accent" />Queue browser</H>
        <P>
          Lists every queue on the broker with live counters (size, consumers, messages added /
          delivered). Auto-refreshes every 2.5 seconds. Click a queue to <b>peek</b> at the first
          messages without consuming them.
        </P>
        <H3>Peek</H3>
        <P>
          Reads a snapshot of pending messages — safe, non-destructive. Each entry shows the same
          metadata view as Receive. Use this to debug stuck or dead-letter queues. The
          <b> Max</b> dropdown picks how many to fetch: presets up to 5000 plus an{" "}
          <b>All</b> option that resolves to the queue's broker-reported{" "}
          <Code>message_count</Code> (capped at 50 000 for safety). Changing the cap{" "}
          <b>re-peeks immediately</b> — no need to follow up with a manual Refresh. Rows are
          sorted by AMQP <Code>creation-time</Code> with newest at the top; the{" "}
          <Code>#N</Code> column shows the original broker-delivery order. The timestamp
          column uses full local <Code>YYYY-MM-DD HH:MM:SS</Code>.
        </P>

        <H3>Multi-select actions</H3>
        <P>
          Each peeked row has a checkbox on its left. Selecting one or more rows reveals an action
          bar with:
        </P>
        <UL>
          <Li><b>Shovel selected…</b> — open the cross-broker shovel modal pre-populated with the picked subset (instead of the full snapshot).</Li>
          <Li><b>Purge selected</b> — delete only the picked messages via Artemis's{" "}
            <Code>queue.removeMessages</Code> with a JMS selector matching their{" "}
            <Code>AMQUserID</Code>s. Requires every selected message to have a non-empty{" "}
            <Code>message-id</Code> (the button is disabled with a tooltip otherwise).
          </Li>
          <Li>On DLQ queues only: <b>Edit & Requeue…</b> and <b>Requeue selected</b> are also available.</Li>
        </UL>
        <H3>Purge</H3>
        <P>
          The red <b>Purge</b> button on the peek pane removes <i>all</i> messages from the queue
          via the broker's management RPC (<Code>removeAllMessages</Code> on Artemis). A confirm
          dialog shows the message count before executing.
        </P>
        <Warn>
          Purge is destructive and cannot be undone. The message count is the broker-reported size
          at the moment of confirmation — concurrent producers may add more after.
        </Warn>

        <H3>DLQ inspection &amp; requeue</H3>
        <P>
          Browser auto-detects <b>dead-letter queues</b> by name — anything matching{" "}
          <Code>DLQ</Code>, <Code>*.DLQ</Code>, <Code>*_dlq</Code>, <Code>ActiveMQ.DLQ</Code>,
          <Code>ExpiryQueue</Code>, or simply containing "dlq" / "dead" (case-insensitive).
          When you peek into a DLQ a banner appears under the header explaining how requeue
          works on your broker, plus a green <b>Requeue all</b> button next to Purge.
        </P>
        <P>
          AMQPush reads the original destination from the message's application properties in
          this priority order:
        </P>
        <UL>
          <Li><Code>_AMQ_ORIG_ADDRESS</Code> — Artemis (most common)</Li>
          <Li><Code>_AMQ_ORIG_QUEUE</Code> — Artemis fallback (queue-level)</Li>
          <Li><Code>originalDestination</Code> — ActiveMQ Classic</Li>
          <Li><Code>JMSXOriginalDestination</Code></Li>
        </UL>
        <P>
          For each requeued message AMQPush strips DLQ-internal markers (<Code>_AMQ_ORIG_*</Code>,
          <Code>_AMQ_DLA_HISTORY</Code>, <Code>originalDestination</Code>, etc.) before
          republishing, so the broker doesn't immediately re-DLQ the copy if delivery fails again.
          The body and remaining application properties go through unchanged.
        </P>
        <P>
          You can also requeue messages individually: expanding any DLQ message reveals a{" "}
          <b>{"Requeue → <origin>"}</b> chip at the top of its details pane.
        </P>

        <H3>Edit &amp; Requeue (per-message or bulk)</H3>
        <P>
          When a message landed in the DLQ because of a fixable payload bug — bad JSON,
          a stale field, a wrong content-type — you can edit it before resubmitting. Each
          peeked DLQ message has an <b>Edit &amp; Requeue…</b> chip in its details pane.
          Clicking opens a modal with:
        </P>
        <UL>
          <Li><b>Body editor</b> (CodeMirror with JSON / XML highlighting) pre-filled with the original payload — tweak whatever you need.</Li>
          <Li><b>Target field</b> defaulted to the message's original destination; you can override to any other queue (handy for promoting a fixed payload to a different environment or replaying through a sanitiser queue).</Li>
        </UL>
        <P>
          For bulk repair, every peeked message on a DLQ queue now has a checkbox on its
          left. Pick several, and a selection bar appears with two actions: <b>Edit &amp;
          Requeue…</b> walks through them one at a time (Resubmit & next / Skip / back-forward
          navigation between them), and <b>Requeue selected</b> resubmits the lot without
          editing.
        </P>
        <Note>
          The non-internal application properties (everything outside the{" "}
          <Code>_AMQ_*</Code> markers) are carried over automatically — you don't have
          to re-build them. Only the body and target are editable. Source messages stay
          on the DLQ either way; use <b>Purge</b> afterwards to drop the originals.
        </Note>

        <Note>
          Requeue does <i>not</i> delete the original from the DLQ — peek-and-republish leaves
          the source untouched. After a successful Requeue all, follow up with the Purge button
          to clean up.
        </Note>

        <H3>Who holds this message?</H3>
        <P>
          Each expanded peek message has a <b>Who holds it?</b> chip in its header. Clicking it
          loads the consumers currently attached to the queue, grouped per client connection,
          with the <b>Credit</b> column showing each consumer's outstanding (unacked) message
          count. Rows highlighted in blue have non-zero credit — those are the consumers most
          likely sitting on this message right now.
        </P>
        <Note>
          Artemis doesn't expose a per-message lock owner through management, so this is an
          inference rather than a guarantee. Use it together with <b>Clients</b> (⌘4)
          when chasing "why is this message stuck?".
        </Note>
      </>
    ),
  },

  /* ── Inspector ───────────────────────────────────────────────────────── */
  {
    id: "inspector",
    title: "Broker Clients",
    icon: <Network className="w-3.5 h-3.5" />,
    searchText: "inspector clients broker connections consumers who holds message credit unacked broker management listConnectionsAsJSON listAllConsumersAsJSON session protocol",
    content: (
      <>
        <H><Network className="w-4 h-4 text-accent" />Broker Clients inspector</H>
        <P>
          Shows everyone connected to the broker right now — both AMQPush itself and any
          other clients (other AMQP libraries, Core / OpenWire / STOMP, the broker's own
          management). Auto-refreshes every 3 seconds.
        </P>
        <H3>Left pane — client connections</H3>
        <P>
          Connections from the same host (different ephemeral ports) are{" "}
          <b>grouped</b> under a collapsible header showing the host name and
          a <Code>(N)</Code> counter. Click the chevron to expand the children
          — each child row is a single connection with its specific port,
          age, session count, and consumer count. Single-connection hosts
          render flat (no group header) — grouping only kicks in when there's
          something to fold.
        </P>
        <P>
          One row per active client connection. Columns are <b>Client</b> (remote
          address), <b>User</b>, <b>Proto</b> (AMQP / CORE / OPENWIRE / STOMP / MQTT),
          <b>Cons</b> (consumer count on this connection), <b>Sess</b> (session count)
          and <b>Age</b> (time since the connection opened). Click a row to see what it's
          consuming.
        </P>
        <H3>Right pane — consumers</H3>
        <P>
          One row per consumer attached to the selected connection. <b>Credit</b> is the
          number of messages the consumer has currently "checked out" but not yet
          acknowledged — the metric that answers "who is holding my message right now?". A non-zero credit on an idle consumer is the classic signature of a
          stuck handler. <b>Last RX</b> is time since the last delivery; <b>Age</b> is
          time since the consumer attached.
        </P>
        <Note>
          Requires Artemis or ActiveMQ Classic with AMQP management enabled — same
          requirement as Browser. The data comes from{" "}
          <Code>listConnectionsAsJSON</Code> and <Code>listAllConsumersAsJSON</Code>{" "}
          routed over the same long-lived management channel.
        </Note>
      </>
    ),
  },

  /* ── History ─────────────────────────────────────────────────────────── */
  {
    id: "history",
    title: "History",
    icon: <HistoryIcon className="w-3.5 h-3.5" />,
    searchText: "history sent log archive resend export json csv 200 entries persistent",
    content: (
      <>
        <H><HistoryIcon className="w-4 h-4 text-accent" />History</H>
        <P>
          The last <b>200 sends</b> (per stand) are persisted to <Code>~/.amqpush/history.json</Code>
          with full payload — text bodies always, file bodies up to 2&nbsp;MB (base64). Resend works
          even after a restart.
        </P>
        <H3>Layout</H3>
        <UL>
          <Li>Left pane: timestamped list, filterable.</Li>
          <Li>Right pane: full message — body (raw or pretty), application properties, auto-set properties.</Li>
          <Li><b>Resend</b> opens Send pre-filled with the original payload + properties.</Li>
          <Li><b>Export</b> dumps the visible filtered list as JSON or CSV.</Li>
        </UL>
        <Note>
          Files larger than 2&nbsp;MB are recorded by name only — body content isn't kept, so resend
          is unavailable. The threshold keeps <Code>history.json</Code> from ballooning.
        </Note>
      </>
    ),
  },

  /* ── Stats ──────────────────────────────────────────────────────────── */
  {
    id: "stats",
    title: "Stats",
    icon: <BarChart3 className="w-3.5 h-3.5" />,
    searchText: "stats statistics throughput sparkline cards reliability per-queue rate sent received error per-stand stand compare dev prod aggregate all",
    content: (
      <>
        <H><BarChart3 className="w-4 h-4 text-accent" />Stats</H>
        <P>
          Six top-level cards — sent / received / errors / avg payload / throughput / reliability —
          with rolling sparklines, plus a per-queue breakdown. Stats are session-only (cleared on
          quit), kept in memory so they don't bloat <Code>localStorage</Code>.
        </P>
        <UL>
          <Li><b>Throughput</b> — moving average over the last 30 seconds (msgs/sec).</Li>
          <Li><b>Reliability</b> — <Code>sent / (sent + errors)</Code> as a percentage.</Li>
          <Li><b>Per-queue</b> — sortable table; click a header to flip direction.</Li>
        </UL>
        <P>
          When you've sent traffic on more than one stand in the same session a{" "}
          <b>stand selector</b> appears in the top bar. Pick a specific stand to see only
          its numbers, or <b>All</b> to merge every bucket into one aggregate view — useful for
          comparing prod vs staging side-by-side without re-running. The selector auto-follows
          the stand chosen in the app header by default.
        </P>
      </>
    ),
  },

  /* ── Logs / Console ──────────────────────────────────────────────────── */
  {
    id: "logs",
    title: "Logs",
    icon: <Terminal className="w-3.5 h-3.5" />,
    searchText: "logs console activity events table sort filter date export json csv pause follow auto-scroll snapshot freeze",
    content: (
      <>
        <H><Terminal className="w-4 h-4 text-accent" />Logs</H>
        <P>
          Sortable table of every event — connect / send / receive / error — with date and time
          columns, level filter, search, and date presets (Today / 1h / 24h / 7d / All). Persists
          last 500 entries across restarts.
        </P>
        <H3>Pause vs Follow</H3>
        <UL>
          <Li><b>Pause</b> freezes the visible table — new events still arrive in the buffer but the table doesn't update until you Resume. Use when you want a stable snapshot to read or copy.</Li>
          <Li><b>Follow</b> keeps the view scrolled to the newest row. Turn off when you scroll up to read older entries — it stays parked there.</Li>
        </UL>
        <H3>Export</H3>
        <P>
          Exports respect the current filter. Pick JSON for round-tripping back into another tool,
          CSV for spreadsheet analysis, or <Code>.log</Code> for plain-text grep.
        </P>
      </>
    ),
  },

  /* ── Shortcuts ───────────────────────────────────────────────────────── */
  {
    id: "shortcuts",
    title: "Keyboard shortcuts",
    icon: <Keyboard className="w-3.5 h-3.5" />,
    searchText: "keyboard shortcuts hotkeys cmd k command palette enter send escape close",
    content: (
      <>
        <H><Keyboard className="w-4 h-4 text-accent" />Keyboard shortcuts</H>
        <H3>Global</H3>
        <Row label={<><Kbd>⌘</Kbd><Kbd>K</Kbd></>}>Open command palette.</Row>
        <Row label={<><Kbd>⌘</Kbd><Kbd>1</Kbd>…<Kbd>7</Kbd></>}>Switch view (Send / Receive / Browser / Broker Clients / History / Stats / Logs).</Row>
        <Row label={<><Kbd>⌘</Kbd><Kbd>L</Kbd></>}>Open Logs.</Row>
        <Row label={<><Kbd>⌘</Kbd><Kbd>Enter</Kbd></>}>Send the current message (Send view).</Row>
        <Row label={<><Kbd>Esc</Kbd></>}>Close any open modal / palette.</Row>
        <H3>Command palette</H3>
        <Row label={<><Kbd>↑</Kbd><Kbd>↓</Kbd></>}>Navigate. Disabled rows are skipped.</Row>
        <Row label={<><Kbd>Enter</Kbd></>}>Run the highlighted action.</Row>
        <H3>Editor (CodeMirror)</H3>
        <Row label={<><Kbd>⌘</Kbd><Kbd>/</Kbd></>}>Toggle line comment.</Row>
        <Row label={<><Kbd>⌘</Kbd><Kbd>F</Kbd></>}>Find / replace.</Row>
        <Row label={<>Type <Code>{"{{"}</Code></>}>Open variable autocomplete.</Row>
      </>
    ),
  },

  /* ── Tips ────────────────────────────────────────────────────────────── */
  {
    id: "tips",
    title: "Tips & Tricks",
    icon: <Sparkles className="w-3.5 h-3.5" />,
    searchText: "tips tricks pro power user advanced workflows performance debug",
    content: (
      <>
        <H><Sparkles className="w-4 h-4 text-accent" />Tips &amp; Tricks</H>
        <UL>
          <Li><b>Pre-fill from history</b>: when something fails in production, find the same payload in History → Resend → tweak → try again.</Li>
          <Li><b>Diagnose stuck queues</b>: Browser → click queue → Peek. Counters show prefetch / consumer status; peek shows what's actually waiting. Purge if needed.</Li>
          <Li><b>Test request-reply locally</b>: open two AMQPush windows, one Subscribed to <Code>requests</Code>, the other Sending with Reply on. The reply lands in the original Send view.</Li>
          <Li><b>Stress-test with Batch</b>: Repeat = 10000, Delay = 0. Watch Stats → Throughput. Set Pre-script <Code>ctx.set("id", "batch-" + ctx.iter)</Code> to make every message unique.</Li>
          <Li><b>Validate before send</b>: paste a JSON Schema / XSD into the Body schema modal. Send is gated on the body validating — no more "oops, missing field" sends.</Li>
          <Li><b>One stand per environment</b>: dev / test / prod as separate stands. Switching the stand in the app header switches the bus and its broker together; nothing else changes.</Li>
        </UL>
      </>
    ),
  },

  /* ── Storage / files ─────────────────────────────────────────────────── */
  {
    id: "files",
    title: "Files & Storage",
    icon: <Database className="w-3.5 h-3.5" />,
    searchText: "files storage paths config home directory amqpush stands templates queues history localstorage",
    content: (
      <>
        <H><Database className="w-4 h-4 text-accent" />Files &amp; Storage</H>
        <H3>~/.amqpush/</H3>
        <Row label="templates.json">Saved Send templates.</Row>
        <Row label="history.json">Last 200 sends per stand.</Row>
        <Row label="queues.json">Legacy queue bookmarks (UI removed; file ignored).</Row>
        <H3>Window storage</H3>
        <Row label="amqpush.logs">Last 500 log entries.</Row>
        <Row label="amqpush.recentQueues.*">The Recent queues of each stand.</Row>
        <Row label="amqpush.subscriber.*">Highlight rules, saved selectors, and kept messages.</Row>
        <Note>
          Broker settings are not here: they belong to the stand, next to the bus address, and
          live with the rest of the app's settings. Backing up <Code>~/.amqpush/</Code> carries
          your templates and send history to a fresh machine.
        </Note>
      </>
    ),
  },
];
