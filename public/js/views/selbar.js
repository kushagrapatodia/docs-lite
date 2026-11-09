import { h, icon } from '../dom.js';

// A small formatting bar that floats above selected text (bold, italic, underline, link, highlight, comment).
export function createSelBar({ editor, getCanEdit, actions }) {
  let bar = null, timer = null;
  const coarse = matchMedia('(pointer: coarse)').matches;

  function hide() { if (bar) { bar.remove(); bar = null; } }
  function build() {
    const btn = (name, label, ic, fn) => h('button', { class: 'tb', type: 'button', title: label, 'aria-label': label, onmousedown: (e) => e.preventDefault(), onclick: () => { fn(); } }, icon(ic, 16));
    return h('div', { class: 'selbar', role: 'toolbar', 'aria-label': 'Selection formatting', onmousedown: (e) => e.preventDefault() },
      btn('bold', 'Bold', 'bold', actions.bold), btn('italic', 'Italic', 'italic', actions.italic), btn('underline', 'Underline', 'underline', actions.underline),
      btn('link', 'Link', 'link', actions.link), btn('highlight', 'Highlight', 'highlight', actions.highlight),
      h('span', { class: 'selbar-sep', 'aria-hidden': 'true' }), btn('comment', 'Comment on selection', 'comment', actions.comment));
  }
  function update() {
    timer = null;
    const s = getSelection();
    if (!getCanEdit() || !s.rangeCount || s.isCollapsed || !editor.contains(s.anchorNode) || !editor.contains(s.focusNode) || !s.toString().trim()) { hide(); return; }
    const rect = s.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) { hide(); return; }
    if (!bar) { bar = build(); document.body.append(bar); }
    const w = bar.offsetWidth, hgt = bar.offsetHeight;
    let top = coarse ? rect.bottom + 12 : rect.top - hgt - 8; // on touch screens the OS handles sit above the selection
    if (top < 60) top = rect.bottom + 8;
    top = Math.min(top, window.innerHeight - hgt - 8);
    bar.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2))}px`;
    bar.style.top = `${top}px`;
  }
  const schedule = () => { if (!timer) timer = setTimeout(update, 120); };
  const onKey = (e) => { if (e.key === 'Escape') hide(); };
  document.addEventListener('selectionchange', schedule);
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  editor.addEventListener('keydown', onKey);
  return { hide, destroy() { clearTimeout(timer); hide(); document.removeEventListener('selectionchange', schedule); window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); editor.removeEventListener('keydown', onKey); } };
}
