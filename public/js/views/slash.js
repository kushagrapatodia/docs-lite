import { h, icon } from '../dom.js';

// Type "/" at the start of a line (or after a space) to open a block menu, like Notion.
export function createSlashMenu({ editor, getCanEdit, commands }) {
  let menu = null, items = [], index = 0, anchor = null; // anchor: { node, start } of the "/" in its text node
  const RE = /^(\s*)\/([\w]{0,20})$/; // only at the start of a line, so "and / or" and "1 / 2" are never taken over

  function close() { if (menu) { menu.remove(); menu = null; } anchor = null; editor.removeAttribute('aria-controls'); editor.removeAttribute('aria-activedescendant'); editor.removeAttribute('aria-expanded'); }
  function query() {
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed || sel.anchorNode.nodeType !== 3 || !editor.contains(sel.anchorNode)) return null;
    const before = sel.anchorNode.nodeValue.slice(0, sel.anchorOffset);
    const m = RE.exec(before);
    return m ? { node: sel.anchorNode, start: m.index + m[1].length, text: m[2] } : null;
  }
  function filter(text) {
    const q = text.trim().toLowerCase();
    return commands.filter((c) => !q || `${c.label} ${c.keywords || ''}`.toLowerCase().includes(q)).slice(0, 9);
  }
  function show(q) {
    items = filter(q.text);
    if (!items.length && q.text.length > 12) { close(); return; } // a long query that matches nothing: stop interfering
    anchor = q;
    index = Math.max(0, Math.min(index, items.length - 1));
    if (!menu) { menu = h('div', { class: 'slash', id: 'slash-menu', role: 'listbox', 'aria-label': 'Insert block' }); document.body.append(menu); }
    editor.setAttribute('aria-controls', 'slash-menu'); editor.setAttribute('aria-activedescendant', `slash-${index}`); editor.setAttribute('aria-expanded', 'true'); // screen readers hear the highlighted command
    menu.replaceChildren(...items.map((c, i) => h('button', { id: `slash-${i}`, class: `slash-item${i === index ? ' active' : ''}`, type: 'button', role: 'option', 'aria-selected': String(i === index), onmousedown: (e) => { e.preventDefault(); pick(c); } }, h('span', { class: 'slash-ico', 'aria-hidden': 'true' }, c.icon ? icon(c.icon, 18) : null), h('span', { class: 'slash-text' }, h('strong', {}, c.label), h('span', { class: 'muted small' }, c.desc || '')))));
    if (!items.length) menu.append(h('div', { class: 'slash-empty muted small', role: 'status' }, `No blocks match “${q.text}”`));
    const r = document.createRange(); r.setStart(q.node, q.start); r.collapse(true);
    const box = r.getBoundingClientRect();
    const top = box.bottom + 6, left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, box.left));
    menu.style.left = `${left}px`;
    menu.style.top = `${top + menu.offsetHeight > window.innerHeight ? Math.max(8, box.top - menu.offsetHeight - 6) : top}px`;
  }
  function pick(c) {
    const q = anchor || query();
    close();
    if (q) { // remove "/query" before running the command
      const sel = getSelection(); const r = document.createRange();
      r.setStart(q.node, q.start); r.setEnd(q.node, Math.min(q.node.nodeValue.length, q.start + 1 + q.text.length));
      sel.removeAllRanges(); sel.addRange(r); document.execCommand('delete');
    }
    c.run();
  }
  editor.addEventListener('input', () => { if (!getCanEdit()) return; const q = query(); if (q) show(q); else close(); });
  editor.addEventListener('keydown', (e) => {
    if (!menu) return;
    if (!items.length) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } return; } // nothing to pick: typing carries on normally
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); index = (index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; show(anchor); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); pick(items[index]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }, true);
  editor.addEventListener('blur', () => setTimeout(close, 120));
  return { close, get open() { return Boolean(menu); } };
}
