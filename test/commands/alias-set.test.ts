import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aliasSet } from '../../src/commands/alias-set.js'
import { VercelApiError } from '../../src/vercel.js'

const HOST = 'myapp-pr-12.preview.example.com'

function certMissing(): VercelApiError {
	return new VercelApiError('Vercel API POST /v2/deployments/dpl_1/aliases → 400', 400, 'cert_missing')
}

function makeDeps() {
	const calls: string[] = []
	const vercel = {
		projectId: 'prj_1',
		getDeployment: vi.fn().mockResolvedValue({ id: 'dpl_1', projectId: 'prj_1', target: null }),
		getAlias: vi.fn().mockResolvedValue({ uid: 'alias_1', alias: HOST, projectId: 'prj_1', protectionBypass: null }),
		findProjectDomain: vi.fn().mockResolvedValue(null),
		deleteProjectDomain: vi.fn(async () => {
			calls.push('deleteProjectDomain')
		}),
		assignAlias: vi.fn(async () => {
			calls.push('assignAlias')
			return { alreadyAssigned: false }
		}),
		getProjectProtection: vi.fn().mockResolvedValue({ sso: 'all_except_custom_domains', password: null }),
		createAliasProtectionOverride: vi.fn().mockResolvedValue(true),
	}
	// Never actually waits — records the requested delays instead.
	const slept: number[] = []
	return {
		vercel,
		calls,
		slept,
		deps: {
			vercel: vercel as never,
			log: vi.fn(),
			sleep: vi.fn(async (ms: number) => {
				slept.push(ms)
			}),
		},
	}
}

const PARAMS = {
	deploymentId: 'dpl_1',
	aliasHost: HOST,
	dryRun: false,
}

