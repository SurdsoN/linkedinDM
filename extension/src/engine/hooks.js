/**
 * Hook Ranking + Matching Engine (runs fully locally).
 *
 * Takes the user's synced profile and the target profile and produces a
 * ranked list of conversation "hooks". Every hook carries the exact evidence
 * it was built from, so message generation (local or LLM) never needs to
 * invent anything.
 *
 * Hook types
 *   shared_company   both worked at the same company (boost if dates overlap)
 *   shared_school    both studied at the same school
 *   recent_post      the target posted/shared something recently
 *   new_role         the target started a role in the last ~6 months
 *   hiring           the target shows a hiring signal
 *   relevant_result  one of the user's quantified results matches the target's focus
 *   skill_overlap    shared skills (peer angle)
 *   complementary    the user has skills the target's work relies on but doesn't list
 *   featured         something the target chose to feature
 *   about_statement  a distinctive line from the target's About section
 *   mutual           mutual connections (soft social proof)
 *   shared_location  same city / region
 *   open_to_work     the target is open to work (handled delicately)
 *   similar_role     similar job function
 *   alumni           (company pages) the user worked at this company
 *   industry_fit     (company pages) the company's industry/specialties match the user's background
 *   hiring_domain    (research) a domain the company hires for most matches the user's background
 *   company_news     (research) recent news about the company
 *   talent_source    (research) the company often hires from a background the user has
 */

import { tokenize } from './text.js';
import { matchDomains, researchFromPage } from './research.js';

export { tokenize };

export const GOALS = {
  warm: { label: 'Warm Network', weights: { shared_company: 10, alumni: 10, shared_school: 10, mutual: 15, shared_location: 10 } },
  value: { label: 'Value-First', weights: { relevant_result: 20, recent_post: 10, complementary: 15, featured: 5 } },
  opportunity: { label: 'Soft Opportunity', weights: { hiring: 25, hiring_domain: 20, new_role: 10, relevant_result: 15, talent_source: 10, open_to_work: 5 } },
  interview: { label: 'Interview Request', weights: { hiring_domain: 30, relevant_result: 20, hiring: 15, talent_source: 15, alumni: 10, company_news: 5, shared_company: 5 } },
  peer: { label: 'Peer Collaboration', weights: { skill_overlap: 15, similar_role: 15, industry_fit: 10, recent_post: 10, about_statement: 5 } },
};

// Diversity buckets: we pick at most one hook per bucket for the top set.
const BUCKET = {
  shared_company: 'background',
  alumni: 'background',
  industry_fit: 'peer',
  hiring_domain: 'fit',
  company_news: 'timely',
  talent_source: 'background',
  shared_school: 'background',
  shared_location: 'background',
  recent_post: 'timely',
  new_role: 'timely',
  hiring: 'timely',
  open_to_work: 'timely',
  relevant_result: 'value',
  complementary: 'value',
  skill_overlap: 'peer',
  similar_role: 'peer',
  featured: 'content',
  about_statement: 'content',
  mutual: 'social',
};

const COMPANY_SUFFIX = /\b(inc|llc|ltd|limited|plc|gmbh|corp|corporation|co|company|group|holdings|technologies|technology|labs)\.?$/i;

export function normalizeOrg(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}& ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(COMPANY_SUFFIX, '')
    .trim();
}

function normalizeCity(loc) {
  return String(loc || '').split(',')[0].replace(/\b(greater|area|metropolitan|region|bay)\b/gi, '').trim().toLowerCase();
}


const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "Mar 2021" → Date; "2019" → Jan 2019; "Present" → now. */
export function parseMonthYear(s, now = new Date()) {
  if (!s) return null;
  if (/present/i.test(s)) return now;
  const m = String(s).match(/(?:([a-z]{3})[a-z]*\.?\s+)?((?:19|20)\d{2})/i);
  if (!m) return null;
  const month = m[1] ? MONTHS[m[1].toLowerCase()] ?? 0 : 0;
  return new Date(parseInt(m[2], 10), month, 1);
}

function rangeOf(role, now) {
  const r = role.dateRange || {};
  const start = parseMonthYear(r.start, now);
  const end = r.end ? parseMonthYear(r.end, now) : start;
  return start ? { start, end: end || start } : null;
}

function overlaps(a, b) {
  return a && b && a.start <= b.end && b.start <= a.end;
}

function firstSentence(text, max = 220) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,}?[.!?])(\s|$)/);
  const s = m ? m[1] : t;
  return s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s;
}

