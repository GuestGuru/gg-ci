#!/usr/bin/env bash
# IT-1808 — a bő tesztsorok ütemezett indítója. A gg-mb launchd-ja hívja (install.sh),
# és a schedule.tsv minden sorára `gh workflow run`-t küld: a workflow a saját runneren
# (gg-runner) fut, GitHub-perc nélkül. Ha a gg-mb áll, az aznapi futás kimarad.
#
#   dispatch.sh [auto|nightly|weekly|all|scheduled]
#
# auto (alap): a nightly sorok, hétfőn (UTC) utánuk a weekly sorok is. scheduled: a
# launchd módja — óránként hívja, és csak GG_DISPATCH_UTC_HOUR órában (01 UTC) fut
# auto-ként, máskor némán kilép; így az időpont nyáron és télen is 01:30 UTC. Egyszeri
# kivétel: ha van `run-now` fájl a szkript mellett, törli, és azonnal fut (kézi próba
# `launchctl kickstart`-tal, l. README).
#
# A sorok egymás után futnak: minden indítás után a `gh workflow run` által visszaadott
# futást várja ki (`gh run watch --exit-status`, legfeljebb GG_DISPATCH_WAIT_SECONDS;
# átmeneti API-hiba után újrafigyel), csak utána jön a következő. Ha egy indítás vagy futás hibázik, a többit akkor is
# végigviszi, és a végén 1-gyel lép ki.
#
# A lista ötödik, elhagyható oszlopa a feltétel (IT-2165). `changed`: a sor kimarad, ha a
# workflow legutóbbi befejezett futása az ág mostani fején sikeres. Elindul tehát, ha a kód
# változott az utolsó zöld futás óta, ha a fejen még nem volt befejezett futás, vagy ha a
# legutóbbi nem sikeres (akkor is, ha ugyanazon a commiton korábban volt zöld). Változatlan,
# zöld kódon a futás csak ugyanazt bizonyítaná újra. Az ellenőrzés két olvasó API-hívás; ha
# bármelyik hibázik, időtúllép vagy mást ad, mint amit várunk, a sor elindul: egy fölös futás
# olcsóbb, mint egy csendben kimaradó tesztsor. Üres feltétellel a sor minden alkalommal indul.
# A feltételhez a ref ágnév legyen.
#
# Hitelesítés: a gg-mb helyi `gh` bejelentkezése (~/.config/gh/hosts.yml).
# Felülírható (főleg a teszthez): GG_DISPATCH_LIST, GG_DISPATCH_WAIT_SECONDS (5400),
# GG_DISPATCH_POLL_SECONDS (30), GG_DISPATCH_CALL_SECONDS (60), GG_DISPATCH_WEEKDAY (`date -u +%u`),
# GG_DISPATCH_HOUR (`date -u +%H`), GG_DISPATCH_UTC_HOUR (01), GG_DISPATCH_GH (gh),
# GG_DISPATCH_OWNER (GuestGuru), GG_DISPATCH_LOCK, GG_DISPATCH_RUN_NOW.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
list="${GG_DISPATCH_LIST:-$script_dir/schedule.tsv}"
wait_max="${GG_DISPATCH_WAIT_SECONDS:-5400}"
poll="${GG_DISPATCH_POLL_SECONDS:-30}"
# egy rövid API-hívás (a `changed` két lekérdezése, az indítás) kerete
call_max="${GG_DISPATCH_CALL_SECONDS:-60}"
weekday="${GG_DISPATCH_WEEKDAY:-$(date -u +%u)}"
hour="${GG_DISPATCH_HOUR:-$(date -u +%H)}"
utc_hour="${GG_DISPATCH_UTC_HOUR:-01}"
gh_bin="${GG_DISPATCH_GH:-gh}"
owner="${GG_DISPATCH_OWNER:-GuestGuru}"
lock="${GG_DISPATCH_LOCK:-$script_dir/dispatch.lock}"
run_now="${GG_DISPATCH_RUN_NOW:-$script_dir/run-now}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# A `changed` feltétel: sikeres-e a workflow legutóbbi befejezett futása az ág mostani fején?
#   0 = igen (a sor kimarad),
#   1 = nem: a legutóbbi befejezett futás nem sikeres, vagy a fejen még nem volt (indítani kell),
#   2 = nem állapítható meg (indítani kell, figyelmeztetéssel).
# Csak pozitív bizonyítékra hagy ki: a válasznak pontosan a fej SHA-ját és a `success`
# eredményt kell tartalmaznia. A futások listája a legújabbal kezd, ezért a `status=completed`
# szűrővel kért első elem a legutóbbi befejezett futás; a folyamatban lévő nem számít. Az
# ágszűrő miatt csak az ugyanerre az ágra indított futás bizonyíték. A fej SHA-ja a `head_sha`
# változóba kerül. Mindkét hívás csak olvas, és a perl alarm GG_DISPATCH_CALL_SECONDS után
# leállítja, hogy egy beragadt API ne tartsa fel a többi sort.
head_sha=""
green_on_head() {
  local full="$1" workflow="$2" ref="$3" latest
  head_sha="$(perl -e 'alarm shift; exec @ARGV' "$call_max" \
    "$gh_bin" api "repos/$full/git/ref/heads/$ref" --jq .object.sha 9>&-)" || return 2
  [[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || return 2
  latest="$(perl -e 'alarm shift; exec @ARGV' "$call_max" \
    "$gh_bin" api "repos/$full/actions/workflows/$workflow/runs?head_sha=$head_sha&branch=$ref&status=completed&per_page=1" \
    --jq '.workflow_runs[0] | "\(.head_sha) \(.conclusion)"' 9>&-)" || return 2
  case "$latest" in
    "$head_sha success") return 0 ;;
    "null null") return 1 ;;
    "$head_sha "?*) return 1 ;;
    *) return 2 ;;
  esac
}

