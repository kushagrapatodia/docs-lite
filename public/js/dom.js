// Small DOM helpers: element builder, icons, toasts, dialogs, formatting.
// On Apple devices the shortcut key is Command: labels written as "Ctrl+B" are shown as "⌘B" (the handlers already accept both).
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
export const keyLabel = (t) => (isMac && typeof t === 'string' ? t.replace(/Ctrl\+Shift\+/g, '⇧⌘').replace(/Ctrl\+Alt\+/g, '⌥⌘').replace(/Ctrl\+/g, '⌘').replace(/Ctrl\/Cmd/g, '⌘') : t);
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (isMac && (k === 'title' || k === 'aria-label' || k === 'placeholder')) { el.setAttribute(k, keyLabel(v)); continue; }
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(keyLabel(String(c))));
  }
  return el;
}

const ICONS = {
  logo: '<rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" stroke="none"/><path d="M7.500 5.500h5.800L17 9.200V18H7.500z" fill="var(--surface, #fffefc)" stroke="none"/><path d="M13.300 5.500v3.700H17z" fill="#4fc3b5" stroke="none"/><path d="M9.500 13h4.500M9.500 15.500h3" stroke="currentColor" stroke-width="1.500" opacity=".7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M10 5h8M6 19h8M14 5l-4 14"/>',
  underline: '<path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14"/>',
  strike: '<path d="M5 12h14M16 7.5C15.2 6 13.8 5 12 5c-2.2 0-4 1.2-4 3 0 1.2.8 2 2 2.5M8 16.5C8.8 18 10.2 19 12 19c2.2 0 4-1.2 4-3 0-.6-.2-1.100-.5-1.500"/>',
  ul: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.500" cy="6" r="1" fill="currentColor"/><circle cx="4.500" cy="12" r="1" fill="currentColor"/><circle cx="4.500" cy="18" r="1" fill="currentColor"/>',
  ol: '<path d="M10 6h10M10 12h10M10 18h10M4 5l1.500-1v4M3.500 13.500c0-1 2.500-1 2.500 0s-2.500 1.500-2.500 2.500H6M3.500 19.500c1 .8 2.500.2 2.500-.6 0-.7-.8-1-1.500-.9"/>',
  quote: '<path d="M6 17c0-3 1-5 3-6M6 11h3v6H6zM15 17c0-3 1-5 3-6M15 11h3v6h-3z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.500 5l-3 14"/>',
  tag: '<path d="M20.600 13.400 13.400 20.600a2 2 0 0 1-2.800 0L3 13V3h10l7.600 7.600a2 2 0 0 1 0 2.800z"/><circle cx="7.500" cy="7.500" r="1.200"/>',
  pagebreak: '<path d="M5 3v6M19 3v6M5 15v6M19 15v6"/><path d="M3 12h4M10 12h4M17 12h4"/>',
  star: '<path d="m12 3 2.700 5.600 6.100.8-4.500 4.300 1.100 6.100L12 16.800 6.600 19.800l1.100-6.100L3.200 9.400l6.100-.8z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.600"/><path d="m21 16-5-5-8 8"/>',
  hr: '<path d="M4 12h16"/><path d="M8 7h8M8 17h8" opacity=".4"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  clear: '<path d="M5 6h14M9 6V4h6v2M7 6l1 13h8l1-13M3 21l18-18" />',
  share: '<circle cx="18" cy="5" r="2.500"/><circle cx="6" cy="12" r="2.500"/><circle cx="18" cy="19" r="2.500"/><path d="m8.200 10.800 7.600-4.600M8.200 13.200l7.600 4.600"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.700L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
  more: '<circle cx="5" cy="12" r="1.500" fill="currentColor"/><circle cx="12" cy="12" r="1.500" fill="currentColor"/><circle cx="19" cy="12" r="1.500" fill="currentColor"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  comment: '<path d="M21 12a8 8 0 0 1-11.600 7.100L4 20l1-4.600A8 8 0 1 1 21 12z"/><path d="M8.500 11h7M8.500 14h4"/>',
  outline: '<path d="M4 6h16M8 12h12M12 18h8"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.700L3 8"/><path d="M3 3v5h5"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>',
  alignLeft: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  alignCenter: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  alignRight: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  alignJustify: '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
  checklist: '<rect x="3.500" y="4.500" width="5" height="5" rx="1"/><path d="m4.500 7 1 1 2-2.200M12 7h8M12 17h8"/><rect x="3.500" y="14.500" width="5" height="5" rx="1"/>',
  indent: '<path d="M4 6h16M10 10h10M10 14h10M4 18h16M4 9.500l3 2.500-3 2.500z"/>',
  outdent: '<path d="M4 6h16M10 10h10M10 14h10M4 18h16M7 9.500 4 12l3 2.500z"/>',
  sub: '<path d="m4 6 8 9M12 6l-8 9"/><path d="M17 17.500h4v-1.500c0-1-4-1-4 0M17 21h4"/>',
  sup: '<path d="m4 8 8 9M12 8l-8 9"/><path d="M17 8.500h4V7c0-1-4-1-4 0M17 12h4"/>',
  textcolor: '<path d="M6 17 12 4l6 13M8.200 13h7.600"/>',
  highlight: '<path d="m9 11 4 4 6-6-4-4zM9 11l-3.500 3.500V18h4L13 15M4 21h6"/>',
  find: '<circle cx="10" cy="10" r="6"/><path d="m20 20-5.500-5.500"/>',
  omega: '<path d="M5 19h4v-2.500C6.500 15 5 12.500 5 10a7 7 0 0 1 14 0c0 2.500-1.500 5-4 6.500V19h4"/>',
  spacing: '<path d="M10 6h10M10 12h10M10 18h10M5 5v14M3 7l2-2 2 2M3 17l2 2 2-2"/>',
  minus: '<path d="M5 12h14"/>',
  stats: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  file: '<path d="M14 3v4h4M6 3h8l4 4v14H6z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.900 4.900l1.400 1.400M17.700 17.700l1.400 1.400M2 12h2M20 12h2M4.900 19.100l1.400-1.400M17.700 6.300l1.400-1.400"/>',
  moon: '<path d="M20 14.500A8 8 0 1 1 9.500 4a6.500 6.500 0 0 0 10.500 10.500z"/>',
  auto: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  users: '<circle cx="9" cy="8" r="3.500"/><path d="M2.500 20a6.500 6.500 0 0 1 13 0M16 4.500a3.500 3.500 0 0 1 0 7M18 14a6.500 6.500 0 0 1 3.500 6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  eye: '<path d="M2 12s3.500-7 10-7 10 7 10 7-3.500 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  alert: '<path d="M12 3 2 20h20zM12 10v4M12 17.500v.01"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  print: '<path d="M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z"/>',
};
// stroke is scaled so every icon renders with the same ~1.7px line whatever its size
export function icon(name, size = 18) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${(1.7 * 24 / Math.max(size, 12)).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

// ---- Toasts -------------------------------------------------------------------------
export function toast(message, kind = 'info', ms = 3800, action = null) {
  const host = document.getElementById('toasts');
  const close = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); };
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, h('span', {}, message),
    action && h('button', { class: 'toast-action', type: 'button', onclick: () => { close(); action.onClick(); } }, action.label));
  host.append(el);
  while (host.children.length > 3) host.firstElementChild.remove(); // never a tall stack
  requestAnimationFrame(() => el.classList.add('show'));
  // A toast stays while the pointer or keyboard focus is on it (WCAG 2.2.1), and restarts its timer afterwards
  let timer = setTimeout(close, action ? Math.max(ms, 7000) : ms);
  const hold = () => clearTimeout(timer), release = () => { timer = setTimeout(close, 2500); };
  el.addEventListener('pointerenter', hold); el.addEventListener('pointerleave', release); el.addEventListener('focusin', hold); el.addEventListener('focusout', release);
}

