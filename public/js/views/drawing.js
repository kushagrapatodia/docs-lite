import { h, openDialog } from '../dom.js';

// Insert > Drawing: a small canvas that is flattened to a PNG and inserted through the normal picture pipeline
// (so resizing, limits, alt text, Word export and view links all behave exactly like any other picture).
const COLORS = ['#111827', '#dc2626', '#d97706', '#16a34a', '#2563eb', '#7c3aed'];

export function openDrawing({ onSave }) {
  const W = 640, H = 360;
  const canvas = h('canvas', { class: 'draw-canvas', width: W, height: H, role: 'img', 'aria-label': 'Drawing area' });
  const ctx = canvas.getContext('2d');
  let strokes = [], redo = [], cur = null, color = COLORS[0], width = 4, tool = 'pen';

  function paint() {
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    for (const s of strokes) drawStroke(s);
    if (cur) drawStroke(cur);
  }
  function drawStroke(s) {
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = s.width; ctx.strokeStyle = s.tool === 'eraser' ? '#fff' : s.color;
    if (s.tool === 'highlighter') { ctx.globalAlpha = 0.35; ctx.lineWidth = s.width * 4; }
    ctx.beginPath();
    const p = s.points;
    if (p.length === 1) { ctx.arc(p[0][0], p[0][1], ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fillStyle = ctx.strokeStyle; ctx.fill(); }
    else { ctx.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length - 1; i++) { const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2; ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my); } ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]); ctx.stroke(); }
    ctx.restore();
  }
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)]; };
  canvas.style.touchAction = 'none'; // otherwise the browser steals the gesture for scrolling
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); cur = { tool, color, width, points: [pos(e)] }; redo = []; paint(); });
  canvas.addEventListener('pointermove', (e) => { if (!cur) return; for (const ev of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) cur.points.push(pos(ev)); paint(); });
  const end = () => { if (cur) { strokes.push(cur); if (strokes.length > 500) strokes.shift(); cur = null; paint(); } };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);

  const toolBtn = (id, label) => h('button', { class: 'btn sm', type: 'button', 'aria-pressed': String(tool === id), onclick: (e) => { tool = id; tools.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); }, 'data-tool': id }, label);
  const tools = h('div', { class: 'draw-tools' },
    toolBtn('pen', 'Pen'), toolBtn('highlighter', 'Highlighter'), toolBtn('eraser', 'Eraser'),
    ...COLORS.map((c) => h('button', { class: 'swatch', type: 'button', 'aria-label': `Colour ${c}`, title: c, onclick: () => { color = c; if (tool === 'eraser') tool = 'pen'; }, style: `background:${c}` })),
    h('label', { class: 'small muted' }, 'Size ', h('input', { type: 'range', min: 1, max: 24, value: width, 'aria-label': 'Stroke size', oninput: (e) => { width = Number(e.target.value); } })),
    h('button', { class: 'btn sm', type: 'button', onclick: () => { const s = strokes.pop(); if (s) redo.push(s); paint(); } }, 'Undo'),
    h('button', { class: 'btn sm', type: 'button', onclick: () => { const s = redo.pop(); if (s) strokes.push(s); paint(); } }, 'Redo'),
    h('button', { class: 'btn sm', type: 'button', onclick: () => { strokes = []; redo = []; paint(); } }, 'Clear'));
  paint();
  const d = openDialog({ title: 'Drawing', wide: true, body: h('div', { class: 'stack' }, tools, canvas, h('p', { class: 'muted small' }, 'The drawing is inserted as a picture.')),
    actions: [{ label: 'Cancel', value: null }, { label: 'Insert drawing', kind: 'primary', onClick: (finish) => {
      if (!strokes.length) { finish(null); return; }
      canvas.toBlob((blob) => { finish(true); if (blob) onSave(new File([blob], 'Drawing.png', { type: 'image/png' })); }, 'image/png');
    } }] });
  return d;
}
