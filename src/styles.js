'use strict';
// Strict allow-list for the inline styles the editor may store. Everything else in a style
// attribute is discarded, and every accepted value is re-serialised from a validated parse,
// so nothing the client sends can smuggle in url(), expression(), position, etc.

const FONTS = ['Arial', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas', 'Courier New', 'Garamond', 'Georgia', 'Helvetica', 'Impact', 'Palatino', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
const FONT_LOOKUP = new Map(FONTS.map((f) => [f.toLowerCase(), f]));
// Generic families map to a concrete, listed font so stored documents look the same everywhere.
const GENERIC = { serif: 'Times New Roman', 'sans-serif': 'Arial', monospace: 'Courier New', cursive: 'Comic Sans MS', fantasy: 'Impact', 'ui-serif': 'Times New Roman', 'ui-sans-serif': 'Arial', 'ui-monospace': 'Courier New', system: 'Arial' };
const SIZE_KEYWORDS = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
const FONT_SIZE_1_TO_7 = [10, 13, 16, 18, 24, 32, 48]; // legacy <font size="n">

// The CSS basic colour keywords (plus a few very common ones) so pasted web content keeps its colours.
const NAMED_COLORS = { black: '#000000', silver: '#c0c0c0', gray: '#808080', grey: '#808080', white: '#ffffff', maroon: '#800000', red: '#ff0000', purple: '#800080', fuchsia: '#ff00ff', magenta: '#ff00ff', green: '#008000', lime: '#00ff00', olive: '#808000', yellow: '#ffff00', navy: '#000080', blue: '#0000ff', teal: '#008080', aqua: '#00ffff', cyan: '#00ffff', orange: '#ffa500', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082', violet: '#ee82ee', crimson: '#dc143c', coral: '#ff7f50', salmon: '#fa8072', khaki: '#f0e68c', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightblue: '#add8e6', lightgreen: '#90ee90', darkblue: '#00008b', darkgreen: '#006400', darkred: '#8b0000' };

const hex2 = (n) => n.toString(16).padStart(2, '0');

function normColor(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{8}$/.test(v)) return v.slice(0, 7); // alpha is ignored
  const m = v.match(/^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*(\d*\.?\d+%?)\s*)?\)$/);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if (r > 255 || g > 255 || b > 255) return null;
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null; // fully transparent
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  return null;
}

function normSize(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (SIZE_KEYWORDS[v]) return `${SIZE_KEYWORDS[v]}px`;
  const m = v.match(/^(\d{1,3}(?:\.\d{1,3})?)(px|pt)$/);
  if (!m) return null;
  let px = parseFloat(m[1]) * (m[2] === 'pt' ? 4 / 3 : 1);
  if (!(px >= 6 && px <= 200)) return null;
  px = Math.round(px * 100) / 100;
  return `${px}px`;
}

function normFont(raw) {
  const first = String(raw ?? '').split(',')[0].trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
  if (FONT_LOOKUP.has(first)) return FONT_LOOKUP.get(first);
  if (GENERIC[first]) return GENERIC[first];
  return null;
}

function normAlign(raw) {
  const v = String(raw ?? '').trim().toLowerCase().replace(/^-(webkit|moz)-/, '');
  if (v === 'left' || v === 'start') return null; // the default: do not store it
  if (v === 'right' || v === 'end') return 'right';
  if (v === 'center') return 'center';
  if (v === 'justify') return 'justify';
  return null;
}

function normLineHeight(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  let n = null;
  if (/^\d*\.?\d+$/.test(v)) n = parseFloat(v);
  else if (/^\d+(\.\d+)?%$/.test(v)) n = parseFloat(v) / 100;
  if (n === null || !(n >= 0.8 && n <= 4)) return null;
  return String(Math.round(n * 100) / 100);
}

function normIndent(raw) {
  const m = String(raw ?? '').trim().toLowerCase().match(/^(\d{1,4}(?:\.\d+)?)(px|pt)$/);
  if (!m) return null;
  const px = Math.round(parseFloat(m[1]) * (m[2] === 'pt' ? 4 / 3 : 1));
  if (px <= 0 || px > 720) return null;
  return `${px}px`;
}

const INLINE = ['color', 'background-color', 'font-size', 'font-family'];
const BLOCK = ['text-align', 'line-height', 'margin-left'];

// kind: 'inline' (spans) or 'block' (paragraphs, headings, list items, cells, quotes)
function cleanStyle(raw, kind, extra = {}) {
  const found = { ...extra };
  for (const decl of String(raw ?? '').split(';')) {
    const i = decl.indexOf(':');
    if (i < 1) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    let val = decl.slice(i + 1).trim().replace(/\s*!important\s*$/i, '');
    if (/[\\@]|url\(|expression\(|var\(|calc\(|\/\*/i.test(val)) continue;
    if (kind === 'inline') {
      if (prop === 'color') { const c = normColor(val); if (c) found.color = c; }
      else if (prop === 'background-color' || prop === 'background') { const c = normColor(val); if (c) found['background-color'] = c; }
      else if (prop === 'font-size') { const z = normSize(val); if (z) found['font-size'] = z; }
      else if (prop === 'font-family') { const f = normFont(val); if (f) found['font-family'] = f; }
    } else if (kind === 'block') {
      if (prop === 'text-align') { const a = normAlign(val); if (a) found['text-align'] = a; else delete found['text-align']; }
      else if (prop === 'line-height') { const l = normLineHeight(val); if (l) found['line-height'] = l; }
      else if (prop === 'margin-left' || prop === 'padding-left') { const g = normIndent(val); if (g) found['margin-left'] = g; }
    }
  }
  const order = kind === 'inline' ? INLINE : BLOCK;
  return order.filter((p) => found[p]).map((p) => `${p}:${p === 'font-family' ? `'${found[p]}'` : found[p]}`).join(';');
}

// Legacy <font color face size> attributes -> the equivalent style declarations.
function fontTagStyle(attrs) {
  const parts = [];
  if (attrs.color) parts.push(`color:${attrs.color}`);
  if (attrs.face) parts.push(`font-family:${attrs.face}`);
  if (attrs.size && /^[1-7]$/.test(attrs.size.trim())) parts.push(`font-size:${FONT_SIZE_1_TO_7[Number(attrs.size) - 1]}px`);
  return parts.join(';');
}

module.exports = { FONTS, FONT_SIZE_1_TO_7, normColor, normSize, normFont, normAlign, normLineHeight, normIndent, cleanStyle, fontTagStyle };
