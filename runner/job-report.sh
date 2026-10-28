#!/usr/bin/env bash
# IT-2011 — összesítés a runner job-naplójából (runner/job-log.sh): mely repók, jobok,
# issue-k vagy agentek terhelték a gg-runner VM-et. A VM gazdagépén (gg-mb) fut:
#
#   runner/job-report.sh                # az utolsó 24 óra, repó + job szerint
#   runner/job-report.sh 72 issue       # az utolsó 72 óra, issue szerint
#
# Csoport: job (repó + workflow + job, alapértelmezés) | repo | issue | agent | runner.
# Oszlopok: jobszám, összes futásidő és CPU-idő (perc), átlagos és legnagyobb
# magszám (CPU-idő / futásidő), leghosszabb futás (perc). CPU-idő szerint csökkenő.
# A CPU-idő a konténerek (services:, container:) nélkül értendő, l. job-log.sh.
#
# Felülírható: GG_RUNNER_COLIMA_PROFILE (ci), GG_RUNNER_JOB_LOG (~/runner-hooks/job-log.jsonl).
set -euo pipefail

hours="${1:-24}"
group="${2:-job}"
profile="${GG_RUNNER_COLIMA_PROFILE:-ci}"
log="${GG_RUNNER_JOB_LOG:-~/runner-hooks/job-log.jsonl}"

[[ "$hours" =~ ^[0-9]+$ ]] || { echo "használat: $0 [órák] [job|repo|issue|agent|runner]" >&2; exit 2; }
case "$group" in
  job) key='"\(.repo) · \(.workflow) · \(.job)"' ;;
  repo|issue|agent|runner) key=".${group} // \"?\"" ;;
  *) echo "használat: $0 [órák] [job|repo|issue|agent|runner]" >&2; exit 2 ;;
esac

since="$(date -u -v-"${hours}"H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "-${hours} hours" +%Y-%m-%dT%H:%M:%SZ)"

# shellcheck disable=SC2016 # a $-ok a jq-programban, a VM-ben bontódnak ki
program='
  def r1: . * 10 | round / 10;
  [inputs | select(.ts >= $since)]
  | group_by('"$key"')
  | map({k: (.[0] | '"$key"'), n: length,
         dur: (map(.duration_s // 0) | add / 60),
         cpu: (map(.cpu_s // 0) | add / 60),
         maxc: (map(.cpu_cores // 0) | max),
         maxd: (map(.duration_s // 0) | max / 60)})
  | sort_by(-.cpu)
  | (["CPU-perc", "futásperc", "átl. mag", "max mag", "max perc", "db", "'"$group"'"] | @tsv),
    (.[] | [(.cpu | r1), (.dur | r1), (if .dur > 0 then .cpu / .dur | r1 else 0 end), (.maxc | r1), (.maxd | r1), .n, .k] | @tsv)
'

echo "Job-napló, ${since} óta, csoport: ${group} (CPU-idő konténerek nélkül)"
# a "~/" a VM-felhasználó HOME-ja; a forgatott .1 fájl is számít
# shellcheck disable=SC2016 # a VM-ben bontódik ki
colima ssh -p "$profile" -- bash -c '
  f="$1"; case "$f" in "~/"*) f="$HOME/${f#"~/"}" ;; esac
  files=("$f.1" "$f")
  ex=(); for x in "${files[@]}"; do [[ -f "$x" ]] && ex+=("$x"); done
  (( ${#ex[@]} )) || { echo "nincs job-napló: $f" >&2; exit 1; }
  jq -n -r --arg since "$2" "$3" "${ex[@]}"
' job-report "$log" "$since" "$program" | column -t -s $'\t'
