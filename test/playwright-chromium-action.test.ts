import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// A közös Playwright-telepítő action (IT-1256). A szkriptet hamis `npx`/`pnpm`
// paranccsal futtatjuk: a stub naplózza az argumentumait, és a környezet szerint
// bukik vagy lóg, így a kötelező és a best-effort ág viselkedése mérhető.

const actionDir = new URL('../.github/actions/playwright-chromium/', import.meta.url)
const script = new URL('install.sh', actionDir).pathname

const stub = `#!/bin/bash
echo "\${0##*/} $*" >> "$STUB_LOG"
case "$*" in
	*install-deps*)
		[ -n "\${STUB_DEPS_SLEEP:-}" ] && /bin/sleep "$STUB_DEPS_SLEEP"
		exit "\${STUB_DEPS_EXIT:-0}"
		;;
	*install*) exit "\${STUB_INSTALL_EXIT:-0}" ;;
esac
`

// A GNU `timeout` könyvtára, ha a gépen van (Linuxon igen, macOS-en
// alapból nincs) — a valódi időtúllépést csak ott lehet mérni.
const timeoutDir = (() => {
	const found = spawnSync('/bin/sh', ['-c', 'command -v timeout'], {
		encoding: 'utf8',
	}).stdout.trim()
	return found ? dirname(found) : undefined
})()

describe('playwright-chromium action (IT-1256)', () => {
	let stubDir: string
	let log: string

	beforeEach(() => {
		stubDir = mkdtempSync(join(tmpdir(), 'gg-ci-pw-'))
		log = join(stubDir, 'calls.log')
		for (const name of ['npx', 'pnpm']) {
			writeFileSync(join(stubDir, name), stub)
			chmodSync(join(stubDir, name), 0o755)
		}
	})

	afterEach(() => {
		rmSync(stubDir, { recursive: true, force: true })
	})

	const run = (env: Record<string, string>, withTimeout = true) => {
		const started = Date.now()
		const result = spawnSync('/bin/bash', [script], {
			encoding: 'utf8',
			env: {
				PATH: [stubDir, ...(withTimeout && timeoutDir ? [timeoutDir] : [])].join(':'),
				STUB_LOG: log,
				...env,
			},
		})
		let calls: string[] = []
		try {
			calls = readFileSync(log, 'utf8').trim().split('\n')
		} catch {
			// Egyetlen hívás sem történt.
		}
		return { ...result, calls, seconds: (Date.now() - started) / 1000 }
	}

	it('runs the composite step through install.sh with the inputs as env', () => {
		const action = parse(readFileSync(new URL('action.yml', actionDir), 'utf8'))
		expect(action.runs.using).toBe('composite')
		expect(action.inputs['working-directory'].default).toBe('.')
		expect(action.inputs['package-manager'].default).toBe('npm')
		expect(action.runs.steps).toHaveLength(1)
		const [step] = action.runs.steps
		expect(step.shell).toBe('bash')
		expect(step['working-directory']).toBe('${{ inputs.working-directory }}')
		expect(step.env.PACKAGE_MANAGER).toBe('${{ inputs.package-manager }}')
		expect(step.run).toBe('bash "$GITHUB_ACTION_PATH/install.sh"')
		// Composite lépésen ezek nem támogatott / nem kívánt kulcsok: a keret a szkriptben van.
		expect(step).not.toHaveProperty('timeout-minutes')
		expect(step).not.toHaveProperty('continue-on-error')
	})

	it.runIf(timeoutDir)('installs the browser, then the system packages, with npx by default', () => {
		const result = run({})
		expect(result.status).toBe(0)
		expect(result.calls).toEqual([
			'npx playwright install chromium',
			'npx playwright install-deps chromium',
		])
		expect(result.stdout).not.toContain('::warning::')
	})

	it.runIf(timeoutDir)('uses pnpm exec when package-manager is pnpm', () => {
		const result = run({ PACKAGE_MANAGER: 'pnpm' })
		expect(result.status).toBe(0)
		expect(result.calls).toEqual([
			'pnpm exec playwright install chromium',
			'pnpm exec playwright install-deps chromium',
		])
	})

	it('fails when the browser cannot be installed, and skips the system packages', () => {
		const result = run({ STUB_INSTALL_EXIT: '3' })
		expect(result.status).toBe(3)
		expect(result.calls).toEqual(['npx playwright install chromium'])
	})

	it.runIf(timeoutDir)('warns but succeeds when the system packages fail', () => {
		const result = run({ STUB_DEPS_EXIT: '100' })
		expect(result.status).toBe(0)
		expect(result.stdout).toContain('::warning::Playwright\'s system packages could not be installed (exit 100;')
	})

	it.runIf(timeoutDir)('stops a hanging system-package install at the limit, warns, and succeeds', () => {
		const result = run({ STUB_DEPS_SLEEP: '30', DEPS_TIMEOUT_SECONDS: '1' })
		expect(result.status).toBe(0)
		expect(result.seconds).toBeLessThan(10)
		expect(result.stdout).toContain('::warning::Playwright\'s system packages did not install within 1s')
	})

	it('skips the system packages with a warning when there is no timeout command', () => {
		const result = run({}, false)
		expect(result.status).toBe(0)
		expect(result.calls).toEqual(['npx playwright install chromium'])
		expect(result.stdout).toContain('::warning::No timeout command on this runner')
	})

	it('rejects an unknown package manager and a malformed limit before installing anything', () => {
		const wrongManager = run({ PACKAGE_MANAGER: 'yarn' })
		expect(wrongManager.status).toBe(1)
		expect(wrongManager.stdout).toContain("::error::package-manager must be npm or pnpm, got 'yarn'")
		const wrongLimit = run({ DEPS_TIMEOUT_SECONDS: '2m' })
		expect(wrongLimit.status).toBe(1)
		expect(wrongLimit.calls).toEqual([])
	})
})
