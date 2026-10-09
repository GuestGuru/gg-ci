#!/usr/bin/env bash
# IT-762, IT-1494 — a self-hosted runner diszk-őre. A runner JOB_COMPLETED hookja
# hívja, tehát a kimenete a JOB LOGJÁBAN látszik: ha fogy a hely, minden CI-futás
# elmondja, nem kell külön dashboardot nézni.
#
# Két diszket figyel:
#   A. a work-diszk (/mnt/lima-colima-ci, IT-762): ha PRUNE_UNDER_GB alatt van a
#      szabad hely, kidobja azokat a repo-munkakönyvtárakat, amikben KEEP_DAYS
#      napja SEMMI nem változott (a runner újraklónoz — ezek eldobhatók). A
#      _tool / _actions cache-t nem bántja, mert azt minden job újra letöltené.
#      WARN_UNDER_GB alatt ::warning::.
#   B. a rendszerdiszk (/, 19 GB, IT-1494): itt laknak a home cache-ei. Ha
#      ROOT_PRUNE_UNDER_GB alatt van, lépcsőben takarít, a legolcsóbbal kezdve, és
#      minden lépcső után újramér (ha már elég, megáll):
#        1. a /tmp job-maradványai: a runner-felhasználó azon /tmp-elemei, amelyek
#           fájában TMP_KEEP_HOURS órája semmi nem változott (mérve 2026-10-08:
#           napi 1,5–1,8 GB, a rendszer tmpfiles-szabálya csak 30 nap után ürít);
#        2. a ~/.cache/ms-playwright régi böngészői: típusonként (chromium,
#           chromium_headless_shell, …) a legutóbb HASZNÁLT ROOT_PW_KEEP marad;
#        3. a ~/.npm/_cacache (az npm nincs a PATH-on; minden repó újratölti,
#           ezért utolsóként).
#      Ha utána is a küszöb alatt marad, ::warning::.
#
# ⚠️ A work-diszk frissessége a könyvtár TELJES fájában mérendő, nem a tetején:
# egy `_work/<repo>` saját mtime-ja csak a közvetlen gyerekei változásakor
# frissül, a checkout viszont mélyebben ír. Ezért `find … -newermt … -print -quit`.
#
# ⚠️ A Playwright-verziók közül NEM a legmagasabb revízió a „friss”: mérve
# 2026-10-08, mind a négy (1217–1243) élő repó-hivatkozás volt, és a legkisebb
# (1217) aznap települt és futott. A használat jele a fájlok atime-ja (a / relatime,
# tehát naponta legalább egyszer frissül, és a böngésző indítása frissíti).
#
# ⚠️ A VM-ben négy runner-példány fut (IT-1323). A hook a saját jobja Worker-
# folyamatán belül fut, ezért a saját Runner.Worker-t (a hook ősét) ki kell
# hagyni; ha BÁRMELYIK másik Worker fut, a home-cache-eket nem bántja, csak szól.
# Törlés előtt átnevez: egy közben induló job üres cache-t lát, nem félig
# törölt fát.
#
# Sosem buktatja el a jobot: minden ág `exit 0`-ra fut ki.
# ⚠️ A runner `bash -e`-vel indítja (mérve 2026-10-08, Worker-napló): ezért minden
# parancshelyettesítéses értékadás `|| …`-t kap, különben egy hibázó df vagy awk
# félúton, nem nulla kóddal állítaná le.
set -uo pipefail

WARN_UNDER_GB="${DISK_GUARD_WARN_UNDER_GB:-10}"
PRUNE_UNDER_GB="${DISK_GUARD_PRUNE_UNDER_GB:-15}"
KEEP_DAYS="${DISK_GUARD_KEEP_DAYS:-14}"
ROOT_PATH="${DISK_GUARD_ROOT_PATH:-/}"
ROOT_PRUNE_UNDER_GB="${DISK_GUARD_ROOT_PRUNE_UNDER_GB:-4}"
ROOT_PW_KEEP="${DISK_GUARD_ROOT_PW_KEEP:-2}"
TMP_DIR="${DISK_GUARD_TMP_DIR:-/tmp}"
TMP_KEEP_HOURS="${DISK_GUARD_TMP_KEEP_HOURS:-24}"

