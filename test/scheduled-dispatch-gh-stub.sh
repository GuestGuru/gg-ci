#!/bin/bash
# A scheduled-dispatch tesztek hamis `gh`-ja; a test/scheduled-dispatch.test.ts a GG_DISPATCH_GH
# változón át adja a dispatch.sh-nak. Minden hívást kétszer naplóz: a GH_CALLS fájlba szóközzel
# összefűzve, a GH_ARGV fájlba argumentumonként szögletes zárójelben, hogy az idézés is látsszon.
#
# `api`: a `changed` feltétel olvasó hívásai. A valódi gh a --jq szűrő eredményét írja ki, ezért
# itt is valódi JSON-on fut a szűrő (jq):
#   …/git/ref/heads/<ág>  az ág feje a FIXTURES/heads fájlból: az n-edik hívás az n-edik sort kapja
#                         (ha kevesebb sor van, az utolsót). HEAD_FAIL_AT=<n>|all: az a hívás hibázik.
#   …/workflows/<f>/runs  a FIXTURES/runs.json futásrekordjai, a GitHub szűrőivel (repó, workflow,
#                         head_sha, branch, status, per_page) és rendezésével (a legújabb elöl).
#                         RUNS_FAIL: a hívás hibázik. RUNS_RAW: a szűrő helyett ezt írja ki.
#                         RUNS_EXIT: a válasz kiírása után ezzel a kóddal lép ki.
# HEAD_SLEEP, RUNS_SLEEP, WATCH_SLEEP, VIEW_SLEEP: a megfelelő hívás lóg; RUN_SLEEP_FIRST: az első
# indítás lóg. HANG_IGNORE_TERM: a lógó hívás a SIGTERM-et is figyelmen kívül hagyja.
#
# `workflow run`: a futás URL-jét írja ki (mint a valódi, nem terminálon), az azonosító 1000 + az
# indítás sorszáma; a FAIL_REPO-ra hibázik (RUN_EXIT kóddal, alapból 1), a NOURL_REPO-ra URL nélkül
# sikeres. `run watch`: a
# WATCH_FAIL azonosítóra 1-gyel lép ki, WATCH_FLAKY mellett az első hívása hibázik. `run view`: a
# VIEW_STATE-et adja.
set -uo pipefail

# Egy hívás egy naplósor marad akkor is, ha egy argumentum (a jq-program) több soros.
nl=$'\n'
joined="$*"
printf '%s\n' "${joined//"$nl"/ }" >> "$GH_CALLS"
bracketed=""
for arg in "$@"; do
  bracketed+="[${arg//"$nl"/ }]"
done
printf '%s\n' "$bracketed" >> "$GH_ARGV"

# A valódi gh (Go) a SIGALRM-ot elkapja, és nem lép ki rá. A lógó hívás itt is így viselkedik,
# különben a teszt olyan időkeretet is elfogadna, amely a valódi gh-t nem állítja le.
hang() {
  trap '' ALRM
  if [[ -n "${HANG_IGNORE_TERM:-}" ]]; then trap '' TERM; fi
  exec sleep "$1"
}

if [[ "$1" == api ]]; then
  if [[ "${3:-}" != --jq || -z "${4:-}" ]]; then
    echo "gh-stub: az api hívás --jq szűrőt vár" >&2
    exit 64
  fi
  case "$2" in
    */git/ref/heads/*)
      nth="$(grep -c '^api [^ ]*/git/ref/heads/' "$GH_CALLS")"
      [[ -n "${HEAD_SLEEP:-}" ]] && hang "$HEAD_SLEEP"
      if [[ "${HEAD_FAIL_AT:-}" == all || "${HEAD_FAIL_AT:-}" == "$nth" ]]; then exit 1; fi
      sha="$(sed -n "${nth}p" "$FIXTURES/heads")"
      [[ -n "$sha" ]] || sha="$(tail -n 1 "$FIXTURES/heads")"
      jq -n --arg ref "refs/${2##*/git/ref/}" --arg sha "$sha" \
        '{ref: $ref, object: {sha: $sha, type: "commit"}}' | jq -r "$4" || exit 1
      ;;
    */runs\?*)
      [[ -n "${RUNS_SLEEP:-}" ]] && hang "$RUNS_SLEEP"
      [[ -n "${RUNS_FAIL:-}" ]] && exit 1
      if [[ -n "${RUNS_RAW+set}" ]]; then
        printf '%s\n' "$RUNS_RAW"
        exit "${RUNS_EXIT:-0}"
      fi
      path="${2%%\?*}"
      query="${2#*\?}"
      repo="${path#repos/}"
      repo="${repo%%/actions/*}"
      workflow="${path##*/workflows/}"
      workflow="${workflow%/runs}"
      param() { printf '%s\n' "$query" | tr '&' '\n' | sed -n "s/^$1=//p" | head -n 1; }
      per_page="$(param per_page)"
      jq --arg repo "$repo" --arg workflow "$workflow" --arg sha "$(param head_sha)" \
        --arg branch "$(param branch)" --arg status "$(param status)" --argjson n "${per_page:-30}" '
        [ .[]
          | select(.repository.full_name == $repo and .path == (".github/workflows/" + $workflow))
          | select($sha == "" or .head_sha == $sha)
          | select($branch == "" or .head_branch == $branch)
          | select($status == "" or .status == $status) ]
        | sort_by(.created_at) | reverse
        | {total_count: length, workflow_runs: .[0:$n]}' "$FIXTURES/runs.json" | jq -r "$4" || exit 1
      exit "${RUNS_EXIT:-0}"
      ;;
    *)
      echo "gh-stub: ismeretlen api útvonal: $2" >&2
      exit 64
      ;;
  esac
  exit 0
fi

case "$1 ${2:-}" in
  "workflow run")
    # csak az első indítás lóg, a többi rendben megy
    if [[ -n "${RUN_SLEEP_FIRST:-}" && "$(grep -c '^workflow run' "$GH_CALLS")" == 1 ]]; then
      hang "$RUN_SLEEP_FIRST"
    fi
    [[ "$*" == *"${FAIL_REPO:-nothing}"* ]] && exit "${RUN_EXIT:-1}"
    [[ "$*" == *"${NOURL_REPO:-nothing}"* ]] && exit 0
    echo "https://github.com/$5/actions/runs/$((1000 + $(grep -c '^workflow run' "$GH_CALLS")))"
    ;;
  "run watch")
    [[ -n "${WATCH_SLEEP:-}" ]] && hang "$WATCH_SLEEP"
    [[ "$3" == "${WATCH_FAIL:-}" ]] && exit 1
    # az első watch átmeneti hibával lép ki (mint egy TLS handshake timeout)
    [[ -n "${WATCH_FLAKY:-}" && "$(grep -c '^run watch' "$GH_CALLS")" == 1 ]] && exit 1
    exit 0
    ;;
  "run view")
    [[ -n "${VIEW_SLEEP:-}" ]] && hang "$VIEW_SLEEP"
    echo "${VIEW_STATE:-completed failure}"
    ;;
esac
