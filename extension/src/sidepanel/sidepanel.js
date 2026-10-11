/**
 * Side panel controller.
 *
 * Views: status (not on a profile / loading), own (Sync My Profile + About-me
 * note), target (person or company: Analyze → hooks → Generate), favorites,
 * settings.
 *
 * Privacy: the target profile/company lives only in `state.target` (memory).
 * It is never written to storage and is dropped when you navigate to another
 * person or company. Favourites are saved as templates with the recipient's
 * name/company replaced by placeholders.
 */

import {
  getUserProfile, saveUserProfile, clearUserProfile, getSettings, saveSettings, maskKey,
  getUserNote, saveUserNote, getFavorites, addFavorite, removeFavorite,
  getCachedResearch, cacheResearch, clearResearchCache,
} from '../shared/storage.js';
import { rankHooks } from '../engine/hooks.js';
import { buildPrompt, LENGTHS } from '../engine/prompt.js';
import { generateWithLLM, testKey, pingGemini, completeJSON, PROVIDERS } from '../engine/llm.js';
import { generateLocal } from '../engine/templates.js';
import { buildCorpus, factCheck, segments } from '../engine/factcheck.js';
import { toTemplate, fillTemplate } from '../engine/favorites.js';
import { researchCompany, researchWithGroq, researchWithTavily, researchFromPage, matchDomains } from '../engine/research.js';
import { checkOwnership, parseLinkedInId } from '../shared/identity.js';
import { checkForUpdate, compareVersions, REPO_URL } from '../shared/updater.js';
import { buildApplicationPrompt, buildShortenPrompt, parseApplication, MAX_APPLICATION_CHARS, LINKEDIN_MESSAGE_LIMIT } from '../engine/application.js';
import { listGeminiModels, pickGeminiModel, isModelUnavailable, isModelQuotaExhausted, isBadModelReply } from '../engine/gemini-models.js';
import { listGroqModels, pickGroqModel } from '../engine/groq-models.js';
import { LLMError } from '../engine/errors.js';

const X = globalThis.LDAExtractor;
const $ = (id) => document.getElementById(id);

const GOAL_LABEL = { warm: 'Warm Network', value: 'Value-First', opportunity: 'Soft Opportunity', interview: 'Interview Request', peer: 'Peer Collaboration' };

const state = {
  tabId: null,
  page: null, // result of LDA_PING
  user: null, // synced profile
  note: '', // About-me note
  settings: null,
  favorites: [],
  target: null, // in-memory only (person or company)
  targetKey: '',
  hooks: { all: [], top: [] },
  selected: new Set(),
  variants: [], // [{angle, message, why, hooksUsed, source, seed}]
  genOpts: null, // options used for the current variants (for per-card regenerate)
  view: 'main', // 'main' | 'settings' | 'favorites'
  research: new Map(), // company name (lowercase) → web research; memory only
};

// ---------------------------------------------------------------------------
// Messaging with the content script
// ---------------------------------------------------------------------------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function send(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!res) reject(new Error('No response from page'));
      else if (!res.ok) reject(new Error(res.error || 'Page error'));
      else resolve(res);
    });
  });
}

/** Ping the page; inject the content script if the tab predates the install. */
async function pingPage(tabId) {
  const ctx = { syncedSlug: parseLinkedInId(state.settings.me.linkedinId) || state.user?.source?.publicIdentifier || '' };
  try {
    return (await send(tabId, { type: 'LDA_PING', ctx })).page;
  } catch (_) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/extractor.js', 'src/content/content-script.js'] });
    return (await send(tabId, { type: 'LDA_PING', ctx })).page;
  }
}

async function extractPage(options = {}) {
  const ctx = { syncedSlug: parseLinkedInId(state.settings.me.linkedinId) || state.user?.source?.publicIdentifier || '' };
  const res = await send(state.tabId, { type: 'LDA_EXTRACT', options: { ...options, ctx } });
  return res.profile;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
}

function show(view) {
  for (const id of ['view-status', 'view-own', 'view-target', 'view-settings', 'view-favorites']) $(id).hidden = id !== view;
  $('btn-settings').classList.toggle('active', view === 'view-settings');
  $('btn-favorites').classList.toggle('active', view === 'view-favorites');
}

function showStatus({ icon = '', title, text = '', actions = [], spinner = false }) {
  $('status-icon').replaceChildren(spinner ? el('span', { class: 'spinner' }) : document.createTextNode(icon));
  $('status-title').textContent = title;
  $('status-text').textContent = text;
  $('status-actions').replaceChildren(...actions);
  show('view-status');
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Busy state with a spinner; after a few seconds it also shows elapsed time. */
function setBusy(btn, busy, label) {
  clearInterval(btn._busyTimer);
  if (busy) {
    btn.dataset.label = btn.textContent;
    const text = document.createTextNode(label || 'Working…');
    btn.replaceChildren(el('span', { class: 'spinner' }), text);
    btn.disabled = true;
    const started = Date.now();
    btn._busyTimer = setInterval(() => {
      const secs = Math.round((Date.now() - started) / 1000);
      if (secs >= 3) text.textContent = `${label || 'Working…'} ${secs}s`;
    }, 1000);
  } else {
    btn.textContent = btn.dataset.label || btn.textContent;
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Model auto-selection (Gemini + Groq)
// ---------------------------------------------------------------------------

const AUTO_MODEL_PROVIDERS = ['gemini', 'groq'];
const modelLists = {}; // provider → [{id, displayName}] for the current key (memory)

async function availableModels(provider, refresh = false) {
  if (!modelLists[provider] || refresh) {
    const key = state.settings.apiKeys[provider];
    modelLists[provider] = provider === 'gemini' ? await listGeminiModels(key) : await listGroqModels(key);
  }
  return modelLists[provider];
}

function pickModel(provider, models, exclude) {
  return provider === 'gemini' ? pickGeminiModel(models, exclude) : pickGroqModel(models, exclude);
}

function modelNotice(msg) {
  state.modelNotice = msg;
  if (state.target) updateGenerateState();
  const cn = document.getElementById('company-notice');
  if (cn) cn.textContent = msg || '';
  if (state.view === 'settings') $('key-status').textContent = msg;
}

/**
 * Run a call with automatic model fallback:
 *  - model retired / not available (404) → switch to the best available model and save it
 *  - model's free daily quota used up    → use the next model for this request (each has its own quota)
 */
async function withModel(provider, fn) {
  const tried = [];
  const saved = state.settings.models[provider];
  let model = saved;
  let lastErr = null;
  const notes = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await fn(model);
      if (notes.length) modelNotice(notes.join(' '));
      return result;
    } catch (e) {
      const gone = isModelUnavailable(e);
      const spent = isModelQuotaExhausted(e);
      const garbled = isBadModelReply(e);
      if (!gone && !spent && !garbled) throw e;
      lastErr = e;
      tried.push(model);
      let next = '';
      try {
        next = pickModel(provider, await availableModels(provider, gone), tried);
      } catch (_) { /* listing failed — surface the original error */ }
      if (!next) break;
      if (gone && model === saved) {
        // Only replace the saved model when IT is the one that's gone.
        state.settings = await saveSettings({ models: { [provider]: next } });
        notes.push(`“${model}” isn’t available for your key any more, so the default was switched to “${next}”.`);
      } else if (gone) {
        notes.push(`“${model}” isn’t available, so “${next}” was tried.`);
      } else if (spent) {
        notes.push(`Today’s free quota for “${model}” is used up (resets every 24h), so “${next}” was used for this request.`);
      } else {
        notes.push(`“${model}” replied in an unexpected format, so “${next}” was tried.`);
      }
      model = next;
    }
  }
  if (notes.length) modelNotice(notes.join(' '));
  if (lastErr && lastErr.format) throw new LLMError('The AI replies weren’t in the expected format. Try again, or use the local draft.', { provider });
  if (lastErr && lastErr.status === 429) throw new LLMError(`${lastErr.message} Every other model available to your key is also out of quota for today — try again later, or use the local draft.`, { provider, status: 429 });
  throw lastErr || new LLMError('Couldn’t find a working model. Try again later.', { provider });
}

const withGeminiModel = (fn) => withModel('gemini', fn);

/** Call the selected provider (Gemini and Groq get automatic model fallback). */
function callProvider({ system, user }) {
  const provider = state.settings.provider;
  const apiKey = state.settings.apiKeys[provider];
  if (AUTO_MODEL_PROVIDERS.includes(provider)) return withModel(provider, (model) => generateWithLLM({ provider, apiKey, model, system, user }));
  return generateWithLLM({ provider, apiKey, model: state.settings.models[provider], system, user });
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = el('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const prev = btn.textContent;
  btn.textContent = 'Copied ✓';
  setTimeout(() => (btn.textContent = prev), 1500);
}

function renderMeChip() {
  const chip = $('me-chip');
  chip.hidden = false;
  if (state.user) {
    chip.className = 'me-chip ok';
    chip.textContent = `Synced as ${state.user.name} · ${fmtDate(state.user.syncedAt)}`;
  } else {
    chip.className = 'me-chip no';
    chip.textContent = state.settings?.me?.name ? 'Your profile is not synced yet' : 'Add your name in Settings to get started';
  }
}

function renderFavCount() {
  const n = state.favorites.length;
  $('fav-count').hidden = !n;
  $('fav-count').textContent = String(n);
}

const isCompany = () => state.target?.entityType === 'company' || state.page?.entityType === 'company';

// ---------------------------------------------------------------------------
// Main refresh: decide which view to show for the active tab
// ---------------------------------------------------------------------------

let refreshTimer = null;
function scheduleRefresh(delay = 500) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, delay);
}

