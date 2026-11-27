import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// A bő tesztsorok gg-mb-s indítója (IT-1808): a lista formátuma, és a dispatch.sh
// hamis `gh`-val — a saját futását várja ki, a hibás indítás nem állítja meg a többit,
// a kilépési kód 1, a weekly sorok csak hétfőn mennek, a zár nem marad bent, és a
// launchd-mód csak 01 UTC-kor indít. A `changed` feltételű sor (IT-2165) kimarad, ha az ág
// fején a legutóbbi befejezett futás sikeres, és elindul, ha nem az, ha még nem volt, vagy ha
// ez nem állapítható meg.

const dir = new URL('../scheduled-dispatch/', import.meta.url).pathname
const dispatch = join(dir, 'dispatch.sh')

const hasShellcheck =
	spawnSync('/bin/sh', ['-c', 'command -v shellcheck'], { encoding: 'utf8' }).stdout.trim() !== ''

describe('scheduled-dispatch: shellcheck', () => {
	it.runIf(hasShellcheck || process.env.CI)('passes on dispatch.sh and install.sh', () => {
		const result = spawnSync('shellcheck', ['dispatch.sh', 'install.sh'], { cwd: dir, encoding: 'utf8' })
		expect(result.error).toBeUndefined()
		expect(result.stdout + result.stderr).toBe('')
		expect(result.status).toBe(0)
	})
})

describe('scheduled-dispatch: schedule.tsv', () => {
	it('every row has repo, workflow file, ref, a known frequency and at most a known condition', () => {
		const rows = readFileSync(join(dir, 'schedule.tsv'), 'utf8')
			.split('\n')
			.filter((line) => line.trim() !== '' && !line.startsWith('#'))
		expect(rows.length).toBeGreaterThan(0)
		for (const row of rows) {
			const [repo, workflow, ref, frequency, condition, ...rest] = row.split('\t')
			expect(rest, row).toEqual([])
			// az ötödik oszlop elhagyható; ha van, csak ismert feltétel lehet
			expect([undefined, 'changed'], row).toContain(condition)
			expect(repo, row).toMatch(/^[A-Za-z0-9_.-]+$/)
			expect(workflow, row).toMatch(/^[A-Za-z0-9_.-]+\.ya?ml$/)
			expect(ref, row).toBe('main')
			expect(['nightly', 'weekly'], row).toContain(frequency)
		}
	})
})

