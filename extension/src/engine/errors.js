/** Error type shared by the LLM and research clients (user-facing message). */
export class LLMError extends Error {
  /**
   * @param {string} message
   * @param {{status?:number, provider?:string, timeout?:boolean, quota?:'minute'|'daily'|'none', retryAfter?:number, detail?:string}} [opts]
   */
  constructor(message, { status, provider, timeout, quota, retryAfter, detail, format } = {}) {
    super(message);
    this.status = status;
    this.provider = provider;
    this.timeout = !!timeout;
    this.quota = quota || null;
    this.retryAfter = retryAfter || 0;
    this.detail = detail || '';
    this.format = !!format; // reply couldn't be parsed — another model may do better
  }
}
