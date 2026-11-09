import { h, toast } from '../dom.js';

// Table of contents: headings get stable ids, and a <ul data-type="toc"> holds links to them.
// The server keeps only ids of the form h-xxxxxxxx and same-document links to such ids.
const HEADINGS = 'h1, h2, h3';
const ID_RE = /^h-[a-z0-9]{4,16}$/;
const newId = () => { const b = new Uint8Array(4); crypto.getRandomValues(b); return `h-${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`; };

export function createToc({ editor, getCanEdit, onEdit, exec }) {
  const entries = () => [...editor.querySelectorAll(HEADINGS)].filter((e) => !e.closest('ul[data-type="toc"]') && e.textContent.trim());

  // Give every heading its own id (new, or when copied/duplicated). Returns whether anything changed.
  function ensureIds() {
    const seen = new Set();
    let changed = false;
    for (const el of editor.querySelectorAll(HEADINGS)) {
      if (!ID_RE.test(el.id) || seen.has(el.id)) { el.id = newId(); changed = true; }
      seen.add(el.id);
    }
    return changed;
  }

  function buildItems() {
    ensureIds();
    const list = entries();
    if (!list.length) return [h('li', {}, 'Add headings to your document, then update the table of contents.')];
    return list.map((el) => {
      const level = Number(el.tagName[1]);
      const text = el.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
      return h('li', level > 1 ? { style: `margin-left:${(level - 1) * 24}px` } : {}, h('a', { href: `#${el.id}` }, text));
    });
  }
  const signature = (ul) => ul.innerHTML;

  function insert() {
    if (!getCanEdit()) return;
    const ul = h('ul', { 'data-type': 'toc' }, buildItems());
    exec('insertHTML', `${ul.outerHTML}<p><br></p>`);
  }

  // Refresh every table of contents (skipped while the caret is inside one, so typing there is never disturbed).
  function update({ announce = false } = {}) {
    if (!getCanEdit()) return false;
    const tocs = [...editor.querySelectorAll('ul[data-type="toc"]')];
    const idsChanged = ensureIds();
    let changed = idsChanged;
    const sel = getSelection();
    for (const ul of tocs) {
      if (sel.rangeCount && ul.contains(sel.anchorNode)) continue;
      const fresh = h('ul', {}, buildItems());
      if (signature(ul) !== signature(fresh)) { ul.replaceChildren(...fresh.childNodes); changed = true; }
    }
    if (announce) toast(tocs.length ? 'Table of contents updated' : 'There is no table of contents yet', tocs.length ? 'success' : 'info', 2000);
    return changed;
  }

  function goTo(id) {
    if (!ID_RE.test(id)) return;
    const el = editor.querySelector(`[id="${id}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return { insert, update, ensureIds, goTo, has: () => Boolean(editor.querySelector('ul[data-type="toc"]')) };
}
