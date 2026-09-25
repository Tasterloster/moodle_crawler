#!/usr/bin/env bash
# Packt die Erweiterung zu einer ZIP-Datei, die bei addons.mozilla.org
# hochgeladen oder in Firefox installiert werden kann.
set -euo pipefail

cd "$(dirname "$0")"
version=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
out="dist/moodle-crawler-${version}.zip"

rm -rf dist
mkdir -p dist

zip -qr "$out" \
  manifest.json \
  popup content lib background icons _locales \
  -x '*.DS_Store' '*/.*'

echo "Paket erstellt: $out"
unzip -l "$out"