function resetTarget() {
  state.target = null;
  state.hooks = { all: [], top: [] };
  state.selected.clear();
  state.variants = [];
  state.genOpts = null;
  $('analysis').hidden = true;
  $('variants').replaceChildren();
  $('variants-head').replaceChildren();
  $('gen-error').hidden = true;
  $('sync-result').hidden = true;
  $('inp-recipient').value = '';
  $('inp-research-company').value = '';
  $('target-diag').hidden = true;
  $('analyze-error').hidden = true;
  state.application = null;
  state.modelNotice = '';
  $('company-notice').textContent = '';
  $('application-out').replaceChildren();
}

async function refresh() {
  renderMeChip();
  if (state.view !== 'main') return;

  const tab = await activeTab();
  state.tabId = tab?.id ?? null;
  const url = tab?.url || '';

  if (!url || !/^https:\/\/www\.linkedin\.com\//.test(url)) {
    state.page = null;
    showStatus({ icon: '🔗', title: 'Open a LinkedIn profile or company page', text: 'Go to any linkedin.com/in/… or linkedin.com/company/… page. On your own profile you can sync it; anywhere else you can draft a DM.' });
    return;
  }

  const parsed = X.parseProfileUrl(url);
  if (!parsed.isProfile || parsed.pageType === 'other') {
    state.page = null;
    showStatus({ icon: '👤', title: 'Open a profile or company page', text: 'This works on linkedin.com/in/… and linkedin.com/company/… pages.' });
    return;
  }

  // Navigated to a different person/company → drop in-memory target data.
  // Company tabs (home/about/posts) share one key so their data can be combined.
  const key = parsed.entityType === 'company' ? `company|${parsed.slug}` : `in|${parsed.slug}|${parsed.pageType}|${parsed.detailsSection || ''}`;
  if (key !== state.targetKey) resetTarget();
  state.targetKey = key;

  try {
    state.page = await pingPage(state.tabId);
  } catch (e) {
    showStatus({ icon: '⚠️', title: 'Can’t read this page yet', text: 'Reload the LinkedIn tab and try again.', actions: [el('button', { class: 'btn ghost', text: 'Retry', onclick: refresh })] });
    return;
  }

  if (state.page.entityType !== 'person') return renderTarget();
  state.ownCheck = pageOwnership(state.page);
  // Before a name is set, fall back to page detection so the user still lands on the Sync view.
  const isOwn = state.ownCheck.needsSetup ? !!state.page.ownership?.isOwn : state.ownCheck.mine;
  if (isOwn) renderOwn();
  else renderTarget();
}

/** Is the open page the user's profile? Uses the name/username from Settings. */
function pageOwnership(page) {
  const sig = page.ownership?.signals || {};
  return checkOwnership({ slug: page.slug, pageName: page.name, viewerSignals: sig.viewer, ownerSignals: sig.owner }, state.settings.me);
}

function settingsButton(label = 'Open Settings') {
  return el('button', { class: 'btn primary small', type: 'button', text: label, onclick: () => openOverlay('settings') });
}

// ---------------------------------------------------------------------------
// Own profile — Sync
// ---------------------------------------------------------------------------

function renderOwn() {
  const p = state.page;
  const isDetails = p.pageType === 'details';
  $('own-name').textContent = p.name || state.user?.name || 'Your profile';
  const btn = $('btn-sync');
  if (isDetails) {
    btn.textContent = state.user ? `Add full ${p.detailsSection} list to my synced profile` : 'Sync My Profile';
    $('own-state').textContent = state.user
      ? `This page has your complete ${p.detailsSection} list. Sync adds it to your saved profile.`
      : 'Sync your main profile page first, then come back here to add the full list.';
    btn.disabled = !state.user;
  } else if (state.user) {
    btn.textContent = 'Re-sync';
    $('own-state').textContent = `Last synced ${fmtDate(state.user.syncedAt)}. Re-sync after you update your profile.`;
    btn.disabled = false;
  } else {
    btn.textContent = 'Sync My Profile';
    $('own-state').textContent = 'One click saves your profile so every DM can match against it.';
    btn.disabled = false;
  }
  // No name in Settings yet: ask for it before syncing.
  const gate = $('own-gate');
  if (!state.settings.me.name) {
    gate.hidden = false;
    gate.className = 'card warn';
    gate.replaceChildren(el('p', { text: 'First, add your name (and ideally your LinkedIn username) in Settings. Sync checks this page is yours before saving anything.' }), settingsButton('Add my name'));
    btn.disabled = true;
  } else gate.hidden = true;
  $('note-own').value = state.note;
  show('view-own');
}

async function onSync() {
  const btn = $('btn-sync');
  setBusy(btn, true, 'Reading your profile…');
  $('sync-result').hidden = true;
  try {
    const me = state.settings.me;
    if (!me.name) throw new Error('Add your name in Settings first.');
    const extracted = await extractPage({ loadAll: true });
    // Verify this really is the user's profile before saving anything.
    const check = checkOwnership(
      { slug: extracted.source.publicIdentifier, pageName: extracted.name, viewerSignals: extracted.ownership?.signals?.viewer, ownerSignals: extracted.ownership?.signals?.owner },
      me
    );
    if (!check.mine) throw new Error(`Not synced — this doesn’t look like your profile. ${check.reason}`);
    let record;
    let savedId = '';

    if (extracted.source.pageType === 'details') {
      if (!state.user) throw new Error('Sync your main profile page first.');
      if (state.user.source.publicIdentifier.toLowerCase() !== extracted.source.publicIdentifier.toLowerCase()) {
        throw new Error('This details page belongs to a different profile than the one you synced.');
      }
      record = await saveUserProfile(X.mergeDetails(state.user, extracted));
    } else {
      // Your name always comes from Settings (the page may not show it in a readable way).
      extracted.pageName = extracted.name;
      extracted.name = me.name;
      extracted.meta.verifiedBy = check.method;
      if (!extracted.headline && !extracted.experience.length && !extracted.about) {
        throw new Error('Very little profile data was found. Scroll down the page once so LinkedIn loads all sections, then try again.');
      }
      const prev = state.user;
      if (prev && prev.source.publicIdentifier && prev.source.publicIdentifier.toLowerCase() !== extracted.source.publicIdentifier.toLowerCase()) {
        if (!confirm(`Replace your synced profile (${prev.name}) with ${extracted.name}?`)) return;
      }
      // Keep any full lists previously merged from details pages if they are longer.
      if (prev && prev.source.publicIdentifier === extracted.source.publicIdentifier) {
        for (const key of prev.meta?.mergedDetails || []) {
          if ((prev[key] || []).length > (extracted[key] || []).length) {
            extracted[key] = prev[key];
            delete extracted.meta.truncated[key];
            extracted.meta.warnings = extracted.meta.warnings.filter((w) => !w.toLowerCase().startsWith(key));
            extracted.meta.mergedDetails = (extracted.meta.mergedDetails || []).concat(key);
          }
        }
      }
      record = await saveUserProfile(extracted);
      // Remember the username so future checks match the page address exactly.
      if (!parseLinkedInId(me.linkedinId) && extracted.source.publicIdentifier) {
        savedId = extracted.source.publicIdentifier;
        state.settings = await saveSettings({ me: { linkedinId: savedId } });
      }
    }
    state.user = record;
    record.meta.savedId = savedId;
    renderSyncResult(record);
    renderMeChip();
  } catch (e) {
    const box = $('sync-result');
    box.className = 'card error';
    box.replaceChildren(el('p', {}, el('strong', { text: 'Sync failed. ' }), e.message), diagButton());
    box.hidden = false;
  } finally {
    setBusy(btn, false);
    renderOwn();
  }
}

