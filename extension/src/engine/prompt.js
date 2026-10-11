/**
 * Prompt construction for LLM-based DM generation.
 *
 * Data minimisation: only the fields that help write a good opener are sent
 * (no profile URLs, follower counts, or the full raw extraction).
 */

import { GOALS } from './hooks.js';

export const TONES = {
  friendly: 'Friendly and warm, like a thoughtful peer. Contractions are fine.',
  professional: 'Professional and polished, but still human — no corporate jargon.',
  direct: 'Direct and concise. Get to the point in the first line.',
  casual: 'Casual and relaxed, conversational. Still respectful.',
};

export const LENGTHS = {
  note: { label: 'Connection note (≤300 chars)', maxChars: 300, guide: 'Max 300 characters total (LinkedIn connection-note limit). 2–3 short sentences.' },
  dm: { label: 'Direct message (≤600 chars)', maxChars: 600, guide: 'Roughly 300–600 characters. 3–5 short sentences, no paragraphs longer than 2 sentences.' },
};

const GOAL_GUIDE = {
  warm: 'Build a genuine connection. The CTA is light: connecting, swapping notes, or a short chat. Do not ask for a job.',
  value: 'Lead with something useful to them grounded in the sender’s real experience. Offer, don’t ask. CTA: offer to share/send something or a quick exchange.',
  opportunity:
    'Open a door to a possible hiring conversation without asking for a job outright. Show relevant fit through the sender’s real results. CTA: ask what they look for / whether a short chat makes sense.',
  interview:
    'The aim is an interview or hiring conversation. Name the specific area the company is hiring in that matches the sender (from RESEARCH.matchedHiringDomains or HOOKS), back it with ONE concrete result from SENDER, and make a clear, polite ask: a short conversation about open roles in that area, or whether they are the right person / could point the sender to the right person. Confident and specific, never desperate. Do not attach or mention a CV unless SENDER.note says so.',
  peer: 'Propose a peer-to-peer exchange: comparing approaches, collaborating, or trading lessons on a shared topic. CTA: a short call or async exchange.',
};

export const SYSTEM_PROMPT = `You write LinkedIn direct messages for networking that can lead to hiring conversations.

Hard rules:
1. NEVER invent facts. Use only details present in SENDER (including SENDER.note), RECIPIENT, RESEARCH and HOOKS. If a detail is not there, leave it out. No made-up numbers, companies, mutual friends, events, or compliments about things not shown.
2. The first sentence must be specific to the recipient (reference a hook), never generic ("I came across your profile", "I hope this finds you well" are forbidden).
3. Sound like a real person: plain words, no buzzwords ("synergy", "leverage", "passionate about connecting"), no flattery, no emojis, no hashtags, at most one exclamation mark.
4. One low-friction call to action at the end, phrased as an easy question. No calendar links, no "15-minute call this week?" pressure if the goal is warm.
5. Address the recipient by first name. Do not sign with a placeholder like [Your Name]; end without a signature, or with the sender's first name.
6. Each variant must lead with a DIFFERENT hook or angle.
7. Respect the length limit strictly.
8. If a hook carries a "caution", follow it.
9. SENDER.note is the sender's own words about goals or context not on their profile (e.g. what they are looking for). Use it when it helps, rephrased naturally; never contradict it.
10. RESEARCH comes from a web search (or the company's LinkedIn Jobs tab) about the company (for a person: the company they work at). Use at most one or two research facts, stated accurately and briefly; prefer facts that connect to the sender's background (matchedHiringDomains, talentSources).
11. If RECIPIENT.type is "company": address RECIPIENT_PERSON by first name if given, otherwise "<Company> team". Refer to the company in the second person ("your team"), and do not claim the recipient personally wrote company posts.

Return only JSON matching the requested schema.`;

function trimCompany(c) {
  return {
    type: 'company',
    name: c.name,
    tagline: c.tagline,
    industry: c.industry,
    headquarters: c.headquarters,
    companySize: c.companySize,
    founded: c.founded,
    specialties: (c.specialties || []).slice(0, 15),
    overview: String(c.about || '').slice(0, 1200),
    recentPosts: (c.activity || []).slice(0, 3).map((a) => ({ when: a.when, text: String(a.text || '').slice(0, 400) })),
    signals: {
      hiring: !!(c.signals && c.signals.hiring),
      openJobs: (c.signals && c.signals.jobsCount) || 0,
      connectionsWorkingThere: c.signals && c.signals.mutualConnections ? c.signals.mutualConnections.text : '',
    },
  };
}

