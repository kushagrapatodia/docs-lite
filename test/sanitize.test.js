'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeHtml, markdownToHtml, textToHtml, htmlToText, safeHref } = require('../src/sanitize');

test('keeps formatting tags and canonicalises them', () => {
  assert.equal(sanitizeHtml('<p>a <strong>b</strong> <em>c</em> <strike>d</strike></p>'), '<p>a <b>b</b> <i>c</i> <s>d</s></p>');
  assert.equal(sanitizeHtml('<h1>T</h1><ul><li>x</li></ul><ol><li>y</li></ol><blockquote>q</blockquote><hr><br>'), '<h1>T</h1><ul><li>x</li></ul><ol><li>y</li></ol><blockquote>q</blockquote><hr><br>');
});

test('removes scripts, event handlers and every attribute', () => {
  const vectors = [
    '<p onclick="x()">hi</p>',
    '<script>alert(1)</script><p>hi</p>',
    '<img src=x onerror=alert(1)>hi',
    '<p style="background:url(javascript:alert(1))">hi</p>',
    '<svg onload=alert(1)><circle/></svg>hi',
    '<iframe src="javascript:alert(1)"></iframe>hi',
    '<b onmouseover=alert(1)>hi</b>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>hi',
    '<style>*{x:expression(alert(1))}</style>hi',
    '<form action=x><button>go</button></form>hi',
    '<!--<script>alert(1)</script>-->hi',
    '<scr<script>ipt>alert(1)</scr</script>ipt>hi',
  ];
  for (const v of vectors) {
    const out = sanitizeHtml(v);
    assert.doesNotMatch(out, /on\w+\s*=|<script|<img|<svg|<iframe|<style|javascript:|expression\(/i, `leaked from: ${v} -> ${out}`);
    assert.match(out, /hi/);
  }
});

test('links: only http(s) and mailto survive, always with noopener', () => {
  assert.equal(sanitizeHtml('<a href="https://a.com/x?y=1&z=2">l</a>'), '<a href="https://a.com/x?y=1&amp;z=2" target="_blank" rel="noopener noreferrer">l</a>');
  assert.equal(sanitizeHtml('<a href="mailto:a@b.com">m</a>').includes('mailto:a@b.com'), true);
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', '//evil.com', '/relative']) {
    assert.equal(sanitizeHtml(`<a href="${bad}">t</a>`), 't', `allowed: ${bad}`);
  }
  assert.equal(safeHref('https://ok.com'), 'https://ok.com');
  assert.equal(safeHref(''), null);
  assert.equal(sanitizeHtml('<a href="https://x.com" onclick="evil()" class="c">t</a>'), '<a href="https://x.com" target="_blank" rel="noopener noreferrer">t</a>');
});

test('output is always well nested and text is escaped', () => {
  assert.equal(sanitizeHtml('<p><b>unclosed'), '<p><b>unclosed</b></p>');
  assert.equal(sanitizeHtml('stray</b>text'), 'straytext');
  assert.equal(sanitizeHtml('1 < 2 and 3 > 2'), '1 &lt; 2 and 3 &gt; 2');
  assert.equal(sanitizeHtml('<p>"quotes" & <b>x</b></p>'), '<p>&quot;quotes&quot; & <b>x</b></p>');
  assert.equal(sanitizeHtml(null), '');
  assert.equal(sanitizeHtml(undefined), '');
});

test('idempotent: sanitising twice gives the same result', () => {
  const inputs = ['<p>Hi <b>there</b> <a href="https://x.com">l</a></p>', '<ul><li>a<ul><li>b</li></ul></li></ul>', '1 < 2 & "x"', '<p onclick=1>x</p>'];
  for (const i of inputs) { const once = sanitizeHtml(i); assert.equal(sanitizeHtml(once), once); }
});

test('markdown import: headings, lists, emphasis, links, quotes, code and escaping', () => {
  const html = markdownToHtml('# H1\n## H2\n#### Deep\n\nText **bold** *it* ~~del~~ `code` [site](https://x.com) <b>raw</b>\n\n- a\n- b\n\n1. one\n2. two\n\n> quote\n\n---\n\n```\nlet x = 1 < 2;\n```');
  assert.match(html, /<h1>H1<\/h1>/);
  assert.match(html, /<h2>H2<\/h2>/);
  assert.match(html, /<h3>Deep<\/h3>/);
  assert.match(html, /<b>bold<\/b> <i>it<\/i> <s>del<\/s> <code>code<\/code> <a href="https:\/\/x.com">site<\/a> &lt;b&gt;raw&lt;\/b&gt;/);
  assert.match(html, /<ul>\s*<li>a<\/li>\s*<li>b<\/li>\s*<\/ul>/);
  assert.match(html, /<ol>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ol>/);
  assert.match(html, /<blockquote>quote<\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<pre>let x = 1 &lt; 2;<\/pre>/);
});

