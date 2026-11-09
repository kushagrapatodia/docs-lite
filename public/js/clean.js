// Client-side clean-up for pasted HTML (the server sanitises again on save).
// DOMParser creates an inert document, so nothing here can execute.
const KEEP = new Set(['SUB', 'SUP', 'P', 'BR', 'B', 'I', 'U', 'S', 'CODE', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'A', 'HR', 'DIV', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']);
const RENAME = { STRONG: 'B', EM: 'I', STRIKE: 'S', DEL: 'S', H4: 'H3', H5: 'H3', H6: 'H3', TITLE: 'H1', TFOOT: 'TBODY' };
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'META', 'LINK', 'BUTTON', 'SELECT', 'TEXTAREA', 'FORM', 'IMG', 'CANVAS', 'VIDEO', 'AUDIO']);
const TABLE_PARTS = new Set(['COLGROUP', 'CAPTION', 'COL']); // table furniture we do not keep

export function safeUrl(u) {
  const v = String(u || '').trim();
  const probe = v.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
  return /^(https?:|mailto:)/.test(probe) ? v : null;
}

// Word and Google Docs express formatting through inline styles rather than tags.
const style = (el) => (el.getAttribute('style') || '').toLowerCase();
const isBold = (st) => /(^|[;\s])font-weight\s*:\s*(bold|bolder|[6-9]00)\b/.test(st);
const notBold = (st) => /(^|[;\s])font-weight\s*:\s*(normal|lighter|[1-5]00)\b/.test(st);
const isItalic = (st) => /(^|[;\s])font-style\s*:\s*(italic|oblique)/.test(st);
const notItalic = (st) => /(^|[;\s])font-style\s*:\s*normal/.test(st);
const isUnderline = (st) => /(^|[;\s])text-decoration[^;]*underline/.test(st);
const isStrike = (st) => /(^|[;\s])text-decoration[^;]*line-through/.test(st);

// Declarations worth carrying over from pasted content (the server validates them again).
function declaration(st, prop) { const m = st.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'i')); return m ? m[1].trim() : null; }
const isBlackish = (v) => /^(#0{3}|#0{6}|black|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*1\s*\))$/i.test(v);
function inlineStyle(el) {
  const st = el.getAttribute('style') || '';
  const out = [];
  const color = declaration(st, 'color');
  if (color && !isBlackish(color)) out.push(`color:${color}`);
  const bg = declaration(st, 'background-color');
  if (bg && !/^(transparent|#fff(fff)?|white|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*[,)].*)$/i.test(bg)) out.push(`background-color:${bg}`);
  const size = declaration(st, 'font-size'); if (size) out.push(`font-size:${size}`);
  const fam = declaration(st, 'font-family'); if (fam) out.push(`font-family:${fam}`);
  return out.join(';');
}
function blockStyle(el) {
  const st = el.getAttribute('style') || '';
  const out = [];
  const al = declaration(st, 'text-align'); if (al && !/^(left|start)$/i.test(al)) out.push(`text-align:${al}`);
  const lh = declaration(st, 'line-height'); if (lh) out.push(`line-height:${lh}`);
  const ml = declaration(st, 'margin-left'); if (ml && !/^0(px|pt)?$/.test(ml)) out.push(`margin-left:${ml}`);
  return out.join(';');
}

export function cleanPastedHtml(html) {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  const out = document.createElement('div');

  const walk = (node, into) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { into.append(document.createTextNode(child.nodeValue)); continue; }
      if (child.nodeType !== 1) continue;
      const orig = child.tagName.toUpperCase(); // SVG/MathML elements report lower-case names
      if (DROP.has(orig)) continue;
      const tag = RENAME[orig] || orig;
      const st = style(child);

      // Styled wrappers become real formatting tags.
      if (TABLE_PARTS.has(orig)) continue;
      if (orig === 'SPAN' || orig === 'FONT' || !KEEP.has(tag)) {
        let target = into;
        const wrap = (t) => { const e = document.createElement(t); target.append(e); target = e; };
        if (isBold(st)) wrap('b');
        if (isItalic(st)) wrap('i');
        if (isUnderline(st)) wrap('u');
        if (isStrike(st)) wrap('s');
        const keep = inlineStyle(child);
        if (keep) { const sp = document.createElement('span'); sp.setAttribute('style', keep); target.append(sp); target = sp; }
        walk(child, target);
        continue;
      }
      // Google Docs wraps the whole selection in <b style="font-weight:normal">: that is not bold.
      if (tag === 'B' && notBold(st)) { walk(child, into); continue; }
      if (tag === 'I' && notItalic(st)) { walk(child, into); continue; }


      if (tag === 'A') {
        const href = safeUrl(child.getAttribute('href'));
        if (!href) { walk(child, into); continue; }
        const a = document.createElement('a'); a.setAttribute('href', href); into.append(a); walk(child, a); continue;
      }
      if (tag === 'BR' || tag === 'HR') { into.append(document.createElement(tag.toLowerCase())); continue; }
      const el = document.createElement(tag.toLowerCase());
      if (/^(P|DIV|H1|H2|H3|LI|BLOCKQUOTE|TD|TH)$/.test(tag)) { const bs = blockStyle(child); if (bs) el.setAttribute('style', bs); }
      into.append(el);
      walk(child, el);
      // formatting expressed on a block element (e.g. <p style="font-weight:bold">) applies to its content
      if (/^(P|DIV|LI|H1|H2|H3)$/.test(tag) && el.childNodes.length && (isBold(st) && tag !== 'H1' && tag !== 'H2' && tag !== 'H3' || isItalic(st))) {
        const kids = [...el.childNodes];
        let holder = el;
        if (isBold(st) && !/^H[1-3]$/.test(tag)) { const b = document.createElement('b'); el.append(b); holder = b; kids.forEach((k) => b.append(k)); }
        if (isItalic(st)) { const i = document.createElement('i'); holder.append(i); [...holder === el ? kids : holder.childNodes].filter((k) => k !== i).forEach((k) => i.append(k)); }
      }
    }
  };
  walk(doc.body, out);
  // Tidy: drop empty inline wrappers and trailing whitespace artefacts.
  out.querySelectorAll('b:empty, i:empty, u:empty, s:empty, a:empty').forEach((e) => e.remove());
  return out.innerHTML;
}
