'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { htmlToDocx, docxToHtml, readZip, writeZip } = require('../src/docx');
const { toMarkdown, toText, toStandaloneHtml } = require('../src/export');
const { sanitizeHtml } = require('../src/sanitize');

const SAMPLE = '<h1>Plan</h1><p>Hello <b>bold</b> <i>it</i> <u>under</u> <s>gone</s> <a href="https://x.com/a?b=1&amp;c=2">a link</a></p><h2>Steps</h2><ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul><ol><li>first</li><li>second</li></ol><blockquote>quoted</blockquote>';

test('zip writer and reader round trip, including unicode names and content', () => {
  const buf = writeZip([['a.txt', 'hello'], ['dir/b.txt', 'héllo wörld ✓']]);
  const z = readZip(buf);
  assert.equal(z.read('a.txt').toString(), 'hello');
  assert.equal(z.read('dir/b.txt').toString(), 'héllo wörld ✓');
  assert.equal(z.read('missing'), null);
});

test('docx export produces a valid package with the expected parts', () => {
  const z = readZip(htmlToDocx(SAMPLE, 'My Doc'));
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels']) assert.ok(z.has(part), part);
  const xml = z.read('word/document.xml').toString();
  assert.match(xml, /w:pStyle w:val="Heading1"/);
  assert.match(xml, /<w:b\/>/);
  assert.match(xml, /r:id="rIdL1"/);
  assert.match(z.read('word/_rels/document.xml.rels').toString(), /Target="https:\/\/x.com\/a\?b=1&amp;c=2"/);
});

test('docx round trip keeps headings, inline formatting, links, nested lists and quotes', () => {
  const back = docxToHtml(htmlToDocx(SAMPLE, 'T'));
  assert.match(back, /<h1>Plan<\/h1>/);
  assert.match(back, /<h2>Steps<\/h2>/);
  assert.match(back, /<b>bold<\/b>/);
  assert.match(back, /<i>it<\/i>/);
  assert.match(back, /<u>under<\/u>/);
  assert.match(back, /<s>gone<\/s>/);
  assert.match(back, /<a href="https:\/\/x.com\/a\?b=1&amp;c=2"[^>]*>a link<\/a>/);
  assert.match(back, /<ul>\s*<li>one\s*<ul>\s*<li>nested\s*<\/li>\s*<\/ul>\s*<\/li>\s*<li>two\s*<\/li>\s*<\/ul>/);
  assert.match(back, /<ol>\s*<li>first\s*<\/li>\s*<li>second\s*<\/li>\s*<\/ol>/);
  assert.match(back, /<blockquote>quoted<\/blockquote>/);
  assert.equal(sanitizeHtml(back), back); // importer output is already clean
});

