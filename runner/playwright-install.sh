#!/usr/bin/env bash
# A gg-runner VM böngészője (IT-945, 2026-09-23).
#
# Egy helyen, egy verzióban: a playwright MODUL és a hozzá tartozó chromium
# ugyanabból a telepítésből jön, ezért a kettő nem csúszhat el egymástól.
# A mérők (gg-design scripts/lib/dom-szin.mjs) a runner .env-jéből kapják:
#   GG_PLAYWRIGHT=/opt/gg-playwright/node_modules/playwright/index.mjs
#   GG_PLAYWRIGHT_BROWSERS_PATH=/opt/gg-playwright/browsers
# (NEM a szabványos PLAYWRIGHT_BROWSERS_PATH: az a runner összes jobjára hatna,
# és a többi repó saját `playwright install`-ját is ide irányítaná. A mérő csak
# a saját folyamatában állítja át.)
#
# Frissítés (a VM-ben, `colima ssh -p ci`):  /opt/gg-playwright/telepit.sh 1.64.0
# Akkor futtasd, amikor egyik runner sem busy: a csere közben egy futó
# mérő félkész modult vagy böngészőt láthatna.
# Leírás: wiki tudas/gg-delivery/ci-kapu, „Böngésző a VM-ben".
set -euo pipefail
VERZIO="${1:?használat: telepit.sh <playwright-verzió, pl. 1.63.0>}"
CEL=/opt/gg-playwright
export PLAYWRIGHT_BROWSERS_PATH="$CEL/browsers"

# A VM-nek nincs rendszer-node-ja; a runner tool-cache-éből a legfrissebb 24.x.
if ! command -v node >/dev/null; then
  NODE_BIN="$(ls -d /mnt/lima-colima-ci/actions-work/*/_tool/node/24.*/arm64/bin 2>/dev/null | sort -V | tail -1)"
  [[ -n "$NODE_BIN" ]] || { echo "nincs node a tool-cache-ben" >&2; exit 1; }
  export PATH="$NODE_BIN:$PATH"
fi

cd "$CEL"
[[ -f package.json ]] || echo '{ "name": "gg-playwright", "private": true }' > package.json
npm install --no-audit --no-fund --save-exact "playwright@$VERZIO"
# --with-deps: az apt-függőségek (sudo); a chromium és a headless shell a browsers/-be.
npx --no-install playwright install --with-deps chromium
# A régi buildeket a playwright install maga takarítja (a browsers/.links alapján).
echo "kész: playwright $(node -p "require('$CEL/node_modules/playwright/package.json').version")"
ls "$PLAYWRIGHT_BROWSERS_PATH"
