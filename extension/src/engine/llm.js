/**
 * LLM provider client. Called only when the user presses "Generate" with a
 * provider selected; the request goes straight from the browser to that
 * provider with the user's own key. No intermediary server.
 *
 * Gemini is the default: it supports a strict `responseSchema`, so variants
 * always come back in the same structure.
 */

import { RESPONSE_SCHEMA } from './prompt.js';
import { LLMError } from './errors.js';
import { requestJSON } from './http.js';

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    keyHint: 'AIza…',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    // Suggestions only — the real list comes from the API (see gemini-models.js).
    models: ['gemini-flash-latest', 'gemini-flash-lite-latest'],
  },
  openai: { label: 'OpenAI', keyHint: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys', models: ['gpt-5-mini', 'gpt-5', 'gpt-4.1-mini'] },
  anthropic: {
    label: 'Anthropic Claude',
    keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],
  },
  grok: { label: 'xAI Grok', keyHint: 'xai-…', keyUrl: 'https://console.x.ai/', models: ['grok-4', 'grok-3-mini'] },
  // Free tier, no credit card. OpenAI-compatible API; list comes from /models (see groq-models.js).
  groq: {
    label: 'Groq',
    keyHint: 'gsk_…',
    keyUrl: 'https://console.groq.com/keys',
    models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'],
  },
};

export const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

export { LLMError };

/** POST with the shared error handling (quota classification, friendly messages). */
function postJSON(url, headers, body, provider, model, timeoutMs) {
  return requestJSON(url, headers, body, { provider, label: PROVIDERS[provider]?.label || provider, model, timeoutMs });
}

async function callGemini({ apiKey, model, system, user }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const data = await postJSON(
    url,
    { 'x-goog-api-key': apiKey },
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      // Default temperature: newer Gemini models are tuned for it.
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    },
    'gemini',
    model
  );
  const cand = data && data.candidates && data.candidates[0];
  if (!cand) {
    const block = data && data.promptFeedback && data.promptFeedback.blockReason;
    throw new LLMError(block ? `Gemini blocked the request (${block}).` : 'Gemini returned no result.', { provider: 'gemini' });
  }
  if (cand.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason)) {
    throw new LLMError(`Gemini stopped early (${cand.finishReason}). Try again or switch model.`, { provider: 'gemini' });
  }
  return (cand.content?.parts || []).map((p) => p.text || '').join('');
}

async function callOpenAICompatible({ url, apiKey, model, system, user, provider }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
  };
  // Groq: keep reasoning short (saves free-tier tokens) and out of the answer.
  if (provider === 'groq' && /gpt-oss/.test(model)) body.reasoning_effort = 'low';
  else if (provider === 'groq' && /qwen|deepseek|reason/i.test(model)) body.reasoning_format = 'hidden';
  let data;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      data = await postJSON(url, { Authorization: `Bearer ${apiKey}` }, body, provider, model);
      break;
    } catch (e) {
      // Drop an optional parameter the model doesn't support and retry (we parse JSON from text anyway).
      const why = `${e.detail || ''} ${e.message}`;
      if (e.status !== 400) throw e;
      if (body.response_format && /response_format|json/i.test(why)) delete body.response_format;
      else if (body.reasoning_effort && /reasoning_effort/i.test(why)) delete body.reasoning_effort;
      else if (body.reasoning_format && /reasoning_format/i.test(why)) delete body.reasoning_format;
      else throw e;
    }
  }
  return data?.choices?.[0]?.message?.content || '';
}

async function callAnthropic({ apiKey, model, system, user }) {
  const data = await postJSON(
    'https://api.anthropic.com/v1/messages',
    {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required for direct browser (extension) calls.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    {
      model,
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: `${user}\n\nRespond with JSON only: {"variants":[{"angle":"","message":"","why":"","hooksUsed":[]}]}` }],
    },
    'anthropic'
  );
  return (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/** Remove reasoning that some models print before the answer (<think>…</think>). */
export function stripReasoning(raw) {
  return String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '') // unclosed opening tag cut off
    .trim();
}

/** Every balanced {...} block in the text, longest first. */
function jsonObjects(text) {
  const out = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        out.push(text.slice(start, i + 1));
        break;
      }
    }
    if (out.length > 20) break;
  }
  return out.sort((x, y) => y.length - x.length);
}

const LIST_KEYS = ['variants', 'messages', 'drafts', 'options', 'dms', 'results'];
const TEXT_KEYS = ['message', 'text', 'content', 'draft', 'body', 'dm'];

