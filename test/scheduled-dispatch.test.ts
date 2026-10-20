import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// A bő tesztsorok gg-mb-s indítója (IT-1808): a lista formátuma, és a dispatch.sh
// hamis `gh`-val — a saját futását várja ki, a hibás indítás nem állítja meg a többit,
// a kilépési kód 1, a weekly sorok csak hétfőn mennek, a zár nem marad bent, és a
// launchd-mód csak 01 UTC-kor indít.

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
	it('every row has repo, workflow file, ref and a known frequency', () => {
		const rows = readFileSync(join(dir, 'schedule.tsv'), 'utf8')
			.split('\n')
			.filter((line) => line.trim() !== '' && !line.startsWith('#'))
		expect(rows.length).toBeGreaterThan(0)
		for (const row of rows) {
			const [repo, workflow, ref, frequency, ...rest] = row.split('\t')
			expect(rest, row).toEqual([])
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
// lóg. Minden hívás a GH_CALLS fájlba íródik.
const ghStub = `#!/bin/bash
echo "$*" >> "$GH_CALLS"
case "$1 $2" in
	"workflow run")
		[[ "$*" == *"$FAIL_REPO"* ]] && exit 1
		[[ "$*" == *"$NOURL_REPO"* ]] && exit 0
		echo "https://github.com/$5/actions/runs/$((1000 + $(grep -c "^workflow run" "$GH_CALLS")))" ;;
	"run watch")
		[[ -n "\${WATCH_SLEEP:-}" ]] && exec sleep "$WATCH_SLEEP"
		[[ "$3" == "\${WATCH_FAIL:-}" ]] && exit 1
		exit 0 ;;
	"run view") echo "failure" ;;
esac
`

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
		...extra,
	})
	const run = (args: string[], extra: Record<string, string>) =>
		spawnSync('bash', [dispatch, ...args], { encoding: 'utf8', env: env(extra) })
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
})