function snippet(text, max = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : t;
}

/** Lines from the user's experience that contain measurable results. */
export function extractResults(profile) {
  const out = [];
  const RESULT_RE = /(\d+(?:\.\d+)?\s?(?:%|x|k|m|bn|\+)|\$\s?\d|£\s?\d|€\s?\d|₦\s?\d|\b\d{2,}\b\s+(?:users|clients|customers|students|people|projects|countries|languages|hires|members|downloads))/i;
  for (const role of profile.experience || []) {
    const sentences = String(role.description || '')
      .split(/\n|(?<=[.!?])\s+/)
      .map((s) => s.replace(/^[-•*▪◦·]\s*/, '').trim())
      .filter(Boolean);
    for (const s of sentences) {
      if (RESULT_RE.test(s) && s.length >= 20 && s.length <= 260) {
        out.push({ text: s, role: role.title, company: role.company });
      }
    }
  }
  return out;
}

function targetFocusTokens(target) {
  const recent = (target.experience || []).slice(0, 2).map((r) => `${r.title} ${r.description}`).join(' ');
  return new Set(tokenize(`${target.headline} ${target.about} ${recent} ${(target.skills || []).join(' ')}`));
}

function ageInDays(when) {
  // LinkedIn relative times: 5h, 3d, 2w, 1mo, 1yr
  const m = String(when || '').match(/^(\d+)\s*(s|m|h|d|w|mo|yr|y)\b/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  return { s: 0, m: 0, h: n / 24, d: n, w: n * 7, mo: n * 30, yr: n * 365, y: n * 365 }[unit] ?? null;
}

/**
 * Build and rank hooks.
 * @param {object} user   synced user profile
 * @param {object} target extracted target profile
 * @param {{goal?:string, now?:Date}} [opts]
 * @returns {{ all: Hook[], top: Hook[] }}
 */
export function rankHooks(user, target, opts = {}) {
  const goal = GOALS[opts.goal] ? opts.goal : 'warm';
  const now = opts.now || new Date();
  const hooks = target && target.entityType === 'company' ? companyHooks(user, target, now) : personHooks(user, target, now);
  const research = opts.research || (target && target.entityType === 'company' ? researchFromPage(target) : null);
  if (research) hooks.push(...researchHooks(user, target, research));
  return selectTop(hooks, goal);
}

function personHooks(user, target, now) {
  const hooks = [];
  const add = (h) => hooks.push({ id: `${h.type}:${hooks.length}`, ...h });

  // --- Shared companies ------------------------------------------------------
  const userByOrg = new Map();
  for (const r of user.experience || []) {
    const k = normalizeOrg(r.company);
    if (k) (userByOrg.get(k) || userByOrg.set(k, []).get(k)).push(r);
  }
  const seenOrg = new Set();
  for (const tr of target.experience || []) {
    const k = normalizeOrg(tr.company);
    if (!k || seenOrg.has(k) || !userByOrg.has(k)) continue;
    seenOrg.add(k);
    const ur = userByOrg.get(k)[0];
    const together = userByOrg.get(k).some((u) => overlaps(rangeOf(u, now), rangeOf(tr, now)));
    add({
      type: 'shared_company',
      score: 90 + (together ? 8 : 0),
      title: together ? `You overlapped at ${tr.company}` : `You both worked at ${tr.company}`,
      evidence: {
        target: `${tr.title} at ${tr.company}${tr.dateRange ? ` (${tr.dateRange.raw || `${tr.dateRange.start} – ${tr.dateRange.end}`})` : ''}`,
        user: `${ur.title} at ${ur.company}${ur.dateRange ? ` (${ur.dateRange.raw || `${ur.dateRange.start} – ${ur.dateRange.end}`})` : ''}`,
      },
      facts: { company: tr.company, overlapped: together, targetRole: tr.title, userRole: ur.title },
    });
  }

  // --- Shared schools --------------------------------------------------------
  const userSchools = new Map((user.education || []).map((e) => [normalizeOrg(e.school), e]));
  for (const te of target.education || []) {
    const k = normalizeOrg(te.school);
    if (!k || !userSchools.has(k)) continue;
    const ue = userSchools.get(k);
    add({
      type: 'shared_school',
      score: 82,
      title: `Both studied at ${te.school}`,
      evidence: {
        target: [te.degree, te.field].filter(Boolean).join(', ') || te.school,
        user: [ue.degree, ue.field].filter(Boolean).join(', ') || ue.school,
      },
      facts: { school: te.school },
    });
    break;
  }

  // --- Recent activity -------------------------------------------------------
  const post = (target.activity || []).find((a) => a.kind === 'post' && a.text) || (target.activity || [])[0];
  if (post && post.text) {
    const age = ageInDays(post.when);
    add({
      type: 'recent_post',
      score: 78 + (age != null && age <= 14 ? 8 : age != null && age > 60 ? -15 : 0),
      title: post.kind === 'repost' ? 'Recently shared a post' : post.kind === 'comment' ? 'Recently commented on a post' : 'Recent post',
      evidence: { target: `“${snippet(post.text, 180)}”${post.when ? ` (${post.when} ago)` : ''}` },
      facts: { postSnippet: snippet(post.text, 300), when: post.when, kind: post.kind, url: post.url },
    });
  }

  // --- New role --------------------------------------------------------------
  const current = (target.experience || []).find((r) => r.isCurrent);
  if (current) {
    const start = parseMonthYear(current.dateRange && current.dateRange.start, now);
    const months = start ? (now - start) / (1000 * 60 * 60 * 24 * 30.4) : null;
    if (months != null && months >= 0 && months <= 6) {
      add({
        type: 'new_role',
        score: 74,
        title: `Started as ${current.title} recently`,
        evidence: { target: `${current.title} at ${current.company} since ${current.dateRange.start}` },
        facts: { title: current.title, company: current.company, since: current.dateRange.start },
      });
    }
  }

  // --- Hiring / open to work ---------------------------------------------------
  const sig = target.signals || {};
  if (sig.hiring) {
    add({
      type: 'hiring',
      score: 76,
      title: 'Hiring signal on profile',
      evidence: { target: `#Hiring signal${target.currentCompany ? ` (${target.currentCompany})` : ''}` },
      facts: { company: target.currentCompany },
    });
  }
  if (sig.openToWork) {
    add({
      type: 'open_to_work',
      score: 50,
      title: 'Open to work',
      evidence: { target: sig.openToWorkDetails || '#OpenToWork signal' },
      facts: { details: sig.openToWorkDetails },
      caution: 'Be tactful — do not mention their job search unless it is clearly relevant.',
    });
  }

  // --- User results relevant to target --------------------------------------
  const focus = targetFocusTokens(target);
  const results = extractResults(user)
    .map((r) => {
      const overlap = [...new Set(tokenize(`${r.text} ${r.role}`))].filter((t) => focus.has(t));
      return { ...r, overlap };
    })
    .filter((r) => r.overlap.length > 0)
    .sort((a, b) => b.overlap.length - a.overlap.length);
  if (results[0]) {
    const r = results[0];
    add({
      type: 'relevant_result',
      score: 62 + Math.min(r.overlap.length, 5) * 3,
      title: 'One of your results matches their focus',
      evidence: { user: `${r.text} (${r.role}${r.company ? `, ${r.company}` : ''})`, target: `Shared themes: ${r.overlap.slice(0, 4).join(', ')}` },
      facts: { result: r.text, role: r.role, company: r.company, themes: r.overlap.slice(0, 4) },
    });
  }

  // --- Skills ----------------------------------------------------------------
  const uSkills = new Map((user.skills || []).map((s) => [s.toLowerCase(), s]));
  const tSkills = new Map((target.skills || []).map((s) => [s.toLowerCase(), s]));
  const shared = [...tSkills.keys()].filter((k) => uSkills.has(k)).map((k) => tSkills.get(k));
  if (shared.length >= 2) {
    add({
      type: 'skill_overlap',
      score: 50 + Math.min(shared.length, 6) * 2,
      title: `Shared skills: ${shared.slice(0, 3).join(', ')}`,
      evidence: { target: shared.slice(0, 6).join(', '), user: shared.slice(0, 6).join(', ') },
      facts: { skills: shared.slice(0, 6) },
    });
  }
  // Complementary: user skills mentioned in the target's text but not in their skills list.
  const targetText = `${target.headline} ${target.about} ${(target.experience || []).slice(0, 3).map((r) => r.description).join(' ')}`.toLowerCase();
  const complementary = [...uSkills.values()].filter((s) => !tSkills.has(s.toLowerCase()) && s.length > 2 && targetText.includes(s.toLowerCase()));
  if (complementary.length) {
    add({
      type: 'complementary',
      score: 58 + Math.min(complementary.length, 4) * 2,
      title: `Your skills fit their work: ${complementary.slice(0, 2).join(', ')}`,
      evidence: { user: complementary.slice(0, 4).join(', '), target: 'Mentioned in their headline/About/experience' },
      facts: { skills: complementary.slice(0, 4) },
    });
  }

  // --- Similar role ----------------------------------------------------------
  const uTitle = new Set(tokenize(`${user.headline} ${(user.experience || [])[0]?.title || ''}`));
  const tTitleTokens = tokenize(`${target.headline} ${(target.experience || [])[0]?.title || ''}`);
  const titleOverlap = [...new Set(tTitleTokens.filter((t) => uTitle.has(t)))];
  if (titleOverlap.length) {
    add({
      type: 'similar_role',
      score: 42 + Math.min(titleOverlap.length, 3) * 4,
      title: 'Similar line of work',
      evidence: { target: target.headline, user: user.headline },
      facts: { themes: titleOverlap.slice(0, 3) },
    });
  }

  // --- Featured / About ------------------------------------------------------
  const feat = (target.featured || [])[0];
  if (feat) {
    add({
      type: 'featured',
      score: 60,
      title: `Featured: ${snippet(feat.title, 60)}`,
      evidence: { target: `${feat.type ? feat.type + ': ' : ''}${snippet(feat.title, 120)}${feat.snippet ? ` — ${snippet(feat.snippet, 100)}` : ''}` },
      facts: { title: feat.title, type: feat.type, url: feat.url },
    });
  }
  if (target.about && target.about.length > 40) {
    const sentences = target.about.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 30 && s.length < 240);
    // Prefer a sentence with a number or a strong first-person claim; else the first.
    const pick =
      sentences.find((s) => /\d/.test(s)) ||
      sentences.find((s) => /\b(i (build|help|lead|love|believe|focus|started|founded)|my mission|passionate)\b/i.test(s)) ||
      sentences[0];
    if (pick) {
      add({
        type: 'about_statement',
        score: 52,
        title: 'Line from their About',
        evidence: { target: `“${firstSentence(pick)}”` },
        facts: { quote: firstSentence(pick) },
      });
    }
  }

  // --- Mutual connections ----------------------------------------------------
  const mutual = sig.mutualConnections || {};
  if (mutual.count > 0 || (mutual.names || []).length) {
    add({
      type: 'mutual',
      score: 48 + Math.min(mutual.count || 1, 10),
      title: `${mutual.count || mutual.names.length} mutual connection${(mutual.count || mutual.names.length) === 1 ? '' : 's'}`,
      evidence: { target: mutual.text || (mutual.names || []).join(', ') },
      facts: { names: mutual.names || [], count: mutual.count || 0 },
    });
  }

  // --- Location --------------------------------------------------------------
  const uc = normalizeCity(user.location);
  if (uc && uc === normalizeCity(target.location)) {
    add({
      type: 'shared_location',
      score: 44,
      title: `Both based in ${String(target.location).split(',')[0].trim()}`,
      evidence: { target: target.location, user: user.location },
      facts: { city: String(target.location).split(',')[0].trim() },
    });
  }

  return hooks;
}

