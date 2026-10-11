/**
 * chrome.storage.local wrapper.
 *
 * What is stored (locally only, never synced to a server):
 *  - lda.userProfile : the user's own synced profile (JSON from the extractor)
 *  - lda.settings    : provider, model, API keys, UI preferences
 *  - lda.userNote    : the user's own "About me" note (not on their profile)
 *  - lda.research    : company research results (public company info only),
 *                      kept 7 days so the same company isn't searched twice
 *  - lda.favorites   : drafts the user starred, saved as reusable templates —
 *                      the recipient's name is replaced by {{firstName}} etc.,
 *                      so no target profile data is kept
 *
 * What is NOT stored: target profiles. Those live only in the side panel's
 * memory and disappear when the panel closes.
 */

const KEYS = {
  userProfile: 'lda.userProfile',
  settings: 'lda.settings',
  userNote: 'lda.userNote',
  favorites: 'lda.favorites',
  research: 'lda.research',
};

const RESEARCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RESEARCH = 40;

const MAX_FAVORITES = 100;

export const DEFAULT_SETTINGS = {
  me: { name: '', linkedinId: '' }, // who the user is — used to verify "Sync" runs on their own profile
  provider: 'groq', // 'groq' | 'gemini' | 'openai' | 'anthropic' | 'grok' | 'local' — Groq: free tier, fast
  models: {
    gemini: 'gemini-flash-latest', // auto-replaced by the best available model if Google retires it
    openai: 'gpt-5-mini',
    anthropic: 'claude-sonnet-5-5',
    grok: 'grok-4',
    groq: 'openai/gpt-oss-120b', // auto-replaced if Groq retires it
  },
  apiKeys: { gemini: '', openai: '', anthropic: '', grok: '', groq: '', tavily: '' }, // tavily: optional web-search key for research
  llmConsent: false, // user acknowledged that "Generate" sends profile text to the provider
  goal: 'warm',
  tone: 'friendly',
  length: 'dm',
  showFab: true, // floating "DM Architect" button on LinkedIn profile/company pages
};

function get(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, (res) => resolve(res[key])));
}

function set(key, value) {
  return new Promise((resolve, reject) =>
    chrome.storage.local.set({ [key]: value }, () =>
      chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()
    )
  );
}

function remove(key) {
  return new Promise((resolve) => chrome.storage.local.remove(key, resolve));
}

export async function getUserProfile() {
  return (await get(KEYS.userProfile)) || null;
}

/** Save the synced profile, stamping the sync time. */
export async function saveUserProfile(profile) {
  const record = { ...profile, syncedAt: new Date().toISOString() };
  // The ownership block is page-detection debug data; no need to persist it.
  delete record.ownership;
  await set(KEYS.userProfile, record);
  return record;
}

export async function clearUserProfile() {
  await remove(KEYS.userProfile);
}

const SETTINGS_VERSION = 2;

export async function getSettings() {
  const stored = { ...((await get(KEYS.settings)) || {}) };
  // v2: Groq became the default drafting provider (Gemini's free tier was too limited).
  if ((stored.settingsVersion || 1) < 2 && stored.provider === 'gemini') stored.provider = 'groq';
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    me: { ...DEFAULT_SETTINGS.me, ...(stored.me || {}) },
    models: { ...DEFAULT_SETTINGS.models, ...(stored.models || {}) },
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...(stored.apiKeys || {}) },
  };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    me: { ...current.me, ...(patch.me || {}) },
    models: { ...current.models, ...(patch.models || {}) },
    apiKeys: { ...current.apiKeys, ...(patch.apiKeys || {}) },
    settingsVersion: SETTINGS_VERSION,
  };
  await set(KEYS.settings, next);
  return next;
}

/** "AIzaSyD…x9Q2" — enough to recognise a saved key without exposing it. */
export function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 10) return '•'.repeat(k.length);
  return `${k.slice(0, 4)}${'•'.repeat(8)}${k.slice(-4)}`;
}

// --- About me note ---------------------------------------------------------

export async function getUserNote() {
  return (await get(KEYS.userNote)) || '';
}

export async function saveUserNote(text) {
  await set(KEYS.userNote, String(text || '').slice(0, 1500));
}

// --- Favourite drafts ------------------------------------------------------

export async function getFavorites() {
  return (await get(KEYS.favorites)) || [];
}

/**
 * @param {{template:string, angle?:string, why?:string, goal?:string, tone?:string, length?:string, entityType?:string}} fav
 */
export async function addFavorite(fav) {
  const list = await getFavorites();
  const item = { id: `fav_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, savedAt: new Date().toISOString(), ...fav };
  if (list.some((f) => f.template === item.template)) return list; // already saved
  const next = [item, ...list].slice(0, MAX_FAVORITES);
  await set(KEYS.favorites, next);
  return next;
}

export async function removeFavorite(id) {
  const next = (await getFavorites()).filter((f) => f.id !== id);
  await set(KEYS.favorites, next);
  return next;
}

// --- Company research cache (public company info, 7 days) ------------------

export async function getCachedResearch(companyName) {
  const all = (await get(KEYS.research)) || {};
  const hit = all[String(companyName || '').toLowerCase()];
  return hit && Date.now() - hit.at < RESEARCH_TTL_MS ? { ...hit.data, cachedAt: new Date(hit.at).toISOString() } : null;
}

export async function cacheResearch(companyName, data) {
  const all = (await get(KEYS.research)) || {};
  all[String(companyName || '').toLowerCase()] = { at: Date.now(), data };
  const entries = Object.entries(all).filter(([, v]) => Date.now() - v.at < RESEARCH_TTL_MS).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_RESEARCH);
  await set(KEYS.research, Object.fromEntries(entries));
}

export async function clearResearchCache() {
  await remove(KEYS.research);
}
