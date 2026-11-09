import { h, openDialog, pluralize } from '../dom.js';
import { SIZES, MARGINS, DEFAULT_SETTINGS } from '../pagesetup.js';

// ---- special characters and emoji ---------------------------------------------------------------
const SETS = {
  Common: '© ® ™ § ¶ † ‡ • … – — « » “ ” ‘ ’ ° ± × ÷ ≠ ≈ ≤ ≥ µ № ‰ ½ ¼ ¾'.split(' '),
  Arrows: '← → ↑ ↓ ↔ ↕ ⇐ ⇒ ⇑ ⇓ ⇔ ↖ ↗ ↘ ↙ ↩ ↪ ↻ ↺ ⬆ ⬇ ⬅ ➡'.split(' '),
  Math: '∞ ∑ ∏ √ ∫ ∂ ∆ ∇ ∈ ∉ ∩ ∪ ⊂ ⊃ ⊆ ⊇ ∀ ∃ ∧ ∨ ¬ ≡ ∝ π θ λ Ω ² ³ ⁿ'.split(' '),
  Currency: '$ € £ ¥ ₹ ₽ ₩ ₪ ₫ ₺ ₴ ₦ ¢ ₿ ฿ ₡ ₱'.split(' '),
  Greek: 'α β γ δ ε ζ η θ ι κ λ μ ν ξ ο π ρ σ τ υ φ χ ψ ω Α Β Γ Δ Σ Ω'.split(' '),
  Emoji: '\u{1F600} \u{1F601} \u{1F602} \u{1F923} \u{1F60A} \u{1F60D} \u{1F618} \u{1F60E} \u{1F914} \u{1F622} \u{1F62D} \u{1F621} \u{1F44D} \u{1F44E} \u{1F44F} \u{1F64C} \u{1F64F} \u{1F4AA} \u{1F389} \u{1F525} ✨ ❤️ \u{1F4A1} ✅ ❌ ⚠️ ⭐ \u{1F680} \u{1F4C8} \u{1F4DD} \u{1F4CE} \u{1F4C5} \u{1F512} \u{1F50D} \u{1F4AC} \u{1F440}'.split(' '),
};

export function openCharMap(onPick) {
  let tab = 'Common';
  const grid = h('div', { class: 'chargrid', role: 'listbox', 'aria-label': 'Characters' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, Object.keys(SETS).map((name) => h('button', { class: 'tab', type: 'button', role: 'tab', onclick: () => { tab = name; draw(); } }, name)));
  function draw() {
    [...tabs.children].forEach((b) => { const on = b.textContent === tab; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
    grid.replaceChildren(...SETS[tab].map((c) => h('button', { class: 'char', type: 'button', title: `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`, 'aria-label': `Insert ${c}`, onclick: () => { d.close(); setTimeout(() => onPick(c), 0); } }, c))); // close first: the editor cannot take focus behind a modal dialog
  }
  const d = openDialog({ title: 'Insert special character', wide: true, body: h('div', { class: 'stack' }, tabs, grid), actions: [{ label: 'Close', value: null }] });
  draw();
  return d;
}

// ---- word count and writing insights --------------------------------------------------------------
import { analyse } from '../insights.js';
export function countStats(text) { return analyse(text, document.documentElement.lang || undefined); }

export function openStats({ text, selectionText }) {
  const all = countStats(text);
  const sel = selectionText && selectionText.trim() ? countStats(selectionText) : null;
  const fmt = (n) => n.toLocaleString();
  const row = (label, key, f = fmt) => h('tr', {}, h('th', { scope: 'row' }, label), h('td', {}, f(all[key])), sel && h('td', { class: 'muted' }, f(sel[key])));
  const minutes = (m) => (m < 1 ? 'under a minute' : `${Math.round(m)} min`);
  const extra = [];
  if (all.flesch !== null) extra.push(h('tr', {}, h('th', { scope: 'row' }, 'Reading ease'), h('td', {}, `${all.flesch} · ${all.level}`), sel && h('td', { class: 'muted' }, sel.flesch !== null ? String(sel.flesch) : '')));
  extra.push(row('Average sentence', 'avgSentence', (n) => `${n} words`));
  const table = h('table', { class: 'stats' },
    h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, 'Document'), sel && h('th', {}, 'Selection'))),
    h('tbody', {}, row('Words', 'words'), row('Characters', 'characters'), row('Characters without spaces', 'charactersNoSpaces'), row('Sentences', 'sentences'), row('Paragraphs', 'paragraphs'),
      h('tr', {}, h('th', { scope: 'row' }, 'Reading time'), h('td', {}, minutes(all.readingMinutes)), sel && h('td', { class: 'muted' }, minutes(sel.readingMinutes))),
      h('tr', {}, h('th', { scope: 'row' }, 'Speaking time'), h('td', {}, minutes(all.speakingMinutes)), sel && h('td', { class: 'muted' }, minutes(sel.speakingMinutes))), ...extra));
  const more = [];
  if (all.top.length) more.push(h('p', { class: 'muted small' }, 'Most repeated words: ', all.top.map(([w, n]) => `${w} (${n})`).join(', ')));
  if (all.longest && all.longest.words > 25) more.push(h('p', { class: 'muted small' }, `Longest sentence (${all.longest.words} words): “${all.longest.text}${all.longest.text.length >= 140 ? '…' : ''}”`));
  return openDialog({ title: 'Word count', body: h('div', { class: 'stack' }, table, ...more), actions: [{ label: 'Done', kind: 'primary', value: true }] });
}

