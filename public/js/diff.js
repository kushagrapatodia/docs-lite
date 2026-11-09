// Word-level difference between two texts, used for the version-history preview summary.
// Exact (longest common subsequence) for normal documents; falls back to a fast
// multiset comparison for very large ones so the UI never stalls.
const tokens = (t) => String(t || '').split(/\s+/).filter(Boolean);
const EXACT_LIMIT = 4_000_000; // max cells in the LCS table

export function diffStats(from, to) {
  const a = tokens(from), b = tokens(to);
  if (!a.length || !b.length || a.length * b.length > EXACT_LIMIT) return multiset(a, b);
  // trim common prefix and suffix: most edits are local
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const x = a.slice(s, ea), y = b.slice(s, eb);
  if (!x.length || !y.length) return { added: y.length, removed: x.length };
  if (x.length * y.length > EXACT_LIMIT) return multiset(x, y);
  let prev = new Uint32Array(y.length + 1), cur = new Uint32Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  const common = prev[y.length];
  return { added: y.length - common, removed: x.length - common };
}

function multiset(a, b) {
  const count = new Map();
  for (const t of a) count.set(t, (count.get(t) || 0) + 1);
  let common = 0;
  for (const t of b) { const n = count.get(t); if (n) { common++; count.set(t, n - 1); } }
  return { added: b.length - common, removed: a.length - common };
}

export function htmlToPlain(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script, style, template, noscript').forEach((e) => e.remove());
  return doc.body.textContent || '';
}
