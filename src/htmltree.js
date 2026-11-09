'use strict';
// Parser for the sanitised HTML subset produced by sanitize.js. Because the sanitiser
// guarantees well-nested tags and no attributes except <a href>, a tiny tokenizer is enough.

const VOID = new Set(['br', 'hr', 'img']);

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function parse(html) {
  const root = { tag: '#root', children: [] };
  const stack = [root];
  const re = /<(\/?)([a-z0-9]+)((?:\s[^>]*)?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(String(html)))) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) { top.children.push({ text: decode(m[4]) }); continue; }
    const name = m[2];
    if (m[1] === '/') {
      const idx = stack.map((n) => n.tag).lastIndexOf(name);
      if (idx > 0) stack.length = idx;
      continue;
    }
    const node = { tag: name, children: [] };
    const href = m[3] && m[3].match(/href="([^"]*)"/);
    if (href) node.href = decode(href[1]);
    if (name === 'img' && m[3]) {
      const src = m[3].match(/src="([^"]*)"/), alt = m[3].match(/alt="([^"]*)"/), w = m[3].match(/width="(\d+)"/);
      if (src) node.src = src[1];
      if (alt) node.alt = decode(alt[1]);
      if (w) node.width = Number(w[1]);
    }
    const style = m[3] && m[3].match(/style="([^"]*)"/);
    if (style) node.style = decode(style[1]);
    if (m[3] && /data-type="check"/.test(m[3])) node.check = true;
    if (name === 'hr' && m[3] && /data-type="page"/.test(m[3])) node.page = true;
    if (m[3] && /data-checked="true"/.test(m[3])) node.checked = true;
    top.children.push(node);
    if (!VOID.has(name)) stack.push(node);
  }
  return root;
}

const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'ul', 'ol', 'blockquote', 'pre', 'hr', 'li', 'table']);

// Rows of a <table> as arrays of { header, children } cells (thead/tbody wrappers are transparent).
// Content that sits outside any cell (sloppy pasted HTML) is kept as an extra cell instead of being dropped.
function tableRows(table) {
  const rows = [];
  const meaningful = (nodes) => nodes.some((x) => x.text === undefined || x.text.trim());
  const visit = (n) => {
    let loose = [];
    const flush = () => { if (meaningful(loose)) rows.push([{ header: false, children: loose }]); loose = []; };
    for (const c of n.children) {
      if (c.tag === 'tr') {
        flush();
        const cells = [];
        let stray = [];
        const flushStray = () => { if (meaningful(stray)) cells.push({ header: false, children: stray }); stray = []; };
        for (const x of c.children) {
          if (x.tag === 'td' || x.tag === 'th') { flushStray(); cells.push({ header: x.tag === 'th', children: x.children }); } else stray.push(x);
        }
        flushStray();
        rows.push(cells);
      } else if (c.tag === 'thead' || c.tag === 'tbody') { flush(); visit(c); } else loose.push(c);
    }
    flush();
  };
  visit(table);
  return rows.filter((r) => r.length);
}

// Group top-level (or container-level) inline nodes into synthetic paragraphs so every
// consumer sees only blocks. A <div> that wraps other blocks (browsers do this when a list or
// heading is created inside a div) is unwrapped so its contents are not lost.
const hasBlockChild = (n) => n.children && n.children.some((c) => c.tag && BLOCK.has(c.tag));
function blocks(children) {
  const out = [];
  let run = [];
  const flush = () => { if (run.some((n) => n.text === undefined ? true : n.text.trim())) out.push({ tag: 'p', children: run }); run = []; };
  for (const n of children) {
    if (n.tag === 'div' && hasBlockChild(n)) { flush(); out.push(...blocks(n.children)); }
    else if (n.tag && BLOCK.has(n.tag)) { flush(); out.push(n); }
    else run.push(n);
  }
  flush();
  return out;
}

// Items of a <ul>/<ol>. Browsers only emit <li> children, but pasted or imported HTML can put text
// (or a nested list) directly inside the list: group such runs into a synthetic <li> so nothing is lost.
function listItems(list) {
  const items = [];
  let loose = null;
  for (const c of list.children) {
    if (c.tag === 'li') { loose = null; items.push(c); continue; }
    if (c.text !== undefined && !c.text.trim()) continue;
    // a nested list sitting directly in the list belongs to the item before it
    if ((c.tag === 'ul' || c.tag === 'ol') && items.length && !loose) { items[items.length - 1].children.push(c); continue; }
    if (!loose) { loose = { tag: 'li', children: [] }; items.push(loose); }
    loose.children.push(c);
  }
  return items;
}

// "color:#ff0000;font-size:18px" -> { color: '#ff0000', 'font-size': '18px' } (values come pre-validated from the sanitiser)
function styleMap(str) {
  const out = {};
  for (const d of String(str || '').split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim().replace(/^'|'$/g, ''); }
  return out;
}

module.exports = { parse, blocks, decode, BLOCK, listItems, tableRows, styleMap };
