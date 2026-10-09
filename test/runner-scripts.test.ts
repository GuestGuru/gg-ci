import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// A gg-runner VM üzemeltetési szkriptjei (IT-1496). Két rész:
// 1. shellcheck minden runner-szkriptre (és az install.sh VM-ben futó részére);
//    a CI-ban kötelező, helyben kimarad, ha nincs shellcheck a gépen.
// 2. az install.sh hamis `colima`/`systemctl` paranccsal: a „VM” egy ideiglenes
//    könyvtár, így a telepítés, az idempotencia és a visszamérés mérhető.

const runnerDir = new URL('../runner/', import.meta.url).pathname
const installScript = join(runnerDir, 'install.sh')
const runnerScripts = ['disk-guard.sh', 'playwright-install.sh', 'install.sh']

const hasShellcheck =
	spawnSync('/bin/sh', ['-c', 'command -v shellcheck'], { encoding: 'utf8' }).stdout.trim() !== ''

describe('runner scripts: shellcheck (IT-1496)', () => {
	// A CI-ban (GitHub-hosted ubuntu-latest) a shellcheck elő van telepítve; ott a
	// hiánya hiba, nem csendes kihagyás.
	it.runIf(hasShellcheck || process.env.CI)('passes on every runner script', () => {
		const result = spawnSync(
			'shellcheck',
			[...runnerScripts, '../.github/actions/playwright-chromium/install.sh'],
			{ cwd: runnerDir, encoding: 'utf8' },
		)
		expect(result.error).toBeUndefined()
		expect(result.stdout + result.stderr).toBe('')
		expect(result.status).toBe(0)
	})

	it.runIf(hasShellcheck || process.env.CI)('passes on the part of install.sh that runs in the VM', () => {
		const source = readFileSync(installScript, 'utf8')
		const remote = source.match(/^remote_script='\n([\s\S]*?)\n'$/m)?.[1]
		expect(remote).toBeDefined()
		const result = spawnSync('shellcheck', ['-s', 'bash', '-'], {
			cwd: runnerDir,
			encoding: 'utf8',
			input: remote,
		})
		expect(result.error).toBeUndefined()
		expect(result.stdout + result.stderr).toBe('')
		expect(result.status).toBe(0)
	})
})

// A `colima ssh -p <profil> -- <parancs…>` helyben futtatja a parancsot, a „VM”
// HOME-jával; a `colima status` a STUB_COLIMA_STATUS kóddal tér vissza.
const colimaStub = `#!/bin/bash
case "$1" in
	status) exit "\${STUB_COLIMA_STATUS:-0}" ;;
	ssh)
		shift
		[ "$1" = -p ] && shift 2
		[ "$1" = -- ] && shift
		HOME="$STUB_VM_HOME" exec "$@"
		;;
esac
exit 64
`

// list-units: a STUB_UNITS egységei; show -p <tulajdonság> --value <egység>:
// a munkakönyvtár a VM HOME-ja alatt az egység nevén.
const systemctlStub = `#!/bin/bash
case "$1" in
	list-units)
		for u in $STUB_UNITS; do echo "$u loaded active running GitHub Actions Runner"; done
		;;
	show)
		case "$3" in
			WorkingDirectory) echo "$STUB_VM_HOME/$5" ;;
			ActiveState) echo active ;;
		esac
		;;
esac
`

