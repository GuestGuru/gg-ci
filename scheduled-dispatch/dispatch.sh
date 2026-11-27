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
# workflow legutóbb indult kísérlete az ág mostani fején befejeződött, és sikeres. Elindul tehát,
# ha a kód változott az utolsó zöld futás óta, ha a fejen még nem volt futás, vagy ha a legutóbbi
# kísérlet nem sikeres vagy még tart (akkor is, ha ugyanazon a commiton korábban volt zöld).
# Változatlan, zöld kódon a futás csak ugyanazt bizonyítaná újra. Kihagyni csak pozitív bizonyítékra szabad:
# ha az ellenőrzés hibázik, időtúllép, mást ad, mint amit várunk, vagy az ág feje közben
# elmozdul, a sor elindul. Egy fölös futás olcsóbb, mint egy csendben kimaradó tesztsor. Üres
# feltétellel a sor minden alkalommal indul. A feltételhez a ref ágnév legyen.
#
# A hibás sor (kevés vagy sok mező, üres kötelező mező, ismeretlen gyakoriság) nem indítható:
# hibaként a naplóba kerül, a többi sor megy tovább, és a kilépési kód 1.
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
# egy rövid API-hívás (a `changed` lekérdezései, az indítás) kerete
call_max="${GG_DISPATCH_CALL_SECONDS:-60}"
weekday="${GG_DISPATCH_WEEKDAY:-$(date -u +%u)}"
hour="${GG_DISPATCH_HOUR:-$(date -u +%H)}"
utc_hour="${GG_DISPATCH_UTC_HOUR:-01}"
gh_bin="${GG_DISPATCH_GH:-gh}"
owner="${GG_DISPATCH_OWNER:-GuestGuru}"
lock="${GG_DISPATCH_LOCK:-$script_dir/dispatch.lock}"
run_now="${GG_DISPATCH_RUN_NOW:-$script_dir/run-now}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# bounded <mp> <parancs…>: a parancs időkerettel. A keret lejártakor SIGTERM-et, 5 mp múlva
# SIGKILL-t küld neki, megvárja, és 142-vel tér vissza; egyébként a parancs kilépési kódját adja
# (a parancs saját 142-es kódját 1-re írja át, hogy a 142 mindig a keret lejártát jelentse).
# A korábbi `perl -e 'alarm shift; exec @ARGV'` a gh-t NEM állította le: a Go futtatókörnyezet a
# SIGALRM-ot elkapja, és nem lép ki rá (mérve 2026-11-27: a gh 1 mp-es kerettel 8 mp-ig élt).
# Ezért a keretet egy szülőfolyamat őrzi, és olyan jelet küld, amelyre a gh leáll.
# A zár (9-es leíró) nem öröklődik: a perl és a gh nélküle indul. Parancshelyettesítésben a hívó
# `$(exec 9>&-; bounded …)` alakot használ, hogy a köztes alshell se tartsa a zárat, ha az indítót
# egy hívás közben leállítják.
bounded() {
  perl -e '
    use strict; use warnings; use POSIX ();
    my $limit = shift @ARGV;
    if ($limit !~ /^[1-9][0-9]*$/) { print STDERR "bounded: érvénytelen keret: $limit\n"; exit 125 }
    my $pid = fork();
    if (!defined $pid) { print STDERR "bounded: fork: $!\n"; exit 126 }
    if ($pid == 0) {
      exec { $ARGV[0] } @ARGV or POSIX::_exit(127);
    }
    my $expired = 0;
    $SIG{ALRM} = sub {
      if ($expired) { kill "KILL", $pid } else { $expired = 1; kill "TERM", $pid; alarm 5 }
    };
    alarm $limit;
    1 while waitpid($pid, 0) == -1 && $!{EINTR};
    my $status = $?;
    alarm 0;
    exit 142 if $expired;
    my $code = ($status & 127) ? 128 + ($status & 127) : $status >> 8;
    exit($code == 142 ? 1 : $code);
  ' "$@" 9>&-
}

# Az ág fejének SHA-ja a `head_sha` változóba. 0, ha érvényes commit-SHA jött; a változót csak
# akkor írja át.
head_sha=""
read_head() {
  local full="$1" ref="$2" sha
  sha="$(exec 9>&-; bounded "$call_max" "$gh_bin" api "repos/$full/git/ref/heads/$ref" --jq .object.sha)" || return 1
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  head_sha="$sha"
}

