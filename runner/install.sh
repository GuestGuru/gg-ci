#!/usr/bin/env bash
# IT-1496 — a gg-runner VM (a gg-mb `ci` Colima-profilja) üzemeltetési szkriptjeinek
# telepítője és ellenőrzője. A VM gazdagépén (gg-mb) fut, a repó gyökeréből vagy bárhonnan:
#
#   runner/install.sh           # telepíti, ami eltér, utána visszamér
#   runner/install.sh --check   # csak mér; bármilyen eltérésnél exit 1
#
# Mit hová (forrás → cél a VM-ben, mód 755):
#   runner/job-log.sh            → ~/runner-hooks/job-log.sh      (job-napló, a hook hívja, IT-2011)
#   runner/disk-guard-volumes.sh → ~/runner-hooks/disk-guard-volumes.sh (aszinkron kötettakarító, IT-1732)
#   runner/disk-guard.sh         → ~/runner-hooks/disk-guard.sh   (JOB_COMPLETED hook, IT-762, IT-1494)
#   runner/playwright-install.sh → /opt/gg-playwright/telepit.sh  (kézi böngésző-telepítő, IT-945)
#   runner/fstrim-timer-daily.conf → /etc/systemd/system/fstrim.timer.d/gg-daily.conf
#       (mód 644, root-könyvtár, sudo; napi fstrim, IT-2105 — ha változott, utána
#       systemctl daemon-reload és az fstrim.timer újraindítása)
#
# A futó runnereket nem indítja újra, és a .env-jükhöz nem nyúl: a hook útvonala
# nem változik, a runner minden job végén újra beolvassa a fájlt, tehát a csere a
# következő job végétől él. A csere ideiglenes fájllal megy ugyanabban a
# könyvtárban (chmod, majd mv): egy épp induló hook sosem lát félig írt fájlt.
# Ami már egyezik (sha256 és mód), azt nem írja újra — kétszer futtatva a második
# futás csak mér.
#
# Visszamérés: az öt célfájl sha256-ja (és módja) a repóéval, és minden runner-példány
# (systemd `actions.runner.*`) .env-jében az ACTIONS_RUNNER_HOOK_JOB_COMPLETED és a
# két GG_PLAYWRIGHT* sor. A .env többi sorát nem olvassa ki: titok lehet benne.
#
# Felülírható (főleg a teszthez): GG_RUNNER_COLIMA_PROFILE (ci),
# GG_RUNNER_HOOK_DIR (~/runner-hooks), GG_RUNNER_PLAYWRIGHT_DIR (/opt/gg-playwright),
# GG_RUNNER_SYSTEMD_DIR (/etc/systemd/system).
set -euo pipefail

profile="${GG_RUNNER_COLIMA_PROFILE:-ci}"
hook_dir="${GG_RUNNER_HOOK_DIR:-~/runner-hooks}"
pw_dir="${GG_RUNNER_PLAYWRIGHT_DIR:-/opt/gg-playwright}"
systemd_dir="${GG_RUNNER_SYSTEMD_DIR:-/etc/systemd/system}"
src_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

check_only=0
case "${1:-}" in
  "") ;;
  --check) check_only=1 ;;
  *) echo "használat: $0 [--check]" >&2; exit 2 ;;
esac

