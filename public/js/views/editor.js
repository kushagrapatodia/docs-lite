import { h, icon, avatar, toast, openDialog, confirmDialog, promptDialog, timeAgo, fullTime, debounce, pluralize } from '../dom.js';
import { Api, ApiError, filePayload } from '../api.js';
import { cleanPastedHtml, safeUrl } from '../clean.js';
import { openShareDialog } from './share.js';
import { openHistory } from './history.js';
import { openComments } from './comments.js';
import { diffStats, htmlToPlain } from '../diff.js';
import { createFormatter, FONTS, SIZES, LINE_SPACINGS, PALETTE } from './format.js';
import { createFind } from './find.js';
import { openCharMap, openStats, openPageSetup } from './dialogs.js';
import { applyPrintStyles, removePrintStyles, isDefault, paperPixels, MARGINS, DEFAULT_SETTINGS } from '../pagesetup.js';
import { createImages, IMAGE_TYPES } from './images.js';
import { createToc } from './toc.js';
import { createSelBar } from './selbar.js';
import { attachTooltips } from './tooltips.js';
import { openDrawing } from './drawing.js';
import { mergeHtml } from '../merge.js';
import { createPeers } from './peers.js';
import { openPalette } from './palette.js';
import { createSlashMenu } from './slash.js';

const ROLE_TEXT = { owner: 'Owner', editor: 'Can edit', viewer: 'View only' };
const BLOCKS = [['p', 'Normal text'], ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['blockquote', 'Quote'], ['pre', 'Code block']];

// The caret is remembered as (top-level block, characters into that block), so an edit to an EARLIER block by someone
// else does not move it (a global character offset would shift by the length of their change).
function caretOffset(root) {
  const sel = getSelection();
  if (!sel.rangeCount || !root.contains(sel.anchorNode)) return null;
  let blk = sel.getRangeAt(0).endContainer;
  while (blk && blk.parentNode !== root) blk = blk.parentNode;
  if (!blk) return { block: -1, off: 0 };
  const pre = document.createRange();
  pre.selectNodeContents(blk);
  pre.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return { block: [...root.childNodes].indexOf(blk), off: pre.toString().length };
}
function setCaret(root, pos) {
  const sel = getSelection();
  let off = pos.off;
  const target = pos.block >= 0 ? root.childNodes[pos.block] : null;
  if (target) root = target; // continue inside that block (falls back to the whole document when it is gone)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n, count = 0;
  const r = document.createRange();
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    if (count + len >= off) { r.setStart(n, off - count); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); return; }
    count += len;
  }
  r.selectNodeContents(root); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
}

// Unsaved text is stashed locally if a save cannot complete (session expiry, tab closed mid-save),
// and offered back the next time the document is opened.
const draftKey = (id) => `docs-lite:draft:${id}`;
function stashDraft(id, draft) { try { sessionStorage.setItem(draftKey(id), JSON.stringify(draft)); } catch { /* storage unavailable or full */ } }
function readDraft(id) { try { const v = sessionStorage.getItem(draftKey(id)); return v ? JSON.parse(v) : null; } catch { return null; } }
function clearDraft(id) { try { sessionStorage.removeItem(draftKey(id)); } catch { /* ignore */ } }