test('markdown links with unsafe schemes are not turned into anchors', () => {
  const out = sanitizeHtml(markdownToHtml('[x](javascript:alert(1)) and [y](https://ok.com)'));
  assert.doesNotMatch(out, /href="javascript:/i); // the unsafe link stays as inert plain text
  assert.equal((out.match(/<a /g) || []).length, 1);
  assert.match(out, /<a href="https:\/\/ok.com"/);
});

test('plain text import keeps paragraphs and line breaks, and escapes markup', () => {
  assert.equal(textToHtml('one\nline two\n\nsecond <b>para</b>'), '<p>one<br>line two</p>\n<p>second &lt;b&gt;para&lt;/b&gt;</p>');
  assert.equal(htmlToText('<p>a &amp; b</p><p>c</p>').trim(), 'a & b\nc');
});

test('block elements inside a paragraph are normalised like an HTML parser would (Chrome produces <p><ul>)', () => {
  assert.equal(sanitizeHtml('<p>a<ul><li>b</li></ul></p>'), '<p>a</p><ul><li>b</li></ul>');
  assert.equal(sanitizeHtml('<p><ol><li>x</li></ol></p>'), '<ol><li>x</li></ol>');
  assert.equal(sanitizeHtml('<p></p><div></div><h2></h2><p><br></p><blockquote><p></p></blockquote>x'), '<p><br></p>x', 'empty wrappers are dropped but intentional blank lines are kept');
  assert.equal(sanitizeHtml('<p>one<h2>two</h2>three</p>'), '<p>one</p><h2>two</h2>three');
  assert.equal(sanitizeHtml('<p>a<hr>b</p>'), '<p>a</p><hr>b');
  assert.equal(sanitizeHtml('<p><b>bold<div>block</div></b></p>'), '<p><b>bold</b></p><div>block</div>');
  assert.equal(sanitizeHtml('<ul><li>a<li>b</ul>'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(sanitizeHtml('<ul><li>a<ul><li>n</li></ul><li>b</li></ul>'), '<ul><li>a<ul><li>n</li></ul></li><li>b</li></ul>');
  for (const input of ['<p>a<ul><li>b</li></ul></p>', '<p><ol><li>x</li></ol></p>', '<ul><li>a<li>b</ul>']) { const once = sanitizeHtml(input); assert.equal(sanitizeHtml(once), once); }
});

test('extreme nesting is flattened so exporters cannot be recursed into a stack overflow', () => {
  const deep = '<b>'.repeat(50000) + 'x' + '</b>'.repeat(50000);
  const out = sanitizeHtml(deep);
  assert.match(out, /x/);
  const depth = (out.match(/<b>/g) || []).length;
  assert.ok(depth <= 40, `depth ${depth}`);
  assert.equal((out.match(/<b>/g) || []).length, (out.match(/<\/b>/g) || []).length, 'still balanced');
  assert.equal(sanitizeHtml(out), out);
  const lists = '<ul><li>'.repeat(5000) + 'leaf';
  assert.match(sanitizeHtml(lists), /leaf/);
});

test('indented lists (a <ul> directly inside a <ul>, as browsers emit) are nested inside the previous item', () => {
  assert.equal(sanitizeHtml('<ul><li>one</li><li>two</li><ul><li>nested</li></ul><li>three</li></ul>'), '<ul><li>one</li><li>two<ul><li>nested</li></ul></li><li>three</li></ul>');
  assert.equal(sanitizeHtml('<ol><li>a</li><ul><li>b</li><li>c</li></ul></ol>'), '<ol><li>a<ul><li>b</li><li>c</li></ul></li></ol>');
  assert.equal(sanitizeHtml('<ul><ul><li>lonely</li></ul></ul>'), '<ul><li><ul><li>lonely</li></ul></li></ul>', 'a leading nested list gets its own item');
  const already = '<ul><li>x<ul><li>y</li></ul></li></ul>';
  assert.equal(sanitizeHtml(already), already, 'correctly nested lists are untouched');
  assert.equal(sanitizeHtml(sanitizeHtml('<ul><li>a</li><ul><li>b</li></ul></ul>')), sanitizeHtml('<ul><li>a</li><ul><li>b</li></ul></ul>'));
});
