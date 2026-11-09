'use strict';
// Minimal, dependency-free reader/writer for .docx (a zip of XML files).
const zlib = require('node:zlib');
const { escapeHtml, sanitizeHtml, safeHref, stripBlocks } = require('./sanitize');
const { parse, blocks, listItems, tableRows, styleMap } = require('./htmltree');
const { DEFAULTS: PAGE_DEFAULTS, pageBox } = require('./pagesetup');

const MAX_ENTRY = 4 * 1024 * 1024; // refuse to inflate anything bigger (zip-bomb guard)
const MAX_ENTRIES = 2000;

// ---- zip ------------------------------------------------------------------------
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('Not a valid .docx file');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .docx file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error('The file has too many parts');
  const entries = new Map();
  const cache = new Map();
  let budget = 24 * 1024 * 1024;
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Corrupt .docx file');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    entries.set(name, { method, csize, usize, lho });
    off += 46 + nlen + xlen + clen;
  }
  return {
    has: (n) => entries.has(n),
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (cache.has(name)) return cache.get(name); // an entry is inflated once, however many times it is referenced
      if ((budget -= e.usize) < 0) throw new Error('The file is too large to import'); // total inflated bytes per import
      if (e.usize > MAX_ENTRY) throw new Error('The file is too large to import');
      const lo = e.lho;
      if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('Corrupt .docx file');
      const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
      const data = buf.subarray(start, start + e.csize);
      let out;
      if (e.method === 0) out = data;
      else if (e.method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
      else throw new Error('Unsupported compression in .docx');
      if ((budget -= Math.max(0, out.length - e.usize)) < 0) throw new Error('The file is too large to import'); // the declared size can lie: charge what was really inflated
      cache.set(name, out);
      return out;
    },
  };
}

// MS-DOS timestamp fields: a real date (today), not the invalid all-zero value
const NOW = new Date();
const DOS_DATE = ((Math.max(NOW.getFullYear(), 1980) - 1980) << 9) | ((NOW.getMonth() + 1) << 5) | NOW.getDate();
const DOS_TIME = (NOW.getHours() << 11) | (NOW.getMinutes() << 5) | (NOW.getSeconds() >> 1);

function writeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---- docx -> html ---------------------------------------------------------------
const xmlDecode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const flagOn = (xml, tag) => {
  const m = xml.match(new RegExp(`<w:${tag}(\\s[^>]*)?/?>`));
  if (!m) return false;
  const v = m[1] && m[1].match(/w:val="([^"]*)"/);
  return !v || !['0', 'false', 'none'].includes(v[1].toLowerCase());
};

function numberingMap(xml) {
  const abstract = {}, nums = {};
  if (!xml) return () => 'ul';
  for (const m of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    abstract[m[1]] = {};
    for (const l of m[2].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      const f = l[2].match(/<w:numFmt\s+w:val="([^"]*)"/);
      abstract[m[1]][l[1]] = f ? f[1] : 'decimal';
    }
  }
  for (const m of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const a = m[2].match(/<w:abstractNumId\s+w:val="(\d+)"/);
    if (a) nums[m[1]] = a[1];
  }
  return (numId, lvl) => {
    const fmt = (abstract[nums[numId]] || {})[lvl] || 'bullet';
    return fmt === 'bullet' || fmt === 'none' ? 'ul' : 'ol';
  };
}

