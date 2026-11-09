import { h, icon, avatar, toast, timeAgo, fullTime, parseTs, openDialog } from '../dom.js';
import { Api } from '../api.js';

// Slide-in version history panel. Clicking a version previews it in the editor;
// restoring creates a new version (history is never rewritten).
export function openHistory({ host, doc, canRestore, onPreview, onRestore, onClose }) {
  let versions = [];
  let selected = null;
  const list = h('ul', { class: 'versions' });
  const opener = document.activeElement;
  const panel = h('aside', { class: 'history', 'aria-label': 'Version history', onkeydown: (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { e.stopPropagation(); api.close(); } } },
    h('div', { class: 'history-head' }, h('h2', {}, 'Version history'), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close history', onclick: () => api.close() }, icon('close'))),
    h('p', { class: 'muted small pad' }, 'Click a version to preview it. Restoring keeps the full history.'),
    list);
  host.append(panel);
  host.classList.add('with-panel');
  requestAnimationFrame(() => panel.classList.add('open'));

  const dayLabel = (ts) => {
    const d = parseTs(ts); if (isNaN(d)) return '';
    const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
    const same = (a, b) => a.toDateString() === b.toDateString();
    return same(d, today) ? 'Today' : same(d, y) ? 'Yesterday' : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  };
  const clock = (ts) => { const d = parseTs(ts); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };

  function draw() {
    const rows = [];
    let group = null;
    versions.forEach((v, i) => {
      const current = i === 0;
      const label = dayLabel(v.updated_at);
      if (label !== group) { group = label; rows.push(h('li', { class: 'vgroup', role: 'presentation' }, label)); }
      const btn = h('button', { class: `version ${selected === v.id ? 'selected' : ''}`, type: 'button', 'aria-current': selected === v.id ? 'true' : undefined, title: `Version ${v.version} · ${fullTime(v.updated_at)}`,
        onclick: async () => {
          if (current) { selected = null; draw(); onPreview(null, true); return; }
          try { const full = await Api.version(doc.id, v.id); selected = v.id; draw(); onPreview(full, false); } catch (e) { toast(e.message, 'error'); }
        } },
        avatar(v.author_name || '?', 'sm'),
        h('div', { class: 'ver-main' },
          h('strong', {}, v.label ? v.label : current ? `${clock(v.updated_at)} · Current version` : clock(v.updated_at)),
          h('span', { class: 'muted small' }, v.label ? `${clock(v.updated_at)} · ` : '', `${v.author_name || 'Unknown'}`),
          v.title && v.title !== doc.title && h('span', { class: 'muted small clip' }, `Renamed: ${v.title}`)),
        null);
      const nameBtn = canRestore() ? h('button', { class: 'icon-btn ver-name', type: 'button', title: v.label ? 'Rename or remove the name' : 'Name this version', 'aria-label': v.label ? `Rename version ${v.version}` : `Name version ${v.version}`, onclick: () => nameVersion(v) }, icon('tag', 15)) : null;
      rows.push(h('li', { class: 'ver-row' }, btn, nameBtn));
    });
    list.replaceChildren(...rows);
    if (!versions.length) list.append(h('li', { class: 'empty-panel' }, icon('history', 28), h('strong', {}, 'No versions yet'), h('p', { class: 'muted small' }, 'Versions appear as you edit. You can name important ones, preview them and restore.')));
  }

  function nameVersion(v) {
    const input = h('input', { type: 'text', value: v.label || '', maxLength: 80, 'aria-label': 'Version name', placeholder: 'e.g. Sent to legal' });
    const save = async (name, finish) => {
      try { versions = await Api.labelVersion(doc.id, v.id, name); draw(); finish(true); toast(name ? 'Version named' : 'Name removed', 'success', 1800); } catch (e) { toast(e.message, 'error'); }
    };
    const form = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) save(input.value.trim(), d.close); } }, h('label', {}, 'Name', input), h('p', { class: 'muted small' }, 'Named versions are kept permanently and are never merged with later edits.'));
    const d = openDialog({ title: v.label ? 'Rename version' : 'Name this version', body: form, actions: [
      { label: 'Cancel', value: null },
      ...(v.label ? [{ label: 'Remove name', kind: 'danger', onClick: (finish) => save('', finish) }] : []),
      { label: 'Save', kind: 'primary', onClick: () => form.requestSubmit() }] });
    input.focus(); input.select();
  }
  async function refresh() {
    try { versions = await Api.versions(doc.id); draw(); } catch (e) { toast(e.message, 'error'); }
  }
  const api = {
    refresh, restore: onRestore, select: (id) => { selected = id; draw(); },
    close(silent) { panel.classList.remove('open'); host.classList.remove('with-panel'); setTimeout(() => panel.remove(), 200); if (panel.contains(document.activeElement) && opener && opener.isConnected) opener.focus(); onClose(); },
  };
  refresh();
  return api;
}
