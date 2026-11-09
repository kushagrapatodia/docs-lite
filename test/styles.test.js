'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normColor, normSize, normFont, normAlign, normLineHeight, normIndent, cleanStyle, fontTagStyle } = require('../src/styles');
const { sanitizeHtml, markdownToHtml } = require('../src/sanitize');
const { htmlToDocx, docxToHtml, writeZip } = require('../src/docx');
const { toMarkdown, toText } = require('../src/export');

test('colours: hex, rgb(a) and named colours are normalised; everything else is refused', () => {
  assert.equal(normColor('#F00'), '#ff0000');
  assert.equal(normColor('#A1B2C3'), '#a1b2c3');
  assert.equal(normColor('#a1b2c3ff'), '#a1b2c3');
  assert.equal(normColor('rgb(255, 128, 0)'), '#ff8000');
  assert.equal(normColor('rgba(0,0,0,0.5)'), '#000000');
  assert.equal(normColor('rgb(0 128 255)'), '#0080ff');
  assert.equal(normColor('RED'), '#ff0000');
  assert.equal(normColor('rgba(1,2,3,0)'), null, 'fully transparent is not a colour');
  for (const bad of ['rgb(300,0,0)', 'javascript:alert(1)', 'url(x)', 'var(--x)', 'hsl(10,10%,10%)', '#12', '#12345', 'expression(alert(1))', '', null, undefined, 'red;background:blue', '#fff url(x)']) assert.equal(normColor(bad), null, String(bad));
});

test('sizes: px and pt in a sane range, keywords mapped, nothing else', () => {
  assert.equal(normSize('18px'), '18px');
  assert.equal(normSize('12pt'), '16px');
  assert.equal(normSize('14pt'), '18.67px');
  assert.equal(normSize('x-large'), '24px');
  assert.equal(normSize('11.5px'), '11.5px');
  for (const bad of ['5px', '201px', '0', '-10px', '1em', '2rem', '150%', 'calc(1px+1px)', '10', 'big', '1e3px', '999px']) assert.equal(normSize(bad), null, bad);
});

test('fonts: only the listed families (first in the stack), generics mapped', () => {
  assert.equal(normFont('"Times New Roman", serif'), 'Times New Roman');
  assert.equal(normFont("georgia"), 'Georgia');
  assert.equal(normFont('Comic Sans MS, cursive'), 'Comic Sans MS');
  assert.equal(normFont('sans-serif'), 'Arial');
  assert.equal(normFont('monospace'), 'Courier New');
  for (const bad of ['Papyrus', 'evil"; background: url(x)', '', 'url(x)', 'Arial Black Extra']) assert.equal(normFont(bad), null, bad);
});

test('alignment, line height and indent', () => {
  assert.equal(normAlign('center'), 'center');
  assert.equal(normAlign('-webkit-center'), 'center');
  assert.equal(normAlign('end'), 'right');
  assert.equal(normAlign('left'), null, 'the default is not stored');
  assert.equal(normAlign('start'), null);
  assert.equal(normAlign('diagonal'), null);
  assert.equal(normLineHeight('1.5'), '1.5');
  assert.equal(normLineHeight('150%'), '1.5');
  assert.equal(normLineHeight('0.5'), null);
  assert.equal(normLineHeight('9'), null);
  assert.equal(normLineHeight('24px'), null);
  assert.equal(normIndent('36px'), '36px');
  assert.equal(normIndent('27pt'), '36px');
  assert.equal(normIndent('0px'), null);
  assert.equal(normIndent('10000px'), null);
  assert.equal(normIndent('-20px'), null);
});

