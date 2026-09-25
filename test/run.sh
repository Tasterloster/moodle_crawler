#!/usr/bin/env bash
# Führt alle Tests aus. jsdom wird nur für den End-to-End-Test gebraucht.
set -euo pipefail
cd "$(dirname "$0")/.."

node test/structure.test.mjs
echo
node test/zip.test.mjs
echo

if node -e "require.resolve(process.env.JSDOM_PATH || 'jsdom')" 2>/dev/null; then
  node test/e2e.test.mjs
else
  echo "ÜBERSPRUNGEN  End-to-End-Test (jsdom fehlt: npm install jsdom)"
fi