function renderSyncResult(p) {
  const box = $('sync-result');
  box.className = 'card';
  const stat = (n, label) => el('div', { class: 'stat' }, el('b', { text: String(n) }), el('span', { text: label }));
  box.replaceChildren(
    el('h3', { text: '✓ Profile synced' }),
    el('p', { class: 'muted small', text: `${p.name} — ${p.headline || ''}` }),
    el('p', { class: 'hint', text: `Verified as your profile by ${({ username: 'your LinkedIn username', name: 'your name', 'page-controls': 'owner-only controls on the page' })[p.meta.verifiedBy] || 'your profile URL'}.${p.meta.savedId ? ` Saved your username (${p.meta.savedId}) to Settings.` : ''}` }),
    el(
      'div',
      { class: 'stats' },
      stat(p.experience.length, 'roles'),
      stat(p.education.length, 'schools'),
      stat(p.skills.length, 'skills'),
      stat(p.featured.length, 'featured'),
      stat(p.activity.length, 'posts'),
      stat(p.about ? '✓' : '—', 'about')
    ),
    p.meta.warnings.length ? el('ul', { class: 'warnings' }, p.meta.warnings.map((w) => el('li', { text: w }))) : null,
    p.meta.warnings.length || !p.experience.length ? diagButton() : null
  );
  box.hidden = false;
}

/**
 * "Copy diagnostic report": page structure (tags, classes, section headings,
 * counts) for troubleshooting LinkedIn layout changes. No names or profile text.
 */
function diagButton() {
  const btn = el('button', { class: 'btn ghost small', type: 'button', text: 'Copy diagnostic report' });
  btn.addEventListener('click', async () => {
    try {
      const { report } = await send(state.tabId, { type: 'LDA_DIAG' });
      report.extensionVersion = chrome.runtime.getManifest().version;
      await copyText(JSON.stringify(report, null, 2), btn);
    } catch (e) {
      btn.textContent = `Couldn’t build report: ${e.message}`;
    }
  });
  return el('div', { class: 'actions' }, btn, el('span', { class: 'hint', text: 'Contains page structure only — no names or profile text.' }));
}

// ---------------------------------------------------------------------------
// About-me note (shared by the own-profile view and Settings)
// ---------------------------------------------------------------------------

async function onSaveNote(e) {
  const btn = e.currentTarget; // currentTarget is cleared once we await
  const ta = $(btn.dataset.for);
  state.note = ta.value.trim();
  await saveUserNote(state.note);
  for (const id of ['note-own', 'note-settings']) $(id).value = state.note;
  const status = btn.parentElement.querySelector('.note-status');
  status.textContent = state.note ? 'Saved ✓' : 'Note cleared';
  setTimeout(() => (status.textContent = ''), 2000);
}

// ---------------------------------------------------------------------------
// Target — Analyze, hooks, generate
// ---------------------------------------------------------------------------

function renderTarget() {
  const p = state.page;
  const company = p.entityType === 'company';
  $('target-eyebrow').textContent = company ? 'Company page' : 'Viewing';
  $('target-name').textContent = state.target?.name || p.name || (company ? 'Company' : 'LinkedIn member');
  $('target-headline').textContent = state.target?.headline || '';
  $('recipient-wrap').hidden = !company;
  $('btn-not-target').hidden = company;

  const gate = $('target-gate');
  const analyze = $('btn-analyze');
  if (!state.settings.me.name) {
    gate.hidden = false;
    gate.className = 'card warn';
    gate.replaceChildren(el('p', { text: 'Start by adding your name in Settings, then open your own LinkedIn profile and press Sync.' }), settingsButton('Add my name'));
    analyze.disabled = true;
  } else if (!state.user) {
    gate.hidden = false;
    gate.className = 'card warn';
    gate.replaceChildren(
      el('p', { text: 'Sync your own profile first so messages can match your background.' }),
      el('button', { class: 'btn primary small', text: 'Open my profile', onclick: () => chrome.tabs.update(state.tabId, { url: `https://www.linkedin.com/in/${encodeURIComponent(parseLinkedInId(state.settings.me.linkedinId) || 'me')}/` }) })
    );
    analyze.disabled = true;
  } else if (p.pageType === 'details') {
    gate.hidden = false;
    gate.className = 'card warn';
    gate.replaceChildren(el('p', { text: 'Open their main profile page to analyze it.' }));
    analyze.disabled = true;
  } else {
    gate.hidden = true;
    analyze.disabled = false;
  }

  const tabsRead = state.target?.meta?.tabsRead || [];
  if (company) {
    const here = p.subpage || 'home';
    analyze.textContent = !state.target ? 'Analyze company' : tabsRead.includes(here) ? 'Re-analyze company' : `Add this “${here}” tab to the analysis`;
    $('research-title').textContent = `2. Research${state.target ? `: ${state.target.name}` : ''}`;
    const tip = $('company-tip');
    tip.hidden = false;
    tip.textContent = state.target
      ? `Read so far: ${tabsRead.join(', ')}.${tabsRead.includes('about') ? '' : ' Open the About tab and analyze it for the overview, size and specialties.'}`
      : 'Step 1 reads the company’s About tab (overview, industry, size, specialties). Research and the application follow.';
  } else {
    analyze.textContent = state.target ? 'Re-analyze profile' : 'Analyze profile';
    $('company-tip').hidden = true;
  }
  $('analysis').hidden = !state.target;
  // Company pages: Analyze → Research → Application. No DM section.
  $('dm-section').hidden = company;
  $('dm-output').hidden = company;
  $('company-steps').hidden = !company;
  $('btn-open-about').hidden = !company || p.subpage === 'about';
  if (company && p.subpage !== 'about') $('btn-open-about').textContent = 'Open the About tab (best for step 1)';
  renderApplicationCard();
  renderSteps();
  show('view-target');
}

/** Step tracker for company pages. */
function renderSteps() {
  const steps = $('company-steps');
  if (steps.hidden) return;
  const done = { analyze: !!state.target, research: !!webResearch(), application: !!state.application };
  let currentSet = false;
  for (const li of steps.querySelectorAll('li')) {
    const k = li.dataset.step;
    li.classList.toggle('done', done[k]);
    const isCurrent = !done[k] && !currentSet;
    li.classList.toggle('current', isCurrent);
    if (isCurrent) currentSet = true;
  }
}

async function onAnalyze() {
  const btn = $('btn-analyze');
  setBusy(btn, true, isCompany() ? 'Reading company…' : 'Reading profile…');
  try {
    const t = await extractPage({ loadAll: true });
    if (!t.name) throw new Error('Couldn’t read this page. Wait for it to load and try again.');
    // Combine company tabs (home + about + posts…) in memory.
    state.target = t.entityType === 'company' && state.target?.entityType === 'company' ? X.mergeCompany(state.target, t) : t;
    // Reuse saved research for this company (no API call).
    const companyName = researchCompanyName();
    if (companyName && !state.research.has(companyName.toLowerCase())) {
      const cached = await getCachedResearch(companyName);
      if (cached) state.research.set(companyName.toLowerCase(), cached);
    }
    $('analyze-error').hidden = true;
    rerankHooks(true);
    renderResearch();
    // Company pages: research straight away (Tavily first) unless a saved copy exists.
    if (t.entityType === 'company' && !webResearch() && researchAvailability().ok) {
      setBusy(btn, false);
      onResearch(); // runs in the background; the research card shows progress
    }
    // Tell the user when the page wasn't fully understood, with a way to report it.
    const diag = $('target-diag');
    const missing = t.entityType === 'person' ? [!t.experience.length && 'experience', !t.currentCompany && 'current company', !t.headline && 'headline'].filter(Boolean) : [];
    diag.hidden = !missing.length;
    if (missing.length) diag.replaceChildren(el('p', { text: `Couldn’t read this profile’s ${missing.join(', ')}. LinkedIn may have changed its layout — scroll the page once and Re-analyze, or copy the report below and share it.` }), diagButton());
  } catch (e) {
    // Shown in the top card so it stays visible even before any analysis exists.
    const box = $('analyze-error');
    box.replaceChildren(el('p', {}, el('strong', { text: 'Couldn’t analyze this page. ' }), e.message), diagButton());
    box.hidden = false;
  } finally {
    setBusy(btn, false);
    renderTarget();
  }
}

function rerankHooks(resetSelection) {
  state.hooks = rankHooks(state.user, state.target, { goal: $('sel-goal').value, research: activeResearch() });
  if (resetSelection || !state.selected.size) state.selected = new Set(state.hooks.top.map((h) => h.id));
  renderHooks();
}

