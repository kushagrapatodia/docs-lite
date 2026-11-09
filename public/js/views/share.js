import { h, icon, avatar, toast, openDialog } from '../dom.js';
import { Api } from '../api.js';

export async function openShareDialog({ doc, flush, onChange }) {
  await flush();
  let fresh = doc;
  try { fresh = await Api.get(doc.id); } catch (e) { toast(e.message, 'error'); return; }
  let shares = fresh.shares || [];
  let users = [];
  try { users = await Api.users(); } catch { /* the datalist is optional */ }

  const list = h('ul', { class: 'people' });
  const err = h('p', { class: 'error', role: 'alert' });
  const listId = `share-users-${Math.random().toString(36).slice(2)}`;
  const userInput = h('input', { type: 'text', list: listId, placeholder: 'Username (e.g. bob)', 'aria-label': 'Username to share with', autocomplete: 'off', autocapitalize: 'none', spellcheck: false });
  const datalist = h('datalist', { id: listId }, users.map((u) => h('option', { value: u.username }, u.display_name)));
  const roleSel = h('select', { 'aria-label': 'Access level' }, h('option', { value: 'editor' }, 'Can edit'), h('option', { value: 'viewer' }, 'Can view'));
  const addBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Share');

  function draw() {
    list.replaceChildren(
      h('li', {}, avatar(fresh.owner_name), h('div', { class: 'who' }, h('strong', {}, fresh.owner_name), h('span', { class: 'muted small' }, 'You can manage sharing')), h('span', { class: 'role-pill owner' }, icon('lock', 13), 'Owner')),
      ...shares.map((s) => {
        const sel = h('select', { 'aria-label': `Access for ${s.display_name}`, onchange: async (e) => { try { shares = await Api.share(doc.id, s.username, e.target.value); onChange(shares); draw(); toast(`${s.display_name} can now ${e.target.value === 'editor' ? 'edit' : 'view'}`, 'success', 2000); } catch (x) { toast(x.message, 'error'); draw(); } } },
          h('option', { value: 'editor', selected: s.role === 'editor' }, 'Can edit'), h('option', { value: 'viewer', selected: s.role === 'viewer' }, 'Can view'));
        return h('li', {}, avatar(s.display_name), h('div', { class: 'who' }, h('strong', {}, s.display_name), h('span', { class: 'muted small' }, `@${s.username}`)), sel,
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${s.display_name}`, title: 'Remove access', onclick: async () => { try { shares = await Api.unshare(doc.id, s.user_id); onChange(shares); draw(); } catch (x) { toast(x.message, 'error'); } } }, icon('close')));
      }));
    if (!shares.length) list.append(h('li', { class: 'empty-line muted' }, 'Not shared with anyone yet.'));
  }
  draw();

  const form = h('form', { class: 'share-add', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const username = userInput.value.trim().replace(/^@/, '');
    if (!username) { err.textContent = 'Enter the username of the person to share with.'; return; }
    addBtn.disabled = true;
    try { shares = await Api.share(doc.id, username, roleSel.value); onChange(shares); userInput.value = ''; draw(); toast('Shared', 'success', 2000); }
    catch (x) { err.textContent = x.message; }
    addBtn.disabled = false; userInput.focus();
  } }, userInput, datalist, roleSel, addBtn);

  // ---- general access (like Drive): Restricted / Anyone with the link, then one Copy link button ----------------------
  let token = fresh.link_token || null;
  const publicUrl = () => `${location.origin}${location.pathname}#/view/${token}`;
  const appUrl = `${location.origin}${location.pathname}#/doc/${doc.id}`;
  const access = h('div', { class: 'general-access' });
  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch { toast(text, 'info', 8000); return; }
    const old = btn.textContent; btn.textContent = 'Copied'; btn.disabled = true; // brief confirmation, announced politely
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1500);
  }
  function drawAccess() {
    const sel = h('select', { 'aria-label': 'General access', onchange: async (e) => {
      sel.disabled = true;
      try {
        if (e.target.value === 'link') token = (await Api.createLink(doc.id)).link_token;
        else { await Api.removeLink(doc.id); token = null; }
        onChange(shares); drawAccess();
      } catch (x) { toast(x.message, 'error'); drawAccess(); }
    } }, h('option', { value: 'restricted', selected: !token }, 'Restricted'), h('option', { value: 'link', selected: Boolean(token) }, 'Anyone with the link'));
    const copyBtn = h('button', { class: 'btn', type: 'button', 'aria-live': 'polite', onclick: (e) => copyText(token ? publicUrl() : appUrl, e.currentTarget) }, 'Copy link');
    const renew = token ? h('button', { class: 'btn ghost sm', type: 'button', title: 'Make a new link; the old one stops working', onclick: async () => { try { token = (await Api.createLink(doc.id)).link_token; drawAccess(); toast('New link created. The old one no longer works.', 'success', 3000); } catch (x) { toast(x.message, 'error'); } } }, 'New link') : null;
    access.replaceChildren(
      h('h3', { class: 'ga-title' }, 'General access'),
      h('div', { class: 'ga-row' }, h('span', { class: `ga-icon${token ? ' on' : ''}`, 'aria-hidden': 'true' }, icon(token ? 'users' : 'lock', 18)),
        h('div', { class: 'ga-main' }, sel, h('span', { class: 'muted small' }, token ? 'Anyone on the internet with the link can view. No sign-in needed.' : 'Only people added above can open this document. The link needs them to sign in.')),
        h('div', { class: 'ga-actions' }, renew, copyBtn)));
  }
  drawAccess();

  const d = openDialog({
    title: `Share “${fresh.title}”`, wide: true,
    body: h('div', { class: 'stack' }, form, err, list, h('p', { class: 'muted small' }, 'Editors can change the document. Viewers can read, export and make their own copy.'), access),
    actions: [{ label: 'Done', kind: 'primary', value: true }],
  });
  userInput.focus();
}
