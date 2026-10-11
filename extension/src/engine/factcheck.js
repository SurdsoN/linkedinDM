/**
 * Fact-check flags for drafts.
 *
 * Finds names (capitalised words/phrases, acronyms) and numbers in a draft
 * that do not appear anywhere in the source data: the user's synced profile,
 * their "About me" note, the target's extracted data and the recipient name.
 * Anything flagged may have been invented by the model and should be checked
 * before sending.
 *
 * Heuristic by design: it never edits the draft, it only highlights.
 */

// Capitalised words that are fine without a source.
const ALLOW = new Set(
  [
    'i', "i'm", "i've", "i'd", "i'll", 'linkedin', 'ok', 'ps', 'p.s', 'dm', 'cv', 'hi', 'hello', 'hey', 'dear', 'thanks', 'thank', 'best', 'cheers', 'regards',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
    'congrats', 'congratulations', 'also', 'and', 'team',
    // capitalised function words (after a dash or quote mid-sentence)
    'your', 'my', 'our', 'their', 'the', 'this', 'that', 'these', 'we', 'you', 'it', 'as', 'at', 'in', 'on', 'for', 'with', 'from',
    'loved', 'saw', 'just', 'would', 'happy', 'great', 'curious', 'quick', 'if', 'so', 'but', 'or', 'a', 'an',
  ]
);

// Numbers next to these words are conversational ("15-minute chat"), not claims.
const SOFT_NUMBER_CONTEXT = /^[\s-]*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|quick|short|things|questions|ideas|thoughts|tips|minute)\b/i;

const SKIP_KEYS = new Set(['meta', 'source', 'ownership', 'url', 'syncedAt', 'schemaVersion', 'extractedAt']);

/** Flatten every string in the source objects into one searchable text. */
export function buildCorpus(...sources) {
  const parts = [];
  const walk = (v, key) => {
    if (v == null || SKIP_KEYS.has(key)) return;
    if (typeof v === 'string' || typeof v === 'number') parts.push(String(v));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  sources.forEach((s) => walk(s, ''));
  return normalize(parts.join(' \n '));
}

function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/(\d),(\d)/g, '$1$2') // 1,204 → 1204
    .replace(/\s+/g, ' ');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inCorpus(term, corpus) {
  const t = normalize(term).trim();
  if (!t) return true;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}($|[^\\p{L}\\p{N}])`, 'u').test(corpus);
}

const NAME_RE = /\p{Lu}[\p{L}\p{M}\p{N}'’-]*(?:[ \t]+(?:(?:of|the|and|&|de|da|van|von|for)[ \t]+)?\p{Lu}[\p{L}\p{M}\p{N}'’-]*)*/gu;
const JOINER = /^(of|the|and|&|de|da|van|von|for)$/i;
const allowed = (w) => ALLOW.has(w.toLowerCase().replace(/’/g, "'").replace(/[.']+$/, ''));
const NUMBER_RE = /(?:[$£€₦]\s?)?\d[\d,.]*\d?(?:\s?(?:%|x\b|k\b|m\b|bn\b|\+))?/gi;

/**
 * @param {string} message
 * @param {string} corpus   from buildCorpus()
 * @returns {Array<{term:string, kind:'name'|'number', start:number, end:number}>}
 */
export function factCheck(message, corpus) {
  const text = String(message || '');
  const flags = [];
  // Names
  for (const m of text.matchAll(NAME_RE)) {
    let term = m[0].replace(/['’]s$/u, '').replace(/[.,&-]+$/, '');
    const start = m.index;
    const before = text.slice(0, start);
    const sentenceStart = /(^|[.!?:;—–\n“"(]\s*)$/.test(before) || /(^|\n)\s*$/.test(before);
    let words = term.split(/\s+/);
    // A single capitalised word at a sentence start is usually just grammar.
    if (sentenceStart && words.length === 1 && !/^\p{Lu}{2,}$/u.test(term)) continue;
    // Trim grammatical words from the edges ("Loved the MIT" → "MIT"), unless the whole phrase is known.
    if (!inCorpus(term, corpus)) {
      const isFiller = (w) => JOINER.test(w) || allowed(w);
      while (words.length && isFiller(words[0])) words.shift();
      while (words.length && isFiller(words[words.length - 1])) words.pop();
      if (!words.length) continue;
      term = words.join(' ');
    }
    if (inCorpus(term, corpus)) continue;
    // Accept a phrase if every significant word is known individually.
    const unknown = words.filter((w) => w.length > 1 && !JOINER.test(w) && !allowed(w) && !inCorpus(w, corpus));
    if (!unknown.length) continue;
    const s = text.indexOf(term, start);
    flags.push({ term, kind: 'name', start: s === -1 ? start : s, end: (s === -1 ? start : s) + term.length });
  }

  // Numbers
  for (const m of text.matchAll(NUMBER_RE)) {
    const raw = m[0].trim().replace(/[.,]+$/, '');
    if (!/\d/.test(raw)) continue;
    const after = text.slice(m.index + m[0].length);
    if (SOFT_NUMBER_CONTEXT.test(after)) continue;
    const digits = raw.replace(/[^\d.]/g, '').replace(/\.$/, '');
    if (!digits) continue;
    if (inCorpus(digits, corpus) || inCorpus(raw, corpus)) continue;
    flags.push({ term: raw, kind: 'number', start: m.index, end: m.index + raw.length });
  }

  // De-duplicate overlapping/same terms, keep order.
  const seen = new Set();
  return flags
    .sort((a, b) => a.start - b.start)
    .filter((f) => {
      const k = f.term.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/** Split text into [{text, flagged}] segments for highlighting (all occurrences). */
export function segments(message, flags) {
  const text = String(message || '');
  if (!flags.length) return [{ text, flagged: false }];
  const ranges = [];
  for (const f of flags) {
    const re = new RegExp(escapeRe(f.term), 'g');
    for (const m of text.matchAll(re)) ranges.push([m.index, m.index + f.term.length, f.kind]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [];
  let pos = 0;
  for (const [s, e, kind] of ranges) {
    if (s < pos) continue;
    if (s > pos) out.push({ text: text.slice(pos, s), flagged: false });
    out.push({ text: text.slice(s, e), flagged: true, kind });
    pos = e;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), flagged: false });
  return out;
}
