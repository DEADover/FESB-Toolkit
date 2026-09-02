/**
 * Simple line-by-line diff via Longest Common Subsequence (LCS).
 *
 * Returns operations: `eq` (line in both), `del` (only in left), `add`
 * (only in right). O(n·m) DP over lines — fine for message-sized payloads
 * (a few hundred lines); not appropriate for diffing whole codebases.
 *
 * Shared between SubscriberView's compare-two-messages flow and
 * HistoryView's compare-this-send-to-another flow so both renderings
 * agree on what counts as a "differing line".
 */
export type DiffOp = { kind: "eq" | "del" | "add"; left?: string; right?: string };

export function diffLines(a: string, b: string): DiffOp[] {
  const la = a.split("\n");
  const lb = b.split("\n");
  const n = la.length, m = lb.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = la[i] === lb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (la[i] === lb[j]) { ops.push({ kind: "eq", left: la[i], right: lb[j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ kind: "del", left: la[i] }); i++; }
    else { ops.push({ kind: "add", right: lb[j] }); j++; }
  }
  while (i < n) { ops.push({ kind: "del", left: la[i++] }); }
  while (j < m) { ops.push({ kind: "add", right: lb[j++] }); }
  return ops;
}
