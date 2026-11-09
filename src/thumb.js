'use strict';
// A tiny, safe excerpt of a document for the card thumbnail on the documents page: headings, paragraphs, a few list items,
// grey blocks for pictures and tables. Built from the parsed tree, text only and escaped, so it carries no attributes,
// no styles and nothing the client has to sanitise. Stored with the document (never computed on list requests).
const { parse, blocks, listItems, tableRows } = require('./htmltree');
const { escapeHtml } = require('./sanitize');

const textOf = (n) => (n.text !== undefined ? n.text : n.tag === 'img' ? '' : n.tag === 'br' ? ' ' : (n.children || []).map(textOf).join(''));
const clean = (s) => s.replace(/\s+/g, ' ').trim();
const hasImg = (n) => n.tag === 'img' || (n.children || []).some(hasImg);

function makeThumb(html, { maxChars = 520, maxBlocks = 14 } = {}) {
  let used = 0, out = '', count = 0;
  const room = () => used < maxChars && count < maxBlocks;
  const add = (tag, text, cls) => { const t = clean(text).slice(0, 140); if (!t) return; out += `<${tag}${cls ? ` class="${cls}"` : ''}>${escapeHtml(t)}</${tag}>`; used += t.length; count++; };
  for (const b of blocks(parse(html).children)) {
    if (!room()) break;
    if (b.tag === 'h1' || b.tag === 'h2' || b.tag === 'h3') add(b.tag, textOf(b));
    else if (b.tag === 'ul' || b.tag === 'ol') {
      let items = ''; let n = 0;
      for (const li of listItems(b)) { if (n++ >= 4 || used >= maxChars) break; const t = clean(li.children.filter((c) => c.tag !== 'ul' && c.tag !== 'ol').map(textOf).join('')).slice(0, 90); if (t) { items += `<li${b.check ? (li.checked ? ' class="on"' : ' class="off"') : ''}>${escapeHtml(t)}</li>`; used += t.length; } }
      if (items) { out += `<${b.tag === 'ol' ? 'ol' : 'ul'}>${items}</${b.tag === 'ol' ? 'ol' : 'ul'}>`; count++; }
    } else if (b.tag === 'table') { if (tableRows(b).length) { out += '<div class="t-table"></div>'; used += 90; count++; } }
    else if (b.tag === 'hr') { out += '<hr>'; count++; }
    else if (b.tag === 'blockquote') add('blockquote', textOf(b));
    else if (b.tag === 'pre') add('pre', textOf(b));
    else if (hasImg(b) && !clean(textOf(b))) { out += '<div class="t-img"></div>'; used += 110; count++; }
    else add('p', textOf(b));
  }
  return out;
}

module.exports = { makeThumb };
