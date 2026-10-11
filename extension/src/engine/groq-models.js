/**
 * Groq model discovery (free tier). Groq retires models too, so we list what
 * the key can use (GET /models, free) and pick a strong chat model.
 */

import { requestJSON } from './http.js';

// Speech, safety classifiers, TTS and agentic systems aren't for writing drafts.
const EXCLUDE = /(whisper|guard|tts|playai|orpheus|distil|compound|safeguard|embed|vision-preview)/i;

// Preferred order when available (strong, JSON-capable, generous free limits).
const PREFERRED = [
  /^openai\/gpt-oss-120b$/,
  /^openai\/gpt-oss-20b$/, // same family: reliable JSON, separate daily quota
  /^llama-3\.3-70b-versatile$/,
  /llama-4-maverick/,
  /kimi-k2/,
  /qwen3?.*32b|qwen3/,
  /llama-4-scout/,
  /^llama-3\.1-8b-instant$/,
];

export async function listGroqModels(apiKey) {
  const data = await requestJSON('https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${apiKey}` }, null, { provider: 'groq', label: 'Groq', timeoutMs: 15000 });
  return rankGroqModels(((data && data.data) || []).filter((m) => m && m.id && m.active !== false).map((m) => m.id));
}

export function rankGroqModels(ids) {
  const score = (id) => {
    const i = PREFERRED.findIndex((re) => re.test(id));
    return i === -1 ? 100 : i;
  };
  return ids
    .filter((id) => !EXCLUDE.test(id))
    .sort((a, b) => score(a) - score(b) || a.localeCompare(b))
    .map((id) => ({ id, displayName: id }));
}

export function pickGroqModel(models, exclude = []) {
  const skip = new Set(exclude.map((x) => String(x).toLowerCase()));
  const m = rankGroqModels(models.map((x) => (typeof x === 'string' ? x : x.id))).find((x) => !skip.has(x.id.toLowerCase()));
  return m ? m.id : '';
}
