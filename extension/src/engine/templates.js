/**
 * Local (no-API) message generator.
 *
 * Used when no provider is configured, or as a fallback. Sentences are built
 * only from hook evidence and the user's own synced profile, so nothing is
 * invented — the trade-off is less natural phrasing than an LLM.
 *
 * Works for person targets and company targets (addressed to a named
 * recipient if given, otherwise "<Company> team").
 */

import { LENGTHS } from './prompt.js';

const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

const GREETING = { friendly: 'Hi', professional: 'Hello', direct: 'Hi', casual: 'Hey' };

/** Opening line per hook type (specific first sentence). */
function opener(h, ctx) {
  const f = h.facts || {};
  const co = ctx.companyName;
  switch (h.type) {
    case 'shared_company':
      return f.overlapped
        ? `I noticed we were both at ${f.company} around the same time — I was there as ${f.userRole}.`
        : `I saw you were at ${f.company} as well — I spent time there as ${f.userRole}.`;
    case 'alumni':
      return f.current ? `I'm ${article(f.userRole)} ${f.userRole} at ${f.company} and wanted to connect with more of the team.` : `I spent time at ${f.company} as ${f.userRole} and still follow what the team is building.`;
    case 'shared_school':
      return `Fellow ${f.school} alum here.`;
    case 'recent_post':
      if (co) return `I saw ${co}'s recent post — “${trimQuote(f.postSnippet)}” — and it stuck with me.`;
      return f.kind === 'repost'
        ? `I saw the post you shared recently (“${trimQuote(f.postSnippet)}”) and it stuck with me.`
        : `Your recent post — “${trimQuote(f.postSnippet)}” — stuck with me.`;
    case 'new_role':
      return `Congrats on starting as ${f.title} at ${f.company}.`;
    case 'hiring':
      if (co) return f.jobsCount ? `I saw ${co} has ${f.jobsCount} open role${f.jobsCount === 1 ? '' : 's'} right now.` : `I saw ${co} is hiring.`;
      return f.company ? `I noticed you're hiring at ${f.company}.` : `I noticed you're hiring.`;
    case 'relevant_result':
      return co
        ? `${co}'s focus on ${f.themes.slice(0, 2).join(' and ')} caught my eye — it's close to what I've been doing.`
        : `Your focus on ${f.themes.slice(0, 2).join(' and ')} caught my eye — it's close to what I've been doing.`;
    case 'skill_overlap':
      return `Looks like we work in a lot of the same areas — ${f.skills.slice(0, 2).join(' and ')} especially.`;
    case 'complementary':
      return co
        ? `${co}'s work leans on ${f.skills.slice(0, 2).join(' and ')}, which is a big part of what I do.`
        : `Your work leans on ${f.skills.slice(0, 2).join(' and ')}, which is a big part of what I do.`;
    case 'similar_role':
      return `We seem to do similar work, so I wanted to reach out.`;
    case 'industry_fit':
      return `My background lines up closely with what ${co || 'your team'} does${f.industry ? ` in ${f.industry.toLowerCase()}` : ''}.`;
    case 'featured':
      return `I came across “${trimQuote(f.title)}” on your profile and enjoyed it.`;
    case 'about_statement':
      return co ? `This line from ${co}'s overview stood out: “${trimQuote(f.quote)}”` : `This line from your About stood out: “${trimQuote(f.quote)}”`;
    case 'mutual':
      if (co) return f.names && f.names[0] ? `${f.names[0]} and others in my network work at ${co}, so I wanted to reach out.` : `A few people in my network work at ${co}, so I wanted to reach out.`;
      return f.names && f.names[0] ? `We're both connected with ${f.names[0]}, so I thought I'd say hello.` : `We share a few connections, so I thought I'd say hello.`;
    case 'shared_location':
      return co ? `I'm also based in ${f.city}, so ${co} has been on my radar.` : `Always good to meet someone else in ${f.city}.`;
    case 'open_to_work':
      return `I came across your profile and liked the work you've done.`;
    case 'hiring_domain':
      return f.roles && f.roles[0]
        ? `I saw ${f.company} is hiring in ${f.domain} — including ${f.roles[0]} — which is exactly my field.`
        : `I saw ${f.company} is growing its ${f.domain} team, which is exactly my field.`;
    case 'company_news':
      return `I saw the news about ${f.company}: “${trimQuote(f.headline)}”.`;
    case 'talent_source':
      return `I noticed ${f.company} brings in a lot of people from ${f.source} — that's my background too.`;
    default:
      return h.title + '.';
  }
}