# A futáslista szűrője: a fejre és az ágra szűrt futások közül a legutóbb INDULT kísérletet adja
# "<sha> <ág> <állapot> <eredmény> ;" alakban. Egy újrafuttatás a futás `run_started_at` mezőjét
# frissíti, ezért nem a legutóbb létrehozott rekord számít. A záró ` ;` miatt az utolsó mező sem
# végződhet észrevétlenül sortöréssel (a parancshelyettesítés a kimenet végi sortöréseket levágja).
# Ha a válasz nem egyértelmű, a szűrő ezt mondja meg, és a sor elindul:
#   none       a fejen ezen az ágon még nem volt futás;
#   truncated  a lista nem teljes (több futás van, mint amennyi egy lapra fér), vagy nincs darabszám;
#   ambiguous  valamelyik futás indulási ideje hiányzik vagy nem időbélyeg (a sorrend így nem
#              megbízható), vagy több futás indult ugyanabban a másodpercben.
# shellcheck disable=SC2016  # a `$` itt a jq változóit jelöli, nem a shellét
latest_attempt='
  .workflow_runs as $runs
  | if (.total_count | type) != "number" or (($runs | type) != "array") or .total_count != ($runs | length)
    then "truncated"
    elif ($runs | length) == 0 then "none"
    elif any($runs[]; (.run_started_at | type) != "string"
        or (.run_started_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$") | not))
    then "ambiguous"
    else ($runs | map(.run_started_at) | max) as $started
      | ($runs | map(select(.run_started_at == $started))) as $latest
      | if ($latest | length) != 1 then "ambiguous"
        else $latest[0] | "\(.head_sha) \(.head_branch) \(.status) \(.conclusion) ;"
        end
    end'

# A `changed` feltétel: sikeres-e a workflow legutóbb indult kísérlete az ág mostani fején?
#   0 = igen, és be is fejeződött (a sor kimarad),
#   1 = nem: a fejen még nem volt futás, a legutóbbi kísérlet nem sikeres, vagy még tart (indítani kell),
#   2 = nem állapítható meg (indítani kell, figyelmeztetéssel),
#   3 = zöld volt, de az ág feje az ellenőrzés közben elmozdult vagy nem olvasható újra (indítani kell).
# Csak pozitív bizonyítékra hagy ki: a válasznak pontosan a fej SHA-ját, az ágat, a `completed`
# állapotot és a `success` eredményt kell tartalmaznia. A még tartó kísérlet nem bizonyíték, és
# nem is takarhat el semmit: ha épp egy bukott futást futtatnak újra, a sor elindul. A fej SHA-ja
# a `head_sha` változóban marad. Minden hívás csak olvas, és időkeretet kap.
green_on_head() {
  local full="$1" workflow="$2" ref="$3" latest first at
  read_head "$full" "$ref" || return 2
  first="$head_sha"
  latest="$(exec 9>&-; bounded "$call_max" "$gh_bin" api \
    "repos/$full/actions/workflows/$workflow/runs?head_sha=$first&branch=$ref&per_page=100" \
    --jq "$latest_attempt")" || return 2
  at="$first $ref"
  case "$latest" in
    "$at completed success ;")
      # Kihagyás előtt még egyszer kiolvassuk a fejet: ha közben új commit érkezett, a zöld
      # bizonyíték már nem a mostani fejre szól.
      read_head "$full" "$ref" || return 3
      [[ "$head_sha" == "$first" ]] || return 3
      return 0
      ;;
    none) return 1 ;;
    "$at completed failure ;" | "$at completed cancelled ;" | "$at completed timed_out ;" | \
      "$at completed skipped ;" | "$at completed neutral ;" | "$at completed action_required ;" | \
      "$at completed stale ;" | "$at completed startup_failure ;") return 1 ;;
    "$at queued null ;" | "$at in_progress null ;" | "$at requested null ;" | "$at waiting null ;" | \
      "$at pending null ;") return 1 ;;
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

# A számszerű felülírások ellenőrzése. Érvénytelen érték helyett az alapérték érvényes: egy
# elgépelt keret se a határidőt kapcsolja ki (a nulla vagy nem szám `alarm` nem jár le), se a
# ciklust állítsa meg egy aritmetikai hibával.
checked() { # <változónév> <env-név> <alapérték> <minta>
  local value="${!1}"
  if [[ ! "$value" =~ $4 ]]; then
    log "figyelmeztetés: érvénytelen $2 ($value), az alapérték ($3) érvényes"
    printf -v "$1" '%s' "$3"
  fi
}
checked wait_max GG_DISPATCH_WAIT_SECONDS 5400 '^[1-9][0-9]{0,8}$'
checked call_max GG_DISPATCH_CALL_SECONDS 60 '^[1-9][0-9]{0,8}$'
# vezető nulla nélkül: a `08` a bash aritmetikájában hibás oktális szám, a gh pedig elutasítja
checked poll GG_DISPATCH_POLL_SECONDS 30 '^(0|[1-9][0-9]{0,8})$'

# A lista beolvasása és ellenőrzése egy menetben, még az indítások előtt, hogy a hibás sor
# egyszer és hangosan jelenjen meg, ne csendben maradjon ki. Tabok mentén darabolunk, az üres
# mezőt megtartva: a `read` tab-IFS-sel összevonná őket, és a mezők elcsúsznának. A záró
# sortörés nélküli utolsó sor is sor, a sorvégi CR pedig nem része az utolsó mezőnek.
tab=$'\t'
cr=$'\r'
rows_repo=()
rows_workflow=()
rows_ref=()
rows_every=()
rows_when=()
failed=0
if ! exec 3< "$list"; then
  log "HIBA: a lista nem olvasható: $list"
  exit 1
