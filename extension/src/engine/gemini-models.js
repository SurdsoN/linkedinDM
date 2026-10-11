/**
 * Gemini model discovery.
 *
 * Google retires Gemini model names regularly (e.g. gemini-2.5-flash), and a
 * retired name returns 404 "model not found". Instead of hard-coding one, we
 * ask the API which models this key can use (ListModels — free, no quota) and
 * pick the best text model, preferring Flash: it is the family available on
 * the free tier.
 */

import { LLMError } from './errors.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Not suitable for writing messages (embeddings, images, audio, live, etc.).
const EXCLUDE = /(embed|embedding|aqa|imagen|image|vision|tts|audio|native-audio|live|veo|robotics|computer-use|learnlm|gemma|nano|banana|thinking-exp|deep-research)/i;

/** @returns {Promise<Array<{id:string, displayName:string, inputTokenLimit:number}>>} */
export async function listGeminiModels(apiKey) {
  if (!apiKey) throw new LLMError('Add your Gemini API key first.', { provider: 'gemini' });
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    let res;
    try {
      res = await fetch(`${BASE}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { headers: { 'x-goog-api-key': apiKey } });
    } catch (e) {
      throw new LLMError(`Network error: ${e.message}`, { provider: 'gemini' });
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = (data && data.error && data.error.message) || `HTTP ${res.status}`;
      throw new LLMError(
        res.status === 400 || res.status === 401 || res.status === 403 || /api key/i.test(detail)
          ? 'Your Gemini API key was rejected. Copy it again from Google AI Studio and save it.'
          : `Couldn’t list Gemini models: ${detail}`,
        { status: res.status, provider: 'gemini' }
      );
    }
    for (const m of (data && data.models) || []) {
      const id = String(m.name || '').replace(/^models\//, '');
      if (!id || !(m.supportedGenerationMethods || []).includes('generateContent')) continue;
      if (EXCLUDE.test(id)) continue;
      out.push({ id, displayName: m.displayName || id, inputTokenLimit: m.inputTokenLimit || 0 });
    }
    pageToken = data && data.nextPageToken;
    if (!pageToken) break;
  }
  return rankGeminiModels(out);
}

/**
 * Best first:
 *  1. "-latest" aliases (Google keeps them pointed at a current model)
 *  2. Flash > Flash-Lite > Pro (Pro is paid-only on the free tier)
 *  3. newer version number first
 *  4. stable before preview/experimental of the same version
 */
export function rankGeminiModels(models) {
  const score = (id) => {
    const s = id.toLowerCase();
    const version = parseFloat((s.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
    const family = /flash-lite|flash-8b/.test(s) ? 2 : /flash/.test(s) ? 3 : /pro/.test(s) ? 1 : 0;
    const latest = /-latest$/.test(s) ? 1 : 0;
    const unstable = /(preview|exp|experimental)/.test(s) ? 1 : 0;
    const dated = /-\d{2,}(-\d{2})?$/.test(s) || /-\d{3}$/.test(s) ? 1 : 0; // pinned snapshots like -001, -09-2025
    return latest * 1000 + family * 100 + version * 10 - unstable * 3 - dated;
  };
  return models
    .map((m) => (typeof m === 'string' ? { id: m, displayName: m } : m))
    .filter((m) => /gemini/i.test(m.id))
    .sort((a, b) => score(b.id) - score(a.id) || a.id.localeCompare(b.id));
}

/** Pick the best model, optionally skipping ones known to fail. */
export function pickGeminiModel(models, exclude = []) {
  const skip = new Set(exclude.map((x) => String(x).toLowerCase()));
  const m = rankGeminiModels(models).find((x) => !skip.has(x.id.toLowerCase()));
  return m ? m.id : '';
}

/** True for errors that mean "this model name doesn't work for this key". */
export function isModelUnavailable(err) {
  return !!err && ['gemini', 'groq'].includes(err.provider) && (err.status === 404 || /not found|no longer available|is not supported|decommissioned/i.test(err.message || ''));
}

/** A 429 where waiting a minute won't help, but another model (own quota) might. */
export function isModelQuotaExhausted(err) {
  return !!err && err.status === 429 && (err.quota === 'daily' || err.quota === 'none');
}

/** The model answered, but not in a usable shape — a different model usually does. */
export function isBadModelReply(err) {
  return !!err && err.format === true;
}
