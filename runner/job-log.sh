#!/usr/bin/env bash
# IT-2011 — a self-hosted runner job-naplója: minden job végén egy JSON-sor a
# ~/runner-hooks/job-log.jsonl fájlba, hogy mérhető legyen, melyik repó, job,
# issue és agent mennyi ideig és mennyi CPU-val terhelte a gg-mb-t.
#
# A disk-guard.sh (a JOB_COMPLETED hook) hívja elsőként: a runner csak egy
# JOB_COMPLETED hookot ismer, és a .env cseréje runner-újraindítással járna.
# JOB_STARTED hook nem kell: a job kezdete a saját Runner.Worker-ünk (a hook őse)
# indulási ideje, a CPU-ja pedig a Worker saját és a megvárt leszármazottai
# idejének összege (/proc/<pid>/stat utime+stime+cutime+cstime). Ebben minden
# lépés minden folyamata benne van, amit a szülője megvárt (node → bash → vitest
# → worker-szálak); NINCS benne a Docker-konténerek (services:, container:) és a
# leválasztott háttérfolyamatok CPU-ja — azokat a dockerd cgroupja viseli.
#
# Az agent és az issue becslés, nem mérés: az issue az első IT-<n> a head-ágban, a refben,
# a PR-címben vagy a push commit-üzenetében; az agent a commit-trailerből
# (Claude-Session / Co-Authored-By: Claude) vagy az ág előtagjából (agent/, codex/).
# A Herdr-workspace a runnerből nem látszik, ezért nincs a naplóban.
#
# Sosem buktatja el a jobot: minden ág 0-val lép ki. Felülírható (főleg a
# teszthez): JOB_LOG_FILE, JOB_LOG_MAX_BYTES (20 MiB, utána .1-be forgat),
# JOB_LOG_PROC (/proc), JOB_LOG_WORKER_PID (a Worker keresése helyett).
set -uo pipefail

home="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
log="${JOB_LOG_FILE:-${home}/runner-hooks/job-log.jsonl}"
max_bytes="${JOB_LOG_MAX_BYTES:-20971520}"
proc="${JOB_LOG_PROC:-/proc}"

command -v jq >/dev/null 2>&1 || { echo "CI job-napló: nincs jq, kihagyva."; exit 0; }

# a legközelebbi Runner.Worker ős (a comm 15 karakterre vágott, a név belefér)
find_worker() {
  local pid=$$ comm
  while [[ -n "$pid" && "$pid" -gt 1 ]]; do
    comm="$(cat "$proc/$pid/comm" 2>/dev/null)" || comm=""
    [[ "$comm" == Runner.Worker ]] && { echo "$pid"; return 0; }
    pid="$(awk '/^PPid:/ { print $2 }' "$proc/$pid/status" 2>/dev/null)" || pid=""
  done
  return 1
}

worker="${JOB_LOG_WORKER_PID:-$(find_worker)}" || worker=""
cpu_s=null
started=null
duration_s=null
if [[ -n "$worker" && -r "$proc/$worker/stat" ]]; then
  clk="$(getconf CLK_TCK 2>/dev/null)" || clk=100
  btime="$(awk '$1 == "btime" { print $2 }' "$proc/stat" 2>/dev/null)" || btime=""
  # a ")" utáni mezők: [11..14] utime stime cutime cstime, [19] starttime (tick)
  read -r cpu_ticks start_ticks < <(sed 's/^.*) //' "$proc/$worker/stat" 2>/dev/null |
    awk '{ print $12 + $13 + $14 + $15, $20 }') || cpu_ticks=""
  if [[ -n "${cpu_ticks:-}" ]]; then
    cpu_s="$(awk -v t="$cpu_ticks" -v c="$clk" 'BEGIN { printf "%.1f", t / c }')"
    if [[ -n "$btime" ]]; then
      start_epoch=$(( btime + start_ticks / clk ))
      d="$(date -u -d "@${start_epoch}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || d=""
      [[ -n "$d" ]] && started="\"$d\""
      duration_s=$(( $(date +%s) - start_epoch ))
    fi
  fi
fi