/** Secondary hook phrased as a short add-on sentence (null = not used as add-on). */
function addOn(h, ctx) {
  const f = h.facts || {};
  const co = ctx.companyName;
  switch (h.type) {
    case 'shared_company':
      return f.overlapped ? `We also overlapped at ${f.company}, where I was ${f.userRole}.` : `We also both spent time at ${f.company}.`;
    case 'alumni':
      return f.current ? null : `I worked at ${f.company} myself, as ${f.userRole}.`;
    case 'shared_school':
      return `We're also both ${f.school} alumni.`;
    case 'hiring':
      return co ? `I also saw ${co} is hiring.` : f.company ? `I also saw ${f.company} is hiring.` : null;
    case 'mutual':
      if (co) return f.count ? `${f.count} people in my network work there, too.` : null;
      return f.names && f.names[0] ? `We're both connected with ${f.names[0]}, too.` : null;
    case 'shared_location':
      return co ? `I'm based in ${f.city} as well.` : `And we're both in ${f.city}.`;
    case 'skill_overlap':
      return `We share a lot of ground on ${f.skills.slice(0, 2).join(' and ')}.`;
    case 'hiring_domain':
      return f.weakMatch ? null : `I also saw ${f.company} is hiring in ${f.domain}, which is my area.`;
    case 'company_news':
      return `Congrats on the recent news, too (“${trimQuote(f.headline, 60)}”).`;
    default:
      return null;
  }
}

function trimQuote(s, max = 90) {
  const t = String(s || '').replace(/\s+/g, ' ').replace(/^“|”$/g, '').trim();
  return t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : t;
}

/** A short "who I am" line from the user's own data. */
function bridge(user, hook) {
  if (hook && hook.type === 'relevant_result' && hook.facts.result) {
    const r = hook.facts.result.replace(/[.\s]+$/, '');
    return `As ${article(hook.facts.role)} ${hook.facts.role}${hook.facts.company ? ` at ${hook.facts.company}` : ''}, I ${lowerFirst(r)}.`;
  }
  if (hook && hook.type === 'alumni') return '';
  const role = (user.experience || []).find((r) => r.isCurrent) || (user.experience || [])[0];
  if (role && role.title) return `I'm ${article(role.title)} ${role.title}${role.company ? ` at ${role.company}` : ''}.`;
  return user.headline ? `A bit about me: ${user.headline}.` : '';
}

function article(word) {
  return /^[aeiou]/i.test(String(word || '')) ? 'an' : 'a';
}