# A VM-ben futó rész. Egy hívás = egy művelet; a fájltartalom a stdin-en jön.
# shellcheck disable=SC2016 # szándékosan a VM-ben bontódik ki
remote_script='
set -euo pipefail
# a "~/" a VM-felhasználó HOME-ja (a helyi shell nem bonthatja ki)
# shellcheck disable=SC2088 # a szó szerinti "~/" előtagot keressük
resolve() { case "$1" in "~/"*) printf "%s\n" "$HOME/${1#"~/"}" ;; *) printf "%s\n" "$1" ;; esac; }
sha() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | cut -d" " -f1; }
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
root=0
as_root() { if (( root )); then sudo "$@"; else "$@"; fi; }
op="$1"; shift
case "$op" in
  state) # <cél> → "<sha256> <mód>", vagy "hiányzik"
    p="$(resolve "$1")"
    if [[ -f "$p" ]]; then printf "%s %s\n" "$(sha < "$p")" "$(mode "$p")"; else echo "hiányzik"; fi
    ;;
  put) # <cél> <mód>; a tartalom a stdin-en
    p="$(resolve "$1")"; d="$(dirname "$p")"
    if [[ ! -d "$d" ]]; then
      mkdir -p "$d" 2>/dev/null || { sudo mkdir -p "$d" && sudo chown "$(id -un)" "$d"; }
    fi
    tmp="$(mktemp "$d/.install-XXXXXX")"
    cat > "$tmp"
    chmod "$2" "$tmp"
    mv -f "$tmp" "$p"
    ;;
  put-root) # <cél> <mód>; mint a put, de root-könyvtárba (sudo, ha nem írható)
    p="$(resolve "$1")"; d="$(dirname "$p")"
    mkdir -p "$d" 2>/dev/null || true
    root=0; [[ -d "$d" && -w "$d" ]] || root=1
    as_root mkdir -p "$d"
    tmp="$(as_root mktemp "$d/.install-XXXXXX")"
    as_root tee "$tmp" >/dev/null
    as_root chmod "$2" "$tmp"
    as_root mv -f "$tmp" "$p"
    ;;
  reload-fstrim) # <drop-in>: újraolvasás és az időzítő újraszámolása
    root=0; [[ -w "$(dirname "$(resolve "$1")")" ]] || root=1
    as_root systemctl daemon-reload
    as_root systemctl restart fstrim.timer
    ;;
  fstrim-state) # <drop-in> → "ok", ha a systemd betöltötte, nem vár reloadra és a timer aktív
    p="$(resolve "$1")"
    dropins="$(systemctl show -p DropInPaths --value fstrim.timer)"
    reload="$(systemctl show -p NeedDaemonReload --value fstrim.timer)"
    active="$(systemctl show -p ActiveState --value fstrim.timer)"
    if [[ " $dropins " == *" $p "* && "$reload" == no && "$active" == active ]]; then echo ok
    else echo "betöltve: $([[ " $dropins " == *" $p "* ]] && echo igen || echo nem), NeedDaemonReload=$reload, ActiveState=$active"; fi
    ;;
  env) # <hook-cél> <playwright-könyvtár>: minden runner-példány .env-jének három sora
    hook="$(resolve "$1")"; pw="$(resolve "$2")"
    want_pw="$pw/node_modules/playwright/index.mjs"; want_browsers="$pw/browsers"
    rc=0; n=0
    while read -r unit _; do
      [[ -n "$unit" ]] || continue
      n=$((n + 1))
      dir="$(systemctl show -p WorkingDirectory --value "$unit")"
      state="$(systemctl show -p ActiveState --value "$unit")"
      f="$dir/.env"
      get() { { sed -n "s/^$1=//p" "$f" 2>/dev/null || true; } | tail -1; }
      bad=""
      [[ "$(get ACTIONS_RUNNER_HOOK_JOB_COMPLETED)" == "$hook" ]] || bad+=" ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$(get ACTIONS_RUNNER_HOOK_JOB_COMPLETED)"
      [[ "$(get GG_PLAYWRIGHT)" == "$want_pw" ]] || bad+=" GG_PLAYWRIGHT=$(get GG_PLAYWRIGHT)"
      [[ "$(get GG_PLAYWRIGHT_BROWSERS_PATH)" == "$want_browsers" ]] || bad+=" GG_PLAYWRIGHT_BROWSERS_PATH=$(get GG_PLAYWRIGHT_BROWSERS_PATH)"
      if [[ -z "$bad" ]]; then
        echo "  rendben: ${unit%.service} ($state, $f): a hook és a két GG_PLAYWRIGHT* sor a várt értéken"
      else
        echo "  ELTÉR: ${unit%.service} ($state, $f):$bad" >&2
        rc=1
      fi
    done < <(systemctl list-units --all --type=service --plain --no-legend "actions.runner.*")
    if (( n == 0 )); then echo "  ELTÉR: egyetlen actions.runner.* systemd-egység sincs a VM-ben" >&2; rc=1; fi
    v="$({ sed -n "s/^ *\"version\": *\"\([^\"]*\)\".*/\1/p" "$pw/node_modules/playwright/package.json" 2>/dev/null || true; } | head -1)"
    echo "  a VM playwright-modulja: ${v:-nincs telepítve} ($pw)"
    exit "$rc"
    ;;
  *) echo "ismeretlen művelet: $op" >&2; exit 2 ;;
