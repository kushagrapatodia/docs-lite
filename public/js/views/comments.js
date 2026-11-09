import { h, icon, avatar, toast, timeAgo, fullTime, confirmDialog } from '../dom.js';
import { Api } from '../api.js';

// Slide-in comments panel. Comment text is always rendered with textContent (never HTML).
export function openComments({ host, doc, user, getRole, onCount, onClose, onJump, onData = () => {} }) {
  let comments = [];
  let showResolved = false;
  let quote = '';
  const quoteChip = h('div', { class: 'quote-chip', hidden: true });
  const list = h('ul', { class: 'comments', 'aria-live': 'polite' });
  const box = h('textarea', { class: 'composer-input', rows: 3, maxLength: 2000, placeholder: 'Add a comment…', 'aria-label': 'Write a comment' });
  const send = h('button', { class: 'btn primary sm', type: 'button', onclick: submit }, 'Comment');
  const count = h('span', { class: 'muted small' });
  const toggle = h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { showResolved = e.target.checked; draw(); } }), 'Show resolved');
  const opener = document.activeElement;
  const panel = h('aside', { class: 'history comments-panel', 'aria-label': 'Comments', onkeydown: (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { e.stopPropagation(); api.close(); } } },
    h('div', { class: 'history-head' }, h('h2', {}, 'Comments'), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close comments', onclick: () => api.close() }, icon('close'))),
    h('div', { class: 'pad row-between' }, count, toggle),
    list,
    h('div', { class: 'composer' }, quoteChip, box, h('div', { class: 'row-between' }, h('span', { class: 'muted small' }, 'Ctrl+Enter to send'), send)));
  host.append(panel);
  host.classList.add('with-panel');
  requestAnimationFrame(() => panel.classList.add('open'));
  box.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); } });

  const topLevel = () => comments.filter((c) => !c.parent_id);
  const unresolved = () => topLevel().filter((c) => !c.resolved).length;
  let replyingTo = null; // id of the thread whose reply box is open
  let replyDraft = ''; // survives redraws caused by other people's comments
  let focusReply = false;
  function replyBox(c) {
    const ta = h('textarea', { class: 'composer-input', rows: 2, maxLength: 2000, placeholder: 'Reply…', 'aria-label': 'Write a reply' });
    const go = h('button', { class: 'btn primary sm', type: 'button', onclick: () => sendReply(c, ta, go) }, 'Reply');
    ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendReply(c, ta, go); } else if (e.key === 'Escape') { replyingTo = null; replyDraft = ''; draw(); } });
    ta.value = replyDraft;
    ta.addEventListener('input', () => { replyDraft = ta.value; });
    if (focusReply) { focusReply = false; setTimeout(() => ta.focus(), 0); }
    return h('div', { class: 'reply-box' }, ta, h('div', { class: 'row-end' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { replyingTo = null; replyDraft = ''; draw(); } }, 'Cancel'), go));
  }
  async function sendReply(c, ta, go) {
    const body = ta.value.trim();
    if (!body) { ta.focus(); return; }
    go.disabled = true;
    try { comments.push(await Api.addComment(doc.id, body, undefined, c.id)); replyingTo = null; replyDraft = ''; draw(); }
    catch (e) { toast(e.message, 'error'); go.disabled = false; }
  }
  function draw() {
    const shown = topLevel().filter((c) => showResolved || !c.resolved);
    const role = getRole();
    const keepScroll = list.scrollTop;
    const replyFocused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.reply-box') && list.contains(document.activeElement);
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const delBtn = (c) => (c.author_id === user.id || role === 'owner') && h('button', { class: 'link-btn danger-text', type: 'button', onclick: () => remove(c) }, 'Delete');
    list.replaceChildren(...shown.map((c) => {
      const replies = comments.filter((r) => r.parent_id === c.id);
      const actions = h('div', { class: 'c-actions' },
        h('button', { class: 'link-btn', type: 'button', onclick: () => { replyingTo = replyingTo === c.id ? null : c.id; replyDraft = ''; focusReply = replyingTo !== null; draw(); } }, replies.length ? `Reply (${replies.length})` : 'Reply'),
        (role === 'owner' || role === 'editor') && h('button', { class: 'link-btn', type: 'button', onclick: () => toggleResolved(c) }, c.resolved ? 'Reopen' : 'Resolve'),
        delBtn(c));
      return h('li', { class: `comment${c.resolved ? ' resolved' : ''}` }, avatar(c.author_name, 'sm'),
        h('div', { class: 'c-main' },
          h('div', { class: 'c-head' }, h('strong', {}, c.author_name), h('span', { class: 'muted small', title: fullTime(c.created_at) }, timeAgo(c.created_at)), c.resolved && h('span', { class: 'pill' }, 'Resolved')),
          c.quote && h('button', { class: 'c-quote', type: 'button', title: 'Show this passage in the document', onclick: () => onJump(c.quote) }, c.quote),
          h('p', { class: 'c-body' }, c.body),
          replies.length ? h('ul', { class: 'replies' }, replies.map((r) => h('li', { class: 'reply' }, avatar(r.author_name, 'sm'),
            h('div', { class: 'c-main' }, h('div', { class: 'c-head' }, h('strong', {}, r.author_name), h('span', { class: 'muted small', title: fullTime(r.created_at) }, timeAgo(r.created_at))),
              h('p', { class: 'c-body' }, r.body), h('div', { class: 'c-actions' }, delBtn(r)))))) : null,
          actions, replyingTo === c.id ? replyBox(c) : null));
    }));
    if (!shown.length) list.append(h('li', { class: 'empty-panel' }, topLevel().length && !showResolved ? h('p', { class: 'muted' }, 'All comments are resolved.') : [icon('comment', 28), h('strong', {}, 'No comments yet'), h('p', { class: 'muted small' }, 'Select some text and press Ctrl+Alt+M to comment on it, or write a general comment below.')]));
    count.textContent = `${unresolved()} open`;
    onCount(unresolved());
    onData(comments);
    list.scrollTop = atBottom ? list.scrollHeight : keepScroll;
    if (replyFocused) { const t = list.querySelector('.reply-box textarea'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } } // an incoming comment must not steal focus from a reply being typed
  }

  function setQuote(text) {
    quote = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    quoteChip.hidden = !quote;
    quoteChip.replaceChildren(...(quote ? [h('span', { class: 'muted small' }, 'Commenting on'), h('q', {}, quote), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove quote', onclick: () => setQuote('') }, icon('close', 14))] : []));
  }

  async function load() { try { comments = await Api.comments(doc.id); draw(); } catch (e) { toast(e.message, 'error'); } }
  async function submit() {
    const body = box.value.trim();
    if (!body) { box.focus(); return; }
    send.disabled = true;
    try { comments.push(await Api.addComment(doc.id, body, quote || undefined)); box.value = ''; setQuote(''); draw(); }
    catch (e) { toast(e.message, 'error'); }
    send.disabled = false; box.focus();
  }
  async function toggleResolved(c) {
    try { const u = await Api.resolveComment(doc.id, c.id, !c.resolved); Object.assign(c, u); draw(); } catch (e) { toast(e.message, 'error'); }
  }
  async function remove(c) {
    if (!(await confirmDialog({ title: c.parent_id ? 'Delete reply?' : 'Delete comment?', message: c.parent_id ? 'This cannot be undone.' : 'The comment and all its replies will be deleted. This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
    try { await Api.deleteComment(doc.id, c.id); comments = comments.filter((x) => x.id !== c.id && x.parent_id !== c.id); draw(); } catch (e) { toast(e.message, 'error'); }
  }

  const api = {
    // live events from other collaborators
    onEvent(d) {
      if (d.type === 'added') { if (!comments.some((c) => c.id === d.comment.id)) comments.push(d.comment); }
      else if (d.type === 'updated') { const c = comments.find((x) => x.id === d.comment.id); if (c) Object.assign(c, d.comment); }
      else if (d.type === 'deleted') comments = comments.filter((c) => c.id !== d.comment.id && c.parent_id !== d.comment.id);
      draw();
    },
    redraw: draw,
    setQuote: (t) => { setQuote(t); box.focus(); },
    close() { panel.classList.remove('open'); host.classList.remove('with-panel'); setTimeout(() => panel.remove(), 200); if (panel.contains(document.activeElement) && opener && opener.isConnected) opener.focus(); onClose(); },
  };
  load();
  box.focus();
  return api;
}
