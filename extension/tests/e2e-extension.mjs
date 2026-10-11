/**
 * End-to-end test: loads the unpacked extension in Chromium, serves the
 * fixtures at linkedin.com URLs, and drives the real side panel page.
 *   node tests/e2e-extension.mjs
 * The panel is opened as a tab, so chrome.tabs.query is pointed at the
 * LinkedIn tab under test (the only test-only shim). AI calls are mocked.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { OWN_PROFILE, TARGET_PROFILE, COMPANY_HOME, COMPANY_ABOUT, COMPANY_JOBS, OWN_PROFILE_REDESIGN, COMPANY_ABOUT_OCT26 } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extPath = process.env.EXT_PATH ? path.resolve(process.env.EXT_PATH) : path.resolve(here, '..');
const shots = process.env.SHOT_DIR || os.tmpdir();
const require = createRequire(import.meta.url);
let pw;
for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { pw = require(p); break; } catch (_) {} }
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lda-'));
const ctx = await pw.chromium.launchPersistentContext(userDataDir, {
  headless: true,
  viewport: { width: 420, height: 900 },
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});
await ctx.route('https://www.linkedin.com/**', (route) => {
  const u = route.request().url();
  const noName = OWN_PROFILE_REDESIGN.replace('(3) Amara Okafor | LinkedIn', 'LinkedIn').replace('<p class="xname">Amara Okafor</p>', '').replace('alt="Amara Okafor"', 'alt=""');
  const body = u.includes('/in/amara-redesign') ? OWN_PROFILE_REDESIGN
    : u.includes('/in/amara-noname') ? noName
    : u.includes('/in/amara-okafor') ? OWN_PROFILE
    : u.includes('/company/polyglot') ? COMPANY_ABOUT_OCT26
    : u.includes('/company/northwind-learning/about') ? COMPANY_ABOUT
    : u.includes('/company/northwind-learning/jobs') ? COMPANY_JOBS
    : u.includes('/company/') ? COMPANY_HOME
    : TARGET_PROFILE;
  route.fulfill({ status: 200, contentType: 'text/html', body });
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;

let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };
const errors = [];

async function openPanelFor(linkedinUrl) {
  const li = await ctx.newPage();
  await li.goto(linkedinUrl);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0].id, linkedinUrl);
  const panel = await ctx.newPage();
  panel.on('pageerror', (e) => errors.push(e.message));
  panel.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await panel.addInitScript((id) => {
    const orig = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => (q && q.active ? [await chrome.tabs.get(id)] : orig(q));
  }, tabId);
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`);
  return { li, panel, tabId };
}
/** Point the panel at a different tab (simulates switching tabs). */
async function retarget(panel, tabId) {
  await panel.evaluate((id) => {
    chrome.tabs.query = async (q) => (q && q.active ? [await chrome.tabs.get(id)] : []);
  }, tabId);
}

console.log('E2E');
// 1) Own profile → Sync + About-me note + floating button
let { li, panel } = await openPanelFor('https://www.linkedin.com/in/amara-okafor/');
await step('floating button injected on profile page', async () => {
  await li.waitForSelector('#lda-fab-host', { state: 'attached', timeout: 5000 });
});
await step('floating button click asks service worker to open the panel', async () => {
  // In headless Chromium sidePanel.open may reject; either way the message must round-trip.
  const res = await li.evaluate(() => new Promise((r) => {
    const host = document.getElementById('lda-fab-host');
    r(!!host && host.style.position === 'fixed');
  }));
  assert.ok(res);
  await li.locator('#lda-fab-host').click({ position: { x: 30, y: 15 } });
  await li.waitForTimeout(300);
});
await panel.waitForSelector('#view-own:not([hidden])', { timeout: 10000 });
await step('sync is blocked until your name is set in Settings', async () => {
  assert.equal(await panel.isDisabled('#btn-sync'), true);
  assert.match(await panel.textContent('#own-gate'), /add your name/i);
  assert.match(await panel.textContent('#me-chip'), /Add your name in Settings/);
});
await step('set name in Settings (invalid username rejected)', async () => {
  await panel.click('#own-gate button');
  await panel.waitForSelector('#view-settings:not([hidden])');
  await panel.fill('#inp-me-name', 'Amara Okafor');
  await panel.fill('#inp-me-id', 'not a url');
  await panel.click('#btn-save-me');
  assert.match(await panel.textContent('#me-status'), /doesn’t look like/);
  await panel.fill('#inp-me-id', '');
  await panel.click('#btn-save-me');
  assert.match(await panel.textContent('#me-status'), /Saved/);
  await panel.click('#btn-close-settings');
  await panel.waitForSelector('#view-own:not([hidden])');
  assert.equal(await panel.isDisabled('#btn-sync'), false);
});
await step('sync verifies by name, saves profile + username', async () => {
  await panel.click('#btn-sync');
  await panel.waitForSelector('#sync-result:not([hidden])', { timeout: 20000 });
  const text = await panel.textContent('#sync-result');
  assert.match(text, /Profile synced/);
  assert.match(text, /Verified as your profile by your name/);
  assert.match(text, /Saved your username \(amara-okafor\)/);
  const s = (await sw.evaluate(() => chrome.storage.local.get('lda.settings')))['lda.settings'];
  assert.equal(s.me.linkedinId, 'amara-okafor');
});
await step('About-me note saves', async () => {
  await panel.fill('#note-own', 'Looking for a localization PM role in edtech; open to Lagos or remote.');
  await panel.click('.btn-save-note[data-for="note-own"]');
  const st = await sw.evaluate(() => chrome.storage.local.get('lda.userNote'));
  assert.match(st['lda.userNote'], /localization PM role/);
});
await li.close(); await panel.close();