// ---- page setup ---------------------------------------------------------------------------------------
export function openPageSetup({ settings, canEdit, onSave }) {
  const sel = (label, options, value, key) => h('label', {}, label, h('select', { 'data-key': key, disabled: !canEdit }, options.map(([v, text]) => h('option', { value: v, selected: v === value }, text))));
  const size = sel('Paper size', Object.entries(SIZES).map(([k, v]) => [k, v.label]), settings.size, 'size');
  const orient = sel('Orientation', [['portrait', 'Portrait'], ['landscape', 'Landscape']], settings.orientation, 'orientation');
  const margins = sel('Margins', Object.entries(MARGINS).map(([k, v]) => [k, v.label]), settings.margins, 'margins');
  const header = h('input', { type: 'text', value: settings.header, maxLength: 120, placeholder: 'Shown at the top of every page', disabled: !canEdit, 'aria-label': 'Header text' });
  const footer = h('input', { type: 'text', value: settings.footer, maxLength: 120, placeholder: 'Shown at the bottom of every page', disabled: !canEdit, 'aria-label': 'Footer text' });
  const numbers = h('input', { type: 'checkbox', checked: settings.pageNumbers, disabled: !canEdit });
  const err = h('p', { class: 'error', role: 'alert' });
  const read = () => ({ size: size.querySelector('select').value, orientation: orient.querySelector('select').value, margins: margins.querySelector('select').value, header: header.value.trim(), footer: footer.value.trim(), pageNumbers: numbers.checked });
  // a small page that shows the choice: shape from size and orientation, inset from the margins, dashes for header / footer
  const sheet = h('div', { class: 'ps-sheet' }, h('i', { class: 'ps-head' }), h('i', { class: 'ps-line' }), h('i', { class: 'ps-line' }), h('i', { class: 'ps-line short' }), h('i', { class: 'ps-foot' }));
  const preview = h('div', { class: 'ps-preview', 'aria-hidden': 'true' }, sheet);
  function drawPreview() {
    const v = read(); const z = SIZES[v.size] || SIZES.a4, m = MARGINS[v.margins] || MARGINS.normal;
    const w = v.orientation === 'landscape' ? z.h : z.w, hgt = v.orientation === 'landscape' ? z.w : z.h;
    const scale = 112 / Math.max(w, hgt);
    sheet.style.width = `${Math.round(w * scale)}px`; sheet.style.height = `${Math.round(hgt * scale)}px`;
    sheet.style.padding = `${Math.round(m.tb * scale)}px ${Math.round(m.lr * scale)}px`;
    sheet.classList.toggle('has-head', Boolean(v.header)); sheet.classList.toggle('has-foot', Boolean(v.footer || v.pageNumbers));
  }
  const form = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); save(); }, onchange: drawPreview, oninput: drawPreview },
    h('div', { class: 'ps-top' }, h('div', { class: 'grid-3' }, size, orient, margins), preview),
    h('label', {}, 'Header', header), h('label', {}, 'Footer', footer),
    h('label', { class: 'check' }, numbers, 'Page numbers (bottom right)'),
    h('p', { class: 'muted small' }, 'Applies when you print, save as PDF or export to Word. Headers and footers are not shown while editing.'), err);
  async function save() { err.textContent = ''; try { await onSave(read()); d.close(true); } catch (e) { err.textContent = e.message; } }
  queueMicrotask(drawPreview);
  const d = openDialog({ title: 'Page setup', body: form, actions: canEdit
    ? [{ label: 'Reset', kind: 'ghost', onClick: () => { size.querySelector('select').value = DEFAULT_SETTINGS.size; orient.querySelector('select').value = 'portrait'; margins.querySelector('select').value = 'normal'; header.value = ''; footer.value = ''; numbers.checked = false; drawPreview(); } }, { label: 'Cancel', value: null }, { label: 'Apply', kind: 'primary', onClick: () => form.requestSubmit() }]
    : [{ label: 'Close', kind: 'primary', value: true }] });
  return d;
}