// ---- Dialogs (accessible <dialog>, no window.confirm/prompt) -------------------------
let dialogCount = 0;
export function openDialog({ title, body, actions = [], wide = false, onClose }) {
  const titleId = `dlg-title-${++dialogCount}`;
  const dlg = h('dialog', { class: `dialog${wide ? ' wide' : ''}`, 'aria-labelledby': titleId });
  const opener = document.activeElement; // return focus here when the dialog goes away
  const restoreFocus = () => { if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true }); };
  const finish = (value) => { dlg.close(); dlg.remove(); restoreFocus(); if (onClose) onClose(value); };
  dlg.addEventListener('cancel', () => { dlg.remove(); restoreFocus(); if (onClose) onClose(undefined); });
  // Only a press that STARTED on the backdrop closes the dialog (dragging a text selection out of a field must not discard it)
  let pressedBackdrop = false;
  dlg.addEventListener('pointerdown', (e) => { pressedBackdrop = e.target === dlg; });
  dlg.addEventListener('click', (e) => { if (e.target === dlg && pressedBackdrop) finish(undefined); pressedBackdrop = false; });
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => finish(undefined) }, icon('close'));
  dlg.append(h('div', { class: 'dialog-head' }, h('h2', { id: titleId }, title), closeBtn), h('div', { class: 'dialog-body' }, body));
  if (actions.length) {
    dlg.append(h('div', { class: 'dialog-actions' }, actions.map((a) => h('button', { class: `btn ${a.kind || ''}`, type: 'button', onclick: () => a.onClick ? a.onClick(finish) : finish(a.value) }, a.label))));
  }
  document.body.append(dlg);
  dlg.showModal();
  // land on the first real field (or [autofocus]), not on the header close button
  const first = dlg.querySelector('[autofocus]') || dlg.querySelector('.dialog-body input:not([type="hidden"]):not([readonly]), .dialog-body select, .dialog-body textarea');
  if (first) first.focus({ preventScroll: true });
  return { dlg, close: finish };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const d = openDialog({
      title, body: h('p', {}, message),
      actions: [{ label: 'Cancel', value: false }, { label: confirmLabel, kind: danger ? 'danger solid' : 'primary', value: true }],
      onClose: (v) => resolve(v === true),
    });
    d.dlg.querySelector('.dialog-actions .btn:last-child').focus();
  });
}

