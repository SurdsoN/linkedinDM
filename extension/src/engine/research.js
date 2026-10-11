/**
 * Company research.
 *
 * Two sources, both user-triggered:
 *  1. Web research via Gemini with Google Search grounding (needs a Gemini
 *     key + consent). Only the company name and a little context (industry,
 *     location, website) are sent — never profile text. Results and source
 *     links come back from Gemini; nothing on LinkedIn is fetched.
 *  2. Page-only: job titles visible on the company's LinkedIn "Jobs" tab are
 *     grouped into hiring domains locally (no network).
 *
 * Research is kept in the side panel's memory only.
 */

import { LLMError } from './errors.js';
import { requestJSON } from './http.js';
import { tokenize } from './text.js';

// Hiring domains and the title keywords that map to them.
export const DOMAINS = [
  // Most specific first: "Localization PM" is Localization, not Product.
  ['Localization & Language', /\b(locali[sz]ation|translat(or|ion)|interpret(er|ing)|linguist|language|l10n|i18n|subtitl)\w*/i],
  ['Engineering', /\b(engineer|engineering|developer|software|backend|front[- ]?end|full[- ]?stack|devops|sre|mobile|ios|android|qa|test|architect|platform|security|infrastructure)\b/i],
  ['Data & AI', /\b(data|analytics|analyst|scientist|machine learning|ml|ai|bi|insights)\b/i],
  ['Product', /\b(product (manager|owner|lead)|product management|\bpm\b)\b/i],
  ['Design', /\b(design|designer|ux|ui|research(er)?)\b/i],
  ['Content & Marketing', /\b(marketing|content|brand|growth|seo|social media|communications|copywriter|editor|pr)\b/i],
  ['Sales & Partnerships', /\b(sales|account (executive|manager)|business development|bdr|sdr|partnership|partner)\b/i],
  ['Customer Success & Support', /\b(customer|support|success|service|onboarding|implementation)\b/i],
  ['Operations & Project Management', /\b(operations|ops|project manager|program manager|project management|delivery|coordinator|logistics|supply chain)\b/i],
  ['Finance & Legal', /\b(finance|financial|accountant|accounting|controller|legal|counsel|compliance|audit|tax)\b/i],
  ['People & HR', /\b(hr|human resources|people|talent|recruit(er|ing)|hiring)\b/i],
  ['Education & Training', /\b(teacher|instructor|curriculum|learning|training|tutor|education)\b/i],
];

/** Group job titles into hiring domains, most common first. */
export function domainsFromJobTitles(titles) {
  const counts = new Map();
  for (const t of titles || []) {
    const hit = DOMAINS.find(([, re]) => re.test(t));
    const name = hit ? hit[0] : 'Other';
    const entry = counts.get(name) || { domain: name, roles: [], count: 0 };
    entry.count++;
    if (entry.roles.length < 4 && !entry.roles.includes(t)) entry.roles.push(t);
    counts.set(name, entry);
  }
  return [...counts.values()]
    .filter((d) => d.domain !== 'Other' || counts.size === 1)
    .sort((a, b) => b.count - a.count)
    .map((d) => ({ ...d, evidence: `${d.count} open role${d.count === 1 ? '' : 's'} on their LinkedIn Jobs tab`, source: 'page' }));
}

