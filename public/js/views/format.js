// Formatting operations for the editor (fonts, sizes, colours, alignment, spacing, indent, checklists).
// Everything produces the markup the server's sanitiser keeps: <span style="..."> for inline styles,
// style on blocks for alignment / spacing / indent, <sub>/<sup>, and ul[data-type=check].

export const FONTS = ['Arial', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas', 'Courier New', 'Garamond', 'Georgia', 'Helvetica', 'Impact', 'Palatino', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
export const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 24, 30, 36, 48, 60, 72];
export const LINE_SPACINGS = [['1', 'Single'], ['1.15', '1.15'], ['1.5', '1.5'], ['2', 'Double']];
const BLOCK_SELECTOR = 'p, div, h1, h2, h3, li, blockquote, pre';
const NESTED = 'p, div, h1, h2, h3, li, blockquote, pre, ul, ol, table';

export const PALETTE = [
  ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff'],
  ['#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff'],
  ['#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc'],
  ['#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd'],
  ['#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0'],
  ['#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79'],
  ['#5b0f00', '#660000', '#783f04', '#7f6000', '#274e13', '#0c343d', '#1c4587', '#073763', '#20124d', '#4c1130'],
];

export function createFormatter({ editor, onEdit }) {
  let savedRange = null;
  let pendingSize = null; // size chosen with a collapsed caret: applied to the first typed characters

  const inEditor = (n) => n && editor.contains(n);
  const onSel = () => {
    const sel = getSelection();
    if (sel.rangeCount && inEditor(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  };
  document.addEventListener('selectionchange', onSel);
  // Toolbar selects and inputs steal focus: put the caret/selection back before formatting.
  function restore() {
    editor.focus({ preventScroll: true });
    const sel = getSelection();
    if (savedRange && (!sel.rangeCount || !inEditor(sel.anchorNode))) { sel.removeAllRanges(); sel.addRange(savedRange); }
  }
  const css = (fn) => {
    restore();
    document.execCommand('styleWithCSS', false, true); // inline styles for these commands...
    let ok = false;
    try { ok = fn(); } finally { document.execCommand('styleWithCSS', false, false); } // ...but real tags (<b>, <i>) for the rest
    return ok;
  };
  const done = () => { onEdit(); };

  const selectedRange = () => { const s = getSelection(); return s.rangeCount ? s.getRangeAt(0) : null; };
  // innermost block elements touched by the selection
  function selectedBlocks() {
    const r = selectedRange();
    if (!r || !inEditor(r.commonAncestorContainer)) return [];
    const blocks = [...editor.querySelectorAll(BLOCK_SELECTOR)].filter((el) => r.intersectsNode(el) && !el.querySelector(NESTED));
    if (!blocks.length) { // caret directly in the editor root or a text node outside any block
      let n = r.startContainer; while (n && n.parentNode !== editor) n = n.parentNode;
      if (n && n.nodeType === 1) return [n];
    }
    return blocks;
  }
  const unwrap = (el) => { while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el); el.remove(); };
  function stripInline(prop) {
    const r = selectedRange();
    if (!r) return;
    for (const span of [...editor.querySelectorAll('span[style]')]) {
      if (!r.intersectsNode(span)) continue;
      span.style.removeProperty(prop);
      if (!(span.getAttribute('style') || '').trim()) unwrap(span);
    }
  }

  // ---- fonts and sizes ---------------------------------------------------------------------------
  function setFont(name) {
    if (!name) { restore(); stripInline('font-family'); done(); return; }
    css(() => document.execCommand('fontName', false, name)); done();
  }
  function fixSizes(px) {
    for (const el of [...editor.querySelectorAll('font[size="7"], span[style*="xxx-large"]')]) {
      if (el.tagName === 'FONT') { const sp = document.createElement('span'); sp.style.fontSize = `${px}px`; while (el.firstChild) sp.append(el.firstChild); el.replaceWith(sp); } else el.style.fontSize = `${px}px`;
    }
  }
  function setSize(px) {
    css(() => document.execCommand('fontSize', false, '7')); // the browser can only do 7 sizes: apply the largest, then set the real size
    fixSizes(px);
    if (selectedRange() && selectedRange().collapsed) pendingSize = px;
    done();
  }
  function currentSize() {
    const sel = getSelection();
    let n = sel.rangeCount ? sel.anchorNode : null;
    if (n && n.nodeType === 3) n = n.parentElement;
    if (!n || !inEditor(n)) return null;
    return Math.round(parseFloat(getComputedStyle(n).fontSize) * 100) / 100;
  }
  function changeSize(dir) {
    const cur = currentSize() || 16;
    const pt = Math.round(cur * 0.75 * 100) / 100; // sizes are shown in points like every word processor
    const next = dir > 0 ? SIZES.find((s) => s > pt + 0.01) : [...SIZES].reverse().find((s) => s < pt - 0.01);
    if (next) setSize(Math.round(next * 4 / 3 * 100) / 100);
  }
  function currentFont() {
    const sel = getSelection();
    let n = sel.rangeCount ? sel.anchorNode : null;
    if (n && n.nodeType === 3) n = n.parentElement;
    if (!n || !inEditor(n)) return null;
    const first = getComputedStyle(n).fontFamily.split(',')[0].replace(/["']/g, '').trim().toLowerCase();
    return FONTS.find((f) => f.toLowerCase() === first) || null;
  }

  // ---- colours ---------------------------------------------------------------------------------------
  function setColor(kind, color) { // kind: 'text' | 'highlight'
    if (!color) { restore(); stripInline(kind === 'text' ? 'color' : 'background-color'); done(); return; }
    if (kind === 'text') css(() => document.execCommand('foreColor', false, color));
    else css(() => document.execCommand('hiliteColor', false, color) || document.execCommand('backColor', false, color));
    done();
  }

  // ---- alignment, spacing, indent ----------------------------------------------------------------------
  function align(kind) {
    css(() => document.execCommand({ left: 'justifyLeft', center: 'justifyCenter', right: 'justifyRight', justify: 'justifyFull' }[kind]));
    done();
  }
  function lineSpacing(value) {
    restore();
    for (const b of selectedBlocks()) { if (value) b.style.lineHeight = value; else b.style.removeProperty('line-height'); if (!(b.getAttribute('style') || '').trim()) b.removeAttribute('style'); }
    done();
  }
  function indent(delta) {
    restore();
    const blocks = selectedBlocks();
    if (blocks.some((b) => b.tagName === 'LI')) { document.execCommand(delta > 0 ? 'indent' : 'outdent'); done(); return; }
    for (const b of blocks) {
      const cur = parseFloat(b.style.marginLeft) || 0;
      const next = Math.max(0, Math.min(360, cur + delta * 36));
      if (next) b.style.marginLeft = `${next}px`; else b.style.removeProperty('margin-left');
      if (!(b.getAttribute('style') || '').trim()) b.removeAttribute('style');
    }
    done();
  }

  // ---- lists, scripts, clearing ---------------------------------------------------------------------------
  const listAtCaret = () => { const s = getSelection(); let n = s.rangeCount ? s.anchorNode : null; while (n && n !== editor) { if (n.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL')) return n; n = n.parentNode; } return null; };
  function toggleChecklist() {
    restore();
    let list = listAtCaret();
    if (!list) { document.execCommand('insertUnorderedList'); list = listAtCaret(); }
    if (!list) return;
    if (list.tagName === 'OL') { const ul = document.createElement('ul'); while (list.firstChild) ul.append(list.firstChild); list.replaceWith(ul); list = ul; }
    if (list.dataset.type === 'check') { list.removeAttribute('data-type'); list.querySelectorAll('li[data-checked]').forEach((li) => li.removeAttribute('data-checked')); }
    else list.setAttribute('data-type', 'check');
    done();
  }
  // Called for each click inside the editor: a click on the box of a checklist item toggles it.
  function handleChecklistClick(e) {
    const li = e.target.closest && e.target.closest('li');
    if (!li || !inEditor(li) || !li.parentElement || li.parentElement.dataset.type !== 'check') return false;
    const box = li.getBoundingClientRect();
    if (e.clientX - box.left > 28) return false;
    if (li.hasAttribute('data-checked')) li.removeAttribute('data-checked'); else li.setAttribute('data-checked', 'true');
    done();
    return true;
  }
  // After Enter in a checklist the browser copies the previous item's attributes: a new item starts unchecked.
  function afterInput(e) {
    if (pendingSize) { fixSizes(pendingSize); pendingSize = null; }
    if (e && e.inputType === 'insertParagraph') {
      const s = getSelection(); let n = s.rangeCount ? s.anchorNode : null;
      while (n && n !== editor) { if (n.nodeType === 1 && n.tagName === 'LI') { if (n.parentElement && n.parentElement.dataset.type === 'check' && n.hasAttribute('data-checked') && !n.textContent.trim()) n.removeAttribute('data-checked'); break; } n = n.parentNode; }
    }
  }
  function script(kind) { restore(); document.execCommand(kind === 'sub' ? 'subscript' : 'superscript'); done(); }
  function clearFormatting() {
    restore();
    document.execCommand('removeFormat');
    for (const b of selectedBlocks()) { b.removeAttribute('style'); }
    stripInline('font-family'); stripInline('font-size'); stripInline('color'); stripInline('background-color');
    document.execCommand('formatBlock', false, '<p>');
    done();
  }

  const destroy = () => { document.removeEventListener('selectionchange', onSel); savedRange = null; };
  return { destroy, restore, setFont, setSize, changeSize, currentSize, currentFont, setColor, align, lineSpacing, indent, toggleChecklist, handleChecklistClick, afterInput, script, clearFormatting, selectedBlocks, listAtCaret };
}
