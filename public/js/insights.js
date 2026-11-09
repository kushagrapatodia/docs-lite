// Writing statistics. Words and sentences come from Intl.Segmenter, so Chinese, Japanese, Thai and Arabic
// count correctly (splitting on spaces would call a whole Chinese paragraph "one word").
const seg = (type, loc) => { try { return new Intl.Segmenter(loc, { granularity: type }); } catch { return null; } };
const STOP = new Set('the a an and or but of to in on at for with is are was were be been it this that as by from not have has had you your i we they he she'.split(' '));

function syllables(word) { // English heuristic: vowel groups, minus a silent final e
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  const groups = w.replace(/e$/, '').match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

export function analyse(text, locale) {
  const t = String(text || '').replace(/​/g, '');
  const wordSeg = seg('word', locale), sentSeg = seg('sentence', locale);
  const words = [];
  if (wordSeg) { for (const s of wordSeg.segment(t)) if (s.isWordLike) words.push(s.segment); }
  else words.push(...(t.match(/\S+/g) || []));
  let sentences = 0, longest = null;
  if (sentSeg) { for (const s of sentSeg.segment(t)) { const trimmed = s.segment.trim(); if (!trimmed) continue; sentences++; const n = (trimmed.match(/\S+/g) || []).length; if (!longest || n > longest.words) longest = { words: n, text: trimmed.slice(0, 140) }; } }
  else sentences = (t.match(/[^.!?]+[.!?]*/g) || []).filter((x) => x.trim()).length;
  const paragraphs = t.split(/\n+/).filter((p) => p.trim()).length;
  const latin = words.filter((w) => /^[A-Za-z'’-]+$/.test(w));
  const english = words.length > 0 && latin.length / words.length > 0.8;
  const syl = english ? latin.reduce((n, w) => n + syllables(w), 0) : 0;
  // Flesch reading ease: 206.835 - 1.015 (words/sentences) - 84.6 (syllables/words); English only
  const flesch = english && sentences && words.length ? Math.round(206.835 - 1.015 * (words.length / sentences) - 84.6 * (syl / words.length)) : null;
  const freq = new Map();
  for (const w of words) { const k = w.toLowerCase(); if (k.length > 2 && !STOP.has(k)) freq.set(k, (freq.get(k) || 0) + 1); }
  const top = [...freq].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
  return {
    words: words.length, characters: t.replace(/\n/g, '').length, charactersNoSpaces: t.replace(/\s/g, '').length, sentences, paragraphs,
    readingMinutes: words.length / 230, speakingMinutes: words.length / 130, flesch, level: flesch === null ? null : fleschLabel(flesch),
    avgSentence: sentences ? Math.round((words.length / sentences) * 10) / 10 : 0, longest, top,
  };
}

export function fleschLabel(n) {
  if (n >= 90) return 'Very easy'; if (n >= 70) return 'Easy'; if (n >= 60) return 'Plain English'; if (n >= 50) return 'Fairly difficult'; if (n >= 30) return 'Difficult'; return 'Very difficult';
}
