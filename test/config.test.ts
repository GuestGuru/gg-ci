import { describe, expect, it } from 'vitest'
import { parseAliasArgs, parseArgs } from '../src/config.js'

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

	it('az --unpooled-env-var-name opcionális, alapból undefined', () => {
		const result = parseArgs(['ensure', ...BASE, '--pr-number=1', '--git-branch=x'], ENV)
		expect(result.config.unpooledEnvVarName).toBeUndefined()
	})

	it('feldolgozza az --unpooled-env-var-name-et, ha meg van adva', () => {
		const result = parseArgs(
			['ensure', ...BASE, '--pr-number=1', '--git-branch=x', '--unpooled-env-var-name=DB_URL_UNPOOLED'],
			ENV,
		)
		expect(result.config.unpooledEnvVarName).toBe('DB_URL_UNPOOLED')
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

const ALIAS_BASE = ['--vercel-project-id=prj_1', '--vercel-team-id=team_1']

describe('parseAliasArgs', () => {
	it('feldolgozza az alias-set parancsot', () => {
		const result = parseAliasArgs(
			['alias-set', ...ALIAS_BASE, '--deployment-id=dpl_1', '--alias-host=pr-12.preview.example.com'],
			ENV,
		)
		expect(result.command).toBe('alias-set')
		expect(result.deploymentId).toBe('dpl_1')
		expect(result.aliasHost).toBe('pr-12.preview.example.com')
		expect(result.dryRun).toBe(false)
		expect(result.config).toEqual({
			vercelToken: 'vercel-token',
			vercelProjectId: 'prj_1',
			vercelTeamId: 'team_1',
		})
	})

	it('az alias-remove-hoz nem kell deployment-id', () => {
		const result = parseAliasArgs(
			['alias-remove', ...ALIAS_BASE, '--alias-host=pr-12.preview.example.com', '--dry-run'],
			ENV,
		)
		expect(result.deploymentId).toBeUndefined()
		expect(result.dryRun).toBe(true)
	})

	it('nem kér Neon inputot és NEON_API_KEY-t', () => {
		const result = parseAliasArgs(
			['alias-remove', ...ALIAS_BASE, '--alias-host=pr-12.preview.example.com'],
			{ VERCEL_TOKEN: 'vercel-token' } as NodeJS.ProcessEnv,
		)
		expect(result.aliasHost).toBe('pr-12.preview.example.com')
	})

	it('hibázik, ha az alias-sethez nincs deployment-id', () => {
		expect(() =>
			parseAliasArgs(['alias-set', ...ALIAS_BASE, '--alias-host=pr-12.preview.example.com'], ENV),
		).toThrow(/deployment-id/)
	})

	it('hibázik, ha az alias-host URL és nem hosztnév', () => {
		expect(() =>
			parseAliasArgs(
				['alias-remove', ...ALIAS_BASE, '--alias-host=https://pr-12.preview.example.com'],
				ENV,
			),
		).toThrow(/Invalid --alias-host/)
	})

	it('hibázik hiányzó VERCEL_TOKEN-re', () => {
		expect(() =>
			parseAliasArgs(['alias-remove', ...ALIAS_BASE, '--alias-host=pr-12.preview.example.com'], {}),
		).toThrow(/VERCEL_TOKEN/)
	})
})