test('docx import handles special characters and never emits raw markup', () => {
  const back = docxToHtml(htmlToDocx('<p>5 &lt; 6 &amp; &lt;script&gt;alert(1)&lt;/script&gt;</p>', 'T'));
  assert.match(back, /5 &lt; 6 &amp; &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(back, /<script/);
});

test('docx import reads a Word-style file (styles, numbering and tracked deletions)', () => {
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const doc = `<?xml version="1.0"?><w:document ${NS}><w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b w:val="1"/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t xml:space="preserve"> plain</w:t></w:r><w:del><w:r><w:t>deleted text</w:t></w:r></w:del></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>Bullet</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="8"/></w:numPr></w:pPr><w:r><w:t>Number</w:t></w:r></w:p>
    <w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t></w:r></w:p>
  </w:body></w:document>`;
  const numbering = `<w:numbering ${NS}><w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="4"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="3"/></w:num><w:num w:numId="8"><w:abstractNumId w:val="4"/></w:num></w:numbering>`;
  const html = docxToHtml(writeZip([['word/document.xml', doc], ['word/numbering.xml', numbering]]));
  assert.match(html, /<h1>Quarterly report<\/h1>/);
  assert.match(html, /<b>Bold<\/b> plain/);
  assert.doesNotMatch(html, /deleted text/);
  assert.match(html, /<ul>\s*<li>Bullet\s*<\/li>\s*<\/ul>/);
  assert.match(html, /<ol>\s*<li>Number\s*<\/li>\s*<\/ol>/);
  assert.match(html, /Line one<br>Line two/);
});

test('docx import rejects garbage, truncated files and zip bombs without crashing', () => {
  assert.throws(() => docxToHtml(Buffer.from('this is not a zip file at all, just text')), /valid \.docx/);
  assert.throws(() => docxToHtml(Buffer.alloc(10)), /valid \.docx/);
  const good = htmlToDocx('<p>x</p>', 'T');
  assert.throws(() => docxToHtml(good.subarray(0, good.length - 30)), /(valid|Corrupt)/);
  assert.throws(() => docxToHtml(writeZip([['word/other.xml', '<x/>']])), /no document body/);
  // Highly compressible 40 MB payload: must be refused, not inflated.
  const bomb = writeZip([['word/document.xml', Buffer.alloc(40 * 1024 * 1024, 'a')]]);
  assert.ok(bomb.length < 200000, 'test payload should be tiny when compressed');
  assert.throws(() => docxToHtml(bomb), /too large/);
});

test('markdown, text and standalone html exports', () => {
  const md = toMarkdown(SAMPLE);
  assert.match(md, /^# Plan$/m);
  assert.match(md, /\*\*bold\*\*/);
  assert.match(md, /\*it\*/);
  assert.match(md, /~~gone~~/);
  assert.match(md, /\[a link\]\(https:\/\/x.com\/a\?b=1&c=2\)/);
  assert.match(md, /^- one\n {2}- nested\n- two$/m);
  assert.match(md, /^1\. first\n2\. second$/m);
  assert.match(md, /^> quoted$/m);
  const txt = toText(SAMPLE);
  assert.doesNotMatch(txt, /[*<>]/);
  assert.match(txt, /- one\n {2}- nested/);
  const page = toStandaloneHtml('A <title>', '<p>body</p>');
  assert.match(page, /<title>A &lt;title&gt;<\/title>/);
  assert.match(page, /<p>body<\/p>/);
});

test('markdown export escapes markdown syntax in plain text', () => {
  assert.match(toMarkdown('<p>2 * 3 = 6 and snake_case</p>'), /2 \\\* 3 = 6 and snake\\_case/);
});

test('exports tolerate bare text and empty documents', () => {
  assert.equal(toMarkdown(''), '\n');
  assert.equal(toMarkdown('just text <b>bold</b>').trim(), 'just text **bold**');
  assert.ok(htmlToDocx('', 'Empty').length > 500);
  assert.ok(zlib.crc32 === undefined || typeof zlib.crc32 === 'function');
});

test('wrapper divs around lists and headings (what browsers produce) do not lose content in exports', () => {
  const html = '<p>intro</p><div><ul><li>a</li><li>b</li></ul></div><div><h2>Title</h2><p>body</p></div><div>plain <b>bold</b></div>';
  const md = toMarkdown(html);
  assert.match(md, /^- a\n- b$/m);
  assert.match(md, /^## Title$/m);
  assert.match(md, /^body$/m);
  assert.match(md, /^plain \*\*bold\*\*$/m);
  const back = docxToHtml(htmlToDocx(html, 'T'));
  assert.match(back, /<ul>\s*<li>a\s*<\/li>\s*<li>b\s*<\/li>\s*<\/ul>/);
  assert.match(back, /<h2>Title<\/h2>/);
  assert.match(toText(html), /- a\n- b/);
});

test('list items that contain paragraphs or divs keep their text', () => {
  const html = '<ul><li><p>one</p></li><li><div>two</div></li><li>three<ul><li><p>nested</p></li></ul></li></ul>';
  const md = toMarkdown(html);
  assert.match(md, /^- one$/m);
  assert.match(md, /^- two$/m);
  assert.match(md, /^- three\n {2}- nested$/m);
  const back = docxToHtml(htmlToDocx(html, 'T'));
  for (const w of ['one', 'two', 'three', 'nested']) assert.match(back, new RegExp(w));
});

test('a list that the browser nested inside a paragraph still exports as a list', () => {
  const html = sanitizeHtml('<p>intro</p><p><ul><li>one</li><li>two</li></ul></p><p><ol><li>first</li></ol></p>');
  assert.match(toMarkdown(html), /^- one\n- two$/m);
  assert.match(toMarkdown(html), /^1\. first$/m);
  const back = docxToHtml(htmlToDocx(html, 'T'));
  assert.match(back, /<ul>\s*<li>one\s*<\/li>\s*<li>two\s*<\/li>\s*<\/ul>/);
});

test('docx import: localized style ids, legacy list styles, text boxes and tracked changes from real Word files', () => {
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
  const doc = `<w:document ${NS}><w:body>
    <w:p><w:pPr><w:pStyle w:val="berschrift1"/></w:pPr><w:r><w:t>Kapitel Eins</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Listenabsatz2"/></w:pPr><w:r><w:t>German bullet style</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>Legacy bullet</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="ListNumber"/></w:pPr><w:r><w:t>Legacy number</w:t></w:r></w:p>
    <w:p><w:ins w:id="1"><w:r><w:t>Inserted text kept</w:t></w:r></w:ins></w:p>
    <mc:AlternateContent><mc:Choice><w:p><w:r><w:t>Text box once</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>Text box once</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>
  </w:body></w:document>`;
  const styles = `<w:styles ${NS}><w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Listenabsatz2"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/></w:style><w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/></w:style></w:styles>`;
  const html = docxToHtml(writeZip([['word/document.xml', doc], ['word/styles.xml', styles]]));
  assert.match(html, /<h1>Kapitel Eins<\/h1>/);
  assert.match(html, /<p>German bullet style<\/p>/);
  assert.match(html, /<ul>\s*<li>Legacy bullet\s*<\/li>\s*<\/ul>/);
  assert.match(html, /<ol>\s*<li>Legacy number\s*<\/li>\s*<\/ol>/);
  assert.match(html, /Inserted text kept/);
  assert.equal((html.match(/Text box once/g) || []).length, 1, 'text boxes are not duplicated');
});

test('regressions found by fuzzing: loose list text, horizontal rules, nesting order, list-level bombs', () => {
  // text placed directly inside a list (outside any <li>) is kept, not dropped
  assert.match(toMarkdown('<ol>loose text<li>item</li></ol>'), /loose text/);
  assert.match(docxToHtml(htmlToDocx('<ul>loose<li>item</li></ul>', 'T')), /loose/);
  // <hr> survives Word as a real rule, not literal "* * *"
  const back = docxToHtml(htmlToDocx('<p>a</p><hr><p>b</p>', 'T'));
  assert.match(back, /<p>a<\/p>\s*<hr>\s*<p>b<\/p>/);
  assert.doesNotMatch(back, /\* \* \*/);
  // text that follows a nested list stays after it
  const md = toMarkdown('<ul><li>one<ul><li>nested</li></ul>after</li></ul>');
  assert.ok(md.indexOf('nested') < md.indexOf('after'), md);
  const wordHtml = docxToHtml(htmlToDocx('<ul><li>one<ul><li>nested</li></ul>after</li></ul>', 'T'));
  assert.ok(wordHtml.indexOf('nested') < wordHtml.indexOf('after'), wordHtml);
  // a docx claiming list level 99999 must not build a 100,000-deep list
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const xml = `<w:document ${NS}><w:body><w:p><w:pPr><w:numPr><w:ilvl w:val="99999"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>deep</w:t></w:r></w:p></w:body></w:document>`;
  const html = docxToHtml(writeZip([['word/document.xml', xml]]));
  assert.ok((html.match(/<ul>/g) || []).length <= 9, 'nesting is capped at Word\'s 9 levels');
  assert.match(html, /deep/);
});

const TABLE = '<p>before</p><table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>Apple <b>red</b></td><td>3</td></tr><tr><td>Pie | tart</td><td></td></tr></tbody></table><p>after</p>';

test('tables: sanitiser keeps structure and repairs sloppy markup like a parser would', () => {
  assert.equal(sanitizeHtml(TABLE), TABLE);
  assert.equal(sanitizeHtml('<table><tr><td>a<td>b<tr><td>c</table>'), '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>');
  assert.equal(sanitizeHtml('<table border=1 style="x" onclick="y"><tr><td colspan=2 onmouseover="z">a</td></tr></table>'), '<table><tr><td>a</td></tr></table>');
  assert.equal(sanitizeHtml('<p>x<table><tr><td>c</td></tr></table></p>'), '<p>x</p><table><tr><td>c</td></tr></table>');
  assert.equal(sanitizeHtml('<table><tr><td><script>x</script>ok</td></tr></table>'), '<table><tr><td>ok</td></tr></table>');
});

test('tables: Markdown, text and Word exports', () => {
  const md = toMarkdown(TABLE);
  assert.match(md, /^\| Name \| Qty \|\n\| --- \| --- \|\n\| Apple \*\*red\*\* \| 3 \|\n\| Pie \\\| tart \|  \|$/m);
  assert.match(toText(TABLE), /Name\tQty\nApple red\t3\nPie \| tart\t/);
  const zip = readZip(htmlToDocx(TABLE, 'T'));
  const xml = zip.read('word/document.xml').toString();
  assert.equal((xml.match(/<w:tr>/g) || []).length, 3);
  assert.equal((xml.match(/<w:tc>/g) || []).length, 6);
  assert.match(xml, /<w:tblHeader\/>/);
  assert.match(xml, /<\/w:tbl><w:p>/, 'Word needs a paragraph after a table');
  assert.match(xml, /w:tblBorders/);
});

test('tables: Word round trip keeps cells, header row, formatting and does not add blank lines', () => {
  const back = docxToHtml(htmlToDocx(TABLE, 'T'));
  assert.match(back, /<p>before<\/p>\s*<table>/);
  assert.match(back, /<\/table>\s*<p>after<\/p>/, 'the padding paragraph Word requires is not imported as an empty line');
  assert.match(back, /<th>Name<\/th><th>Qty<\/th>/);
  assert.match(back, /<td>Apple <b>red<\/b><\/td><td>3<\/td>/);
  assert.match(back, /<td>Pie \| tart<\/td>/);
  assert.equal((back.match(/<tr>/g) || []).length, 3);
  assert.equal(sanitizeHtml(back), back);
  // and a second round trip is stable
  assert.equal(docxToHtml(htmlToDocx(back, 'T')), back);
});

test('tables: a Word-style table with merged cells, multi-paragraph cells and a nested list imports sensibly', () => {
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const cell = (inner, extra = '') => `<w:tc><w:tcPr>${extra}</w:tcPr>${inner}</w:tc>`;
  const p = (t, b) => `<w:p><w:r>${b ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t>${t}</w:t></w:r></w:p>`;
  const doc = `<w:document ${NS}><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Report</w:t></w:r></w:p>
    <w:tbl><w:tblPr/><w:tblGrid/>
      <w:tr><w:trPr><w:tblHeader/></w:trPr>${cell(p('Item', true), '<w:gridSpan w:val="2"/>')}</w:tr>
      <w:tr>${cell(p('Line one') + p('Line two'))}${cell(p('x'), '<w:vMerge w:val="restart"/>')}</w:tr>
      <w:tr>${cell(p('solo'))}${cell('<w:p/>', '<w:vMerge/>')}</w:tr>
    </w:tbl>
    <w:p/>
    <w:p><w:r><w:t>Closing text</w:t></w:r></w:p>
  </w:body></w:document>`;
  const html = docxToHtml(writeZip([['word/document.xml', doc]]));
  assert.match(html, /<h1>Report<\/h1>/);
  assert.match(html, /<th>Item<\/th>/);
  assert.match(html, /<td><p>Line one<\/p>\s*<p>Line two<\/p><\/td>/);
  assert.match(html, /<td>solo<\/td>/);
  assert.match(html, /<\/table>\s*<p>Closing text<\/p>/);
  assert.equal(sanitizeHtml(html), html);
});

test('tables: empty and degenerate tables do not break exports', () => {
  for (const html of ['<table></table>', '<table><tr></tr></table>', '<table><tr><td></td></tr></table>', '<table><tbody></tbody></table><p>x</p>', '<table><tr><td><table><tr><td>nested</td></tr></table></td></tr></table>']) {
    const clean = sanitizeHtml(html);
    toMarkdown(clean); toText(clean);
    assert.equal(typeof docxToHtml(htmlToDocx(clean, 'T')), 'string');
  }
  assert.match(toMarkdown(sanitizeHtml('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>')), /\| a \| b \|\n\| --- \| --- \|\n\| c \|  \|/, 'ragged rows are padded');
});

test('a real Word-style file (created with python-docx, whose template mirrors Word) imports faithfully', () => {
  const html = docxToHtml(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'word_like.docx')));
  assert.match(html, /<h1>Quarterly Report<\/h1>/, 'Title style');
  assert.match(html, /<h1>1\. Overview<\/h1>/);
  assert.match(html, /<h2>Details<\/h2>/);
  assert.match(html, /<h3>Sub sub<\/h3>/);
  assert.match(html, /Revenue grew <b>12%<\/b> while costs <i>fell<\/i><u> sharply<\/u>/);
  assert.match(html, /<ul>\s*<li>First point\s*<\/li>\s*<li>Second point\s*<\/li>\s*<\/ul>/, 'List Bullet style becomes a bulleted list');
  assert.match(html, /<ol>\s*<li>Step one\s*<\/li>\s*<li>Step two\s*<\/li>\s*<li>Step three\s*<\/li>\s*<\/ol>/, 'List Number style becomes a numbered list');
  assert.match(html, /<blockquote>A quoted remark<\/blockquote>/);
  assert.match(html, /<table>.*<td>Region<\/td><td>Q3<\/td><td>Q4<\/td>.*<td>South<\/td><td>8<\/td><td>9<\/td>.*<\/table>\s*<p>Text after the table\.<\/p>/s);
  assert.equal(sanitizeHtml(html), html);
});

test('exports handle a sibling nested list even if it was stored before the sanitiser repaired it', () => {
  const raw = '<ul><li>item two</li><ul><li>nested item</li></ul><li>item three</li></ul>';
  const md = toMarkdown(raw);
  assert.match(md, /^- item two\n {2}- nested item\n- item three$/m, md);
  const back = docxToHtml(htmlToDocx(raw, 'T'));
  assert.match(back, /<li>item two\s*<ul>\s*<li>nested item/);
});

test('docx import: list items carry no stray newline, and a round trip keeps list text clean', () => {
  const { htmlToDocx, docxToHtml, readZip } = require('../src/docx');
  const html = '<ul><li>first</li><li>second</li></ul><ol><li>one</li></ol>';
  const back = docxToHtml(htmlToDocx(html, 'T'));
  assert.ok(!/\n<\/li>/.test(back), back);
  const xml = readZip(htmlToDocx(back, 'T')).read('word/document.xml').toString();
  assert.ok(!/<w:t[^>]*>[^<]*\n[^<]*<\/w:t>/.test(xml), 'no newline inside a text run');
});