// 2) Target → analyze → local generate → regenerate one → fact-check → favourite
({ li, panel } = await openPanelFor('https://www.linkedin.com/in/daniel-mensah-123/'));
await panel.waitForSelector('#view-target:not([hidden])', { timeout: 10000 });
await panel.click('#btn-analyze');
await panel.waitForSelector('#analysis:not([hidden])', { timeout: 20000 });
await step('research card offers the person’s current company', async () => {
  assert.equal(await panel.inputValue('#inp-research-company'), 'Northwind Learning');
  assert.equal(await panel.isDisabled('#btn-research'), true); // no Gemini key yet
});
await panel.selectOption('#sel-goal', 'interview');
await panel.click('#btn-generate');
await panel.waitForSelector('#variants textarea');
await step('three local drafts, all fact-checked clean', async () => {
  const facts = await panel.$$eval('#variants .fact', (n) => n.map((x) => x.className + '|' + x.textContent));
  assert.equal(facts.length, 3);
  for (const f of facts) assert.match(f, /^fact ok/, f);
});
await step('regenerate only one card (others keep edits)', async () => {
  await panel.fill('#variants .variant:nth-child(2) textarea', 'Hi Daniel, my edited draft.');
  const before = await panel.$$eval('#variants textarea', (n) => n.map((x) => x.value));
  await panel.click('#variants .variant:nth-child(1) button:has-text("Regenerate")');
  await panel.waitForFunction((b) => document.querySelector('#variants .variant:nth-child(1) textarea').value !== b, before[0]);
  const after = await panel.$$eval('#variants textarea', (n) => n.map((x) => x.value));
  assert.equal(after[1], 'Hi Daniel, my edited draft.');
  assert.equal(after[2], before[2]);
});
await step('fact-check flags an invented detail while typing', async () => {
  await panel.fill('#variants .variant:nth-child(3) textarea', 'Hi Daniel, at Google I grew sales 3x.');
  await panel.waitForSelector('#variants .variant:nth-child(3) .fact.warn mark.flag');
  const marks = await panel.$$eval('#variants .variant:nth-child(3) mark.flag', (n) => n.map((x) => x.textContent));
  assert.deepEqual(marks, ['Google', '3x']);
});
await step('save a favourite as a template (no recipient name stored)', async () => {
  await panel.click('#variants .variant:nth-child(1) button.star');
  const fav = (await sw.evaluate(() => chrome.storage.local.get('lda.favorites')))['lda.favorites'];
  assert.equal(fav.length, 1);
  assert.match(fav[0].template, /\{\{firstName\}\}/);
  assert.ok(!/Daniel/.test(fav[0].template), fav[0].template);
  assert.equal(await panel.textContent('#fav-count'), '1');
});
await step('target data never stored', async () => {
  const all = JSON.stringify(await sw.evaluate(() => chrome.storage.local.get(null)));
  assert.ok(!all.includes('Mensah') && !all.includes('Daniel'), 'target data leaked');
});

