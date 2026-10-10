// Matching for the command box (DESIGN-SPEC 3.13.5): letters in order, a bonus for word starts and for
// runs of letters. Ignores case and accents. Pure functions, no DOM.

/** Lower case, one character in and one character out (accents are dropped), so positions stay valid. */
export function foldChars(s: string): string[] {
  return [...s].map((c) => {
    const base = c.normalize('NFD').charAt(0);
    return base.toLowerCase();
  });
}

export interface Match {
  score: number;
  /** Indexes (in the characters of the text) that matched, for the bold letters. */
  positions: number[];
}

const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);

/** Best match of `query` in `text`, or null when the letters do not appear in this order. */
export function fuzzyMatch(query: string, text: string): Match | null {
  const q = foldChars(query).filter((c) => c.trim() !== '');
  if (q.length === 0) return { score: 0, positions: [] };
  const t = foldChars(text);
  const n = q.length;
  const m = t.length;
  if (n > m) return null;
  // Fast check: are the letters there in order at all?
  let at = 0;
  for (let j = 0; j < m && at < n; j++) if (t[j] === q[at]) at++;
  if (at < n) return null;

  const start = (j: number) => j === 0 || !isWordChar(t[j - 1]!);
  const NEG = -1e9;
  const dp: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(NEG));
  const from: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(-1));
  for (let j = 0; j < m; j++) if (t[j] === q[0]) dp[0]![j] = 1 + (start(j) ? 8 : 0) - j * 0.05;
  for (let i = 1; i < n; i++) {
    for (let j = i; j < m; j++) {
      if (t[j] !== q[i]) continue;
      let best = NEG;
      let arg = -1;
      for (let k = i - 1; k < j; k++) {
        const prev = dp[i - 1]![k]!;
        if (prev <= NEG) continue;
        const s = prev + 1 + (start(j) ? 8 : 0) + (k === j - 1 ? 5 : 0) - (j - k - 1) * 0.05;
        if (s > best) {
          best = s;
          arg = k;
        }
      }
      dp[i]![j] = best;
      from[i]![j] = arg;
    }
  }
  let endJ = -1;
  let top = NEG;
  for (let j = 0; j < m; j++) {
    if (dp[n - 1]![j]! > top) {
      top = dp[n - 1]![j]!;
      endJ = j;
    }
  }
  if (endJ < 0) return null;
  const positions: number[] = new Array<number>(n);
  let j = endJ;
  for (let i = n - 1; i >= 0; i--) {
    positions[i] = j;
    j = from[i]![j]!;
  }
  return { score: top, positions };
}

export interface Ranked<T> {
  item: T;
  score: number;
  positions: number[];
}

/**
 * Ranks items for a query: best score first. Ties: recent items first (lower `recent` rank), then the
 * original order. Keeps at most `limit` results.
 */
export function rankItems<T>(
  items: readonly T[],
  query: string,
  text: (t: T) => string,
  recentRank: (t: T) => number | null,
  limit = 30,
): Ranked<T>[] {
  const out: (Ranked<T> & { order: number; recent: number })[] = [];
  items.forEach((item, order) => {
    const m = fuzzyMatch(query, text(item));
    if (!m) return;
    const r = recentRank(item);
    out.push({ item, score: m.score, positions: m.positions, order, recent: r === null ? 1e6 : r });
  });
  out.sort((a, b) => b.score - a.score || a.recent - b.recent || a.order - b.order);
  return out.slice(0, limit).map(({ item, score, positions }) => ({ item, score, positions }));
}