workers="$(grep -lx Runner.Worker "$proc"/[0-9]*/comm 2>/dev/null | wc -l | tr -dc 0-9)" || workers=""
load1="$(awk '{ print $1 }' "$proc/loadavg" 2>/dev/null)" || load1=""
mem_avail_mb="$(awk '$1 == "MemAvailable:" { print int($2 / 1024) }' "$proc/meminfo" 2>/dev/null)" || mem_avail_mb=""

event_file="${GITHUB_EVENT_PATH:-}"
[[ -r "$event_file" ]] || event_file=/dev/null

line="$(jq -c -n \
  --slurpfile ev "$event_file" \
  --argjson cpu_s "$cpu_s" --argjson started "$started" --argjson duration_s "$duration_s" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg repo "${GITHUB_REPOSITORY:-}" --arg workflow "${GITHUB_WORKFLOW:-}" --arg job "${GITHUB_JOB:-}" \
  --arg run_id "${GITHUB_RUN_ID:-}" --arg run_attempt "${GITHUB_RUN_ATTEMPT:-}" \
  --arg event "${GITHUB_EVENT_NAME:-}" --arg ref "${GITHUB_REF_NAME:-}" --arg head_ref "${GITHUB_HEAD_REF:-}" \
  --arg sha "${GITHUB_SHA:-}" --arg actor "${GITHUB_ACTOR:-}" --arg triggering_actor "${GITHUB_TRIGGERING_ACTOR:-}" \
  --arg runner "${RUNNER_NAME:-}" --arg workers "$workers" --arg load1 "$load1" --arg mem_avail_mb "$mem_avail_mb" '
  def nz: if . == "" then null else . end;
  def num: if . == "" or . == null then null else tonumber? // null end;
  ($ev[0] // {}) as $e
  | (($head_ref | nz) // ($e.pull_request.head.ref // null)) as $branch
  | ($e.pull_request.title // null) as $title
  | ($e.head_commit.message // "") as $msg
  | ([$branch, ($ref | nz), $title, $msg] | map(select(. != null) | scan("\\bIT-[0-9]+"; "i") | ascii_upcase) | first // null) as $issue
  | (($msg | capture("Claude-Session: *\\S*/(?<s>session_[A-Za-z0-9]+)") | .s) // null) as $session
  | (if ($msg | test("Claude-Session:|Co-Authored-By: *Claude"; "i")) then "claude"
     elif (($branch // "") | startswith("codex/")) then "codex"
     elif (($branch // "") | startswith("agent/")) then "autoagent"
     else null end) as $agent
  | {ts: $ts, started_at: $started, duration_s: $duration_s, cpu_s: $cpu_s,
     cpu_cores: (if ($duration_s // 0) > 0 and $cpu_s != null then ($cpu_s / $duration_s * 100 | round / 100) else null end),
     repo: ($repo | nz), workflow: ($workflow | nz), job: ($job | nz),
     run_id: ($run_id | num), run_attempt: ($run_attempt | num), event: ($event | nz),
     ref: ($ref | nz), head_ref: $branch, sha: ($sha | nz),
     pr: ($e.pull_request.number // null), pr_title: (if $title then $title[0:200] else null end),
     pr_author: ($e.pull_request.user.login // null),
     actor: ($actor | nz), triggering_actor: ($triggering_actor | nz),
     issue: $issue, agent: $agent, session: $session,
     runner: ($runner | nz), workers_running: ($workers | num),
     vm_load1: ($load1 | num), vm_mem_avail_mb: ($mem_avail_mb | num)}' 2>/dev/null)" || line=""

if [[ -z "$line" ]]; then
  echo "CI job-napló: nem sikerült a sort összeállítani, kihagyva."
  exit 0
fi

mkdir -p "$(dirname "$log")" 2>/dev/null || true
size="$(stat -c %s "$log" 2>/dev/null || stat -f %z "$log" 2>/dev/null)" || size=0
if (( ${size:-0} > max_bytes )); then mv -f "$log" "$log.1" 2>/dev/null || true; fi
# egy sor egyetlen write: a párhuzamos runnerek sorai nem keverednek
printf '%s\n' "$line" >> "$log" 2>/dev/null || { echo "CI job-napló: nem írható: $log"; exit 0; }

if [[ "$cpu_s" != null && "$duration_s" != null ]]; then
  echo "CI job-napló: ${duration_s} s, ${cpu_s} CPU-s (konténerek nélkül), ${workers:-?} job futott a VM-ben → ${log}"
fi
exit 0
