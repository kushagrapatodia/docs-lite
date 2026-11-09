// Service worker: the app shell opens offline, and documents you have opened can be read offline.
// Edits made offline are kept by the editor (draft recovery) and saved when the connection returns.
const SHELL = 'docs-lite-shell-v2'; // bump on every deploy that changes the app files
const API = 'docs-lite-api'; // cleared on sign-out by the page

self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/css/styles.css', '/js/main.js', '/favicon.svg']).catch(() => {}))); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('docs-lite-shell-') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const cacheable = (url) => /^\/api\/documents(\/\d+)?$/.test(url.pathname);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith('/events') || url.pathname === '/metrics' || url.pathname === '/healthz' || url.pathname === '/readyz') return;
  if (url.pathname.startsWith('/api/')) {
    if (!cacheable(url)) return; // sessions, exports, trash...: always live
    e.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(API).then((c) => c.put(req, copy)); } return res; })
      .catch(() => caches.open(API).then((c) => c.match(req)).then((hit) => hit || new Response(JSON.stringify({ error: 'You are offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))));
    return;
  }
  // static files: answer from cache at once, refresh in the background (stale-while-revalidate); pages fall back to the cached shell
  if (/\.(js|css)$/.test(url.pathname)) { // scripts and styles: network first, so a deploy is never one version behind; cache only when offline
    e.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); } return res; }).catch(() => caches.open(SHELL).then((c) => c.match(req, { ignoreSearch: true })).then((hit) => hit || Response.error())));
    return;
  }
  e.respondWith(caches.open(SHELL).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || (req.mode === 'navigate' ? c.match('/') : Response.error());
  }));
});
