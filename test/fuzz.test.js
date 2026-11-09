'use strict';
// Seeded property/fuzz tests: thousands of random hostile inputs against the sanitiser,
// exporters and the .docx reader. Failures print the seed and the offending input.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeHtml, markdownToHtml, textToHtml, htmlToText } = require('../src/sanitize');
const { htmlToDocx, docxToHtml, writeZip, readZip } = require('../src/docx');
const { toMarkdown, toText, toStandaloneHtml } = require('../src/export');
const { parse, blocks } = require('../src/htmltree');

// mulberry32: small deterministic PRNG so failures are reproducible
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

const TAGS = ['span', 'font', 'sub', 'sup', 'span', 'p', 'div', 'b', 'i', 'u', 's', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'code', 'br', 'hr', 'span', 'script', 'style', 'iframe', 'img', 'svg', 'math', 'table', 'tr', 'td', 'form', 'input', 'button', 'textarea', 'object', 'embed', 'template', 'noscript', 'select', 'title', 'head', 'marquee', 'x-custom', 'B', 'SCRIPT', 'Ul'];
const ATTRS = ['id="h-ab12cd34"', 'id="evil"', 'href="#h-ab12cd34"', 'href="#nope"', 'data-type="toc"', 'src="data:image/png;base64,iVBORw0KGgo="', 'src="data:image/svg+xml;base64,PHN2Zz4="', 'src="https://evil.example/x.png"', 'alt="x <b> y &amp; z"', 'width="120"', 'width="99999"', 'data-type="page"', 'style="color:red;font-size:18pt;font-family:Georgia"', 'style="text-align:center;line-height:1.5;margin-left:36px"', 'style="background:url(javascript:x);position:fixed"', 'style="color:expression(alert(1))"', 'data-type="check"', 'data-checked="true"', 'align="center"', 'color="#f00" face="Arial" size="5"', 'onclick="alert(1)"', 'onerror=alert(1)', "onload='x()'", 'href="javascript:alert(1)"', 'href="https://ok.example/a?b=1&c=2"', 'href="JaVa\tScRiPt:alert(1)"', 'href=data:text/html,x', 'style="color:red"', 'class="c"', 'id=i', 'src=x', 'href="mailto:a@b.co"', 'target=_blank', '"', "'", 'a=b=c', '/', ''];
const TEXTS = ['hello', 'a < b', 'x > y', '&amp;', '&lt;script&gt;', '&#60;script&#62;', '"quoted"', "it's", '\u0000', '‮', 'emoji \u{1F680}', '日本語', 'العربية', '<', '>', '&', '\n', '  ', 'javascript:alert(1)', '<!--', '-->', ']]>', '<![CDATA[x]]>'];

function randomHtml(r, depth = 0) {
  const parts = [];
  const n = 1 + Math.floor(r() * 8);
  for (let i = 0; i < n; i++) {
    const roll = r();
    if (roll < 0.35) parts.push(pick(r, TEXTS));
    else if (roll < 0.8) {
      const tag = pick(r, TAGS);
      const attrs = Array.from({ length: Math.floor(r() * 3) }, () => pick(r, ATTRS)).join(' ');
      const inner = depth < 4 ? randomHtml(r, depth + 1) : pick(r, TEXTS);
      const closing = r() < 0.8 ? `</${r() < 0.1 ? pick(r, TAGS) : tag}>` : '';
      parts.push(`<${tag}${attrs ? ' ' + attrs : ''}${r() < 0.05 ? '' : '>'}${inner}${closing}`);
    } else if (roll < 0.9) parts.push(`</${pick(r, TAGS)}>`);
    else parts.push(pick(r, ['<!-- c -->', '<?php x ?>', '<!DOCTYPE html>', '<![CDATA[<script>]]>', '<scr<script>ipt>', '<<script>>', '<a href="x" href="javascript:y">']));
  }
  return parts.join(r() < 0.3 ? ' ' : '');
}

