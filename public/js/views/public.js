import { h, icon, timeAgo } from '../dom.js';
import { Api } from '../api.js';
import { illustration } from './list.js';
import { applyPrintStyles, removePrintStyles } from '../pagesetup.js';

// Read-only page for "anyone with the link" documents. No sign-in; the server decides what the token may see.
export function renderPublic(view, { token, signedIn }) {
  view.replaceChildren(h('div', { class: 'public-view', role: 'status', 'aria-label': 'Loading document' }, h('div', { class: 'paper' }, h('div', { class: 'skeleton', style: 'border:0;box-shadow:none' }, h('i'), h('i'), h('i'), h('i')))));
  let alive = true;
  Api.publicDoc(token).then((doc) => {
    if (!alive) return;
    document.title = `${doc.title} · Docs Lite`;
    if (doc.settings) applyPrintStyles(doc.settings);
    const page = h('article', { class: 'page prose', 'aria-label': doc.title });
    page.innerHTML = doc.content; // already sanitised by the server (allow-list, no scripts, no remote resources)
    const h1 = page.querySelector('h1'); if (h1 && h1.textContent.trim() === doc.title.trim() && page.firstElementChild === h1) h1.remove(); // the title is already in the header
    for (const a of page.querySelectorAll('a')) { if ((a.getAttribute('href') || '').startsWith('#')) continue; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; }
    page.addEventListener('click', (e) => { // table-of-contents links scroll instead of changing the route
      const a = e.target.closest('a');
      const href = a && a.getAttribute('href');
      if (href && href.startsWith('#')) { e.preventDefault(); const t = page.querySelector(`[id="${CSS.escape(href.slice(1))}"]`); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
    view.replaceChildren(h('div', { class: 'public-view' },
      h('div', { class: 'public-head' },
        h('div', {}, h('h1', { class: 'public-title' }, doc.title), h('p', { class: 'muted small' }, icon('eye', 13), ` Read-only · shared by ${doc.owner_name}${doc.updated_at ? ` · updated ${timeAgo(doc.updated_at)}` : ''}`)),
        h('div', { class: 'public-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'Print'),
          h('a', { class: 'btn primary', href: '#/' }, signedIn ? 'Open Docs Lite' : 'Sign in'))),
      h('div', { class: 'paper-wrap' }, h('div', { class: 'paper' }, page)),
      !signedIn && h('p', { class: 'public-foot muted small' }, 'Made with Docs Lite. ', h('a', { href: '#/' }, 'Create your own documents'))));
  }).catch((e) => {
    if (!alive) return;
    document.title = 'Docs Lite';
    view.replaceChildren(h('div', { class: 'public-view' }, h('div', { class: 'empty-state' }, illustration('broken'), h('h1', {}, 'Link not available'), h('p', { class: 'muted' }, e.status === 404 ? 'This link was turned off, replaced or the document was deleted. Ask the owner for a new one.' : e.message), h('a', { class: 'btn primary', href: '#/' }, 'Go to Docs Lite'))));
  });
  return () => { alive = false; removePrintStyles(); };
}