/** Score how well each hiring domain matches the user's background. */
export function matchDomains(user, hiringFocus) {
  const userTokens = new Set(
    tokenize(`${user.headline} ${user.about} ${(user.experience || []).map((r) => `${r.title} ${r.description}`).join(' ')} ${(user.skills || []).join(' ')}`)
  );
  const userTitles = (user.experience || []).map((r) => r.title).join(' ');
  return (hiringFocus || [])
    .map((d) => {
      const text = `${d.domain} ${(d.roles || []).join(' ')} ${d.evidence || ''}`;
      const overlap = [...new Set(tokenize(text))].filter((t) => userTokens.has(t));
      // Same domain bucket as one of the user's own titles is a strong signal.
      const domainDef = DOMAINS.find(([name]) => name === d.domain);
      const sameDomain = domainDef ? domainDef[1].test(userTitles) : false;
      return { ...d, overlap: overlap.slice(0, 5), score: overlap.length + (sameDomain ? 3 : 0), sameDomain };
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score);
}

const RESEARCH_PROMPT = (c) => `Research the company below using web search. I am preparing a job-seeking outreach message and need accurate, current facts.

Company: ${c.name}
${c.industry ? `Industry (from LinkedIn): ${c.industry}\n` : ''}${c.location ? `Location (from LinkedIn): ${c.location}\n` : ''}${c.website ? `Website: ${c.website}\n` : ''}${c.linkedinUrl ? `LinkedIn page: ${c.linkedinUrl}\n` : ''}
Rules:
- Only include facts supported by your search results. If something is unknown, use an empty string or empty array. Never guess.
- Prefer the last 12 months. Include dates where you have them.
- "hiringFocus" = the job areas/domains this company is hiring for most right now (from their careers page, job boards, LinkedIn jobs, news about team growth). Order by how much they are hiring.
- "talentSources" = backgrounds, companies, schools or industries this company commonly hires people from, if publicly evident (e.g. employee backgrounds, hiring announcements). Leave empty if not evident.
- Keep every string short (under 200 characters).

Return ONLY a JSON object with exactly these keys:
{
  "summary": "what the company does, in one or two sentences",
  "industry": "",
  "headquarters": "",
  "size": "",
  "products": ["main products or services"],
  "recentNews": [{"headline": "", "date": "", "detail": ""}],
  "hiringFocus": [{"domain": "e.g. Engineering, Localization & Language, Sales", "roles": ["example open role titles"], "evidence": "where this comes from"}],
  "talentSources": [{"source": "", "evidence": ""}],
  "values": ["stated values or culture points"],
  "interviewAngles": ["specific talking points a candidate could raise"],
  "confidence": "high | medium | low"
}`;

function parseJSONObject(raw) {
  const text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
  const tries = [text, (text.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const t of tries) {
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch (_) { /* next */ }
  }
  throw new LLMError('Research reply was not in the expected format. Try again.', { format: true });
}

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v.trim().slice(0, 400) : '');

/** Normalise model output into a predictable shape. */
export function normalizeResearch(o, sources = []) {
  return {
    summary: str(o.summary),
    industry: str(o.industry),
    headquarters: str(o.headquarters),
    size: str(o.size),
    products: arr(o.products).map(str).filter(Boolean).slice(0, 6),
    recentNews: arr(o.recentNews).map((n) => ({ headline: str(n && n.headline), date: str(n && n.date), detail: str(n && n.detail) })).filter((n) => n.headline).slice(0, 5),
    hiringFocus: arr(o.hiringFocus)
      .map((d) => ({ domain: str(d && d.domain), roles: arr(d && d.roles).map(str).filter(Boolean).slice(0, 5), evidence: str(d && d.evidence), source: (d && d.source) || 'web', count: (d && d.count) || 0 }))
      .filter((d) => d.domain)
      .slice(0, 6),
    talentSources: arr(o.talentSources).map((t) => ({ source: str(t && t.source), evidence: str(t && t.evidence) })).filter((t) => t.source).slice(0, 5),
    values: arr(o.values).map(str).filter(Boolean).slice(0, 5),
    interviewAngles: arr(o.interviewAngles).map(str).filter(Boolean).slice(0, 5),
    confidence: /^(high|medium|low)$/i.test(str(o.confidence)) ? str(o.confidence).toLowerCase() : 'low',
    sources,
  };
}

/**
 * Research a company on the web with Gemini + Google Search grounding.
 * @param {{apiKey:string, model:string, company:{name:string, industry?:string, location?:string, website?:string, linkedinUrl?:string}}} req
 */
export async function researchCompany({ apiKey, model, company }) {
  if (!apiKey) throw new LLMError('Company research uses Google Gemini with Search. Add your Gemini key in Settings.');
  if (!company || !company.name) throw new LLMError('No company name to research.');
  const m = model || 'gemini-flash-latest';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`;
  const data = await requestJSON(
    url,
    { 'x-goog-api-key': apiKey },
    { contents: [{ role: 'user', parts: [{ text: RESEARCH_PROMPT(company) }] }], tools: [{ google_search: {} }] },
    { provider: 'gemini', label: 'Gemini web search', model: m }
  );
  const cand = data && data.candidates && data.candidates[0];
  if (!cand) throw new LLMError('Gemini returned no research result.', { provider: 'gemini' });
  const text = (cand.content?.parts || []).map((p) => p.text || '').join('');
  const chunks = cand.groundingMetadata?.groundingChunks || [];
  const sources = chunks
    .map((c) => c.web)
    .filter((w) => w && w.uri)
    .map((w) => ({ title: w.title || w.uri, uri: w.uri }));
  return { ...normalizeResearch(parseJSONObject(text), dedupeSources(sources)), engine: `Gemini + Google Search (${m})` };
}

function dedupeSources(list) {
  return list.filter((s, i, a) => s.uri && a.findIndex((x) => x.uri === s.uri) === i).slice(0, 8);
}

// Groq ways to search the web, tried in order. "compound" systems search on their
// own; gpt-oss models can use the built-in browser_search tool (free in beta).
const GROQ_SEARCH_ATTEMPTS = [
  { model: 'groq/compound' },
  { model: 'groq/compound-mini' },
  // 20b first: browser search pulls whole pages into the request (many tokens), and
  // each model has its own daily quota — this keeps 120b's quota for writing drafts.
  { model: 'openai/gpt-oss-20b', tools: [{ type: 'browser_search' }], tool_choice: 'required', reasoning_effort: 'low' },
  { model: 'openai/gpt-oss-120b', tools: [{ type: 'browser_search' }], tool_choice: 'required', reasoning_effort: 'low' },
];

async function groqModelIds(apiKey) {
  try {
    const data = await requestJSON('https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${apiKey}` }, null, { provider: 'groq', label: 'Groq', timeoutMs: 15000 });
    return ((data && data.data) || []).map((m) => m.id);
  } catch (_) {
    return []; // unknown → just try every option
  }
}

