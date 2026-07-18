import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/config.js'

const BASE = [
	'--neon-project-id=proj_1',
	'--parent-branch-id=br-parent',
	'--role-name=app_role',
	'--database-name=app_db',
	'--vercel-project-id=prj_1',
	'--vercel-team-id=team_1',
	'--branch-prefix=preview/app',
	'--shared-branch-name=preview-shared',
	'--env-var-name=DB_URL',
	'--ttl-days=7',
]

const ENV = { NEON_API_KEY: 'neon-key', VERCEL_TOKEN: 'vercel-token' } as NodeJS.ProcessEnv

describe('parseArgs', () => {
	it('feldolgozza az ensure parancsot', () => {
		const result = parseArgs(['ensure', ...BASE, '--pr-number=42', '--git-branch=feat/x'], ENV)
		expect(result.command).toBe('ensure')
		expect(result.prNumber).toBe(42)
		expect(result.gitBranch).toBe('feat/x')
		expect(result.dryRun).toBe(false)
		expect(result.config.neonProjectId).toBe('proj_1')
		expect(result.config.ttlDays).toBe(7)
		expect(result.config.neonApiKey).toBe('neon-key')
		expect(result.config.vercelToken).toBe('vercel-token')
	})

	it('felismeri a --dry-run kapcsolót', () => {
		const result = parseArgs(['ensure', ...BASE, '--pr-number=1', '--git-branch=x', '--dry-run'], ENV)
		expect(result.dryRun).toBe(true)
	})

	it('vesszős PR-listát parse-ol a refresh-ttl-hez', () => {
		const result = parseArgs(['refresh-ttl', ...BASE, '--open-pr-numbers=1,2, 3'], ENV)
		expect(result.openPrNumbers).toEqual([1, 2, 3])
	})

	it('üres open-pr-numbers üres tömb, nem undefined', () => {
		const result = parseArgs(['refresh-ttl', ...BASE, '--open-pr-numbers='], ENV)
		expect(result.openPrNumbers).toEqual([])
	})

	it('teljesen hiányzó open-pr-numbers undefined marad', () => {
		const result = parseArgs(['refresh-ttl', ...BASE], ENV)
		expect(result.openPrNumbers).toBeUndefined()
	})

	it('hibázik ismeretlen parancsra', () => {
		expect(() => parseArgs(['nope', ...BASE], ENV)).toThrow(/Unknown command/)
	})

	it('hibázik hiányzó kötelező inputra', () => {
		expect(() => parseArgs(['ensure', '--pr-number=1', '--git-branch=x'], ENV)).toThrow(
			/neon-project-id/,
		)
	})

	it('hibázik hiányzó NEON_API_KEY-re', () => {
		expect(() => parseArgs(['ensure', ...BASE, '--pr-number=1', '--git-branch=x'], {})).toThrow(
			/NEON_API_KEY/,
		)
	})

	it('hibázik, ha az ensure-höz nincs pr-number', () => {
		expect(() => parseArgs(['ensure', ...BASE, '--git-branch=x'], ENV)).toThrow(/pr-number/)
	})
})
