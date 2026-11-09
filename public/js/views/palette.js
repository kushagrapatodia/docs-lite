import { h, icon } from '../dom.js';

// Ctrl/Cmd+Shift+P command palette: type to filter, arrows to move, Enter to run, Esc to close.
// Matching: every word must appear (substring), otherwise the query may match as a subsequence ("bld" -> "Bold").
export const fuzzy = (label, q) => {
  const L = label.toLowerCase(); const pos = []; let from = 0;
  for (const ch of q.replace(/\s+/g, '')) { const k = L.indexOf(ch, from); if (k < 0) return null; pos.push(k); from = k + 1; }
  let score = 1; pos.forEach((k, n) => { if (n && k === pos[n - 1] + 1) score += 2; if (k === 0 || L[k - 1] === ' ') score += 2; });
  return { score, pos };
};
export const rank = (c, q) => {
  if (!q) return { score: 1, pos: [] };
  const hay = `${c.label} ${c.keywords || ''} ${c.group || ''}`.toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  if (words.every((w) => hay.includes(w))) {
    const pos = []; const L = c.label.toLowerCase();
    for (const w of words) { const k = L.indexOf(w); if (k >= 0) for (let n = 0; n < w.length; n++) pos.push(k + n); }
    return { score: 100 + words.reduce((n, w) => n + (L.startsWith(w) ? 3 : hay.includes(` ${w}`) ? 2 : 1), 0), pos };
  }
  const f = fuzzy(c.label, q);
  return f ? { score: f.score, pos: f.pos } : null;
};

let current = null; // one palette at a time
export function openPalette(commands) {
  if (current) current.close();
  const prev = document.activeElement;
  let items = commands, index = 0;
  const input = h('input', { type: 'text', class: 'pal-input', placeholder: 'Type a command…', 'aria-label': 'Search commands', role: 'combobox', 'aria-expanded': 'true', 'aria-autocomplete': 'list', 'aria-controls': 'pal-list', autocomplete: 'off', spellcheck: false });
  const list = h('ul', { class: 'pal-list', id: 'pal-list', role: 'listbox' });
  const overlay = h('div', { class: 'pal-overlay', onmousedown: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'pal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' }, input, list, h('div', { class: 'pal-foot muted small' }, '↑↓ to move · Enter to run · Esc to close')));
  const RECENT_KEY = 'docs-lite:palette-recent';
  const recents = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } };
  const remember = (label) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([label, ...recents().filter((x) => x !== label)].slice(0, 5))); } catch { /* ignore */ } };
  const bold = (label, pos) => { const set = new Set(pos); return [...label].map((ch, i) => (set.has(i) ? h('b', {}, ch) : ch)); };
  function draw() {
    const q = input.value.trim().toLowerCase();
    let ranked;
    if (q) ranked = commands.map((c) => ({ c, r: rank(c, q) })).filter((x) => x.r).sort((a, b) => b.r.score - a.r.score).slice(0, 40);
    else {
      const rec = recents().map((l) => commands.find((c) => c.label === l)).filter(Boolean);
      const rest = commands.filter((c) => !rec.includes(c));
      ranked = [...rec.map((c) => ({ c, r: { pos: [] }, head: 'Recent' })), ...rest.slice(0, 40).map((c) => ({ c, r: { pos: [] }, head: c.group || 'Commands' }))];
    }
    items = ranked.map((x) => x.c);
    index = Math.min(index, Math.max(0, items.length - 1));
    const rows = []; let lastHead = null;
    ranked.forEach((x, i) => {
      if (x.head && x.head !== lastHead) { lastHead = x.head; rows.push(h('li', { class: 'pal-group', role: 'presentation' }, x.head)); }
      rows.push(h('li', { class: `pal-item${i === index ? ' active' : ''}`, role: 'option', id: `pal-${i}`, 'aria-selected': String(i === index), onmousemove: () => { if (index !== i) { index = i; mark(); } }, onclick: () => run(x.c) },
        h('span', { class: 'pal-label' }, x.c.icon ? icon(x.c.icon, 16) : null, h('span', {}, x.r.pos.length ? bold(x.c.label, x.r.pos) : x.c.label)), x.c.hint && h('kbd', {}, x.c.hint)));
    });
    list.replaceChildren(...rows);
    if (!items.length) list.append(h('li', { class: 'pal-empty muted' }, 'No matching commands'));
    input.setAttribute('aria-expanded', String(items.length > 0));
    input.setAttribute('aria-activedescendant', items.length ? `pal-${index}` : '');
  }
  function mark() { const opts = list.querySelectorAll('.pal-item'); opts.forEach((li, i) => { li.classList.toggle('active', i === index); li.setAttribute('aria-selected', String(i === index)); }); input.setAttribute('aria-activedescendant', `pal-${index}`); const a = opts[index]; if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' }); }
  function close() { if (current && current.close === close) current = null; overlay.remove(); document.removeEventListener('keydown', onKey, true); if (prev && prev.isConnected && prev.focus) prev.focus({ preventScroll: true }); }
  function run(c) { remember(c.label); close(); setTimeout(() => c.run(), 0); }
  function onKey(e) {
    if (e.key === 'Tab') { e.preventDefault(); input.focus(); } // the dialog is modal: focus stays in the search box
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { index = (index + 1) % items.length; mark(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { index = (index - 1 + items.length) % items.length; mark(); } }
    else if (e.key === 'Enter' && items[index]) { e.preventDefault(); run(items[index]); }
  }
  input.addEventListener('input', () => { index = 0; draw(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  draw(); input.focus();
  current = { close };
  return current;
}
