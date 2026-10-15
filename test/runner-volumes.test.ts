import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// /proc, flock és GNU timeout: ugyanaz a környezet kell, mint a runner VM-ben.
describe('runner volume guard (IT-1732)', () => {
	it.skipIf(process.platform !== 'linux')('protects jobs and resumes listeners on success and failure', () => {
		const result = spawnSync('python3', [
			new URL('./runner-volumes-test.py', import.meta.url).pathname,
			new URL('../runner/disk-guard-volumes.sh', import.meta.url).pathname,
		], { encoding: 'utf8', timeout: 30_000 })
		expect(result.error).toBeUndefined()
		expect(result.stdout + result.stderr).toContain('Ran 13 tests')
		expect(result.status, result.stdout + result.stderr).toBe(0)
	})
})