esac
'

vm() { colima ssh -p "$profile" -- bash -c "$remote_script" gg-runner-install "$@"; }
local_sha() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi < "$1" | cut -d" " -f1; }

command -v colima >/dev/null || { echo "nincs colima a PATH-on: ezt a szkriptet a VM gazdagépén (gg-mb) futtasd" >&2; exit 2; }
colima status -p "$profile" >/dev/null 2>&1 || { echo "a(z) '$profile' Colima-profil nem fut" >&2; exit 2; }

drift=0
# A segédek a hook ELŐTT települnek: az új hook csak teljes segédet indíthat.
# forrás (a repóban) | cél (a VM-ben) | mód | put-művelet. A lista a 3-as fd-n
# jön: a `colima ssh` a stdin-t olvassa, és különben megenné a ciklus többi sorát.
while IFS='|' read -r src dest fmode op <&3; do
  want="$(local_sha "$src_dir/$src") $fmode"
  have="$(vm state "$dest" </dev/null)"
  if [[ "$have" == "$want" ]]; then
    echo "változatlan: $dest (sha256 ${want%% *})"
  elif (( check_only )); then
    echo "ELTÉR: $dest — a VM-ben: $have; a repóban: $want" >&2
    drift=1
  else
    vm "$op" "$dest" "$fmode" < "$src_dir/$src"
    now="$(vm state "$dest" </dev/null)"
    [[ "$now" == "$want" ]] || { echo "a telepítés után is eltér: $dest — a VM-ben: $now; a repóban: $want" >&2; exit 1; }
    echo "telepítve: $dest (előtte: $have; most: $now)"
  fi
done 3<<EOF
disk-guard-volumes.sh|$hook_dir/disk-guard-volumes.sh|755|put
job-log.sh|$hook_dir/job-log.sh|755|put
disk-guard.sh|$hook_dir/disk-guard.sh|755|put
playwright-install.sh|$pw_dir/telepit.sh|755|put
fstrim-timer-daily.conf|$systemd_dir/fstrim.timer.d/gg-daily.conf|644|put-root
EOF

# A drop-in fájl egyezése nem elég: az élő timert mérjük (betöltötte-e a systemd, nem
# vár-e reloadra, aktív-e). Egy korábbi, félbemaradt reload így a következő futáskor
# pótlódik, a --check pedig jelzi.
dropin="$systemd_dir/fstrim.timer.d/gg-daily.conf"
fstrim="$(vm fstrim-state "$dropin" </dev/null)" || fstrim="nem mérhető"
if [[ "$fstrim" == ok ]]; then
  echo "fstrim.timer: él a napi drop-in."
elif (( check_only )); then
  echo "ELTÉR: fstrim.timer — $fstrim" >&2
  drift=1
else
  vm reload-fstrim "$dropin" </dev/null
  fstrim="$(vm fstrim-state "$dropin" </dev/null)" || fstrim="nem mérhető"
  [[ "$fstrim" == ok ]] || { echo "az fstrim.timer a reload után sem él: $fstrim" >&2; exit 1; }
  echo "fstrim.timer: daemon-reload és újraindítás megtörtént, él a napi drop-in."
fi

echo "runner-példányok (.env):"
vm env "$hook_dir/disk-guard.sh" "$pw_dir" </dev/null || drift=1

if (( drift )); then
  echo "EREDMÉNY: eltérés van (l. fent)." >&2
  exit 1
fi
echo "EREDMÉNY: a VM a repóval egyezik."