mode="${1:-auto}"
if [[ "$mode" == scheduled ]]; then
  if [[ -e "$run_now" ]]; then
    rm -f "$run_now"
    log "kézi indítás (run-now)"
  elif [[ "$hour" != "$utc_hour" ]]; then
    exit 0
  fi
  mode=auto
fi
case "$mode" in
  auto) if [[ "$weekday" == 1 ]]; then want="nightly weekly"; else want="nightly"; fi ;;
  nightly | weekly) want="$mode" ;;
  all) want="nightly weekly" ;;
  *) echo "használat: $0 [auto|nightly|weekly|all|scheduled]" >&2; exit 2 ;;
esac

# Két egyidejű indítás (pl. kézi próba az éjszakai futás alatt) ne fusson egymásra. A zár
# a 9-es leírón nyitott fájl flock-ja: a processzel együtt szűnik meg (crash vagy SIGKILL
# után sem marad bent). A perl csak megszerzi; a zár a közös fájlleíróhoz tartozik.
exec 9>"$lock"
if ! perl -MFcntl=:flock -e 'open(my $fh, ">&=", 9) or exit 2; flock($fh, LOCK_EX | LOCK_NB) or exit 1'; then
  log "HIBA: már fut egy indítás ($lock)"
  exit 1
fi

[[ -r "$list" ]] || { log "HIBA: a lista nem olvasható: $list"; exit 1; }