describe('aliasSet', () => {
	let ctx: ReturnType<typeof makeDeps>

	beforeEach(() => {
		ctx = makeDeps()
	})

	it('projekt-domain NÉLKÜL aliasol, kivételt tesz rá, és visszaadja a https URL-t', async () => {
		const result = await aliasSet(ctx.deps, PARAMS)

		expect(ctx.vercel.assignAlias).toHaveBeenCalledWith('dpl_1', HOST)
		expect(ctx.vercel.deleteProjectDomain).not.toHaveBeenCalled()
		expect(ctx.vercel.createAliasProtectionOverride).toHaveBeenCalledWith('alias_1')
		expect(result).toEqual({
			url: 'https://myapp-pr-12.preview.example.com',
			alreadyAssigned: false,
			legacyDomainDetached: false,
			protectionOverride: 'created',
		})
	})

	it('production deploymentre nem aliasol (IT-1046)', async () => {
		ctx.vercel.getDeployment.mockResolvedValue({ id: 'dpl_1', projectId: 'prj_1', target: 'production' })

		await expect(aliasSet(ctx.deps, PARAMS)).rejects.toThrow(/production deployment/)

		expect(ctx.calls).toEqual([])
	})

	it('más projekt deploymentjére nem aliasol (IT-1046)', async () => {
		ctx.vercel.getDeployment.mockResolvedValue({ id: 'dpl_1', projectId: 'prj_other', target: null })

		await expect(aliasSet(ctx.deps, PARAMS)).rejects.toThrow(/belongs to project prj_other/)

		expect(ctx.calls).toEqual([])
	})

	it('más projekt aliasát nem veszi át', async () => {
		ctx.vercel.getAlias.mockResolvedValue({ uid: 'alias_x', alias: HOST, projectId: 'prj_other' })

		await expect(aliasSet(ctx.deps, PARAMS)).rejects.toThrow(/alias of project prj_other/)

		expect(ctx.calls).toEqual([])
	})

	it('nem PR-hosztot (…-pr-<szám>.…) nem aliasol — dry-runban sem', async () => {
		for (const aliasHost of ['myapp.example.com', 'myapp-pr-.preview.example.com', 'pr-12.preview.example.com']) {
			await expect(aliasSet(ctx.deps, { ...PARAMS, aliasHost })).rejects.toThrow(/not a PR host/)
			await expect(aliasSet(ctx.deps, { ...PARAMS, aliasHost, dryRun: true })).rejects.toThrow(/not a PR host/)
		}

		expect(ctx.vercel.getDeployment).not.toHaveBeenCalled()
	})

	it('a régi (IT-1046 előtti) projekt-domaint ELŐBB leválasztja, aztán aliasol', async () => {
		ctx.vercel.findProjectDomain.mockResolvedValue({ name: HOST, verified: true, gitBranch: null })

		const result = await aliasSet(ctx.deps, PARAMS)

		expect(ctx.calls).toEqual(['deleteProjectDomain', 'assignAlias'])
		expect(result.legacyDomainDetached).toBe(true)
	})

	it('a meglévő védelmi kivételt nem hozza létre újra', async () => {
		ctx.vercel.getAlias.mockResolvedValue({
			uid: 'alias_1',
			alias: HOST,
			projectId: 'prj_1',
			protectionBypass: { '*': { scope: 'alias-protection-override' } },
		})

		const result = await aliasSet(ctx.deps, PARAMS)

		expect(ctx.vercel.createAliasProtectionOverride).not.toHaveBeenCalled()
		expect(result.protectionOverride).toBe('present')
	})

	it('a már létező kivétel (exception_already_exists) nem hiba', async () => {
		ctx.vercel.createAliasProtectionOverride.mockResolvedValue(false)

		expect((await aliasSet(ctx.deps, PARAMS)).protectionOverride).toBe('present')
	})

	it.each([
		[{ sso: null, password: null }],
		[{ sso: 'all', password: null }],
		[{ sso: 'all_except_custom_domains', password: 'all' }],
	])('nem tesz kivételt, ha a projekt védtelen vagy mindent véd (%j)', async (protection) => {
		ctx.vercel.getProjectProtection.mockResolvedValue(protection)

		const result = await aliasSet(ctx.deps, PARAMS)

		expect(ctx.vercel.createAliasProtectionOverride).not.toHaveBeenCalled()
		expect(result.protectionOverride).toBe('not-needed')
	})

	it('idempotens: a már erre a deploymentre mutató alias nem hiba', async () => {
		ctx.vercel.assignAlias.mockResolvedValue({ alreadyAssigned: true } as never)

		const result = await aliasSet(ctx.deps, PARAMS)

		expect(result.alreadyAssigned).toBe(true)
	})

	it('cert_missing után újrapróbálkozik, és a sikeres hívás eredményét adja vissza', async () => {
		ctx.vercel.assignAlias
			.mockRejectedValueOnce(certMissing())
			.mockRejectedValueOnce(certMissing())
			.mockResolvedValueOnce({ alreadyAssigned: false })

		const result = await aliasSet(ctx.deps, PARAMS)

		expect(ctx.vercel.assignAlias).toHaveBeenCalledTimes(3)
		expect(ctx.slept).toEqual([5000, 5000])
		expect(result.url).toBe('https://myapp-pr-12.preview.example.com')
	})

	it('a retry-korlát kimerülése után dob', async () => {
		ctx.vercel.assignAlias.mockRejectedValue(certMissing())

		await expect(aliasSet(ctx.deps, PARAMS)).rejects.toThrow(/400/)

		expect(ctx.vercel.assignAlias).toHaveBeenCalledTimes(15)
		// Eggyel kevesebb várakozás, mint ahány próbálkozás — az utolsó után már nem vár.
		expect(ctx.slept).toHaveLength(14)
		// A teljes várakozás ésszerű korláton belül marad.
		expect(ctx.slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(90_000)
	})

	it('nem-cert_missing hibán azonnal dob, retry nélkül', async () => {
		ctx.vercel.assignAlias.mockRejectedValue(new VercelApiError('deployment not found', 404, 'not_found'))

		await expect(aliasSet(ctx.deps, PARAMS)).rejects.toThrow(/not found/)

		expect(ctx.vercel.assignAlias).toHaveBeenCalledTimes(1)
		expect(ctx.deps.sleep).not.toHaveBeenCalled()
	})

	it('dry-run módban egyik írás-API-t sem hívja', async () => {
		const result = await aliasSet(ctx.deps, { ...PARAMS, dryRun: true })

		expect(ctx.vercel.getDeployment).not.toHaveBeenCalled()
		expect(ctx.vercel.assignAlias).not.toHaveBeenCalled()
		expect(ctx.vercel.createAliasProtectionOverride).not.toHaveBeenCalled()
		expect(result.url).toBe('https://myapp-pr-12.preview.example.com')
	})
})
