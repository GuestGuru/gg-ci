import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// A bő tesztsorok gg-mb-s indítója (IT-1808): a lista formátuma, és a dispatch.sh
// hamis `gh`-val — a hibás indítás nem állítja meg a többit, a kilépési kód 1, és a
// weekly sorok csak hétfőn mennek.

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

// A hamis gh: `workflow run` a FAIL_REPO-ra hibázik, minden más futás azonnal kész
// (success); minden hívás a GH_CALLS fájlba íródik.
const ghStub = `#!/bin/bash
echo "$*" >> "$GH_CALLS"
case "$1 $2" in
	"workflow run") [[ "$*" == *"$FAIL_REPO"* ]] && exit 1; exit 0 ;;
	"run list") echo "42 https://example.test/runs/42" ;;
	"run view") echo "completed success" ;;
esac
`

describe('scheduled-dispatch: dispatch.sh', () => {
	let tmp: string
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), 'gg-dispatch-'))
		writeFileSync(join(tmp, 'gh'), ghStub)
		chmodSync(join(tmp, 'gh'), 0o755)
		writeFileSync(
			join(tmp, 'list.tsv'),
			['# komment', 'a\tx.yml\tmain\tnightly', 'b\ty.yml\tmain\tnightly', 'c\tz.yml\tmain\tweekly', ''].join('\n'),
		)
	})
	afterEach(() => rmSync(tmp, { recursive: true, force: true }))

	const run = (args: string[], env: Record<string, string>) =>
		spawnSync('bash', [dispatch, ...args], {
			encoding: 'utf8',
			env: {
				...process.env,
				GG_DISPATCH_GH: join(tmp, 'gh'),
				GG_DISPATCH_LIST: join(tmp, 'list.tsv'),
				GG_DISPATCH_POLL_SECONDS: '0',
				GG_DISPATCH_LOCK: join(tmp, 'lock'),
				GH_CALLS: join(tmp, 'calls'),
				FAIL_REPO: 'nothing',
				...env,
			},
		})
	const dispatched = () =>
		readFileSync(join(tmp, 'calls'), 'utf8')
			.split('\n')
			.filter((line) => line.startsWith('workflow run'))

	it('dispatches only the nightly rows on a weekday other than Monday', () => {
		const result = run([], { GG_DISPATCH_WEEKDAY: '3' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatched()).toEqual([
			'workflow run x.yml -R GuestGuru/a --ref main',
			'workflow run y.yml -R GuestGuru/b --ref main',
		])
		expect(result.stdout).toContain('futás: https://example.test/runs/42')
	})

	it('adds the weekly rows after the nightly ones on Monday', () => {
		const result = run([], { GG_DISPATCH_WEEKDAY: '1' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatched().map((line) => line.split(' ')[2])).toEqual(['x.yml', 'y.yml', 'z.yml'])
	})

	it('keeps going after a failed dispatch and exits non-zero', () => {
		const result = run(['nightly'], { FAIL_REPO: 'GuestGuru/a' })
		expect(result.status).toBe(1)
		expect(dispatched()).toHaveLength(2)
		expect(result.stdout).toContain('HIBA: nem indult: GuestGuru/a x.yml@main')
		expect(result.stdout).toContain('kész: success')
	})

	it('refuses to run twice at the same time', () => {
		spawnSync('mkdir', [join(tmp, 'lock')])
		const result = run(['nightly'], {})
		expect(result.status).toBe(1)
		expect(result.stdout).toContain('már fut')
	})
})
