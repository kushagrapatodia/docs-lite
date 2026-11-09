// Client copy of the page-setup constants (the server validates everything again).
export const DEFAULT_SETTINGS = { size: 'a4', orientation: 'portrait', margins: 'normal', header: '', footer: '', pageNumbers: false };
export const SIZES = { a4: { label: 'A4', w: 794, h: 1123, css: 'A4' }, letter: { label: 'Letter', w: 816, h: 1056, css: 'letter' }, legal: { label: 'Legal', w: 816, h: 1344, css: 'legal' } }; // CSS px at 96 dpi
export const MARGINS = { normal: { label: 'Normal (1 in)', tb: 96, lr: 96 }, narrow: { label: 'Narrow (0.5 in)', tb: 48, lr: 48 }, wide: { label: 'Wide (1.5 in sides)', tb: 96, lr: 144 } };

export const isDefault = (s) => s.size === 'a4' && s.orientation === 'portrait' && s.margins === 'normal';
export function paperPixels(s) { const z = SIZES[s.size] || SIZES.a4; return s.orientation === 'landscape' ? { w: z.h, h: z.w } : { w: z.w, h: z.h }; }

const cssString = (t) => `"${String(t).replace(/[\\"]/g, '\\$&').replace(/[\n\r]/g, ' ')}"`;
// @page rule for printing / saving as PDF; margin boxes carry the header, footer and page number
export function pageCss(s) {
  const z = SIZES[s.size] || SIZES.a4, m = MARGINS[s.margins] || MARGINS.normal;
  const box = (name, content) => `@${name}{content:${content};font:10pt sans-serif;color:#555}`;
  const boxes = [s.header && box('top-center', cssString(s.header)), s.footer && box('bottom-left', cssString(s.footer)), s.pageNumbers && box('bottom-right', '"Page " counter(page)')].filter(Boolean);
  return `@page{size:${z.css} ${s.orientation};margin:${m.tb / 96}in ${m.lr / 96}in;${boxes.join('')}}`;
}

// A constructable stylesheet is not an inline <style>, so it works under the strict CSP.
let sheet = null;
export function applyPrintStyles(s) {
  try {
    if (!sheet) sheet = new CSSStyleSheet();
    sheet.replaceSync(pageCss(s));
    if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch { /* older browsers print with the default page */ }
}
export function removePrintStyles() {
  if (sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet);
}
