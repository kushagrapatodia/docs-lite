import { h, toast, promptDialog } from '../dom.js';

// Pictures are stored inside the document as data URLs, so they are downscaled and re-encoded
// in the browser first. The server accepts png / jpeg / gif / webp and enforces its own limits.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_SIDE = 1280;
const MAX_CHARS = 900_000; // per picture, well under the server's 1.5M cap

const readAsDataUrl = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('Could not read the image')); r.readAsDataURL(blob); });

export async function imageToDataUrl(file) {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error('Only PNG, JPEG, GIF and WebP pictures can be inserted');
  if (file.size > 15_000_000) throw new Error('That picture is too large (15 MB max)');
  if (file.type === 'image/gif') { // keep animation: no re-encoding, so it has to fit as is
    const raw = await readAsDataUrl(file);
    if (raw.length > MAX_CHARS) throw new Error('That GIF is too large to embed (about 650 KB max)');
    return raw;
  }
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('That file is not a readable picture'); }
  let scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  for (let attempt = 0; attempt < 6; attempt++) {
    const w = Math.max(1, Math.round(bitmap.width * scale)), hgt = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = hgt;
    const ctx = canvas.getContext('2d');
    if (file.type === 'image/png' && attempt === 0) { // PNG keeps transparency; fall back to JPEG when it is too big
      ctx.drawImage(bitmap, 0, 0, w, hgt);
      const png = canvas.toDataURL('image/png');
      if (png.length <= MAX_CHARS) { bitmap.close && bitmap.close(); return png; }
    }
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hgt); ctx.drawImage(bitmap, 0, 0, w, hgt);
    const jpeg = canvas.toDataURL('image/jpeg', attempt < 2 ? 0.85 : 0.7);
    if (jpeg.length <= MAX_CHARS) { bitmap.close && bitmap.close(); return jpeg; }
    scale *= 0.75;
  }
  bitmap.close && bitmap.close();
  throw new Error('Could not shrink that picture enough to embed it');
}

const WIDTHS = [['Small', 160], ['Medium', 320], ['Large', 520], ['Full width', null]];

// Picture insertion plus a contextual bar (size, alt text, remove) shown while a picture is selected.
export function createImages({ editor, getCanEdit, onEdit, restore, bar }) {
  let selected = null;
  const limitError = () => {
    const pics = editor.querySelectorAll('img').length;
    if (pics >= 20) return 'A document can hold up to 20 pictures';
    return null;
  };
  async function insert(file) {
    if (!getCanEdit()) return;
    const err = limitError();
    if (err) { toast(err, 'error'); return; }
    try {
      const src = await imageToDataUrl(file);
      if (!editor.isConnected) return; // the document was closed while the picture was being prepared
      if (editor.innerHTML.length + src.length > 2_900_000) { toast('This document is full: remove a picture first', 'error'); return; }
      restore();
      const alt = (file.name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').slice(0, 100);
      const el = document.createElement('img');
      el.src = src; if (alt) el.alt = alt;
      document.execCommand('insertHTML', false, el.outerHTML);
      onEdit();
    } catch (e) { toast(e.message || 'Could not insert the picture', 'error'); }
  }
  function select(img) {
    selected = img;
    const r = document.createRange(); r.selectNode(img);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    refresh();
  }
  function refresh() {
    if (selected && !(selected.isConnected && editor.contains(selected))) selected = null;
    if (selected) { // still selected only while the selection is exactly that picture
      const s = getSelection();
      const ok = s.rangeCount && s.getRangeAt(0).intersectsNode(selected) && editor.contains(s.anchorNode);
      if (!ok) selected = null;
    }
    bar.hidden = !selected || !getCanEdit();
    if (selected) label.textContent = selected.alt ? `Picture: ${selected.alt}` : 'Picture';
  }
  const label = h('span', { class: 'muted small imgname' }, 'Picture');
  bar.append(label,
    ...WIDTHS.map(([name, px]) => h('button', { class: 'btn sm', type: 'button', onclick: () => { if (!selected) return; if (px) selected.setAttribute('width', String(px)); else selected.removeAttribute('width'); onEdit(); } }, name)),
    h('button', { class: 'btn sm', type: 'button', onclick: async () => {
      if (!selected) return;
      const img = selected;
      const v = await promptDialog({ title: 'Picture description', label: 'Alt text (read aloud by screen readers)', value: img.alt || '', maxLength: 200 });
      if (v !== null && img.isConnected) { img.alt = v; onEdit(); refresh(); }
    } }, 'Alt text'),
    h('button', { class: 'btn sm danger', type: 'button', onclick: () => { if (!selected) return; selected.remove(); selected = null; editor.focus(); onEdit(); refresh(); } }, 'Remove'));
  editor.addEventListener('click', (e) => { if (e.target && e.target.tagName === 'IMG' && getCanEdit()) select(e.target); });
  document.addEventListener('selectionchange', refresh);
  return { insert, pick: (input) => input.click(), destroy: () => document.removeEventListener('selectionchange', refresh) };
}
