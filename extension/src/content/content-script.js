/**
 * Content script — runs on linkedin.com pages.
 *
 * It reads nothing on its own. It only answers requests from the side panel,
 * which are always triggered by a user click:
 *   LDA_PING     → quick page classification (profile? own? name?)
 *   LDA_EXTRACT  → full extraction of the page that is currently open
 *
 * It also shows a small floating "DM Architect" button on profile and
 * company pages; clicking it asks the service worker to open the side panel.
 * The button can be hidden for the page (×) or turned off in Settings.
 *
 * It never navigates, clicks, fetches other profiles, or sends messages.
 */
(function () {
  'use strict';
  if (window.__ldaContentLoaded) return; // guard against double injection
  window.__ldaContentLoaded = true;

  const X = globalThis.LDAExtractor;

  function ping(ctx) {
    const url = X.parseProfileUrl(location.href);
    return {
      url: location.href,
      ...url,
      name: url.isProfile ? X.pageName(document) : '',
      ownership: url.isProfile ? X.detectOwnProfile(document, ctx) : null,
    };
  }

  let busy = false;

  async function extract(options) {
    if (busy) throw new Error('Already reading this page — one moment.');
    busy = true;
    try {
      if (options && options.loadAll !== false) await X.ensureSectionsLoaded(document);
      return X.extractProfile(document, options && options.ctx);
    } finally {
      busy = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('LDA_')) return false;
    (async () => {
      try {
        if (msg.type === 'LDA_PING') sendResponse({ ok: true, page: ping(msg.ctx) });
        else if (msg.type === 'LDA_EXTRACT') sendResponse({ ok: true, profile: await extract(msg.options) });
        else if (msg.type === 'LDA_DIAG') sendResponse({ ok: true, report: X.diagnose(document) });
        else sendResponse({ ok: false, error: 'Unknown request' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true; // async response
  });
  // ---------------------------------------------------------------------------
  // Floating button (opens the side panel)
  // ---------------------------------------------------------------------------

  let fabHost = null;
  let fabEnabled = true;
  let dismissedFor = ''; // slug the user hid the button for

  function buildFab() {
    const host = document.createElement('div');
    host.id = 'lda-fab-host';
    host.style.cssText = 'all: initial; position: fixed; right: 0; top: 42%; z-index: 2147483000;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .wrap { display: flex; align-items: center; font: 600 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        .btn { display: flex; align-items: center; gap: 6px; padding: 9px 12px 9px 10px; border: 0; cursor: pointer;
               background: #0a66c2; color: #fff; border-radius: 10px 0 0 10px; box-shadow: 0 2px 10px rgba(0,0,0,.25);
               transform: translateX(calc(100% - 40px)); transition: transform .18s ease; font: inherit; }
        .wrap:hover .btn, .btn:focus-visible { transform: translateX(0); }
        .btn img { width: 20px; height: 20px; border-radius: 4px; flex: none; }
        .x { position: absolute; top: -8px; left: -8px; width: 18px; height: 18px; border-radius: 50%; border: 0; cursor: pointer;
             background: #fff; color: #333; font: 700 12px/18px system-ui; box-shadow: 0 1px 4px rgba(0,0,0,.3); display: none; padding: 0; }
        .wrap:hover .x { display: block; }
        .tip { position: absolute; right: 8px; top: 44px; width: 220px; background: #1d2226; color: #fff; padding: 8px 10px;
               border-radius: 8px; font: 400 12px/1.4 system-ui, sans-serif; display: none; }
      </style>
      <div class="wrap">
        <button class="x" title="Hide on this page" aria-label="Hide DM Architect button">×</button>
        <button class="btn" title="Open LinkedIn DM Architect">
          <img alt="" src="${chrome.runtime.getURL('icons/icon32.png')}"><span>DM Architect</span>
        </button>
        <div class="tip" role="status"></div>
      </div>`;
    const tip = root.querySelector('.tip');
    root.querySelector('.btn').addEventListener('click', () => {
      // Must be sent straight from the click so Chrome treats it as a user gesture.
      chrome.runtime.sendMessage({ type: 'LDA_OPEN_PANEL' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          tip.textContent = 'Click the DM Architect icon in the Chrome toolbar to open the panel.';
          tip.style.display = 'block';
          setTimeout(() => (tip.style.display = 'none'), 4000);
        }
      });
    });
    root.querySelector('.x').addEventListener('click', () => {
      dismissedFor = X.parseProfileUrl(location.href).slug;
      updateFab();
    });
    return host;
  }

  function updateFab() {
    const url = X.parseProfileUrl(location.href);
    const show = fabEnabled && url.isProfile && url.pageType !== 'other' && url.slug !== dismissedFor;
    if (show && !fabHost) {
      fabHost = buildFab();
      document.documentElement.appendChild(fabHost);
    } else if (!show && fabHost) {
      fabHost.remove();
      fabHost = null;
    }
  }

  chrome.storage.local.get('lda.settings', (res) => {
    const s = res && res['lda.settings'];
    fabEnabled = !s || s.showFab !== false;
    updateFab();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['lda.settings']) {
      const s = changes['lda.settings'].newValue;
      fabEnabled = !s || s.showFab !== false;
      updateFab();
    }
  });
  // LinkedIn is a single-page app: watch for URL changes.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      updateFab();
    }
  }, 800);
})();
