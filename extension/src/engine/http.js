/**
 * JSON POST/GET helper shared by all AI providers, with user-facing errors.
 *
 * Rate limits (HTTP 429) are classified so the UI can react sensibly:
 *   err.quota = 'minute' | 'daily' | 'none'   (none = model has no free quota)
 *   err.retryAfter = seconds to wait, when the provider says
 */

import { LLMError } from './errors.js';

export const DEFAULT_TIMEOUT_MS = 90000;

function parseDelay(v) {
  const m = String(v || '').match(/^(\d+(?:\.\d+)?)s?$/);
  return m ? Math.ceil(parseFloat(m[1])) : 0;
}

/** Work out what kind of quota a 429 hit (Gemini sends google.rpc details). */
export function classifyQuota(data, headers) {
  const err = (data && data.error) || {};
  const details = Array.isArray(err.details) ? err.details : [];
  const msg = String(err.message || (data && data.message) || '');
  const violations = details.flatMap((d) => d.violations || []);
  const ids = violations.map((v) => `${v.quotaId || ''} ${v.quotaMetric || ''}`).join(' ') + ' ' + msg;
  const retry = details.find((d) => /RetryInfo/.test(d['@type'] || ''));
  let retryAfter = parseDelay(retry && retry.retryDelay) || parseDelay(headers && headers.get && headers.get('retry-after'));
  const zero = violations.some((v) => String(v.quotaValue) === '0') || /limit:\s*0\b/.test(msg);
  const daily = /per\s*day|perday|requests_per_day|RPD|daily/i.test(ids);
  if (!retryAfter) retryAfter = (msg.match(/retry in (\d+(?:\.\d+)?)s/i) || [])[1] ? Math.ceil(parseFloat(msg.match(/retry in (\d+(?:\.\d+)?)s/i)[1])) : 0;
  return { quota: zero ? 'none' : daily ? 'daily' : 'minute', retryAfter };
}

function rateLimitMessage({ quota, retryAfter }, label, model) {
  const who = model ? `${label} (${model})` : label;
  if (quota === 'none') return `${who} has no free-tier quota for this request.`;
  if (quota === 'daily') return `Daily free-tier limit reached for ${who}. It resets every 24h (midnight Pacific for Gemini).`;
  return `${who} rate limit reached — too many requests this minute.${retryAfter ? ` Try again in ${retryAfter}s.` : ' Wait a minute and try again.'}`;
}

/**
 * @param {string} url
 * @param {object} headers
 * @param {object|null} body   null → GET
 * @param {{provider:string, label?:string, model?:string, timeoutMs?:number}} meta
 */
export async function requestJSON(url, headers, body, { provider, label, model, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const name = label || provider;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: body == null ? 'GET' : 'POST',
      headers: body == null ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body == null ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new LLMError(`No answer within ${Math.round(timeoutMs / 1000)}s — the model is slow right now. Try again.`, { provider, timeout: true });
    throw new LLMError(`Network error: ${e.message}`, { provider });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) { /* non-JSON body */ }
  if (!res.ok) {
    const detail = (data && (data.error?.message || data.message)) || text.slice(0, 200);
    if (provider === 'tavily' && (res.status === 432 || res.status === 433)) {
      throw new LLMError(
        res.status === 432
          ? 'Tavily refused the search: your Tavily plan or key usage limit is reached. Check app.tavily.com → Usage (free plan: 1,000 credits a month, plus any per-key limit you set).'
          : 'Tavily refused the search: your pay-as-you-go limit is reached. Check app.tavily.com → Billing.',
        { status: 429, provider, quota: 'daily', detail }
      );
    }
    if (res.status === 429) {
      const q = classifyQuota(data, res.headers);
      throw new LLMError(rateLimitMessage(q, name, model), { status: 429, provider, quota: q.quota, retryAfter: q.retryAfter });
    }
    const friendly =
      (res.status === 400 && /api key/i.test(detail)) || res.status === 401
        ? `Your ${name} API key was rejected. Check it in Settings.`
        : res.status === 403
          ? `Your ${name} key doesn’t have access to ${model ? `“${model}”` : 'this model'}.${detail ? ` ${name} said: “${String(detail).slice(0, 160)}”` : ''}`
          : res.status === 404 || /model.*(not found|does not exist|decommissioned|no longer available)/i.test(detail)
            ? `The model “${model || '?'}” isn’t available for your key (it may have been retired, or not enabled for your account).${detail ? ` ${name} said: “${String(detail).slice(0, 160)}”` : ''}`
            : `${name} error (${res.status}): ${detail}`;
    const status = res.status === 400 && /model.*(not found|does not exist|decommissioned)/i.test(detail) ? 404 : res.status;
    throw new LLMError(friendly, { status, provider, detail });
  }
  return data;
}
