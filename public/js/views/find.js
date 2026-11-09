import { h, icon, toast, debounce } from '../dom.js';

// Find and replace for the editor. Matches are computed over the whole text (so a match can span
// bold/italic boundaries) and drawn with the CSS Custom Highlight API where available.
export function createFind({ editor, host, getCanEdit, onEdit }) {
  let ranges = [];
  let current = -1;
  let matchCase = false;
  let wholeWord = false;
  let open = false;

  const findIn = h('input', { type: 'search', placeholder: 'Find', 'aria-label': 'Find in document', autocomplete: 'off', spellcheck: false });
  const replaceIn = h('input', { type: 'text', placeholder: 'Replace with', 'aria-label': 'Replace with', autocomplete: 'off', spellcheck: false });
  const count = h('span', { class: 'find-count muted small', 'aria-live': 'polite' });
  const caseBtn = h('button', { class: 'tb', type: 'button', 'aria-pressed': 'false', title: 'Match case', 'aria-label': 'Match case', onclick: () => { matchCase = !matchCase; caseBtn.classList.toggle('on', matchCase); caseBtn.setAttribute('aria-pressed', String(matchCase)); search(); } }, 'Aa');
  const wordBtn = h('button', { class: 'tb', type: 'button', 'aria-pressed': 'false', title: 'Whole word', 'aria-label': 'Whole word', onclick: () => { wholeWord = !wholeWord; wordBtn.classList.toggle('on', wholeWord); wordBtn.setAttribute('aria-pressed', String(wholeWord)); search(); } }, h('span', { class: 'ww' }, 'ab'));
  const prevBtn = h('button', { class: 'tb', type: 'button', title: 'Previous match (Shift+Enter)', 'aria-label': 'Previous match', onclick: () => step(-1) }, '↑');
  const nextBtn = h('button', { class: 'tb', type: 'button', title: 'Next match (Enter)', 'aria-label': 'Next match', onclick: () => step(1) }, '↓');
  const closeBtn = h('button', { class: 'tb', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close find', onclick: () => api.close() }, icon('close', 16));
  const replaceBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => replaceOne() }, 'Replace');
  const replaceAllBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => replaceAll() }, 'Replace all');
  const replaceToggle = h('button', { class: 'tb', type: 'button', title: 'Show replace', 'aria-label': 'Show replace', onclick: () => { replaceRow.hidden = !replaceRow.hidden; if (!replaceRow.hidden) replaceIn.focus(); } }, 'Replace');
  const replaceRow = h('div', { class: 'find-row' }, replaceIn, replaceBtn, replaceAllBtn);
  const bar = h('div', { class: 'findbar', role: 'search', hidden: true, 'aria-label': 'Find and replace' },
    h('div', { class: 'find-row' }, findIn, count, caseBtn, wordBtn, prevBtn, nextBtn, replaceToggle, closeBtn), replaceRow);
  host.append(bar);

  const hasHighlights = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
  function paint() {
    if (!hasHighlights) return;
    CSS.highlights.delete('find-match'); CSS.highlights.delete('find-current');
    if (!open || !ranges.length) return;
    CSS.highlights.set('find-match', new Highlight(...ranges));
    if (current >= 0) CSS.highlights.set('find-current', new Highlight(ranges[current]));
  }

  function collect(query) {
    const out = [];
    if (!query) return out;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let full = '', lastBlock = null;
    for (let n; (n = walker.nextNode());) {
      const block = n.parentElement && n.parentElement.closest('p, div, h1, h2, h3, li, blockquote, pre, td, th');
      if (lastBlock && block !== lastBlock) full += '\n'; // matches never run from one paragraph into the next
      lastBlock = block;
      nodes.push({ node: n, start: full.length });
      full += n.nodeValue;
    }
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped, `g${matchCase ? '' : 'i'}u`);
    const locate = (pos, end) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const { node, start } = nodes[i];
        if (pos >= start && (pos < start + node.nodeValue.length || (end && pos === start + node.nodeValue.length))) return { node, offset: pos - start };
      }
      return null;
    };
    let m, guard = 0;
    while ((m = re.exec(full)) && guard++ < 5000) {
      if (!m[0].length) { re.lastIndex++; continue; }
      const a = locate(m.index, false), b = locate(m.index + m[0].length, true);
      if (a && b) { const r = document.createRange(); r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); out.push(r); }
    }
    return out;
  }

  function show(scroll) {
    count.textContent = findIn.value ? (ranges.length ? `${current + 1} of ${ranges.length}` : 'No results') : '';
    const none = !ranges.length;
    prevBtn.disabled = nextBtn.disabled = replaceBtn.disabled = replaceAllBtn.disabled = none;
    if (!getCanEdit()) replaceBtn.disabled = replaceAllBtn.disabled = true;
    paint();
    if (scroll && current >= 0) {
      const el = ranges[current].startContainer.parentElement;
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  function search(keepIndex = false) {
    const prev = current;
    ranges = collect(findIn.value);
    current = ranges.length ? (keepIndex && prev >= 0 ? Math.min(prev, ranges.length - 1) : 0) : -1;
    show(!keepIndex);
  }
  function step(dir) {
    if (!ranges.length) return;
    current = (current + dir + ranges.length) % ranges.length;
    show(true);
  }
  function select(range) { const s = getSelection(); s.removeAllRanges(); s.addRange(range); }
  function replaceOne() {
    if (current < 0 || !getCanEdit()) return;
    editor.focus();
    select(ranges[current]);
    document.execCommand('insertText', false, replaceIn.value);
    onEdit();
    search(true);
    findIn.focus();
  }
  function replaceAll() {
    if (!ranges.length || !getCanEdit()) return;
    const total = ranges.length;
    editor.focus();
    for (const r of [...ranges].reverse()) { select(r); document.execCommand('insertText', false, replaceIn.value); } // last to first keeps earlier ranges valid
    onEdit();
    search();
    toast(`Replaced ${total} ${total === 1 ? 'match' : 'matches'}`, 'success', 2200);
  }

  findIn.addEventListener('input', () => search());
  findIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } });
  replaceIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); replaceOne(); } });
  bar.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); api.close(); editor.focus(); } });
  const refresh = debounce(() => { if (open) search(true); }, 250);

  const api = {
    get isOpen() { return open; },
    open(withReplace = false) {
      open = true; bar.hidden = false;
      replaceRow.hidden = !withReplace && !replaceIn.value;
      if (withReplace) replaceRow.hidden = false;
      const sel = getSelection();
      const text = sel && sel.rangeCount && editor.contains(sel.anchorNode) ? sel.toString() : '';
      if (text && text.length < 80 && !/\n/.test(text)) findIn.value = text; // search for the selection, like every editor
      findIn.focus(); findIn.select();
      search();
    },
    close() { open = false; bar.hidden = true; ranges = []; current = -1; paint(); },
    next: () => step(1), prev: () => step(-1),
    refresh, // call after the document changes
    destroy() { open = false; if (hasHighlights) { CSS.highlights.delete('find-match'); CSS.highlights.delete('find-current'); } bar.remove(); },
  };
  return api;
}
