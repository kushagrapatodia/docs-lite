'use strict';
// Allow-list HTML sanitizer for editor content.
// Only the tags below survive. Attributes are dropped except: a vetted href on <a>, a strictly
// validated `style` (see styles.js), and the checklist markers data-type="check" / data-checked="true".
const { cleanStyle, fontTagStyle } = require('./styles');
const ALLOWED = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'div', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'font', 'sub', 'sup', 'img']);
const BLOCK_STYLED = new Set(['p', 'div', 'h1', 'h2', 'h3', 'li', 'blockquote', 'td', 'th']);
const VOID = new Set(['br', 'hr', 'img']);
const MAX_IMAGE_CHARS = 1_500_000; // one embedded image (base64 text)
const IMAGE_SRC = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_DEPTH = 40; // deeper nesting is flattened so no consumer can be recursed into a stack overflow
// Per the HTML parsing rules, these start tags implicitly close an open <p> (browsers can still hand us <p><ul>...).
const CLOSES_P = new Set(['p', 'div', 'ul', 'ol', 'h1', 'h2', 'h3', 'blockquote', 'pre', 'hr', 'table']);
// Cells and rows close the previous cell/row, like the HTML parser does.
const CELL = new Set(['td', 'th']);
// Canonical names so the stored HTML is uniform regardless of browser.
const CANON = { strong: 'b', em: 'i', strike: 's', del: 's', font: 'span' };
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|template|svg|math|noscript|textarea|select|button|form|head|title)\b[\s\S]*?<\/\1\s*>/gi;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const HEADING_ID = /^h-[a-z0-9]{4,16}$/;
function safeHref(raw) {
  const href = String(raw || '').replace(/&amp;/g, '&').trim();
  if (!href || href.length > 2000) return null;
  if (href.startsWith('#')) return HEADING_ID.test(href.slice(1)) ? href : null; // links to a heading in the same document (table of contents)
  // Strip control characters and whitespace tricks like "java\tscript:".
  const probe = href.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
  if (/[\s<>()]/.test(href)) return null; // spaces, brackets and parentheses would break Markdown and attribute contexts
  if (/^(https?:|mailto:)/.test(probe)) return href;
  return null;
}

// Only raster images embedded as base64 data URLs survive (never SVG, which can carry script, never remote URLs).
function safeImageSrc(raw) {
  const v = String(raw || '').replace(/\s+/g, '').replace(/^data:image\/jpg;/i, 'data:image/jpeg;');
  const norm = v.replace(/^data:image\/(png|jpeg|gif|webp);base64,/i, (m) => m.toLowerCase());
  if (norm.length > MAX_IMAGE_CHARS || !IMAGE_SRC.test(norm)) return null;
  return norm;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
}

// A <span> with no style does nothing: remove it and its matching </span> (output is well nested by construction).
function unwrapBareSpans(html) {
  if (!html.includes('<span')) return html;
  let out = '', last = 0;
  const bare = [];
  const re = /<span>|<span [^>]*>|<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    out += html.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[0] === '</span>') { if (!bare.pop()) out += m[0]; }
    else { const isBare = m[0] === '<span>'; bare.push(isBare); if (!isBare) out += m[0]; }
  }
  return out + html.slice(last);
}

// Remove every `open ... close` block in ONE forward pass. The regex equivalent (`<x[\s\S]*?</x>`) rescans to the end of the
// input for every unclosed opener, which is quadratic: a few hundred KB of "<svg" froze the server for minutes.
// `closeRe` finds the end of the block; once a closer is known to be missing it is never searched for again.
function stripBlocks(s, openRe, closeFor) {
  let out = '', last = 0;
  const missing = new Set();
  const closers = new Map();
  openRe.lastIndex = 0;
  let m;
  while ((m = openRe.exec(s))) {
    const key = closeFor(m);
    if (missing.has(key)) continue;
    let re = closers.get(key);
    if (!re) { re = new RegExp(key, 'gi'); closers.set(key, re); }
    re.lastIndex = m.index + m[0].length;
    const c = re.exec(s);
    if (!c) { missing.add(key); continue; }
    out += s.slice(last, m.index);
    last = c.index + c[0].length;
    openRe.lastIndex = last;
  }
  return out + s.slice(last);
}
const DROP_OPEN = /<(script|style|iframe|object|embed|template|svg|math|noscript|textarea|select|button|form|head|title)\b/gi;

