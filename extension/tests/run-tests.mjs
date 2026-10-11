/**
 * Test harness: runs the real extractor inside headless Chromium against the
 * synthetic fixtures (served at linkedin.com URLs via request interception),
 * then runs the hook ranker and local generator on the results in Node.
 *
 *   node tests/run-tests.mjs
 *
 * Requires Playwright (`npm i -D playwright` or a global install).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import assert from 'node:assert/strict';
import { OWN_PROFILE, TARGET_PROFILE, OWN_DETAILS_SKILLS, COMPANY_HOME, COMPANY_ABOUT, COMPANY_JOBS, OWN_PROFILE_REDESIGN, OWN_PROFILE_2026, TARGET_PROFILE_2026, OWN_PROFILE_OCT26, COMPANY_ABOUT_OCT26 } from './fixtures.mjs';
import { rankHooks } from '../src/engine/hooks.js';
import { generateLocal } from '../src/engine/templates.js';
import { buildPrompt } from '../src/engine/prompt.js';
import { parseVariants, pingGemini } from '../src/engine/llm.js';
import { buildCorpus, factCheck, segments } from '../src/engine/factcheck.js';
import { toTemplate, fillTemplate } from '../src/engine/favorites.js';
import { rankGeminiModels, pickGeminiModel, isModelUnavailable } from '../src/engine/gemini-models.js';
import { LLMError } from '../src/engine/errors.js';
import { classifyQuota, requestJSON } from '../src/engine/http.js';
import { rankGroqModels, pickGroqModel } from '../src/engine/groq-models.js';
import { isModelQuotaExhausted } from '../src/engine/gemini-models.js';
import { buildApplicationPrompt, buildShortenPrompt, MAX_APPLICATION_CHARS } from '../src/engine/application.js';
import { compareVersions, checkForUpdate, downloadUpdate } from '../src/shared/updater.js';
import { unzip } from '../src/shared/zip.js';
import { execFileSync } from 'node:child_process';
import { readFileSync as readFile, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkOwnership, namesMatch, parseLinkedInId } from '../src/shared/identity.js';
import { domainsFromJobTitles, matchDomains, normalizeResearch, researchFromPage } from '../src/engine/research.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright']) {
    try {
      return require(p);
    } catch (_) { /* try next */ }
  }
  throw new Error('Playwright not found. Run: npm i -D playwright');
}
const { chromium } = loadPlaywright();
const extractorSrc = readFileSync(path.join(here, '../src/content/extractor.js'), 'utf8');
// Load the classic-script extractor in Node for its pure helpers.
const sandbox = { module: { exports: {} }, URL };
vm.runInNewContext(extractorSrc, sandbox);
const X = sandbox.module.exports;

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${e.message.split('\n').join('\n    ')}`);
  }
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function extractFrom(url, html, ctx) {
  const pg = await browser.newPage();
  await pg.route('https://www.linkedin.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await pg.goto(url);
  await pg.addScriptTag({ content: extractorSrc });
  const result = await pg.evaluate(async (c) => {
    await globalThis.LDAExtractor.ensureSectionsLoaded(document, { maxMs: 800, pauseMs: 50 });
    return globalThis.LDAExtractor.extractProfile(document, c);
  }, ctx || {});
  await pg.close();
  return result;
}

console.log('Extractor — own profile');
const own = await extractFrom('https://www.linkedin.com/in/amara-okafor/', OWN_PROFILE);
await test('top card', () => {
  assert.equal(own.name, 'Amara Okafor');
  assert.match(own.headline, /^Localization Project Manager/);
  assert.equal(own.location, 'Lagos, Lagos State, Nigeria');
  assert.equal(own.connections, '500+');
  assert.equal(own.source.publicIdentifier, 'amara-okafor');
});
await test('detected as own profile', () => {
  assert.equal(own.ownership.isOwn, true, JSON.stringify(own.ownership));
  assert.equal(own.ownership.confidence, 'high');
});
await test('about (no duplicated screen-reader text)', () => {
  assert.match(own.about, /^I help publishers/);
  assert.equal(own.about.match(/I help publishers/g).length, 1);
});
await test('experience incl. grouped roles', () => {
  assert.equal(own.experience.length, 3, JSON.stringify(own.experience, null, 1));
  const [a, b, c] = own.experience;
  assert.equal(a.title, 'Senior Localization Project Manager');
  assert.equal(a.company, 'Kestrel Language Services');
  assert.equal(a.employmentType, 'Full-time');
  assert.equal(a.isCurrent, true);
  assert.equal(a.dateRange.start, 'Mar 2022');
  assert.equal(a.location, 'Lagos, Nigeria');
  assert.equal(a.workMode, 'Hybrid');
  assert.deepEqual(a.skills, ['Project Management', 'Vendor Management']);
  assert.match(a.description, /35%/);
  assert.equal(b.company, 'Brightway Media Group');
  assert.equal(b.title, 'Translation Coordinator');
  assert.equal(b.employmentType, 'Full-time');
  assert.equal(c.title, 'Junior Translator');
  assert.equal(c.dateRange.end, 'Dec 2019');
});
await test('education', () => {
  const e = own.education[0];
  assert.equal(e.school, 'University of Lagos');
  assert.equal(e.degree, 'Bachelor of Arts - BA');
  assert.equal(e.field, 'French Language and Literature');
  assert.equal(e.dateRange.start, '2013');
  assert.equal(e.activities, 'Debate club');
});
await test('skills (endorsement lines ignored)', () => {
  assert.deepEqual(own.skills, ['Localization', 'Project Management', 'Vendor Management', 'Translation']);
});
await test('featured', () => {
  assert.equal(own.featured[0].type, 'Article');
  assert.match(own.featured[0].title, /cut localization turnaround/);
});
await test('truncation warning for "Show all"', () => {
  assert.equal(own.meta.truncated.experience, 5);
  assert.ok(own.meta.warnings.some((w) => /^Experience/.test(w)));
});

console.log('Extractor — target profile');
const target = await extractFrom('https://www.linkedin.com/in/daniel-mensah-123/', TARGET_PROFILE, { syncedSlug: 'amara-okafor' });
await test('detected as target', () => {
  assert.equal(target.ownership.isOwn, false, JSON.stringify(target.ownership));
});
await test('signals: hiring + mutual connections', () => {
  assert.equal(target.signals.hiring, true);
  assert.equal(target.signals.openToWork, false);
  assert.equal(target.signals.mutualConnections.count, 8);
  assert.deepEqual(target.signals.mutualConnections.names, ['Chidi Eze', 'Funmi Bello']);
});
await test('activity post', () => {
  assert.equal(target.activity.length, 1);
  assert.match(target.activity[0].text, /^We just opened two/);
  assert.equal(target.activity[0].when, '1w');
  assert.equal(target.activity[0].url, 'https://www.linkedin.com/feed/update/urn:li:activity:123/');
});
await test('experience + derived current company', () => {
  assert.equal(target.experience.length, 2);
  assert.equal(target.currentCompany, 'Northwind Learning');
  assert.equal(target.experience[0].workMode, 'On-site');
});
await test('slug match makes it own even without owner controls', async () => {
  const p = await extractFrom('https://www.linkedin.com/in/daniel-mensah-123/', TARGET_PROFILE, { syncedSlug: 'Daniel-Mensah-123' });
  assert.equal(p.ownership.isOwn, true);
});

console.log('Extractor — details page merge');
const details = await extractFrom('https://www.linkedin.com/in/amara-okafor/details/skills/', OWN_DETAILS_SKILLS);
await test('details page extracts full list', () => {
  assert.equal(details.source.pageType, 'details');
  assert.equal(details.skills.length, 7);
  assert.equal(details.ownership.isOwn, true);
});
await test('mergeDetails keeps the longer list', () => {
  const merged = X.mergeDetails(own, details);
  assert.equal(merged.skills.length, 7);
  assert.equal(merged.experience.length, own.experience.length);
  assert.equal(JSON.stringify(merged.meta.mergedDetails), '["skills"]');
});
await test('parseProfileUrl', () => {
  assert.equal(X.parseProfileUrl('https://www.linkedin.com/in/j%C3%B6rg/').slug, 'jörg');
  assert.equal(X.parseProfileUrl('https://www.linkedin.com/in/x/overlay/contact-info/').pageType, 'profile');
  assert.equal(X.parseProfileUrl('https://www.linkedin.com/in/x/recent-activity/all/').pageType, 'other');
  assert.equal(X.parseProfileUrl('https://www.linkedin.com/feed/').isProfile, false);
  assert.equal(X.parseProfileUrl('https://evil.com/in/x/').isProfile, false);
});

console.log('Extractor — redesigned layout (no h1 / no sections / 2 mains)');
const redesign = await extractFrom('https://www.linkedin.com/in/amara-okafor/', OWN_PROFILE_REDESIGN);
await test('name found via tab title + matching element', () => {
  assert.equal(redesign.name, 'Amara Okafor');
  assert.match(redesign.headline, /^Localization Project Manager/);
  assert.equal(redesign.location, 'Lagos, Lagos State, Nigeria');
});
await test('sections found by heading without <section>/ids', () => {
  assert.match(redesign.about, /^I help publishers/);
  assert.equal(redesign.experience.length, 2, JSON.stringify(redesign.experience));
  assert.equal(redesign.experience[0].company, 'Kestrel Language Services');
  assert.equal(redesign.education[0].school, 'University of Lagos');
  assert.deepEqual([...redesign.skills], ['Localization', 'Project Management']);
  assert.equal(redesign.ownership.isOwn, true);
});
await test('diagnose() reports structure without personal text', async () => {
  const pg = await browser.newPage();
  await pg.route('https://www.linkedin.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: OWN_PROFILE_REDESIGN }));
  await pg.goto('https://www.linkedin.com/in/amara-okafor/');
  await pg.addScriptTag({ content: extractorSrc });
  const rep = await pg.evaluate(() => globalThis.LDAExtractor.diagnose(document));
  await pg.close();
  assert.equal(rep.counts.mains, 2);
  assert.equal(rep.counts.h1, 0);
  assert.equal(rep.title.hasName, true);
  assert.equal(rep.extracted.name, true);
  assert.equal(rep.extracted.experience, 2);
  assert.equal(rep.sections.experience.dateLines, 2);
  const json = JSON.stringify(rep);
  assert.ok(!/Amara|Okafor|Kestrel|Lagos/.test(json), 'report leaked personal text');
});

console.log('Extractor — 2026 live layout (divs only, chips, pronoun badge)');
const own26 = await extractFrom('https://www.linkedin.com/in/omotoler-onabanjo/', OWN_PROFILE_2026);
await test('own: headline is the real headline (not "He/Him"), location, pronouns, company + school chips', () => {
  assert.equal(own26.name, 'Omotola Onabanjo');
  assert.match(own26.headline, /^EN <> DE - IT - ES Translator/);
  assert.equal(own26.pronouns, 'He/Him');
  assert.equal(own26.location, 'Slough, England, United Kingdom');
  assert.equal(own26.currentCompany, 'Elite Languauge Craft');
  assert.equal(own26.currentSchool, 'University of Surrey, Guildford, UK');
  assert.equal(own26.ownership.isOwn, true);
});
await test('own: experience (grouped + single) from div layout', () => {
  assert.equal(own26.experience.length, 3, JSON.stringify(own26.experience, null, 1));
  const [a, b, c] = own26.experience;
  assert.equal(a.title, 'Senior Associate');
  assert.equal(a.company, 'Elite Languauge Craft');
  assert.equal(a.isCurrent, true);
  assert.equal(a.workMode, 'Remote');
  assert.equal(b.title, 'Project Management Specialist');
  assert.equal(b.company, 'Elite Languauge Craft');
  assert.match(b.description, /20%/);
  assert.equal(c.title, 'Freelance Translator & Subtitler');
  assert.equal(c.employmentType, 'Self-employed');
});
await test('own: education + skills from div layout', () => {
  assert.deepEqual(own26.education.map((e) => e.school), ['University of Surrey, Guildford, UK', 'University of Lagos']);
  assert.equal(own26.education[0].degree, 'Master of Arts - MA');
  assert.deepEqual([...own26.skills], ['Localization', 'Subtitling', 'Project Management', 'German']);
});
const pratik = await extractFrom('https://www.linkedin.com/in/pratik-vadara-bb9384218/', TARGET_PROFILE_2026, { syncedSlug: 'omotoler-onabanjo' });
await test('target: company from top-card chip + experience; degree badge ignored', () => {
  assert.equal(pratik.headline, 'Junior Project Manager');
  assert.equal(pratik.location, 'Noida, Uttar Pradesh, India');
  assert.equal(pratik.currentCompany, 'BIG Language Solutions');
  assert.equal(pratik.experience.length, 2);
  assert.equal(pratik.experience[0].company, 'BIG Language Solutions');
  assert.equal(pratik.education[0].degree, 'MBA');
  assert.equal(pratik.signals.mutualConnections.count, 57);
  assert.equal(pratik.ownership.isOwn, false);
});

console.log('Extractor — live layout from the diagnostic report (name in h2, aria-hidden separators only)');
const oct = await extractFrom('https://www.linkedin.com/in/kemi-adeyemi/', OWN_PROFILE_OCT26);
await test('top card from h2 name; headline, location, company + school', () => {
  assert.equal(oct.name, 'Kemi Adeyemi');
  assert.match(oct.headline, /^EN <> FR Translator/);
  assert.equal(oct.location, 'Reading, England, United Kingdom');
  assert.equal(oct.currentCompany, 'BrightLingo');
  assert.equal(oct.currentSchool, 'University of Reading');
  assert.equal(oct.ownership.isOwn, true);
});
await test('experience: 3 roles with company, dates, location, skills (separators no longer swallow the text)', () => {
  assert.equal(oct.experience.length, 3, JSON.stringify(oct.experience, null, 1));
  const [a, b] = oct.experience;
  assert.equal(a.title, 'Senior Associate');
  assert.equal(a.company, 'BrightLingo');
  assert.equal(a.employmentType, 'Full-time');
  assert.equal(a.dateRange.start, 'Jan 2025');
  assert.equal(a.isCurrent, true);
  assert.equal(a.workMode, 'Remote');
  assert.match(a.description, /30\+ clients/);
  assert.equal(b.company, 'Lingvatech');
  assert.equal(oct.meta.truncated.experience, 7);
});
await test('education, skills, featured, certifications, languages', () => {
  assert.deepEqual(oct.education.map((e) => e.school), ['University of Reading', 'University of Lagos']);
  assert.equal(oct.education[0].field, 'Translation and Localization Management');
  assert.ok(oct.skills.includes('Administrative Organization') && oct.skills.includes('Cross-Cultural Communication'), JSON.stringify(oct.skills));
  assert.equal(oct.featured.length, 2);
  assert.equal(oct.certifications[0].name, 'Crash Course in Localization');
  assert.equal(oct.languages.length, 2);
});
await test('activity posts read from cards (no <li>)', () => {
  assert.equal(oct.activity.length, 2, JSON.stringify(oct.activity));
  assert.match(oct.activity[0].text, /Crash Course in Localization/);
  assert.equal(oct.activity[0].when, '1w');
});

console.log('Extractor — company pages');
const coHome = await extractFrom('https://www.linkedin.com/company/northwind-learning/', COMPANY_HOME);
const coAbout = await extractFrom('https://www.linkedin.com/company/northwind-learning/about/', COMPANY_ABOUT);
const coJobs = await extractFrom('https://www.linkedin.com/company/northwind-learning/jobs/', COMPANY_JOBS);
await test('company home: top card, signals, post', () => {
  assert.equal(coHome.entityType, 'company');
  assert.equal(coHome.name, 'Northwind Learning');
  assert.match(coHome.tagline, /^Online courses/);
  assert.equal(coHome.industry, 'E-Learning Providers');
  assert.equal(coHome.headquarters, 'Lagos, Lagos State');
  assert.equal(coHome.followers, '12K');
  assert.equal(coHome.signals.mutualConnections.count, 12);
  assert.deepEqual([...coHome.signals.mutualConnections.names], ['Chidi Eze']);
  assert.equal(coHome.activity.length, 1, JSON.stringify(coHome.activity));
  assert.match(coHome.activity[0].text, /Igbo-language data science course/);
  assert.equal(coHome.activity[0].when, '3d');
  assert.equal(coHome.ownership.isOwn, false);
});
await test('company about: overview + details list', () => {
  assert.match(coAbout.about, /^Northwind Learning builds localized/);
  assert.equal(coAbout.companySize, '201-500 employees');
  assert.equal(coAbout.founded, '2018');
  assert.equal(coAbout.website, 'https://northwind.example');
  assert.deepEqual([...coAbout.specialties], ['Localization', 'Online Learning', 'Translation', 'Curriculum Design']);
});
await test('company jobs tab: job titles (deduped) + hiring', () => {
  assert.deepEqual(coJobs.jobs.map((j) => j.title), ['Localization Project Manager', 'Senior Localization Project Manager', 'Igbo Translator', 'Backend Engineer']);
  assert.equal(coJobs.signals.hiring, true);
  assert.equal(coJobs.signals.jobsCount, 4);
});
const company = X.mergeCompany(X.mergeCompany(coHome, coAbout), coJobs);
await test('mergeCompany combines tabs', () => {
  assert.equal(company.activity.length, 1);
  assert.equal(company.founded, '2018');
  assert.equal(company.jobs.length, 4);
  assert.equal(JSON.stringify(company.meta.tabsRead), '["home","about","jobs"]');
  assert.ok(!company.meta.warnings.some((w) => /about/i.test(w)), JSON.stringify(company.meta.warnings));
});
await test('company About tab, current layout: name, tagline, info line, overview, details, connections', async () => {
  const c = await extractFrom('https://www.linkedin.com/company/polyglot/about/', COMPANY_ABOUT_OCT26);
  assert.equal(c.name, 'Polyglot Interpreters and Translators');
  assert.equal(c.tagline, 'The World’s Voice. Interpreted.');
  assert.equal(c.industry, 'Translation and Localization');
  assert.equal(c.headquarters, 'Winter Haven, Florida');
  assert.equal(c.followers, '74K');
  assert.equal(c.companySize, '51-200 employees');
  assert.equal(c.founded, '2017');
  assert.equal(c.website, 'https://www.polyglot.example');
  assert.ok(c.specialties.includes('Medical Interpretation') && c.specialties.includes('Schedulers'), JSON.stringify(c.specialties));
  assert.match(c.about, /^Polyglot Interpreters and Translators is a language service/);
  assert.match(c.about, /Our Mission/);
  assert.match(c.about, /200\+ languages/);
  assert.ok(!/Website|Founded/.test(c.about), c.about);
  assert.equal(c.signals.mutualConnections.count, 2);
});
await test('parseProfileUrl: company pages', () => {
  const c = X.parseProfileUrl('https://www.linkedin.com/company/northwind-learning/about/');
  assert.equal(c.entityType, 'company');
  assert.equal(c.subpage, 'about');
  assert.equal(c.pageType, 'profile');
  assert.equal(X.parseProfileUrl('https://www.linkedin.com/company/x/admin/').pageType, 'other');
  assert.equal(X.parseProfileUrl('https://www.linkedin.com/in/x/').entityType, 'person');
});

await browser.close();

console.log('Hook engine');
const now = new Date('2026-10-11T00:00:00Z');
await test('ranks shared company, hiring, recent post, result', () => {
  const { all, top } = rankHooks(own, target, { goal: 'opportunity', now });
  const types = all.map((h) => h.type);
  for (const t of ['shared_company', 'hiring', 'recent_post', 'relevant_result', 'skill_overlap', 'mutual', 'shared_location', 'new_role', 'featured', 'about_statement']) {
    assert.ok(types.includes(t), `missing ${t}: ${types.join(',')}`);
  }
  assert.equal(top.length, 3);
  assert.equal(new Set(top.map((h) => h.type)).size, 3);
  const company = all.find((h) => h.type === 'shared_company');
  assert.equal(company.facts.company, 'Brightway Media Group');
  assert.equal(company.facts.overlapped, true); // 2019–2022 overlaps 2019–2026
});
await test('goal changes ranking', () => {
  const warm = rankHooks(own, target, { goal: 'warm', now }).top.map((h) => h.type);
  const opp = rankHooks(own, target, { goal: 'opportunity', now }).top.map((h) => h.type);
  assert.ok(opp.includes('hiring'));
  assert.notDeepEqual(warm, opp);
});

console.log('Generation');
await test('local variants use only real facts and respect note length', () => {
  const { top } = rankHooks(own, target, { goal: 'warm', now });
  const dm = generateLocal({ user: own, target, hooks: top, goal: 'warm', tone: 'friendly', length: 'dm' });
  assert.equal(dm.length, 3);
  for (const v of dm) {
    assert.match(v.message, /^Hi Daniel,/);
    assert.ok(!/undefined|null|\[object/.test(v.message), v.message);
    assert.ok(v.why);
  }
  const notes = generateLocal({ user: own, target, hooks: top, goal: 'warm', tone: 'casual', length: 'note' });
  for (const v of notes) assert.ok(v.message.length <= 300, `${v.message.length}: ${v.message}`);
  console.log('\n    sample:\n    ' + dm[0].message.split('\n').join('\n    ') + '\n');
});
await test('prompt contains hooks + rules, excludes URLs', () => {
  const { top } = rankHooks(own, target, { goal: 'value', now });
  const p = buildPrompt({ user: own, target, hooks: top, goal: 'value', tone: 'direct', length: 'note' });
  assert.match(p.system, /NEVER invent facts/);
  assert.match(p.user, /Value-First/);
  assert.match(p.user, /300 characters/);
  assert.ok(!p.user.includes('linkedin.com/in/'), 'profile URLs should not be sent');
  assert.equal(p.maxChars, 300);
});
await test('parseVariants handles schema JSON, fenced JSON and bad output', () => {
  const j = { variants: [{ angle: 'a', message: 'Hi', why: 'w', hooksUsed: ['x'] }] };
  assert.equal(parseVariants(JSON.stringify(j))[0].message, 'Hi');
  assert.equal(parseVariants('Sure!\n```json\n' + JSON.stringify(j) + '\n```')[0].angle, 'a');
  assert.throws(() => parseVariants('no json here'));
});

console.log('Company hooks + research');
await test('company hooks: alumni-free, hiring, post, connections, location, fit', () => {
  const { all } = rankHooks(own, company, { goal: 'interview', now });
  const types = all.map((h) => h.type);
  for (const t of ['recent_post', 'hiring', 'mutual', 'shared_location', 'hiring_domain', 'complementary', 'about_statement']) assert.ok(types.includes(t), `missing ${t}: ${types}`);
  const dom = all.find((h) => h.type === 'hiring_domain');
  assert.equal(dom.facts.domain, 'Localization & Language');
  assert.equal(dom.facts.source, 'page');
});
await test('alumni hook when user worked at the company', () => {
  const brightway = { ...company, name: 'Brightway Media Group', jobs: [] };
  const { top } = rankHooks(own, brightway, { goal: 'warm', now });
  assert.equal(top[0].type, 'alumni');
});
await test('domainsFromJobTitles groups and ranks', () => {
  const d = domainsFromJobTitles(['Localization PM', 'Translator', 'Backend Engineer', 'Localization Specialist']);
  assert.equal(d[0].domain, 'Localization & Language');
  assert.equal(d[0].count, 3);
  assert.equal(d[1].domain, 'Engineering');
});
const research = normalizeResearch({
  summary: 'Edtech company building localized courses.',
  hiringFocus: [{ domain: 'Engineering', roles: ['Backend Engineer'] }, { domain: 'Localization & Language', roles: ['Localization Project Manager'], evidence: 'Careers page' }],
  talentSources: [{ source: 'Brightway Media Group', evidence: 'Several managers came from there' }],
  recentNews: [{ headline: 'Northwind raises Series B to expand into 5 new languages', date: 'Aug 2026' }],
  interviewAngles: ['Vendor management at scale'],
  confidence: 'HIGH',
  bogus: 1,
}, [{ title: 'northwind.example', uri: 'https://northwind.example/careers' }]);
await test('normalizeResearch shape', () => {
  assert.equal(research.confidence, 'high');
  assert.equal(research.hiringFocus[1].source, 'web');
  assert.equal(research.sources.length, 1);
  assert.ok(!('bogus' in research));
});
await test('matchDomains prefers the user’s field', () => {
  const m = matchDomains(own, research.hiringFocus);
  assert.equal(m[0].domain, 'Localization & Language');
});
await test('research hooks for a PERSON target (their current company)', () => {
  const { all, top } = rankHooks(own, target, { goal: 'interview', now, research });
  const types = all.map((h) => h.type);
  assert.ok(types.includes('hiring_domain') && types.includes('company_news') && types.includes('talent_source'), types.join(','));
  assert.equal(top[0].type, 'hiring_domain');
  assert.equal(all.find((h) => h.type === 'hiring_domain').facts.company, 'Northwind Learning');
});
await test('researchFromPage uses job titles', () => {
  const r = researchFromPage(company);
  assert.equal(r.hiringFocus[0].domain, 'Localization & Language');
  assert.equal(r.hiringFocus[0].source, 'page');
});
await test('prompt: interview goal, research, company recipient, regenerate-one', () => {
  const { top } = rankHooks(own, company, { goal: 'interview', now, research });
  const p = buildPrompt({ user: own, target: company, hooks: top, goal: 'interview', tone: 'professional', length: 'dm', note: 'Looking for a PM role in edtech', recipientName: 'Ngozi Ade', research, matchedDomains: matchDomains(own, research.hiringFocus), count: 1, avoid: ['old draft text'] });
  assert.match(p.user, /Interview Request/);
  assert.match(p.user, /Write 1 new LinkedIn message/);
  assert.match(p.user, /old draft text/);
  assert.match(p.user, /"RESEARCH"/);
  assert.match(p.user, /"matchedHiringDomains"/);
  assert.match(p.user, /"RECIPIENT_PERSON"/);
  assert.match(p.user, /"type": "company"/);
  assert.match(p.user, /Looking for a PM role in edtech/);
});
await test('local drafts for a company (named recipient + team fallback)', () => {
  const { top } = rankHooks(own, company, { goal: 'interview', now });
  const named = generateLocal({ user: own, target: company, hooks: top, goal: 'interview', recipientName: 'Ngozi Ade' });
  assert.match(named[0].message, /^Hi Ngozi,/);
  const team = generateLocal({ user: own, target: company, hooks: top, goal: 'interview' });
  assert.match(team[0].message, /^Hi Northwind Learning team,/);
  for (const v of team) assert.ok(!/undefined|null/.test(v.message), v.message);
  console.log('\n    company sample:\n    ' + team[0].message.split('\n').join('\n    ') + '\n');
});
await test('local regenerate (seed) produces a different draft', () => {
  const { top } = rankHooks(own, target, { goal: 'warm', now });
  const a = generateLocal({ user: own, target, hooks: top, seed: 0 })[0].message;
  const b = generateLocal({ user: own, target, hooks: top, seed: 1 })[0].message;
  assert.notEqual(a, b);
});

await test('application prompt enforces the 700-character limit; shorten prompt keeps facts', () => {
  assert.equal(MAX_APPLICATION_CHARS, 700);
  const p = buildApplicationPrompt({ user: own, company, research: null });
  assert.match(p.system, /AT MOST 700 characters/);
  assert.match(p.system, /LinkedIn's limit is 750/);
  const sp = buildShortenPrompt('x'.repeat(900));
  assert.match(sp.user, /AT MOST 700 characters in total \(it is 900 now\)/);
  assert.match(sp.user, /Do not add any new facts/);
});

console.log('Fact-check');
const corpusAll = buildCorpus(own, target, 'Looking for a PM role');
await test('local drafts have no flags', () => {
  const { top } = rankHooks(own, target, { goal: 'opportunity', now });
  for (const v of generateLocal({ user: own, target, hooks: top, goal: 'opportunity' })) assert.deepEqual(factCheck(v.message, corpusAll), [], v.message);
});
await test('invented names and numbers are flagged', () => {
  const msg = 'Hi Daniel,\n\nLoved your post. At Google I grew revenue 3x and cut costs by 35%. Would a 15-minute chat work? Sarah Lee suggested I reach out.\n\nAmara';
  const flags = factCheck(msg, corpusAll).map((f) => f.term);
  assert.deepEqual(flags, ['Google', '3x', 'Sarah Lee'].sort((a, b) => msg.indexOf(a) - msg.indexOf(b)));
  const seg = segments(msg, factCheck(msg, corpusAll));
  assert.equal(seg.filter((x) => x.flagged).length, 3);
});

console.log('Identity (Settings name / username)');
await test('parseLinkedInId accepts URLs, paths and bare usernames', () => {
  assert.equal(parseLinkedInId('https://www.linkedin.com/in/Amara-Okafor-12/'), 'amara-okafor-12');
  assert.equal(parseLinkedInId('linkedin.com/in/amara-okafor?trk=x'), 'amara-okafor');
  assert.equal(parseLinkedInId('/in/j%C3%B6rg/'), 'jörg');
  assert.equal(parseLinkedInId('amara-okafor'), 'amara-okafor');
  assert.equal(parseLinkedInId('not a url'), '');
  assert.equal(parseLinkedInId('https://example.com/foo/bar'), '');
});
await test('namesMatch tolerates accents, middle names, suffixes', () => {
  assert.ok(namesMatch('Amara Okafor', 'amara okafor'));
  assert.ok(namesMatch('Amára Okafor, MBA', 'Amara Okafor'));
  assert.ok(namesMatch('Amara Chiamaka Okafor (She/Her)', 'Amara Okafor'));
  assert.ok(!namesMatch('Amara Obi', 'Amara Okafor'));
  assert.ok(!namesMatch('Amara', 'Amara Okafor'));
  assert.ok(!namesMatch('Chiamaka Amara Okafor', 'Amara Okafor')); // first names differ
});
await test('checkOwnership: username exact, name match, viewer buttons, setup', () => {
  const me = { name: 'Amara Okafor', linkedinId: '' };
  assert.equal(checkOwnership({ slug: 'x', pageName: 'Amara Okafor' }, { name: '', linkedinId: '' }).needsSetup, true);
  assert.equal(checkOwnership({ slug: 'amara-okafor', pageName: 'Someone Else' }, { ...me, linkedinId: 'amara-okafor' }).mine, true);
  assert.equal(checkOwnership({ slug: 'other', pageName: 'Amara Okafor' }, { ...me, linkedinId: 'amara-okafor' }).mine, false);
  assert.equal(checkOwnership({ slug: 'a', pageName: 'Amara Okafor', viewerSignals: [] }, me).mine, true);
  const twin = checkOwnership({ slug: 'a', pageName: 'Amara Okafor', viewerSignals: ['connect', 'message'] }, me);
  assert.equal(twin.mine, false);
  assert.match(twin.reason, /someone else/);
  assert.match(checkOwnership({ slug: 'a', pageName: 'Daniel Mensah' }, me).reason, /Daniel Mensah/);
  assert.equal(checkOwnership({ slug: 'a', pageName: '', ownerSignals: ['open-to'] }, me).mine, true);
  assert.equal(checkOwnership({ slug: 'a', pageName: '', ownerSignals: [] }, me).mine, false);
});

console.log('Gemini model selection');
await test('ranks Flash first, newest version, stable before preview; skips retired', () => {
  const ids = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-preview-05-2026', 'gemini-3.5-flash-lite', 'gemini-2.0-flash-001', 'gemini-3.1-pro-preview'];
  assert.equal(rankGeminiModels(ids)[0].id, 'gemini-3.5-flash');
  assert.equal(pickGeminiModel(ids, ['gemini-3.5-flash']), 'gemini-3.5-flash-preview-05-2026');
  assert.equal(pickGeminiModel([...ids, 'gemini-flash-latest']), 'gemini-flash-latest');
  assert.equal(pickGeminiModel(['gemini-3.1-pro-preview', 'gemini-2.5-flash-lite']), 'gemini-2.5-flash-lite'); // free tier: Flash over Pro
  assert.equal(pickGeminiModel([]), '');
});
await test('isModelUnavailable detects 404 / retired model errors', () => {
  assert.ok(isModelUnavailable(new LLMError('x', { status: 404, provider: 'gemini' })));
  assert.ok(isModelUnavailable(new LLMError('models/gemini-2.5-flash is no longer available', { status: 400, provider: 'gemini' })));
  assert.ok(!isModelUnavailable(new LLMError('rate limit', { status: 429, provider: 'gemini' })));
  assert.ok(!isModelUnavailable(new LLMError('x', { status: 404, provider: 'openai' })));
});

await test('pingGemini times out quickly with a clear, flagged error', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (_url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  try {
    const started = Date.now();
    await assert.rejects(pingGemini({ apiKey: 'k', model: 'm', timeoutMs: 50 }), (e) => e.timeout === true && /No answer within/.test(e.message));
    assert.ok(Date.now() - started < 1000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('classifyQuota: per-minute vs daily vs no free quota, retry delay', () => {
  const det = (quotaId, quotaValue, delay) => ({ error: { message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId, quotaValue }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] } });
  assert.deepEqual(classifyQuota(det('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '10', '37s')), { quota: 'minute', retryAfter: 37 });
  assert.equal(classifyQuota(det('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '20', '3s')).quota, 'daily');
  assert.equal(classifyQuota(det('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '0', '3s')).quota, 'none');
  assert.equal(classifyQuota({ error: { message: 'Rate limit reached for model `x` on requests per day (RPD). Please try again in 7m12.5s' } }).quota, 'daily');
  const h = { get: (k) => (k === 'retry-after' ? '12' : null) };
  assert.deepEqual(classifyQuota({ error: { message: 'Rate limit reached on tokens per minute (TPM)' } }, h), { quota: 'minute', retryAfter: 12 });
  assert.ok(isModelQuotaExhausted(new LLMError('x', { status: 429, quota: 'daily' })));
  assert.ok(!isModelQuotaExhausted(new LLMError('x', { status: 429, quota: 'minute' })));
});
await test('Groq models: chat models only, strong ones first', () => {
  const ids = ['whisper-large-v3', 'llama-3.1-8b-instant', 'groq/compound', 'openai/gpt-oss-120b', 'meta-llama/llama-guard-4-12b', 'llama-3.3-70b-versatile', 'playai-tts'];
  assert.deepEqual(rankGroqModels(ids).map((m) => m.id), ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);
  assert.equal(pickGroqModel(ids, ['openai/gpt-oss-120b']), 'llama-3.3-70b-versatile');
  assert.equal(pickGroqModel([...ids, 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'], ['openai/gpt-oss-120b']), 'openai/gpt-oss-20b');
});

await test('parseVariants: reasoning <think> tags, prose, alternate keys (qwen-style replies)', () => {
  const qwen = '<think>The user wants {three} drafts. Let me plan {a} and {b}.</think>\n\nHere you go:\n{"variants":[{"angle":"A","message":"Hi Daniel, one.","why":"w"},{"angle":"B","message":"Hi Daniel, two.","why":"w"}]}';
  assert.deepEqual(parseVariants(qwen).map((v) => v.message), ['Hi Daniel, one.', 'Hi Daniel, two.']);
  assert.equal(parseVariants('{"drafts":[{"title":"T","text":"Hello there"}]}')[0].message, 'Hello there');
  assert.equal(parseVariants('{"messages":["Plain string draft"]}')[0].message, 'Plain string draft');
  assert.throws(() => parseVariants('<think>{"variants": []}</think> sorry'), (e) => e.format === true);
});
await test('Tavily 432 → clear plan/usage-limit message', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: { error: "This request exceeds your plan's set usage limit." } }), { status: 432 });
  try {
    await assert.rejects(requestJSON('https://api.tavily.com/search', {}, { q: 1 }, { provider: 'tavily', label: 'Tavily' }), (e) => /usage limit is reached/.test(e.message) && e.status === 429);
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log('Updater (GitHub: SurdsoN/linkedinDM)');
{
  const root = path.join(here, '..');
  const manifest = JSON.parse(readFile(path.join(root, 'manifest.json'), 'utf8'));
  // Pretend the installed version is older than the package.
  globalThis.chrome = { runtime: { getManifest: () => ({ ...manifest, version: '0.5.2' }) } };
  execFileSync('sh', [path.join(root, 'scripts/package.sh')], { stdio: 'ignore' });
  const zipPath = path.join(root, 'dist', `linkedin-dm-architect-v${manifest.version}.zip`);
  const zipBuf = readFile(zipPath);
  const ab = zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength);
  const sha = createHash('sha256').update(zipBuf).digest('hex');
  const versionJson = { name: manifest.name, version: manifest.version, released: '2026-10-11', zip: `releases/linkedin-dm-architect-v${manifest.version}.zip`, sha256: sha, notes: ['A', 'B'] };
  const fakeFetch = (overrides = {}) => async (url) => {
    if (url.includes('version.json')) return new Response(JSON.stringify({ ...versionJson, ...overrides }), { status: 200 });
    if (url.endsWith('.zip')) return new Response(overrides.zipBody || ab, { status: 200 });
    return new Response('nope', { status: 404 });
  };
  await test('compareVersions', () => {
    assert.equal(compareVersions('0.6.0', '0.5.2'), 1);
    assert.equal(compareVersions('0.5.10', '0.5.9'), 1);
    assert.equal(compareVersions('1.0', '1.0.0'), 0);
    assert.equal(compareVersions('0.4.4', '0.5.0'), -1);
  });
  await test('unzip reads the real release zip (deflate)', async () => {
    const files = await unzip(ab);
    assert.ok(files.has('manifest.json') && files.has('src/sidepanel/sidepanel.js') && files.has('src/updater/updater.html'));
    assert.equal(JSON.parse(new TextDecoder().decode(files.get('manifest.json'))).version, manifest.version);
  });
  await test('checkForUpdate: newer version from version.json; zip URL on raw.githubusercontent', async () => {
    const info = await checkForUpdate({ fetchImpl: fakeFetch() });
    assert.equal(info.newer, true);
    assert.equal(info.latest, manifest.version);
    assert.match(info.zipUrl, /^https:\/\/raw\.githubusercontent\.com\/SurdsoN\/linkedinDM\/main\/releases\//);
    assert.deepEqual(info.notes, ['A', 'B']);
  });
  await test('downloadUpdate verifies checksum, name and version; files limited to the extension', async () => {
    const info = await checkForUpdate({ fetchImpl: fakeFetch() });
    const { files } = await downloadUpdate(info, { fetchImpl: fakeFetch() });
    assert.ok(files.has('manifest.json') && files.has('src/background/service-worker.js'));
    assert.ok([...files.keys()].every((k) => /^(manifest\.json|README\.md|CHANGELOG\.md|icons\/|src\/)/.test(k)));
    await assert.rejects(downloadUpdate({ ...info, sha256: 'ab'.repeat(32) }, { fetchImpl: fakeFetch() }), /integrity check/);
    await assert.rejects(downloadUpdate({ ...info, latest: '9.9.9' }, { fetchImpl: fakeFetch() }), /Version mismatch/);
    globalThis.chrome.runtime.getManifest = () => ({ ...manifest, name: 'Other Extension', version: '0.5.2' });
    await assert.rejects(downloadUpdate(info, { fetchImpl: fakeFetch() }), /This update is for/);
    globalThis.chrome.runtime.getManifest = () => ({ ...manifest, version: '0.5.2' });
  });
  await test('downloadUpdate rejects unsafe paths', async () => {
    const evil = path.join(os.tmpdir(), 'lda-evil.zip');
    execFileSync('python3', ['-c', `import zipfile;z=zipfile.ZipFile(${JSON.stringify(evil)},'w');z.writestr('../evil.js','x');z.writestr('manifest.json','{}');z.close()`]);
    const eb = readFile(evil);
    const info = await checkForUpdate({ fetchImpl: fakeFetch() });
    await assert.rejects(downloadUpdate({ ...info, sha256: '' }, { fetchImpl: fakeFetch({ zipBody: eb.buffer.slice(eb.byteOffset, eb.byteOffset + eb.byteLength) }) }), /Unsafe path/);
  });
  delete globalThis.chrome;
}

console.log('Favourites');
await test('template strips recipient name/company and refills for someone else', () => {
  const tpl = toTemplate('Hi Daniel,\n\nDaniel Mensah, I saw Northwind Learning is hiring.', target);
  assert.equal(tpl, 'Hi {{firstName}},\n\n{{name}}, I saw {{company}} is hiring.');
  assert.ok(!tpl.includes('Daniel'));
  const other = { entityType: 'person', name: 'Ada Obi', currentCompany: 'Acme' };
  assert.equal(fillTemplate(tpl, other), 'Hi Ada,\n\nAda Obi, I saw Acme is hiring.');
  assert.equal(fillTemplate('Hi {{firstName}}', company), 'Hi Northwind Learning team');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
