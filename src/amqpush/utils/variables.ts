import { faker } from "@faker-js/faker/locale/en";

export interface UserVariable {
  id: number;
  enabled: boolean;
  key: string;
  value: string;
  description: string;
}

/**
 * Resolve a `{{faker.<path>}}` or `{{faker.<path>(<arg>)}}` token. Returns
 * the generated value (always a string), or `null` if the path isn't
 * recognised — the caller leaves the original token intact in that case.
 *
 * Designed to be cheap: faker is bundled at module load (it's a desktop
 * app, no first-paint constraint), and each resolver call is just a thin
 * wrapper around one or two faker functions.
 */
function resolveFakerToken(path: string, arg?: string): string | null {
  switch (path) {
    // ── People ─────────────────────────────────────────────────────────
    case "firstName":         return faker.person.firstName();
    case "lastName":          return faker.person.lastName();
    case "fullName":          return faker.person.fullName();
    case "jobTitle":          return faker.person.jobTitle();
    case "gender":            return faker.person.gender();

    // ── Internet / contact ─────────────────────────────────────────────
    case "email":             return faker.internet.email().toLowerCase();
    case "username":          return faker.internet.username();
    case "url":               return faker.internet.url();
    case "domain":            return faker.internet.domainName();
    case "userAgent":         return faker.internet.userAgent();
    case "password":          return faker.internet.password();
    case "ip":                return faker.internet.ipv4();
    case "ipv6":              return faker.internet.ipv6();
    case "macAddress":        return faker.internet.mac();
    case "phone":             return faker.phone.number();

    // ── Address ────────────────────────────────────────────────────────
    case "streetAddress":     return faker.location.streetAddress();
    case "city":              return faker.location.city();
    case "state":             return faker.location.state();
    case "country":           return faker.location.country();
    case "countryCode":       return faker.location.countryCode();
    case "zipCode":           return faker.location.zipCode();
    case "latitude":          return faker.location.latitude().toString();
    case "longitude":         return faker.location.longitude().toString();

    // ── Finance ────────────────────────────────────────────────────────
    case "creditCardNumber":  return faker.finance.creditCardNumber();
    case "creditCardCvv":     return faker.finance.creditCardCVV();
    case "creditCardExpiry":  return faker.date.future({ years: 5 }).toISOString().slice(0, 7);
    case "iban":              return faker.finance.iban();
    case "bic":               return faker.finance.bic();
    case "currency":          return faker.finance.currencyCode();
    case "amount":            return faker.finance.amount();

    // ── Company / commerce ─────────────────────────────────────────────
    case "companyName":       return faker.company.name();
    case "productName":       return faker.commerce.productName();
    case "productPrice":      return faker.commerce.price();
    case "department":        return faker.commerce.department();

    // ── Text ───────────────────────────────────────────────────────────
    case "lorem": {
      // {{faker.lorem}} → 1 sentence; {{faker.lorem(N)}} → N words
      const n = arg ? parseInt(arg, 10) : NaN;
      return Number.isFinite(n) && n > 0 ? faker.lorem.words(n) : faker.lorem.sentence();
    }
    case "loremParagraph":    return faker.lorem.paragraph();
    case "word":              return faker.lorem.word();

    default:                  return null;
  }
}

/**
 * Result of running a Pre-script. `vars` is the dict of names→values the
 * script set via `ctx.set(name, value)`; `logs` is whatever it sent to
 * `ctx.log(...args)` (we surface those in the Logs view); `error` is set
 * when the script threw — the calling code decides whether to abort the
 * send or continue with whatever vars were collected before the throw.
 */
export interface PreScriptResult {
  vars: Record<string, string>;
  logs: string[];
  error?: string;
}

/**
 * Run a Pre-script in a sandboxed Function. The script body has access to:
 *
 *   - `ctx.set(name, value)` — register a variable for `{{name}}` substitution
 *   - `ctx.get(name)`        — read previously-set / user-defined value
 *   - `ctx.log(...args)`     — push a string to the AMQPush log
 *   - `ctx.now`              — Date.now() snapshot at start of run
 *   - `ctx.uuid()`           — crypto.randomUUID()
 *   - Built-ins: Date, Math, JSON, crypto
 *
 * The script does NOT have access to: `window`, `document`, `fetch`,
 * Tauri APIs, `eval`, dynamic imports, the rest of the React tree, or
 * anything else not explicitly passed in. (`Function` constructed code
 * still runs in the global JS context, so a determined user CAN reach
 * `globalThis` — this is a usability sandbox, not a security boundary.
 * Don't import templates from untrusted sources.)
 */