/** Pull the drafts out of a model reply (tolerates code fences, reasoning, alternate key names). */
export function parseVariants(raw) {
  const text = stripReasoning(raw);
  const fenced = (text.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1];
  const candidates = [text, fenced, ...jsonObjects(text)].filter(Boolean);
  for (const c of candidates) {
    let obj;
    try {
      obj = JSON.parse(c);
    } catch (_) {
      continue;
    }
    const list = Array.isArray(obj) ? obj : LIST_KEYS.map((k) => obj && obj[k]).find(Array.isArray);
    if (!Array.isArray(list) || !list.length) continue;
    const variants = list
      .map((v) => (typeof v === 'string' ? { message: v } : v))
      .map((v) => ({ ...v, message: TEXT_KEYS.map((k) => v && v[k]).find((x) => typeof x === 'string' && x.trim()) }))
      .filter((v) => v.message)
      .slice(0, 3)
      .map((v) => ({ angle: String(v.angle || v.title || ''), message: v.message.trim(), why: String(v.why || v.reason || v.rationale || ''), hooksUsed: Array.isArray(v.hooksUsed) ? v.hooksUsed : [] }));
    if (variants.length) return variants;
  }
  throw new LLMError('The model reply was not in the expected format.', { format: true });
}

/**
 * @param {{provider:string, apiKey:string, model:string, system:string, user:string}} req
 * @returns {Promise<Array<{angle,message,why,hooksUsed}>>}
 */
export async function generateWithLLM(req) {
  const { provider, apiKey } = req;
  if (!apiKey) throw new LLMError(`Add your ${PROVIDERS[provider]?.label || provider} API key in Settings.`, { provider });
  let raw;
  switch (provider) {
    case 'gemini':
      raw = await callGemini(req);
      break;
    case 'openai':
      raw = await callOpenAICompatible({ ...req, url: 'https://api.openai.com/v1/chat/completions' });
      break;
    case 'grok':
      raw = await callOpenAICompatible({ ...req, url: 'https://api.x.ai/v1/chat/completions' });
      break;
    case 'groq':
      raw = await callOpenAICompatible({ ...req, url: GROQ_CHAT_URL });
      break;
    case 'anthropic':
      raw = await callAnthropic(req);
      break;
    default:
      throw new LLMError(`Unknown provider: ${provider}`);
  }
  return parseVariants(raw);
}

/**
 * Quick Gemini check for the "Test key" button: a tiny plain-text request
 * (no JSON schema), bounded by a short timeout.
 */
export async function pingGemini({ apiKey, model, timeoutMs = 25000 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const data = await postJSON(url, { 'x-goog-api-key': apiKey }, { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }] }, 'gemini', model, timeoutMs || 25000);
  if (!data || !data.candidates || !data.candidates.length) throw new LLMError('Gemini returned no result to the test.', { provider: 'gemini' });
  return true;
}

/** Cheap call to confirm a key works (used by the "Test key" button). */
export async function testKey({ provider, apiKey, model }) {
  const variants = await generateWithLLM({
    provider,
    apiKey,
    model,
    system: 'Return JSON only.',
    user: 'Return {"variants":[{"angle":"test","message":"ok","why":"ok","hooksUsed":[]}]}',
  });
  return variants.length > 0;
}

/**
 * Plain JSON completion with any provider (used to summarise search results).
 * @returns {Promise<string>} the model's raw text (expected to be JSON)
 */
export async function completeJSON({ provider, apiKey, model, prompt, system = 'You are a careful research assistant. Return only a JSON object. Never invent facts.' }) {
  if (!apiKey) throw new LLMError(`Add your ${PROVIDERS[provider]?.label || provider} API key in Settings.`, { provider });
  switch (provider) {
    case 'gemini': {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const data = await postJSON(url, { 'x-goog-api-key': apiKey }, { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }, 'gemini', model);
      return (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    }
    case 'openai':
    case 'grok':
    case 'groq': {
      const url = provider === 'groq' ? GROQ_CHAT_URL : provider === 'grok' ? 'https://api.x.ai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
      return callOpenAICompatible({ url, apiKey, model, system, user: prompt, provider });
    }
    case 'anthropic': {
      const data = await postJSON('https://api.anthropic.com/v1/messages', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, { model, max_tokens: 2000, system, messages: [{ role: 'user', content: prompt }] }, 'anthropic', model);
      return (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    default:
      throw new LLMError(`Unknown provider: ${provider}`);
  }
}