function hookItem(h) {
  const checked = state.selected.has(h.id);
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => {
    if (input.checked) {
      if (state.selected.size >= 3) {
        input.checked = false;
        return;
      }
      state.selected.add(h.id);
    } else state.selected.delete(h.id);
    updateGenerateState();
  });
  const ev = [];
  if (h.evidence?.target) ev.push(el('div', { class: 'hook-ev' }, el('b', { text: 'Them: ' }), h.evidence.target));
  if (h.evidence?.user) ev.push(el('div', { class: 'hook-ev' }, el('b', { text: 'You: ' }), h.evidence.user));
  return el('li', {}, el('label', { class: 'hook' }, input, el('div', {}, el('div', { class: 'hook-title' }, h.title, el('span', { class: 'badge', text: h.type.replace(/_/g, ' ') })), ev)));
}

function renderHooks() {
  const top = state.hooks.top;
  const rest = state.hooks.all.filter((h) => !top.includes(h));
  $('hooks').replaceChildren(...(top.length ? top.map(hookItem) : [el('li', { class: 'muted small', text: 'No strong hooks found — the message will lean on their headline and your background.' })]));
  $('more-hooks').replaceChildren(...rest.map(hookItem));
  $('more-hooks-wrap').hidden = !rest.length;
  updateGenerateState();
}

function engineInfo() {
  const s = state.settings;
  const provider = s.provider;
  if (provider === 'local') return { llm: false, note: 'Using local templates (no AI). Add a Gemini key in Settings for more natural drafts.' };
  if (!s.apiKeys[provider]) return { llm: false, note: `No ${PROVIDERS[provider].label} key set — using local templates. Add your key in Settings.` };
  if (!s.llmConsent) return { llm: false, note: 'AI generation is off until you tick the consent box in Settings — using local templates.' };
  return { llm: true, note: `Generating with ${PROVIDERS[provider].label} (${s.models[provider]}). Your synced profile, About-me note and this page’s text are sent to it.${provider === 'gemini' ? ' On the free tier a draft can take 20–60s.' : provider === 'groq' ? ' Groq’s free tier is fast — usually a few seconds.' : ''}` };
}

function updateGenerateState() {
  $('btn-generate').disabled = !state.target;
  $('engine-note').textContent = engineInfo().note + (state.modelNotice ? ` ${state.modelNotice}` : '');
}

function showGenError(message, actions = []) {
  const box = $('gen-error');
  box.replaceChildren(...[el('p', { text: message }), actions.length ? el('div', { class: 'actions' }, actions) : null].filter(Boolean));
  box.hidden = false;
}

function currentOpts() {
  return {
    user: state.user,
    target: state.target,
    hooks: state.hooks.all.filter((h) => state.selected.has(h.id)),
    goal: $('sel-goal').value,
    tone: $('sel-tone').value,
    length: $('sel-length').value,
    note: state.note,
    recipientName: isCompany() ? $('inp-recipient').value.trim() : '',
    research: activeResearch(),
    matchedDomains: activeResearch() ? matchDomains(state.user, activeResearch().hiringFocus) : [],
  };
}

async function onGenerate() {
  const btn = $('btn-generate');
  $('gen-error').hidden = true;
  const opts = currentOpts();
  state.genOpts = opts;
  await saveSettings({ goal: opts.goal, tone: opts.tone, length: opts.length });
  const info = engineInfo();

  if (!info.llm) {
    setVariants(generateLocal(opts).map((v) => ({ ...v, source: 'local', seed: 0 })));
    return;
  }

  setBusy(btn, true, 'Writing drafts…');
  try {
    const { system, user } = buildPrompt(opts);
    const provider = state.settings.provider;
    const variants = await callProvider({ system, user });
    setVariants(variants.map((v) => ({ ...v, source: provider })));
  } catch (e) {
    showGenError(e.message, [
      el('button', { class: 'btn ghost small', text: 'Use local draft instead', onclick: () => { $('gen-error').hidden = true; setVariants(generateLocal(opts).map((v) => ({ ...v, source: 'local', seed: 0 }))); } }),
    ]);
  } finally {
    setBusy(btn, false);
  }
}

/** Regenerate a single variant card, keeping the others (and their edits). */
async function onRegenerate(i, btn) {
  const opts = state.genOpts || currentOpts();
  const current = state.variants[i];
  const others = state.variants.filter((_, j) => j !== i).map((v) => v.message);
  setBusy(btn, true, '…');
  try {
    let fresh;
    if (current.source !== 'local' && current.source !== 'favorite' && engineInfo().llm) {
      const { system, user } = buildPrompt({ ...opts, count: 1, avoid: [current.message, ...others] });
      const provider = state.settings.provider;
      const [v] = await callProvider({ system, user });
      fresh = { ...v, source: provider };
    } else {
      // Local: rotate the lead hook / call to action until the draft differs.
      let seed = current.seed || 0;
      const slot = Math.min(i, 2);
      for (let tries = 0; tries < 6; tries++) {
        seed += 1;
        const v = generateLocal({ ...opts, seed })[slot] || generateLocal({ ...opts, seed })[0];
        if (v && v.message !== current.message && !others.includes(v.message)) {
          fresh = { ...v, source: 'local', seed };
          break;
        }
      }
      if (!fresh) throw new Error('No different local draft available — pick other hooks or change the goal.');
    }
    state.variants[i] = fresh;
    $('variants').children[i].replaceWith(variantCard(i));
  } catch (e) {
    showGenError(e.message);
  } finally {
    setBusy(btn, false);
  }
}

function setVariants(list) {
  state.variants = list;
  renderVariants();
}

function sourceLabel(src) {
  return src === 'local' ? 'local templates' : src === 'favorite' ? 'a saved draft' : PROVIDERS[src]?.label || src;
}

function renderVariants() {
  const sources = [...new Set(state.variants.map((v) => v.source))];
  $('variants-head').replaceChildren(
    state.variants.length ? el('p', { class: 'muted small', text: `Drafted with ${sources.map(sourceLabel).join(' + ')}. Review before sending — nothing is sent automatically.` }) : null
  );
  $('variants').replaceChildren(...state.variants.map((_, i) => variantCard(i)));
}

function corpus() {
  const opts = state.genOpts || currentOpts();
  return buildCorpus(state.user, state.target, state.note, opts.recipientName, (opts.hooks || []).map((h) => h.evidence), opts.research);
}

/** Fact-check box: highlights names/numbers not found in either profile. */
function renderFactCheck(box, text) {
  const flags = factCheck(text, corpus());
  if (!flags.length) {
    box.className = 'fact ok';
    box.replaceChildren('✓ Every name and number appears in your profile or theirs.');
    return;
  }
  box.className = 'fact warn';
  box.replaceChildren(
    el('div', { class: 'fact-title', text: `⚠ ${flags.length} detail${flags.length === 1 ? '' : 's'} not found in either profile — check before sending:` }),
    el('div', { class: 'chips' }, flags.map((f) => el('span', { class: 'chip flag', text: `${f.kind === 'number' ? '#' : ''}${f.term}` }))),
    el('div', { class: 'preview' }, segments(text, flags).map((s) => (s.flagged ? el('mark', { class: 'flag', text: s.text }) : document.createTextNode(s.text))))
  );
}

function variantCard(i) {
  const v = state.variants[i];
  const max = (LENGTHS[(state.genOpts || currentOpts()).length] || LENGTHS.dm).maxChars;
  const ta = el('textarea', { 'aria-label': `Message variant ${i + 1}` });
  ta.value = v.message;
  const count = el('span', { class: 'count' });
  const fact = el('div', { class: 'fact' });
  const star = el('button', { class: 'btn ghost small star', type: 'button', title: 'Save as a reusable draft' });
  const isSaved = () => {
    const tpl = toTemplate(ta.value, state.target, (state.genOpts || currentOpts()).recipientName);
    return state.favorites.some((f) => f.template === tpl);
  };
  const updateStar = () => {
    const on = isSaved();
    star.textContent = on ? '★ Saved' : '☆ Save';
    star.classList.toggle('on', on);
  };
  const update = () => {
    count.textContent = `${ta.value.length}/${max}`;
    count.classList.toggle('over', ta.value.length > max);
    updateStar();
  };
  let factTimer = null;
  ta.addEventListener('input', () => {
    v.message = ta.value; // keep edits when another card is regenerated
    update();
    clearTimeout(factTimer);
    factTimer = setTimeout(() => renderFactCheck(fact, ta.value), 250);
  });
  update();
  renderFactCheck(fact, ta.value);

  star.addEventListener('click', async () => {
    if (isSaved()) return;
    const opts = state.genOpts || currentOpts();
    state.favorites = await addFavorite({
      template: toTemplate(ta.value, state.target, opts.recipientName),
      angle: v.angle,
      why: v.why,
      goal: opts.goal,
      tone: opts.tone,
      length: opts.length,
      entityType: state.target?.entityType || 'person',
    });
    renderFavCount();
    updateStar();
  });

  const copy = el('button', { class: 'btn primary small', text: 'Copy', type: 'button' });
  copy.addEventListener('click', () => copyText(ta.value, copy));
  const regen = el('button', { class: 'btn ghost small', text: '↻ Regenerate', type: 'button', title: 'Write a different version of just this one' });
  regen.addEventListener('click', () => onRegenerate(i, regen));

  return el(
    'div',
    { class: 'card variant' },
    el('div', { class: 'row-between' }, el('span', { class: 'variant-angle', text: `${i + 1}. ${v.angle || 'Variant'}` }), count),
    ta,
    fact,
    el('div', { class: 'row-between' }, el('span', { class: 'muted small', text: 'Edit freely, then paste.' }), el('div', { class: 'variant-actions' }, regen, star, copy)),
    v.why ? el('div', { class: 'why' }, el('b', { text: 'Why this works: ' }), v.why) : null
  );
}