# a HOME-ot a runner adja; ha mégis üres, a passwd-ból (a set -u miatt ne álljon le)
home="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
npm_cache="${home}/.npm/_cacache"
pw_cache="${home}/.cache/ms-playwright"
# eseménynapló (csak takarítás és kihagyás): ebből mérhető, milyen gyakran és melyik
# lépcsővel takarít — a joblog repónként szét van szórva
event_log="${DISK_GUARD_EVENT_LOG:-${home}/runner-hooks/disk-guard-events.log}"

free_gb() { df -BG --output=avail "$1" 2>/dev/null | tail -1 | tr -dc "0-9"; }
free_mb() { df -BM --output=avail "$1" 2>/dev/null | tail -1 | tr -dc "0-9"; }
fmt_gb() { awk -v m="$1" 'BEGIN { printf "%.1f", m / 1024 }'; }

log_event() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$event_log" 2>/dev/null || true; }

# átnevezés, aztán törlés: a cél azonnal eltűnik, a lassú rm már a lomot viszi
trash() {
  local target="$1" tmp
  tmp="$(dirname "$target")/.disk-guard-trash-$$-$(basename "$target")"
  mv -- "$target" "$tmp" 2>/dev/null || return 1
  rm -rf -- "$tmp" || true
}

# A. work-diszk (IT-762) ---------------------------------------------------
# a work root a RUNNER_WORKSPACE (<work>/<repo>) szülője
work_root="${RUNNER_WORKSPACE:-}"
[[ -n "$work_root" ]] && work_root="$(dirname "$work_root")"

if [[ -d "$work_root" ]] && avail="$(free_gb "$work_root")" && [[ -n "$avail" ]]; then
  if (( avail < PRUNE_UNDER_GB )); then
    echo "::group::Runner disk guard — takarítás (${avail} GB szabad)"
    for d in "$work_root"/*/; do
      d="${d%/}"
      [[ -d "$d" ]] || continue
      case "$(basename "$d")" in _tool|_actions|_temp|_PipelineMapping|_diag) continue ;; esac
      [[ -n "$(find "$d" -newermt "-${KEEP_DAYS} days" -print -quit 2>/dev/null)" ]] && continue
      echo "  eldobva (${KEEP_DAYS} napja semmi nem változott benne): $d"
      rm -rf -- "$d" || true
    done
    echo "::endgroup::"
    avail="$(free_gb "$work_root")" || avail=0
  fi

  if (( avail < WARN_UNDER_GB )); then
    echo "::warning title=Runner disk::A CI-runner munkadiszkjén már csak ${avail} GB szabad (${work_root}). Ha betelik, minden GG-merge blokkolva — l. IT-762."
  else
    echo "Runner disk: ${avail} GB szabad a(z) ${work_root} diszkjén."
  fi
fi

# B. rendszerdiszk (IT-1494) -----------------------------------------------
# A saját jobunk Worker-e a hook őse: az ősök listája kell a kizáráshoz.
ancestors=" "
pid=$$
while [[ -n "$pid" && "$pid" -gt 1 ]]; do
  ancestors+="$pid "
  pid="$(awk '/^PPid:/ { print $2 }' "/proc/$pid/status" 2>/dev/null)" || pid=""
done

other_workers() {
  local p
  for p in $(pgrep -f "[R]unner\.Worker" 2>/dev/null); do
    [[ "$ancestors" == *" $p "* ]] || printf '%s ' "$p"
  done
}

# Legutóbbi használat: a böngésző-könyvtár fájljainak legnagyobb atime-ja.
last_used() {
  find "$1" -maxdepth 3 -type f -printf '%A@\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1
}

prune_playwright() {
  [[ -d "$pw_cache" ]] || return 0
  # a Playwright telepítés közben itt tart zárat — akkor nem nyúlunk hozzá
  if [[ -e "$pw_cache/__dirlock" ]]; then
    echo "  Playwright: épp telepít valaki (__dirlock), kihagyva."
    return 0
  fi
  local d name type ts
  local -A types=()
  # egy korábbi, félbeszakadt törlés maradéka
  rm -rf -- "$pw_cache"/.disk-guard-trash-* 2>/dev/null || true
  for d in "$pw_cache"/*-[0-9]*/; do
    d="${d%/}"
    [[ -d "$d" ]] || continue
    name="$(basename "$d")"
    [[ "$name" =~ ^(.+)-[0-9]+$ ]] || continue
    types["${BASH_REMATCH[1]}"]=1
  done
  for type in "${!types[@]}"; do
    # típusonként legutóbb használt elöl; az első ROOT_PW_KEEP marad
    while read -r ts d; do
      echo "  Playwright: eldobva ${d##*/} (utoljára használva: $(date -d "@${ts}" '+%Y-%m-%d'))"
      trash "$d" || echo "  Playwright: nem sikerült törölni: ${d##*/}"
    done < <(
      for d in "$pw_cache/$type"-[0-9]*/; do
        d="${d%/}"
        [[ "$(basename "$d")" =~ ^${type}-[0-9]+$ ]] || continue
        printf '%s %s\n' "$(last_used "$d")" "$d"
      done | sort -rn | tail -n "+$((ROOT_PW_KEEP + 1))"
    )
  done
}

