'use strict';
const { parse, blocks, listItems, tableRows } = require('./htmltree');
const { escapeHtml } = require('./sanitize');

function inline(nodes) {
  let s = '';
  for (const n of nodes) {
    if (n.text !== undefined) { s += n.text.replace(/([\\`*_~<&])/g, '\\$1'); continue; }
    const inner = inline(n.children);
    switch (n.tag) {
      case 'b': s += inner.trim() ? `**${inner}**` : inner; break;
      case 'i': s += inner.trim() ? `*${inner}*` : inner; break;
      case 'u': s += `<u>${inner}</u>`; break;
      case 's': s += inner.trim() ? `~~${inner}~~` : inner; break;
      case 'code': s += `\`${inner.replace(/\\([\\`*_~])/g, '$1')}\``; break;
      case 'a': s += n.href && n.href.startsWith('#') ? inner : `[${inner}](${n.href})`; break;
      case 'sub': s += `<sub>${inner}</sub>`; break;
      case 'sup': s += `<sup>${inner}</sup>`; break;
      case 'br': s += '  \n'; break;
      case 'img': s += n.alt ? `[Image: ${n.alt.replace(/[\[\]\\]/g, '')}]` : '[Image]'; break;
      default: s += inner;
    }
  }
  return s;
}
const plainInline = (nodes) => nodes.map((n) => (n.text !== undefined ? n.text : n.tag === 'br' ? '\n' : n.tag === 'img' ? (n.alt ? `[Image: ${n.alt}]` : '[Image]') : plainInline(n.children))).join('');

function listLines(list, depth, fmtInline) {
  const lines = [];
  let i = 1;
  for (const li of listItems(list)) {
    // Walk the item's children in order: inline content becomes a bullet, a nested list is emitted
    // where it appears, and any text that follows it becomes a further bullet (document order is kept).
    let buf = [];
    let emitted = false;
    const flush = () => {
      const text = fmtInline(blocks(buf).flatMap((b) => b.children)).trim();
      if (text || !emitted) { lines.push(`${'  '.repeat(depth)}${list.tag === 'ol' ? `${i++}.` : '-'} ${list.check && !emitted ? (li.checked ? '[x] ' : '[ ] ') : ''}${text}`); emitted = true; }
      buf = [];
    };
    for (const c of li.children) {
      if (c.tag === 'ul' || c.tag === 'ol') { if (buf.length || !emitted) flush(); lines.push(...listLines(c, depth + 1, fmtInline)); }
      else buf.push(c);
    }
    if (buf.length || !emitted) flush();
  }
  return lines;
}

function cellText(children, fmt) { return fmt(blocks(children).flatMap((b) => (b.tag === 'p' || b.tag === 'div' ? [...b.children, { text: ' ' }] : [b]))).replace(/\s+/g, ' ').trim(); }
function mdTable(table) {
  const rows = tableRows(table);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => (r[i] ? cellText(r[i].children, inline).replace(/\|/g, '\\|') : '')).join(' | ')} |`;
  return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

function toMarkdown(html) {
  const out = [];
  for (const b of blocks(parse(html).children)) {
    switch (b.tag) {
      case 'h1': case 'h2': case 'h3': out.push(`${'#'.repeat(Number(b.tag[1]))} ${inline(b.children).trim()}`); break;
      case 'ul': case 'ol': out.push(listLines(b, 0, inline).join('\n')); break;
      case 'blockquote': out.push(inline(b.children).trim().split('\n').map((l) => `> ${l}`).join('\n')); break;
      case 'pre': out.push('```\n' + plainInline(b.children).replace(/\n$/, '') + '\n```'); break;
      case 'hr': out.push('---'); break;
      case 'table': { const t = mdTable(b); if (t) out.push(t); break; }
      default: { const t = inline(b.children).trim(); if (t) out.push(t); }
    }
  }
  return out.join('\n\n') + '\n';
}

function toText(html) {
  const out = [];
  for (const b of blocks(parse(html).children)) {
    switch (b.tag) {
      case 'ul': case 'ol': out.push(listLines(b, 0, plainInline).join('\n')); break;
      case 'hr': out.push('----'); break;
      case 'table': out.push(tableRows(b).map((r) => r.map((c) => cellText(c.children, plainInline)).join('\t')).join('\n')); break;
      default: { const t = plainInline(b.children).trim(); if (t) out.push(t); }
    }
  }
  return out.join('\n\n') + '\n';
}

function toStandaloneHtml(title, html, pageCss = '') {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>\n<style>body{font:16px/1.6 Georgia,serif;max-width:46rem;margin:3rem auto;padding:0 1rem;color:#222}h1,h2,h3{font-family:system-ui,sans-serif;line-height:1.25}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:1rem;color:#555}pre,code{background:#f3f3f3;border-radius:4px}hr[data-type=page]{border:0;break-after:page}pre{padding:.8rem;overflow:auto}${pageCss}</style></head>\n<body>\n<h1>${escapeHtml(title)}</h1>\n${html}\n</body></html>\n`;
}

module.exports = { toMarkdown, toText, toStandaloneHtml };