export function promptDialog({ title, label, value = '', confirmLabel = 'OK', maxLength = 200 }) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, maxLength, required: true, 'aria-label': label });
    const form = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) d.close(input.value.trim()); } }, h('label', {}, label, input));
    const d = openDialog({
      title, body: form,
      actions: [{ label: 'Cancel', value: null }, { label: confirmLabel, kind: 'primary', onClick: () => form.requestSubmit() }],
      onClose: (v) => resolve(typeof v === 'string' ? v : null),
    });
    input.focus(); input.select();
  });
}

// ---- Formatting -------------------------------------------------------------------------
const rtf = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;
export function parseTs(ts) { return new Date(String(ts).replace(' ', 'T') + 'Z'); }
export function timeAgo(ts) {
  const d = parseTs(ts);
  if (isNaN(d)) return '';
  const s = Math.round((d - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'just now';
  if (!rtf) return d.toLocaleString();
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(s / 86400), 'day');
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}
export function fullTime(ts) { const d = parseTs(ts); return isNaN(d) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
export function initials(name) { return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
export function avatarClass(seed) { let n = 0; for (const c of String(seed)) n = (n * 31 + c.charCodeAt(0)) >>> 0; return `av-${n % 8}`; }
export function avatar(name, size = '') { return h('span', { class: `avatar ${avatarClass(name)} ${size}`, title: name, 'aria-label': name }, initials(name)); }
export function debounce(fn, ms) { let t; const f = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; f.cancel = () => clearTimeout(t); return f; }
export function pluralize(n, one, many = `${one}s`) { return `${n} ${n === 1 ? one : many}`; }

// One implementation of the menu-button pattern: aria-expanded, focus into the menu, arrow keys, Escape, Tab.
export function wireMenu(btn, menu, { beforeOpen } = {}) {
  const items = () => [...menu.querySelectorAll('[role="menuitem"]:not([disabled])')];
  const sync = () => btn.setAttribute('aria-expanded', String(!menu.hidden));
  const close = (refocus) => { menu.hidden = true; sync(); if (refocus) btn.focus(); };
  const open = (focusFirst) => { if (beforeOpen) beforeOpen(); menu.hidden = false; sync(); if (focusFirst) { const i = items(); if (i[0]) i[0].focus(); } };
  btn.addEventListener('click', (e) => { e.stopPropagation(); if (menu.hidden) open(false); else close(false); });
  btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); open(true); } });
  menu.addEventListener('keydown', (e) => {
    const list = items(); const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); } else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
  });
  new MutationObserver(sync).observe(menu, { attributes: true, attributeFilter: ['hidden'] });
  sync();
}
