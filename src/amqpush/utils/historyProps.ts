/**
 * Mine the send-history for previously-used application property keys and
 * their values. Drives autocompletion in the Send view's Properties tab so
 * a user retyping `_AMQ_ROUTING_TYPE` after seeing it once gets a one-click
 * pick instead of repeated typing.
 *
 * The returned map is keyed by property name; each entry is an array of
 * unique values ordered by recency (most-recent-first) — capped per key so
 * a queue with millions of unique values doesn't blow the dropdown.
 *
 * Both user-supplied and auto-set properties are considered — together they
 * are the full "things a user has put on the wire" surface.
 */
import type { HistoryEntry } from "../types";

const VALUES_PER_KEY_CAP = 50;
const KEYS_CAP = 500;

export interface PropSuggestions {
  /** Sorted keys (most-recently-used first). */
  keys: string[];
  /** key → ordered list of unique values seen for that key (most-recent first). */
  valuesByKey: Map<string, string[]>;
}

export function mineHistoryProps(history: HistoryEntry[]): PropSuggestions {
  // Per-key ordered set of values. We use Map to preserve insertion order
  // and dedupe in O(1).
  const valuesByKey = new Map<string, Map<string, true>>();
  // Per-key last-seen timestamp for the recency-based key sort.
  const lastSeen = new Map<string, number>();

  // History is newest-first in our app's convention, but we'll iterate in
  // both orders defensively. Walk in given order so the "most-recent" Map
  // insertion lands on the first occurrence.
  for (const entry of history) {
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : 0;
    const bucket = (k: string, v: string) => {
      if (!k) return;
      let set = valuesByKey.get(k);
      if (!set) {
        set = new Map<string, true>();
        valuesByKey.set(k, set);
      }
      // If value already present, leave it where it is (preserves recency
      // ordering of the FIRST time we saw it during this walk).
      if (!set.has(v) && set.size < VALUES_PER_KEY_CAP) {
        set.set(v, true);
      }
      if (!lastSeen.has(k) || ts > (lastSeen.get(k) ?? 0)) {
        lastSeen.set(k, ts);
      }
    };
    for (const [k, v] of Object.entries(entry.properties ?? {})) {
      bucket(k, String(v));
    }
    for (const [k, v] of Object.entries(entry.auto_properties ?? {})) {
      bucket(k, String(v));
    }
  }

  // Sort keys by last-seen timestamp descending, then alphabetical for
  // never-seen-with-ts ties. Cap to KEYS_CAP for sanity.
  const keys = [...valuesByKey.keys()]
    .sort((a, b) => {
      const da = lastSeen.get(a) ?? 0;
      const db = lastSeen.get(b) ?? 0;
      if (db !== da) return db - da;
      return a.localeCompare(b);
    })
    .slice(0, KEYS_CAP);

  const valuesByKeyArr = new Map<string, string[]>();
  for (const k of keys) {
    valuesByKeyArr.set(k, [...(valuesByKey.get(k)?.keys() ?? [])]);
  }
  return { keys, valuesByKey: valuesByKeyArr };
}