// A hamis gh: a `workflow run` a futás URL-jét írja ki (mint a valódi, nem terminálon),
// az azonosító 1000 + az indítás sorszáma; a FAIL_REPO-ra hibázik, a NOURL_REPO-ra URL nélkül
// sikeres. A `run watch` a WATCH_FAIL azonosítóra 1-gyel lép ki, WATCH_SLEEP mellett
// lóg, WATCH_FLAKY mellett az első hívása hibázik; a `run view` a VIEW_STATE-et adja,
// VIEW_SLEEP mellett lóg. Minden hívás a GH_CALLS fájlba íródik.
// Az `api` a `changed` feltétel két olvasó hívása (a valódi gh a --jq szűrő eredményét írja ki):
// a `…/git/ref/heads/<ág>` a HEAD_SHA-t adja; a `…/runs?…` a legutóbbi befejezett futást
// "<sha> <eredmény>" alakban — a GREEN_REPO-ra "<HEAD_SHA> success", másra "null null" (nincs
// befejezett futás), RUNS_OUTPUT mellett azt. A HEAD_FAIL_REPO-ra, ill. a RUNS_FAIL_REPO-ra a
// megfelelő hívás hibázik; RUNS_EXIT mellett a futások hívása kiírja a választ, de ezzel a kóddal
// lép ki. HEAD_SLEEP, ill. RUNS_SLEEP mellett a megfelelő hívás lóg; RUN_SLEEP_FIRST mellett az
// első indítás.
const ghStub = `#!/bin/bash
echo "$*" >> "$GH_CALLS"
if [[ "$1" == api ]]; then
	case "$2" in
		*/git/ref/heads/*)
			[[ -n "\${HEAD_SLEEP:-}" ]] && exec sleep "$HEAD_SLEEP"
			[[ "$2" == *"$HEAD_FAIL_REPO/"* ]] && exit 1
			echo "$HEAD_SHA" ;;
		*/runs\\?*)
			[[ -n "\${RUNS_SLEEP:-}" ]] && exec sleep "$RUNS_SLEEP"
			[[ "$2" == *"$RUNS_FAIL_REPO/"* ]] && exit 1
			if [[ -n "\${RUNS_OUTPUT+set}" ]]; then echo "$RUNS_OUTPUT"
			elif [[ "$2" == *"$GREEN_REPO/"* ]]; then echo "$HEAD_SHA success"
			else echo "null null"; fi
			exit "\${RUNS_EXIT:-0}" ;;
	esac
	exit 0
fi
case "$1 $2" in
	"workflow run")
		# csak az első indítás lóg, a többi rendben megy
		[[ -n "\${RUN_SLEEP_FIRST:-}" && "$(grep -c "^workflow run" "$GH_CALLS")" == 1 ]] && exec sleep "$RUN_SLEEP_FIRST"
		[[ "$*" == *"$FAIL_REPO"* ]] && exit 1
		[[ "$*" == *"$NOURL_REPO"* ]] && exit 0
		echo "https://github.com/$5/actions/runs/$((1000 + $(grep -c "^workflow run" "$GH_CALLS")))" ;;
	"run watch")
		[[ -n "\${WATCH_SLEEP:-}" ]] && exec sleep "$WATCH_SLEEP"
		[[ "$3" == "\${WATCH_FAIL:-}" ]] && exit 1
		# az első watch átmeneti hibával lép ki (mint egy TLS handshake timeout)
		[[ -n "\${WATCH_FLAKY:-}" && "$(grep -c "^run watch" "$GH_CALLS")" == 1 ]] && exit 1
		exit 0 ;;
	"run view")
		[[ -n "\${VIEW_SLEEP:-}" ]] && exec sleep "$VIEW_SLEEP"
		echo "\${VIEW_STATE:-completed failure}" ;;
esac
`

// A ref feje a hamis gh szerint; a `changed` feltétel erre a commitra keres sikeres futást.
const headSha = 'a'.repeat(40)

// Egy háttérben futó másik indító, ami a zárat tartja (ugyanaz a flock, mint a dispatch.sh-ban).
const holdLock = (lock: string) =>
	spawn('bash', [
		'-c',
		`exec 9>"$1"; perl -MFcntl=:flock -e 'open(my $fh, ">&=", 9) or exit 2; flock($fh, LOCK_EX | LOCK_NB) or exit 1' && echo locked && exec sleep 30`,
		'holder',
		lock,
	])