/** Constructor for an async function literal — used to compile user pre-scripts
 *  so they can `await` Web Crypto, timers, and other Promise-returning APIs at
 *  the top level. Not exposed by the standard runtime; recovered via the
 *  prototype chain of an async function expression. */
const AsyncFunction: new (...args: string[]) => (...args: unknown[]) => Promise<unknown> =
  Object.getPrototypeOf(async function () {}).constructor;

export async function runPreScript(
  script: string,
  existingVars: UserVariable[]
): Promise<PreScriptResult> {
  const vars: Record<string, string> = {};
  const logs: string[] = [];

  if (!script.trim()) return { vars, logs };

  const ctx = {
    set(name: string, value: unknown) {
      if (typeof name !== "string" || !name.trim()) return;
      vars[name] = value === null || value === undefined ? "" : String(value);
    },
    get(name: string): string | undefined {
      if (name in vars) return vars[name];
      const u = existingVars.find(v => v.enabled && v.key === name);
      return u?.value;
    },
    log(...args: unknown[]) {
      logs.push(args.map(a => {
        if (typeof a === "string") return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(" "));
    },
    now: Date.now(),
    uuid() { return crypto.randomUUID(); },
  };

  try {
    // Compile as an *async* function so `await` works at the top level —
    // useful for `crypto.subtle.digest`, fetch wrappers, anything that
    // returns a Promise. We only expose what's passed via parameters;
    // the script can still reach `globalThis` (deliberately — pre-script
    // is a usability sandbox, not a security boundary).
    const fn = new AsyncFunction("ctx", "Date", "Math", "JSON", "crypto",
      `"use strict";\n${script}`);
    await fn(ctx, Date, Math, JSON, crypto);
    return { vars, logs };
  } catch (e) {
    return { vars, logs, error: (e as Error).message };
  }
}

/** Persistent counter — increments on every `{{counter}}` substitution. Resets
 *  on app restart. Useful when running batch sends to give each message a
 *  monotonic sequence number. */
let counterValue = 0;

/** Build N random characters from the given charset. */
function randomString(n: number, charset: "alnum" | "alpha" | "hex"): string {
  const chars =
    charset === "hex"   ? "0123456789abcdef" :
    charset === "alpha" ? "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" :
                          "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/**
 * Replaces `{{variable}}` tokens in a string before sending. User-defined
 * tokens are applied first so they can override built-ins; the built-ins
 * cover identifiers, randomness, dates / times and a process-local counter.
 *
 * Token reference (also surfaced in the Variables tab "Built-in presets"):
 *
 *   Identifiers      uuid, counter
 *   Randomness       random_int, random_int(min,max), random_float, random_bool,
 *                    random_string, random_string(N), random_hex, random_hex(N),
 *                    random_alpha(N), random_choice(a|b|c), random_email
 *   Dates / times    timestamp, timestamp_ms, timestamp_s,
 *                    date, date_local, time, time_local,
 *                    year, month, day, hour, minute, second
 *
 * The counter is shared per-render — a single `applyVariables(...)` call that
 * contains `{{counter}}` twice gets two consecutive values, not the same one.
 */
export function applyVariables(text: string, userVars: UserVariable[] = []): string {
  // 1. User-defined variables first (can override built-ins by name).
  let result = text;
  for (const v of userVars) {
    if (!v.enabled || !v.key.trim()) continue;
    const safe = v.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`\\{\\{\\s*${safe}\\s*\\}\\}`, "g"), v.value);
  }

  // 2. Built-in tokens. Snapshot `now` once per call so all date/time tokens
  //    that fire in the same render see the same instant.
  const now = new Date();

  return result
    // ── Identifiers ──────────────────────────────────────────────────────
    .replace(/\{\{uuid\}\}/g, () => crypto.randomUUID())
    .replace(/\{\{counter\}\}/g, () => (++counterValue).toString())

    // ── Random numbers ───────────────────────────────────────────────────
    .replace(/\{\{random_int\((\d+),\s*(\d+)\)\}\}/g, (_, min, max) => {
      const lo = parseInt(min, 10);
      const hi = parseInt(max, 10);
      return Math.floor(Math.random() * (hi - lo + 1) + lo).toString();
    })
    .replace(/\{\{random_int\}\}/g, () => Math.floor(Math.random() * 1_000_000).toString())
    .replace(/\{\{random_float\}\}/g, () => Math.random().toFixed(6))
    .replace(/\{\{random_bool\}\}/g, () => Math.random() < 0.5 ? "true" : "false")

    // ── Random strings ───────────────────────────────────────────────────
    .replace(/\{\{random_string\((\d+)\)\}\}/g, (_, n) => randomString(parseInt(n, 10), "alnum"))
    .replace(/\{\{random_string\}\}/g, () => randomString(10, "alnum"))
    .replace(/\{\{random_hex\((\d+)\)\}\}/g, (_, n) => randomString(parseInt(n, 10), "hex"))
    .replace(/\{\{random_hex\}\}/g, () => randomString(16, "hex"))
    .replace(/\{\{random_alpha\((\d+)\)\}\}/g, (_, n) => randomString(parseInt(n, 10), "alpha"))

    // random_choice(a|b|c) — pick one of the pipe-separated alternatives.
    // Whitespace around each choice is trimmed so `{{random_choice(red | green | blue)}}`
    // does the natural thing.
    .replace(/\{\{random_choice\(([^)]+)\)\}\}/g, (_, opts: string) => {
      const choices = opts.split("|").map(s => s.trim()).filter(Boolean);
      return choices.length === 0 ? "" : choices[Math.floor(Math.random() * choices.length)];
    })

    // Synthetic email — useful when a downstream consumer expects a unique
    // user identifier per request and you don't want to hand-roll one.
    .replace(/\{\{random_email\}\}/g, () => `${randomString(8, "alnum").toLowerCase()}@example.com`)

    // ── Dates / times ────────────────────────────────────────────────────
    .replace(/\{\{timestamp\}\}/g,    () => now.toISOString())
    .replace(/\{\{timestamp_ms\}\}/g, () => now.getTime().toString())
    .replace(/\{\{timestamp_s\}\}/g,  () => Math.floor(now.getTime() / 1000).toString())
    .replace(/\{\{date\}\}/g,         () => now.toISOString().slice(0, 10))
    .replace(/\{\{date_local\}\}/g,   () => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
    .replace(/\{\{time\}\}/g,         () => now.toISOString().slice(11, 19))
    .replace(/\{\{time_local\}\}/g,   () => `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`)
    .replace(/\{\{year\}\}/g,         () => String(now.getFullYear()))
    .replace(/\{\{month\}\}/g,        () => pad(now.getMonth() + 1))
    .replace(/\{\{day\}\}/g,          () => pad(now.getDate()))
    .replace(/\{\{hour\}\}/g,         () => pad(now.getHours()))
    .replace(/\{\{minute\}\}/g,       () => pad(now.getMinutes()))
    .replace(/\{\{second\}\}/g,       () => pad(now.getSeconds()))

    // ── Faker tokens — {{faker.<path>}} or {{faker.<path>(<arg>)}} ──────
    //   Single regex catches every faker.* token; resolveFakerToken does the
    //   actual lookup. Unknown paths are left intact (regex doesn't match).
    .replace(/\{\{faker\.(\w+)(?:\(([^)]*)\))?\}\}/g, (orig, path, arg) => {
      const v = resolveFakerToken(path, arg);
      return v === null ? orig : v;
    });
}