test('cleanStyle keeps only valid declarations of the right kind, in a canonical order', () => {
  assert.equal(cleanStyle('font-family: Georgia; color: RED; position: fixed; font-size: 14pt; background: url(javascript:x); background-color: #ff0', 'inline'),
    "color:#ff0000;background-color:#ffff00;font-size:18.67px;font-family:'Georgia'");
  assert.equal(cleanStyle('margin-left:36px; text-align: center; color: red; line-height:150%', 'block'), 'text-align:center;line-height:1.5;margin-left:36px');
  assert.equal(cleanStyle('color:red;', 'block'), '', 'colour is not a block property');
  assert.equal(cleanStyle('text-align:center', 'inline'), '', 'alignment is not an inline property');
  assert.equal(cleanStyle('color: red !important', 'inline'), 'color:#ff0000');
  assert.equal(cleanStyle('color:red;color:blue', 'inline'), 'color:#0000ff', 'last declaration wins');
  for (const evil of ['color: \\72 ed', 'background-color: expression(alert(1))', 'font-size: calc(1px + 1px)', 'color: var(--x)', '/* c */ color: red; behavior: url(x.htc)', '@import "x"']) {
    assert.doesNotMatch(cleanStyle(evil, 'inline'), /url|expression|@import|calc|var\(|behavior|\\/i, evil);
  }
  assert.equal(cleanStyle(null, 'inline'), '');
  assert.equal(cleanStyle(';;;:::', 'block'), '');
  assert.equal(fontTagStyle({ color: '#00f', face: 'Arial', size: '5' }), 'color:#00f;font-family:Arial;font-size:24px');
});

test('sanitiser: styles survive only through the allow-list; bare spans disappear', () => {
  assert.equal(sanitizeHtml('<span style="color: rgb(255,0,0); font-size: 18pt">x</span>'), '<span style="color:#ff0000;font-size:24px">x</span>');
  assert.equal(sanitizeHtml('<span style="position:fixed;top:0">x</span>'), 'x');
  assert.equal(sanitizeHtml('<span>a<span style="color:blue">b</span>c</span>'), 'a<span style="color:#0000ff">b</span>c');
  assert.equal(sanitizeHtml('<span class="x" id="y" onclick="z()">t</span>'), 't');
  assert.equal(sanitizeHtml('<p style="text-align:center;color:red;position:absolute" onclick="x()">c</p>'), '<p style="text-align:center">c</p>');
  assert.equal(sanitizeHtml('<p align="right">r</p>'), '<p style="text-align:right">r</p>');
  assert.equal(sanitizeHtml('<font color="#00f" face="Georgia" size="5">f</font>'), '<span style="color:#0000ff;font-size:24px;font-family:\'Georgia\'">f</span>');
  assert.equal(sanitizeHtml('<h2 style="text-align:justify;line-height:2">h</h2>'), '<h2 style="text-align:justify;line-height:2">h</h2>');
  assert.equal(sanitizeHtml('<td style="text-align:center">c</td>'), '<td style="text-align:center">c</td>');
  assert.equal(sanitizeHtml('<b style="color:red">bold</b>'), '<b>bold</b>', 'styles are only kept where they are supported');
  assert.equal(sanitizeHtml('x<sub>2</sub> y<sup>3</sup>'), 'x<sub>2</sub> y<sup>3</sup>');
  assert.equal(sanitizeHtml('<span style="font-family:Papyrus">p</span>'), 'p');
  const once = sanitizeHtml('<p style="margin-left:36px;line-height:150%"><span style="font-family:Georgia,serif;color:red">x</span></p>');
  assert.equal(sanitizeHtml(once), once, 'idempotent');
});

test('sanitiser: checklist markers survive only on <ul> and <li> with exact values', () => {
  assert.equal(sanitizeHtml('<ul data-type="check"><li data-checked="true">a</li><li>b</li></ul>'), '<ul data-type="check"><li data-checked="true">a</li><li>b</li></ul>');
  assert.equal(sanitizeHtml('<ul data-type="evil" data-x="1"><li data-checked="yes">a</li></ul>'), '<ul><li>a</li></ul>');
  assert.equal(sanitizeHtml('<p data-type="check" data-checked="true">p</p>'), '<p>p</p>');
});

test('Word round trip keeps colours, sizes, fonts, highlights, alignment, spacing, indent and sub/superscript', () => {
  const html = sanitizeHtml('<h2 style="text-align:center">Centered</h2><p style="text-align:justify;line-height:2;margin-left:72px"><span style="color:#ff0000;font-size:24px;font-family:Georgia;background-color:#ffff00">Big red</span> x<sub>2</sub> y<sup>3</sup></p><p style="text-align:right"><b>right</b></p>');
  const back = docxToHtml(htmlToDocx(html, 'T'));
  assert.match(back, /<h2 style="text-align:center">Centered<\/h2>/);
  assert.match(back, /<p style="text-align:justify;line-height:2;margin-left:72px">/);
  assert.match(back, /<span style="color:#ff0000;background-color:#ffff00;font-size:24px;font-family:'Georgia'">Big red<\/span>/);
  assert.match(back, /x<sub>2<\/sub> y<sup>3<\/sup>/);
  assert.match(back, /<p style="text-align:right"><b>right<\/b><\/p>/);
  assert.equal(sanitizeHtml(back), back);
  assert.equal(docxToHtml(htmlToDocx(back, 'T')), back, 'stable on a second pass');
});

test('Word import: run properties, highlight palette, shading and paragraph layout from real-world XML', () => {
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const doc = `<w:document ${NS}><w:body>
    <w:p><w:pPr><w:jc w:val="both"/><w:spacing w:line="360" w:lineRule="auto"/><w:ind w:left="720"/></w:pPr>
      <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="1F4E79"/><w:sz w:val="28"/></w:rPr><w:t>Blue Arial 14pt</w:t></w:r>
      <w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>Marked</w:t></w:r>
      <w:r><w:rPr><w:shd w:val="clear" w:color="auto" w:fill="C6E0B4"/></w:rPr><w:t>Shaded</w:t></w:r>
      <w:r><w:rPr><w:color w:val="000000"/><w:rFonts w:ascii="Papyrus"/></w:rPr><w:t>Black is the default colour; Papyrus is not allowed</w:t></w:r>
      <w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>sup</w:t></w:r>
    </w:p>
    <w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:t>left is the default</w:t></w:r></w:p>
    <w:p><w:pPr><w:jc w:val="right"/><w:spacing w:line="480" w:lineRule="exact"/></w:pPr><w:r><w:t>exact spacing ignored</w:t></w:r></w:p>
  </w:body></w:document>`;
  const html = docxToHtml(writeZip([['word/document.xml', doc]]));
  assert.match(html, /<p style="text-align:justify;line-height:1.5;margin-left:48px">/);
  assert.match(html, /<span style="color:#1f4e79;font-size:18.67px;font-family:'Arial'">Blue Arial 14pt<\/span>/);
  assert.match(html, /<span style="background-color:#ffff00">Marked<\/span>/);
  assert.match(html, /<span style="background-color:#c6e0b4">Shaded<\/span>/);
  assert.match(html, /Black is the default colour; Papyrus is not allowed/);
  assert.doesNotMatch(html, /Papyrus"|000000/);
  assert.match(html, /<sup>sup<\/sup>/);
  assert.match(html, /<p>left is the default<\/p>/);
  assert.match(html, /<p style="text-align:right">exact spacing ignored<\/p>/);
});

test('checklists: Markdown task lists in and out, text export, and Word ballot boxes both ways', () => {
  const html = sanitizeHtml(markdownToHtml('# Plan\n\n- [ ] write tests\n- [x] ship it\n- plain bullet\n\n1. one'));
  assert.match(html, /<ul data-type="check">\s*<li>write tests<\/li>\s*<li data-checked="true">ship it<\/li>\s*<\/ul>/);
  assert.match(html, /<ul>\s*<li>plain bullet<\/li>\s*<\/ul>/);
  const md = toMarkdown(html);
  assert.match(md, /^- \[ \] write tests\n- \[x\] ship it$/m);
  assert.match(md, /^- plain bullet$/m);
  assert.equal(sanitizeHtml(markdownToHtml(md)), html, 'Markdown round trip is stable');
  assert.match(toText(html), /- \[ \] write tests\n- \[x\] ship it/, 'plain text keeps the checkbox state');
  const back = docxToHtml(htmlToDocx(html, 'T'));
  assert.match(back, /<ul data-type="check">\s*<li>write tests\s*<\/li>\s*<li data-checked="true">ship it\s*<\/li>\s*<\/ul>/);
  assert.match(back, /<ul>\s*<li>plain bullet/);
});

// ---- images ----------------------------------------------------------------------------------------
const { imageSize } = require('../src/docx');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('images: only embedded raster data URLs survive', () => {
  const ok = sanitizeHtml(`<p><img src="data:image/png;base64,${PNG}" alt="a <b>px</b>" width="120" onerror="x()"></p>`);
  assert.equal(ok, `<p><img src="data:image/png;base64,${PNG}" alt="a &lt;b&gt;px&lt;/b&gt;" width="120"></p>`);
  assert.equal(sanitizeHtml(ok), ok); // idempotent
  for (const bad of ['<img src="https://evil.example/x.png">', '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">', '<img src="javascript:alert(1)">', '<img src="data:image/png;base64,@@@">', '<img>', '<img src="data:text/html;base64,PGI+">']) {
    assert.equal(sanitizeHtml(`<p>x${bad}y</p>`), '<p>xy</p>', bad);
  }
  assert.ok(!sanitizeHtml(`<img src="data:image/png;base64,${PNG}" width="99999">`).includes('width='));
});

test('images: exports and the .docx round trip', () => {
  const html = `<p>Before <img src="data:image/png;base64,${PNG}" alt="dot" width="160"> after</p>`;
  assert.match(toMarkdown(html), /Before \[Image: dot\] after/);
  assert.match(toText(html), /Before \[Image: dot\] after/);
  assert.equal(docxToHtml(htmlToDocx(html, 'T')), html);
  assert.deepEqual(imageSize(Buffer.from(PNG, 'base64')), { w: 1, h: 1 });
});

test('page breaks: kept by the sanitiser, exported to .docx and read back', () => {
  const html = '<p>one</p><hr data-type="page"><p>two</p><hr>';
  assert.equal(sanitizeHtml(html), html);
  assert.equal(sanitizeHtml('<hr data-type="evil" onclick="x()">'), '<hr>');
  const docx = htmlToDocx(html, 'T');
  assert.match(readZipText(docx), /<w:br w:type="page"\/>/);
  assert.equal(docxToHtml(docx), '<p>one</p>\n<hr data-type="page">\n<p>two</p>\n<hr>');
  assert.match(toMarkdown(html), /one\n\n---\n\ntwo\n\n---/);
});
function readZipText(buf) { return require('../src/docx').readZip(buf).read('word/document.xml').toString(); }

test('table of contents: heading ids and same-document links survive, nothing else does', () => {
  const html = '<h1 id="h-0a1b2c3d">Intro</h1><ul data-type="toc"><li><a href="#h-0a1b2c3d">Intro</a></li><li style="margin-left:24px"><a href="#h-ffeeddcc">Deep</a></li></ul>';
  assert.equal(sanitizeHtml(html), html);
  assert.equal(sanitizeHtml(sanitizeHtml(html)), html);
  assert.equal(sanitizeHtml('<h2 id="evil" onclick="x()">T</h2>'), '<h2>T</h2>');
  assert.equal(sanitizeHtml('<p><a href="#nope">x</a> <a href="#">y</a> <a href="javascript:alert(1)">z</a></p>'), '<p>x y z</p>');
  assert.equal(sanitizeHtml('<p id="h-0a1b2c3d">not a heading</p>'), '<p>not a heading</p>');
  // exports: heading links are plain text everywhere (there is no anchor to jump to in Word or Markdown)
  assert.equal(toMarkdown(html), '# Intro\n\n- Intro\n- Deep\n');
  const doc = require('../src/docx').readZip(htmlToDocx(html, 'T')).read('word/document.xml').toString();
  assert.ok(!doc.includes('<w:hyperlink'), 'no hyperlink to a bookmark that does not exist');
});
