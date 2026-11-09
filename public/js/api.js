// Thin fetch wrapper. Throws ApiError with .status and .data (the parsed error body).
export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data || {}; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Creating things is made safe to retry with an Idempotency-Key (the same key for every attempt of one action).
const IDEMPOTENT_POST = /^\/api\/documents(\/import|\/\d+\/duplicate|\/\d+\/comments)?$/;

export async function api(method, url, body, { retries } = {}) {
  const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
  const safeToRetry = method === 'GET' || method === 'HEAD' || (method === 'POST' && IDEMPOTENT_POST.test(url));
  if (method === 'POST' && IDEMPOTENT_POST.test(url)) headers['Idempotency-Key'] = crypto.randomUUID();
  const max = retries ?? (safeToRetry ? 2 : 0);
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) }); // a hung request must not freeze the app
      if (![502, 503, 504].includes(res.status) || attempt >= max) break;
    } catch {
      if (attempt >= max) throw new ApiError('You appear to be offline. Check your connection and try again.', 0);
    }
    await sleep(Math.random() * Math.min(4000, 300 * 2 ** attempt)); // full-jitter exponential backoff
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !/^\/api\/(login|register|session)$/.test(url)) { window.dispatchEvent(new CustomEvent('session-expired')); try { caches.delete('docs-lite-api'); } catch { /* none */ } } // offline copies belong to the signed-in user only
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

export const Api = {
  session: async () => (await api('GET', '/api/session')).user,
  login: async (username, password) => { try { await caches.delete('docs-lite-api'); } catch { /* none */ } return api('POST', '/api/login', { username, password }); },
  register: (username, display_name, password) => api('POST', '/api/register', { username, display_name, password }),
  logout: async () => { const r = await api('POST', '/api/logout'); try { await caches.delete('docs-lite-api'); } catch { /* no cache */ } return r; }, // offline copies are private to the signed-in user
  users: () => api('GET', '/api/users'),
  list: (q = '') => api('GET', `/api/documents${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  create: (title, content) => api('POST', '/api/documents', { title, content }),
  get: (id) => api('GET', `/api/documents/${id}`),
  save: (id, patch) => api('PATCH', `/api/documents/${id}`, patch),
  remove: (id) => api('DELETE', `/api/documents/${id}`),
  trash: () => api('GET', '/api/trash'),
  restoreFromTrash: (id) => api('POST', `/api/trash/${id}/restore`),
  eraseFromTrash: (id) => api('DELETE', `/api/trash/${id}`),
  duplicate: (id) => api('POST', `/api/documents/${id}/duplicate`, {}),
  importFile: (payload) => api('POST', '/api/documents/import', payload),
  convert: (payload) => api('POST', '/api/convert', payload),
  versions: (id) => api('GET', `/api/documents/${id}/versions`),
  version: (id, vid) => api('GET', `/api/documents/${id}/versions/${vid}`),
  labelVersion: (id, vid, label) => api('PUT', `/api/documents/${id}/versions/${vid}/label`, { label }),
  restore: (id, vid) => api('POST', `/api/documents/${id}/versions/${vid}/restore`),
  star: (id, on) => api(on ? 'PUT' : 'DELETE', `/api/documents/${id}/star`),
  saveSettings: (id, settings) => api('PUT', `/api/documents/${id}/settings`, settings),
  cursor: (id, body) => fetch(`/api/documents/${id}/cursor`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}), // fire and forget: a lost cursor update is harmless
  createLink: (id) => api('POST', `/api/documents/${id}/link`),
  removeLink: (id) => api('DELETE', `/api/documents/${id}/link`),
  publicDoc: (token) => api('GET', `/api/public/${encodeURIComponent(token)}`),
  share: (id, username, role) => api('PUT', `/api/documents/${id}/shares`, { username, role }),
  unshare: (id, userId) => api('DELETE', `/api/documents/${id}/shares/${userId}`),
  comments: (id) => api('GET', `/api/documents/${id}/comments`),
  addComment: (id, body, quote, parent_id) => api('POST', `/api/documents/${id}/comments`, { body, quote, parent_id }),
  resolveComment: (id, cid, resolved) => api('PATCH', `/api/documents/${id}/comments/${cid}`, { resolved }),
  deleteComment: (id, cid) => api('DELETE', `/api/documents/${id}/comments/${cid}`),
  exportUrl: (id, format) => `/api/documents/${id}/export?format=${format}`,
};

// Read a File into the JSON payload the import endpoint expects.
export async function filePayload(file) {
  const name = file.name;
  if (/\.docx$/i.test(name)) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { filename: name, content_base64: btoa(bin) };
  }
  return { filename: name, content: await file.text() };
}
