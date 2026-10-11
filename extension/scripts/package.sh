#!/bin/sh
# Build an installable zip of the extension (runtime files only) into dist/.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/linkedin-dm-architect-v${VERSION}.zip"
mkdir -p dist
rm -f "$OUT"
zip -qr "$OUT" manifest.json icons src README.md CHANGELOG.md -x '*.DS_Store'
echo "Built $OUT"
