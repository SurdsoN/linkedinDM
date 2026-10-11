# LinkedIn DM Architect

A free Chrome extension that drafts personalised LinkedIn DMs and job application messages from the page you're viewing and your own synced profile. You review and send; nothing is ever sent for you.

**Website:** https://surdson.github.io/linkedinDM/ (after GitHub Pages is enabled, see below)

## Download & install
1. Download the latest zip from [`releases/`](releases/). [`version.json`](version.json) always names the newest one.
2. Unzip it to a folder you'll keep.
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the unzipped folder.

## Updates
In the extension: **Settings → Updates → Check for updates → Install update**. The extension reads `version.json` from this repo, downloads the zip, verifies its SHA-256, name and version, writes the files into your install folder (you pick it once), and reloads.

## What's in this repo
| Path | What |
|---|---|
| `index.html`, `assets/` | Landing page (GitHub Pages) |
| `version.json` | Latest version, release notes, zip path, SHA-256: read by the extension's update check |
| `releases/` | Installable zips, one per version |
| `extension/` | Source code, tests and docs ([extension/README.md](extension/README.md)) |

## Publishing a release
From the extension source:
```bash
# bump "version" in manifest.json and add a CHANGELOG.md section first
sh scripts/publish.sh /path/to/this/repo
cd /path/to/this/repo && git add -A && git commit -m "Release vX.Y.Z" && git push
```
Installed copies see the update within a day (or immediately via **Check for updates**).

## Enable the website (one time)
Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**. The site appears at `https://surdson.github.io/linkedinDM/`.

## Privacy & responsible use
Data stays in your browser. Profiles you view aren't stored, and AI requests go only to the provider you choose, with your own key. DM Architect reads only the page you have open, only when you click. LinkedIn's User Agreement restricts automated data collection, so use it for personal, one-at-a-time outreach. Not affiliated with LinkedIn.