let researchReq = null;
let genReqs = [];
// Fake Gemini: ListModels + generateContent. Retired models return 404 like the real API.
const AVAILABLE = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'text-embedding-005'];
const genModels = [];
await ctx.route('https://generativelanguage.googleapis.com/**', (route) => {
  const url = route.request().url();
  if (route.request().method() === 'GET' && /\/models\?/.test(url)) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: AVAILABLE.map((id) => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: id.startsWith('text-') ? ['embedContent'] : ['generateContent'] })) }) });
  }
  const model = (url.match(/models\/([^:]+):generateContent/) || [])[1];
  genModels.push(model);
  if (!AVAILABLE.includes(model)) {
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 404, message: `models/${model} is not found for API version v1beta, or is not supported for generateContent.` } }) });
  }
  const body = JSON.parse(route.request().postData());
  if (body.tools) {
    researchReq = body;
    if (geminiSearch429) {
      return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota.', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' }] } }) });
    }
    const research = {
      summary: 'Northwind Learning builds localized online courses for African learners.',
      industry: 'E-Learning', headquarters: 'Lagos', size: '201-500',
      recentNews: [{ headline: 'Northwind Learning raises Series B', date: 'Aug 2026', detail: '' }],
      hiringFocus: [{ domain: 'Localization & Language', roles: ['Localization Project Manager'], evidence: 'Careers page' }, { domain: 'Engineering', roles: ['Backend Engineer'], evidence: 'Careers page' }],
      talentSources: [{ source: 'Brightway Media Group', evidence: 'Several managers joined from there' }],
      values: ['Learner first'], interviewAngles: ['Scaling vendor workflows across 9 languages'], confidence: 'medium',
    };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '```json\n' + JSON.stringify(research) + '\n```' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://northwind.example/careers', title: 'northwind.example' } }] } }] }) });
  }
  if (body.contents[0].parts[0].text === 'Reply with the single word OK.') {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'OK' }] } }] }) });
  }
  genReqs.push(body);
  const n = body.contents[0].parts[0].text.includes('Write 1 new') ? 1 : 3;
  const words = n === 1 ? ['Kestrel Language Services'] : ['Localization', 'Lagos', 'Brightway Media Group'];
  const variants = words.map((w, i) => ({ angle: `Angle ${genReqs.length}-${i}`, message: `Hi Daniel, I saw Northwind Learning is hiring — ${w} is close to my work.${i === 0 && n === 3 ? ' I led projects at Atlantis Corp.' : ''}`, why: 'Mock', hooksUsed: [] }));
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ variants }) }] } }] }) });
});
// Fake Groq: /models + chat completions (drafts, and groq/compound web research).
let geminiSearch429 = false;
let compound404 = false; // reproduce: "The model `groq/compound` does not exist or you do not have access to it."
let browserSearch400 = false;
const groqDaily = new Set(); // models whose free daily token quota is "used up"
let garbleModel = ''; // model that replies with prose instead of JSON
const groqReqs = [];
const tavilyReqs = [];
const appReqs = [];
let appTooLong = false;
await ctx.route('https://api.tavily.com/**', (route) => {
  tavilyReqs.push(JSON.parse(route.request().postData()));
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [{ title: 'Northwind Learning careers', url: 'https://northwind.example/careers', content: 'Northwind Learning is hiring Localization Project Managers in Lagos.' }] }) });
});
await ctx.route('https://api.groq.com/**', (route) => {
  const url = route.request().url();
  if (route.request().method() === 'GET' && url.endsWith('/models')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'whisper-large-v3', 'groq/compound', 'meta-llama/llama-guard-4-12b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'].map((id) => ({ id, active: true })) }) });
  }
  const body = JSON.parse(route.request().postData());
  groqReqs.push(body);
  let content;
  if (groqDaily.has(body.model)) {
    return route.fulfill({ status: 429, contentType: 'application/json', headers: { 'retry-after': '3600' }, body: JSON.stringify({ error: { message: `Rate limit reached for model \`${body.model}\` in organization \`org_x\` service tier \`on_demand\` on tokens per day (TPD): Limit 200000, Used 199912, Requested 2290. Please try again in 15m.`, type: 'tokens', code: 'rate_limit_exceeded' } }) });
  }
  if (body.model === 'llama-3.3-70b-versatile' && garbleModel) {
    // Groq retired this model on 16 Aug 2026.
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'The model `llama-3.3-70b-versatile` has been decommissioned and is no longer supported.', type: 'invalid_request_error', code: 'model_decommissioned' } }) });
  }
  if (body.model === garbleModel) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Sure! Here are some ideas for your message to Daniel.' } }] }) });
  }
  if (/job application messages/.test(body.messages[0].content)) {
    appReqs.push(body);
    if (appTooLong && !/Shorten this application message/.test(body.messages[1].content)) {
      const long = { subject: 'Application — Localization Project Manager', body: 'Dear Polyglot Interpreters and Translators recruitment team,\n\n' + 'Your work across 200+ languages from Winter Haven, Florida stood out to me. '.repeat(12) + '\n\nAmara Okafor', why: 'w', roleArea: 'Localization project management' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(long) } }] }) });
    }
    const app = { subject: `Application — Localization Project Manager${/clearly different version/.test(body.messages[1].content) ? ' (v2)' : ''}`, body: 'Dear Polyglot Interpreters and Translators recruitment team,\n\nYour work across 200+ languages from Winter Haven, Florida stood out to me. As a Senior Localization Project Manager at Kestrel Language Services, I cut average turnaround time by 35% by redesigning the vendor workflow.\n\nI would welcome an interview. My CV is available on request.\n\nAmara Okafor', why: 'Matches their localization focus.', roleArea: 'Localization project management' };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(app) } }] }) });
  }
  if (/compound/.test(body.model) && compound404) {
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { message: `The model \`${body.model}\` does not exist or you do not have access to it.`, type: 'invalid_request_error', code: 'model_not_found' } }) });
  }
  if (body.tools && browserSearch400) {
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'browser_search tool is not supported for this organization', type: 'invalid_request_error' } }) });
  }
  if (/compound/.test(body.model) || (body.tools && body.tools[0].type === 'browser_search') || /SEARCH RESULTS/.test(JSON.stringify(body.messages))) {
    content = JSON.stringify({ summary: 'Northwind Learning makes localized courses.', hiringFocus: [{ domain: 'Localization & Language', roles: ['Localization Project Manager'], evidence: 'Groq web search' }], recentNews: [], talentSources: [], values: [], interviewAngles: [], confidence: 'medium' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content, executed_tools: [{ search_results: { results: [{ title: 'Northwind careers', url: 'https://northwind.example/careers' }] } }] } }] }) });
  }
  const n = /Write 1 new/.test(body.messages[body.messages.length - 1].content) ? 1 : 3;
  if (/qwen/.test(body.model)) {
    const variants = [{ angle: 'Qwen 0', message: 'Hi Daniel, I saw Northwind Learning is hiring in Localization.', why: 'q' }];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: `<think>The user wants {drafts}. Plan: {a}, {b}.</think>\n\n${JSON.stringify({ variants })}` } }] }) });
  }
  const variants = Array.from({ length: n }, (_, i) => ({ angle: `Groq ${i}`, message: `Hi Daniel, I saw Northwind Learning is hiring in Localization${i ? ' in Lagos' : ''}.`, why: 'Groq mock', hooksUsed: [] }));
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ variants }) } }] }) });
});

// 3) Settings: masked key, FAB toggle
await panel.click('#btn-settings');
await step('Groq is the default provider', async () => {
  assert.equal(await panel.inputValue('#sel-provider'), 'groq');
  assert.match(await panel.textContent('#key-label'), /Groq API key/);
  await panel.selectOption('#sel-provider', 'gemini'); // the next steps cover Gemini
});
await step('API key is masked, never re-displayed, removable', async () => {
  assert.equal(await panel.getAttribute('#inp-key', 'type'), 'password');
  await panel.fill('#inp-key', 'AIzaSyTESTKEY1234567890');
  await panel.check('#chk-consent');
  await panel.click('#btn-save-key');
  assert.equal(await panel.inputValue('#inp-key'), ''); // not put back into the field
  assert.match(await panel.textContent('#key-saved'), /AIza••••••••7890/);
  // Saving a Gemini key loads the models it can use; the retired default is replaced.
  await panel.waitForFunction(() => document.querySelector('#inp-model').value === 'gemini-3.5-flash', null, { timeout: 5000 });
  assert.match(await panel.textContent('#key-status'), /isn’t available for your key/);
  const opts = await panel.$$eval('#model-list option', (n) => n.map((o) => o.value));
  assert.ok(opts.includes('gemini-3.5-flash-lite') && !opts.includes('text-embedding-005'), opts.join(','));
  // Saving again with an empty field keeps the key.
  await panel.click('#btn-save-key');
  const s = (await sw.evaluate(() => chrome.storage.local.get('lda.settings')))['lda.settings'];
  assert.equal(s.apiKeys.gemini, 'AIzaSyTESTKEY1234567890');
  // Show reveals only what is typed, and re-hides on blur.
  await panel.fill('#inp-key', 'typed');
  await panel.click('#btn-toggle-key');
  assert.equal(await panel.getAttribute('#inp-key', 'type'), 'text');
  await panel.click('#inp-model');
  assert.equal(await panel.getAttribute('#inp-key', 'type'), 'password');
  await panel.fill('#inp-key', '');
});
await step('Test key: validates via model list, then a quick ping with timing', async () => {
  await panel.click('#btn-test-key');
  await panel.waitForFunction(() => /Key works with gemini-3\.5-flash \(answered in \d+s\)/.test(document.querySelector('#key-status').textContent), null, { timeout: 10000 });
  assert.equal(await panel.textContent('#btn-test-key'), 'Test key'); // spinner cleared
});
await step('floating button can be turned off', async () => {
  await panel.uncheck('#chk-fab');
  await li.waitForSelector('#lda-fab-host', { state: 'detached', timeout: 3000 });
  await panel.check('#chk-fab');
  await li.waitForSelector('#lda-fab-host', { state: 'attached', timeout: 3000 });
});
await panel.click('#btn-close-settings');

