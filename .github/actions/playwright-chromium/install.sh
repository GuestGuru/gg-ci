#!/usr/bin/env bash
# A Playwright Chromium telepítése két részben (IT-782, IT-1253, IT-1256).
#
# 1. A böngésző-bináris a Playwright saját CDN-jéről jön — KÖTELEZŐ, nélküle a
#    smoke nem mér semmit, ezért a hibája a lépést (és a jobot) bukja.
# 2. A rendszercsomagok (`install-deps`) best-effort. A `--with-deps` apt-ja egy
#    külső Ubuntu-tükör kiesésén 2026-09-11-én ötször blokkolta a merge-kaput zöld
#    munka mellett; a hiányolt csomagok (`xvfb`, `xfonts-scalable`, …) X11-hez
#    kellenek, a HEADLESS chromiumnak nem. Ha mégis hiányozna valami, a smoke a
#    saját mérésén bukik el, értelmes hibával.
#    Saját, szűk időkerete van: 2026-10-01-én egy ~100 kB/s-os tükör 5–6 percig
#    húzta, és zöld tesztek mellett a job-keretet ette meg (BPDBv2#149). Normál
#    futásban 2–15 mp.
#
# Környezet: PACKAGE_MANAGER (npm | pnpm), DEPS_TIMEOUT_SECONDS (alap 120; a
# tesztek írják felül).
set -euo pipefail

case "${PACKAGE_MANAGER:-npm}" in
	npm) playwright=(npx playwright) ;;
	pnpm) playwright=(pnpm exec playwright) ;;
	*)
		echo "::error::package-manager must be npm or pnpm, got '${PACKAGE_MANAGER}'"
		exit 1
		;;
esac

deps_timeout="${DEPS_TIMEOUT_SECONDS:-120}"
if ! [[ "$deps_timeout" =~ ^[1-9][0-9]*$ ]]; then
	echo "::error::DEPS_TIMEOUT_SECONDS must be a positive integer, got '${deps_timeout}'"
	exit 1
fi

echo "::group::Playwright Chromium (required)"
"${playwright[@]}" install chromium
echo "::endgroup::"

# A `timeout` (GNU coreutils) a saját folyamatcsoportjának küldi a jelet, tehát
# a `sudo apt-get` gyerekfolyamatot is leállítja, nem csak az npx-et. A
# `--kill-after` a TERM-et figyelmen kívül hagyó folyamatra kell.
if ! command -v timeout >/dev/null 2>&1; then
	echo "::warning::No timeout command on this runner, so Playwright's system packages are skipped (best-effort step, IT-1256). Headless Chromium usually runs without them; if not, the tests will say so."
	exit 0
fi

echo "::group::Playwright system packages (best-effort, ${deps_timeout}s limit)"
status=0
timeout --kill-after=10 "$deps_timeout" "${playwright[@]}" install-deps chromium || status=$?
echo "::endgroup::"

if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
	echo "::warning::Playwright's system packages did not install within ${deps_timeout}s (slow Ubuntu mirror?) — continuing without them (IT-1253). Headless Chromium usually runs without them; if not, the tests will say so."
elif [ "$status" -ne 0 ]; then
	echo "::warning::Playwright's system packages could not be installed (exit ${status}; external Ubuntu mirror?) — continuing without them (IT-782). Headless Chromium usually runs without them; if not, the tests will say so."
fi