/** Errors that mean "this way of searching isn't available — try the next one". */
function searchOptionUnavailable(e) {
  return (
    e &&
    (e.status === 404 ||
      e.status === 403 ||
      e.format ||
      (e.status === 429 && (e.quota === 'daily' || e.quota === 'none')) || // this model's daily quota — the next has its own
      (e.status === 400 && /tool|browser_search|model|not supported|does not exist|reasoning/i.test(`${e.detail} ${e.message}`)))
  );
}

/**
 * Research with Groq: compound systems first, then gpt-oss + browser_search.
 * Uses whichever the key actually has access to.
 */
export async function researchWithGroq({ apiKey, company }) {
  if (!apiKey) throw new LLMError('Add a Groq key in Settings to research with Groq.');
  if (!company || !company.name) throw new LLMError('No company name to research.');
  const ids = await groqModelIds(apiKey);
  const attempts = GROQ_SEARCH_ATTEMPTS.filter((a) => !ids.length || ids.includes(a.model));
  if (!attempts.length) throw new LLMError('Your Groq key has no model with web search (compound or gpt-oss). Add a free Tavily key in Settings for research.', { provider: 'groq', status: 404 });
  const failures = [];
  for (const a of attempts) {
    try {
      const data = await requestJSON(
        'https://api.groq.com/openai/v1/chat/completions',
        { Authorization: `Bearer ${apiKey}` },
        { model: a.model, messages: [{ role: 'user', content: RESEARCH_PROMPT(company) }], ...(a.tools ? { tools: a.tools, tool_choice: a.tool_choice } : {}), ...(a.reasoning_effort ? { reasoning_effort: a.reasoning_effort } : {}) },
        { provider: 'groq', label: 'Groq web search', model: a.model }
      );
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      if (!msg || !msg.content) throw new LLMError('Groq returned no research result.', { provider: 'groq' });
      // Sources: search results reported by the tool calls, plus any links in the answer.
      const fromTools = (msg.executed_tools || [])
        .flatMap((t) => (t.search_results && t.search_results.results) || [])
        .map((r) => ({ title: r.title || r.url, uri: r.url }));
      const fromText = (msg.content.match(/https?:\/\/[^\s)"'\]]+/g) || []).map((u) => ({ title: u.replace(/^https?:\/\/(www\.)?/, '').split('/')[0], uri: u }));
      const how = a.tools ? `${a.model} + browser search` : a.model;
      return { ...normalizeResearch(parseJSONObject(msg.content), dedupeSources(fromTools.concat(fromText))), engine: `Groq web search (${how})` };
    } catch (e) {
      if (!searchOptionUnavailable(e)) throw e;
      failures.push(`${a.tools ? `${a.model} browser search` : a.model}: ${e.status === 429 ? e.message : e.detail || e.message}`);
    }
  }
  throw new LLMError(`None of Groq’s web-search options are available for your key. Groq said — ${failures.join(' · ')}. Add a free Tavily key in Settings for research.`, { provider: 'groq', status: 404 });
}

/**
 * Research with Tavily (free plan: 1,000 searches/month): two basic searches
 * (overview + hiring), then the user's AI provider summarises ONLY those results.
 * @param {(prompt:string) => Promise<string>} summarize  returns the model's JSON text
 */
export async function researchWithTavily({ tavilyKey, company, summarize, pageContext = null }) {
  if (!tavilyKey) throw new LLMError('Add a Tavily key in Settings to research with Tavily.');
  const where = company.location ? ` ${company.location}` : '';
  const site = (String(company.website || '').match(/^https?:\/\/(?:www\.)?([^/]+)/i) || [])[1];
  const queries = [`${company.name}${where}${site ? ` ${site}` : ''} company overview services news`, `${company.name}${site ? ` ${site}` : ''} careers hiring open jobs roles`];
  const results = [];
  for (const query of queries) {
    const data = await requestJSON(
      'https://api.tavily.com/search',
      { Authorization: `Bearer ${tavilyKey}` },
      { query, search_depth: 'basic', max_results: 6, include_answer: false },
      { provider: 'tavily', label: 'Tavily', timeoutMs: 30000 }
    );
    for (const r of (data && data.results) || []) {
      if (r.url && !results.some((x) => x.url === r.url)) results.push({ title: r.title || r.url, url: r.url, content: String(r.content || '').slice(0, 700) });
    }
  }
  if (!results.length) throw new LLMError(`Tavily found nothing for “${company.name}”. Check the company name.`, { provider: 'tavily' });
  const prompt = `${RESEARCH_PROMPT(company).replace('using web search', 'using ONLY the search results below')}

${pageContext ? `\nTHE COMPANY'S OWN LINKEDIN PAGE (also a valid source — combine it with the search results):\n${JSON.stringify(pageContext, null, 2)}\n` : ''}
SEARCH RESULTS:
${results.map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n${r.content}`).join('\n\n')}`;
  const text = await summarize(prompt);
  return { ...normalizeResearch(parseJSONObject(text), dedupeSources(results.map((r) => ({ title: r.title, uri: r.url })))), engine: 'Tavily search' };
}

/** Page-only research from a company extraction (no network). */
export function researchFromPage(company) {
  const titles = (company && company.jobs ? company.jobs.map((j) => j.title) : []).filter(Boolean);
  if (!titles.length) return null;
  return normalizeResearch({ hiringFocus: domainsFromJobTitles(titles), summary: company.tagline || '' }, []);
}
