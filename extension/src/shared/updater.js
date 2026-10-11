/**
 * Updates from GitHub (https://github.com/SurdsoN/linkedinDM).
 *
 * Chrome only auto-updates Web Store extensions, so for an unpacked install:
 *  1. checkForUpdate()  reads version.json from the repo and compares versions.
 *  2. downloadUpdate()  fetches the release zip, checks its SHA-256 (from
 *                       version.json), unzips it and validates its manifest.
 *  3. installUpdate()   writes the files into the extension's folder — the
 *                       user picks that folder once (File System Access API,
 *                       Chrome asks for permission) — then chrome.runtime.reload().
 */

import { unzip } from './zip.js';

export const UPDATE_SOURCE = { owner: 'SurdsoN', repo: 'linkedinDM', branch: 'main' };
export const REPO_URL = `https://github.com/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}`;
const RAW = `https://raw.githubusercontent.com/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}/${UPDATE_SOURCE.branch}/`;

// Only these paths may be written by an update.
const ALLOWED = /^(manifest\.json|README\.md|CHANGELOG\.md|icons\/[\w.-]+\.png|src\/[\w./-]+\.(js|html|css|json|png|svg))$/;

/** -1 / 0 / 1 for "1.2.3"-style versions. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function currentVersion() {
  return chrome.runtime.getManifest().version;
}

/** @returns {Promise<{current:string, latest:string, newer:boolean, notes:string[], released:string, zipUrl:string, sha256:string, size:number}>} */
export async function checkForUpdate({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${RAW}version.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Couldn’t reach the update server (HTTP ${res.status}).`);
  const info = await res.json();
  if (!info || !info.version || !info.zip) throw new Error('The update information is incomplete.');
  const current = currentVersion();
  return {
    current,
    latest: info.version,
    newer: compareVersions(info.version, current) > 0,
    notes: Array.isArray(info.notes) ? info.notes : [],
    released: info.released || '',
    zipUrl: /^https:\/\//.test(info.zip) ? info.zip : RAW + info.zip.replace(/^\//, ''),
    sha256: String(info.sha256 || '').toLowerCase(),
    size: info.size || 0,
  };
}

async function sha256Hex(buffer) {
  const d = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Download + verify. Throws if the checksum, contents or manifest don't match.
 * @returns {Promise<{files: Map<string, Uint8Array>, manifest: object}>}
 */
export async function downloadUpdate(info, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(info.zipUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
  const buffer = await res.arrayBuffer();
  if (info.sha256) {
    const got = await sha256Hex(buffer);
    if (got !== info.sha256) throw new Error('The downloaded update failed its integrity check (SHA-256 mismatch). Nothing was installed.');
  }
  const raw = await unzip(buffer);
  // Packages may have everything inside one top folder — strip it.
  const names = [...raw.keys()];
  const prefix = names.every((n) => n.includes('/')) ? names[0].split('/')[0] + '/' : '';
  const files = new Map();
  for (const [name, data] of raw) {
    const rel = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
    if (!rel || rel.includes('..') || rel.startsWith('/') || rel.includes('\\')) throw new Error(`Unsafe path in update: ${name}`);
    if (!ALLOWED.test(rel)) continue; // ignore anything that isn't part of the extension
    files.set(rel, data);
  }
  const mBytes = files.get('manifest.json');
  if (!mBytes) throw new Error('The update has no manifest.json.');
  const manifest = JSON.parse(new TextDecoder().decode(mBytes));
  const self = chrome.runtime.getManifest();
  if (manifest.name !== self.name) throw new Error(`This update is for “${manifest.name}”, not ${self.name}.`);
  if (manifest.version !== info.latest) throw new Error(`Version mismatch: the package is v${manifest.version}, expected v${info.latest}.`);
  for (const f of ['src/sidepanel/sidepanel.html', 'src/content/extractor.js', 'src/background/service-worker.js']) {
    if (!files.has(f)) throw new Error(`The update is incomplete (missing ${f}).`);
  }
  return { files, manifest };
}

// --- Folder handle (persisted in IndexedDB) ---------------------------------

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('lda-updater', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getSavedFolder() {
  const db = await idb();
  return new Promise((resolve) => {
    const r = db.transaction('kv').objectStore('kv').get('folder');
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => resolve(null);
  });
}

export async function saveFolder(handle) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(handle, 'folder');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/** Check a folder really is this extension (its manifest.json has our name). */
export async function verifyFolder(handle) {
  try {
    const f = await (await handle.getFileHandle('manifest.json')).getFile();
    const m = JSON.parse(await f.text());
    return { ok: m.name === chrome.runtime.getManifest().name, version: m.version, name: m.name };
  } catch (_) {
    return { ok: false, version: '', name: '' };
  }
}

/** Ask Chrome for write access to the saved folder (needs a click). */
export async function ensureWritable(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

/** Write every file of the update into the folder. */
export async function writeFiles(handle, files, onProgress = () => {}) {
  let done = 0;
  // manifest.json last: if anything fails midway, the old manifest stays and Chrome keeps loading a consistent version.
  const ordered = [...files].sort(([a], [b]) => (a === 'manifest.json') - (b === 'manifest.json'));
  for (const [rel, data] of ordered) {
    const parts = rel.split('/');
    let dir = handle;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
    const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
    onProgress(++done, files.size, rel);
  }
}

/** True when loaded unpacked (the only kind of install that can be updated this way). */
export async function isUnpacked() {
  try {
    const self = await chrome.management.getSelf();
    return self.installType === 'development';
  } catch (_) {
    return true;
  }
}