/** Goal weighting + diversity selection (max one hook per bucket in the top 3). */
function selectTop(hooks, goal) {
  const weights = GOALS[goal].weights;
  for (const h of hooks) h.score += weights[h.type] || 0;
  hooks.sort((a, b) => b.score - a.score);

  const top = [];
  const usedBuckets = new Set();
  for (const h of hooks) {
    if (top.length >= 3) break;
    const b = BUCKET[h.type] || h.type;
    if (usedBuckets.has(b)) continue;
    usedBuckets.add(b);
    top.push(h);
  }
  // If buckets ran out, fill with the next best regardless of bucket.
  for (const h of hooks) {
    if (top.length >= 3) break;
    if (!top.includes(h)) top.push(h);
  }
  return { all: hooks, top };
}

/**
 * Hooks for a company page. The "recipient" is the company (or a person the
 * user names, such as a recruiter), so hooks are about the company itself.
 */
function companyHooks(user, company, now) {
  const hooks = [];
  const add = (h) => hooks.push({ id: `${h.type}:${hooks.length}`, ...h });
  const name = company.name;
  const key = normalizeOrg(name);

  // Alumni / current employee
  const roles = (user.experience || []).filter((r) => key && normalizeOrg(r.company) === key);
  if (roles.length) {
    const r = roles[0];
    add({
      type: 'alumni',
      score: 92,
      title: r.isCurrent ? `You work at ${name}` : `You worked at ${name}`,
      evidence: { user: `${r.title} at ${r.company}${r.dateRange ? ` (${r.dateRange.raw || `${r.dateRange.start} – ${r.dateRange.end}`})` : ''}` },
      facts: { company: name, userRole: r.title, current: !!r.isCurrent },
    });
  }

  // Recent company post
  const post = (company.activity || []).find((a) => a.text);
  if (post) {
    const age = ageInDays(post.when);
    add({
      type: 'recent_post',
      score: 78 + (age != null && age <= 14 ? 8 : age != null && age > 60 ? -15 : 0),
      title: `Recent post from ${name}`,
      evidence: { target: `“${snippet(post.text, 180)}”${post.when ? ` (${post.when} ago)` : ''}` },
      facts: { postSnippet: snippet(post.text, 300), when: post.when, kind: 'post', url: post.url, company: name },
    });
  }

  // Hiring
  const sig = company.signals || {};
  if (sig.hiring) {
    add({
      type: 'hiring',
      score: 76 + (sig.jobsCount ? 4 : 0),
      title: sig.jobsCount ? `${name} has ${sig.jobsCount} open job${sig.jobsCount === 1 ? '' : 's'}` : `${name} is hiring`,
      evidence: { target: sig.jobsCount ? `${sig.jobsCount} open jobs listed` : 'Hiring signal on the page' },
      facts: { company: name, jobsCount: sig.jobsCount || 0 },
    });
  }

  // User results / skills that match what the company does
  const focus = new Set(tokenize(`${company.tagline} ${company.about} ${company.industry} ${(company.specialties || []).join(' ')}`));
  const results = extractResults(user)
    .map((r) => ({ ...r, overlap: [...new Set(tokenize(`${r.text} ${r.role}`))].filter((t) => focus.has(t)) }))
    .filter((r) => r.overlap.length > 0)
    .sort((a, b) => b.overlap.length - a.overlap.length);
  if (results[0]) {
    const r = results[0];
    add({
      type: 'relevant_result',
      score: 62 + Math.min(r.overlap.length, 5) * 3,
      title: `One of your results matches what ${name} does`,
      evidence: { user: `${r.text} (${r.role}${r.company ? `, ${r.company}` : ''})`, target: `Shared themes: ${r.overlap.slice(0, 4).join(', ')}` },
      facts: { result: r.text, role: r.role, company: r.company, themes: r.overlap.slice(0, 4), targetIsCompany: true, targetName: name },
    });
  }
  const companyText = `${company.tagline} ${company.about} ${company.industry} ${(company.specialties || []).join(' ')}`.toLowerCase();
  const matching = (user.skills || []).filter((s) => s.length > 2 && companyText.includes(s.toLowerCase()));
  if (matching.length) {
    add({
      type: 'complementary',
      score: 58 + Math.min(matching.length, 4) * 2,
      title: `Your skills fit ${name}: ${matching.slice(0, 2).join(', ')}`,
      evidence: { user: matching.slice(0, 4).join(', '), target: 'Mentioned in their tagline, overview or specialties' },
      facts: { skills: matching.slice(0, 4), targetIsCompany: true, targetName: name },
    });
  }

  // Industry fit: industry words appear in the user's headline/about/roles
  const userText = new Set(tokenize(`${user.headline} ${user.about} ${(user.experience || []).map((r) => r.title).join(' ')}`));
  const industryOverlap = [...new Set(tokenize(`${company.industry} ${company.tagline}`))].filter((t) => userText.has(t));
  if (industryOverlap.length) {
    add({
      type: 'industry_fit',
      score: 46 + Math.min(industryOverlap.length, 3) * 4,
      title: `Your background fits their space`,
      evidence: { target: [company.industry, company.tagline].filter(Boolean).join(' — '), user: user.headline },
      facts: { themes: industryOverlap.slice(0, 3), industry: company.industry, company: name },
    });
  }

  // Overview quote (mission line)
  if (company.about && company.about.length > 40) {
    const sentences = company.about.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 30 && s.length < 240);
    const pick = sentences.find((s) => /\b(mission|we (believe|help|build|exist|make)|our goal)\b/i.test(s)) || sentences.find((s) => /\d/.test(s)) || sentences[0];
    if (pick) {
      add({
        type: 'about_statement',
        score: 54,
        title: `Line from ${name}'s overview`,
        evidence: { target: `“${firstSentence(pick)}”` },
        facts: { quote: firstSentence(pick), company: name, targetIsCompany: true },
      });
    }
  }

  // Connections who work there
  const mutual = sig.mutualConnections || {};
  if (mutual.count > 0) {
    add({
      type: 'mutual',
      score: 50 + Math.min(mutual.count, 10),
      title: `${mutual.count} of your connection${mutual.count === 1 ? '' : 's'} work${mutual.count === 1 ? 's' : ''} here`,
      evidence: { target: mutual.text },
      facts: { names: mutual.names || [], count: mutual.count, company: name, targetIsCompany: true },
    });
  }

  // HQ city
  const uc = normalizeCity(user.location);
  if (uc && company.headquarters && uc === normalizeCity(company.headquarters)) {
    add({
      type: 'shared_location',
      score: 44,
      title: `${name} is based in your city`,
      evidence: { target: company.headquarters, user: user.location },
      facts: { city: String(company.headquarters).split(',')[0].trim(), targetIsCompany: true },
    });
  }
  return hooks;
}

