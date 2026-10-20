#!/usr/bin/env bash
# IT-1808 — a bő tesztsorok indítójának telepítője a gg-mb-re (LaunchAgent).
# A gg-ci main checkoutjából futtasd, merge után:
#
#   scheduled-dispatch/install.sh               # telepít (ami eltér), betölti, visszamér
#   scheduled-dispatch/install.sh --check       # csak mér; eltérésnél exit 1
#   scheduled-dispatch/install.sh --uninstall   # leveszi a LaunchAgentet, törli a másolatot
#
# A dispatch.sh és a schedule.tsv másolata az INSTALL_DIR-be kerül (nem a checkoutra
# mutat: egy worktree törlése vagy ágváltás nem viszi el az indítót). Kézi próba:
#   launchctl kickstart gui/$(id -u)/hu.guestguru.gg-ci-scheduled-dispatch
# Napló: ~/Library/Logs/gg-ci-scheduled-dispatch/dispatch.log
#
# Felülírható (a teszthez): GG_DISPATCH_INSTALL_DIR, GG_DISPATCH_AGENTS_DIR,
# GG_DISPATCH_LOG_DIR, GG_DISPATCH_LAUNCHCTL.
set -euo pipefail

label="hu.guestguru.gg-ci-scheduled-dispatch"
src_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install_dir="${GG_DISPATCH_INSTALL_DIR:-$HOME/.local/share/gg-ci/scheduled-dispatch}"
agents_dir="${GG_DISPATCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
log_dir="${GG_DISPATCH_LOG_DIR:-$HOME/Library/Logs/gg-ci-scheduled-dispatch}"
launchctl_bin="${GG_DISPATCH_LAUNCHCTL:-launchctl}"
plist="$agents_dir/$label.plist"
domain="gui/$(id -u)"

op="install"
case "${1:-}" in
  "") ;;
  --check) op="check" ;;
  --uninstall) op="uninstall" ;;
  *) echo "használat: $0 [--check|--uninstall]" >&2; exit 2 ;;
esac

render_plist() {
  sed -e "s|__HOME__|$HOME|g" -e "s|__INSTALL_DIR__|$install_dir|g" -e "s|__LOG_DIR__|$log_dir|g" \
    "$src_dir/$label.plist"
}

# <cél> <tartalom-fájl> → 0, ha egyezik
same() { [[ -f "$1" ]] && cmp -s "$1" "$2"; }

check() {
  local rc=0 rendered
  rendered="$(mktemp)"
  render_plist > "$rendered"
  for f in dispatch.sh schedule.tsv; do
    if same "$install_dir/$f" "$src_dir/$f"; then echo "ok: $install_dir/$f"
    else echo "ELTÉR: $install_dir/$f"; rc=1; fi
  done
  if same "$plist" "$rendered"; then echo "ok: $plist"; else echo "ELTÉR: $plist"; rc=1; fi
  rm -f "$rendered"
  if "$launchctl_bin" print "$domain/$label" >/dev/null 2>&1; then echo "ok: betöltve ($domain/$label)"
  else echo "NINCS BETÖLTVE: $domain/$label"; rc=1; fi
  return "$rc"
}

case "$op" in
  check)
    check
    ;;
  uninstall)
    "$launchctl_bin" bootout "$domain/$label" 2>/dev/null || true
    rm -f "$plist" "$install_dir/dispatch.sh" "$install_dir/schedule.tsv"
    rmdir "$install_dir" 2>/dev/null || true
    echo "eltávolítva: $label (a napló marad: $log_dir)"
    ;;
  install)
    mkdir -p "$install_dir" "$agents_dir" "$log_dir"
    # atomikus csere: ideiglenes fájl ugyanabban a könyvtárban, majd mv
    for f in dispatch.sh schedule.tsv; do
      if ! same "$install_dir/$f" "$src_dir/$f"; then
        tmp="$(mktemp "$install_dir/.install-XXXXXX")"
        cp "$src_dir/$f" "$tmp"
        if [[ "$f" == *.sh ]]; then chmod 755 "$tmp"; else chmod 644 "$tmp"; fi
        mv -f "$tmp" "$install_dir/$f"
        echo "telepítve: $install_dir/$f"
      fi
    done
    tmp="$(mktemp "$agents_dir/.install-XXXXXX")"
    render_plist > "$tmp"
    if same "$plist" "$tmp"; then
      rm -f "$tmp"
    else
      chmod 644 "$tmp"
      mv -f "$tmp" "$plist"
      echo "telepítve: $plist"
      # a launchd a plist változását csak újratöltéskor látja
      "$launchctl_bin" bootout "$domain/$label" 2>/dev/null || true
    fi
    if ! "$launchctl_bin" print "$domain/$label" >/dev/null 2>&1; then
      "$launchctl_bin" bootstrap "$domain" "$plist"
      echo "betöltve: $domain/$label"
    fi
    check
    ;;
esac
