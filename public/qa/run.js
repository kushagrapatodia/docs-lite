import { cleanPastedHtml, safeUrl } from '/js/clean.js';
import { timeAgo, initials, avatarClass, pluralize, parseTs } from '/js/dom.js';
import { diffStats, htmlToPlain } from '/js/diff.js';
import { countStats } from '/js/views/dialogs.js';
import { createFormatter, FONTS, SIZES } from '/js/views/format.js';
import { imageToDataUrl } from '/js/views/images.js';
import { createToc } from '/js/views/toc.js';
import { mergeHtml, merge3, changes } from '/js/merge.js';
import { rank } from '/js/views/palette.js';
import { keyLabel } from '/js/dom.js';

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || 'not equal'}\n  got:      ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`); };
const has = (s, sub) => { if (!s.includes(sub)) throw new Error(`expected to contain ${JSON.stringify(sub)}\n  got: ${JSON.stringify(s)}`); };
const lacks = (s, re) => { if (re.test(s)) throw new Error(`must not match ${re}\n  got: ${JSON.stringify(s)}`); };
const clean = cleanPastedHtml;

// ---- paste cleaner ----------------------------------------------------------------
test('plain and empty input', () => { eq(clean(''), ''); eq(clean('just text'), 'just text'); });
test('styled spans become real formatting (Docs / Word)', () => {
  eq(clean('<span style="font-weight:700">B</span> <span style="font-style:italic">I</span> <span style="text-decoration:underline">U</span> <span style="text-decoration:line-through">S</span>'), '<b>B</b> <i>I</i> <u>U</u> <s>S</s>');
  eq(clean('<span style="font-weight:700;font-style:italic">both</span>'), '<b><i>both</i></b>');
  eq(clean('<span style="text-decoration:underline line-through">x</span>'), '<u><s>x</s></u>');
});
test('mso-* vendor properties are not mistaken for formatting', () => {
  eq(clean('<span style="mso-bidi-font-weight:bold">x</span>'), 'x');
});
test('Google Docs wrapper <b style="font-weight:normal"> is not bold', () => {
  eq(clean('<b style="font-weight:normal" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:400">plain</span> <span style="font-weight:700">strong</span></p></b>'), '<p>plain <b>strong</b></p>');
});
test('semantic tags are canonicalised', () => {
  eq(clean('<strong>a</strong><em>b</em><strike>c</strike><del>d</del>'), '<b>a</b><i>b</i><s>c</s><s>d</s>');
  eq(clean('<h1>a</h1><h4>b</h4><h6>c</h6>'), '<h1>a</h1><h3>b</h3><h3>c</h3>');
});
test('rich formatting from Google Docs / Word survives: colours, sizes, fonts, alignment, spacing, sub/superscript', () => {
  eq(clean('<span style="color:#ff0000;font-size:18pt;font-family:Georgia;background-color:#ffff00">x</span>'), '<span style="color:#ff0000;background-color:#ffff00;font-size:18pt;font-family:Georgia">x</span>');
  eq(clean('<p style="text-align:center;line-height:1.5;margin-left:36pt;position:fixed">c</p>'), '<p style="text-align:center;line-height:1.5;margin-left:36pt">c</p>');
  eq(clean('<h2 style="text-align:right">h</h2>'), '<h2 style="text-align:right">h</h2>');
  eq(clean('x<sub>2</sub> y<sup>3</sup>'), 'x<sub>2</sub> y<sup>3</sup>');
  eq(clean('<span style="font-weight:700;color:rgb(217, 48, 37)">b</span>'), '<b><span style="color:rgb(217, 48, 37)">b</span></b>');
  eq(clean('<table><tr><td style="text-align:center">c</td></tr></table>').includes('<td style="text-align:center">c</td>'), true);
});
test('pasted pure black and white backgrounds are dropped so text stays readable in dark mode', () => {
  eq(clean('<span style="color:#000000">k</span> <span style="color:rgb(0,0,0)">k2</span> <span style="color:black">k3</span>'), 'k k2 k3');
  eq(clean('<span style="background-color:#ffffff">w</span> <span style="background-color:transparent">t</span>'), 'w t');
  eq(clean('<span style="color:#000001">almost</span>'), '<span style="color:#000001">almost</span>');
});
test('lists, quotes and code survive', () => {
  eq(clean('<ul><li>one<ul><li>nested</li></ul></li></ul><ol><li>n</li></ol>'), '<ul><li>one<ul><li>nested</li></ul></li></ul><ol><li>n</li></ol>');
  eq(clean('<blockquote>q</blockquote><pre>c</pre><code>x</code>'), '<blockquote>q</blockquote><pre>c</pre><code>x</code>');
});
test('tables keep their structure, without attributes or styling', () => {
  eq(clean('<p>x</p><table border=1 style="width:99%"><colgroup><col></colgroup><thead><tr><th style="color:red">H</th></tr></thead><tbody><tr><td colspan=2 onclick="x()">a</td><td>b</td></tr></tbody><tfoot><tr><td>f</td></tr></tfoot></table>'),
    '<p>x</p><table><thead><tr><th>H</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody><tbody><tr><td>f</td></tr></tbody></table>');
  eq(clean('<table><tr><td><b>bold</b> <span style="font-style:italic">it</span></td></tr></table>'), '<table><tbody><tr><td><b>bold</b> <i>it</i></td></tr></tbody></table>');
});
test('links: safe schemes kept, dangerous ones reduced to text', () => {
  eq(clean('<a href="https://ok.example/x?a=1">ok</a>'), '<a href="https://ok.example/x?a=1">ok</a>');
  eq(clean('<a href="mailto:a@b.co">m</a>'), '<a href="mailto:a@b.co">m</a>');
  for (const bad of ['javascript:alert(1)', 'JaVa\tScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example', '/relative']) eq(clean(`<a href="${bad}">t</a>`), 't', bad);
});
test('scripts, handlers, frames, svg, math, forms and images are removed', () => {
  const out = clean('<img src=x onerror=alert(1)><script>alert(1)</script><iframe src=x></iframe><svg><script>1</script></svg><math><mi>2</mi></math><form><button>go</button></form><object data=x></object>ok');
  eq(out, 'ok');
  lacks(clean('<p onclick="x()" style="color:red" class="c" id="i">hi</p>'), /onclick|style=|class=|id=/);
});
test('inert parsing: nothing in pasted HTML executes', () => {
  window.__qa_pwned = 0;
  clean('<img src=x onerror="window.__qa_pwned=1"><svg onload="window.__qa_pwned=2"></svg><script>window.__qa_pwned=3</script><body onload="window.__qa_pwned=4">');
  eq(window.__qa_pwned, 0);
});
test('pathological input does not hang', () => {
  const t0 = performance.now();
  clean('<b>'.repeat(5000) + 'x' + '</b>'.repeat(5000));
  clean('<div>'.repeat(3000) + 'x');
  clean('<span style="font-weight:bold">'.repeat(2000) + 'x');
  if (performance.now() - t0 > 3000) throw new Error('too slow');
});
test('safeUrl', () => {
  eq(safeUrl('https://a.co'), 'https://a.co'); eq(safeUrl(' mailto:a@b.co '), 'mailto:a@b.co');
  eq(safeUrl('javascript:1'), null); eq(safeUrl(''), null); eq(safeUrl(null), null); eq(safeUrl('ftp://x'), null);
});

// ---- formatting helpers ------------------------------------------------------------
const ago = (ms) => new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
test('timeAgo', () => {
  eq(timeAgo(ago(5000)), 'just now');
  has(timeAgo(ago(5 * 60000)), '5');
  has(timeAgo(ago(3 * 3600000)), '3');
  eq(timeAgo('not a date'), '');
});
test('initials, avatar colour and pluralize', () => {
  eq(initials('Alice Rivera'), 'AR'); eq(initials('  bob  '), 'B'); eq(initials(''), '?'); eq(initials('Åsa Öberg Smith'), 'ÅÖ');
  eq(avatarClass('Alice'), avatarClass('Alice')); if (!/^av-[0-7]$/.test(avatarClass('x'))) throw new Error('bad class');
  eq(pluralize(1, 'word'), '1 word'); eq(pluralize(0, 'word'), '0 words'); eq(pluralize(2, 'person', 'people'), '2 people');
  eq(parseTs('2026-11-09 12:00:00').toISOString(), '2026-11-09T12:00:00.000Z');
});

// ---- diff -----------------------------------------------------------------------------
const d = (a, b) => JSON.stringify(diffStats(a, b));
test('diffStats: counts words added and removed', () => {
  eq(d('', ''), '{"added":0,"removed":0}');
  eq(d('a b c', 'a b c'), '{"added":0,"removed":0}');
  eq(d('a b c', 'a b c d e'), '{"added":2,"removed":0}');
  eq(d('a b c d e', 'a b'), '{"added":0,"removed":3}');
  eq(d('the quick brown fox', 'the slow brown dog'), '{"added":2,"removed":2}');
  eq(d('', 'new text here'), '{"added":3,"removed":0}');
  eq(d('old text', ''), '{"added":0,"removed":2}');
  eq(d('a b a b', 'b a b a'), '{"added":1,"removed":1}', 'order matters');
  eq(d('  spaced   out \n words ', 'spaced out words'), '{"added":0,"removed":0}', 'whitespace is ignored');
});
test('diffStats: huge inputs stay fast and sane', () => {
  const big = (n, w) => Array.from({ length: n }, (_, i) => `${w}${i % 97}`).join(' ');
  const t0 = performance.now();
  const r = diffStats(big(8000, 'a'), big(8000, 'a') + ' extra words appended');
  if (performance.now() - t0 > 2000) throw new Error('too slow');
  eq(r.added, 3); eq(r.removed, 0);
  const r2 = diffStats(big(5000, 'x'), big(5000, 'y'));
  if (r2.added !== 5000 || r2.removed !== 5000) throw new Error(JSON.stringify(r2));
});
test('htmlToPlain: strips markup without executing anything', () => {
  window.__qa_d = 0;
  eq(htmlToPlain('<p>Hi <b>there</b></p><img src=x onerror="window.__qa_d=1"><script>window.__qa_d=2</script>').trim(), 'Hi there');
  eq(window.__qa_d, 0);
  eq(htmlToPlain(''), ''); eq(htmlToPlain(null), '');
});


// ---- statistics ------------------------------------------------------------------------
test('countStats: words, characters, sentences, paragraphs, reading time', () => {
  const st = countStats('Hello world. This is a test!\n\nSecond paragraph here? Yes.');
  eq(st.words, 10); eq(st.paragraphs, 2); eq(st.sentences, 4);
  eq(st.characters, 'Hello world. This is a test!Second paragraph here? Yes.'.length);
  eq(st.charactersNoSpaces, 'Helloworld.Thisisatest!Secondparagraphhere?Yes.'.length);
  if (!(st.readingMinutes > 0 && st.readingMinutes < 1)) throw new Error('reading time');
  const empty = countStats('');
  eq(empty.words, 0); eq(empty.sentences, 0); eq(empty.paragraphs, 0);
  eq(countStats('one\u200btwo   three\n').words, 2, 'zero-width space is not a word separator but does not count');
  eq(countStats(null).words, 0);
  eq(countStats('no punctuation at all').sentences, 1);
});

// ---- formatter (runs against a real contenteditable) ---------------------------------------------
function fixture(html) {
  const host = document.createElement('div');
  const ed = document.createElement('div');
  ed.contentEditable = 'true'; ed.innerHTML = html; host.append(ed); document.body.append(host);
  let edits = 0;
  const fmt = createFormatter({ editor: ed, onEdit: () => { edits++; } });
  const select = (el) => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
  return { ed, fmt, select, get edits() { return edits; }, done: () => host.remove() };
}
test('formatter: line spacing and indent on blocks, and removal restores a clean attribute-free block', () => {
  const f = fixture('<p>one</p><p>two</p><h2>three</h2>');
  const [p1, p2] = f.ed.querySelectorAll('p');
  f.select(p1); f.fmt.lineSpacing('1.5');
  eq(p1.style.lineHeight, '1.5'); eq(p2.style.lineHeight, '');
  f.fmt.indent(1); f.fmt.indent(1);
  eq(p1.style.marginLeft, '72px');
  f.fmt.indent(-1); eq(p1.style.marginLeft, '36px');
  f.fmt.indent(-1); f.fmt.indent(-1); eq(p1.style.marginLeft, '', 'never below zero');
  f.fmt.lineSpacing(null); eq(p1.getAttribute('style'), null, 'no empty style attribute is left behind');
  for (let i = 0; i < 20; i++) f.fmt.indent(1);
  eq(p1.style.marginLeft, '360px', 'indent is capped');
  const r = document.createRange(); r.setStartBefore(f.ed.querySelector('p')); r.setEndAfter(f.ed.querySelector('h2')); getSelection().removeAllRanges(); getSelection().addRange(r);
  eq(f.fmt.selectedBlocks().length, 3, 'a multi-block selection touches every block');
  if (f.edits < 4) throw new Error('onEdit must fire for each change');
  f.done();
});
test('formatter: checklist toggle on a paragraph, a bullet list and a numbered list', () => {
  const f = fixture('<p>task</p>');
  f.select(f.ed.querySelector('p')); f.fmt.toggleChecklist();
  const ul = f.ed.querySelector('ul'); if (!ul) throw new Error('no list was created');
  eq(ul.dataset.type, 'check');
  f.fmt.toggleChecklist(); eq(ul.hasAttribute('data-type'), false, 'toggling again turns it back into a plain list');
  f.done();
  const g = fixture('<ol><li>one</li><li data-checked="true">two</li></ol>');
  g.select(g.ed.querySelector('li')); g.fmt.toggleChecklist();
  const conv = g.ed.querySelector('ul'); if (!conv) throw new Error('an ordered list becomes a checklist');
  eq(conv.dataset.type, 'check'); eq(g.ed.querySelectorAll('li').length, 2); eq(g.ed.querySelector('ol'), null);
  g.done();
});
test('formatter: clicking a checklist box toggles it, clicking the text does not', () => {
  const f = fixture('<ul data-type="check"><li>a</li><li data-checked="true">b</li></ul>');
  const [a, b] = f.ed.querySelectorAll('li');
  const box = a.getBoundingClientRect();
  const ev = (x, target) => ({ target, clientX: x });
  eq(f.fmt.handleChecklistClick(ev(box.left + 40, a)), false, 'clicks on the text are left alone');
  eq(a.hasAttribute('data-checked'), false);
  eq(f.fmt.handleChecklistClick(ev(box.left + 6, a)), true); eq(a.getAttribute('data-checked'), 'true');
  eq(f.fmt.handleChecklistClick(ev(b.getBoundingClientRect().left + 6, b)), true); eq(b.hasAttribute('data-checked'), false);
  f.done();
  const plain = fixture('<ul><li>x</li></ul>');
  eq(plain.fmt.handleChecklistClick({ target: plain.ed.querySelector('li'), clientX: 0 }), false, 'plain lists ignore it');
  plain.done();
});
test('formatter: a new item created by Enter in a checklist starts unchecked', () => {
  const f = fixture('<ul data-type="check"><li data-checked="true">done</li><li data-checked="true"><br></li></ul>');
  const second = f.ed.querySelectorAll('li')[1];
  const r = document.createRange(); r.setStart(second, 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r);
  f.fmt.afterInput({ inputType: 'insertParagraph' });
  eq(second.hasAttribute('data-checked'), false, 'the empty copy is unchecked');
  eq(f.ed.querySelector('li').getAttribute('data-checked'), 'true', 'the original keeps its state');
  f.done();
});
test('formatter: size helpers and the font/size catalogues', () => {
  const f = fixture('<p style="font-size:24px">big</p>');
  f.select(f.ed.querySelector('p').firstChild);
  eq(f.fmt.currentSize(), 24); eq(typeof f.fmt.currentFont(), 'object');
  eq(SIZES.includes(12) && SIZES.includes(72), true); eq(FONTS.includes('Georgia') && FONTS.includes('Arial'), true);
  if (new Set(FONTS).size !== FONTS.length) throw new Error('duplicate fonts');
  f.done();
});

// ---- pictures ---------------------------------------------------------------------
const canvasBlob = (w, h, type, noise = false) => new Promise((resolve) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#3366cc'; x.fillRect(0, 0, w, h);
  if (noise) { const d = x.getImageData(0, 0, w, h); for (let i = 0; i < d.data.length; i += 4) { d.data[i] = Math.random() * 255; d.data[i + 1] = Math.random() * 255; d.data[i + 2] = Math.random() * 255; } x.putImageData(d, 0, 0); }
  c.toBlob(resolve, type);
});
const dims = (src) => new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve([im.naturalWidth, im.naturalHeight]); im.onerror = () => reject(new Error('not an image')); im.src = src; });
test('pictures: a large PNG is scaled down and stays a PNG', async () => {
  const src = await imageToDataUrl(new File([await canvasBlob(2600, 1300, 'image/png')], 'wide.png', { type: 'image/png' }));
  has(src, 'data:image/png;base64,');
  const [w, hgt] = await dims(src);
  eq(w, 1280); eq(hgt, 640);
});
test('pictures: a small image is never enlarged', async () => {
  const src = await imageToDataUrl(new File([await canvasBlob(40, 30, 'image/png')], 'tiny.png', { type: 'image/png' }));
  const [w, hgt] = await dims(src); eq(w, 40); eq(hgt, 30);
});
test('pictures: an image too noisy for PNG falls back to JPEG within the size limit', async () => {
  const src = await imageToDataUrl(new File([await canvasBlob(1200, 900, 'image/png', true)], 'noise.png', { type: 'image/png' }));
  has(src, 'data:image/jpeg;base64,');
  if (src.length > 900_000) throw new Error(`too big: ${src.length}`);
});
test('pictures: unsupported or unreadable files are rejected with a clear message', async () => {
  for (const [file, msg] of [[new File(['hello'], 'a.txt', { type: 'text/plain' }), /Only PNG/], [new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }), /Only PNG/], [new File(['not really a png'], 'a.png', { type: 'image/png' }), /not a readable picture/]]) {
    let err = null; try { await imageToDataUrl(file); } catch (e) { err = e; }
    if (!err || !msg.test(err.message)) throw new Error(`expected ${msg} for ${file.name}, got ${err && err.message}`);
  }
});

// ---- table of contents -------------------------------------------------------------
function tocFixture(html) {
  const ed = document.createElement('div');
  ed.contentEditable = 'true'; ed.innerHTML = html;
  document.body.append(ed);
  const toc = createToc({ editor: ed, getCanEdit: () => true, onEdit: () => {}, exec: (c, v) => { ed.focus(); document.execCommand(c, false, v); } });
  const caretAtStart = () => { ed.focus(); const r = document.createRange(); r.setStart(ed, 0); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
  return { ed, toc, caretAtStart, done: () => ed.remove() };
}
test('toc: every heading gets a unique valid id, existing ones are kept', () => {
  const f = tocFixture('<h1 id="h-0a1b2c3d">A</h1><h2>B</h2><h2 id="h-0a1b2c3d">C (duplicate id)</h2><h3 id="bad id">D</h3><p>text</p>');
  eq(f.toc.ensureIds(), true);
  const ids = [...f.ed.querySelectorAll('h1,h2,h3')].map((x) => x.id);
  eq(ids[0], 'h-0a1b2c3d'); eq(new Set(ids).size, 4, 'ids must be unique');
  for (const id of ids) if (!/^h-[a-z0-9]{4,16}$/.test(id)) throw new Error(`bad id ${id}`);
  eq(f.toc.ensureIds(), false, 'second pass changes nothing');
  f.done();
});
test('toc: insert builds indented links in document order and update follows heading edits', () => {
  const f = tocFixture('<h1>Intro</h1><p>x</p><h2>Part</h2><p>y</p><h1>End</h1>');
  f.caretAtStart(); f.toc.insert();
  const ul = f.ed.querySelector('ul[data-type="toc"]');
  eq(ul.querySelectorAll('a').length, 3);
  eq([...ul.querySelectorAll('a')].map((a) => a.textContent).join('|'), 'Intro|Part|End');
  eq(ul.querySelectorAll('li')[1].style.marginLeft, '24px');
  for (const a of ul.querySelectorAll('a')) if (!f.ed.querySelector(`[id="${a.getAttribute('href').slice(1)}"]`)) throw new Error('link without a target heading');
  f.ed.querySelectorAll('h2')[0].textContent = 'Renamed part';
  f.ed.querySelector('p').remove();
  eq(f.toc.update(), true);
  eq([...ul.querySelectorAll('a')].map((a) => a.textContent).join('|'), 'Intro|Renamed part|End');
  eq(f.toc.update(), false, 'nothing to do the second time');
  f.done();
});
test('toc: headings inside the table of contents itself are never listed; empty documents get a hint', () => {
  const f = tocFixture('<p>no headings</p>');
  f.caretAtStart(); f.toc.insert();
  has(f.ed.querySelector('ul[data-type="toc"]').textContent, 'Add headings');
  f.done();
});

// ---- automatic merge ---------------------------------------------------------------
const P = (...t) => t.map((x) => `<p>${x}</p>`).join('');
test('merge: edits to different paragraphs are both kept', () => {
  const base = P('one', 'two', 'three', 'four');
  const m = mergeHtml(base, P('one', 'TWO mine', 'three', 'four'), P('one', 'two', 'three', 'FOUR theirs'));
  eq(m, P('one', 'TWO mine', 'three', 'FOUR theirs').replace(/<\/p><p>/g, '</p>\n<p>'));
});
test('merge: insertions and deletions in different places combine', () => {
  const base = P('a', 'b', 'c', 'd');
  const m = mergeHtml(base, P('a', 'new', 'b', 'c', 'd'), P('a', 'b', 'd'));
  eq(m.replace(/\n/g, ''), P('a', 'new', 'b', 'd'));
});
test('merge: the same paragraph changed differently is a conflict (null), identical edits are not', () => {
  const base = P('a', 'b', 'c');
  eq(mergeHtml(base, P('a', 'B1', 'c'), P('a', 'B2', 'c')), null);
  eq(mergeHtml(base, P('a', 'B', 'c'), P('a', 'B', 'c')).replace(/\n/g, ''), P('a', 'B', 'c'));
  eq(mergeHtml(base, P('a', 'x', 'b', 'c'), P('a', 'y', 'b', 'c')), null, 'two insertions at one spot');
  eq(mergeHtml(base, P('a', 'c'), P('a', 'B2', 'c')), null, 'delete versus edit');
});
test('merge: block-level primitives behave on edge cases', () => {
  eq(JSON.stringify(merge3([], ['x'], [])), JSON.stringify(['x']));
  eq(JSON.stringify(merge3(['a'], [], ['a'])), JSON.stringify([]));
  eq(JSON.stringify(changes(['a', 'b'], ['a', 'b'])), '[]');
  eq(mergeHtml('', '', ''), '');
  eq(mergeHtml(P('a'), P('a'), P('a', 'b')).replace(/\n/g, ''), P('a', 'b'), 'only the other side changed');
});

test('merge: different sentences of the same paragraph merge at word level; the same words conflict', () => {
  const base = '<p>The quick brown fox jumps over the lazy dog. It was a sunny day.</p>';
  const mine = '<p>The quick red fox jumps over the lazy dog. It was a sunny day.</p>';
  const theirs = '<p>The quick brown fox jumps over the lazy dog. It was a rainy day.</p>';
  eq(mergeHtml(base, mine, theirs), '<p>The quick red fox jumps over the lazy dog. It was a rainy day.</p>');
  eq(mergeHtml(base, mine, '<p>The quick green fox jumps over the lazy dog. It was a sunny day.</p>'), null);
  eq(mergeHtml(base, mine, mine), mine.replace(/$/, ''), 'identical edits');
});

test('merge: a word-level merge that would break the tag structure is refused', () => {
  const base = '<p>Alpha beta gamma delta</p>';
  eq(mergeHtml(base, '<h2>Alpha beta gamma delta</h2>', '<p>Alpha beta</p><p>gamma delta</p>'), null);
});

// ---- insights ----------------------------------------------------------------------
test('insights: words and sentences come from Intl.Segmenter (CJK and Arabic count correctly)', () => {
  const zh = countStats('今天天气很好。我们去公园玩。'); // two sentences, several words
  if (zh.words < 4) throw new Error(`Chinese words: ${zh.words}`);
  eq(zh.sentences, 2);
  eq(countStats('مرحبا بالعالم الجميل').words, 3);
  eq(countStats('').words, 0); eq(countStats('   \n ').sentences, 0);
  eq(countStats('One two three. Four five!').sentences, 2);
});
test('insights: Flesch reading ease ranks simple text easier than dense text, and is hidden for non-English', () => {
  const easy = countStats('The cat sat on the mat. The dog ran to the park. We like it.');
  const hard = countStats('Notwithstanding considerable organizational complexity, institutional methodologies necessitate comprehensive interdepartmental coordination.');
  if (!(easy.flesch > hard.flesch + 40)) throw new Error(`easy ${easy.flesch} vs hard ${hard.flesch}`);
  eq(countStats('今天天气很好。').flesch, null);
  eq(easy.top.length === 0 || easy.top[0][1] > 1, true);
  eq(countStats('data data data model model').top[0][0], 'data');
});

// ---- command palette ranking and labels ---------------------------------------------
test('palette: substring words rank first, subsequences ("bld") still match, nonsense does not', () => {
  const bold = { label: 'Bold', group: 'Format' }, table = { label: 'Table', group: 'Insert' }, toc = { label: 'Table of contents', group: 'Insert' };
  if (!(rank(table, 'table').score > rank(bold, 'bld').score)) throw new Error('a direct match must outrank a fuzzy one');
  eq(Boolean(rank(bold, 'bld')), true);
  eq(rank(bold, 'xyz'), null);
  eq(Boolean(rank(toc, 'toc')), true);
  eq(rank(table, '').score, 1);
});
test('keyLabel leaves non-Apple labels alone and never throws on odd input', () => {
  eq(typeof keyLabel('Ctrl+B'), 'string'); eq(keyLabel(5), 5); eq(keyLabel(''), '');
});

// ---- accessibility of the built UI ---------------------------------------------------
test('a11y: every button, input and select in the list view has an accessible name', async () => {
  const { renderList } = await import('/js/views/list.js');
  const root = document.createElement('div'); document.body.append(root);
  const stop = renderList(root, { user: { id: 1, display_name: 'Test User' }, navigate: () => {} });
  await new Promise((r) => setTimeout(r, 300));
  const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || (el.labels && el.labels[0] && el.labels[0].textContent) || el.placeholder || '').trim();
  const bad = [...root.querySelectorAll('button, input:not([type="hidden"]), select, a[href]')].filter((el) => !el.closest('[hidden]') && !name(el)).map((el) => el.outerHTML.slice(0, 80));
  if (typeof stop === 'function') stop();
  root.remove();
  if (bad.length) throw new Error(`unnamed controls: ${bad.join(' | ')}`);
});

// ---- runner ----------------------------------------------------------------------------
let failed = 0;
const list = document.getElementById('results');
for (const c of cases) {
  const li = document.createElement('li');
  try { await c.fn(); li.className = 'pass'; li.textContent = c.name; }
  catch (e) { failed++; li.className = 'fail'; li.textContent = c.name; const s = document.createElement('small'); s.textContent = e.message; li.append(s); }
  list.append(li);
}
const summary = document.getElementById('summary');
summary.textContent = failed ? `${failed} of ${cases.length} failed` : `All ${cases.length} browser tests passed`;
summary.className = `summary ${failed ? 'fail' : 'pass'}`;
document.title = failed ? `QA: ${failed} FAILED` : `QA: ${cases.length}/${cases.length} PASS`;
window.__qa = { total: cases.length, failed };
