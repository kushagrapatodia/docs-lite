// Automatic three-way merge of two edits of the same document, at the level of top-level blocks
// (paragraphs, headings, lists, tables...). If the two people changed different blocks the result contains
// both changes; if they touched the same block the merge gives up (returns null) and the caller asks the user.

export function splitBlocks(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return [...doc.body.childNodes].filter((n) => n.nodeType === 1 || (n.nodeType === 3 && n.nodeValue.trim())).map((n) => (n.nodeType === 1 ? n.outerHTML : n.nodeValue.trim()));
}

// Edits that turn `base` into `x`, as [baseStart, baseEnd, replacement[]], from a longest-common-subsequence walk.
export function changes(base, x) {
  const n = base.length, m = x.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = base[i] === x[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0, cur = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === x[j]) { flush(); i++; j++; continue; }
    if (!cur) cur = [i, i, []];
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { cur[2].push(x[j]); j++; } else { cur[1] = ++i; }
  }
  flush();
  return out;
}

const same = (a, b) => a.length === b.length && a.every((v, k) => v === b[k]);

// Returns the merged array of blocks, or null when both sides changed the same place differently.
export function merge3(base, mine, theirs) {
  const a = changes(base, mine), b = changes(base, theirs);
  const out = [];
  let pos = 0, i = 0, j = 0;
  const take = (to) => { while (pos < to) out.push(base[pos++]); };
  while (i < a.length || j < b.length) {
    const ca = a[i], cb = b[j];
    if (ca && cb) {
      const overlap = ca[0] < cb[1] && cb[0] < ca[1];
      const sameSpot = ca[0] === cb[0] && (ca[0] === ca[1] || cb[0] === cb[1]); // two insertions at one place (or an insertion at the start of a change)
      if (overlap || sameSpot) {
        if (ca[0] === cb[0] && ca[1] === cb[1] && same(ca[2], cb[2])) { take(ca[0]); out.push(...ca[2]); pos = ca[1]; i++; j++; continue; } // identical edit
        return null;
      }
    }
    const c = !cb || (ca && ca[0] <= cb[0]) ? (i++, ca) : (j++, cb);
    take(c[0]); out.push(...c[2]); pos = c[1];
  }
  take(base.length);
  return out;
}

// Words, whitespace and tags as separate tokens, so two people editing different sentences of ONE paragraph also merge.
const tokens = (html) => String(html).split(/(<[^>]+>|\s+)/).filter((t) => t !== '');
const MAX_TOKENS = 4000; // the diff is quadratic: bigger documents fall back to asking

// Every opening tag has its closing tag, in order (void tags excepted)
function balanced(html) {
  const stack = [];
  for (const t of html.match(/<\/?[a-zA-Z][^>]*>/g) || []) {
    const name = /^<\/?([a-zA-Z0-9]+)/.exec(t)[1].toLowerCase();
    if (['br', 'hr', 'img'].includes(name)) continue;
    if (t[1] === '/') { if (stack.pop() !== name) return false; } else stack.push(name);
  }
  return stack.length === 0;
}

export function mergeHtml(baseHtml, mineHtml, theirsHtml) {
  const merged = merge3(splitBlocks(baseHtml), splitBlocks(mineHtml), splitBlocks(theirsHtml));
  if (merged) return merged.join('\n');
  const [b, m, t] = [tokens(baseHtml), tokens(mineHtml), tokens(theirsHtml)];
  if (Math.max(b.length, m.length, t.length) > MAX_TOKENS) return null;
  const words = merge3(b, m, t);
  if (!words) return null;
  const joined = words.join('');
  return balanced(joined) ? joined : null; // a merge that breaks the tag structure is worse than asking
}
