/**
 * Update page: check → (choose folder once) → download, verify, write → reload.
 */
import {
  checkForUpdate, downloadUpdate, getSavedFolder, saveFolder, verifyFolder, ensureWritable, writeFiles, isUnpacked, REPO_URL,
} from '../shared/updater.js';

const $ = (id) => document.getElementById(id);
let info = null;
let folder = null;

function setStatus(msg, cls = '') {
  $('status').textContent = msg;
  $('status').className = `hint ${cls}`;
}

async function showFolder() {
  if (!folder) return;
  const v = await verifyFolder(folder);
  $('folder-state').textContent = v.ok ? `✓ ${folder.name} (installed v${v.version})` : `✗ “${folder.name}” isn’t the DM Architect folder (no matching manifest.json). Choose the folder you loaded in chrome://extensions.`;
  $('btn-install').disabled = !(v.ok && info && info.newer);
}

async function init() {
  $('manual-link').href = `${REPO_URL}#install`;
  $('btn-reload').addEventListener('click', () => chrome.runtime.reload());
  try {
    info = await checkForUpdate();
  } catch (e) {
    $('title').textContent = 'Couldn’t check for updates';
    $('versions').textContent = e.message;
    return;
  }
  $('manual-link').href = info.zipUrl;
  $('versions').textContent = `Installed: v${info.current} · Latest: v${info.latest}${info.released ? ` (released ${info.released})` : ''}`;
  $('notes').replaceChildren(...info.notes.map((n) => Object.assign(document.createElement('li'), { textContent: n })));
  if (!info.newer) {
    $('title').textContent = '✓ You have the latest version';
    return;
  }
  $('title').textContent = `Update available: v${info.latest}`;
  if (!(await isUnpacked())) {
    $('install').hidden = false;
    $('btn-folder').disabled = true;
    setStatus('This copy wasn’t loaded unpacked, so it can’t update itself — use the manual steps below.');
    return;
  }
  $('install').hidden = false;
  folder = await getSavedFolder();
  await showFolder();

  $('btn-folder').addEventListener('click', async () => {
    try {
      const h = await window.showDirectoryPicker({ id: 'dm-architect', mode: 'readwrite' });
      const v = await verifyFolder(h);
      if (!v.ok) {
        folder = h;
        await showFolder();
        return;
      }
      folder = h;
      await saveFolder(h);
      await showFolder();
    } catch (e) {
      if (e.name !== 'AbortError') setStatus(`Couldn’t open the folder: ${e.message}`, 'warn');
    }
  });

  $('btn-install').addEventListener('click', async () => {
    const btn = $('btn-install');
    btn.disabled = true;
    try {
      if (!(await ensureWritable(folder))) throw new Error('Chrome didn’t get permission to write to the folder.');
      setStatus('Downloading and verifying…');
      const { files } = await downloadUpdate(info);
      document.querySelector('.progress').hidden = false;
      await writeFiles(folder, files, (n, total) => {
        $('bar').style.width = `${Math.round((n / total) * 100)}%`;
        setStatus(`Installing… ${n}/${total} files`);
      });
      setStatus(`✓ v${info.latest} installed. Reloading the extension…`);
      setTimeout(() => chrome.runtime.reload(), 1200);
    } catch (e) {
      setStatus(`✗ ${e.message}`, 'warn');
      btn.disabled = false;
    }
  });
}

init();