function lowerFirst(s) {
  // Keep acronyms/proper nouns ("Led", "Built" → "led", "built"; "AWS" unchanged).
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

const CTA = {
  warm: ['Would you be open to connecting?', 'Happy to swap notes sometime if you’re up for it.', 'Would you be open to a quick chat sometime?', 'Would you be up for connecting here?'],
  value: ['Happy to share what worked for me if it’s useful — want me to send a few notes over?', 'If it helps, I can share a couple of things I learned — interested?', 'Would a short write-up of how I approached it be useful?', 'Want me to send over what I’d do differently next time?'],
  opportunity: ['Would you be open to a short chat about what your team looks for?', 'If it makes sense, I’d love to hear what you look for in people joining your team — open to a quick chat?', 'Would you be open to connecting in case there’s a fit down the line?', 'Would it make sense to have a short conversation about the team’s plans?'],
  interview: [
    'Would you be open to a short conversation about open roles on the team?',
    'Are you the right person to talk to about these roles — or could you point me to who is?',
    'Would you be open to a 20-minute call to see if my background fits what you need?',
    'If it’s a fit, I’d love to be considered — would a quick chat this week or next work?',
  ],
  peer: ['Would you be up for comparing notes sometime?', 'Open to a quick call to trade approaches?', 'Would you be interested in swapping ideas on this?', 'Fancy trading notes on what’s working for each of us?'],
};

const WHY = {
  shared_company: 'Shared employers create instant context and trust.',
  alumni: 'Having worked there gives you real context and credibility with the team.',
  shared_school: 'An alumni link is a warm, low-pressure opener.',
  recent_post: 'Referencing a recent post shows you actually follow their work.',
  new_role: 'New roles are a natural moment to reach out.',
  hiring: 'They are actively hiring, so a relevant intro is welcome.',
  relevant_result: 'Leads with a concrete result that matches their focus.',
  skill_overlap: 'Shared skills make a peer conversation easy to start.',
  complementary: 'Shows how your skills fit the work they do.',
  similar_role: 'Similar roles make for an easy peer exchange.',
  industry_fit: 'Connects your background directly to their space.',
  featured: 'They chose to feature this, so it matters to them.',
  about_statement: 'Quoting their own words shows genuine interest.',
  mutual: 'Mutual connections add soft social proof.',
  shared_location: 'Local ties make meeting up easy.',
  open_to_work: 'Keeps it tactful without mentioning their job search.',
  hiring_domain: 'Ties your background directly to the area they are hiring in most.',
  company_news: 'Timely: shows you follow the company, not just the job posting.',
  talent_source: 'They already hire people with your background — you fit the pattern.',
};

/**
 * @param {object} o
 * @param {number} [o.seed=0]  shifts lead hook / CTA choice — used by "Regenerate" for one card
 * @param {string} [o.recipientName]  company targets: the person being messaged
 * @returns {Array<{angle,message,why,hooksUsed}>}
 */
export function generateLocal({ user, target, hooks, goal = 'warm', tone = 'friendly', length = 'dm', seed = 0, recipientName = '' }) {
  const maxChars = (LENGTHS[length] || LENGTHS.dm).maxChars;
  const isCompany = target.entityType === 'company';
  const ctx = { companyName: isCompany ? target.name : '' };
  const toName = isCompany ? recipientName || `${target.name} team` : first(target.name);
  const greeting = `${GREETING[tone] || 'Hi'} ${isCompany && recipientName ? first(recipientName) : toName},`;
  const ctas = CTA[goal] || CTA.warm;
  const signoff = tone === 'professional' ? `\n\nBest,\n${first(user.name)}` : `\n\n${first(user.name)}`;
  const list = hooks.length ? hooks : [{ id: 'none', type: isCompany ? 'industry_fit' : 'similar_role', title: 'Reaching out', facts: {} }];
  const n = list.length;

  return list.slice(0, 3).map((_, i) => {
    const lead = list[(i + seed) % n];
    const support = list.find((h) => h !== lead && h.type !== 'open_to_work');
    const resultHook = lead.type === 'relevant_result' ? lead : support && support.type === 'relevant_result' ? support : lead;
    const parts = [opener(lead, ctx)];
    const b = bridge(user, resultHook);
    if (b) parts.push(b);
    const sameTopic = (a, b) => [a, b].sort().join() === 'hiring,hiring_domain';
    if (length !== 'note' && support && support.type !== lead.type && !sameTopic(lead.type, support.type)) {
      const extra = addOn(support, ctx);
      if (extra) parts.push(extra);
    }
    parts.push(ctas[(i + seed) % ctas.length]);

    let body = `${greeting}\n\n${parts.join(' ')}`;
    let message = body + signoff;
    // Fit length: drop optional parts until within the limit.
    while (message.length > maxChars && parts.length > 2) {
      parts.splice(parts.length - 2, 1);
      body = `${greeting} ${parts.join(' ')}`;
      message = length === 'note' ? body : body + signoff;
    }
    if (length === 'note' && message.length > maxChars) message = `${greeting} ${parts.join(' ')}`.slice(0, maxChars);

    return {
      angle: lead.title,
      message,
      why: WHY[lead.type] || 'Specific opener grounded in their profile.',
      hooksUsed: [lead.id].concat(support ? [support.id] : []),
    };
  });
}
