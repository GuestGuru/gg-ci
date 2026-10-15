#!/usr/bin/env bash
# IT-1732 — a lemezőr aszinkron kötettakarító lépcsője. A JOB_COMPLETED hook
# még Worker-ben fut: a segéd legfeljebb 30 mp-ig vár az ÖSSZES Worker kilépésére.
# A flock csak a takarítókat zárja ki; új jobot a Listener-ek rövid SIGSTOP-ja
# zár ki. Megállásukat visszamérjük, aztán ismét ellenőrizzük a Worker-eket.
# A Listener-ek CONT-tal folytatódnak, nem indulnak újra; a systemd-egységekhez,
# .env-hez nem nyúlunk. Már megállított Listener-t nem veszünk át.
# Csak anonim, egyetlen (akár leállított) konténerhez sem kötött kötet törlődik:
# docker volume prune --force, --all NÉLKÜL. Kép/cache/checkout nem törlődik.
# Minden hiba kihagyás; a segéd soha nem buktatja a hívót.
set -uo pipefail
set +e

work_root="${1:-}"
limit="${DISK_GUARD_PRUNE_UNDER_GB:-15}"
wait_seconds="${DISK_GUARD_VOLUME_WAIT_SECONDS:-30}"
event_log="${DISK_GUARD_EVENT_LOG:-${HOME}/runner-hooks/disk-guard-events.log}"
lock_file="${HOME}/runner-hooks/disk-guard-volumes.lock"
paused=()
prune_pid=""
output_file=""
log_event() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$event_log" 2>/dev/null || true; }
# shellcheck disable=SC2329 # EXIT trap hívja
resume_listeners() {
  local pid
  if [[ -n "$prune_pid" ]]; then
    kill -TERM "$prune_pid" 2>/dev/null || true
    wait "$prune_pid" 2>/dev/null || true
  fi
  [[ -z "$output_file" ]] || rm -f -- "$output_file"
  for pid in "${paused[@]}"; do kill -CONT "$pid" 2>/dev/null || true; done
}
trap resume_listeners EXIT
trap 'exit 0' HUP INT TERM

# pgrep: 1 = nincs találat, 2/3 = hiba; hiba sosem jelent üres gépet.
workers_idle() {
  local status
  pgrep -f '(^|/)Runner[.]Worker( |$)' >/dev/null 2>&1
  status=$?
  [[ "$status" == 1 ]]
}
free_mb() { df -BM --output=avail "$work_root" 2>/dev/null | tail -1 | tr -dc '0-9'; }

[[ -d "$work_root" && "$limit" =~ ^[0-9]+$ && "$wait_seconds" =~ ^[0-9]+$ ]] || exit 0
for cmd in flock timeout docker pgrep ps; do command -v "$cmd" >/dev/null || exit 0; done
mkdir -p "${lock_file%/*}" || exit 0
exec 9>"$lock_file" || exit 0
flock -n 9 || exit 0
before="$(free_mb)" || before=""
[[ "$before" =~ ^[0-9]+$ ]] || exit 0
(( before < limit * 1024 )) || exit 0

deadline=$(( SECONDS + wait_seconds ))
until workers_idle; do
  if (( SECONDS >= deadline )); then
    log_event "volume_skip reason=worker_or_discovery_error free_mb=$before"
    exit 0
  fi
  sleep 1
done

listeners="$(pgrep -f '(^|/)Runner[.]Listener( |$)')" || listeners=""
[[ -n "$listeners" ]] || { log_event 'volume_skip reason=no_listeners'; exit 0; }
for pid in $listeners; do
  [[ "$pid" =~ ^[0-9]+$ ]] || exit 0
  state="$(ps -o stat= -p "$pid")" || exit 0
  [[ -n "$state" && "$state" != *T* && "$state" != *Z* ]] || exit 0
  # A jel ELŐTT regisztráljuk, így TERM a kill és a visszamérés között is folytat.
  paused+=("$pid")
  kill -STOP "$pid" 2>/dev/null || exit 0
  stopped=0
  for (( i=0; i<50; i++ )); do
    state="$(ps -o stat= -p "$pid")" || break
    if [[ "$state" == *T* ]]; then stopped=1; break; fi
    sleep 0.02
  done
  (( stopped )) || exit 0
done
# Az esetleg épp elindított Worker már látható, új nem indulhat a megállított
# Listener-ektől. Egy kívülről indított új Listener esetén inkább kihagyjuk.
current="$(pgrep -f '(^|/)Runner[.]Listener( |$)')" || current=""
if [[ "$current" != "$listeners" ]] || ! workers_idle; then
  log_event 'volume_skip reason=runner_changed'
  exit 0
fi
before="$(free_mb)" || before=""
[[ "$before" =~ ^[0-9]+$ ]] && (( before < limit * 1024 )) || exit 0
# A timeout a Docker-kliensre vonatkozik. A daemon saját kötet-referenciazárja
# minden konténer által hivatkozott kötetet megvéd; a prune nem érint más objektumot.
output_file="$(mktemp "${lock_file%/*}/.volume-prune-XXXXXX")" || exit 0
# A háttérfolyamat + wait lehetővé teszi, hogy TERM alatt azonnal fusson a trap
# (parancshelyettesítés alatt a bash a teljes Docker-parancs végéig várna).
timeout --signal=TERM --kill-after=2s 30s docker volume prune --force >"$output_file" 2>&1 &
prune_pid=$!
wait "$prune_pid"
status=$?
prune_pid=""
output="$(cat "$output_file")" || output=""
if (( status == 0 )); then
  after="$(free_mb)" || after="unknown"
  log_event "volume_prune free_mb=${before}->${after} result=${output//$'\n'/ }"
else
  log_event "volume_prune_failed free_mb=$before result=${output//$'\n'/ }"
fi
exit 0