failed=0
for freq in $want; do
  # A lista a 3-as leírón jön: a gh ne nyelje el a ciklus stdin-jét. A záró sortörés nélküli
  # utolsó sor is sor (a `read` ilyenkor hibával tér vissza, de a sort beolvasta), és a sorvégi
  # CR nem része az utolsó mezőnek: egyik miatt sem maradhat ki csendben egy tesztsor.
  while IFS= read -r -u 3 line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    IFS=$'\t' read -r repo workflow ref every when _ <<< "$line"
    [[ -z "$repo" || "$repo" == \#* ]] && continue
    [[ "$every" == "$freq" ]] || continue
    full="$owner/$repo"
    case "$when" in
      "") ;;
      changed)
        green_on_head "$full" "$workflow" "$ref"
        case $? in
          0)
            log "kihagyva, a fej legutóbbi futása sikeres: $full $workflow@$ref (${head_sha:0:9})"
            continue
            ;;
          1) ;;
          *) log "figyelmeztetés: nem állapítható meg, sikeres-e a fej legutóbbi futása, ezért elindul: $full $workflow@$ref" ;;
        esac
        ;;
      *)
        log "HIBA: ismeretlen feltétel ($when), a sor feltétel nélkül indul: $full $workflow@$ref"
        failed=1
        ;;
    esac
    # A gh (nem terminálon) a létrehozott futás URL-jét írja ki: ezt és csak ezt követjük.
    # Az indítás is időkeretet kap: egy beragadt hívás a zárat tartva minden további sort
    # feltartana. Időtúllépés után nem próbáljuk újra, mert a futás ettől még létrejöhetett.
    out="$(perl -e 'alarm shift; exec @ARGV' "$call_max" \
      "$gh_bin" workflow run "$workflow" -R "$full" --ref "$ref" 9>&-)"
    rc=$?
    if [[ "$rc" -eq 142 ]]; then
      log "HIBA: az indítás $call_max mp alatt nem válaszolt (a futás ettől még létrejöhetett), továbblépek: $full $workflow@$ref"
      failed=1
      continue
    elif [[ "$rc" -ne 0 ]]; then
      log "HIBA: nem indult: $full $workflow@$ref"
      failed=1
      continue
    fi
    url="$(grep -Eo 'https://[^[:space:]]+/actions/runs/[0-9]+' <<< "$out" | tail -n 1)"
    if [[ -z "$url" ]]; then
      log "HIBA: elindult, de a gh nem adta vissza a futás URL-jét: $full $workflow@$ref"
      failed=1
      continue
    fi
    id="${url##*/}"
    log "elindítva: $full $workflow@$ref ($freq): $url"

    # Kivárás időkerettel: a perl alarm a gh-t SIGALRM-mal (142) állítja le. A watch nem
    # nullás kódja még nem bukás: egy átmeneti API-hiba (pl. TLS handshake timeout) is
    # 1-gyel lépteti ki, miközben a futás még tart. Ezért ilyenkor a futás állapotát
    # kérdezzük; ha még nem `completed`, a maradék kereten belül újra figyelünk, így a
    # következő sor csak ennek a futásnak a végén indul.
    # A watch, az állapotlekérés és az alvás is a közös határidőn belül marad (a gh-t a
    # perl alarm a maradék idő után leállítja), tehát beragadt API mellett sem csúszik túl.
    deadline=$((SECONDS + wait_max))
    rc=142
    while :; do
      left=$((deadline - SECONDS))
      [[ "$left" -gt 0 ]] || { rc=142; break; }
      perl -e 'alarm shift; exec @ARGV' "$left" \
        "$gh_bin" run watch "$id" -R "$full" --exit-status --interval "$poll" > /dev/null 9>&-
      rc=$?
      [[ "$rc" -eq 0 || "$rc" -eq 142 ]] && break
      left=$((deadline - SECONDS))
      [[ "$left" -gt 0 ]] || { rc=142; break; }
      state="$(perl -e 'alarm shift; exec @ARGV' "$left" \
        "$gh_bin" run view "$id" -R "$full" --json status,conclusion --jq '"\(.status) \(.conclusion)"' 9>&- 2> /dev/null)"
      if [[ "${state%% *}" == completed ]]; then
        [[ "${state#* }" == success ]] && rc=0
        break
      fi
      log "figyelmeztetés: a gh run watch $rc-gyel kilépett, de a futás nem ért véget (${state:-állapot ismeretlen}), újra figyelem: $url"
      left=$((deadline - SECONDS))
      [[ "$left" -gt 0 ]] || { rc=142; break; }
      sleep "$((poll < left ? poll : left))"
    done
    if [[ "$rc" -eq 0 ]]; then
      log "kész: success: $url"
      continue
    fi
    failed=1
    if [[ "$rc" -eq 142 ]]; then
      log "HIBA: $wait_max mp után sem ért véget, továbblépek: $url"
    else
      log "HIBA: ${state#* }: $url"
    fi
  done 3< "$list"
done

if [[ "$failed" -ne 0 ]]; then
  log "vége: volt hiba"
  exit 1
fi
log "vége: minden indítás sikeres"
