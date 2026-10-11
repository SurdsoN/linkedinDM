/**
 * "Is this my profile?" — decided from the name and (optional) LinkedIn
 * username the user enters in Settings, not guessed from the page.
 *
 *  1. Username set  → the page's /in/<slug> must match it exactly.
 *  2. Name only     → the name shown on the page must match the Settings name
 *                     (accent/case-insensitive; middle names and suffixes such
 *                     as ", MBA" are tolerated), and the page must not show
 *                     viewer-only buttons (Connect / Message / Follow).
 *  3. Page shows no readable name → fall back to owner-only controls
 *                     ("Add profile section", "Open to", edit links).
 */

/**
 * Accepts "https://www.linkedin.com/in/jane-doe-123/", "linkedin.com/in/jane-doe-123",
 * "/in/jane-doe-123" or "jane-doe-123". Returns the lowercase slug, or '' if invalid.
 */
export function parseLinkedInId(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  const m = s.match(/(?:^|\/)in\/([^/?#\s]+)/i);
  if (m) s = m[1];
  else if (/[/\s]/.test(s.replace(/\/+$/, ''))) return '';
  s = s.replace(/\/+$/, '').replace(/^@/, '');
  try {
    s = decodeURIComponent(s);
  } catch (_) { /* keep raw */ }
  return /^[\p{L}\p{N}_.-]{2,100}$/u.test(s) ? s.toLowerCase() : '';
}

const SUFFIXES = new Set(['mba', 'phd', 'msc', 'bsc', 'ba', 'ma', 'md', 'cpa', 'pmp', 'jr', 'sr', 'ii', 'iii', 'mr', 'mrs', 'ms', 'dr', 'prof', 'esq', 'cfa', 'acca', 'ceng']);

function nameTokens(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ') // "(She/Her)"
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ''))
    .filter((t) => t && !SUFFIXES.has(t));
}

/** True when two display names refer to the same person name. */
export function namesMatch(a, b) {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  // Allow extra middle names ("Jane Doe" ~ "Jane Mary Doe"): every token of the
  // shorter name must appear in the longer one and the first names must agree.
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 2 && long.length > 1) return false; // a single word isn't enough
  const set = new Set(long);
  return short.every((t) => set.has(t)) && short[0] === long[0];
}

/**
 * @param {{slug:string, pageName:string, viewerSignals?:string[], ownerSignals?:string[]}} page
 * @param {{name:string, linkedinId:string}} me  from Settings
 * @returns {{mine:boolean, needsSetup?:boolean, method:string, reason:string}}
 */
export function checkOwnership(page, me) {
  const name = String((me && me.name) || '').trim();
  const id = parseLinkedInId(me && me.linkedinId);
  const slug = String(page.slug || '').toLowerCase();
  if (!name) return { mine: false, needsSetup: true, method: 'none', reason: 'Add your name in Settings first.' };

  if (id) {
    return slug === id
      ? { mine: true, method: 'username', reason: '' }
      : { mine: false, method: 'username', reason: `This page is linkedin.com/in/${page.slug}, but your Settings say your profile is linkedin.com/in/${id}.` };
  }

  const viewer = (page.viewerSignals || []).filter((s) => s !== 'mutual-connections');
  if (page.pageName) {
    if (!namesMatch(page.pageName, name)) {
      return { mine: false, method: 'name', reason: `This profile shows “${page.pageName}”, but your name in Settings is “${name}”.` };
    }
    if (viewer.length) {
      return { mine: false, method: 'name', reason: `This profile has your name, but it shows ${viewer.join('/')} buttons, so it looks like someone else’s. Add your LinkedIn username in Settings to be sure.` };
    }
    return { mine: true, method: 'name', reason: '' };
  }

  // No readable name on the page: rely on owner-only controls.
  const owner = page.ownerSignals || [];
  return owner.length && !viewer.length
    ? { mine: true, method: 'page-controls', reason: '' }
    : { mine: false, method: 'page-controls', reason: 'Couldn’t read the name on this page. Add your LinkedIn username in Settings so the profile can be matched by its address.' };
}
