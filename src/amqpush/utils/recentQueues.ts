/**
 * Recent-queues MRU list, keyed by profile.
 *
 * Persisted in `localStorage` (per-WebView, lives next to the rest of the
 * app's UI state) under `amqpush.recentQueues.<profileName>`. Capped at
 * `MAX_PER_PROFILE` entries; oldest entries fall off when the cap is hit.
 *
 * Used by `QueuePicker` to surface a "Recent" section above the live broker
 * queue list — common case is "send to the queue I just sent to" which the
 * pure-broker list doesn't help with (it's alphabetical and grows large).
 *
 * Recording is best-effort: failures to read/write storage are swallowed so
 * a quota-exceeded or disabled-storage browser doesn't break send/subscribe.
 */

const KEY_PREFIX = "amqpush.recentQueues.";
const MAX_PER_PROFILE = 10;

export interface RecentQueueEntry {
  /** Queue address (or queue name — whatever the user passed to send/subscribe). */
  address: string;
  /** ms since epoch — most recently used time. Drives MRU sort. */
  ts: number;
}

function keyFor(profile: string): string {
  return `${KEY_PREFIX}${profile || "Default"}`;
}

/** Read the MRU list for a profile, newest first. Returns `[]` on any error. */
export function readRecentQueues(profile: string): RecentQueueEntry[] {
  if (!profile) return [];
  try {
    const raw = localStorage.getItem(keyFor(profile));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter((e): e is RecentQueueEntry =>
      !!e && typeof (e as RecentQueueEntry).address === "string"
            && typeof (e as RecentQueueEntry).ts === "number");
    return valid.sort((a, b) => b.ts - a.ts).slice(0, MAX_PER_PROFILE);
  } catch {
    return [];
  }
}

/**
 * Push an address to the front of the MRU list for the given profile.
 * Re-uses with bump semantics: if the address is already present, its
 * timestamp is updated and it moves to the front rather than being added
 * twice. Trims to the cap.
 */
export function recordRecentQueue(profile: string, address: string): void {
  const a = address.trim();
  if (!profile || !a) return;
  try {
    const current = readRecentQueues(profile);
    const filtered = current.filter(e => e.address !== a);
    filtered.unshift({ address: a, ts: Date.now() });
    const trimmed = filtered.slice(0, MAX_PER_PROFILE);
    localStorage.setItem(keyFor(profile), JSON.stringify(trimmed));
  } catch {
    // storage full / disabled → silently ignore
  }
}

/**
 * Remove a specific address from a profile's MRU list. Used by the
 * QueuePicker's per-entry × button.
 */
export function forgetRecentQueue(profile: string, address: string): void {
  if (!profile) return;
  try {
    const current = readRecentQueues(profile);
    const filtered = current.filter(e => e.address !== address);
    if (filtered.length === current.length) return;
    localStorage.setItem(keyFor(profile), JSON.stringify(filtered));
  } catch {
    // ignore
  }
}

/** Drop every recent-queue entry for the profile (e.g. when it's deleted). */
export function clearRecentQueues(profile: string): void {
  if (!profile) return;
  try { localStorage.removeItem(keyFor(profile)); } catch { /* ignore */ }
}