// Strip text nodes, then no dangerous construct may remain in the *markup*.
function markupOnly(html) { return (html.match(/<[^>]*>/g) || []).join(''); }
const SAFE_TAG = /^<\/?(p|br|b|i|u|s|code|pre|blockquote|h1|h2|h3|ul|ol|li|div|hr|a|table|thead|tbody|tr|th|td|span|sub|sup|img)(\s[^>]*)?>$/;
// every attribute that may survive, with the exact grammar of its value
const COLOR = '#[0-9a-f]{6}';
const INLINE_DECL = `(?:color:${COLOR}|background-color:${COLOR}|font-size:\\d{1,3}(?:\\.\\d{1,2})?px|font-family:'[A-Za-z ]+')`;
const BLOCK_DECL = '(?:text-align:(?:right|center|justify)|line-height:\\d(?:\\.\\d{1,2})?|margin-left:\\d{1,3}px)';
const STYLE_ATTR = { span: new RegExp(`^style="${INLINE_DECL}(?:;${INLINE_DECL})*"$`), block: new RegExp(`^style="${BLOCK_DECL}(?:;${BLOCK_DECL})*"$`) };
function checkAttrs(tag, ctx) {
  const m = tag.match(/^<([a-z0-9]+)((?:\s[^>]*)?)>$/);
  if (!m) return;
  const [, name, rest] = m;
  const attrs = rest.trim() ? rest.trim().match(/[a-z-]+="[^"]*"|[a-z-]+="[^"]*"/g) || [`UNPARSEABLE:${rest}`] : [];
  for (const a of attrs) {
    if (name === 'a') { assert.match(a, /^(href="((https?:|mailto:)[^"<>]*|#h-[a-z0-9]{4,16})"|target="_blank"|rel="noopener noreferrer")$/i, `bad link attr ${a}\n${ctx}`); continue; }
    if (name === 'span') { assert.match(a, STYLE_ATTR.span, `bad span attr ${a}\n${ctx}`); continue; }
    if (name === 'img') { assert.match(a, /^(src="data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+\/]+={0,2}"|alt="[^"<>]*"|width="\d{2,4}")$/, `bad img attr ${a}\n${ctx}`); continue; }
    if (name === 'hr' && a === 'data-type="page"') continue;
    if (name === 'ul' && (a === 'data-type="check"' || a === 'data-type="toc"')) continue;
    if (/^h[1-3]$/.test(name) && /^id="h-[a-z0-9]{4,16}"$/.test(a)) continue;
    if (name === 'li' && a === 'data-checked="true"') continue;
    if (/^(p|div|h1|h2|h3|li|blockquote|td|th)$/.test(name) && a.startsWith('style=')) { assert.match(a, STYLE_ATTR.block, `bad block style ${a}\n${ctx}`); continue; }
    assert.fail(`attribute ${a} must not survive on <${name}>\n${ctx}`);
  }
}

test('sanitiser: 4000 random hostile documents are idempotent, safe and well formed', () => {
  for (let seed = 1; seed <= 4000; seed++) {
    const r = rng(seed);
    const input = randomHtml(r);
    const once = sanitizeHtml(input);
    const ctx = `seed ${seed}\ninput: ${JSON.stringify(input)}\noutput: ${JSON.stringify(once)}`;
    assert.equal(sanitizeHtml(once), once, `not idempotent\n${ctx}`);
    // every tag in the output is an allowed one and the only attributes are the safe link ones
    for (const tag of once.match(/<[^>]*>/g) || []) {
      assert.match(tag, SAFE_TAG, `unexpected tag ${tag}\n${ctx}`);
      checkAttrs(tag, ctx);
      if (/^<a\b/.test(tag)) assert.match(tag, /^<a href="((https?:|mailto:)[^"<>]*" target="_blank" rel="noopener noreferrer"|#h-[a-z0-9]{4,16}")>$/i, `bad link ${tag}\n${ctx}`);
    }
    assert.doesNotMatch(markupOnly(once), /\son\w+\s*=|javascript:|<script|<style|<iframe|url\(|expression\(|position\s*:/i, `dangerous markup\n${ctx}`);
    // balanced: parsing and re-serialising through the exporters must not throw
    const tree = parse(once); blocks(tree.children);
    toMarkdown(once); toText(once); toStandaloneHtml('t', once); htmlToText(once);
  }
});

test('docx: random sanitised documents survive export -> import and stay stable', () => {
  for (let seed = 1; seed <= 600; seed++) {
    const r = rng(seed * 7919);
    const html = sanitizeHtml(randomHtml(r));
    const ctx = `seed ${seed * 7919}\nhtml: ${JSON.stringify(html)}`;
    let back;
    try { back = docxToHtml(htmlToDocx(html, 'T')); } catch (e) { assert.fail(`round trip threw: ${e.message}\n${ctx}`); }
    assert.equal(typeof back, 'string');
    assert.equal(sanitizeHtml(back), back, `importer output must already be clean\n${ctx}`);
    // text content is preserved (ignoring layout)
    const norm = (h) => htmlToText(h).replace(/[\s\u2022|]+/g, ''); // list markers and cell separators are formatting
    assert.equal(norm(back), norm(html), `text lost in round trip\nback: ${JSON.stringify(back)}\n${ctx}`);
  }
});

test('docx reader never crashes or hangs on corrupted files (random byte mutations)', () => {
  const good = htmlToDocx('<h1>Title</h1><p>Hello <b>world</b></p><ul><li>a</li></ul>', 'T');
  const t0 = Date.now();
  for (let seed = 1; seed <= 500; seed++) {
    const r = rng(seed);
    const buf = Buffer.from(good);
    const flips = 1 + Math.floor(r() * 12);
    for (let i = 0; i < flips; i++) buf[Math.floor(r() * buf.length)] = Math.floor(r() * 256);
    const cut = r() < 0.2 ? buf.subarray(0, Math.floor(r() * buf.length)) : buf;
    try { docxToHtml(cut); } catch (e) { assert.ok(e instanceof Error, `non-Error thrown (seed ${seed})`); assert.ok(!/is not a function|undefined|null/.test(e.message), `internal error leaked: ${e.message} (seed ${seed})`); }
  }
  assert.ok(Date.now() - t0 < 20000, 'mutation run too slow');
});

test('docx reader tolerates hostile XML (entities, huge attributes, nesting, giant runs)', () => {
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const docs = [
    `<w:document ${NS}><w:body><w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt; &amp;amp; &#60;b&#62;</w:t></w:r></w:p></w:body></w:document>`,
    `<w:document ${NS}><w:body>${'<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(20000)}</w:body></w:document>`,
    `<w:document ${NS}><w:body><w:p><w:r><w:t>${'a'.repeat(1_000_000)}</w:t></w:r></w:p></w:body></w:document>`,
    `<w:document ${NS}><w:body><w:p><w:pPr><w:numPr><w:ilvl w:val="99999"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>deep</w:t></w:r></w:p></w:body></w:document>`,
    `<w:document ${NS}><w:body><w:p><w:r><w:t>unterminated`,
    `<w:document ${NS}><w:body><w:p><w:hyperlink r:id="x"><w:r><w:t>l</w:t></w:r></w:hyperlink></w:p></w:body></w:document>`,
    '',
  ];
  for (const [i, xml] of docs.entries()) {
    const t0 = Date.now();
    let out;
    try { out = docxToHtml(writeZip([['word/document.xml', xml]])); } catch (e) { assert.ok(e instanceof Error); continue; }
    assert.equal(typeof out, 'string');
    assert.doesNotMatch(markupOnly(out), /<script|on\w+=/i, `doc ${i}`);
    assert.ok(Date.now() - t0 < 5000, `doc ${i} too slow`);
  }
});

test('markdown and text import: random input never throws and always yields clean HTML', () => {
  const frags = ['# ', '## ', '- ', '* ', '1. ', '> ', '```', '---', '**', '*', '__', '~~', '`', '[a](', ')', '](javascript:x)', '<b>', '</b>', '<script>', '\n', '\n\n', '  ', 'text', '\t', '\u0000', '![img](http://x)', '|a|b|', '- [ ] todo'];
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed);
    const md = Array.from({ length: 1 + Math.floor(r() * 30) }, () => pick(r, frags)).join('');
    const html = sanitizeHtml(markdownToHtml(md));
    assert.equal(sanitizeHtml(html), html, `seed ${seed}: ${JSON.stringify(md)}`);
    assert.doesNotMatch(markupOnly(html), /<script|javascript:|on\w+=/i, `seed ${seed}: ${JSON.stringify(md)}`);
    sanitizeHtml(textToHtml(md));
  }
});

test('regex-heavy code stays linear on pathological inputs (no ReDoS)', () => {
  const evil = [
    '<a href="' + 'x'.repeat(200000),
    '<' + 'a '.repeat(100000),
    '<p ' + 'a="b" '.repeat(50000) + '>',
    '<!--' + '-'.repeat(200000),
    '<b>'.repeat(50000) + 'x',
    'a'.repeat(300000) + '<',
    '<scr' + 'ipt'.repeat(50000) + '>',
    '&amp;'.repeat(100000),
    '<p>' + '<b>'.repeat(20000) + '</p>'.repeat(20000),
    '[' + '](a'.repeat(50000),
    '*'.repeat(100000) + 'a' + '*'.repeat(100000),
    '_ '.repeat(100000),
  ];
  for (const [i, s] of evil.entries()) {
    const t0 = Date.now();
    const out = sanitizeHtml(s);
    toMarkdown(out); toText(out);
    assert.ok(Date.now() - t0 < 4000, `sanitise/export of evil[${i}] took ${Date.now() - t0}ms`);
    const t1 = Date.now();
    markdownToHtml(s);
    assert.ok(Date.now() - t1 < 4000, `markdownToHtml of evil[${i}] took ${Date.now() - t1}ms`);
  }
});