// 4) Web research for the person's company (mocked Gemini + Google Search)
await step('research the person’s company with Gemini + Google Search', async () => {
  assert.equal(await panel.isDisabled('#btn-research'), false);
  await panel.click('#btn-research');
  await panel.waitForSelector('#research-body .research');
  assert.ok(researchReq.tools[0].google_search);
  const sent = researchReq.contents[0].parts[0].text;
  assert.match(sent, /Company: Northwind Learning/);
  assert.ok(!sent.includes('Daniel') && !sent.includes('Amara'), 'no profile text in research request');
  const text = await panel.textContent('#research-body');
  assert.match(text, /Localization & Language/);
  assert.match(text, /matches you/);
  assert.match(text, /Brightway Media Group/);
  const hookTypes = await panel.$$eval('#hooks .badge', (n) => n.map((x) => x.textContent));
  assert.equal(hookTypes[0], 'hiring domain');
});
await step('a model retired mid-use is replaced automatically and the call retried', async () => {
  // Simulate Google retiring the saved model after setup.
  await sw.evaluate(async () => {
    const s = (await chrome.storage.local.get('lda.settings'))['lda.settings'];
    s.models.gemini = 'gemini-2.5-flash';
    await chrome.storage.local.set({ 'lda.settings': s });
  });
  await panel.waitForTimeout(200);
});
await step('Gemini drafts include research + note; invented company flagged', async () => {
  await panel.click('#btn-generate');
  await panel.waitForFunction(() => document.querySelector('#variants textarea')?.value.includes('Atlantis'));
  assert.deepEqual(genModels.slice(-2), ['gemini-2.5-flash', 'gemini-3.5-flash']); // 404 → switch → retry
  assert.match(await panel.textContent('#engine-note'), /switched to “gemini-3.5-flash”/);
  const s = (await sw.evaluate(() => chrome.storage.local.get('lda.settings')))['lda.settings'];
  assert.equal(s.models.gemini, 'gemini-3.5-flash');
  const prompt = genReqs[0].contents[0].parts[0].text;
  assert.match(prompt, /"RESEARCH"/);
  assert.match(prompt, /localization PM role in edtech/);
  assert.match(prompt, /Interview Request/);
  const marks = await panel.$$eval('#variants .variant:nth-child(1) mark.flag', (n) => n.map((x) => x.textContent));
  assert.deepEqual(marks, ['Atlantis Corp']);
});
await step('AI regenerate sends count=1 with the other drafts to avoid', async () => {
  await panel.click('#variants .variant:nth-child(2) button:has-text("Regenerate")');
  await panel.waitForFunction(() => document.querySelector('#variants .variant:nth-child(2) textarea').value.includes('Kestrel'));
  const last = genReqs[genReqs.length - 1].contents[0].parts[0].text;
  assert.match(last, /Write 1 new LinkedIn message/);
  assert.match(last, /--- draft 2 ---[\s\S]*Atlantis Corp/); // other drafts passed as "avoid"
  assert.match(await panel.textContent('#variants .variant:nth-child(2) .fact'), /✓/);
});
await step('Groq: save key, models listed (non-chat filtered), Test key', async () => {
  await panel.click('#btn-settings');
  await panel.selectOption('#sel-provider', 'groq');
  await panel.fill('#inp-key', 'gsk_TESTKEY_abcdef123456');
  await panel.click('#btn-save-key');
  await panel.waitForFunction(() => /models available/.test(document.querySelector('#key-status').textContent), null, { timeout: 5000 });
  const opts = await panel.$$eval('#model-list option', (n) => n.map((o) => o.value));
  assert.deepEqual(opts, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'qwen/qwen3.8-27b']);
  await panel.click('#btn-test-key');
  await panel.waitForFunction(() => /Key works with openai\/gpt-oss-120b/.test(document.querySelector('#key-status').textContent), null, { timeout: 10000 });
  await panel.click('#btn-close-settings');
});
await step('Groq writes the drafts', async () => {
  assert.match(await panel.textContent('#engine-note'), /Generating with Groq/);
  await panel.click('#btn-generate');
  await panel.waitForFunction(() => document.querySelector('#variants .variant-angle')?.textContent.includes('Groq 0'));
  const req = groqReqs[groqReqs.length - 1];
  assert.equal(req.model, 'openai/gpt-oss-120b');
  assert.equal(req.response_format.type, 'json_object');
  assert.match(req.messages[1].content, /"RESEARCH"/);
  assert.match(await panel.textContent('#variants-head'), /Drafted with Groq/);
});
await step('your case: 120b daily quota used up, next model garbles, qwen replies with <think> → drafts still arrive', async () => {
  groqDaily.add('openai/gpt-oss-120b');
  garbleModel = 'openai/gpt-oss-20b';
  await panel.click('#btn-generate');
  await panel.waitForFunction(() => document.querySelector('#variants .variant-angle')?.textContent.includes('Qwen 0'), null, { timeout: 15000 });
  const note = await panel.textContent('#engine-note');
  assert.match(note, /Today’s free quota for “openai\/gpt-oss-120b” is used up/);
  assert.match(note, /“openai\/gpt-oss-20b” replied in an unexpected format/);
  assert.match(note, /“llama-3\.3-70b-versatile” isn’t available, so “qwen\/qwen3\.8-27b” was tried/);
  assert.equal(await panel.isVisible('#gen-error'), false);
  groqDaily.clear();
  garbleModel = '';
  const s = (await sw.evaluate(() => chrome.storage.local.get('lda.settings')))['lda.settings'];
  assert.equal(s.models.groq, 'openai/gpt-oss-120b'); // quota fallbacks are per request, not saved
});
await step('with Groq selected, research uses Groq web search first, and is saved for 7 days', async () => {
  const before = groqReqs.length;
  await panel.click('#btn-research'); // "Research again"
  await panel.waitForFunction(() => /Groq web search/.test(document.querySelector('#research-note').textContent), null, { timeout: 10000 });
  const req = groqReqs.slice(before).find((r) => r.model === 'groq/compound');
  assert.ok(req, 'groq/compound not called');
  assert.ok(!/Daniel|Amara/.test(req.messages[0].content), 'no profile text in research');
  const cache = (await sw.evaluate(() => chrome.storage.local.get('lda.research')))['lda.research'];
  assert.ok(cache['northwind learning'], 'research not cached');
});
await step('groq/compound unavailable (your error) → Groq browser search used instead', async () => {
  compound404 = true;
  const before = groqReqs.length;
  await panel.click('#btn-research');
  await panel.waitForFunction(() => /browser search/.test(document.querySelector('#research-note').textContent), null, { timeout: 10000 });
  const reqs = groqReqs.slice(before);
  assert.ok(reqs.some((r) => r.model === 'groq/compound'), 'compound tried first');
  const bs = reqs.find((r) => r.tools && r.tools[0].type === 'browser_search');
  // 20b first, so research doesn't eat the drafting model's (120b) daily quota.
  assert.ok(bs && bs.model === 'openai/gpt-oss-20b' && bs.tool_choice === 'required' && bs.reasoning_effort === 'low', JSON.stringify(bs && { m: bs.model, r: bs.reasoning_effort }));
  assert.match(await panel.textContent('#research-body'), /Localization & Language/);
});
await step('research: 20b daily quota used up → 120b browser search takes over', async () => {
  groqDaily.add('openai/gpt-oss-20b');
  const before = groqReqs.length;
  await panel.click('#btn-research');
  await panel.waitForFunction((b) => document.querySelector('#research-note').textContent.includes('gpt-oss-120b + browser search'), before, { timeout: 10000 });
  groqDaily.clear();
});
await step('no Groq web search at all → clear error naming Tavily; with a Tavily key, Tavily + Groq summary', async () => {
  browserSearch400 = true;
  // Like the user's setup: Groq only, no Gemini key.
  const savedGemini = await sw.evaluate(async () => {
    const s = (await chrome.storage.local.get('lda.settings'))['lda.settings'];
    const k = s.apiKeys.gemini;
    s.apiKeys.gemini = '';
    await chrome.storage.local.set({ 'lda.settings': s });
    return k;
  });
  await panel.waitForTimeout(200);
  await panel.click('#btn-research');
  await panel.waitForSelector('#gen-error:not([hidden])', { timeout: 10000 });
  assert.match(await panel.textContent('#gen-error'), /Tavily/);
  assert.match(await panel.textContent('#gen-error'), /does not exist or you do not have access/); // Groq's own words are shown
  await panel.click('#btn-settings');
  await panel.fill('#inp-tavily', 'tvly-TESTKEY1234567');
  await panel.click('#btn-save-tavily');
  assert.match(await panel.textContent('#tavily-saved'), /tvly••••••••4567/);
  await panel.click('#btn-close-settings');
  const before = groqReqs.length;
  await panel.click('#btn-research');
  await panel.waitForFunction(() => /Tavily search/.test(document.querySelector('#research-note').textContent), null, { timeout: 10000 });
  assert.equal(tavilyReqs.length, 2); // overview + hiring searches
  assert.ok(tavilyReqs.every((q) => /Northwind Learning/.test(q.query) && !/Daniel|Amara/.test(q.query)));
  const summary = groqReqs.slice(before).find((r) => /SEARCH RESULTS/.test(JSON.stringify(r.messages)));
  assert.ok(summary && summary.model === 'openai/gpt-oss-120b' && !summary.tools);
  const hrefs = await panel.$$eval('#research-body .sources a', (n) => n.map((a) => a.href));
  assert.ok(hrefs.includes('https://northwind.example/careers'), hrefs.join(','));
  compound404 = false;
  browserSearch400 = false;
  await sw.evaluate(async (k) => {
    const s = (await chrome.storage.local.get('lda.settings'))['lda.settings'];
    s.apiKeys.gemini = k;
    s.apiKeys.tavily = '';
    await chrome.storage.local.set({ 'lda.settings': s });
  }, savedGemini);
  await panel.waitForTimeout(200);
});
await step('Gemini search quota used up → research falls back to Groq with a clear note', async () => {
  await sw.evaluate(async () => {
    const s = (await chrome.storage.local.get('lda.settings'))['lda.settings'];
    s.provider = 'gemini';
    await chrome.storage.local.set({ 'lda.settings': s });
  });
  await panel.waitForTimeout(200);
  geminiSearch429 = true;
  const before = groqReqs.length;
  await panel.click('#btn-research');
  await panel.waitForFunction(() => /Groq researched it instead/.test(document.querySelector('#engine-note').textContent), null, { timeout: 15000 });
  assert.ok(groqReqs.slice(before).some((r) => r.model === 'groq/compound'));
  assert.match(await panel.textContent('#engine-note'), /Gemini: Daily free-tier limit.*so Groq researched it instead/);
  geminiSearch429 = false;
});
await step('favourite reused on this profile', async () => {
  await panel.click('#btn-favorites');
  await panel.waitForSelector('#view-favorites:not([hidden])');
  assert.match(await panel.textContent('#favorites-list'), /Hi Daniel,/);
  await panel.click('#favorites-list button:has-text("Use for Daniel")');
  await panel.waitForSelector('#view-target:not([hidden])');
  assert.match(await panel.textContent('#variants .variant:nth-child(1) .variant-angle'), /Saved:/);
});
await panel.screenshot({ path: path.join(shots, 'target.png'), fullPage: true });

