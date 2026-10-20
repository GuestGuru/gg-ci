#!/usr/bin/env bash
# IT-1808 — a bő tesztsorok ütemezett indítója. A gg-mb launchd-ja hívja (install.sh),
# és a schedule.tsv minden sorára `gh workflow run`-t küld: a workflow a saját runneren
# (gg-runner) fut, GitHub-perc nélkül. Ha a gg-mb áll, az aznapi futás kimarad.
#
#   dispatch.sh [auto|nightly|weekly|all]
#
# auto (alap): a nightly sorok, hétfőn utánuk a weekly sorok is. A sorok egymás után
# futnak: minden indítás után megvárja a futás végét (legfeljebb
# GG_DISPATCH_WAIT_SECONDS), csak utána jön a következő. Ha egy indítás vagy futás
# hibázik, a többit akkor is végigviszi, és a végén 1-gyel lép ki.
#
# Hitelesítés: a gg-mb helyi `gh` bejelentkezése (~/.config/gh/hosts.yml).
# Felülírható (főleg a teszthez): GG_DISPATCH_LIST, GG_DISPATCH_WAIT_SECONDS (5400),
# GG_DISPATCH_POLL_SECONDS (30), GG_DISPATCH_WEEKDAY (`date +%u`), GG_DISPATCH_GH (gh),
# GG_DISPATCH_OWNER (GuestGuru), GG_DISPATCH_LOCK.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
list="${GG_DISPATCH_LIST:-$script_dir/schedule.tsv}"
wait_max="${GG_DISPATCH_WAIT_SECONDS:-5400}"
poll="${GG_DISPATCH_POLL_SECONDS:-30}"
weekday="${GG_DISPATCH_WEEKDAY:-$(date +%u)}"
gh_bin="${GG_DISPATCH_GH:-gh}"
owner="${GG_DISPATCH_OWNER:-GuestGuru}"
lock="${GG_DISPATCH_LOCK:-${TMPDIR:-/tmp}/gg-ci-scheduled-dispatch.lock}"

mode="${1:-auto}"
case "$mode" in
  auto) if [[ "$weekday" == 1 ]]; then want="nightly weekly"; else want="nightly"; fi ;;
  nightly | weekly) want="$mode" ;;
  all) want="nightly weekly" ;;
  *) echo "használat: $0 [auto|nightly|weekly|all]" >&2; exit 2 ;;
esac

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Két egyidejű indítás (pl. kézi kickstart az éjszakai futás alatt) ne fusson egymásra.
if ! mkdir "$lock" 2>/dev/null; then
  log "HIBA: már fut egy indítás ($lock)"
  exit 1
fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT

[[ -r "$list" ]] || { log "HIBA: a lista nem olvasható: $list"; exit 1; }

# A futás azonosítása: a dispatch előtti időpontnál (30 mp óraeltéréssel) nem
# régebbi legfrissebb workflow_dispatch futás az adott workflow-n.
since() {
  date -u -v-30S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '30 seconds ago' +%Y-%m-%dT%H:%M:%SZ
}

find_run() { # <repó> <workflow> <ref> <since> → "<id> <url>"
  "$gh_bin" run list -R "$1" -w "$2" -b "$3" -e workflow_dispatch -L 10 \
    --json databaseId,createdAt,url \
    --jq "[.[] | select(.createdAt >= \"$4\")] | sort_by(.createdAt) | last | select(. != null) | \"\(.databaseId) \(.url)\""
}

failed=0
for freq in $want; do
  # a lista a 3-as leírón jön: a gh ne nyelje el a ciklus stdin-jét
  while IFS=$'\t' read -r -u 3 repo workflow ref every _; do
    [[ -z "$repo" || "$repo" == \#* ]] && continue
    [[ "$every" == "$freq" ]] || continue
    full="$owner/$repo"
    start="$(since)"
    if ! "$gh_bin" workflow run "$workflow" -R "$full" --ref "$ref" >/dev/null; then
      log "HIBA: nem indult: $full $workflow@$ref"
      failed=1
      continue
    fi
    log "elindítva: $full $workflow@$ref ($freq)"

    # a futás pár mp múlva jelenik meg a listában: legfeljebb 12 próba, 10 mp-enként
    run=""
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
      sleep "$((poll < 10 ? poll : 10))"
      run="$(find_run "$full" "$workflow" "$ref" "$start" 2>/dev/null || true)"
      [[ -n "$run" ]] && break
    done
    if [[ -z "$run" ]]; then
      log "HIBA: a futás nem látszik 120 mp után: $full $workflow"
      failed=1
      continue
    fi
    id="${run%% *}"
    url="${run#* }"
    log "futás: $url"

    conclusion=""
    waited=0
    while :; do
      state="$("$gh_bin" run view "$id" -R "$full" --json status,conclusion --jq '"\(.status) \(.conclusion)"' 2>/dev/null || true)"
      if [[ "${state%% *}" == completed ]]; then
        conclusion="${state#* }"
        break
      fi
      [[ "$waited" -ge "$wait_max" ]] && break
      sleep "$poll"
      waited=$((waited + (poll > 0 ? poll : 1)))
    done
    if [[ -z "$conclusion" ]]; then
      log "HIBA: $wait_max mp után sem ért véget, továbblépek: $url"
      failed=1
    elif [[ "$conclusion" != success ]]; then
      log "HIBA: $conclusion: $url"
      failed=1
    else
      log "kész: success: $url"
    fi
  done 3< "$list"
done

if [[ "$failed" -ne 0 ]]; then
  log "vége: volt hiba"
  exit 1
fi
log "vége: minden indítás sikeres"