/**
 * Catalogue used by the Variables tab "Built-in presets" dropdown. Order
 * matches the substitution order in `applyVariables` so users see related
 * tokens grouped together.
 */
export const VARIABLE_HINTS: { token: string; description: string }[] = [
  // Identifiers
  { token: "{{uuid}}",                 description: "Random UUID v4" },
  { token: "{{counter}}",              description: "Auto-incrementing sequence (resets on restart)" },

  // Randomness
  { token: "{{random_int}}",           description: "Random integer 0–999999" },
  { token: "{{random_int(1,100)}}",    description: "Random integer in range [min,max]" },
  { token: "{{random_float}}",         description: "Random float 0.0–1.0" },
  { token: "{{random_bool}}",          description: "Random true / false" },
  { token: "{{random_string}}",        description: "10 random alphanumeric chars" },
  { token: "{{random_string(N)}}",     description: "N random alphanumeric chars" },
  { token: "{{random_hex}}",           description: "16 random hex chars" },
  { token: "{{random_hex(N)}}",        description: "N random hex chars" },
  { token: "{{random_alpha(N)}}",      description: "N random letters (no digits)" },
  { token: "{{random_choice(a|b|c)}}", description: "Pick one of the alternatives" },
  { token: "{{random_email}}",         description: "Synthetic user@example.com address" },

  // Dates / times
  { token: "{{timestamp}}",            description: "ISO-8601 UTC datetime" },
  { token: "{{timestamp_ms}}",         description: "Unix epoch (milliseconds)" },
  { token: "{{timestamp_s}}",          description: "Unix epoch (seconds)" },
  { token: "{{date}}",                 description: "YYYY-MM-DD (UTC)" },
  { token: "{{date_local}}",           description: "YYYY-MM-DD (local timezone)" },
  { token: "{{time}}",                 description: "HH:MM:SS (UTC)" },
  { token: "{{time_local}}",           description: "HH:MM:SS (local timezone)" },
  { token: "{{year}}",                 description: "Current year (4-digit)" },
  { token: "{{month}}",                description: "Current month (01–12)" },
  { token: "{{day}}",                  description: "Current day of month (01–31)" },
  { token: "{{hour}}",                 description: "Current hour (00–23, local)" },
  { token: "{{minute}}",               description: "Current minute (00–59, local)" },
  { token: "{{second}}",               description: "Current second (00–59, local)" },

  // ── Faker — fake but realistic data (powered by @faker-js/faker) ─────
  // People
  { token: "{{faker.firstName}}",         description: "Faker · random first name" },
  { token: "{{faker.lastName}}",          description: "Faker · random last name" },
  { token: "{{faker.fullName}}",          description: "Faker · full name (first + last)" },
  { token: "{{faker.jobTitle}}",          description: "Faker · job title (e.g. \"Lead Brand Producer\")" },
  { token: "{{faker.gender}}",            description: "Faker · gender" },
  // Internet / contact
  { token: "{{faker.email}}",             description: "Faker · realistic email address" },
  { token: "{{faker.username}}",          description: "Faker · username (e.g. \"john.doe42\")" },
  { token: "{{faker.url}}",               description: "Faker · URL with realistic domain" },
  { token: "{{faker.domain}}",            description: "Faker · domain name" },
  { token: "{{faker.userAgent}}",         description: "Faker · browser User-Agent string" },
  { token: "{{faker.password}}",          description: "Faker · password (15 chars)" },
  { token: "{{faker.ip}}",                description: "Faker · IPv4 address" },
  { token: "{{faker.ipv6}}",              description: "Faker · IPv6 address" },
  { token: "{{faker.macAddress}}",        description: "Faker · MAC address" },
  { token: "{{faker.phone}}",             description: "Faker · phone number" },
  // Address
  { token: "{{faker.streetAddress}}",     description: "Faker · street address" },
  { token: "{{faker.city}}",              description: "Faker · city name" },
  { token: "{{faker.state}}",             description: "Faker · US state name" },
  { token: "{{faker.country}}",           description: "Faker · country name" },
  { token: "{{faker.countryCode}}",       description: "Faker · ISO 3166 country code" },
  { token: "{{faker.zipCode}}",           description: "Faker · ZIP / postal code" },
  { token: "{{faker.latitude}}",          description: "Faker · latitude" },
  { token: "{{faker.longitude}}",         description: "Faker · longitude" },
  // Finance
  { token: "{{faker.creditCardNumber}}",  description: "Faker · Luhn-valid credit-card number" },
  { token: "{{faker.creditCardCvv}}",     description: "Faker · 3-digit CVV" },
  { token: "{{faker.creditCardExpiry}}",  description: "Faker · YYYY-MM expiry" },
  { token: "{{faker.iban}}",              description: "Faker · IBAN bank account" },
  { token: "{{faker.bic}}",               description: "Faker · BIC / SWIFT code" },
  { token: "{{faker.currency}}",          description: "Faker · ISO currency code (e.g. EUR)" },
  { token: "{{faker.amount}}",            description: "Faker · monetary amount (decimal string)" },
  // Company / commerce
  { token: "{{faker.companyName}}",       description: "Faker · company name" },
  { token: "{{faker.productName}}",       description: "Faker · product name" },
  { token: "{{faker.productPrice}}",      description: "Faker · product price (decimal string)" },
  { token: "{{faker.department}}",        description: "Faker · commerce department" },
  // Text
  { token: "{{faker.lorem}}",             description: "Faker · single lorem-ipsum sentence" },
  { token: "{{faker.lorem(N)}}",          description: "Faker · N lorem-ipsum words" },
  { token: "{{faker.loremParagraph}}",    description: "Faker · paragraph of lorem ipsum" },
  { token: "{{faker.word}}",              description: "Faker · single random word" },
];
