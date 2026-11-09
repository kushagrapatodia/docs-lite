'use strict';
// Page setup stored per document: paper size, orientation, margins, header / footer text, page numbers.
// Everything is validated against fixed lists; free text is limited and stripped of control characters,
// and is only ever written into XML / CSS through the escaping helpers below.

const SIZES = { a4: { label: 'A4', w: 11906, h: 16838 }, letter: { label: 'Letter', w: 12240, h: 15840 }, legal: { label: 'Legal', w: 12240, h: 20160 } }; // twips
const MARGINS = { normal: { label: 'Normal', tb: 1440, lr: 1440 }, narrow: { label: 'Narrow', tb: 720, lr: 720 }, wide: { label: 'Wide', tb: 1440, lr: 2160 } };
const DEFAULTS = { size: 'a4', orientation: 'portrait', margins: 'normal', header: '', footer: '', pageNumbers: false };
const MAX_TEXT = 120;

function cleanText(v) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Returns a complete, clean settings object, or throws an Error with a message fit to show the user.
function normalizeSettings(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Page setup must be an object');
  const out = { ...DEFAULTS };
  if (raw.size !== undefined) { if (!Object.hasOwn(SIZES, raw.size)) throw new Error('Unknown paper size'); out.size = raw.size; }
  if (raw.orientation !== undefined) { if (raw.orientation !== 'portrait' && raw.orientation !== 'landscape') throw new Error('Orientation must be portrait or landscape'); out.orientation = raw.orientation; }
  if (raw.margins !== undefined) { if (!Object.hasOwn(MARGINS, raw.margins)) throw new Error('Unknown margin size'); out.margins = raw.margins; }
  for (const k of ['header', 'footer']) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'string') throw new Error(`The ${k} must be text`);
    const t = cleanText(raw[k]);
    if (t.length > MAX_TEXT) throw new Error(`The ${k} is limited to ${MAX_TEXT} characters`);
    out[k] = t;
  }
  if (raw.pageNumbers !== undefined) { if (typeof raw.pageNumbers !== 'boolean') throw new Error('pageNumbers must be true or false'); out.pageNumbers = raw.pageNumbers; }
  return out;
}

// What is stored in the database column may be old, empty or hand-edited: always fall back to defaults.
function parseStored(text) {
  if (!text) return { ...DEFAULTS };
  try { return normalizeSettings(JSON.parse(text)); } catch { return { ...DEFAULTS }; }
}

// Page dimensions in twips with orientation applied.
function pageBox(s) {
  const size = SIZES[s.size] || SIZES.a4, m = MARGINS[s.margins] || MARGINS.normal;
  const landscape = s.orientation === 'landscape';
  return { w: landscape ? size.h : size.w, h: landscape ? size.w : size.h, orient: landscape ? 'landscape' : 'portrait', tb: m.tb, lr: m.lr };
}

const cssString = (t) => `"${String(t).replace(/[\\"]/g, '\\$&').replace(/[<>&]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `).replace(/[\n\r]/g, ' ')}"`; // < > & as CSS escapes: the text can never close a <style> element
// @page rule for printing / saving as PDF (margin boxes carry the header, footer and page number)
function pageCss(s) {
  const b = pageBox(s);
  const inch = (tw) => `${tw / 1440}in`;
  const boxes = [];
  if (s.header) boxes.push(`@top-center{content:${cssString(s.header)};font:10pt sans-serif;color:#555}`);
  if (s.footer) boxes.push(`@bottom-left{content:${cssString(s.footer)};font:10pt sans-serif;color:#555}`);
  if (s.pageNumbers) boxes.push('@bottom-right{content:"Page " counter(page);font:10pt sans-serif;color:#555}');
  return `@page{size:${s.size === 'a4' ? 'A4' : s.size === 'legal' ? 'legal' : 'letter'} ${b.orient};margin:${inch(b.tb)} ${inch(b.lr)};${boxes.join('')}}`;
}

module.exports = { SIZES, MARGINS, DEFAULTS, MAX_TEXT, normalizeSettings, parseStored, pageBox, pageCss };