// ---------------------------------------------------------------------------
// Company research (for a person: the company they currently work at)
// ---------------------------------------------------------------------------

function researchCompanyName() {
  const typed = $('inp-research-company').value.trim();
  if (typed) return typed;
  if (!state.target) return '';
  return state.target.entityType === 'company' ? state.target.name : state.target.currentCompany || '';
}

function webResearch() {
  const name = researchCompanyName();
  return (name && state.research.get(name.toLowerCase())) || null;
}

/**
 * Web research (reused across people at the same company) combined with
 * what the company's own Jobs tab shows, when we have read it.
 */
function activeResearch() {
  const web = webResearch();
  const page = state.target?.entityType === 'company' ? researchFromPage(state.target) : null;
  if (web && page) return { ...web, hiringFocus: web.hiringFocus.concat(page.hiringFocus.filter((d) => !web.hiringFocus.some((x) => x.domain === d.domain))) };
  return web || page;
}

/** Provider used to summarise Tavily results: Groq when a key is saved (free, fast), else the selected one, else any. */
function summarizerProvider() {
  const s = state.settings;
  if (s.apiKeys.groq) return 'groq';
  if (s.provider !== 'local' && s.apiKeys[s.provider]) return s.provider;
  return ['gemini', 'openai', 'anthropic', 'grok'].find((p) => s.apiKeys[p]) || '';
}

function researchEngines() {
  const s = state.settings;
  const primary =
    state.target?.entityType === 'company'
      ? ['tavily', s.provider === 'gemini' ? 'gemini' : 'groq', s.provider === 'gemini' ? 'groq' : 'gemini'] // company pages: Tavily + page content first
      : s.provider === 'gemini'
        ? ['gemini', 'tavily', 'groq']
        : ['groq', 'tavily', 'gemini'];
  return primary.filter((k) => (k === 'tavily' ? s.apiKeys.tavily && summarizerProvider() : s.apiKeys[k]));
}

function researchAvailability() {
  const s = state.settings;
  const engines = researchEngines();
  if (!engines.length) return { ok: false, why: 'Web research needs a free Groq or Gemini key (or a free Tavily key plus any AI key). Add one in Settings.' };
  if (!s.llmConsent) return { ok: false, why: 'Tick the consent box in Settings to enable web research.' };
  const label = { groq: 'Groq web search', gemini: 'Gemini + Google Search', tavily: 'Tavily' };
  return { ok: true, why: `Searches the web for this company only — no profile text is sent. Tries ${engines.map((k) => label[k]).join(', then ')}. Results are saved for 7 days.` };
}

/**
 * Web research with quota-friendly fallbacks: saved copy (7 days) → Gemini
 * (auto model) → Groq web search when Gemini is rate-limited or unavailable.
 */
async function runResearch(company, { force = false } = {}) {
  if (!force) {
    const cached = await getCachedResearch(company.name);
    if (cached) return cached;
  }
  const s = state.settings;
  const summarize = (prompt) => {
    const p = summarizerProvider();
    const run = (model) => completeJSON({ provider: p, apiKey: s.apiKeys[p], model, prompt });
    return AUTO_MODEL_PROVIDERS.includes(p) ? withModel(p, run) : run(s.models[p]);
  };
  const engines = {
    groq: { label: 'Groq', run: () => researchWithGroq({ apiKey: s.apiKeys.groq, company }) },
    gemini: { label: 'Gemini', run: () => withGeminiModel((model) => researchCompany({ apiKey: s.apiKeys.gemini, model, company })) },
    tavily: { label: 'Tavily', run: () => researchWithTavily({ tavilyKey: s.apiKeys.tavily, company, summarize, pageContext: companyPageContext() }) },
  };
  // Try each engine the user has keys for; report what each said if all fail.
  const order = researchEngines();
  if (!order.length) throw new LLMError('Add a free Groq or Gemini key (or a Tavily key) in Settings to research companies.');
  const errors = [];
  for (const k of order) {
    try {
      const r = await engines[k].run();
      if (errors.length) modelNotice(`${errors.map((e) => `${e.label}: ${e.err.message.replace(/\.$/, '')}`).join(' · ')} — so ${engines[k].label} researched it instead.`);
      await cacheResearch(company.name, r);
      return r;
    } catch (err) {
      errors.push({ label: engines[k].label, err });
    }
  }
  if (errors.length === 1) throw errors[0].err;
  throw new LLMError(`Research failed with every engine. ${errors.map((e) => `${e.label}: ${e.err.message}`).join(' | ')}${s.apiKeys.tavily ? '' : ' Tip: a free Tavily key in Settings adds a dependable backup.'}`);
}

function renderResearch() {
  if (!state.target) return;
  const company = state.target.entityType === 'company';
  const name = researchCompanyName();
  if (!$('inp-research-company').value) $('inp-research-company').value = name;
  $('research-title').textContent = company ? `2. Research${name ? `: ${name}` : ''}` : name ? `Research: ${name}` : 'Company research';
  $('research-intro').textContent = company
    ? 'What the company does, what it’s hiring for most, and where it hires from — matched against your background.'
    : `Research the company ${state.target.name.split(' ')[0]} works at: what it’s hiring for most and where it hires from — matched against your background.`;
  const avail = researchAvailability();
  const btn = $('btn-research');
  btn.disabled = !avail.ok || !name;
  btn.textContent = webResearch() ? 'Research again' : `Research ${name || 'company'}`;
  $('research-note').textContent = name ? avail.why : 'No current company found on this profile — type one above.';

  const r = activeResearch();
  const badge = $('research-badge');
  badge.hidden = !r;
  if (r) badge.textContent = webResearch() ? `web · ${r.confidence} confidence${r.hiringFocus.some((d) => d.source === 'page') ? ' + Jobs tab' : ''}` : 'from Jobs tab';
  const web = webResearch();
  if (web) {
    const when = web.cachedAt ? ` · saved ${new Date(web.cachedAt).toLocaleDateString()}` : '';
    $('research-note').textContent = `${web.engine || 'Web research'}${when}. “Research again” fetches fresh results.`;
  }
  $('research-body').replaceChildren(r ? researchView(r) : '');
}

function researchView(r) {
  const matches = matchDomains(state.user, r.hiringFocus);
  const matchSet = new Set(matches.map((d) => d.domain));
  const list = (items) => el('ul', {}, items);
  const section = (title, body) => (body ? [el('h4', { text: title }), body] : []);
  return el(
    'div',
    { class: 'research' },
    r.summary ? el('p', { text: r.summary }) : null,
    el('div', { class: 'chips' }, [r.industry, r.size, r.headquarters].filter(Boolean).map((t) => el('span', { class: 'chip', text: t }))),
    section(
      'Hiring most in',
      r.hiringFocus.length
        ? list(
            r.hiringFocus.map((d) =>
              el(
                'li',
                {},
                el('b', { text: d.domain }),
                matchSet.has(d.domain) ? el('span', { class: 'chip match', text: ' ✓ matches you ' }) : null,
                d.roles.length ? el('div', { class: 'hook-ev', text: d.roles.join(' · ') }) : null,
                d.evidence ? el('div', { class: 'hook-ev', text: d.evidence }) : null
              )
            )
          )
        : el('p', { class: 'hint', text: 'No clear hiring areas found.' })
    ),
    section('Often hires from', r.talentSources.length ? list(r.talentSources.map((t) => el('li', {}, el('b', { text: t.source }), t.evidence ? ` — ${t.evidence}` : ''))) : null),
    section('Recent news', r.recentNews.length ? list(r.recentNews.map((n) => el('li', {}, n.headline, n.date ? el('span', { class: 'muted small', text: ` (${n.date})` }) : null))) : null),
    section('Interview talking points', r.interviewAngles.length ? list(r.interviewAngles.map((a) => el('li', { text: a }))) : null),
    section('Values & culture', r.values.length ? list(r.values.map((v) => el('li', { text: v }))) : null),
    section(
      'Sources',
      r.sources.length ? el('ul', { class: 'sources' }, r.sources.map((src) => el('li', {}, el('a', { href: src.uri, target: '_blank', rel: 'noopener noreferrer', text: src.title })))) : null
    ),
    webResearch() ? el('p', { class: 'hint', text: 'Web results can be wrong or out of date — check anything you quote.' }) : null
  );
}