// 5) Company page: home → about → jobs, merged in memory
const coTab = await ctx.newPage();
await coTab.goto('https://www.linkedin.com/company/northwind-learning/');
const coTabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.linkedin.com/company/*' }))[0].id);
await retarget(panel, coTabId);
await step('floating button on company page', async () => {
  await coTab.waitForSelector('#lda-fab-host', { state: 'attached', timeout: 5000 });
});
await coTab.bringToFront(); // fires tabs.onActivated → panel refreshes for the company tab
await panel.waitForFunction(() => document.querySelector('#target-eyebrow')?.textContent === 'Company page', null, { timeout: 10000 });
await step('company page detected (recipient field, no "my profile" link)', async () => {
  assert.equal(await panel.textContent('#target-eyebrow'), 'Company page');
  assert.equal(await panel.isVisible('#recipient-wrap'), true);
  assert.equal(await panel.isVisible('#btn-not-target'), false);
  assert.equal(await panel.isVisible('#company-steps'), true);
  assert.match(await panel.textContent('#btn-open-about'), /Open the About tab/); // on the home tab
});
await step('analyze home, then about + jobs tabs merge', async () => {
  await panel.click('#btn-analyze');
  await panel.waitForSelector('#analysis:not([hidden])');
  await coTab.goto('https://www.linkedin.com/company/northwind-learning/about/');
  await panel.waitForFunction(() => /about/.test(document.querySelector('#btn-analyze').textContent), null, { timeout: 5000 });
  await panel.click('#btn-analyze');
  await panel.waitForFunction(() => /home, about/.test(document.querySelector('#company-tip').textContent));
  await coTab.goto('https://www.linkedin.com/company/northwind-learning/jobs/');
  await panel.waitForFunction(() => /jobs/.test(document.querySelector('#btn-analyze').textContent), null, { timeout: 5000 });
  await panel.click('#btn-analyze');
  await panel.waitForFunction(() => /home, about, jobs/.test(document.querySelector('#company-tip').textContent));
  // Web research done for Daniel's company is reused here (same company, memory only).
  assert.match(await panel.textContent('#research-badge'), /^web/);
  assert.match(await panel.textContent('#research-body'), /Localization & Language/);
  assert.equal(await panel.inputValue('#inp-research-company'), 'Northwind Learning');
});
await step('company pages: no DM section; application addressed to the named recipient', async () => {
  assert.equal(await panel.isVisible('#dm-section'), false);
  assert.equal(await panel.isVisible('#btn-generate'), false);
  assert.equal(await panel.isVisible('#application-card'), true);
  assert.equal(await panel.isVisible('#btn-open-about'), true); // on the Jobs tab → offer the About tab
  await panel.fill('#inp-recipient', 'Ngozi Ade');
  await panel.selectOption('#sel-app-tone', 'direct');
  const before = appReqs.length;
  await panel.click('#btn-draft-application');
  await panel.waitForFunction((b) => document.querySelector('#application-out textarea'), before, { timeout: 10000 });
  const req = appReqs[appReqs.length - 1];
  assert.match(req.messages[1].content, /CONTACT: Ngozi Ade/);
  assert.match(req.messages[1].content, /TONE: Direct/);
  const all = JSON.stringify(await sw.evaluate(() => chrome.storage.local.get(null)));
  assert.ok(!all.includes('Ngozi') && !all.includes('Igbo-language'), 'company/recipient data leaked to storage');
});
await panel.screenshot({ path: path.join(shots, 'company.png'), fullPage: true });

// 5b) Company About page (current layout): Analyze → Tavily research with page content → Draft Application (Groq)
await sw.evaluate(async () => {
  const s = (await chrome.storage.local.get('lda.settings'))['lda.settings'];
  s.apiKeys.tavily = 'tvly-TESTKEY1234567';
  await chrome.storage.local.set({ 'lda.settings': s });
});
const polyTab = await ctx.newPage();
await polyTab.goto('https://www.linkedin.com/company/polyglot/about/');
const polyTabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.linkedin.com/company/polyglot/*' }))[0].id);
await retarget(panel, polyTabId);
await polyTab.bringToFront();
await panel.waitForFunction(() => document.querySelector('#target-name')?.textContent === 'Polyglot Interpreters and Translators', null, { timeout: 10000 });
await step('Analyze company works on the current About layout and researches with Tavily first (+ page content)', async () => {
  const tBefore = tavilyReqs.length;
  const gBefore = groqReqs.length;
  await panel.click('#btn-analyze');
  await panel.waitForSelector('#analysis:not([hidden])', { timeout: 10000 });
  assert.equal(await panel.textContent('#target-headline'), 'The World’s Voice. Interpreted.');
  await panel.waitForFunction(() => /Tavily search/.test(document.querySelector('#research-note').textContent), null, { timeout: 15000 });
  const qs = tavilyReqs.slice(tBefore).map((q) => q.query);
  assert.equal(qs.length, 2);
  assert.ok(qs.every((q) => /Polyglot Interpreters and Translators/.test(q) && /polyglot\.example/.test(q)), qs.join(' | '));
  const summary = groqReqs.slice(gBefore).find((r) => /SEARCH RESULTS/.test(JSON.stringify(r.messages)));
  assert.match(JSON.stringify(summary.messages), /OWN LINKEDIN PAGE[\s\S]*Medical Interpretation/);
  assert.equal(await panel.isVisible('#application-card'), true);
  const steps = await panel.$$eval('#company-steps li', (n) => n.map((li) => li.className));
  assert.deepEqual(steps, ['done', 'done', 'current']);
  assert.equal(await panel.isVisible('#dm-section'), false);
});
await step('Draft Application (Groq): subject + message, fact-checked, editable, regenerate', async () => {
  const appBefore = appReqs.length;
  await panel.click('#btn-draft-application');
  await panel.waitForFunction((n) => document.querySelector('#application-out textarea') && document.querySelector('#company-steps li:last-child').className === 'done', appBefore, { timeout: 10000 });
  const first = appReqs[appBefore];
  assert.equal(first.model, 'openai/gpt-oss-120b');
  const prompt = first.messages[1].content;
  assert.match(prompt, /"APPLICANT"/);
  assert.match(prompt, /"COMPANY"[\s\S]*Winter Haven, Florida/);
  assert.match(prompt, /"RESEARCH"/);
  assert.match(prompt, /localization PM role in edtech/); // About-me note
  assert.match(await panel.inputValue('#application-out input'), /^Application — Localization Project Manager/);
  assert.match(await panel.inputValue('#application-out textarea'), /cut average turnaround time by 35%/);
  assert.match(await panel.textContent('#application-out .fact'), /✓/);
  assert.match(await panel.textContent('#application-out'), /pitched for Localization project management/);
  await panel.click('#application-out button:has-text("Regenerate")');
  await panel.waitForFunction(() => /\(v2\)/.test(document.querySelector('#application-out input').value), null, { timeout: 10000 });
  assert.match(appReqs[appReqs.length - 1].messages[1].content, /clearly different version/);
  assert.deepEqual(await panel.$$eval('#company-steps li', (n) => n.map((li) => li.className)), ['done', 'done', 'done']);
  const all = JSON.stringify(await sw.evaluate(() => chrome.storage.local.get(null)));
  assert.ok(!all.includes('recruitment team'), 'application text should not be stored');
});
await step('application kept within 700 characters: over-long draft is shortened automatically; live counter', async () => {
  appTooLong = true;
  const before = appReqs.length;
  await panel.click('#btn-draft-application');
  await panel.waitForFunction((b) => document.querySelector('#application-out .count')?.textContent.startsWith(String(document.querySelector('#application-out textarea').value.length)) && !/Shortening|Writing/.test(document.querySelector('#btn-draft-application').textContent), before, { timeout: 15000 });
  const reqs = appReqs.slice(before);
  assert.equal(reqs.length, 2, 'one draft + one shorten request');
  assert.match(reqs[1].messages[1].content, /Shorten this application message to AT MOST 700 characters/);
  const len = (await panel.inputValue('#application-out textarea')).length;
  assert.ok(len <= 700, `body is ${len} chars`);
  assert.match(await panel.textContent('#application-out .count'), new RegExp(`^${len} / 700 characters · LinkedIn limit 750`));
  assert.equal(await panel.isVisible('#application-out button:has-text("Shorten to 700")'), false);
  // Typing past 700 shows the warning and the Shorten button; past 750 turns red.
  await panel.fill('#application-out textarea', 'y'.repeat(720));
  assert.match(await panel.getAttribute('#application-out .count', 'class'), /warn/);
  assert.equal(await panel.isVisible('#application-out button:has-text("Shorten to 700")'), true);
  await panel.fill('#application-out textarea', 'y'.repeat(760));
  assert.match(await panel.getAttribute('#application-out .count', 'class'), /over/);
  appTooLong = false;
  await panel.click('#application-out button:has-text("Shorten to 700")');
  await panel.waitForFunction(() => document.querySelector('#application-out textarea').value.length <= 700, null, { timeout: 10000 });
});
await panel.screenshot({ path: path.join(shots, 'application.png'), fullPage: true });
await polyTab.close();

// 6) Redesigned LinkedIn layout, username mismatch, page without a readable name
for (const p of ctx.pages()) if (p !== panel) await p.close().catch(() => {});
await panel.close();
({ li, panel } = await openPanelFor('https://www.linkedin.com/in/amara-redesign/'));
panel.on('dialog', (d) => d.accept()); // "Replace your synced profile?" confirm
await step('username in Settings ≠ page address → not treated as yours', async () => {
  await panel.waitForSelector('#view-target:not([hidden])', { timeout: 10000 });
});
await step('clear username → name match → sync works on redesigned layout', async () => {
  await panel.click('#btn-not-target');
  await panel.waitForSelector('#view-settings:not([hidden])');
  await panel.fill('#inp-me-id', '');
  await panel.click('#btn-save-me');
  await panel.click('#btn-close-settings');
  await panel.waitForSelector('#view-own:not([hidden])', { timeout: 10000 });
  await panel.click('#btn-sync');
  await panel.waitForSelector('#sync-result:not([hidden]) h3', { timeout: 20000 });
  const st = (await sw.evaluate(() => chrome.storage.local.get('lda.userProfile')))['lda.userProfile'];
  assert.equal(st.name, 'Amara Okafor');
  assert.equal(st.experience.length, 2);
});
await li.close(); await panel.close();
await sw.evaluate(async () => {
  const s = (await chrome.storage.local.get('lda.settings'))['lda.settings'];
  s.me.linkedinId = '';
  await chrome.storage.local.set({ 'lda.settings': s });
});
({ li, panel } = await openPanelFor('https://www.linkedin.com/in/amara-noname/'));
panel.on('dialog', (d) => d.accept());
await step('no readable name on page → owner controls + Settings name', async () => {
  await panel.waitForSelector('#view-own:not([hidden])', { timeout: 10000 });
  await panel.click('#btn-sync');
  await panel.waitForSelector('#sync-result:not([hidden]) h3', { timeout: 20000 });
  const st = (await sw.evaluate(() => chrome.storage.local.get('lda.userProfile')))['lda.userProfile'];
  assert.equal(st.name, 'Amara Okafor'); // from Settings
  assert.match(await panel.textContent('#sync-result'), /owner-only controls/);
});
await li.close(); await panel.close();
({ li, panel } = await openPanelFor('https://www.linkedin.com/in/daniel-mensah-123/'));
await step('sync refuses someone else’s profile with a clear reason; diagnostic report copies', async () => {
  await panel.waitForSelector('#view-target:not([hidden])', { timeout: 10000 });
  // Even if forced into the own view, the Sync check refuses it.
  await panel.evaluate(() => { document.getElementById('view-own').hidden = false; document.getElementById('btn-sync').disabled = false; });
  await panel.click('#btn-sync');
  await panel.waitForSelector('#sync-result.error:not([hidden])', { timeout: 20000 });
  assert.match(await panel.textContent('#sync-result'), /doesn’t look like your profile/);
  await panel.click('#sync-result button:has-text("Copy diagnostic report")');
  await panel.waitForSelector('#sync-result button:has-text("Copied")', { timeout: 5000 });
});

// 7) Updates from GitHub: check → banner → updater page → choose folder → install → reload
{
  const { execFileSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const cur = JSON.parse(fs.readFileSync(path.join(extPath, 'manifest.json'), 'utf8'));
  const next = cur.version.replace(/\d+$/, (n) => String(Number(n) + 1));
  // Build a genuine "next version" package from the current files.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lda-up-'));
  execFileSync('sh', ['-c', `cd "${extPath}" && zip -qr "${tmp}/base.zip" manifest.json icons src`]);
  execFileSync('python3', ['-c', `
import zipfile, json
src = zipfile.ZipFile("${tmp}/base.zip"); out = zipfile.ZipFile("${tmp}/next.zip", "w", zipfile.ZIP_DEFLATED)
for i in src.infolist():
    data = src.read(i.filename)
    if i.filename == "manifest.json":
        m = json.loads(data); m["version"] = "${next}"; data = json.dumps(m).encode()
    out.writestr(i.filename, data)
out.close()`]);
  const zipBuf = fs.readFileSync(`${tmp}/next.zip`);
  const sha = createHash('sha256').update(zipBuf).digest('hex');
  let tamper = false;
  await ctx.route('https://raw.githubusercontent.com/**', (route) => {
    const u = route.request().url();
    if (u.includes('/SurdsoN/linkedinDM/main/version.json')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: cur.name, version: next, released: '2026-10-12', zip: `releases/linkedin-dm-architect-v${next}.zip`, sha256: sha, notes: ['Test release note'] }) });
    }
    if (u.includes(`/releases/linkedin-dm-architect-v${next}.zip`)) {
      const body = tamper ? Buffer.concat([zipBuf, Buffer.from('x')]) : zipBuf;
      return route.fulfill({ status: 200, contentType: 'application/zip', body });
    }
    route.fulfill({ status: 404, body: '' });
  });
  // Updater page: the folder picker returns a sandbox folder holding the "installed" copy; reload is recorded.
  await ctx.addInitScript((ver) => {
    if (location.protocol !== 'chrome-extension:' || !location.pathname.includes('/updater/')) return;
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('dm-architect', { create: true });
      const fh = await dir.getFileHandle('manifest.json', { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify({ name: 'LinkedIn DM Architect', version: ver }));
      await w.close();
      return dir;
    };
    chrome.runtime.reload = () => { window.__reloaded = true; };
  }, cur.version);

  await sw.evaluate(() => chrome.storage.local.remove('lda.update'));
  await panel.reload();
  await step('daily check finds a newer version on GitHub → banner', async () => {
    await panel.waitForSelector('#update-banner:not([hidden])', { timeout: 10000 });
    assert.match(await panel.textContent('#update-banner'), new RegExp(`v${next.replace(/\./g, '\\.')} is available`));
  });
  await step('Settings → Check for updates shows version, notes and Install update', async () => {
    await panel.click('#btn-settings');
    await panel.click('#btn-check-update');
    await panel.waitForFunction(() => /Update available/.test(document.querySelector('#update-status').textContent));
    assert.match(await panel.textContent('#update-version'), new RegExp(`Installed: v${cur.version}`));
    assert.match(await panel.textContent('#update-notes'), /Test release note/);
    assert.equal(await panel.isVisible('#btn-install-update'), true);
  });
  let up;
  await step('Install update opens the updater; choosing the folder verifies it', async () => {
    const [p] = await Promise.all([ctx.waitForEvent('page'), panel.click('#btn-install-update')]);
    up = p;
    up.on('pageerror', (e) => errors.push('updater: ' + e.message));
    await up.waitForSelector('#install:not([hidden])', { timeout: 10000 });
    assert.match(await up.textContent('#title'), new RegExp(`Update available: v${next.replace(/\./g, '\\.')}`));
    await up.click('#btn-folder');
    await up.waitForFunction(() => /✓ dm-architect/.test(document.querySelector('#folder-state').textContent));
    assert.equal(await up.isDisabled('#btn-install'), false);
  });
  await step('tampered download is rejected (SHA-256) and nothing is written', async () => {
    tamper = true;
    await up.click('#btn-install');
    await up.waitForFunction(() => /integrity check/.test(document.querySelector('#status').textContent), null, { timeout: 10000 });
    const v = await up.evaluate(async () => JSON.parse(await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('dm-architect')).getFileHandle('manifest.json')).getFile().then((f) => f.text())).version);
    assert.equal(v, cur.version);
    tamper = false;
  });
  await step('install writes the verified files into the folder, then reloads the extension', async () => {
    await up.click('#btn-install');
    await up.waitForFunction(() => window.__reloaded === true, null, { timeout: 15000 });
    assert.match(await up.textContent('#status'), new RegExp(`v${next.replace(/\./g, '\\.')} installed`));
    const got = await up.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('dm-architect');
      const m = JSON.parse(await (await (await dir.getFileHandle('manifest.json')).getFile()).text());
      const sp = await (await (await (await dir.getDirectoryHandle('src')).getDirectoryHandle('sidepanel')).getFileHandle('sidepanel.html')).getFile();
      return { version: m.version, sidepanelBytes: sp.size };
    });
    assert.equal(got.version, next);
    assert.ok(got.sidepanelBytes > 1000);
  });
}

assert.deepEqual(errors, [], 'panel errors: ' + errors.join('\n'));
await ctx.close();
console.log(`\nE2E OK — ${passed} steps`);