// Word's fixed highlighter palette
const HIGHLIGHT = { yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000' };

// <w:tbl>...</w:tbl> blocks in order, found in one pass (an unclosed <w:tbl> repeated many times must not rescan the file)
function* tableMatches(xml) {
  const open = /<w:tbl\b/g, close = /<\/w:tbl>/g;
  let m;
  while ((m = open.exec(xml))) {
    close.lastIndex = m.index;
    const c = close.exec(xml);
    if (!c) return; // no closer for this one means none for any later one
    const end = c.index + c[0].length;
    yield { 0: xml.slice(m.index, end), index: m.index };
    open.lastIndex = end;
  }
}

// Reject files whose XML is not properly NESTED before any slow parsing. Counting open and close tags is not enough: all the
// closers can come first and every opener still rescans to the end of the file in the lazy regexes below (quadratic: a 4 KB
// file could freeze the server for seconds to minutes). This is one linear pass with a stack; every attempt is bounded.
function assertBalanced(xml, tags) {
  const watch = new Set(tags);
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s[^<>]{0,400})?)(\/?)>/g;
  let m, seen = 0;
  while ((m = re.exec(xml))) {
    if (++seen > 400_000) throw new Error('The document is too complex to import');
    const [, close, name, , self] = m;
    if (!watch.has(name) || self) continue;
    if (!close) { stack.push(name); if (stack.length > 200) throw new Error('The document structure is damaged and cannot be imported'); }
    else if (stack.pop() !== name) throw new Error('The document structure is damaged and cannot be imported');
  }
  if (stack.length) throw new Error('The document structure is damaged and cannot be imported');
}
const DOC_TAGS = ['w:p', 'w:r', 'w:t', 'w:pPr', 'w:rPr', 'w:tbl', 'w:tr', 'w:tc', 'w:drawing', 'w:hyperlink', 'w:del', 'w:moveFrom', 'w:sdt', 'w:txbxContent'];

