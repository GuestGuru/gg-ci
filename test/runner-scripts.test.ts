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
const runnerScripts = ['disk-guard.sh', 'disk-guard-volumes.sh', 'job-log.sh', 'job-report.sh', 'playwright-install.sh', 'install.sh']

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
// a munkakönyvtár a VM HOME-ja alatt az egység nevén. A fstrim.timer modellje: a
// drop-in a daemon-reload után számít betöltöttnek (marker), és ha a fájl újabb a
// markernél, NeedDaemonReload=yes. daemon-reload/restart naplózva; STUB_RELOAD_FAIL=1
// esetén a daemon-reload elbukik.
const systemctlStub = `#!/bin/bash
marker="$STUB_SYSTEMCTL_LOG.reloaded"
case "$1" in
	daemon-reload)
		echo "$*" >> "$STUB_SYSTEMCTL_LOG"
		[ "\${STUB_RELOAD_FAIL:-0}" = 1 ] && exit 1
		touch "$marker"
		;;
	restart) echo "$*" >> "$STUB_SYSTEMCTL_LOG" ;;
	list-units)
		for u in $STUB_UNITS; do echo "$u loaded active running GitHub Actions Runner"; done
		;;
	show)
		case "$3" in
			WorkingDirectory) echo "$STUB_VM_HOME/$5" ;;
			ActiveState) echo active ;;
			DropInPaths) [ -e "$marker" ] && [ -f "$STUB_DROPIN" ] && echo "$STUB_DROPIN" ;;
			NeedDaemonReload) if [ -f "$STUB_DROPIN" ] && [ "$STUB_DROPIN" -nt "$marker" ]; then echo yes; else echo no; fi ;;
		esac
		;;
esac
exit 0
`

// egy futás sok `colima ssh` stub-hívás; terhelt gépen az 5 mp-es alapkeret kevés
describe('runner/install.sh (IT-1496)', { timeout: 30_000 }, () => {
	let root: string
	let vmHome: string
	let pwDir: string
	const unit1 = 'actions.runner.Org.vm-1.service'
	const unit2 = 'actions.runner.Org.vm-2.service'
	const units = [unit1, unit2]

	const hookPath = () => join(vmHome, 'runner-hooks', 'disk-guard.sh')
	const pwInstaller = () => join(pwDir, 'telepit.sh')
	const fstrimDropIn = () => join(root, 'systemd', 'fstrim.timer.d', 'gg-daily.conf')
	const systemctlLog = () => {
		try {
			return readFileSync(join(root, 'systemctl.log'), 'utf8')
		} catch {
			return ''
		}
	}

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
				GG_RUNNER_SYSTEMD_DIR: join(root, 'systemd'),
				STUB_SYSTEMCTL_LOG: join(root, 'systemctl.log'),
				STUB_DROPIN: fstrimDropIn(),
				...env,
			},
		})
		return { status: result.status, out: result.stdout, err: result.stderr }
	}

	it('installs the four scripts (755) and the fstrim drop-in (644) byte-identically, then reports the runners', () => {
		const r = run()
		expect(r.err).toBe('')
		expect(r.status).toBe(0)
		for (const [src, dest] of [
			['disk-guard.sh', hookPath()],
			['disk-guard-volumes.sh', join(vmHome, 'runner-hooks', 'disk-guard-volumes.sh')],
			['job-log.sh', join(vmHome, 'runner-hooks', 'job-log.sh')],
			['playwright-install.sh', pwInstaller()],
		] as const) {
			expect(readFileSync(dest)).toEqual(readFileSync(join(runnerDir, src)))
			expect(statSync(dest).mode & 0o777).toBe(0o755)
		}
		expect(r.out).toContain(`telepítve: ~/runner-hooks/disk-guard.sh (előtte: hiányzik;`)
		expect(r.out).toContain(`telepítve: ${pwInstaller()}`)
		// IT-2105: a napi fstrim drop-in 644-es móddal, utána daemon-reload + timer-újraindítás
		expect(readFileSync(fstrimDropIn())).toEqual(readFileSync(join(runnerDir, 'fstrim-timer-daily.conf')))
		expect(statSync(fstrimDropIn()).mode & 0o777).toBe(0o644)
		expect(systemctlLog()).toBe('daemon-reload\nrestart fstrim.timer\n')
		expect(r.out).toContain('fstrim.timer: daemon-reload és újraindítás megtörtént')
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
			expect(r.out.match(/^változatlan: /gm)).toHaveLength(5)
		}
		// a változatlan drop-in nem indítja újra a timert
		expect(systemctlLog()).toBe('daemon-reload\nrestart fstrim.timer\n')
		expect(statSync(hookPath()).mtimeMs).toBe(before)
	})

	it('IT-2105: a failed reload is retried on the next run, and --check reports it until then', () => {
		const failed = run([], { STUB_RELOAD_FAIL: '1' })
		expect(failed.status).not.toBe(0)
		// a fájl már a helyén van, de a systemd nem töltötte be
		expect(readFileSync(fstrimDropIn())).toEqual(readFileSync(join(runnerDir, 'fstrim-timer-daily.conf')))
		const check = run(['--check'])
		expect(check.status).toBe(1)
		expect(check.err).toContain('ELTÉR: fstrim.timer — betöltve: nem')
		const retry = run()
		expect(retry.status).toBe(0)
		expect(retry.out).toMatch(/^változatlan: .*gg-daily\.conf/m)
		expect(retry.out).toContain('fstrim.timer: daemon-reload és újraindítás megtörtént')
		expect(run(['--check']).status).toBe(0)
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