// Minden eset több bash/perl/stub processzt indít: terhelt gépen az 5 s-os alapkeret kevés.
describe('scheduled-dispatch: dispatch.sh', { timeout: 20_000 }, () => {
	let tmp: string
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), 'gg-dispatch-'))
		writeFileSync(join(tmp, 'gh'), ghStub)
		chmodSync(join(tmp, 'gh'), 0o755)
		writeFileSync(join(tmp, 'calls'), '')
		writeFileSync(
			join(tmp, 'list.tsv'),
			['# komment', 'a\tx.yml\tmain\tnightly', 'b\ty.yml\tmain\tnightly', 'c\tz.yml\tmain\tweekly', ''].join('\n'),
		)
	})
	afterEach(() => rmSync(tmp, { recursive: true, force: true }))

	const env = (extra: Record<string, string>) => ({
		...process.env,
		GG_DISPATCH_GH: join(tmp, 'gh'),
		GG_DISPATCH_LIST: join(tmp, 'list.tsv'),
		GG_DISPATCH_POLL_SECONDS: '0',
		GG_DISPATCH_LOCK: join(tmp, 'lock'),
		GG_DISPATCH_RUN_NOW: join(tmp, 'run-now'),
		GH_CALLS: join(tmp, 'calls'),
		FAIL_REPO: 'nothing',
		NOURL_REPO: 'nothing',
		HEAD_SHA: headSha,
		HEAD_FAIL_REPO: 'nothing',
		RUNS_FAIL_REPO: 'nothing',
		GREEN_REPO: 'nothing',
		...extra,
	})
	// A szinkron gyerekfolyamatot a Vitest időkerete nem tudja megszakítani, ezért sajátot kap:
	// ha az indító beragadna (pl. egy időkeret nélküli hívásban), a futás itt ér véget, státusz nélkül.
	const run = (args: string[], extra: Record<string, string>) =>
		spawnSync('bash', [dispatch, ...args], {
			encoding: 'utf8',
			env: env(extra),
			timeout: 60_000,
			killSignal: 'SIGKILL',
		})
	const calls = (prefix: string) =>
		readFileSync(join(tmp, 'calls'), 'utf8')
			.split('\n')
			.filter((line) => line.startsWith(prefix))

	it('dispatches only the nightly rows on a weekday other than Monday, and watches each own run', () => {
		const result = run([], { GG_DISPATCH_WEEKDAY: '3' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(calls('workflow run')).toEqual([
			'workflow run x.yml -R GuestGuru/a --ref main',
			'workflow run y.yml -R GuestGuru/b --ref main',
		])
		// pontosan a gh által visszaadott futást várja ki, nem egy listából keresett korábbit
		expect(calls('run watch')).toEqual([
			'run watch 1001 -R GuestGuru/a --exit-status --interval 0',
			'run watch 1002 -R GuestGuru/b --exit-status --interval 0',
		])
		expect(calls('run list')).toEqual([])
		// feltétel nélküli sorra nincs előzetes lekérdezés
		expect(calls('api')).toEqual([])
		expect(result.stdout).toContain('kész: success: https://github.com/GuestGuru/a/actions/runs/1001')
	})

	it('adds the weekly rows after the nightly ones on Monday', () => {
		const result = run([], { GG_DISPATCH_WEEKDAY: '1' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(calls('workflow run').map((line) => line.split(' ')[2])).toEqual(['x.yml', 'y.yml', 'z.yml'])
	})

	it('keeps going after a failed dispatch and exits non-zero', () => {
		const result = run(['nightly'], { FAIL_REPO: 'GuestGuru/a' })
		expect(result.status).toBe(1)
		expect(calls('workflow run')).toHaveLength(2)
		expect(result.stdout).toContain('HIBA: nem indult: GuestGuru/a x.yml@main')
		expect(result.stdout).toContain('kész: success')
	})

	it('does not guess a run when gh returns no run URL', () => {
		const result = run(['nightly'], { NOURL_REPO: 'GuestGuru/a' })
		expect(result.status).toBe(1)
		expect(result.stdout).toContain('nem adta vissza a futás URL-jét: GuestGuru/a')
		expect(calls('run watch')).toHaveLength(1)
	})

	it('reports a failed run, goes on with the next row and exits non-zero', () => {
		const result = run(['nightly'], { WATCH_FAIL: '1001' })
		expect(result.status).toBe(1)
		expect(result.stdout).toContain('HIBA: failure: https://github.com/GuestGuru/a/actions/runs/1001')
		expect(result.stdout).toContain('kész: success: https://github.com/GuestGuru/b/actions/runs/1002')
	})

	it('re-watches the same run after a transient watch error while the run is still going', () => {
		const result = run(['nightly'], { WATCH_FLAKY: '1', VIEW_STATE: 'in_progress ' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(calls('run watch')).toEqual([
			'run watch 1001 -R GuestGuru/a --exit-status --interval 0',
			'run watch 1001 -R GuestGuru/a --exit-status --interval 0',
			'run watch 1002 -R GuestGuru/b --exit-status --interval 0',
		])
		expect(result.stdout).toContain('a futás nem ért véget (in_progress ), újra figyelem')
		expect(result.stdout).toContain('kész: success: https://github.com/GuestGuru/a/actions/runs/1001')
	})

	it('counts a run that finished successfully as success even if the watch errored', () => {
		const result = run(['nightly'], { WATCH_FAIL: '1001', VIEW_STATE: 'completed success' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(result.stdout).toContain('kész: success: https://github.com/GuestGuru/a/actions/runs/1001')
	})

	// A közös keret a watch utáni állapotlekérésre és az alvásra is érvényes: sem egy beragadt
	// `run view`, sem a keretnél hosszabb poll nem csúsztatja túl (a stub 30 mp-ig lógna).
	it.each([
		['a hanging run view', { VIEW_SLEEP: '30' }],
		['a poll longer than the remaining time', { VIEW_STATE: 'in_progress ', GG_DISPATCH_POLL_SECONDS: '30' }],
	])('keeps the wait budget after a watch error with %s', (_name, extra) => {
		const started = Date.now()
		const result = run(['weekly'], { WATCH_FLAKY: '1', GG_DISPATCH_WAIT_SECONDS: '2', ...extra })
		expect(Date.now() - started).toBeLessThan(15_000)
		expect(result.status).toBe(1)
		expect(result.stdout).toContain('2 mp után sem ért véget')
	})

	it('stops waiting after GG_DISPATCH_WAIT_SECONDS and moves on', () => {
		const result = run(['weekly'], { WATCH_SLEEP: '20', GG_DISPATCH_WAIT_SECONDS: '1' })
		expect(result.status).toBe(1)
		expect(result.stdout).toContain('1 mp után sem ért véget')
	})

	it('refuses to run while another dispatcher holds the lock', async () => {
		const holder = holdLock(join(tmp, 'lock'))
		await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()))
		const result = run(['nightly'], {})
		holder.kill('SIGKILL')
		expect(result.status).toBe(1)
		expect(result.stdout).toContain('már fut')
		expect(calls('workflow run')).toEqual([])
	})

	it('runs after the previous dispatcher was killed (no stale lock)', async () => {
		const holder = holdLock(join(tmp, 'lock'))
		await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()))
		holder.kill('SIGKILL')
		await new Promise((resolve) => holder.once('exit', resolve))
		const result = run(['nightly'], {})
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(calls('workflow run')).toHaveLength(2)
	})

	it('scheduled mode exits quietly outside 01 UTC and runs at 01 UTC', () => {
		const quiet = run(['scheduled'], { GG_DISPATCH_HOUR: '00', GG_DISPATCH_WEEKDAY: '3' })
		expect(quiet.status).toBe(0)
		expect(quiet.stdout).toBe('')
		expect(calls('workflow run')).toEqual([])

		const night = run(['scheduled'], { GG_DISPATCH_HOUR: '01', GG_DISPATCH_WEEKDAY: '1' })
		expect(night.status, night.stdout + night.stderr).toBe(0)
		expect(calls('workflow run')).toHaveLength(3)
	})

	it('scheduled mode runs once at any hour when the run-now file exists, and removes it', () => {
		writeFileSync(join(tmp, 'run-now'), '')
		const result = run(['scheduled'], { GG_DISPATCH_HOUR: '14', GG_DISPATCH_WEEKDAY: '3' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(result.stdout).toContain('kézi indítás (run-now)')
		expect(calls('workflow run')).toHaveLength(2)
		expect(existsSync(join(tmp, 'run-now'))).toBe(false)
	})

	// --- a `changed` feltétel (IT-2165) ---

	const conditionalList = () =>
		writeFileSync(
			join(tmp, 'list.tsv'),
			['a\tx.yml\tmain\tnightly\tchanged', 'b\ty.yml\tmain\tnightly', ''].join('\n'),
		)
	const dispatchedWorkflows = () => calls('workflow run').map((line) => line.split(' ')[2])
	const skipped = 'kihagyva, a fej legutóbbi futása sikeres: GuestGuru/a x.yml@main (aaaaaaaaa)'
	const undetermined =
		'figyelmeztetés: nem állapítható meg, sikeres-e a fej legutóbbi futása, ezért elindul: GuestGuru/a x.yml@main'

	it('skips a changed row when the latest completed run on the head of the branch succeeded', () => {
		conditionalList()
		const result = run(['nightly'], { GREEN_REPO: 'GuestGuru/a' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		// Pontosan ez a két olvasó hívás megy ki, és csak a feltételes sorra: az ág feje, majd a
		// workflow legutóbbi BEFEJEZETT futása ezen a commiton és ezen az ágon.
		expect(calls('api')).toEqual([
			'api repos/GuestGuru/a/git/ref/heads/main --jq .object.sha',
			`api repos/GuestGuru/a/actions/workflows/x.yml/runs?head_sha=${headSha}&branch=main&status=completed&per_page=1 --jq .workflow_runs[0] | "\\(.head_sha) \\(.conclusion)"`,
		])
		expect(dispatchedWorkflows()).toEqual(['y.yml'])
		expect(result.stdout).toContain(skipped)
	})

	// Nem bukás: a fejen egyszerűen nincs zöld bizonyíték, ezért a sor figyelmeztetés nélkül indul.
	// A futások listája a legújabbal kezd (élesben mérve), így a „zöld után piros ugyanazon a
	// commiton” esetben a GitHub a pirosat adja vissza: a sor újra elindul, a korábbi zöld ellenére.
	it.each([
		['the head has no completed run yet', 'null null'],
		['the latest completed run on the head failed, even after an earlier success', `${headSha} failure`],
		['the latest completed run on the head was cancelled', `${headSha} cancelled`],
	])('dispatches a changed row without a warning when %s', (_name, runsOutput) => {
		conditionalList()
		const result = run(['nightly'], { GREEN_REPO: 'GuestGuru/a', RUNS_OUTPUT: runsOutput })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		expect(result.stdout).not.toContain('kihagyva')
		expect(result.stdout).not.toContain('nem állapítható meg')
	})

	// Fail-open: kihagyni csak pozitív bizonyítékra szabad. Ha a változás nem állapítható meg, a sor
	// elindul — egy fölös futás olcsóbb, mint egy csendben kimaradó tesztsor. A GREEN_REPO minden
	// esetben zöldet jelezne, ha a hibás ág nem érvényesülne.
	it.each([
		['the head lookup fails', { HEAD_FAIL_REPO: 'GuestGuru/a' }],
		['the head lookup returns no commit SHA', { HEAD_SHA: 'null' }],
		['the run lookup fails', { RUNS_FAIL_REPO: 'GuestGuru/a' }],
		['the run lookup prints a green answer but exits non-zero', { RUNS_EXIT: '1' }],
		['the run lookup returns nothing', { RUNS_OUTPUT: '' }],
		['the run lookup returns a success for another commit', { RUNS_OUTPUT: `${'b'.repeat(40)} success` }],
		['the run lookup returns the head without a conclusion', { RUNS_OUTPUT: `${headSha} ` }],
		['the run lookup returns only a success-like prefix', { RUNS_OUTPUT: `${headSha} successful` }],
		['the run lookup returns a count instead of a run', { RUNS_OUTPUT: '3' }],
	])('dispatches a changed row with a warning when %s', (_name, extra) => {
		conditionalList()
		const result = run(['nightly'], { GREEN_REPO: 'GuestGuru/a', ...extra })
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		expect(result.status, result.stdout + result.stderr).toBe(0)
	})

	it.each([
		['the head lookup fails', { HEAD_FAIL_REPO: 'GuestGuru/a' }],
		['the run lookup returns a success for another commit', { RUNS_OUTPUT: `${'b'.repeat(40)} success` }],
		['the run lookup returns nothing', { RUNS_OUTPUT: '' }],
	])('logs that the state is undetermined when %s', (_name, extra) => {
		conditionalList()
		const result = run(['nightly'], { GREEN_REPO: 'GuestGuru/a', ...extra })
		expect(result.stdout).toContain(undetermined)
	})

	// A lógó hívás 300 mp-ig tartana: ha az indító nem szabna neki keretet, a futtató 60 mp-es
	// saját kerete állítaná le (státusz nélkül), és a teszt elbukna. Faliórát nem mérünk.
	it.each([
		['head lookup', { HEAD_SLEEP: '300' }],
		['run lookup', { RUNS_SLEEP: '300' }],
	])('gives up on a hanging %s after GG_DISPATCH_CALL_SECONDS and dispatches the row', (_name, extra) => {
		conditionalList()
		const result = run(['nightly'], { GREEN_REPO: 'GuestGuru/a', GG_DISPATCH_CALL_SECONDS: '1', ...extra })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		expect(result.stdout).toContain(undetermined)
	})

	it('gives up on a hanging dispatch after GG_DISPATCH_CALL_SECONDS, does not retry it, and goes on', () => {
		const result = run(['nightly'], { GG_DISPATCH_CALL_SECONDS: '1', RUN_SLEEP_FIRST: '300' })
		expect(result.status).toBe(1)
		expect(calls('workflow run')).toEqual([
			'workflow run x.yml -R GuestGuru/a --ref main',
			'workflow run y.yml -R GuestGuru/b --ref main',
		])
		expect(result.stdout).toContain(
			'HIBA: az indítás 1 mp alatt nem válaszolt (a futás ettől még létrejöhetett), továbblépek: GuestGuru/a x.yml@main',
		)
		// a lógó indítás futását nem figyeljük (nincs URL-je), a következő sorét igen
		expect(calls('run watch')).toHaveLength(1)
		expect(result.stdout).toContain('kész: success')
	})

	it('reports an unknown condition, still dispatches the row and exits non-zero', () => {
		writeFileSync(join(tmp, 'list.tsv'), ['a\tx.yml\tmain\tnightly\tsometimes', ''].join('\n'))
		const result = run(['nightly'], { GREEN_REPO: 'GuestGuru/a' })
		expect(result.status).toBe(1)
		expect(calls('api')).toEqual([])
		expect(calls('workflow run')).toEqual(['workflow run x.yml -R GuestGuru/a --ref main'])
		expect(result.stdout).toContain(
			'HIBA: ismeretlen feltétel (sometimes), a sor feltétel nélkül indul: GuestGuru/a x.yml@main',
		)
	})

	it('applies the condition per frequency: a changed weekly row is not looked up on a weekday', () => {
		writeFileSync(
			join(tmp, 'list.tsv'),
			['a\tx.yml\tmain\tnightly', 'c\tz.yml\tmain\tweekly\tchanged', ''].join('\n'),
		)
		const weekday = run([], { GG_DISPATCH_WEEKDAY: '3' })
		expect(weekday.status, weekday.stdout + weekday.stderr).toBe(0)
		expect(calls('api')).toEqual([])
		expect(calls('workflow run')).toEqual(['workflow run x.yml -R GuestGuru/a --ref main'])

		const monday = run([], { GG_DISPATCH_WEEKDAY: '1', GREEN_REPO: 'GuestGuru/c' })
		expect(monday.status, monday.stdout + monday.stderr).toBe(0)
		expect(calls('api')).toHaveLength(2)
		// hétfőn a nightly sor újra megy, a zöld fejű weekly sor kimarad
		expect(calls('workflow run')).toHaveLength(2)
		expect(monday.stdout).toContain('kihagyva, a fej legutóbbi futása sikeres: GuestGuru/c z.yml@main')
	})

	// --- a lista sorvégei: egyik miatt sem maradhat ki csendben egy sor ---

	it('dispatches the last row even when the list does not end with a newline', () => {
		writeFileSync(join(tmp, 'list.tsv'), 'a\tx.yml\tmain\tnightly\nb\ty.yml\tmain\tnightly\tchanged')
		const result = run(['nightly'], {})
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		// a feltétel az utolsó, sortörés nélküli sorban is érvényes
		expect(calls('api')).toHaveLength(2)
	})

	it('reads a list with CRLF line endings: the frequency and the condition still match', () => {
		writeFileSync(
			join(tmp, 'list.tsv'),
			['# komment', 'a\tx.yml\tmain\tnightly', 'b\ty.yml\tmain\tnightly\tchanged', ''].join('\r\n'),
		)
		const result = run(['nightly'], { GREEN_REPO: 'GuestGuru/b' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatchedWorkflows()).toEqual(['x.yml'])
		expect(result.stdout).toContain('kihagyva, a fej legutóbbi futása sikeres: GuestGuru/b y.yml@main')
		expect(result.stdout).not.toContain('ismeretlen feltétel')
	})
})
