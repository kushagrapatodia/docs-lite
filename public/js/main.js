import { renderPublic } from './views/public.js';
import { h, icon, avatar, toast } from './dom.js';
import { Api } from './api.js';
import { renderAuth } from './views/auth.js';
import { renderList } from './views/list.js';
import { renderEditor } from './views/editor.js';

const view = document.getElementById('view');
const userbox = document.getElementById('userbox');
let user = null;
let cleanup = null;
let navToken = 0;

// ---- theme (auto / light / dark) ---------------------------------------------------------------
const THEMES = ['auto', 'light', 'dark'];
let theme = 'auto';
try { theme = THEMES.includes(localStorage.getItem('theme')) ? localStorage.getItem('theme') : 'auto'; } catch { /* storage unavailable */ }
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Same-document view transition where supported (progressive enhancement; skipped for reduced motion).
function withTransition(fn) {
  if (!document.startViewTransition || document.hidden || reducedMotion()) return fn();
  try { const t = document.startViewTransition(fn); t.ready.catch(() => {}); t.finished.catch(() => {}); return t.updateCallbackDone.catch(() => {}); } catch { return fn(); } // a skipped transition must not surface as an error
}
function applyTheme() {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
}
applyTheme();

function drawUserbox() {
  userbox.replaceChildren();
  const themeBtn = h('button', { class: 'btn ghost sm theme-btn', type: 'button', title: `Theme: ${theme}`, 'aria-label': `Switch theme (currently ${theme})`, onclick: () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; withTransition(() => { applyTheme(); drawUserbox(); }); toast(`Theme: ${{ auto: 'match system', light: 'light', dark: 'dark' }[theme]}`, 'info', 1500); } }, icon(theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'auto'), h('span', { class: 'theme-label' }, { auto: 'Auto', light: 'Light', dark: 'Dark' }[theme]));
  userbox.append(themeBtn);
  if (!user) return;
  userbox.append(
    h('span', { class: 'whoami' }, avatar(user.display_name, 'sm'), h('span', { class: 'whoami-name' }, user.display_name)),
    h('button', { class: 'btn ghost', type: 'button', onclick: logout }, 'Sign out'));
}

async function logout() {
  if (cleanup) { await cleanup(); cleanup = null; }
  try { await Api.logout(); } catch { /* ignore */ }
  user = null; location.hash = '#/';
  drawUserbox(); route();
}

export function navigate(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function editorSkeleton() {
  const line = (w) => h('i', { style: `width:${w}%` });
  return h('div', { class: 'editor-view is-loading', role: 'status', 'aria-label': 'Opening document' },
    h('div', { class: 'skel-head skeleton' }, h('i', { style: 'width:40%' }), h('i', { style: 'width:18%' })),
    h('div', { class: 'skel-toolbar skeleton' }, h('i', { style: 'width:70%' })),
    h('div', { class: 'paper-wrap' }, h('div', { class: 'paper skeleton skel-paper' }, [92, 80, 88, 60, 90, 84, 52, 70].map(line))));
}
let firstRoute = true;
async function route() {
  try {
    if (firstRoute) { firstRoute = false; return await routeNow(); }
    return await withTransition(() => routeNow());
  } catch (e) { // error boundary: a view that throws must not leave a skeleton on screen
    console.error(e);
    view.removeAttribute('aria-busy');
    view.replaceChildren(h('div', { class: 'empty', style: 'margin:12vh auto;max-width:440px' }, h('h2', {}, 'Something went wrong'), h('p', { class: 'muted' }, 'Reload the page to continue.'), h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Reload')));
  }
}
async function routeNow() {
  const token = ++navToken;
  if (cleanup) { const c = cleanup; cleanup = null; await c(); }
  if (token !== navToken) return;
  if (!user) {
    try { user = await Api.session(); } catch { user = null; }
    drawUserbox();
  }
  if (token !== navToken) return;
  const pub = location.hash.match(/^#\/view\/([A-Za-z0-9_-]{16,64})$/);
  if (pub) { // "anyone with the link" pages need no account
    document.body.dataset.view = 'public';
    cleanup = renderPublic(view, { token: pub[1], signedIn: Boolean(user) });
    view.focus({ preventScroll: true });
    return;
  }
  if (!user) {
    document.body.dataset.view = 'auth';
    renderAuth(view, { onAuthed: (u) => { user = u; drawUserbox(); route(); } });
    return;
  }
  const m = location.hash.match(/^#\/doc\/(\d+)$/);
  if (m) {
    document.body.dataset.view = 'editor';
    // slow opens show a placeholder page (only after 120 ms, so fast opens never flash)
    const skel = setTimeout(() => { if (token === navToken) { view.setAttribute('aria-busy', 'true'); view.replaceChildren(editorSkeleton()); } }, 120);
    const c = await renderEditor(view, { id: Number(m[1]), user, navigate, isCurrent: () => token === navToken });
    clearTimeout(skel); view.removeAttribute('aria-busy');
    if (token !== navToken) { await c(); return; }
    cleanup = c;
  } else {
    if (location.hash && location.hash !== '#/') history.replaceState(null, '', '#/'); // unknown route: show the list and tidy the URL
    document.body.dataset.view = 'list';
    document.title = 'Docs Lite';
    cleanup = renderList(view, { user, navigate });
  }
  view.focus({ preventScroll: true });
}

let expiring = false;
window.addEventListener('session-expired', async () => {
  if (expiring || !user) return;
  expiring = true;
  toast('Your session expired. Please sign in again; your unsaved changes are kept.', 'error', 6000);
  user = null;
  drawUserbox();
  await route();
  expiring = false;
});
window.addEventListener('hashchange', route);
document.getElementById('brand').addEventListener('click', (e) => { e.preventDefault(); navigate('#/'); });
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); toast('Something went wrong. Please try again.', 'error'); });
route();

// Offline support: only on secure origins (localhost counts) and never in the in-browser test page.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const reg = () => navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker not registered:', e.message));
  if (document.readyState === 'complete') reg(); else window.addEventListener('load', reg);
}