# A /tmp-ben csak a saját (runner-felhasználó) legfelső szintű elemeit nézzük; ami
# alatt az utolsó TMP_KEEP_HOURS órában bármi változott, az marad. Egyetlen find
# gyűjti a „friss” legfelső neveket, nem elemenként egy-egy (több ezer elem van).
prune_tmp() {
  [[ -d "$TMP_DIR" ]] || return 0
  local e name n=0 before after
  local -A fresh=()
  while IFS= read -r name; do
    [[ -n "$name" ]] && fresh["$name"]=1
  done < <(find "$TMP_DIR" -xdev -mindepth 1 -newermt "-${TMP_KEEP_HOURS} hours" -printf '%P\n' 2>/dev/null | cut -d/ -f1 | sort -u)
  before="$(free_mb "$ROOT_PATH")" || before=0
  while IFS= read -r -d '' e; do
    name="${e##*/}"
    [[ -n "${fresh[$name]:-}" ]] && continue
    rm -rf -- "$e" 2>/dev/null || true
    n=$((n + 1))
  done < <(find "$TMP_DIR" -xdev -mindepth 1 -maxdepth 1 -user "$(id -u)" -print0 2>/dev/null)
  after="$(free_mb "$ROOT_PATH")" || after="$before"
  echo "  /tmp: ${n} elem eldobva (${TMP_KEEP_HOURS} órája nem változott), $(fmt_gb $(( after - before ))) GB felszabadult."
}

root_limit_mb=$(( ROOT_PRUNE_UNDER_GB * 1024 ))
root_mb="$(free_mb "$ROOT_PATH")" || root_mb=""

if [[ -n "$root_mb" ]]; then
  if (( root_mb < root_limit_mb )); then
    busy="$(other_workers)" || busy=""
    if [[ -n "$busy" ]]; then
      echo "Runner disk guard: a rendszerdiszken $(fmt_gb "$root_mb") GB szabad, de másik job fut (Runner.Worker: ${busy% }), ezért most nem takarítok; a következő job végén újra próbálom."
      log_event "kihagyva free_mb=${root_mb} masik_worker=${busy% }"
    else
      echo "::group::Runner disk guard — rendszerdiszk takarítás ($(fmt_gb "$root_mb") GB szabad a(z) ${ROOT_PATH} diszken)"
      start_mb="$root_mb"
      steps="tmp"
      prune_tmp
      root_mb="$(free_mb "$ROOT_PATH")" || root_mb=0
      if (( root_mb < root_limit_mb )); then
        steps+=",playwright"
        prune_playwright
        root_mb="$(free_mb "$ROOT_PATH")" || root_mb=0
      fi
      rm -rf -- "${npm_cache%/*}"/.disk-guard-trash-* 2>/dev/null || true
      if (( root_mb < root_limit_mb )) && [[ -d "$npm_cache" ]]; then
        echo "  npm-cache: törlöm a ${npm_cache} könyvtárat ($(fmt_gb "$root_mb") GB szabad); a következő jobok újratöltik a csomagokat."
        steps+=",npm"
        trash "$npm_cache" || echo "  npm-cache: nem sikerült törölni."
        root_mb="$(free_mb "$ROOT_PATH")" || root_mb=0
      fi
      echo "::endgroup::"
      log_event "takaritas free_mb=${start_mb}->${root_mb} lepcsok=${steps}"
    fi
  fi

  if (( root_mb < root_limit_mb )); then
    echo "::warning title=Runner rendszerdiszk::A CI-runner rendszerdiszkjén (${ROOT_PATH}) már csak $(fmt_gb "$root_mb") GB szabad. Ha betelik, a jobok ENOSPC-vel buknak — l. IT-1494."
  else
    echo "Runner rendszerdiszk: $(fmt_gb "$root_mb") GB szabad a(z) ${ROOT_PATH} diszken."
  fi
fi
exit 0
