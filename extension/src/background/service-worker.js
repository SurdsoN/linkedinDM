/**
 * Background service worker.
 * Opens the side panel when the toolbar icon or the on-page floating button
 * is clicked.
 * No network calls, no scraping, no storage of target data.
 */

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// Floating button in the page → open the panel for that window.
// sidePanel.open() must run synchronously inside the user-gesture message.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'LDA_OPEN_PANEL' || !sender.tab) return false;
  chrome.sidePanel
    .open({ windowId: sender.tab.windowId })
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