async function onResearch() {
  const btn = $('btn-research');
  const name = researchCompanyName();
  if (!name) return;
  setBusy(btn, true, 'Researching…');
  $('gen-error').hidden = true;
  try {
    const t = state.target;
    const company =
      t.entityType === 'company' && t.name === name
        ? { name, industry: t.industry, location: t.headquarters, website: t.website, linkedinUrl: t.source.url }
        : { name, location: t.entityType === 'person' ? (t.experience.find((r) => r.isCurrent) || {}).location || '' : '' };
    const r = await runResearch(company, { force: !!webResearch() });
    state.research.set(name.toLowerCase(), r);
    rerankHooks(true);
  } catch (e) {
    showGenError(e.message);
  } finally {
    setBusy(btn, false);
    renderResearch();
    renderApplicationCard();
    renderSteps();
  }
}

/** Company page facts passed to Tavily summarisation alongside the search results. */
function companyPageContext() {
  const t = state.target;
  if (!t || t.entityType !== 'company') return null;
  return {
    name: t.name, tagline: t.tagline, industry: t.industry, headquarters: t.headquarters, size: t.companySize,
    founded: t.founded, website: t.website, specialties: t.specialties, overview: String(t.about || '').slice(0, 1500),
    openJobsOnLinkedIn: (t.jobs || []).slice(0, 15).map((j) => j.title),
  };
}

// ---------------------------------------------------------------------------
// Draft Application (company pages) — written with Groq when a Groq key is saved
// ---------------------------------------------------------------------------

function applicationProvider() {
  const s = state.settings;
  if (s.apiKeys.groq) return 'groq';
  return s.provider !== 'local' && s.apiKeys[s.provider] ? s.provider : ['gemini', 'openai', 'anthropic', 'grok'].find((p) => s.apiKeys[p]) || '';
}

function renderApplicationCard() {
  const card = $('application-card');
  const company = state.target?.entityType === 'company';
  card.hidden = !company;
  if (!company) return;
  const p = applicationProvider();
  const btn = $('btn-draft-application');
  $('application-engine').textContent = p ? PROVIDERS[p].label : 'no AI key';
  btn.disabled = !p || !state.settings.llmConsent;
  if (!state.application) {
    $('application-out').replaceChildren(
      !p ? el('p', { class: 'hint', text: 'Add a free Groq key in Settings to draft applications.' })
      : !state.settings.llmConsent ? el('p', { class: 'hint', text: 'Tick the consent box in Settings to use AI drafting.' })
      : el('p', { class: 'hint', text: webResearch() ? 'Research is ready — your application will use it.' : 'Waiting for step 2 (research) gives a sharper application.' })
    );
  }
}

async function onDraftApplication({ regenerate = false } = {}) {
  const btn = $('btn-draft-application');
  const provider = applicationProvider();
  if (!provider) return;
  setBusy(btn, true, 'Writing application…');
  $('gen-error').hidden = true;
  try {
    const research = activeResearch();
    const { system, user } = buildApplicationPrompt({
      user: state.user,
      company: state.target,
      research,
      matchedDomains: research ? matchDomains(state.user, research.hiringFocus) : [],
      note: state.note,
      recipientName: $('inp-recipient').value.trim(),
      tone: $('sel-app-tone').value,
      avoid: regenerate && state.application ? state.application.body : '',
    });
    const ask = (sys, prompt) => {
      const call = (model) => completeJSON({ provider, apiKey: state.settings.apiKeys[provider], model, prompt, system: sys }).then(parseApplication);
      return AUTO_MODEL_PROVIDERS.includes(provider) ? withModel(provider, call) : call(state.settings.models[provider]);
    };
    let app = await ask(system, user);
    // Keep it within LinkedIn's message limit: ask for a shorter version (at most twice).
    for (let i = 0; i < 2 && app.body.length > MAX_APPLICATION_CHARS; i++) {
      setBusy(btn, true, `Shortening to ${MAX_APPLICATION_CHARS} characters…`);
      const sp = buildShortenPrompt(app.body);
      const shorter = await ask(sp.system, sp.user);
      if (shorter.body.length < app.body.length) app = { ...app, ...shorter, subject: shorter.subject || app.subject, why: app.why || shorter.why, roleArea: app.roleArea || shorter.roleArea };
    }
    state.application = app;
    state.application.provider = provider;
    renderApplication();
    renderSteps();
  } catch (e) {
    showGenError(e.message);
    $('gen-error').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } finally {
    setBusy(btn, false);
    btn.textContent = state.application ? 'Draft a new application message' : 'Draft Application Message';
  }
}

/** "Shorten to 700" — rewrite the current (possibly edited) message under the limit. */
async function onShortenApplication(btn) {
  const provider = applicationProvider();
  if (!provider || !state.application) return;
  setBusy(btn, true, 'Shortening…');
  try {
    const sp = buildShortenPrompt(state.application.body);
    const call = (model) => completeJSON({ provider, apiKey: state.settings.apiKeys[provider], model, prompt: sp.user, system: sp.system }).then(parseApplication);
    const shorter = AUTO_MODEL_PROVIDERS.includes(provider) ? await withModel(provider, call) : await call(state.settings.models[provider]);
    state.application = { ...state.application, body: shorter.body };
    renderApplication();
  } catch (e) {
    showGenError(e.message);
  } finally {
    setBusy(btn, false);
  }
}

