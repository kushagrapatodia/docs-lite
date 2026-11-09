import { h } from '../dom.js';

// Other people's selections and carets, painted with the CSS Custom Highlight API so the editable DOM
// (and therefore the saved HTML, the undo stack and the sanitiser) is never touched.
const SLOTS = 6;
const slotOf = (id) => Math.abs(Number(id) || 0) % SLOTS;

export function createPeers({ editor, send }) {
  const peers = new Map(); // userId -> { name, range, flag, timer }
  const supported = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

  const pathOf = (node) => { const p = []; for (let n = node; n && n !== editor; n = n.parentNode) { if (!n.parentNode) return null; p.unshift([...n.parentNode.childNodes].indexOf(n)); } return p; };
  const resolve = (pos) => { let n = editor; for (const i of pos.path) { n = n.childNodes[i]; if (!n) return null; } const max = n.nodeType === 3 ? n.nodeValue.length : n.childNodes.length; return { node: n, offset: Math.min(pos.offset, max) }; };

  // ---- sending our own selection (throttled) ----
  let last = '', timer = null;
  function sendSelection() {
    timer = null;
    const s = getSelection();
    if (!s.rangeCount || !editor.contains(s.anchorNode) || !editor.contains(s.focusNode)) return;
    const a = pathOf(s.anchorNode), f = pathOf(s.focusNode);
    if (!a || !f) return;
    const msg = { anchor: { path: a, offset: s.anchorOffset }, focus: { path: f, offset: s.focusOffset } };
    const key = JSON.stringify(msg);
    if (key !== last) { last = key; send(msg); }
  }
  const onSelectionChange = () => { if (!timer) timer = setTimeout(sendSelection, 150); };
  document.addEventListener('selectionchange', onSelectionChange);
  const onBlur = () => { last = ''; send({ clear: true }); };
  editor.addEventListener('blur', onBlur);

  // ---- painting theirs ----
  function paint() {
    if (!supported) return;
    for (let i = 0; i < SLOTS; i++) {
      const ranges = [...peers.entries()].filter(([id, p]) => slotOf(id) === i && p.range && !p.range.collapsed).map(([, p]) => p.range);
      if (ranges.length) CSS.highlights.set(`peer-${i}`, new Highlight(...ranges)); else CSS.highlights.delete(`peer-${i}`);
    }
  }
  function placeFlag(id, p) {
    if (!p.range) { if (p.flag) p.flag.hidden = true; return; }
    const rects = p.focusRange.getClientRects();
    const r = rects.length ? rects[rects.length - 1] : p.focusRange.getBoundingClientRect();
    if (!p.flag) { p.flag = h('div', { class: `peer-flag slot-${slotOf(id)}`, 'aria-hidden': 'true' }, p.name); document.body.append(p.flag); }
    p.flag.hidden = false;
    p.flag.style.left = `${r.left}px`; p.flag.style.top = `${r.top - 18}px`;
    p.flag.style.setProperty('--h', `${r.height || 18}px`);
  }
  function remove(id) { const p = peers.get(id); if (!p) return; clearTimeout(p.timer); if (p.flag) p.flag.remove(); peers.delete(id); paint(); }
  function onCursor(d) {
    if (d.clear) { remove(d.user_id); return; }
    const a = resolve(d.anchor), f = resolve(d.focus);
    if (!a || !f) { remove(d.user_id); return; } // the document moved on: drop it rather than show a wrong place
    const range = document.createRange(), focusRange = document.createRange();
    try {
      const forward = a.node === f.node ? a.offset <= f.offset : Boolean(a.node.compareDocumentPosition(f.node) & Node.DOCUMENT_POSITION_FOLLOWING);
      forward ? (range.setStart(a.node, a.offset), range.setEnd(f.node, f.offset)) : (range.setStart(f.node, f.offset), range.setEnd(a.node, a.offset));
      focusRange.setStart(f.node, f.offset); focusRange.collapse(true);
    } catch { remove(d.user_id); return; }
    const prev = peers.get(d.user_id);
    if (prev) clearTimeout(prev.timer);
    const p = { name: d.name || 'Someone', range, focusRange, flag: prev && prev.flag, timer: setTimeout(() => { const q = peers.get(d.user_id); if (q && q.flag) q.flag.classList.add('idle'); }, 4000) };
    if (p.flag) { p.flag.textContent = p.name; p.flag.classList.remove('idle'); }
    peers.set(d.user_id, p);
    placeFlag(d.user_id, p); paint();
  }
  const reflow = () => peers.forEach((p, id) => placeFlag(id, p));
  window.addEventListener('scroll', reflow, true); window.addEventListener('resize', reflow);
  return {
    onCursor, remove, reflow,
    keep(ids) { for (const id of [...peers.keys()]) if (!ids.includes(id)) remove(id); }, // people who left
    clearAll() { for (const id of [...peers.keys()]) remove(id); },
    destroy() { clearTimeout(timer); document.removeEventListener('selectionchange', onSelectionChange); editor.removeEventListener('blur', onBlur); window.removeEventListener('scroll', reflow, true); window.removeEventListener('resize', reflow); for (const id of [...peers.keys()]) remove(id); },
  };
}