export async function renderEditor(root, { id, user, navigate, isCurrent = () => true }) {
  let doc;
  try { doc = await Api.get(id); } catch (e) {
    if (!isCurrent()) return () => {};
    root.replaceChildren(h('main', { class: 'empty', style: 'margin:12vh auto;max-width:440px' }, icon('file', 40),
      h('h2', {}, e.status === 404 ? 'Document not found' : 'Could not open this document'),
      h('p', { class: 'muted' }, e.status === 404 ? 'It may have been deleted, or it has not been shared with you. Ask the owner for access.' : e.message),
      h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('#/') }, 'Back to documents')));
    document.title = 'Not found - Docs Lite';
    return () => {};
  }
  if (!isCurrent()) return () => {}; // the user already went somewhere else while this document was loading

  const state = { doc, role: doc.role, version: doc.version, base: doc.content, dirty: false, saving: false, again: false, conflict: null, preview: null, lastSaved: null, presence: [], online: true, live: false };
  let retryTimer = null;
  let evt = null;
  let sseRetries = 0, sseTimer = null;
  let disposed = false;

  // ---- elements --------------------------------------------------------------------
  const title = h('input', { class: 'doc-title', 'aria-label': 'Document title', maxLength: 200, value: doc.title, spellcheck: false });
  const status = h('span', { class: 'save-status', 'aria-live': 'polite' });
  const liveDot = h('span', { class: 'live-dot', title: 'Live updates' });
  const presenceEl = h('div', { class: 'presence', 'aria-label': 'People viewing this document' });
  const roleBadge = h('span', { class: 'role-pill' });
  const banners = h('div', { class: 'banners' });
  const wordsEl = h('span', { class: 'muted' });
  // ---- page setup: paper size, margins, header / footer (shown on paper, printed via @page) -------------------
  state.settings = doc.settings || { ...DEFAULT_SETTINGS };
  const paperHeader = h('div', { class: 'paper-hf paper-header', 'aria-hidden': 'true' });
  const paperFooter = h('div', { class: 'paper-hf paper-footer', 'aria-hidden': 'true' });
  function applySettings(s) {
    state.settings = s;
    if (typeof paper === 'undefined' || !paper) return;
    const custom = !isDefault(s);
    const px = paperPixels(s), m = MARGINS[s.margins] || MARGINS.normal;
    paper.style.maxWidth = custom ? `${px.w}px` : '';
    paper.style.setProperty('--pad-y', custom ? `${m.tb}px` : '');
    paper.style.setProperty('--pad-x', custom ? `${m.lr}px` : '');
    paperHeader.textContent = s.header; paperHeader.hidden = !s.header;
    paperFooter.replaceChildren(h('span', {}, s.footer), s.pageNumbers && h('span', {}, 'Page 1')); paperFooter.hidden = !s.footer && !s.pageNumbers;
    applyPrintStyles(s);
  }
  function showPageSetup() {
    openPageSetup({ settings: state.settings, canEdit: canEdit(), onSave: async (next) => { applySettings(await Api.saveSettings(state.doc.id, next)); } });
  }
  let zoom = 100;
  try { zoom = Number(localStorage.getItem('docs-lite:zoom')) || 100; } catch { /* storage unavailable */ }
  if (![50, 75, 90, 100, 110, 125, 150, 175, 200].includes(zoom)) zoom = 100;
  const zoomSel = h('select', { class: 'zoom-select', 'aria-label': 'Zoom', title: 'Zoom', onchange: (e) => { setZoom(Number(e.target.value)); } },
    [50, 75, 90, 100, 110, 125, 150, 175, 200].map((z) => h('option', { value: String(z), selected: z === zoom }, `${z}%`)));
  const outline = h('nav', { class: 'outline', 'aria-label': 'Document outline', hidden: true });
  let outlineOn = false;
  try { outlineOn = localStorage.getItem('docs-lite:outline') === '1'; } catch { /* storage unavailable */ }
  const editor = h('div', { id: 'document', class: 'page prose', contentEditable: 'true', spellcheck: true, role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Document body' });
  const printTitle = h('h1', { class: 'print-title' });

  const shareBtn = h('button', { class: 'btn', type: 'button', 'aria-label': 'Share', onclick: () => openShareDialog({ doc: state.doc, flush, onChange: (shares) => { state.doc.shares = shares; } }) }, icon('share'), h('span', { class: 'label' }, 'Share'));
  const commentBadge = h('span', { class: 'badge-count', hidden: true });
  const commentsBtn = h('button', { class: 'btn', type: 'button', 'aria-label': 'Comments', onclick: () => toggleComments() }, icon('comment'), h('span', { class: 'label' }, 'Comments'), commentBadge);
  const historyBtn = h('button', { class: 'btn', type: 'button', 'aria-label': 'Version history', onclick: () => openHistoryPanel() }, icon('history'), h('span', { class: 'label' }, 'History'));
  const exportMenu = h('div', { class: 'menu', hidden: true, role: 'menu' }, [
    ['docx', 'Word document (.docx)'], ['md', 'Markdown (.md)'], ['html', 'Web page (.html)'], ['txt', 'Plain text (.txt)'],
  ].map(([f, label]) => h('a', { role: 'menuitem', href: Api.exportUrl(state.doc.id, f), download: '', onclick: async () => { closeMenus(); await flush(); } }, icon('download'), label)),
  h('button', { role: 'menuitem', type: 'button', onclick: async () => { closeMenus(); await flush(); printTitle.textContent = title.value; window.print(); } }, icon('print'), 'Print / save as PDF'));
  const exportBtn = h('div', { class: 'menu-host' }, h('button', { class: 'btn', type: 'button', 'aria-label': 'Export', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); const s = exportMenu.hidden; closeMenus(); exportMenu.hidden = !s; } }, icon('download'), h('span', { class: 'label' }, 'Export')), exportMenu);
  const insertFileInput = h('input', { type: 'file', accept: '.txt,.md,.markdown,.docx', hidden: true, 'aria-label': 'Choose a file to insert', onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) insertFile(f); } });
  const moreMenu = h('div', { class: 'menu right', hidden: true, role: 'menu' },
    h('button', { role: 'menuitem', type: 'button', onclick: async () => { closeMenus(); await flush(); try { const c = await Api.duplicate(state.doc.id); toast('Copy created', 'success'); navigate(`#/doc/${c.id}`); } catch (e) { toast(e.message, 'error'); } } }, icon('copy'), 'Make a copy'),
    h('button', { class: 'edit-only', role: 'menuitem', type: 'button', onclick: () => { closeMenus(); insertFileInput.click(); } }, icon('upload'), 'Insert content from file…'),
    h('button', { role: 'menuitem', type: 'button', onclick: () => { closeMenus(); if (find) find.open(false); } }, icon('find'), 'Find and replace'),
    h('button', { class: 'phone-only', role: 'menuitem', type: 'button', onclick: () => { closeMenus(); openHistoryPanel(); } }, icon('history'), 'Version history'),
    h('a', { class: 'phone-only', role: 'menuitem', href: Api.exportUrl(state.doc.id, 'docx'), download: '', onclick: async () => { closeMenus(); await flush(); } }, icon('download'), 'Download as Word'),
    h('button', { role: 'menuitem', type: 'button', onclick: () => { closeMenus(); showStats(); } }, icon('stats'), 'Word count'),
    h('button', { role: 'menuitem', type: 'button', onclick: () => { closeMenus(); showPageSetup(); } }, icon('file'), 'Page setup…'),
    h('button', { role: 'menuitem', type: 'button', class: 'edit-only', onclick: () => { closeMenus(); toc.insert(); } }, icon('outline'), 'Insert table of contents'),
    h('button', { role: 'menuitem', type: 'button', class: 'edit-only', onclick: () => { closeMenus(); if (toc.update({ announce: true })) onEdit(); } }, icon('outline'), 'Update table of contents'),
    h('button', { role: 'menuitem', type: 'button', onclick: () => { closeMenus(); openPalette(paletteCommands()); } }, icon('keyboard'), 'Command palette  (Ctrl+Shift+P)'),
    h('button', { role: 'menuitem', type: 'button', onclick: () => { closeMenus(); showShortcuts(); } }, icon('keyboard'), 'Keyboard shortcuts'),
    h('button', { class: 'danger owner-only', role: 'menuitem', type: 'button', onclick: async () => { closeMenus(); await deleteDoc(); } }, icon('trash'), 'Move to Trash'));
  const moreBtn = h('div', { class: 'menu-host' }, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'More actions', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); const s = moreMenu.hidden; closeMenus(); moreMenu.hidden = !s; } }, icon('more')), moreMenu);

  // toolbar
  const cmdBtns = {};
  const fmt = createFormatter({ editor, onEdit });
  const tbtn = (name, ic, label, run) => { const b = h('button', { class: 'tb', type: 'button', 'aria-label': label, title: label, onclick: run }, typeof ic === 'string' ? icon(ic) : ic); cmdBtns[name] = b; return b; };
  const keepBtn = (name, ic, label, run) => { const b = tbtn(name, ic, label, run); b.classList.add('keep-enabled'); return b; };
  const exec = (cmd, val) => { fmt.restore(); document.execCommand('styleWithCSS', false, false); document.execCommand(cmd, false, val); onEdit(); refreshToolbar(); };
  const sep = () => h('span', { class: 'sep' });
  const blockSel = h('select', { class: 'tb-select', 'aria-label': 'Text style', title: 'Text style', onchange: (e) => { applyBlock(e.target.value); } }, BLOCKS.map(([v, l]) => h('option', { value: v }, l)));
  function applyBlock(tag) {
    fmt.restore();
    const cur = currentBlock();
    document.execCommand('formatBlock', false, `<${cur === tag && tag !== 'p' ? 'p' : tag}>`); // <tag> form works in Chrome, Safari and Firefox
    onEdit(); refreshToolbar();
  }
  function currentBlock() {
    const sel = getSelection();
    if (!sel.rangeCount) return 'p';
    let n = sel.anchorNode;
    while (n && n !== editor) { if (n.nodeType === 1 && /^(H1|H2|H3|BLOCKQUOTE|PRE)$/.test(n.tagName)) return n.tagName.toLowerCase(); n = n.parentNode; }
    return 'p';
  }
  // font family and size
  const fontSel = h('select', { class: 'tb-select font-select', 'aria-label': 'Font', title: 'Font', onchange: (e) => { fmt.setFont(e.target.value || null); refreshToolbar(); } },
    h('option', { value: '' }, 'Default'), FONTS.map((f) => { const o = h('option', { value: f }, f); o.style.fontFamily = `'${f}'`; return o; }));
  const sizeListId = `sizes-${Math.random().toString(36).slice(2)}`;
  const sizeIn = h('input', { class: 'size-input', type: 'text', inputMode: 'numeric', autocomplete: 'off', list: sizeListId, 'aria-label': 'Font size in points', title: 'Font size (pt)', value: '12' });
  const applySizeInput = () => { const pt = parseFloat(sizeIn.value); if (pt >= 4 && pt <= 150) fmt.setSize(Math.round(pt * 4 / 3 * 100) / 100); refreshToolbar(); };
  sizeIn.addEventListener('change', applySizeInput);
  sizeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applySizeInput(); editor.focus(); } });
  const sizeGroup = h('span', { class: 'size-group' }, tbtn('sizeDown', 'minus', 'Decrease font size', () => { fmt.changeSize(-1); refreshToolbar(); }), sizeIn, h('datalist', { id: sizeListId }, SIZES.map((n) => h('option', { value: String(n) }))), tbtn('sizeUp', 'plus', 'Increase font size', () => { fmt.changeSize(1); refreshToolbar(); }));
  // colour palettes
  const lastColor = { text: '#d93025', highlight: '#ffff00' };
  function colorMenu(kind, label, ic) {
    const bar = h('span', { class: 'color-bar' }); bar.style.background = lastColor[kind];
    const menu = h('div', { class: 'menu palette', hidden: true, role: 'menu', 'aria-label': label });
    const pick = (c) => { menu.hidden = true; if (c) { lastColor[kind] = c; bar.style.background = c; } fmt.setColor(kind, c); refreshToolbar(); };
    for (const row of PALETTE) menu.append(h('div', { class: 'prow' }, row.map((c) => { const b = h('button', { class: 'swatch', type: 'button', role: 'menuitem', title: c, 'aria-label': `${label} ${c}`, onclick: () => pick(c) }); b.style.background = c; return b; })));
    const custom = h('input', { type: 'color', value: lastColor[kind], 'aria-label': `Custom ${label.toLowerCase()}`, onchange: (e) => pick(e.target.value) });
    menu.append(h('div', { class: 'palette-actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => pick(null) }, 'Reset'), h('label', { class: 'check' }, 'Custom', custom)));
    const btn = h('button', { class: 'tb color-btn', type: 'button', 'aria-label': label, title: label, 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); const s = menu.hidden; closeMenus(); menu.hidden = !s; } }, icon(ic), bar);
    cmdBtns[`color-${kind}`] = btn;
    return h('span', { class: 'menu-host' }, btn, menu);
  }
  const spacingSel = h('select', { class: 'tb-select spacing-select', 'aria-label': 'Line spacing', title: 'Line spacing', onchange: (e) => { const v = e.target.value; e.target.value = ''; fmt.lineSpacing(v === 'default' ? null : v); } },
    h('option', { value: '', disabled: true, selected: true }, 'Spacing'), LINE_SPACINGS.map(([v, l]) => h('option', { value: v }, l)), h('option', { value: 'default' }, 'Default'));
  let find = null;
  let editorCol = null;
  let paper = null;
  const toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Formatting' },
    tbtn('undo', 'undo', 'Undo (Ctrl+Z)', () => exec('undo')), tbtn('redo', 'redo', 'Redo (Ctrl+Shift+Z)', () => exec('redo')),
    sep(), blockSel, fontSel, sizeGroup, sep(),
    tbtn('bold', 'bold', 'Bold (Ctrl+B)', () => exec('bold')), tbtn('italic', 'italic', 'Italic (Ctrl+I)', () => exec('italic')),
    tbtn('underline', 'underline', 'Underline (Ctrl+U)', () => exec('underline')), tbtn('strikeThrough', 'strike', 'Strikethrough (Ctrl+Shift+X)', () => exec('strikeThrough')),
    colorMenu('text', 'Text colour', 'textcolor'), colorMenu('highlight', 'Highlight colour', 'highlight'),
    tbtn('subscript', 'sub', 'Subscript (Ctrl+,)', () => { fmt.script('sub'); refreshToolbar(); }), tbtn('superscript', 'sup', 'Superscript (Ctrl+.)', () => { fmt.script('sup'); refreshToolbar(); }),
    sep(),
    tbtn('justifyLeft', 'alignLeft', 'Align left (Ctrl+Shift+L)', () => { fmt.align('left'); refreshToolbar(); }), tbtn('justifyCenter', 'alignCenter', 'Align centre (Ctrl+Shift+E)', () => { fmt.align('center'); refreshToolbar(); }),
    tbtn('justifyRight', 'alignRight', 'Align right (Ctrl+Shift+R)', () => { fmt.align('right'); refreshToolbar(); }), tbtn('justifyFull', 'alignJustify', 'Justify (Ctrl+Shift+J)', () => { fmt.align('justify'); refreshToolbar(); }),
    spacingSel, sep(),
    tbtn('insertUnorderedList', 'ul', 'Bulleted list (Ctrl+Shift+8)', () => exec('insertUnorderedList')), tbtn('insertOrderedList', 'ol', 'Numbered list (Ctrl+Shift+7)', () => exec('insertOrderedList')),
    tbtn('checklist', 'checklist', 'Checklist (Ctrl+Shift+9)', () => { fmt.toggleChecklist(); refreshToolbar(); }),
    tbtn('outdent', 'outdent', 'Decrease indent', () => { fmt.indent(-1); refreshToolbar(); }), tbtn('indent', 'indent', 'Increase indent (Ctrl+])', () => { fmt.indent(1); refreshToolbar(); }),
    sep(),
    tbtn('link', 'link', 'Insert link (Ctrl+K)', () => insertLink()), tbtn('hr', 'hr', 'Horizontal rule', () => exec('insertHorizontalRule')), tbtn('table', 'table', 'Insert table', () => insertTable()), tbtn('pagebreak', 'pagebreak', 'Insert page break (Ctrl+Enter)', () => { fmt.restore(); exec('insertHTML', '<hr data-type="page">'); }), tbtn('image', 'image', 'Insert picture', () => { fmt.restore(); imageInput.click(); }),
    tbtn('special', 'omega', 'Insert special character or emoji', () => insertSpecial()),
    sep(), tbtn('clear', 'clear', 'Clear formatting (Ctrl+\\)', () => { fmt.clearFormatting(); refreshToolbar(); }),
    h('span', { class: 'spacer' }),
    keepBtn('find', 'find', 'Find and replace (Ctrl+F)', () => find && find.open(false)),
    keepBtn('commentSel', 'comment', 'Comment on selection', () => commentOnSelection()),
    keepBtn('outline', 'outline', 'Toggle document outline', () => toggleOutline()));
  cmdBtns.commentSel.title = 'Comment on the selected text (Ctrl+Alt+M)';
  cmdBtns.commentSel.setAttribute('aria-label', 'Comment on selection');
  cmdBtns.outline.setAttribute('aria-pressed', 'false');
  function insertSpecial() { fmt.restore(); const d = openCharMap((c) => { fmt.restore(); document.execCommand('insertText', false, c); onEdit(); }); return d; }
  function showStats() { const sel = getSelection(); openStats({ text: editor.innerText, selectionText: sel && sel.rangeCount && editor.contains(sel.anchorNode) ? sel.toString() : '' }); }
  // ---- tables -----------------------------------------------------------------------------------
  const cellAtCaret = () => { const sel = getSelection(); let n = sel.rangeCount ? sel.anchorNode : null; while (n && n !== editor) { if (n.nodeType === 1 && /^(TD|TH)$/.test(n.tagName)) return n; n = n.parentNode; } return null; };
  const tbar = (label, ic, fn) => h('button', { class: 'btn sm', type: 'button', onclick: () => { const c = cellAtCaret(); if (c) { fn(c); onEdit(); refreshToolbar(); } } }, icon(ic, 14), label);
  const putCaret = (cell) => { if (!cell) return; const r = document.createRange(); r.selectNodeContents(cell); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
  const newCell = (tag) => { const c = document.createElement(tag); c.innerHTML = '<br>'; return c; };
  const rowsOf = (table) => [...table.querySelectorAll('tr')].filter((r) => r.closest('table') === table);
  async function insertTable() {
    const sel0 = getSelection(); const saved = sel0.rangeCount && editor.contains(sel0.anchorNode) ? sel0.getRangeAt(0).cloneRange() : null;
    const ans = await promptDialog({ title: 'Insert table', label: 'Size (columns x rows, up to 10 x 30)', value: '3 x 3', confirmLabel: 'Insert', maxLength: 12 });
    if (!ans) return;
    const mm = /^\s*(\d{1,2})\s*[x×,*]\s*(\d{1,2})\s*$/i.exec(ans);
    const cols = mm ? Math.min(10, Math.max(1, +mm[1])) : 3, rows = mm ? Math.min(30, Math.max(1, +mm[2])) : 3;
    editor.focus();
    if (saved) { const s = getSelection(); s.removeAllRanges(); s.addRange(saved); }
    const row = (tag) => `<tr>${`<${tag}><br></${tag}>`.repeat(cols)}</tr>`;
    exec('insertHTML', `<table><thead>${row('th')}</thead><tbody>${row('td').repeat(Math.max(1, rows - 1))}</tbody></table><p><br></p>`);
    const first = editor.querySelector('table th'); putCaret(first);
  }
  const imageInput = h('input', { type: 'file', accept: IMAGE_TYPES.join(','), hidden: true, 'aria-label': 'Choose a picture', onchange: () => { const f = imageInput.files[0]; imageInput.value = ''; if (f) images.insert(f); } });
  const imageBar = h('div', { class: 'tablebar', hidden: true, role: 'toolbar', 'aria-label': 'Picture tools' });
  const images = createImages({ editor, getCanEdit: () => canEdit(), onEdit: () => onEdit(), restore: () => fmt.restore(), bar: imageBar });
  const peers = createPeers({ editor, send: (m) => { if (state.live && state.presence.length > 1) Api.cursor(state.doc.id, m); } });
  const selbar = createSelBar({ editor, getCanEdit: () => canEdit(), actions: { bold: () => exec('bold'), italic: () => exec('italic'), underline: () => exec('underline'), link: () => insertLink(), highlight: () => { fmt.setColor('highlight', '#ffff00'); refreshToolbar(); }, comment: () => commentOnSelection() } });
  const toc = createToc({ editor, getCanEdit: () => canEdit(), onEdit: () => onEdit(), exec: (c, v) => exec(c, v) });
  const tableBar = h('div', { class: 'tablebar', hidden: true, role: 'toolbar', 'aria-label': 'Table tools' },
    h('span', { class: 'muted small' }, 'Table'),
    tbar('Row above', 'plus', (c) => { const tr = c.parentElement; const n = document.createElement('tr'); for (let i = 0; i < tr.cells.length; i++) n.append(newCell('td')); (tr.parentElement.tagName === 'THEAD' ? tr.closest('table').tBodies[0] || tr.closest('table').appendChild(document.createElement('tbody')) : tr.parentElement)[tr.parentElement.tagName === 'THEAD' ? 'prepend' : 'insertBefore'](...(tr.parentElement.tagName === 'THEAD' ? [n] : [n, tr])); putCaret(n.cells[0]); }),
    tbar('Row below', 'plus', (c) => { const tr = c.parentElement; const n = document.createElement('tr'); for (let i = 0; i < tr.cells.length; i++) n.append(newCell('td')); if (tr.parentElement.tagName === 'THEAD') { const t = tr.closest('table'); (t.tBodies[0] || t.appendChild(document.createElement('tbody'))).prepend(n); } else tr.after(n); putCaret(n.cells[0]); }),
    tbar('Column left', 'plus', (c) => { const i = c.cellIndex; for (const tr of rowsOf(c.closest('table'))) { const ref = tr.cells[i]; const n = newCell(ref ? ref.tagName.toLowerCase() : 'td'); ref ? ref.before(n) : tr.append(n); } putCaret(c.previousElementSibling); }),
    tbar('Column right', 'plus', (c) => { const i = c.cellIndex; for (const tr of rowsOf(c.closest('table'))) { const ref = tr.cells[i]; const n = newCell(ref ? ref.tagName.toLowerCase() : 'td'); ref ? ref.after(n) : tr.append(n); } putCaret(c.nextElementSibling); }),
    tbar('Delete row', 'trash', (c) => { const t = c.closest('table'), tr = c.parentElement, next = tr.nextElementSibling || tr.previousElementSibling; tr.remove(); if (!t.querySelector('tr')) { t.remove(); } else putCaret(next && next.cells[0]); }),
    tbar('Delete column', 'trash', (c) => { const t = c.closest('table'), i = c.cellIndex; for (const tr of rowsOf(t)) if (tr.cells[i]) tr.cells[i].remove(); if (![...t.querySelectorAll('td,th')].length) t.remove(); else putCaret(c.isConnected ? c : (rowsOf(t)[0].cells[Math.max(0, i - 1)])); }),
    tbar('Delete table', 'trash', (c) => { c.closest('table').remove(); editor.focus(); }));
  function refreshToolbar() {
    if (!canEdit()) return;
    for (const c of ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList', 'subscript', 'superscript', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull']) {
      let on = false; try { on = document.queryCommandState(c); } catch { /* unsupported */ }
      if (c === 'justifyLeft') on = on && !['justifyCenter', 'justifyRight', 'justifyFull'].some((k) => { try { return document.queryCommandState(k); } catch { return false; } });
      cmdBtns[c].classList.toggle('on', on); cmdBtns[c].setAttribute('aria-pressed', String(on));
    }
    const list = fmt.listAtCaret();
    const isCheck = Boolean(list && list.dataset.type === 'check');
    cmdBtns.checklist.classList.toggle('on', isCheck); cmdBtns.checklist.setAttribute('aria-pressed', String(isCheck));
    blockSel.value = currentBlock();
    fontSel.value = fmt.currentFont() || '';
    if (document.activeElement !== sizeIn) { const px = fmt.currentSize(); if (px) sizeIn.value = String(Math.round(px * 0.75 * 10) / 10).replace(/\.0$/, ''); }
    tableBar.hidden = !cellAtCaret();
  }
  document.addEventListener('selectionchange', refreshToolbar);

  // ---- state helpers --------------------------------------------------------------------
  const canEdit = () => (state.role === 'owner' || state.role === 'editor') && !state.preview;
  const closeMenus = () => root.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
  const onDocClick = (e) => { if (!e.target.closest('.menu-host')) closeMenus(); };
  document.addEventListener('click', onDocClick);

  function renderChrome() {
    const edit = canEdit();
    editor.contentEditable = String(edit);
    title.readOnly = !edit;
    toolbar.querySelectorAll('button:not(.keep-enabled), select, input').forEach((b) => { b.disabled = !edit; });
    toolbar.classList.toggle('disabled', !edit);
    if (!edit) { tableBar.hidden = true; imageBar.hidden = true; }
    roleBadge.className = `role-pill ${state.role}`;
    roleBadge.replaceChildren(icon(state.role === 'viewer' ? 'eye' : state.role === 'owner' ? 'lock' : 'users', 13), ROLE_TEXT[state.role]);
    shareBtn.hidden = state.role !== 'owner';
    moreMenu.querySelector('.owner-only').hidden = state.role !== 'owner';
    moreMenu.querySelectorAll('.edit-only').forEach((b) => { b.hidden = !edit; });
    if (state.role === 'viewer' && !state.preview) banner('viewer', h('div', { class: 'banner info' }, icon('eye'), h('span', {}, `You have view-only access. ${state.doc.owner_name} owns this document.`), h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { const c = await Api.duplicate(state.doc.id); toast('Copy created: you can edit it freely', 'success'); navigate(`#/doc/${c.id}`); } catch (e) { toast(e.message, 'error'); } } }, icon('copy', 14), 'Make an editable copy')));
    else banner('viewer', null);
    renderPresence();
    renderStatus();
  }
  const bannerEls = {};
  function banner(key, el) {
    if (bannerEls[key]) { bannerEls[key].remove(); delete bannerEls[key]; }
    if (el) { bannerEls[key] = el; banners.append(el); }
  }

  function renderStatus() {
    liveDot.className = `live-dot ${state.live ? 'on' : ''}`;
    liveDot.title = state.live ? 'Live: changes from others appear automatically' : 'Reconnecting to live updates…';
    let text;
    if (!state.online) text = 'Offline';
    else if (state.conflict) text = 'Needs attention';
    else if (state.saving) text = 'Saving…';
    else if (state.dirty) text = 'Unsaved changes';
    else if (state.lastSaved) text = `Saved ${timeAgo(state.lastSaved)}`;
    else text = canEdit() ? 'All changes saved' : '';
    status.textContent = text;
    document.title = `${state.dirty || state.saving ? '\u25cf ' : ''}${state.doc.title} \u00b7 Docs Lite`;
    status.className = `save-status ${state.conflict || !state.online ? 'warn' : ''}`;
    status.title = state.doc.updated_at ? `Last edited ${fullTime(state.doc.updated_at)}` : '';
  }
  const renderWordsSoon = debounce(() => renderWords(), 250);
  function renderWords() {
    const t = editor.innerText.trim();
    const n = t ? t.split(/\s+/).length : 0;
    wordsEl.textContent = `${pluralize(n, 'word')} · ${pluralize(t.length, 'character')}`;
  }
  function renderPresence() {
    const others = state.presence.filter((p) => p.id !== user.id);
    presenceEl.replaceChildren(...others.slice(0, 4).map((p) => avatar(p.name, 'sm ring')), others.length > 4 && h('span', { class: 'more-count' }, `+${others.length - 4}`));
    presenceEl.hidden = !others.length;
    presenceEl.title = others.length ? `Also here: ${others.map((o) => o.name).join(', ')}` : '';
    presenceEl.setAttribute('aria-label', others.length ? `Also viewing: ${others.map((o) => o.name).join(', ')}` : 'Nobody else is here');
  }

  function renderOutline() {
    outline.hidden = !outlineOn;
    cmdBtns.outline.classList.toggle('on', outlineOn); cmdBtns.outline.setAttribute('aria-pressed', String(outlineOn));
    if (!outlineOn) return;
    const heads = [...editor.querySelectorAll('h1, h2, h3')];
    queueMicrotask(spyOutline);
    outline.replaceChildren(h('h2', {}, 'Outline'), heads.length
      ? h('ul', {}, heads.map((el) => h('li', { class: `lvl${el.tagName[1]}` }, h('button', { type: 'button', onclick: () => { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, el.textContent.trim() || '(empty heading)'))))
      : h('p', { class: 'muted small' }, 'Add headings (Heading 1 to 3) and they will appear here.'));
  }
  const renderOutlineSoon = debounce(renderOutline, 300);
  // The outline highlights the section you are reading (scroll-spy)
  function spyOutline() {
    if (!outlineOn || outline.hidden) return;
    const wrap = editor.closest('.paper-wrap');
    if (!wrap) return;
    const top = wrap.getBoundingClientRect().top + 24;
    const heads = [...editor.querySelectorAll('h1, h2, h3')];
    let cur = -1;
    heads.forEach((el, i) => { if (el.getBoundingClientRect().top <= top) cur = i; });
    const rows = outline.querySelectorAll('li');
    rows.forEach((li, i) => { li.classList.toggle('current', i === cur); const b = li.firstElementChild; if (b) { if (i === cur) b.setAttribute('aria-current', 'location'); else b.removeAttribute('aria-current'); } });
  }
  function toggleOutline() { outlineOn = !outlineOn; try { localStorage.setItem('docs-lite:outline', outlineOn ? '1' : '0'); } catch { /* ignore */ } renderOutline(); }

  function setContent(html) {
    editor.innerHTML = html && html.trim() ? html : '<p><br></p>';
    renderWords(); renderOutline();
  }
  function applyDoc(d, { keepCaret = false } = {}) {
    if (typeof peers !== 'undefined') peers.clearAll();
    const off = keepCaret ? caretOffset(editor) : null;
    state.doc = { ...state.doc, ...d };
    state.version = d.version;
    state.base = d.content; // what the server holds, for merging
    if (d.role) state.role = d.role;
    title.value = d.title;
    setContent(d.content);
    document.title = `${d.title} · Docs Lite`;
    if (off !== null && document.activeElement === editor) setCaret(editor, off);
    renderChrome();
    if (find && find.isOpen) find.refresh(); // matches pointed at text that was just replaced
  }

  // ---- saving ---------------------------------------------------------------------------
  function onEdit() {
    if (!canEdit()) return;
    state.dirty = true;
    renderStatus(); renderWordsSoon(); renderOutlineSoon();
    scheduleSave();
  }
  const scheduleSave = debounce(() => save(), 700);
  const stash = () => { if (canEdit() && (state.dirty || state.saving)) stashDraft(state.doc.id, { title: title.value, html: editor.innerHTML, base: state.version, at: Date.now() }); };
  async function save() {
    if (!canEdit() || !state.dirty || state.conflict) return;
    if (disposed && !state.dirty) return;
    if (state.saving) { state.again = true; return; }
    clearTimeout(retryTimer);
    const name = title.value.trim() || state.doc.title;
    if (!title.value.trim()) title.value = name;
    toc.update(); // keeps heading ids and any table of contents current
    const content = editor.innerText.trim() === '' && !editor.querySelector('hr,a,img,table') ? '<p><br></p>' : editor.innerHTML;
    state.saving = true; state.dirty = false; renderStatus();
    try {
      const r = await Api.save(state.doc.id, { title: name, content, base_version: state.version });
      if (r.version > state.version) state.version = r.version; // a merge may already have moved us to a newer version
      state.base = r.content ?? content; // the server only returns content when sanitising changed it
      state.doc.title = name; state.doc.updated_at = r.updated_at;
      state.lastSaved = new Date().toISOString().replace('T', ' ').slice(0, 19);
      state.online = true;
      clearDraft(state.doc.id);
      document.title = `${name} · Docs Lite`;
    } catch (e) {
      state.dirty = true; stash();
      if (e.status === 409 && e.data.conflict) showConflict(e.data.conflict);
      else if (e.status === 0) { state.online = false; if (!disposed) retryTimer = setTimeout(save, 4000); }
      else if (e.status === 403 || e.status === 404) { toast(e.message, 'error', 6000); if (e.status === 404) navigate('#/'); else { state.role = 'viewer'; renderChrome(); } }
      else if (e.status === 401) { stash(); } // signed out: the draft is kept, and no retry may run as whoever signs in next
      else if (!disposed) { toast(e.message, 'error', 6000); retryTimer = setTimeout(save, 6000); }
    } finally {
      state.saving = false;
      renderStatus();
      if (state.again) { state.again = false; save(); }
    }
  }
  async function flush() {
    scheduleSave.cancel();
    for (let i = 0; i < 3 && (state.dirty || state.saving); i++) {
      await save();
      for (let w = 0; state.saving && w < 200; w++) await new Promise((r) => setTimeout(r, 50)); // wait at most about 10 s
    }
  }

  // ---- conflicts and remote changes ------------------------------------------------------
  // Two people changed the document: if they changed different blocks, merge both edits without asking.
  function tryAutoMerge(remote) {
    if (state.base == null || state.preview) return false;
    const titleMine = title.value.trim() || state.doc.title;
    if (titleMine !== state.doc.title && remote.title !== state.doc.title && titleMine !== remote.title) return false;
    let merged;
    try { merged = mergeHtml(state.base, editor.innerHTML, remote.content); } catch { return false; }
    if (merged === null) return false;
    const who = remote.updated_by_id === user.id ? 'your other window' : (remote.updated_by_name || 'someone');
    applyDoc({ title: titleMine !== state.doc.title ? titleMine : remote.title, content: merged, version: remote.version, updated_at: remote.updated_at }, { keepCaret: true });
    state.base = remote.content;
    state.conflict = null; banner('conflict', null); // a merge supersedes any conflict banner that was showing
    state.dirty = true; scheduleSave();
    toast(`Merged changes from ${who} with yours`, 'success', 4000);
    return true;
  }
  function showConflict(remote) {
    if (tryAutoMerge(remote)) return;
    state.conflict = remote;
    const mine = remote.updated_by_id === user.id;
    const who = mine ? 'You' : (remote.updated_by_name || 'Someone');
    banner('conflict', h('div', { class: 'banner warn', role: 'alert' }, icon('alert'),
      h('span', {}, mine ? 'This document was also changed in another tab or window of yours. Choose which version to keep.' : `${who} also changed this document. Choose which version to keep.`),
      h('div', { class: 'banner-actions' },
        h('button', { class: 'btn sm', type: 'button', onclick: useTheirs }, 'Use their version'),
        h('button', { class: 'btn sm primary', type: 'button', onclick: keepMine }, 'Keep mine'),
        h('button', { class: 'btn sm', type: 'button', onclick: saveCopy }, 'Save mine as a copy'))));
    renderStatus();
  }
  function clearConflict() { state.conflict = null; banner('conflict', null); renderStatus(); }
  function useTheirs() {
    const c = state.conflict; clearConflict(); state.dirty = false;
    applyDoc({ title: c.title, content: c.content, version: c.version, updated_at: c.updated_at });
    toast('Loaded the latest version');
  }
  function keepMine() { const c = state.conflict; state.version = c.version; clearConflict(); state.dirty = true; save(); }
  async function saveCopy() {
    const c = state.conflict;
    try {
      const copy = await Api.create(`${title.value.trim() || state.doc.title} (my version)`.slice(0, 200));
      await Api.save(copy.id, { content: editor.innerHTML, base_version: copy.version });
      clearConflict(); state.dirty = false;
      applyDoc({ title: c.title, content: c.content, version: c.version, updated_at: c.updated_at });
      toast('Your version was saved as a separate document', 'success', 6000);
    } catch (e) { toast(e.message, 'error'); }
  }
  function onRemoteUpdate(d) {
    if (state.preview) { state.pendingRemote = d; return; }
    if (d.version <= state.version) return;
    if (!state.dirty && !state.saving && !state.conflict) {
      applyDoc({ title: d.title, content: d.content, version: d.version, updated_at: d.updated_at }, { keepCaret: true });
      if (d.updated_by_id !== user.id) toast(`${d.updated_by_name} updated this document`);
    } else showConflict(d);
  }

  // ---- live updates (SSE) -----------------------------------------------------------------
  function connect() {
    if (disposed || typeof EventSource === 'undefined') return;
    evt = new EventSource(`/api/documents/${state.doc.id}/events`);
    const on = (name, fn) => evt.addEventListener(name, (e) => { try { fn(JSON.parse(e.data)); } catch { /* ignore malformed */ } });
    evt.onopen = () => { state.live = true; sseRetries = 0; renderStatus(); };
    evt.onerror = () => {
      state.live = false; renderStatus();
      // After an HTTP error (a proxy 502 during a deploy, a 429) the browser gives up for good: reconnect ourselves with backoff.
      if (evt && evt.readyState === 2 && !disposed) { evt.close(); clearTimeout(sseTimer); sseTimer = setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(sseRetries++, 4))); }
    };
    on('hello', async (d) => {
      state.live = true; state.presence = d.users; renderPresence(); renderStatus();
      if (d.version > state.version) { try { const fresh = await Api.get(state.doc.id); onRemoteUpdate({ ...fresh, updated_by_name: fresh.updated_by_name }); } catch { /* ignore */ } }
    });
    on('presence', (d) => { state.presence = d.users; renderPresence(); peers.keep(d.users.map((u) => u.id)); });
    on('cursor', (d) => peers.onCursor(d));
    on('comment', (d) => { if (commentsPanel) commentsPanel.onEvent(d); else Api.comments(state.doc.id).then((c) => { setCommentCount(c.filter((x) => !x.resolved && !x.parent_id).length); paintComments(c); }).catch(() => {}); });
    on('settings', (d) => applySettings(d.settings));
    on('update', (d) => {
      if (!d.refetch) { onRemoteUpdate(d); return; }
      // big documents (pictures) are not pushed with every save: fetch the new content once
      Api.get(state.doc.id).then((fresh) => onRemoteUpdate({ ...d, title: fresh.title, content: fresh.content, version: fresh.version, updated_at: fresh.updated_at })).catch(() => {});
    });
    on('role', (d) => { state.role = d.role; state.doc.role = d.role; renderChrome(); if (commentsPanel) commentsPanel.redraw(); toast(`Your access changed: ${ROLE_TEXT[d.role]}`); });
    on('revoked', (d) => { toast(d.reason || 'You no longer have access', 'error', 6000); disposed = true; evt.close(); navigate('#/'); });
  }

  // ---- editing behaviour ---------------------------------------------------------------------
  // Native shortcuts (Ctrl+B etc.) and Enter must produce <b>/<i>/<u> and <p>, not inline styles or <div>s:
  // the server keeps no styles, so style-based formatting would vanish on save.
  const semanticEditing = () => { try { document.execCommand('styleWithCSS', false, false); document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* unsupported */ } };
  editor.addEventListener('focus', semanticEditing);
  editor.addEventListener('beforeinput', semanticEditing);
  editor.addEventListener('input', (e) => { repaintComments(); markdownShortcut(e); fmt.afterInput(e); onEdit(); if (find) find.refresh(); });
  title.addEventListener('input', onEdit);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); editor.focus(); } });
  title.addEventListener('blur', () => { if (!title.value.trim()) title.value = state.doc.title; });
  editor.addEventListener('paste', (e) => {
    if (!canEdit()) return;
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    const pic = [...(e.clipboardData.files || [])].find((f) => IMAGE_TYPES.includes(f.type));
    if (pic && !html.includes('<table')) { e.preventDefault(); images.insert(pic); return; } // a pasted screenshot or copied picture
    if (!html && !text) return;
    e.preventDefault();
    if (html) document.execCommand('insertHTML', false, cleanPastedHtml(html));
    else document.execCommand('insertText', false, text);
  });
  editor.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  editor.addEventListener('drop', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    if (!canEdit() || !e.dataTransfer.files[0]) return;
    const dropped = e.dataTransfer.files[0];
    // place the caret where the file was dropped
    let range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(e.clientX, e.clientY);
    else if (document.caretPositionFromPoint) { const pos = document.caretPositionFromPoint(e.clientX, e.clientY); if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); range.collapse(true); } }
    if (range && editor.contains(range.startContainer)) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    if (IMAGE_TYPES.includes(dropped.type)) images.insert(dropped); else insertFile(dropped);
  });
  // Insert the converted contents of a .txt / .md / .docx file at the caret (or at the end).
  async function insertFile(file) {
    if (!canEdit()) return;
    if (file.size > 2_000_000) { toast(`${file.name} is too large (2 MB max)`, 'error'); return; }
    try {
      const { html } = await Api.convert(await filePayload(file));
      if (!editor.isConnected) return; // closed while the file was converting
      editor.focus();
      const sel = getSelection();
      if (!sel.rangeCount || !editor.contains(sel.anchorNode)) { sel.selectAllChildren(editor); sel.collapseToEnd(); }
      document.execCommand('insertHTML', false, html);
      onEdit();
      toast(`Inserted ${file.name}`, 'success');
    } catch (e) { toast(`${file.name}: ${e.message}`, 'error', 6000); }
  }
  editor.addEventListener('click', (e) => {
    if (canEdit() && fmt.handleChecklistClick(e)) { e.preventDefault(); return; }
    const a = e.target.closest('a');
    if (a && (a.getAttribute('href') || '').startsWith('#')) { e.preventDefault(); hideLinkPopover(); toc.goTo(a.getAttribute('href').slice(1)); return; } // a table-of-contents link
    if (a && (e.ctrlKey || e.metaKey || !canEdit())) { window.open(a.href, '_blank', 'noopener,noreferrer'); e.preventDefault(); }
    else if (a && canEdit()) showLinkPopover(a); else hideLinkPopover();
  });
  // Clicking a link in the editor shows what it points to, with Open / Edit / Remove (like Google Docs).
  let linkPop = null;
  function hideLinkPopover() { if (linkPop) { linkPop.remove(); linkPop = null; } }
  function showLinkPopover(a) {
    hideLinkPopover();
    const href = a.getAttribute('href') || '';
    const shown = href.length > 48 ? `${href.slice(0, 46)}…` : href;
    linkPop = h('div', { class: 'linkpop', role: 'dialog', 'aria-label': 'Link options', onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); hideLinkPopover(); editor.focus(); } } },
      h('a', { class: 'linkpop-url', href, target: '_blank', rel: 'noopener noreferrer', title: href }, icon('link', 14), shown),
      h('button', { class: 'btn sm', type: 'button', onclick: () => { hideLinkPopover(); insertLink(); } }, 'Edit'),
      h('button', { class: 'btn sm danger', type: 'button', onclick: () => { hideLinkPopover(); editor.focus(); const r = document.createRange(); r.selectNodeContents(a); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('unlink'); onEdit(); } }, 'Remove'));
    document.body.append(linkPop);
    const r = a.getBoundingClientRect();
    const w = linkPop.offsetWidth;
    linkPop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
    linkPop.style.top = `${Math.min(window.innerHeight - linkPop.offsetHeight - 8, r.bottom + 6)}px`;
  }
  editor.addEventListener('keydown', (e) => { // Alt+Enter on a link opens its options (keyboard access to the popover)
    if (e.altKey && e.key === 'Enter' && canEdit()) {
      const n = getSelection().anchorNode; const a = n && (n.nodeType === 1 ? n : n.parentElement)?.closest('a');
      if (a && editor.contains(a) && !(a.getAttribute('href') || '').startsWith('#')) { e.preventDefault(); showLinkPopover(a); const first = linkPop && linkPop.querySelector('button'); if (first) first.focus(); return; }
    }
    hideLinkPopover();
  });

  const onPopDown = (e) => { if (linkPop && !linkPop.contains(e.target) && !e.target.closest('a')) hideLinkPopover(); };
  document.addEventListener('mousedown', onPopDown);
  window.addEventListener('scroll', hideLinkPopover, true);
  editor.addEventListener('keydown', (e) => {
    if (!canEdit()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey && ['b', 'i', 'u'].includes(e.key.toLowerCase())) { e.preventDefault(); exec({ b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()]); }
    else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); insertLink(); }
    else if (mod && !e.shiftKey && !e.altKey && e.key === 'Enter') { e.preventDefault(); exec('insertHTML', '<hr data-type="page"><p><br></p>'); }
    else if (mod && e.shiftKey && !e.altKey && ['l', 'e', 'r', 'j'].includes(e.key.toLowerCase())) { e.preventDefault(); fmt.align({ l: 'left', e: 'center', r: 'right', j: 'justify' }[e.key.toLowerCase()]); refreshToolbar(); }
    else if (mod && e.shiftKey && !e.altKey && ['7', '8', '9', '&', '*', '('].includes(e.key)) { e.preventDefault(); if (e.key === '7' || e.key === '&') exec('insertOrderedList'); else if (e.key === '8' || e.key === '*') exec('insertUnorderedList'); else { fmt.toggleChecklist(); refreshToolbar(); } }
    else if (mod && !e.shiftKey && !e.altKey && e.key === '\\') { e.preventDefault(); fmt.clearFormatting(); refreshToolbar(); }
    else if (mod && !e.shiftKey && !e.altKey && (e.key === ']' || e.key === '[')) { e.preventDefault(); fmt.indent(e.key === ']' ? 1 : -1); refreshToolbar(); }
    else if (mod && !e.shiftKey && !e.altKey && (e.key === ',' || e.key === '.')) { e.preventDefault(); fmt.script(e.key === ',' ? 'sub' : 'sup'); refreshToolbar(); }
    else if (mod && e.altKey && e.key.toLowerCase() === 'm') { e.preventDefault(); commentOnSelection(); }
    else if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c') { e.preventDefault(); showStats(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'x') { e.preventDefault(); exec('strikeThrough'); }
    else if (mod && e.altKey && /^[0-3]$/.test(e.key)) { e.preventDefault(); applyBlock(e.key === '0' ? 'p' : `h${e.key}`); }
    else if (e.key === 'Tab' && cellAtCaret()) {
      e.preventDefault();
      const c = cellAtCaret(), cells = [...c.closest('table').querySelectorAll('td,th')], i = cells.indexOf(c) + (e.shiftKey ? -1 : 1);
      if (i >= 0 && i < cells.length) putCaret(cells[i]);
      else if (i >= cells.length) { const tr = c.parentElement, n = document.createElement('tr'); for (let k = 0; k < tr.cells.length; k++) n.append(newCell('td')); (c.closest('table').tBodies[0] || c.closest('table')).append(n); putCaret(n.cells[0]); onEdit(); }
    }
    else if (e.key === 'Tab') {
      const an = getSelection().anchorNode;
      const el = an && (an.nodeType === 1 ? an : an.parentElement); // an empty <li> is itself the anchor
      if (el && el.closest('li') && editor.contains(el)) { e.preventDefault(); exec(e.shiftKey ? 'outdent' : 'indent'); }
    }
  });
  // ---- slash menu and command palette ----------------------------------------------------------------
  const blockCommands = [
    { label: 'Heading 1', desc: 'Big section title', keywords: 'h1 title', icon: 'outline', run: () => applyBlock('h1') },
    { label: 'Heading 2', desc: 'Medium section title', keywords: 'h2 subtitle', icon: 'outline', run: () => applyBlock('h2') },
    { label: 'Heading 3', desc: 'Small section title', keywords: 'h3', icon: 'outline', run: () => applyBlock('h3') },
    { label: 'Text', desc: 'Plain paragraph', keywords: 'paragraph normal', icon: 'file', run: () => applyBlock('p') },
    { label: 'Bulleted list', desc: 'A simple list', keywords: 'ul bullets', icon: 'ul', run: () => exec('insertUnorderedList') },
    { label: 'Numbered list', desc: 'A list with numbers', keywords: 'ol ordered', icon: 'ol', run: () => exec('insertOrderedList') },
    { label: 'Checklist', desc: 'Tick things off', keywords: 'todo task checkbox', icon: 'checklist', run: () => { fmt.toggleChecklist(); refreshToolbar(); } },
    { label: 'Quote', desc: 'Call out a quotation', keywords: 'blockquote', icon: 'file', run: () => applyBlock('blockquote') },
    { label: 'Code block', desc: 'Monospaced text', keywords: 'pre code', icon: 'file', run: () => applyBlock('pre') },
    { label: 'Table', desc: 'Rows and columns', keywords: 'grid', icon: 'table', run: () => insertTable() },
    { label: 'Picture', desc: 'Upload an image', keywords: 'image photo', icon: 'image', run: () => { fmt.restore(); imageInput.click(); } },
    { label: 'Divider', desc: 'A horizontal line', keywords: 'hr rule line', icon: 'hr', run: () => exec('insertHorizontalRule') },
    { label: 'Page break', desc: 'Start a new page', keywords: 'pagebreak', icon: 'pagebreak', run: () => exec('insertHTML', '<hr data-type="page"><p><br></p>') },
    { label: 'Drawing', desc: 'Sketch and insert as a picture', keywords: 'draw sketch pen', icon: 'image', run: () => { fmt.restore(); openDrawing({ onSave: (f) => images.insert(f) }); } },
    { label: 'Table of contents', desc: 'Links to your headings', keywords: 'toc contents', icon: 'outline', run: () => toc.insert() },
  ];
  const slash = createSlashMenu({ editor, getCanEdit: () => canEdit(), commands: blockCommands });
  function paletteCommands() {
    const edit = canEdit();
    const exportTo = (f) => async () => { await flush(); const a = h('a', { href: Api.exportUrl(state.doc.id, f), download: '' }); document.body.append(a); a.click(); a.remove(); };
    const cmds = [
      ...(edit ? blockCommands.map((c) => ({ ...c, group: 'Insert' })) : []),
      ...(edit ? [
        { label: 'Bold', group: 'Format', hint: 'Ctrl+B', icon: 'bold', run: () => exec('bold') }, { label: 'Italic', group: 'Format', hint: 'Ctrl+I', icon: 'italic', run: () => exec('italic') },
        { label: 'Underline', group: 'Format', hint: 'Ctrl+U', icon: 'underline', run: () => exec('underline') }, { label: 'Strikethrough', group: 'Format', icon: 'strike', run: () => exec('strikeThrough') },
        { label: 'Align left', group: 'Format', icon: 'alignLeft', run: () => fmt.align('left') }, { label: 'Align centre', group: 'Format', icon: 'alignCenter', run: () => fmt.align('center') },
        { label: 'Align right', group: 'Format', icon: 'alignRight', run: () => fmt.align('right') }, { label: 'Justify', group: 'Format', icon: 'alignJustify', run: () => fmt.align('justify') },
        { label: 'Increase indent', group: 'Format', icon: 'indent', run: () => fmt.indent(1) }, { label: 'Decrease indent', group: 'Format', icon: 'outdent', run: () => fmt.indent(-1) },
        { label: 'Clear formatting', group: 'Format', hint: 'Ctrl+\\', icon: 'clear', run: () => fmt.clearFormatting() },
        { label: 'Insert link', group: 'Insert', hint: 'Ctrl+K', icon: 'link', run: () => insertLink() }, { label: 'Special characters and emoji', group: 'Insert', icon: 'omega', run: () => insertSpecial() },
        { label: 'Update table of contents', group: 'Insert', icon: 'outline', run: () => { if (toc.update({ announce: true })) onEdit(); } },
        { label: 'Find and replace', group: 'Edit', hint: 'Ctrl+H', icon: 'find', run: () => find && find.open(true) },
        { label: 'Undo', group: 'Edit', icon: 'undo', run: () => exec('undo') }, { label: 'Redo', group: 'Edit', icon: 'redo', run: () => exec('redo') },
      ] : []),
      { label: 'Find in document', group: 'Edit', hint: 'Ctrl+F', icon: 'find', run: () => find && find.open(false) },
      { label: 'Add a comment', group: 'Document', hint: 'Ctrl+Alt+M', icon: 'comment', run: () => commentOnSelection() },
      { label: 'Show comments', group: 'Document', icon: 'comment', run: () => toggleComments() },
      { label: 'Version history', group: 'Document', icon: 'history', run: () => openHistoryPanel() },
      ...(state.role === 'owner' ? [{ label: 'Share…', group: 'Document', keywords: 'invite link people', icon: 'share', run: () => shareBtn.click() }] : []),
      { label: 'Page setup…', group: 'Document', keywords: 'margins orientation header footer paper', icon: 'file', run: () => showPageSetup() },
      { label: 'Word count', group: 'Document', icon: 'stats', run: () => showStats() },
      { label: 'Toggle outline', group: 'View', icon: 'outline', run: () => toggleOutline() },
      { label: 'Keyboard shortcuts', group: 'View', icon: 'keyboard', run: () => showShortcuts() },
      { label: 'Switch theme (auto / light / dark)', group: 'View', keywords: 'dark mode light', icon: 'sun', run: () => { const b = document.querySelector('.theme-btn'); if (b) b.click(); } },
      { label: 'Print / save as PDF', group: 'Export', icon: 'print', run: async () => { await flush(); printTitle.textContent = title.value; window.print(); } },
      { label: 'Export as Word (.docx)', group: 'Export', icon: 'download', run: exportTo('docx') }, { label: 'Export as Markdown', group: 'Export', icon: 'download', run: exportTo('md') },
      { label: 'Export as web page (.html)', group: 'Export', icon: 'download', run: exportTo('html') }, { label: 'Export as plain text', group: 'Export', icon: 'download', run: exportTo('txt') },
      { label: 'Back to all documents', group: 'Go', icon: 'back', run: async () => { await flush(); navigate('#/'); } },
    ];
    for (const el of toc_entries()) cmds.push({ label: `Go to: ${el.text}`, group: 'Headings', keywords: 'jump heading section', icon: 'outline', run: () => toc.goTo(el.id) });
    return cmds;
  }
  function toc_entries() { toc.ensureIds(); return [...editor.querySelectorAll('h1, h2, h3')].filter((e) => !e.closest('ul[data-type="toc"]') && e.textContent.trim()).map((e) => ({ id: e.id, text: e.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) })); }
  const onGlobalKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); slash.close(); openPalette(paletteCommands()); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flush().then(() => { if (!state.dirty && !state.conflict) toast('Saved', 'success', 1500); }); }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && find) { e.preventDefault(); find.open(false); }
    else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'h' && find && canEdit()) { e.preventDefault(); find.open(true); }
    else if (mod && !e.altKey && e.key.toLowerCase() === 'g' && find && find.isOpen) { e.preventDefault(); e.shiftKey ? find.prev() : find.next(); }
    if (e.key === 'Escape') closeMenus();
  };
  window.addEventListener('keydown', onGlobalKey);

  // Markdown-style shortcuts: "# ", "## ", "### ", "- ", "* ", "1. ", "> " at the start of a line.
  function markdownShortcut(e) {
    if (e.inputType !== 'insertText' || e.data !== ' ' || !canEdit()) return;
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return;
    let block = sel.anchorNode;
    while (block && block.parentNode !== editor) block = block.parentNode;
    if (!block || block.nodeType !== 1 || !/^(P|DIV)$/.test(block.tagName)) return;
    const text = block.textContent.replace(/ /g, ' ');
    const map = [[/^# $/, () => 'h1'], [/^## $/, () => 'h2'], [/^### $/, () => 'h3'], [/^[-*] $/, () => 'ul'], [/^1[.)] $/, () => 'ol'], [/^> $/, () => 'blockquote']];
    for (const [re, kind] of map) {
      if (!re.test(text)) continue;
      block.innerHTML = '<br>';
      const r = document.createRange(); r.setStart(block, 0); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
      const k = kind();
      if (k === 'ul') document.execCommand('insertUnorderedList'); else if (k === 'ol') document.execCommand('insertOrderedList'); else document.execCommand('formatBlock', false, `<${k}>`);
      return;
    }
  }

  // ---- link dialog ------------------------------------------------------------------------------
  function insertLink() {
    if (!canEdit()) return;
    const sel = getSelection();
    const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const existing = sel.anchorNode && sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest('a');
    const selectedText = sel.toString();
    const urlIn = h('input', { type: 'text', value: existing ? existing.getAttribute('href') : '', placeholder: 'https://example.com', 'aria-label': 'Link address', autocomplete: 'off' });
    const textIn = h('input', { type: 'text', value: selectedText, placeholder: 'Text to display', 'aria-label': 'Link text' });
    const err = h('p', { class: 'error', role: 'alert' });
    const apply = (done) => {
      let url = urlIn.value.trim();
      if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url) ? `mailto:${url}` : `https://${url}`;
      const ok = safeUrl(url);
      if (!ok) { err.textContent = 'Enter a web address (https://...) or an email address.'; return; }
      done();
      editor.focus();
      if (saved) { sel.removeAllRanges(); sel.addRange(saved); }
      if (selectedText || existing) document.execCommand('createLink', false, ok);
      else document.execCommand('insertHTML', false, `<a href="${ok.replace(/"/g, '&quot;')}">${(textIn.value || ok).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</a>`);
      onEdit();
    };
    const form = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); apply(() => d.close()); } }, h('label', {}, 'Address', urlIn), !selectedText && !existing && h('label', {}, 'Text', textIn), err);
    const actions = [{ label: 'Cancel', value: null }];
    if (existing) actions.push({ label: 'Remove link', kind: 'danger', onClick: (fin) => { fin(); editor.focus(); if (saved) { sel.removeAllRanges(); sel.addRange(saved); } document.execCommand('unlink'); onEdit(); } });
    actions.push({ label: existing ? 'Update' : 'Insert link', kind: 'primary', onClick: () => form.requestSubmit() });
    const d = openDialog({ title: existing ? 'Edit link' : 'Insert link', body: form, actions });
    urlIn.focus(); urlIn.select();
  }

  // ---- history / preview ------------------------------------------------------------------------
  // ---- commented passages are tinted in the page (CSS Custom Highlight API: nothing is added to the document) ----
  let commentRanges = [];
  let lastComments = [];
  function paintComments(list = lastComments) {
    lastComments = list;
    commentRanges = [];
    if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') {
      if (!list.some((c) => !c.resolved && !c.parent_id && c.quote)) { try { CSS.highlights.delete('comment'); } catch { /* ignore */ } return; }
      const nodes = []; let full = ''; const map = []; let prevSpace = false;
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode());) {
        const v = n.nodeValue;
        for (let i = 0; i < v.length; i++) { const sp = /\s/.test(v[i]); if (sp && prevSpace) continue; full += sp ? ' ' : v[i]; map.push([n, i]); prevSpace = sp; }
        nodes.push(n);
        if (!prevSpace) { full += ' '; map.push([n, v.length]); prevSpace = true; }
      }
      for (const c of list) {
        if (c.resolved || c.parent_id || !c.quote) continue;
        const at = full.indexOf(c.quote.replace(/\s+/g, ' ').trim());
        if (at < 0) continue;
        const end = at + c.quote.replace(/\s+/g, ' ').trim().length - 1;
        try { const r = document.createRange(); r.setStart(map[at][0], map[at][1]); r.setEnd(map[end][0], map[end][1] + 1); commentRanges.push({ id: c.id, range: r }); } catch { /* the text changed under it */ }
      }
      if (commentRanges.length) CSS.highlights.set('comment', new Highlight(...commentRanges.map((x) => x.range))); else CSS.highlights.delete('comment');
    }
  }
  editor.addEventListener('click', () => { // clicking a commented passage opens the comments
    const s = getSelection();
    if (!s.rangeCount || !s.isCollapsed || !commentRanges.length) return;
    if (commentRanges.some((x) => { try { return x.range.isPointInRange(s.anchorNode, s.anchorOffset); } catch { return false; } })) { if (!commentsPanel) toggleComments(); }
  });
  const repaintComments = debounce(() => paintComments(), 400);
  // ---- comments -----------------------------------------------------------------------------------
  let commentsPanel = null;
  const setCommentCount = (n) => { state.commentCount = n; commentBadge.textContent = String(n); commentBadge.hidden = !n; commentsBtn.setAttribute('aria-label', n ? `Comments (${n} open)` : 'Comments'); };
  async function toggleComments() {
    if (commentsPanel) { commentsPanel.close(); return; }
    if (historyPanel) historyPanel.close();
    commentsPanel = openComments({ host: workspace, doc: state.doc, user, getRole: () => state.role, onCount: setCommentCount, onData: paintComments, onClose: () => { commentsPanel = null; }, onJump: jumpToText });
  }
  // Comment on the current selection: remember the quoted text, open the panel with it attached.
  function commentOnSelection() {
    const sel = getSelection();
    const text = sel && sel.rangeCount && editor.contains(sel.anchorNode) ? sel.toString() : '';
    if (!commentsPanel) toggleComments();
    if (text.trim()) setTimeout(() => commentsPanel && commentsPanel.setQuote(text), 0);
    else { toast('Select some text first to comment on it', 'info', 2500); }
  }
  // Find the first occurrence of a quoted passage and select it (best effort: text may have been edited since).
  function jumpToText(text) {
    const needle = text.replace(/\s+/g, ' ').trim();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const nodes = []; let full = '';
    for (let n; (n = walker.nextNode());) { nodes.push({ n, start: full.length }); full += n.nodeValue; }
    const flat = full.replace(/\s+/g, ' ');
    // map positions in the whitespace-collapsed string back to the original
    const map = []; let last = false;
    for (let i = 0; i < full.length; i++) { const ws = /\s/.test(full[i]); if (ws && last) continue; map.push(i); last = ws; }
    const at = flat.indexOf(needle);
    if (at === -1) { toast('That passage has been changed or removed', 'info', 3000); return; }
    const locate = (pos) => { const o = map[pos]; for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].start <= o) return { node: nodes[i].n, offset: o - nodes[i].start }; return null; };
    const a = locate(at), b = locate(Math.min(at + needle.length - 1, map.length - 1));
    if (!a || !b) return;
    const r = document.createRange(); r.setStart(a.node, a.offset); r.setEnd(b.node, Math.min(b.offset + 1, b.node.nodeValue.length));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    (a.node.parentElement || editor).scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  Api.comments(state.doc.id).then((c) => { setCommentCount(c.filter((x) => !x.resolved && !x.parent_id).length); paintComments(c); }).catch(() => {});

  let historyPanel = null;
  async function openHistoryPanel() {
    await flush();
    if (historyPanel) { historyPanel.close(); return; }
    if (commentsPanel) commentsPanel.close();
    historyPanel = openHistory({
      host: workspace, doc: state.doc, canRestore: () => state.role === 'owner' || state.role === 'editor',
      onPreview: enterPreview, onRestore: async (vid) => {
        try { const d = await Api.restore(state.doc.id, vid); exitPreview(false); applyDoc(d); toast('Version restored', 'success'); historyPanel && historyPanel.refresh(); }
        catch (e) { toast(e.message, 'error'); }
      },
      onClose: () => { historyPanel = null; if (state.preview) exitPreview(true); },
    });
  }
  let liveSnapshot = null;
  function enterPreview(v, isCurrent) {
    if (isCurrent) { if (state.preview) exitPreview(true); return; }
    if (!state.preview) liveSnapshot = { title: title.value, html: editor.innerHTML };
    state.preview = v;
    title.value = v.title;
    setContent(v.content);
    renderChrome();
    const d = diffStats(htmlToPlain(v.content), htmlToPlain(liveSnapshot.html));
    const vsNow = d.added || d.removed ? ` · since this version: ${d.added ? `+${pluralize(d.added, 'word')}` : ''}${d.added && d.removed ? ', ' : ''}${d.removed ? `\u2212${pluralize(d.removed, 'word')}` : ''}` : ' · same text as the current version';
    banner('preview', h('div', { class: 'banner info' }, icon('history'),
      h('span', {}, `Previewing version ${v.version} by ${v.author_name || 'unknown'} · ${fullTime(v.updated_at)}${vsNow}`),
      h('div', { class: 'banner-actions' },
        (state.role === 'owner' || state.role === 'editor') && h('button', { class: 'btn sm primary', type: 'button', onclick: () => historyPanel && historyPanel.restore(v.id) }, 'Restore this version'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => exitPreview(true) }, 'Back to current'))));
  }
  function exitPreview(restoreLive) {
    if (!state.preview) return;
    state.preview = null;
    banner('preview', null);
    if (restoreLive && liveSnapshot) { title.value = liveSnapshot.title; setContent(liveSnapshot.html); }
    liveSnapshot = null;
    if (state.pendingRemote) { const p = state.pendingRemote; state.pendingRemote = null; onRemoteUpdate(p); }
    renderChrome();
    if (historyPanel) historyPanel.select(null);
  }

  async function deleteDoc() {
    const t = state.doc.title, id = state.doc.id;
    try {
      state.dirty = false; scheduleSave.cancel(); await Api.remove(id); disposed = true;
      toast(`"${t.length > 40 ? t.slice(0, 40) + '…' : t}" moved to Trash`, 'info', 7000, { label: 'Undo', onClick: async () => { try { await Api.restoreFromTrash(id); toast('Restored', 'success', 2000); navigate(`#/doc/${id}`); } catch (e) { toast(e.message, 'error'); } } });
      navigate('#/');
    } catch (e) { toast(e.message, 'error'); }
  }
  function showShortcuts() {
    const rows = [['Bold / Italic / Underline', 'Ctrl+B / I / U'], ['Strikethrough', 'Ctrl+Shift+X'], ['Subscript / Superscript', 'Ctrl+, / Ctrl+.'], ['Insert link', 'Ctrl+K'], ['Insert page break', 'Ctrl+Enter'], ['Command palette', 'Ctrl+Shift+P'], ['Insert block menu', '/'], ['Heading 1-3 / Normal', 'Ctrl+Alt+1-3 / 0'], ['Align left / centre / right / justify', 'Ctrl+Shift+L / E / R / J'], ['Numbered / bulleted / checklist', 'Ctrl+Shift+7 / 8 / 9'], ['Increase / decrease indent', 'Ctrl+] / Ctrl+['], ['Clear formatting', 'Ctrl+\\'], ['Find / replace / next match', 'Ctrl+F / H / G'], ['Comment on selection', 'Ctrl+Alt+M'], ['Word count', 'Ctrl+Shift+C'], ['Save now', 'Ctrl+S'], ['Indent list item / table navigation', 'Tab / Shift+Tab'], ['Heading, list, quote while typing', '# , ## , - , 1. , > then Space'], ['Open link', 'Ctrl+Click']];
    openDialog({ title: 'Keyboard shortcuts', body: h('table', { class: 'shortcuts' }, rows.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, h('kbd', {}, b))))), actions: [{ label: 'Done', kind: 'primary', value: true }] });
  }

  // ---- connectivity -------------------------------------------------------------------------------
  const onOffline = () => { state.online = false; renderStatus(); };
  const onOnline = () => { state.online = true; renderStatus(); if (state.dirty) save(); };
  window.addEventListener('offline', onOffline); window.addEventListener('online', onOnline);
  const onBeforeUnload = (e) => { stash(); if (state.dirty || state.saving) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('session-expired', stash);
  window.addEventListener('beforeunload', onBeforeUnload);
  const statusTimer = setInterval(renderStatus, 30000);
  // Mobile browsers can freeze or kill a backgrounded tab, so save as soon as the page is hidden.
  const onVisibility = () => { if (document.hidden) { scheduleSave.cancel(); save(); stash(); } };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', stash);

  // ---- mount -------------------------------------------------------------------------------------------
  const workspace = h('div', { class: 'workspace' }, outline,
    editorCol = h('div', { class: 'editor-col' }, toolbar, tableBar, imageBar, imageInput, banners, h('div', { class: 'paper-wrap' }, (paper = h('div', { class: 'paper' }, paperHeader, printTitle, editor, paperFooter))), h('div', { class: 'footer-bar' }, wordsEl, zoomSel, h('span', { class: 'muted' }, liveDot, ' ', h('span', { class: 'small' }, 'Live')))));
  find = createFind({ editor, host: editorCol, getCanEdit: canEdit, onEdit });
  // Toolbar: ONE tab stop with arrow-key roving (ARIA toolbar pattern), instead of 35 tab stops before the document
  { let active = null;
    const items = () => [...toolbar.querySelectorAll('button, select, input')].filter((el) => !el.disabled && !el.closest('[hidden]'));
    const sync = () => { const list = items(); if (!list.includes(active)) active = list[0]; list.forEach((el) => { el.tabIndex = el === active ? 0 : -1; }); };
    toolbar.addEventListener('focusin', (e) => { if (e.target.matches('button, select, input')) { active = e.target; sync(); } });
    toolbar.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || e.target.tagName === 'INPUT') return;
      const list = items(); const i = list.indexOf(e.target); if (i < 0) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
      active = list[next]; sync(); active.focus();
    });
    new MutationObserver(sync).observe(toolbar, { attributes: true, attributeFilter: ['disabled', 'hidden'], subtree: true });
    setTimeout(sync, 0);
  }
  const hideTips = attachTooltips(toolbar);
  root.replaceChildren(h('div', { class: 'editor-view' }, h('a', { class: 'skip', href: '#document', onclick: (e) => { e.preventDefault(); editor.focus(); } }, 'Skip to document'), insertFileInput,
    h('div', { class: 'editor-head' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back to all documents', onclick: async () => { await flush(); navigate('#/'); } }, icon('back')),
      h('div', { class: 'title-wrap' }, title, h('div', { class: 'title-meta' }, roleBadge, status)),
      h('div', { class: 'head-actions' }, presenceEl, commentsBtn, historyBtn, shareBtn, exportBtn, moreBtn)),
    workspace));
  function setZoom(z) { zoom = z; paper.style.zoom = String(z / 100); try { localStorage.setItem('docs-lite:zoom', String(z)); } catch { /* ignore */ } }
  setZoom(zoom);
  applySettings(state.settings);
  let spyRaf = 0;
  const onSpy = () => { if (!spyRaf) spyRaf = requestAnimationFrame(() => { spyRaf = 0; spyOutline(); }); };
  setTimeout(() => { for (const host of root.querySelectorAll('.menu-host')) { // aria-expanded follows each menu
    const btn = host.querySelector('button[aria-haspopup]'), menu = host.querySelector('.menu');
    if (!btn || !menu) continue;
    const sync = () => btn.setAttribute('aria-expanded', String(!menu.hidden));
    sync(); new MutationObserver(sync).observe(menu, { attributes: true, attributeFilter: ['hidden'] });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('[role="menuitem"]')]; const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { menu.hidden = true; btn.focus(); }
      else if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Home' && items.length) { e.preventDefault(); items[0].focus(); } else if (e.key === 'End' && items.length) { e.preventDefault(); items[items.length - 1].focus(); }
    });
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); if (menu.hidden) btn.click(); const f = menu.querySelector('[role="menuitem"]'); if (f) f.focus(); } });
  } }, 0);
  document.addEventListener('scroll', onSpy, { capture: true, passive: true }); // the scrolling element is created later, so listen at the document
  setTimeout(spyOutline, 0);
  applyDoc(state.doc);
  document.title = `${state.doc.title} · Docs Lite`;
  const draft = readDraft(state.doc.id);
  if (draft && canEdit() && (draft.html !== state.doc.content || draft.title !== state.doc.title)) {
    banner('draft', h('div', { class: 'banner info', role: 'status' }, icon('alert'),
      h('span', {}, 'We found changes you had not saved from an earlier session.'),
      h('div', { class: 'banner-actions' },
        h('button', { class: 'btn sm primary', type: 'button', onclick: () => { banner('draft', null); title.value = draft.title; setContent(draft.html); if (Number.isInteger(draft.base) && draft.base !== state.version) { state.version = draft.base; state.base = null; } state.dirty = true; renderStatus(); save(); toast('Recovered your unsaved changes', 'success'); } }, 'Restore them'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => { clearDraft(state.doc.id); banner('draft', null); } }, 'Discard'))));
  } else clearDraft(state.doc.id);
  connect();
  if (canEdit() && editor.innerText.trim() === '') editor.focus();

  try { if (sessionStorage.getItem('docs-lite:open-share') === String(state.doc.id) && state.role === 'owner') { sessionStorage.removeItem('docs-lite:open-share'); setTimeout(() => shareBtn.click(), 150); } } catch { /* ignore */ }
  return async () => {
    disposed = true;
    clearInterval(statusTimer); clearTimeout(retryTimer);
    renderWordsSoon.cancel(); renderOutlineSoon.cancel(); repaintComments.cancel();
    if (state.preview) exitPreview(true); // leave history preview first, so the real text is what gets saved
    await flush();
    if (state.dirty) stash(); // a conflict or a failed save must never throw typed text away
    clearTimeout(retryTimer); // a failed final save must not keep retrying after the view is gone
    clearTimeout(sseTimer);
    if (evt) evt.close();
    if (find) find.destroy();
    if (historyPanel) historyPanel.close(true);
    if (commentsPanel) commentsPanel.close();
    document.removeEventListener('selectionchange', refreshToolbar);
    hideTips.destroy(); document.removeEventListener('scroll', onSpy, true); if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete('comment'); images.destroy(); hideLinkPopover(); peers.destroy(); selbar.destroy(); fmt.destroy(); slash.close(); removePrintStyles();
    document.removeEventListener('mousedown', onPopDown); window.removeEventListener('scroll', hideLinkPopover, true);
    document.removeEventListener('click', onDocClick);
    window.removeEventListener('keydown', onGlobalKey);
    window.removeEventListener('offline', onOffline); window.removeEventListener('online', onOnline);
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('session-expired', stash);
    document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('pagehide', stash);
    document.title = 'Docs Lite';
  };
}