function renderApplication() {
  const a = state.application;
  const subject = el('input', { 'aria-label': 'Subject' });
  subject.value = a.subject;
  subject.addEventListener('input', () => (a.subject = subject.value));
  const body = el('textarea', { 'aria-label': 'Application', class: 'application-body' });
  body.value = a.body;
  const count = el('span', { class: 'count' });
  const fact = el('div', { class: 'fact' });
  const shortenBtn = el('button', { class: 'btn ghost small', type: 'button', text: `Shorten to ${MAX_APPLICATION_CHARS}` });
  shortenBtn.addEventListener('click', () => onShortenApplication(shortenBtn));
  const update = () => {
    const n = body.value.length;
    count.textContent = `${n} / ${MAX_APPLICATION_CHARS} characters · LinkedIn limit ${LINKEDIN_MESSAGE_LIMIT}`;
    count.classList.toggle('warn', n > MAX_APPLICATION_CHARS && n <= LINKEDIN_MESSAGE_LIMIT);
    count.classList.toggle('over', n > LINKEDIN_MESSAGE_LIMIT);
    shortenBtn.hidden = n <= MAX_APPLICATION_CHARS;
  };
  let t = null;
  body.addEventListener('input', () => {
    a.body = body.value;
    update();
    clearTimeout(t);
    t = setTimeout(() => renderFactCheck(fact, `${subject.value}\n${body.value}`), 250);
  });
  update();
  renderFactCheck(fact, `${a.subject}\n${a.body}`);
  const copyBody = el('button', { class: 'btn primary small', type: 'button', text: 'Copy message' });
  copyBody.addEventListener('click', () => copyText(body.value, copyBody));
  const copyAll = el('button', { class: 'btn ghost small', type: 'button', text: 'Copy subject + message' });
  copyAll.addEventListener('click', () => copyText(`Subject: ${subject.value}\n\n${body.value}`, copyAll));
  const regen = el('button', { class: 'btn ghost small', type: 'button', text: '↻ Regenerate' });
  regen.addEventListener('click', () => onDraftApplication({ regenerate: true }));
  $('application-out').replaceChildren(
    el('label', { class: 'field' }, el('span', { text: 'Subject' }), subject),
    el('label', { class: 'field' }, el('span', { text: `Message${a.roleArea ? ` — pitched for ${a.roleArea}` : ''}` }), body),
    el('div', { class: 'row-between' }, count, el('div', { class: 'variant-actions' }, shortenBtn, regen, copyAll, copyBody)),
    fact,
    a.why ? el('div', { class: 'why' }, el('b', { text: 'Why this works: ' }), a.why) : null,
    el('p', { class: 'hint', text: `Written with ${PROVIDERS[a.provider]?.label || a.provider}. Review it, attach your CV, and send it yourself.` })
  );
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

function renderFavorites() {
  const list = $('favorites-list');
  if (!state.favorites.length) {
    list.replaceChildren(el('div', { class: 'card empty', text: 'No saved drafts yet. Press ☆ Save on any draft you like.' }));
    return;
  }
  const recipient = isCompany() ? $('inp-recipient').value.trim() : '';
  const canUse = !!state.target;
  list.replaceChildren(
    ...state.favorites.map((f) => {
      const text = canUse ? fillTemplate(f.template, state.target, recipient) : f.template;
      const use = el('button', { class: 'btn primary small', type: 'button', text: canUse ? `Use for ${state.target.name.split(' ')[0]}` : 'Use', disabled: !canUse, title: canUse ? '' : 'Analyze a profile or company first' });
      use.addEventListener('click', () => {
        state.genOpts = state.genOpts || currentOpts();
        state.variants.unshift({ angle: `Saved: ${f.angle || 'draft'}`, message: text, why: f.why || '', hooksUsed: [], source: 'favorite', seed: 0 });
        closeOverlay();
        renderVariants();
        $('variants').scrollIntoView({ behavior: 'smooth' });
      });
      const copy = el('button', { class: 'btn ghost small', type: 'button', text: 'Copy' });
      copy.addEventListener('click', () => copyText(text, copy));
      const del = el('button', { class: 'btn danger small', type: 'button', text: 'Delete' });
      del.addEventListener('click', async () => {
        state.favorites = await removeFavorite(f.id);
        renderFavCount();
        renderFavorites();
      });
      return el(
        'div',
        { class: 'card' },
        el('div', { class: 'chips' },
          el('span', { class: 'chip', text: GOAL_LABEL[f.goal] || f.goal || 'Draft' }),
          f.tone ? el('span', { class: 'chip', text: f.tone }) : null,
          el('span', { class: 'chip', text: f.entityType === 'company' ? 'company' : 'person' }),
          el('span', { class: 'chip', text: new Date(f.savedAt).toLocaleDateString() })),
        el('div', { class: 'fav-text', text }),
        canUse ? el('p', { class: 'hint', text: 'Review it: details from the original draft may not apply to this person.' }) : null,
        el('div', { class: 'actions' }, use, copy, del)
      );
    })
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function renderSettings() {
  const s = state.settings;
  $('sel-provider').value = s.provider;
  const p = s.provider;
  const isLLM = p !== 'local';
  $('provider-fields').hidden = !isLLM;
  if (isLLM) {
    const meta = PROVIDERS[p];
    const saved = s.apiKeys[p];
    $('key-label').textContent = `${meta.label} API key`;
    // A saved key is never put back into the input — only a masked preview is shown.
    $('inp-key').value = '';
    $('inp-key').type = 'password';
    $('inp-key').placeholder = saved ? 'Paste a new key to replace the saved one' : `Paste your key (${meta.keyHint})`;
    $('btn-toggle-key').textContent = 'Show';
    $('key-saved').textContent = saved ? `Saved key: ${maskKey(saved)}` : 'No key saved yet.';
    $('btn-remove-key').hidden = !saved;
    $('key-link').href = meta.keyUrl;
    $('key-link').textContent = `Get a ${meta.label} key ↗`;
    $('inp-model').value = s.models[p];
    $('model-list').replaceChildren(...meta.models.map((m) => el('option', { value: m })));
    $('chk-consent').checked = !!s.llmConsent;
    $('key-status').textContent = '';
  }
  $('chk-fab').checked = s.showFab !== false;
  $('inp-tavily').value = '';
  $('tavily-saved').textContent = s.apiKeys.tavily ? `Saved key: ${maskKey(s.apiKeys.tavily)}` : 'No Tavily key saved (optional).';
  $('btn-remove-tavily').hidden = !s.apiKeys.tavily;
  $('inp-me-name').value = s.me.name;
  $('inp-me-id').value = s.me.linkedinId;
  $('me-status').textContent = s.me.name ? '' : 'Required before you can sync.';
  $('settings-sync-state').textContent = state.user
    ? `${state.user.name} · synced ${fmtDate(state.user.syncedAt)} · ${state.user.experience.length} roles, ${state.user.skills.length} skills`
    : 'Nothing synced yet. Open your LinkedIn profile and press “Sync My Profile”.';
  $('btn-view-json').disabled = $('btn-delete-profile').disabled = !state.user;
  $('json-view').hidden = true;
  $('note-settings').value = state.note;
}

/**
 * Fill the model picker with the models this key can actually use (Gemini or
 * Groq), and replace the saved model if it isn't among them.
 */
async function syncModelList(provider, refresh = false) {
  try {
    const models = await availableModels(provider, refresh);
    $('model-list').replaceChildren(...models.map((m) => el('option', { value: m.id, label: m.displayName })));
    const current = state.settings.models[provider];
    if (models.length && !models.some((m) => m.id === current)) {
      const next = pickModel(provider, models);
      state.settings = await saveSettings({ models: { [provider]: next } });
      $('inp-model').value = next;
      modelNotice(`“${current}” isn’t available for your key, so the model was set to “${next}”.`);
    } else {
      $('key-status').textContent = `${$('key-status').textContent} ${models.length} models available to your key.`.trim();
    }
  } catch (e) {
    $('key-status').textContent = `✗ ${e.message}`;
  }
}

function openOverlay(view) {
  state.view = view;
  if (view === 'settings') {
    renderSettings();
    show('view-settings');
  } else {
    renderFavorites();
    show('view-favorites');
  }
}

function closeOverlay() {
  state.view = 'main';
  if (state.page && state.target) {
    renderTarget();
  } else refresh();
}

async function saveProviderFields() {
  const p = $('sel-provider').value;
  const patch = { provider: p, llmConsent: $('chk-consent').checked };
  if (p !== 'local') {
    const typed = $('inp-key').value.trim();
    if (typed) patch.apiKeys = { [p]: typed }; // empty input keeps the saved key
    patch.models = { [p]: $('inp-model').value.trim() || PROVIDERS[p].models[0] };
  }
  state.settings = await saveSettings(patch);
}

// ---------------------------------------------------------------------------
// Updates (GitHub: SurdsoN/linkedinDM)
// ---------------------------------------------------------------------------

const UPDATE_KEY = 'lda.update';
const DAY = 24 * 60 * 60 * 1000;

function openUpdater() {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/updater/updater.html') });
}

function renderUpdate(info, err) {
  const version = chrome.runtime.getManifest().version;
  $('update-version').textContent = `Installed: v${version}${info ? ` · Latest: v${info.latest}` : ''}`;
  $('btn-install-update').hidden = !(info && info.newer);
  $('update-status').textContent = err ? `✗ ${err}` : !info ? '' : info.newer ? `Update available: v${info.latest}${info.released ? ` (${info.released})` : ''}` : '✓ You have the latest version.';
  const notes = $('update-notes');
  notes.hidden = !(info && info.newer && info.notes.length);
  if (info) notes.replaceChildren(...info.notes.map((n) => el('li', { text: n })));
  const banner = $('update-banner');
  banner.hidden = !(info && info.newer);
  if (info && info.newer) {
    banner.replaceChildren(el('span', { text: `DM Architect v${info.latest} is available.` }), el('button', { class: 'btn primary small', type: 'button', text: 'Install update', onclick: openUpdater }));
  }
}

async function checkUpdates({ manual = false } = {}) {
  const btn = $('btn-check-update');
  if (manual) setBusy(btn, true, 'Checking…');
  try {
    const info = await checkForUpdate();
    await chrome.storage.local.set({ [UPDATE_KEY]: { at: Date.now(), info } });
    renderUpdate(info);
  } catch (e) {
    if (manual) renderUpdate(null, e.message);
  } finally {
    if (manual) setBusy(btn, false);
  }
}

/** Once a day (quietly): show a banner if a newer version is out. */
async function autoCheckUpdates() {
  const saved = (await chrome.storage.local.get(UPDATE_KEY))[UPDATE_KEY];
  if (saved && saved.info) {
    // Re-evaluate against the running version (it may have just been updated).
    const cur = chrome.runtime.getManifest().version;
    renderUpdate({ ...saved.info, current: cur, newer: compareVersions(saved.info.latest, cur) > 0 });
  }
  if (!saved || Date.now() - saved.at > DAY) checkUpdates();
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

async function init() {
  [state.user, state.settings, state.note, state.favorites] = await Promise.all([getUserProfile(), getSettings(), getUserNote(), getFavorites()]);
  $('sel-goal').value = state.settings.goal;
  $('sel-tone').value = state.settings.tone;
  $('sel-length').value = state.settings.length;
  renderFavCount();

  $('btn-sync').addEventListener('click', onSync);
  $('btn-analyze').addEventListener('click', onAnalyze);
  $('btn-generate').addEventListener('click', onGenerate);
  $('btn-research').addEventListener('click', onResearch);
  $('btn-draft-application').addEventListener('click', () => onDraftApplication());
  $('btn-open-about').addEventListener('click', () => {
    if (state.page?.entityType === 'company') chrome.tabs.update(state.tabId, { url: `https://www.linkedin.com/company/${encodeURIComponent(state.page.slug)}/about/` });
  });
  $('inp-research-company').addEventListener('change', () => {
    if (!state.target) return;
    rerankHooks(true);
    renderResearch();
  });
  document.querySelectorAll('.btn-save-note').forEach((b) => b.addEventListener('click', onSaveNote));
  $('sel-goal').addEventListener('change', () => state.target && rerankHooks(true));
  $('btn-not-target').addEventListener('click', () => openOverlay('settings'));
  $('btn-save-me').addEventListener('click', async () => {
    const name = $('inp-me-name').value.trim().replace(/\s+/g, ' ');
    const rawId = $('inp-me-id').value.trim();
    const id = parseLinkedInId(rawId);
    const status = $('me-status');
    if (name.length < 2) return (status.textContent = '✗ Enter your name as it appears on LinkedIn.');
    if (rawId && !id) return (status.textContent = '✗ That doesn’t look like a LinkedIn profile URL or username (e.g. linkedin.com/in/your-name).');
    state.settings = await saveSettings({ me: { name, linkedinId: id } });
    $('inp-me-id').value = id;
    status.textContent = `Saved ✓${id ? '' : ' — tip: add your username too, for an exact match.'}`;
    renderMeChip();
  });

  $('btn-settings').addEventListener('click', () => (state.view === 'settings' ? closeOverlay() : openOverlay('settings')));
  $('btn-favorites').addEventListener('click', () => (state.view === 'favorites' ? closeOverlay() : openOverlay('favorites')));
  $('btn-close-settings').addEventListener('click', closeOverlay);
  $('btn-close-favorites').addEventListener('click', closeOverlay);
  $('sel-provider').addEventListener('change', async () => {
    state.settings = await saveSettings({ provider: $('sel-provider').value });
    renderSettings();
  });

  // API key: masked while typing; "Show" reveals only what you are typing and re-hides on blur.
  const key = $('inp-key');
  $('btn-toggle-key').addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
  $('btn-toggle-key').addEventListener('click', () => {
    key.type = key.type === 'password' ? 'text' : 'password';
    $('btn-toggle-key').textContent = key.type === 'password' ? 'Show' : 'Hide';
  });
  key.addEventListener('blur', () => {
    key.type = 'password';
    $('btn-toggle-key').textContent = 'Show';
  });
  $('btn-save-key').addEventListener('click', async () => {
    const typed = key.value.trim();
    await saveProviderFields();
    const p = state.settings.provider;
    if (typed) delete modelLists[p]; // new key → new model list
    renderSettings();
    $('key-status').textContent = typed ? 'Key saved ✓' : 'Settings saved ✓';
    if (AUTO_MODEL_PROVIDERS.includes(p) && state.settings.apiKeys[p]) await syncModelList(p);
  });
  $('btn-remove-key').addEventListener('click', async () => {
    const p = state.settings.provider;
    if (!confirm(`Remove the saved ${PROVIDERS[p].label} key from this browser?`)) return;
    state.settings = await saveSettings({ apiKeys: { [p]: '' } });
    renderSettings();
    $('key-status').textContent = 'Key removed.';
  });
  $('chk-consent').addEventListener('change', async () => {
    state.settings = await saveSettings({ llmConsent: $('chk-consent').checked });
  });
  $('chk-fab').addEventListener('change', async () => {
    state.settings = await saveSettings({ showFab: $('chk-fab').checked });
  });
  $('btn-test-key').addEventListener('click', async () => {
    const btn = $('btn-test-key');
    await saveProviderFields();
    renderSettings();
    const p = state.settings.provider;
    setBusy(btn, true, 'Testing…');
    try {
      if (p === 'gemini') {
        // Step 1 — listing models proves the key is valid (fast, no quota).
        const models = await availableModels('gemini', true);
        await syncModelList('gemini');
        const status = $('key-status');
        status.textContent = `✓ Key accepted (${models.length} models). Checking that ${state.settings.models.gemini} answers — free-tier models can take up to ~25s…`;
        // Step 2 — a tiny request to the chosen model, with a short timeout.
        const started = Date.now();
        try {
          await withGeminiModel((model) => pingGemini({ apiKey: state.settings.apiKeys.gemini, model }));
          renderSettings();
          $('key-status').textContent = `✓ Key works with ${state.settings.models.gemini} (answered in ${Math.round((Date.now() - started) / 1000)}s).${state.modelNotice ? ` ${state.modelNotice}` : ''}`;
        } catch (e) {
          if (!e.timeout) throw e;
          renderSettings();
          $('key-status').textContent = `✓ Key works (${models.length} models available), but ${state.settings.models.gemini} didn’t answer the test within 25s. Gemini is slow on the free tier right now; drafts may take up to a minute, or pick a “flash-lite” model for faster replies.`;
        }
        return;
      }
      if (p === 'groq') {
        const models = await availableModels('groq', true); // proves the key (free call)
        await syncModelList('groq');
        $('key-status').textContent = `✓ Key accepted (${models.length} models). Checking ${state.settings.models.groq}…`;
        const started = Date.now();
        await withModel('groq', (model) => testKey({ provider: p, apiKey: state.settings.apiKeys.groq, model }));
        renderSettings();
        $('key-status').textContent = `✓ Key works with ${state.settings.models.groq} (answered in ${Math.round((Date.now() - started) / 1000)}s).${state.modelNotice ? ` ${state.modelNotice}` : ''}`;
        return;
      }
      await testKey({ provider: p, apiKey: state.settings.apiKeys[p], model: state.settings.models[p] });
      $('key-status').textContent = '✓ Key works.';
    } catch (e) {
      $('key-status').textContent = `✗ ${e.message}`;
    } finally {
      setBusy(btn, false);
    }
  });
  $('btn-save-tavily').addEventListener('click', async () => {
    const k = $('inp-tavily').value.trim();
    if (!k) return ($('tavily-status').textContent = 'Paste your Tavily key first.');
    state.settings = await saveSettings({ apiKeys: { tavily: k } });
    renderSettings();
    $('tavily-status').textContent = 'Tavily key saved ✓ — used as a research backup.';
  });
  $('btn-remove-tavily').addEventListener('click', async () => {
    state.settings = await saveSettings({ apiKeys: { tavily: '' } });
    renderSettings();
    $('tavily-status').textContent = 'Tavily key removed.';
  });
  $('btn-clear-research').addEventListener('click', async () => {
    await clearResearchCache();
    state.research.clear();
    $('btn-clear-research').textContent = 'Saved research cleared ✓';
  });
  $('btn-view-json').addEventListener('click', () => {
    const pre = $('json-view');
    pre.hidden = !pre.hidden;
    pre.textContent = JSON.stringify(state.user, null, 2);
  });
  $('btn-delete-profile').addEventListener('click', async () => {
    if (!confirm('Delete your synced profile from this browser?')) return;
    await clearUserProfile();
    state.user = null;
    renderSettings();
    renderMeChip();
  });

  chrome.tabs.onActivated.addListener(() => scheduleRefresh(100));
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId === state.tabId && (info.url || info.status === 'complete')) scheduleRefresh(700);
  });
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes['lda.userProfile']) state.user = changes['lda.userProfile'].newValue || null;
    if (changes['lda.settings']) state.settings = await getSettings();
    if (changes['lda.favorites']) {
      state.favorites = changes['lda.favorites'].newValue || [];
      renderFavCount();
    }
    renderMeChip();
    if (state.target) {
      updateGenerateState();
      renderResearch();
    }
  });

  $('update-repo').href = REPO_URL;
  $('btn-check-update').addEventListener('click', () => checkUpdates({ manual: true }));
  $('btn-install-update').addEventListener('click', openUpdater);
  autoCheckUpdates();

  showStatus({ title: 'Loading…', spinner: true });
  refresh();
}

init();
