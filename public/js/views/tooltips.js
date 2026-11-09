import { keyLabel } from '../dom.js';

// Toolbar tooltips that also appear on keyboard focus and show the shortcut in a key cap.
// (The native title attribute is slow, never shows on focus and not at all on touch.)
export function attachTooltips(container) {
  let tip = null, timer = null;
  for (const el of container.querySelectorAll('[title]')) { // move title -> data-tip; keep an accessible name
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', el.getAttribute('title').replace(/\s*\([^)]*\)\s*$/, ''));
    el.dataset.tip = el.getAttribute('title'); el.removeAttribute('title');
  }
  const hide = () => { clearTimeout(timer); if (tip) { tip.remove(); tip = null; } };
  const show = (el) => {
    hide();
    const text = el.dataset.tip; if (!text) return;
    const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(text);
    tip = document.createElement('div'); tip.className = 'tt'; tip.setAttribute('role', 'tooltip');
    tip.append(document.createTextNode(m ? m[1] : text));
    if (m) { const k = document.createElement('kbd'); k.textContent = keyLabel(m[2]); tip.append(k); }
    document.body.append(tip);
    const r = el.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2))}px`;
    tip.style.top = `${r.bottom + 8 + tip.offsetHeight > innerHeight ? r.top - tip.offsetHeight - 8 : r.bottom + 8}px`;
  };
  const target = (e) => e.target.closest && e.target.closest('[data-tip]');
  container.addEventListener('pointerover', (e) => { const el = target(e); if (el && e.pointerType !== 'touch') { clearTimeout(timer); timer = setTimeout(() => show(el), 450); } });
  container.addEventListener('pointerout', hide);
  container.addEventListener('focusin', (e) => { const el = target(e); if (el && el.matches(':focus-visible')) show(el); });
  container.addEventListener('focusout', hide);
  container.addEventListener('pointerdown', hide);
  const onKey = (e) => { if (e.key === 'Escape') hide(); };
  window.addEventListener('keydown', onKey);
  const destroy = () => { hide(); window.removeEventListener('keydown', onKey); };
  hide.destroy = destroy;
  return hide;
}