fi
lineno=0
while IFS= read -r -u 3 line || [[ -n "$line" ]]; do
  lineno=$((lineno + 1))
  line="${line%"$cr"}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  fields=()
  rest="$line"
  while [[ "$rest" == *"$tab"* ]]; do
    fields+=("${rest%%"$tab"*}")
    rest="${rest#*"$tab"}"
  done
  fields+=("$rest")
  count="${#fields[@]}"
  if [[ "$count" -lt 4 || "$count" -gt 5 || -z "${fields[0]}" || -z "${fields[1]}" || -z "${fields[2]}" ]] ||
    [[ "${fields[3]}" != nightly && "${fields[3]}" != weekly ]]; then
    log "HIBA: hibás sor a listában, nem indítható ($lineno. sor): $line"
    failed=1
    continue
  fi
  rows_repo+=("${fields[0]}")
  rows_workflow+=("${fields[1]}")
  rows_ref+=("${fields[2]}")
  rows_every+=("${fields[3]}")
  rows_when+=("${fields[4]:-}")
done
exec 3<&-
if [[ "${#rows_repo[@]}" -eq 0 ]]; then
  log "HIBA: a listában nincs indítható sor: $list"
  exit 1
fi

# Hány sor kerül sorra ebben a körben. A ciklus után ezt összevetjük a ténylegesen megkezdett
# sorokkal: ha egy futásidejű shellhiba (például egy aritmetikai hiba) megszakítaná a ciklust, a
# kör nem zárulhat „minden indítás sikeres” üzenettel.
expected=0
seen=0
for freq in $want; do
  i=0
  while [[ "$i" -lt "${#rows_every[@]}" ]]; do
    [[ "${rows_every[$i]}" == "$freq" ]] && expected=$((expected + 1))
    i=$((i + 1))
  done
done

for freq in $want; do
  i=0
  while [[ "$i" -lt "${#rows_repo[@]}" ]]; do
    repo="${rows_repo[$i]}"
    workflow="${rows_workflow[$i]}"
    ref="${rows_ref[$i]}"
    every="${rows_every[$i]}"
    when="${rows_when[$i]}"
    i=$((i + 1))
    [[ "$every" == "$freq" ]] || continue
    seen=$((seen + 1))
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
          3) log "az ág feje az ellenőrzés közben elmozdult vagy nem olvasható újra, ezért elindul: $full $workflow@$ref" ;;
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
    out="$(exec 9>&-; bounded "$call_max" "$gh_bin" workflow run "$workflow" -R "$full" --ref "$ref")"
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

    # Kivárás időkerettel: a keret lejártakor a `bounded` leállítja a gh-t, és 142-t ad. A watch
    # nem nullás kódja még nem bukás: egy átmeneti API-hiba (pl. TLS handshake timeout) is
    # 1-gyel lépteti ki, miközben a futás még tart. Ezért ilyenkor a futás állapotát
    # kérdezzük; ha még nem `completed`, a maradék kereten belül újra figyelünk, így a
    # következő sor csak ennek a futásnak a végén indul.
    # A watch, az állapotlekérés és az alvás is a közös határidőn belül marad (a gh-t a
    # `bounded` a maradék idő után leállítja), tehát beragadt API mellett sem csúszik túl.
    deadline=$((SECONDS + wait_max))
    rc=142
    while :; do
      left=$((deadline - SECONDS))
      [[ "$left" -gt 0 ]] || { rc=142; break; }
      bounded "$left" "$gh_bin" run watch "$id" -R "$full" --exit-status --interval "$poll" > /dev/null
      rc=$?
      [[ "$rc" -eq 0 || "$rc" -eq 142 ]] && break
      left=$((deadline - SECONDS))
      [[ "$left" -gt 0 ]] || { rc=142; break; }
      state="$(exec 9>&-; bounded "$left" "$gh_bin" run view "$id" -R "$full" --json status,conclusion \
        --jq '"\(.status) \(.conclusion)"' 2> /dev/null)"
      if [[ "${state%% *}" == completed ]]; then
        [[ "${state#* }" == success ]] && rc=0
        break
      fi
      log "figyelmeztetés: a gh run watch $rc-gyel kilépett, de a futás nem ért véget (${state:-állapot ismeretlen}), újra figyelem: $url"
      left=$((deadline - SECONDS))
      [[ "$left" -gt 0 ]] || { rc=142; break; }
      sleep "$((poll < left ? poll : left))" 9>&-
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
  done
done

if [[ "$seen" -ne "$expected" ]]; then
  log "HIBA: a kör idő előtt megszakadt: $expected sorból csak $seen került sorra"
  failed=1
fi

if [[ "$failed" -ne 0 ]]; then
  log "vége: volt hiba"
  exit 1
fi
log "vége: minden indítás sikeres"
