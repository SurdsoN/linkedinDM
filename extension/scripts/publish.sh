#!/bin/sh
# Publish a release to the GitHub update repo (SurdsoN/linkedinDM checkout).
#   sh scripts/publish.sh /path/to/linkedindm
# Writes: releases/<zip>, version.json (version, notes, sha256), extension/ (source).
# Then commit + push that repo; installed extensions see the update.
set -e
cd "$(dirname "$0")/.."
DEST="${1:?usage: publish.sh /path/to/linkedindm}"
sh scripts/package.sh
VERSION=$(node -p "require('./manifest.json').version")
ZIP="linkedin-dm-architect-v${VERSION}.zip"
mkdir -p "$DEST/releases" "$DEST/extension"
cp "dist/$ZIP" "$DEST/releases/$ZIP"
SHA=$(sha256sum "dist/$ZIP" | cut -d' ' -f1)
SIZE=$(wc -c < "dist/$ZIP" | tr -d ' ')
node -e '
const fs = require("fs");
const [version, zip, sha, size, dest] = process.argv.slice(1);
// Notes = bullet lines of the newest CHANGELOG section.
const log = fs.readFileSync("CHANGELOG.md", "utf8").split(/\n## /)[1] || "";
const notes = log.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
const released = (log.split("\n")[0].match(/\d{4}-\d{2}-\d{2}/) || [new Date().toISOString().slice(0, 10)])[0];
const info = { name: "LinkedIn DM Architect", version, released, zip: "releases/" + zip, sha256: sha, size: Number(size), minimumChromeVersion: "116", notes };
fs.writeFileSync(dest + "/version.json", JSON.stringify(info, null, 2) + "\n");
' "$VERSION" "$ZIP" "$SHA" "$SIZE" "$DEST"
# Source mirror (everything except build output and old zips).
rm -rf "$DEST/extension" && mkdir -p "$DEST/extension"
tar --exclude=./dist --exclude=./release --exclude=./node_modules --exclude=.git -cf - . | tar -xf - -C "$DEST/extension"
echo "Published v$VERSION → $DEST (sha256 $SHA)"