describe('runner/install.sh (IT-1496)', () => {
	let root: string
	let vmHome: string
	let pwDir: string
	const unit1 = 'actions.runner.Org.vm-1.service'
	const unit2 = 'actions.runner.Org.vm-2.service'
	const units = [unit1, unit2]

	const hookPath = () => join(vmHome, 'runner-hooks', 'disk-guard.sh')
	const pwInstaller = () => join(pwDir, 'telepit.sh')

	const writeEnv = (unit: string, hook = hookPath()) => {
		mkdirSync(join(vmHome, unit), { recursive: true })
		writeFileSync(
			join(vmHome, unit, '.env'),
			[
				'LANG=C.UTF-8',
				`ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${hook}`,
				`GG_PLAYWRIGHT=${pwDir}/node_modules/playwright/index.mjs`,
				`GG_PLAYWRIGHT_BROWSERS_PATH=${pwDir}/browsers`,
				'SOME_TOKEN=do-not-print-me',
				'',
			].join('\n'),
		)
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'gg-ci-runner-'))
		vmHome = join(root, 'vm-home')
		pwDir = join(root, 'opt', 'gg-playwright')
		const stubDir = join(root, 'bin')
		mkdirSync(stubDir)
		mkdirSync(vmHome)
		for (const [name, body] of [
			['colima', colimaStub],
			['systemctl', systemctlStub],
		] as const) {
			writeFileSync(join(stubDir, name), body)
			chmodSync(join(stubDir, name), 0o755)
		}
		for (const unit of units) writeEnv(unit)
	})

	afterEach(() => {
		rmSync(root, { recursive: true, force: true })
	})

	const run = (args: string[] = [], env: Record<string, string> = {}) => {
		const result = spawnSync('/bin/bash', [installScript, ...args], {
			encoding: 'utf8',
			env: {
				PATH: `${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
				STUB_VM_HOME: vmHome,
				STUB_UNITS: units.join(' '),
				GG_RUNNER_PLAYWRIGHT_DIR: pwDir,
				...env,
			},
		})
		return { status: result.status, out: result.stdout, err: result.stderr }
	}

	it('installs both scripts byte-identically with mode 755, then reports the runners', () => {
		const r = run()
		expect(r.err).toBe('')
		expect(r.status).toBe(0)
		for (const [src, dest] of [
			['disk-guard.sh', hookPath()],
			['playwright-install.sh', pwInstaller()],
		] as const) {
			expect(readFileSync(dest)).toEqual(readFileSync(join(runnerDir, src)))
			expect(statSync(dest).mode & 0o777).toBe(0o755)
		}
		expect(r.out).toContain(`telepítve: ~/runner-hooks/disk-guard.sh (előtte: hiányzik;`)
		expect(r.out).toContain(`telepítve: ${pwInstaller()}`)
		expect(r.out.match(/ {2}rendben: /g)).toHaveLength(2)
		expect(r.out).toContain('a VM playwright-modulja: nincs telepítve')
		expect(r.out).toContain('EREDMÉNY: a VM a repóval egyezik.')
	})

	it('is idempotent: the second run and --check only measure', () => {
		expect(run().status).toBe(0)
		const before = statSync(hookPath()).mtimeMs
		for (const args of [[], ['--check']]) {
			const r = run(args)
			expect(r.status).toBe(0)
			expect(r.out).not.toMatch(/^telepítve:/m)
			expect(r.out.match(/^változatlan: /gm)).toHaveLength(2)
		}
		expect(statSync(hookPath()).mtimeMs).toBe(before)
	})

	it('--check reports a drifted file and a wrong mode without writing', () => {
		expect(run().status).toBe(0)
		writeFileSync(hookPath(), '#!/bin/bash\nexit 0\n')
		chmodSync(pwInstaller(), 0o775)
		const r = run(['--check'])
		expect(r.status).toBe(1)
		expect(r.err).toMatch(/ELTÉR: ~\/runner-hooks\/disk-guard\.sh — a VM-ben: [0-9a-f]{64} 755/)
		expect(r.err).toMatch(/ELTÉR: .*telepit\.sh — a VM-ben: [0-9a-f]{64} 775/)
		expect(readFileSync(hookPath(), 'utf8')).toBe('#!/bin/bash\nexit 0\n')
		// a sima futás helyreállítja
		expect(run().status).toBe(0)
		expect(readFileSync(hookPath())).toEqual(readFileSync(join(runnerDir, 'disk-guard.sh')))
	})

	it('fails on a runner whose .env points elsewhere, and prints only the three checked keys', () => {
		writeEnv(unit2, '/elsewhere/hook.sh')
		const r = run()
		expect(r.status).toBe(1)
		expect(r.err).toContain('ELTÉR: actions.runner.Org.vm-2 ')
		expect(r.err).toContain('ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/elsewhere/hook.sh')
		expect(r.out).toContain('rendben: actions.runner.Org.vm-1 ')
		expect(r.out + r.err).not.toContain('do-not-print-me')
		expect(r.out + r.err).not.toContain('LANG=')
	})

	it('fails when the VM has no runner unit', () => {
		const r = run([], { STUB_UNITS: '' })
		expect(r.status).toBe(1)
		expect(r.err).toContain('egyetlen actions.runner.* systemd-egység sincs')
	})

	it('stops before touching anything when the profile is not running, or on a bad argument', () => {
		const down = run([], { STUB_COLIMA_STATUS: '1' })
		expect(down.status).toBe(2)
		expect(down.err).toContain("a(z) 'ci' Colima-profil nem fut")
		const bad = run(['--force'])
		expect(bad.status).toBe(2)
		expect(bad.err).toContain('használat:')
		expect(() => statSync(hookPath())).toThrow()
	})
})