function docxToHtml(buf) {
  const zip = readZip(buf);
  const docXml = zip.read('word/document.xml');
  if (!docXml) throw new Error('Not a valid .docx file (no document body)');
  const xml = docXml.toString('utf8');
  assertBalanced(xml, DOC_TAGS);
  const numXml = (zip.read('word/numbering.xml') || Buffer.alloc(0)).toString('utf8');
  assertBalanced(numXml, ['w:abstractNum', 'w:lvl', 'w:num', 'w:pPr']);
  const listKind = numberingMap(numXml || null);
  const rels = {};
  const imageRels = {};
  let drawingsSeen = 0;
  let imagesLeft = 40; // pictures kept per import (each is stored inside the document)
  const relXml = zip.read('word/_rels/document.xml.rels');
  if (relXml) for (const m of relXml.toString('utf8').matchAll(/<Relationship\b([^<>]{0,800})>/g)) {
    const id = m[1].match(/Id="([^"]*)"/), target = m[1].match(/Target="([^"]*)"/);
    if (id && target && /TargetMode="External"/.test(m[1])) rels[id[1]] = xmlDecode(target[1]);
    else if (id && target && /relationships\/image"/.test(m[1])) imageRels[id[1]] = xmlDecode(target[1]);
  }

  const styleNames = {};
  const stylesXml = zip.read('word/styles.xml');
  if (stylesXml) assertBalanced(stylesXml.toString('utf8'), ['w:style']);
  if (stylesXml) for (const m of stylesXml.toString('utf8').matchAll(/<w:style\b[^>]*w:styleId="([^"]*)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const n = m[2].match(/<w:name\s+w:val="([^"]*)"/);
    if (n) styleNames[m[1]] = n[1].toLowerCase();
  }
  // single forward passes: the lazy-regex versions were quadratic on a crafted file
  const body = stripBlocks(stripBlocks(xml, /<w:(del|moveFrom)\b/g, (m) => `<\\/w:${m[1]}>`), /<mc:Fallback\b/g, () => '<\\/mc:Fallback>'); // tracked deletions are ignored; text boxes are stored twice (Choice + Fallback)
  const paragraphsToHtml = (segment) => {
  const out = [];
  const listStack = []; // [{ kind, liOpen }]
  let pendingBreak = false; // a page break that ends the previous paragraph
  const PB = '<hr data-type="page">';
  const closeLists = (to = 0) => {
    while (listStack.length > to) { const l = listStack.pop(); if (l.liOpen) out.push('</li>'); out.push(`</${l.kind === 'ulc' ? 'ul' : l.kind}>`); }
  };

  for (const pm of segment.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const pxml = pm[1];
    const ppr = (pxml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [, ''])[1];
    if (pendingBreak) { closeLists(); out.push(PB); pendingBreak = false; }
    if (/<w:pageBreakBefore\b(?![^>]*w:val="(?:0|false)")/.test(ppr)) { closeLists(); out.push(PB); }
    const style = (ppr.match(/<w:pStyle\s+w:val="([^"]*)"/) || [, ''])[1];
    const numId = (ppr.match(/<w:numId\s+w:val="(\d+)"/) || [])[1];
    const jcRaw = (ppr.match(/<w:jc\s+w:val="([^"]*)"/) || [])[1];
    const align = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' }[jcRaw];
    const indRaw = (ppr.match(/<w:ind\b[^>]*w:(?:left|start)="(\d+)"/) || [])[1];
    const lineM = ppr.match(/<w:spacing\b[^>]*w:line="(\d+)"[^>]*w:lineRule="auto"/) || ppr.match(/<w:spacing\b[^>]*w:lineRule="auto"[^>]*w:line="(\d+)"/);
    const layout = (indent) => [align && `text-align:${align}`, lineM && Number(lineM[1]) > 0 && `line-height:${Math.round(Number(lineM[1]) / 240 * 100) / 100}`, indent && indRaw && Number(indRaw) > 0 && `margin-left:${Math.round(Number(indRaw) / 15)}px`].filter(Boolean).join(';');
    const attrOf = (indent = true) => { const l = layout(indent); return l ? ` style="${l}"` : ''; };
    const ilvl = Math.min(Number((ppr.match(/<w:ilvl\s+w:val="(\d+)"/) || [, 0])[1]) || 0, 8); // Word allows 9 levels; never trust a bigger number

    let inner = '';
    let link = null;
    for (const t of pxml.matchAll(/<w:hyperlink\b([^>]*)>|<\/w:hyperlink>|<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
      if (t[0].startsWith('<w:hyperlink')) { const rid = (t[1].match(/r:id="([^"]*)"/) || [])[1]; link = rid && rels[rid] && safeHref(rels[rid]) ? rels[rid] : null; continue; }
      if (t[0] === '</w:hyperlink>') { link = null; continue; }
      const rxml = t[2];
      const rpr = (rxml.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [, ''])[1];
      let text = '';
      for (const x of rxml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:br\s[^>]*\/>/g)) {
        if (x[0].startsWith('<w:tab')) text += '    ';
        else if (x[0].startsWith('<w:br')) { if (/w:type="page"/.test(x[0])) pendingBreak = true; else text += '\n'; }
        else text += xmlDecode(x[1]);
      }
      for (const dm of rxml.matchAll(/<w:drawing\b[\s\S]*?<\/w:drawing>/g)) {
        if (++drawingsSeen > 200) break; // every drawing counts, recognised or not
        const rid = (dm[0].match(/<a:blip\b[^>]*r:embed="([^"]*)"/) || [])[1];
        const target = rid && imageRels[rid];
        if (!target || imagesLeft <= 0) continue;
        const path = target.startsWith('/') ? target.slice(1) : `word/${target}`.replace(/\/[^/]+\/\.\.\//g, '/');
        let data = null;
        try { data = zip.read(path); } catch { data = null; }
        const kind = data && imageMime(data);
        if (!kind || data.length > 1_000_000) continue;
        const cx = Number((dm[0].match(/<wp:extent\b[^>]*cx="(\d+)"/) || [])[1]);
        const alt = (dm[0].match(/<wp:docPr\b[^>]*descr="([^"]*)"/) || [])[1];
        const wpx = cx ? Math.round(cx / 9525) : 0;
        imagesLeft--;
        inner += `<img src="data:image/${kind};base64,${data.toString('base64')}"${alt ? ` alt="${escapeHtml(xmlDecode(alt))}"` : ''}${wpx >= 16 && wpx <= 2000 ? ` width="${wpx}"` : ''}>`;
      }
      if (!text) continue;
      let h = escapeHtml(text).replace(/\n/g, '<br>');
      if (flagOn(rpr, 'b')) h = `<b>${h}</b>`;
      if (flagOn(rpr, 'i')) h = `<i>${h}</i>`;
      if (flagOn(rpr, 'u') && !link) h = `<u>${h}</u>`;
      if (flagOn(rpr, 'strike')) h = `<s>${h}</s>`;
      const va = (rpr.match(/<w:vertAlign\s+w:val="(subscript|superscript)"/) || [])[1];
      if (va) h = va === 'subscript' ? `<sub>${h}</sub>` : `<sup>${h}</sup>`;
      if (!link) { // colours and fonts of hyperlink runs are Word's link styling, not the author's choice
        const st = [];
        const col = (rpr.match(/<w:color\s+w:val="([0-9A-Fa-f]{6})"/) || [])[1];
        if (col && col.toUpperCase() !== '000000') st.push(`color:#${col}`);
        const sz = (rpr.match(/<w:sz\s+w:val="(\d+)"/) || [])[1];
        if (sz) st.push(`font-size:${Math.round(Number(sz) * 2 / 3 * 100) / 100}px`);
        const fam = (rpr.match(/<w:rFonts\b[^>]*w:ascii="([^"]*)"/) || [])[1];
        if (fam) st.push(`font-family:${fam}`);
        const fill = (rpr.match(/<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6})"/) || [])[1];
        const hl = (rpr.match(/<w:highlight\s+w:val="(\w+)"/) || [])[1];
        if (fill) st.push(`background-color:#${fill}`);
        else if (hl && HIGHLIGHT[hl]) st.push(`background-color:${HIGHLIGHT[hl]}`);
        if (st.length) h = `<span style="${escapeHtml(st.join(';'))}">${h}</span>`;
      }
      if (link) h = `<a href="${escapeHtml(link)}">${h}</a>`;
      inner += h;
    }

    let checkState = null; // checklist items are paragraphs that start with a ballot-box glyph
    if (!numId) {
      const cm = inner.match(/^((?:<[^>]+>)*)\s*([\u2610\u2611\u2612])\s?/);
      if (cm) { checkState = cm[2] !== '\u2610'; inner = inner.replace(/^((?:<[^>]+>)*)\s*[\u2610\u2611\u2612]\s?/, '$1'); }
    }
    const legacy = !numId && checkState === null && /^list\s*(bullet|number)/.test(styleNames[style] || style.toLowerCase());
    if ((numId && numId !== '0') || legacy || checkState !== null) {
      const kind = checkState !== null ? 'ulc' : legacy ? (/number/.test(styleNames[style] || style.toLowerCase()) ? 'ol' : 'ul') : listKind(numId, String(ilvl));
      closeLists(ilvl + 1);
      if (listStack.length === ilvl + 1 && listStack[ilvl].kind !== kind) closeLists(ilvl);
      while (listStack.length < ilvl + 1) { listStack.push({ kind, liOpen: false }); out.push(kind === 'ulc' ? '<ul data-type="check">' : `<${kind}>`); }
      const cur = listStack[ilvl];
      if (cur.liOpen) out.push('</li>');
      out.push(`<li${checkState ? ' data-checked="true"' : ''}${attrOf(false)}>${inner || '<br>'}`);
      cur.liOpen = true;
      continue;
    }
    closeLists();
    if (!inner.replace(/<br>/g, '').trim() && /<w:pBdr>[\s\S]*?<w:bottom\b/.test(ppr)) { out.push('<hr>'); continue; }
    if (!inner.replace(/<br>/g, '').trim() && /<w:br\s[^>]*w:type="page"/.test(pxml)) continue; // the paragraph only carried a page break
    if (!inner.replace(/<br>/g, '').trim()) { if (out.length && out[out.length - 1] !== '<p><br></p>') out.push('<p><br></p>'); continue; }
    const styleName = styleNames[style] || style.toLowerCase();
    const hm = style.match(/^Heading([1-6])$/i) || styleName.match(/^heading\s*([1-6])$/);
    if (hm) { const l = Math.min(Number(hm[1]), 3); out.push(`<h${l}${attrOf()}>${inner}</h${l}>`); }
    else if (/^title$/.test(styleName)) out.push(`<h1${attrOf()}>${inner}</h1>`);
    else if (/^subtitle$/.test(styleName)) out.push(`<h2${attrOf()}>${inner}</h2>`);
    else if (/quote/.test(styleName)) out.push(`<blockquote${attrOf()}>${inner}</blockquote>`);
    else out.push(`<p${attrOf()}>${inner}</p>`);
  }
  if (pendingBreak) { closeLists(); out.push(PB); }
  closeLists();
  return out.join('\n').replace(/\n(<\/(?:li|ul|ol)>)/g, '$1'); // no stray newline inside a list item
  };

  const tableToHtml = (tbl) => {
    const rows = [...tbl.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((r, ri) => {
      const tag = ri === 0 && /<w:tblHeader\b/.test(r[0]) ? 'th' : 'td';
      const cells = [...r[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) => {
        let html = paragraphsToHtml(c[0]).replace(/(<p><br><\/p>\s*)+$/, '');
        const single = html.match(/^<p>([\s\S]*)<\/p>$/);
        if (single && !/<\/?p>|<ul>|<ol>|<h\d>|<blockquote>/.test(single[1])) html = single[1]; // one plain paragraph: just the text
        if (tag === 'th') html = html.replace(/^<b>([\s\S]*)<\/b>$/, '$1'); // header bold is implied by <th>
        return `<${tag}>${html || '<br>'}</${tag}>`;
      });
      return cells.length ? `<tr>${cells.join('')}</tr>` : '';
    }).filter(Boolean);
    return rows.length ? `<table><tbody>${rows.join('')}</tbody></table>` : '';
  };

  // Walk the body in order: runs of paragraphs, then a table, then more paragraphs.
  const parts = [];
  let last = 0;
  for (const tm of tableMatches(body)) {
    parts.push(paragraphsToHtml(body.slice(last, tm.index)), tableToHtml(tm[0]));
    last = tm.index + tm[0].length;
    // Word requires a paragraph after a table: do not turn that padding into a visible blank line
    const rest = body.slice(last).match(/^\s*<w:p(?:\s[^>]*)?>(?:(?!<w:t[ >])[\s\S])*?<\/w:p>/);
    if (rest) last += rest[0].length;
  }
  parts.push(paragraphsToHtml(body.slice(last)));
  return sanitizeHtml(parts.filter(Boolean).join('\n'));
}

// ---- html -> docx ----------------------------------------------------------------
const xmlEsc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Pixel size of a PNG / GIF / JPEG / WebP from its header (null when unreadable).
function imageSize(b) {
  try {
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.length > 10 && b.toString('latin1', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) { i++; continue; }
        const mk = b[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
    if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const k = b.toString('latin1', 12, 16);
      if (k === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (k === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (k === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    }
  } catch { /* fall through */ }
  return null;
}
function imageMime(b) {
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return 'png';
  if (b.length > 3 && b.toString('latin1', 0, 3) === 'GIF') return 'gif';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function htmlToDocx(html, title = 'Document', settings = PAGE_DEFAULTS) {
  const root = parse(html);
  const links = []; // external hyperlink targets
  const images = []; // embedded pictures { name, ext, data }
  const body = [];

  const runs = (nodes, fmt = {}) => {
    let x = '';
    for (const n of nodes) {
      if (n.text !== undefined) {
        if (!n.text) continue;
        // children appear in the order the OOXML schema requires (Word can reject out-of-order run properties)
        const font = fmt.code ? 'Courier New' : fmt.font;
        const color = fmt.link ? '0563C1' : (fmt.color || '').replace('#', '').toUpperCase();
        const halfPts = fmt.size ? Math.round(parseFloat(fmt.size) * 1.5) : 0;
        const rpr = (font ? `<w:rFonts w:ascii="${xmlEsc(font)}" w:hAnsi="${xmlEsc(font)}" w:cs="${xmlEsc(font)}"/>` : '') + (fmt.b ? '<w:b/>' : '') + (fmt.i ? '<w:i/>' : '') + (fmt.s ? '<w:strike/>' : '')
          + (color ? `<w:color w:val="${xmlEsc(color)}"/>` : '') + (halfPts ? `<w:sz w:val="${halfPts}"/><w:szCs w:val="${halfPts}"/>` : '')
          + (fmt.u || fmt.link ? '<w:u w:val="single"/>' : '') + (fmt.bg ? `<w:shd w:val="clear" w:color="auto" w:fill="${xmlEsc(fmt.bg.replace('#', '').toUpperCase())}"/>` : '')
          + (fmt.sub ? '<w:vertAlign w:val="subscript"/>' : fmt.sup ? '<w:vertAlign w:val="superscript"/>' : '');
        const t = `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(n.text)}</w:t></w:r>`;
        if (fmt.link) { links.push(fmt.link); x += `<w:hyperlink r:id="rIdL${links.length}">${t}</w:hyperlink>`; } else x += t;
        continue;
      }
      switch (n.tag) {
        case 'b': x += runs(n.children, { ...fmt, b: true }); break;
        case 'i': x += runs(n.children, { ...fmt, i: true }); break;
        case 'u': x += runs(n.children, { ...fmt, u: true }); break;
        case 's': x += runs(n.children, { ...fmt, s: true }); break;
        case 'code': x += runs(n.children, { ...fmt, code: true }); break;
        case 'a': x += n.href && n.href.startsWith('#') ? runs(n.children, fmt) : runs(n.children, { ...fmt, link: n.href }); break; // heading links are plain text in Word
        case 'sub': x += runs(n.children, { ...fmt, sub: true, sup: false }); break;
        case 'sup': x += runs(n.children, { ...fmt, sup: true, sub: false }); break;
        case 'span': { const st = styleMap(n.style); x += runs(n.children, { ...fmt, ...(st.color && { color: st.color }), ...(st['background-color'] && { bg: st['background-color'] }), ...(st['font-size'] && { size: st['font-size'] }), ...(st['font-family'] && { font: st['font-family'] }) }); break; }
        case 'br': x += '<w:r><w:br/></w:r>'; break;
        case 'img': x += imageRun(n); break;
        default: x += runs(n.children, fmt);
      }
    }
    return x;
  };
  const imageRun = (n) => {
    const m = /^data:image\/(png|jpeg|gif|webp);base64,(.+)$/.exec(n.src || '');
    if (!m || images.length >= 100) return n.alt ? `<w:r><w:t xml:space="preserve">${xmlEsc(`[Image: ${n.alt}]`)}</w:t></w:r>` : '';
    const data = Buffer.from(m[2], 'base64');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    let dim = imageSize(data);
    if (!dim || !(dim.w > 0) || !(dim.h > 0)) dim = { w: 400, h: 300 }; // unreadable or zero-sized header
    let w = n.width || Math.min(dim.w, 624);
    w = Math.max(16, Math.min(w, 624));
    const h = Math.max(1, Math.round(w * dim.h / dim.w));
    images.push({ ext, data });
    const id = images.length;
    const cx = w * 9525, cy = h * 9525;
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${xmlEsc(n.alt || '')}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdI${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };
  const para = (inner, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;
  // spacing, indent and alignment of a block, in schema order (spacing, ind, jc)
  const layoutPPr = (node, { indent = true } = {}) => {
    const st = styleMap(node && node.style);
    const lh = st['line-height'] ? Math.round(parseFloat(st['line-height']) * 240) : 0;
    const left = indent && st['margin-left'] ? Math.round(parseFloat(st['margin-left']) * 15) : 0;
    const jc = { center: 'center', right: 'right', justify: 'both' }[st['text-align']];
    return (lh ? `<w:spacing w:line="${lh}" w:lineRule="auto"/>` : '') + (left ? `<w:ind w:left="${left}"/>` : '') + (jc ? `<w:jc w:val="${jc}"/>` : '');
  };

  const emitBlock = (n, listCtx) => {
    switch (n.tag) {
      case 'h1': case 'h2': case 'h3': body.push(para(runs(n.children), `<w:pStyle w:val="Heading${n.tag[1]}"/>${layoutPPr(n)}`)); break;
      case 'blockquote': body.push(para(runs(n.children), `<w:pStyle w:val="Quote"/>${layoutPPr(n)}`)); break;
      case 'pre': body.push(para(runs(n.children, { code: true }))); break;
      case 'hr': if (n.page) { body.push(para('<w:r><w:br w:type="page"/></w:r>')); break; } body.push(para('', '<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="1" w:color="808080"/></w:pBdr>')); break;
      case 'ul': case 'ol': emitList(n, 0); break;
      case 'table': emitTable(n); break;
      default: body.push(para(runs(n.children), layoutPPr(n)));
    }
  };
  // Table cells hold paragraphs; headings and lists inside a cell are flattened to plain paragraphs.
  const cellParas = (children, bold) => {
    const out = [];
    const walk = (nodes) => {
      for (const b of blocks(nodes)) {
        if (b.tag === 'ul' || b.tag === 'ol') {
          // every list item (nested ones too) becomes a bulleted paragraph; nothing is dropped
          const walkList = (list, depth) => {
            for (const li of listItems(list)) {
              const own = li.children.filter((c) => c.tag !== 'ul' && c.tag !== 'ol');
              out.push(para(runs([{ text: `${'    '.repeat(depth)}\u2022 ` }, ...own], bold ? { b: true } : {})));
              for (const sub of li.children) if (sub.tag === 'ul' || sub.tag === 'ol') walkList(sub, depth + 1);
            }
          };
          walkList(b, 0);
        }
        else if (b.tag === 'table') { for (const r of tableRows(b)) out.push(para(r.map((c, i) => (i ? runs([{ text: ' | ' }]) : '') + runs(c.children)).join(''))); } // a nested table becomes readable rows
        else if (b.tag === 'hr') out.push(para(''));
        else out.push(para(runs(b.children, bold ? { b: true } : {}), layoutPPr(b, { indent: false })));
      }
    };
    walk(children);
    return out.length ? out.join('') : para('');
  };
  const emitTable = (t) => {
    const rows = tableRows(t);
    if (!rows.length) return;
    const width = Math.max(...rows.map((r) => r.length));
    const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('');
    const grid = Array.from({ length: width }, () => '<w:gridCol w:w="2000"/>').join('');
    const trs = rows.map((r, ri) => {
      const header = ri === 0 && r.every((c) => c.header);
      const cells = Array.from({ length: width }, (_, i) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${cellParas(r[i] ? r[i].children : [], header)}</w:tc>`).join('');
      return `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;
    }).join('');
    body.push(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border}</w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${trs}</w:tbl>`, para(''));
  };
  const emitList = (list, lvl) => {
    const numId = list.tag === 'ol' ? 2 : 1;
    const item = (nodes, li) => {
      const layout = layoutPPr(li, { indent: false });
      if (list.check) { // a checklist has no bullets: a ballot-box glyph shows the state
        body.push(para(runs([{ text: li.checked ? '\u2611 ' : '\u2610 ' }, ...nodes]), `<w:pStyle w:val="ListParagraph"/>${lvl ? `<w:ind w:left="${720 * (lvl + 1)}"/>` : ''}${layout}`));
      } else body.push(para(runs(nodes), `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${Math.min(lvl, 8)}"/><w:numId w:val="${numId}"/></w:numPr>${layout}`));
    };
    for (const li of listItems(list)) {
      // children in document order: inline content (and wrapper <p>/<div>) forms an item, nested lists follow where they appear
      let buf = [];
      let emitted = false;
      const flush = () => { if (buf.length || !emitted) { item(buf, li); emitted = true; } buf = []; };
      for (const c of li.children) {
        if (c.tag === 'ul' || c.tag === 'ol') {
          const last = buf[buf.length - 1]; if (last && last.text !== undefined) { const t = last.text.replace(/\s*\n\s*$/, ''); if (t) buf[buf.length - 1] = { ...last, text: t }; else buf.pop(); } // formatting newline before a nested list is not content
          if (buf.length || !emitted) flush(); emitList(c, lvl + 1);
        }
        else if (c.tag === 'p' || c.tag === 'div') buf.push(...c.children);
        else if (c.text !== undefined && !c.text.trim() && /\n/.test(c.text)) continue; // formatting whitespace between blocks is not content
        else buf.push(c);
      }
      if (buf.length || !emitted) flush();
    }
  };
  for (const b of blocks(root.children)) emitBlock(b);
  if (!body.length) body.push(para(''));

  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const box = pageBox(settings || PAGE_DEFAULTS);
  const hasHeader = Boolean(settings && settings.header);
  const hasFooter = Boolean(settings && (settings.footer || settings.pageNumbers));
  const run = (t) => `<w:r><w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r>`;
  const headerXml = hasHeader ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run(settings.header)}</w:p></w:hdr>` : null;
  const field = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const footerXml = hasFooter ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}><w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="${box.w - 2 * box.lr}"/></w:tabs></w:pPr>${settings.footer ? run(settings.footer) : ''}${settings.pageNumbers ? `<w:r><w:tab/></w:r>${run('Page ')}${field}` : ''}</w:p></w:ftr>` : null;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS} xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join('')}<w:sectPr>${hasHeader ? '<w:headerReference w:type="default" r:id="rIdH"/>' : ''}${hasFooter ? '<w:footerReference w:type="default" r:id="rIdF"/>' : ''}<w:pgSz w:w="${box.w}" w:h="${box.h}"${box.orient === 'landscape' ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${box.tb}" w:right="${box.lr}" w:bottom="${box.tb}" w:left="${box.lr}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const heading = (id, name, size) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${heading('Heading1', 'heading 1', 40)}${heading('Heading2', 'heading 2', 32)}${heading('Heading3', 'heading 3', 26)}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style></w:styles>`;
  const lvls = (fmt, glyph) => Array.from({ length: 9 }, (_, i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${fmt === 'bullet' ? glyph : `%${i + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + i * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('bullet', '\u2022')}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('decimal')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${links.map((l, i) => `<Relationship Id="rIdL${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEsc(l)}" TargetMode="External"/>`).join('')}${hasHeader ? '<Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' : ''}${hasFooter ? '<Relationship Id="rIdF" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : ''}${images.map((im, i) => `<Relationship Id="rIdI${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.${im.ext}"/>`).join('')}</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="webp" ContentType="image/webp"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>${hasHeader ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}${hasFooter ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEsc(title)}</dc:title><dc:creator>Docs Lite</dc:creator></cp:coreProperties>`;
  return writeZip([
    ['[Content_Types].xml', contentTypes], ['_rels/.rels', rootRels], ['word/document.xml', documentXml],
    ['word/styles.xml', stylesXml], ['word/numbering.xml', numberingXml], ['word/_rels/document.xml.rels', rels], ['docProps/core.xml', core],
    ...(headerXml ? [['word/header1.xml', headerXml]] : []), ...(footerXml ? [['word/footer1.xml', footerXml]] : []),
    ...images.map((im, i) => [`word/media/image${i + 1}.${im.ext}`, im.data]),
  ]);
}

module.exports = { imageSize, readZip, writeZip, docxToHtml, htmlToDocx };