function trimProfile(p, { isSender }) {
  const exp = (p.experience || []).slice(0, isSender ? 6 : 5).map((r) => ({
    title: r.title,
    company: r.company,
    dates: r.dateRange ? r.dateRange.raw || `${r.dateRange.start} – ${r.dateRange.end}` : '',
    current: !!r.isCurrent,
    location: r.location || undefined,
    description: String(r.description || '').slice(0, isSender ? 700 : 400) || undefined,
  }));
  return {
    name: p.name,
    firstName: String(p.name || '').split(/\s+/)[0],
    headline: p.headline,
    location: p.location,
    about: String(p.about || '').slice(0, isSender ? 1200 : 900),
    experience: exp,
    education: (p.education || []).slice(0, 3).map((e) => ({ school: e.school, degree: [e.degree, e.field].filter(Boolean).join(', '), dates: e.dateRange ? e.dateRange.raw : '' })),
    skills: (p.skills || []).slice(0, 20),
    ...(isSender
      ? {}
      : {
          featured: (p.featured || []).slice(0, 3).map((f) => ({ type: f.type, title: f.title, snippet: String(f.snippet || '').slice(0, 200) })),
          recentActivity: (p.activity || []).slice(0, 3).map((a) => ({ kind: a.kind, when: a.when, text: String(a.text || '').slice(0, 400) })),
          signals: {
            hiring: !!(p.signals && p.signals.hiring),
            openToWork: !!(p.signals && p.signals.openToWork),
            mutualConnections: p.signals && p.signals.mutualConnections ? p.signals.mutualConnections.text : '',
          },
        }),
  };
}

function trimResearch(r, matched, companyName) {
  return {
    about: companyName,
    summary: r.summary,
    industry: r.industry,
    size: r.size,
    products: r.products,
    recentNews: (r.recentNews || []).slice(0, 3),
    hiringFocus: (r.hiringFocus || []).slice(0, 4).map((d) => ({ domain: d.domain, roles: d.roles, evidence: d.evidence })),
    matchedHiringDomains: (matched || []).slice(0, 3).map((d) => ({ domain: d.domain, roles: d.roles, matchesSenderOn: d.overlap })),
    talentSources: (r.talentSources || []).slice(0, 3),
    values: (r.values || []).slice(0, 3),
    interviewAngles: (r.interviewAngles || []).slice(0, 3),
  };
}

/**
 * @param {object} o
 * @param {string} [o.note]           sender's "About me" note
 * @param {string} [o.recipientName]  company targets: person being messaged
 * @param {number} [o.count=3]        number of variants (1 = regenerate one card)
 * @param {string[]} [o.avoid]        existing drafts the new one must differ from
 * @param {object} [o.research]        company research (research.js)
 * @param {object[]} [o.matchedDomains] hiring domains matched to the sender
 * @returns {{system:string, user:string, maxChars:number}}
 */
export function buildPrompt({ user, target, hooks, goal, tone, length, note = '', recipientName = '', count = 3, avoid = [], research = null, matchedDomains = [] }) {
  const len = LENGTHS[length] || LENGTHS.dm;
  const isCompany = target.entityType === 'company';
  const sender = trimProfile(user, { isSender: true });
  if (note && note.trim()) sender.note = note.trim().slice(0, 800);
  const payload = {
    SENDER: sender,
    RECIPIENT: isCompany ? trimCompany(target) : trimProfile(target, { isSender: false }),
    ...(isCompany && recipientName.trim() ? { RECIPIENT_PERSON: { name: recipientName.trim(), firstName: recipientName.trim().split(/\s+/)[0] } } : {}),
    ...(research ? { RESEARCH: trimResearch(research, matchedDomains, isCompany ? target.name : target.currentCompany) } : {}),
    HOOKS: hooks.map((h) => ({ id: h.id, type: h.type, title: h.title, evidence: h.evidence, ...(h.caution ? { caution: h.caution } : {}) })),
  };
  const ask =
    count === 1
      ? `Write 1 new LinkedIn message variant from SENDER to ${isCompany ? 'the RECIPIENT company' : 'RECIPIENT'}.` +
        (avoid.length ? `\nIt must take a clearly different angle and wording from these existing drafts:\n${avoid.map((m, i) => `--- draft ${i + 1} ---\n${m}`).join('\n')}` : '')
      : `Write ${count} LinkedIn message variants from SENDER to ${isCompany ? 'the RECIPIENT company' : 'RECIPIENT'}.`;
  const userMsg = `${ask}

GOAL: ${(GOALS[goal] || GOALS.warm).label} — ${GOAL_GUIDE[goal] || GOAL_GUIDE.warm}
TONE: ${TONES[tone] || TONES.friendly}
LENGTH: ${len.guide}

For each variant return:
- "angle": 2–5 word label for the approach
- "message": the full message text, ready to paste
- "why": one or two sentences on why this works for this specific recipient
- "hooksUsed": array of HOOK ids used

DATA:
${JSON.stringify(payload, null, 2)}`;
  return { system: SYSTEM_PROMPT, user: userMsg, maxChars: len.maxChars };
}
/** JSON schema shared by providers that support structured output. */
export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    variants: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          angle: { type: 'string' },
          message: { type: 'string' },
          why: { type: 'string' },
          hooksUsed: { type: 'array', items: { type: 'string' } },
        },
        required: ['angle', 'message', 'why', 'hooksUsed'],
      },
    },
  },
  required: ['variants'],
};