function sanitizeHtml(input) {
  let html = String(input ?? '');
  html = html.replace(/\u0000/g, '');
  html = stripBlocks(html, DROP_OPEN, (m) => `<\\/${m[1].toLowerCase()}\\s*>`);
  html = stripBlocks(html, /<!--/g, () => '-->');
  html = stripBlocks(html, /<!\[CDATA\[/g, () => '\\]\\]>');
  html = stripBlocks(html, /<\?/g, () => '\\?>');
  html = stripBlocks(html, /<!/g, () => '>');
  // Anything after the last ">" cannot be a tag: it is text. This keeps the tag matcher below linear on "<a <a <a ...".
  const lastGt = html.lastIndexOf('>');
  const tail = html.slice(lastGt + 1).replace(/</g, '\u0001LT\u0001');
  html = html.slice(0, lastGt + 1) + tail;

  let out = '';
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>|<|[^<]+/g;
  const stack = [];
  const flattened = {}; // names of tags dropped for depth, so their closing tags are dropped too
  let m;
  while ((m = re.exec(html))) {
    if (m[2] === undefined) {
      // text (or a lone "<")
      out += m[0] === '<' ? '&lt;' : m[0].replace(/\u0001LT\u0001/g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      continue;
    }
    const closing = m[1] === '/';
    const orig = m[2].toLowerCase();
    let name = orig;
    if (!ALLOWED.has(name)) continue; // unknown tag: drop the tag, keep its text
    name = CANON[name] || name;
    if (VOID.has(name)) {
      if (!closing && name === 'img') {
        const src = safeImageSrc(attr(m[0], 'src'));
        if (src) {
          const alt = String(attr(m[0], 'alt') || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 200);
          const w = Number(attr(m[0], 'width'));
          out += `<img src="${src}"${alt ? ` alt="${escapeHtml(alt)}"` : ''}${Number.isInteger(w) && w >= 16 && w <= 2000 ? ` width="${w}"` : ''}>`;
        }
        continue;
      }
      if (!closing) {
        if (name === 'hr') { const idx = stack.lastIndexOf('p'); if (idx !== -1) while (stack.length > idx) out += `</${stack.pop()}>`; }
        out += name === 'hr' && /^page$/i.test(attr(m[0], 'data-type') || '') ? '<hr data-type="page">' : `<${name}>`; // hr data-type=page is a page break
      }
      continue;
    }
    if (closing) {
      if (flattened[name] > 0) { flattened[name]--; continue; }
      const idx = stack.lastIndexOf(name);
      if (idx === -1) continue; // stray closing tag
      while (stack.length > idx) out += `</${stack.pop()}>`;
      continue;
    }
    if (stack.length >= MAX_DEPTH) { flattened[name] = (flattened[name] || 0) + 1; continue; }
    if (name === 'a') {
      const href = safeHref(attr(m[0], 'href'));
      if (!href) continue; // link without a safe target: keep text only
      stack.push('a');
      out += href.startsWith('#') ? `<a href="${href}">` : `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">`;
      continue;
    }
    if (CLOSES_P.has(name)) {
      const idx = stack.lastIndexOf('p');
      if (idx !== -1) while (stack.length > idx) out += `</${stack.pop()}>`;
    }
    let top = stack.length - 1;
    while (top >= 0 && stack[top] === 'span') top--; // inline spans are transparent for structure
    if ((name === 'ul' || name === 'ol') && (stack[top] === 'ul' || stack[top] === 'ol')) {
      // A list directly inside a list (what browsers emit when you indent): it belongs inside the preceding <li>.
      if (out.endsWith('</li>')) { out = out.slice(0, -5); stack.push('li'); } else { out += '<li>'; stack.push('li'); }
    }
    if (CELL.has(name)) { const c = Math.max(stack.lastIndexOf('td'), stack.lastIndexOf('th')), t = stack.lastIndexOf('tr'); if (c !== -1 && c > t) while (stack.length > c) out += `</${stack.pop()}>`; }
    if (name === 'tr') { const t = stack.lastIndexOf('tr'), tb = Math.max(stack.lastIndexOf('table'), stack.lastIndexOf('tbody'), stack.lastIndexOf('thead')); if (t !== -1 && t > tb) while (stack.length > t) out += `</${stack.pop()}>`; }
    if (name === 'li') { // a new <li> ends the previous sibling <li> (but not an ancestor's)
      const li = stack.lastIndexOf('li'), list = Math.max(stack.lastIndexOf('ul'), stack.lastIndexOf('ol'));
      if (li !== -1 && li > list) while (stack.length > li) out += `</${stack.pop()}>`;
    }
    // attributes we keep, each re-built from a validated parse
    let attrStr = '';
    if (name === 'span') {
      const raw = (orig === 'font' ? fontTagStyle({ color: attr(m[0], 'color'), face: attr(m[0], 'face'), size: attr(m[0], 'size') }) + ';' : '') + (attr(m[0], 'style') || '');
      const st = cleanStyle(raw, 'inline');
      if (st) attrStr = ` style="${escapeHtml(st)}"`;
    } else if (BLOCK_STYLED.has(name)) {
      const align = attr(m[0], 'align');
      const st = cleanStyle((attr(m[0], 'style') || '') + (align ? `;text-align:${align}` : ''), 'block');
      if (st) attrStr = ` style="${escapeHtml(st)}"`;
      if (/^h[1-3]$/.test(name)) { const id = attr(m[0], 'id'); if (id && HEADING_ID.test(id)) attrStr = ` id="${id}"${attrStr}`; } // anchors for the table of contents
    } else if (name === 'ul' && /^check$/i.test(attr(m[0], 'data-type') || '')) attrStr = ' data-type="check"';
    else if (name === 'ul' && /^toc$/i.test(attr(m[0], 'data-type') || '')) attrStr = ' data-type="toc"';
    if (name === 'li' && /^true$/i.test(attr(m[0], 'data-checked') || '')) attrStr += ' data-checked="true"';
    stack.push(name);
    out += `<${name}${attrStr}>`;
  }
  while (stack.length) out += `</${stack.pop()}>`;
  // Empty block wrappers render nothing; drop them so repeated edits cannot pile them up (<p><br></p> blank lines are kept).
  out = unwrapBareSpans(out);
  for (let prev = ''; prev !== out;) { prev = out; out = out.replace(/<(p|div|blockquote|h[1-3])(?: [^>]*)?><\/\1>/g, ''); }
  // A stray "<" in text was escaped above; make sure ">" outside tags is harmless too.
  return out;
}

// ---- Converters used by import ---------------------------------------------------
// Inline formatting uses BOUNDED matches: an unclosed opener (" _a _a _a ...", "[a [a [a ...") used to rescan the whole line for
// every opener, which is quadratic and froze the server. Spans longer than 200 characters are simply left as text, and very long
// lines get no inline formatting at all.
function inlineMd(t) {
  let s = escapeHtml(t);
  if (s.length > 2000) return s;
  s = s.replace(/`([^`]{1,200})`/g, '<code>$1</code>');
  s = s.replace(/\*\*(.{1,200}?)\*\*/g, '<b>$1</b>').replace(/__(.{1,200}?)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*(?!\s)(.{1,200}?)\*(?!\*)/g, '$1<i>$2</i>').replace(/(^|[^_\w])_(?!\s)(.{1,200}?)_(?![_\w])/g, '$1<i>$2</i>');
  s = s.replace(/~~(.{1,200}?)~~/g, '<s>$1</s>');
  s = s.replace(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]{1,1000}|mailto:[^\s)]{1,300})\)/g, (_, text, url) => `<a href="${url}">${text}</a>`);
  return s;
}

function markdownToHtml(md) {
  const out = [];
  let list = null;
  let inCode = false;
  let code = [];
  const closeList = () => { if (list) { out.push(`</${list === 'ulc' ? 'ul' : list}>`); list = null; } };
  for (const raw of String(md).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (/^```/.test(line.trim())) {
      if (inCode) { out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`); code = []; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { code.push(raw); continue; }
    let m;
    if (!line.trim()) { closeList(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { closeList(); const lvl = Math.min(m[1].length, 3); out.push(`<h${lvl}>${inlineMd(m[2])}</h${lvl}>`); continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { closeList(); out.push(`<blockquote>${inlineMd(m[1])}</blockquote>`); continue; }
    if ((m = line.match(/^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/))) { // task list item
      if (list !== 'ulc') { closeList(); out.push('<ul data-type="check">'); list = 'ulc'; }
      out.push(`<li${m[1] === ' ' ? '' : ' data-checked="true"'}>${inlineMd(m[2])}</li>`); continue;
    }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inlineMd(m[1])}</li>`); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inlineMd(m[1])}</li>`); continue; }
    closeList();
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  if (inCode) out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
  closeList();
  return out.join('\n');
}

function textToHtml(text) {
  return String(text).replace(/\r\n/g, '\n').split(/\n{2,}/).filter((p) => p.trim()).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

// Plain-text length of stored HTML (for word counts and validation).
function htmlToText(html) {
  return String(html).replace(/<\/(p|div|h[1-3]|li|blockquote|pre|tr)>/g, '\n').replace(/<\/(td|th)>/g, ' ').replace(/<br>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

module.exports = { stripBlocks, safeImageSrc, MAX_IMAGE_CHARS, sanitizeHtml, markdownToHtml, textToHtml, escapeHtml, htmlToText, safeHref };