/**
 * Hooks from company research (web or page-only). For a person target the
 * research is about the company they currently work at.
 */
function researchHooks(user, target, research) {
  const hooks = [];
  const company = target.entityType === 'company' ? target.name : target.currentCompany || research.companyName || 'their company';
  const add = (h) => hooks.push({ id: `${h.type}:r${hooks.length}`, ...h });
  const via = (d) => (d.source === 'page' ? 'LinkedIn Jobs tab' : 'web research');

  const matches = matchDomains(user, research.hiringFocus);
  if (matches[0]) {
    const d = matches[0];
    add({
      type: 'hiring_domain',
      score: 80 + Math.min(d.score, 6) * 2,
      title: `${company} is hiring in ${d.domain} — your area`,
      evidence: {
        target: `${d.domain}${d.roles && d.roles.length ? `: ${d.roles.slice(0, 3).join(', ')}` : ''} (${via(d)})`,
        user: d.overlap.length ? `Matches your background: ${d.overlap.join(', ')}` : 'Same field as your recent roles',
      },
      facts: { company, domain: d.domain, roles: d.roles || [], themes: d.overlap, source: d.source, targetIsCompany: target.entityType === 'company' },
    });
  } else if ((research.hiringFocus || [])[0]) {
    const d = research.hiringFocus[0];
    add({
      type: 'hiring_domain',
      score: 58,
      title: `${company} is mostly hiring in ${d.domain}`,
      evidence: { target: `${d.domain}${d.roles && d.roles.length ? `: ${d.roles.slice(0, 3).join(', ')}` : ''} (${via(d)})` },
      facts: { company, domain: d.domain, roles: d.roles || [], themes: [], source: d.source, weakMatch: true, targetIsCompany: target.entityType === 'company' },
      caution: 'This hiring area is not a clear match for the sender — only mention it if the sender’s background genuinely fits.',
    });
  }

  const news = (research.recentNews || [])[0];
  if (news) {
    add({
      type: 'company_news',
      score: 66,
      title: `Recent news: ${news.headline.slice(0, 60)}`,
      evidence: { target: `${news.headline}${news.date ? ` (${news.date})` : ''}` },
      facts: { company, headline: news.headline, date: news.date, detail: news.detail },
    });
  }

  // Talent sources: does the user come from a background they hire from?
  const userOrgs = (user.experience || []).map((r) => r.company).concat((user.education || []).map((e) => e.school)).filter(Boolean);
  const userText = `${userOrgs.join(' | ')} ${user.headline} ${(user.experience || []).map((r) => r.title).join(' ')}`.toLowerCase();
  for (const t of research.talentSources || []) {
    const org = userOrgs.find((o) => t.source.toLowerCase().includes(o.toLowerCase()) || o.toLowerCase().includes(t.source.toLowerCase()));
    const overlap = [...new Set(tokenize(t.source))].filter((w) => userText.includes(w));
    if (org || overlap.length >= 1) {
      add({
        type: 'talent_source',
        score: org ? 78 : 60 + Math.min(overlap.length, 3) * 3,
        title: `${company} often hires from ${t.source.slice(0, 50)} — like you`,
        evidence: { target: `${t.source}${t.evidence ? ` — ${t.evidence}` : ''} (web research)`, user: org || overlap.join(', ') },
        facts: { company, source: t.source, userMatch: org || overlap.join(', ') },
      });
      break;
    }
  }
  return hooks;
}
