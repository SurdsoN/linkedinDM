/**
 * "Draft Application" — a job application message to a company (for its
 * careers email, LinkedIn message, or a hiring contact), written from the
 * user's synced profile + About-me note, the company page, and research.
 */

import { LLMError } from './errors.js';
import { stripReasoning } from './llm.js';

/** LinkedIn message limit is 750 characters; we aim for 700 to leave room for edits. */
export const MAX_APPLICATION_CHARS = 700;
export const LINKEDIN_MESSAGE_LIMIT = 750;

const TONE = {
  friendly: 'Warm and confident, plain words.',
  professional: 'Polished and professional, still human.',
  direct: 'Direct and concise.',
  casual: 'Relaxed but respectful.',
};

export const APPLICATION_SYSTEM = `You write job application messages that get candidates interviews.

Hard rules:
1. NEVER invent facts. Use only details in APPLICANT (incl. APPLICANT.note), COMPANY and RESEARCH. No made-up numbers, employers, degrees, certifications or achievements.
2. Open with one specific, accurate line about the company (from COMPANY or RESEARCH) — never "I hope this finds you well" or "I came across your page".
3. Match the applicant to what the company does and hires for (COMPANY.specialties, RESEARCH.hiringFocus / matchedHiringDomains). Name the role area they fit.
4. Back the fit with 1–2 concrete points from APPLICANT's experience (prefer measurable results), each in one short sentence.
5. If APPLICANT.note says what they are looking for (role, location, availability), use it.
6. End with a clear, polite ask for an interview or a short call, and say a CV/portfolio is available on request.
7. LENGTH: the body must be AT MOST ${MAX_APPLICATION_CHARS} characters in total, counting spaces and line breaks (LinkedIn's limit is ${LINKEDIN_MESSAGE_LIMIT}). Aim for 600–${MAX_APPLICATION_CHARS}. 3–4 very short paragraphs. No emojis, no hashtags, no buzzwords ("synergy", "leverage", "passionate").
8. Address the named contact if given, otherwise the hiring/recruitment team of the company.
9. Sign off with the applicant's full name (it counts toward the limit).

Return only JSON: {"subject": "...", "body": "...", "why": "one sentence on why this application fits", "roleArea": "the role area pitched"}`;

function trim(s, n) {
  return String(s || '').slice(0, n);
}

/**
 * @param {{user:object, company:object, research?:object|null, matchedDomains?:object[], note?:string, recipientName?:string, tone?:string, avoid?:string}} o
 */
export function buildApplicationPrompt({ user, company, research = null, matchedDomains = [], note = '', recipientName = '', tone = 'professional', avoid = '' }) {
  const applicant = {
    name: user.name,
    headline: user.headline,
    location: user.location,
    about: trim(user.about, 1200),
    experience: (user.experience || []).slice(0, 6).map((r) => ({
      title: r.title,
      company: r.company,
      dates: r.dateRange ? r.dateRange.raw || `${r.dateRange.start} – ${r.dateRange.end}` : '',
      description: trim(r.description, 600) || undefined,
      skills: (r.skills || []).slice(0, 6),
    })),
    education: (user.education || []).slice(0, 3).map((e) => ({ school: e.school, degree: [e.degree, e.field].filter(Boolean).join(', ') })),
    certifications: (user.certifications || []).slice(0, 5).map((c) => c.name),
    languages: (user.languages || []).slice(0, 6).map((l) => [l.title, l.subtitle].filter(Boolean).join(' — ')),
    skills: (user.skills || []).slice(0, 25),
    ...(note && note.trim() ? { note: note.trim().slice(0, 800) } : {}),
  };
  const companyData = {
    name: company.name,
    tagline: company.tagline,
    industry: company.industry,
    headquarters: company.headquarters,
    size: company.companySize,
    founded: company.founded,
    website: company.website,
    specialties: (company.specialties || []).slice(0, 20),
    overview: trim(company.about, 1800),
    openJobsOnLinkedIn: (company.jobs || []).slice(0, 15).map((j) => j.title),
    recentPosts: (company.activity || []).slice(0, 2).map((a) => trim(a.text, 300)),
  };
  const researchData = research
    ? {
        summary: research.summary,
        hiringFocus: (research.hiringFocus || []).slice(0, 5).map((d) => ({ domain: d.domain, roles: d.roles })),
        matchedHiringDomains: (matchedDomains || []).slice(0, 3).map((d) => ({ domain: d.domain, roles: d.roles, matchesApplicantOn: d.overlap })),
        recentNews: (research.recentNews || []).slice(0, 2),
        values: (research.values || []).slice(0, 3),
        interviewAngles: (research.interviewAngles || []).slice(0, 3),
      }
    : null;
  const user_ = `Write a job application message from APPLICANT to COMPANY.
TONE: ${TONE[tone] || TONE.professional}
${recipientName ? `CONTACT: ${recipientName}\n` : ''}${avoid ? `Write a clearly different version from this previous draft:\n---\n${trim(avoid, 1500)}\n---\n` : ''}
DATA:
${JSON.stringify({ APPLICANT: applicant, COMPANY: companyData, ...(researchData ? { RESEARCH: researchData } : {}) }, null, 2)}`;
  return { system: APPLICATION_SYSTEM, user: user_ };
}

/** Parse {subject, body, why, roleArea} from a model reply (tolerates reasoning and prose). */
export function parseApplication(raw) {
  const text = stripReasoning(raw);
  const tries = [text, (text.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const t of tries) {
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      const body = String(o.body || o.message || o.email || o.text || '').trim();
      if (body.length > 40) {
        return { subject: String(o.subject || o.title || '').trim(), body, why: String(o.why || o.reason || ''), roleArea: String(o.roleArea || o.role || '') };
      }
    } catch (_) { /* next */ }
  }
  throw new LLMError('The application reply was not in the expected format.', { format: true });
}

/**
 * Ask the model to shorten a draft to the limit without changing its facts.
 * @returns {{system:string, user:string}}
 */
export function buildShortenPrompt(body, max = MAX_APPLICATION_CHARS) {
  return {
    system: APPLICATION_SYSTEM,
    user: `Shorten this application message to AT MOST ${max} characters in total (it is ${String(body).length} now), counting spaces and line breaks. Keep the greeting, the specific opening line, the strongest concrete point, the interview ask and the sign-off. Do not add any new facts. Return the same JSON shape with the same subject.

MESSAGE:
${body}`,
  };
}
