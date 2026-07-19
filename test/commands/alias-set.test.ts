import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aliasSet } from '../../src/commands/alias-set.js'
import { VercelApiError } from '../../src/vercel.js'

function certMissing(): VercelApiError {
	return new VercelApiError('Vercel API POST /v2/deployments/dpl_1/aliases → 400', 400, 'cert_missing')
}

function makeDeps() {
	const vercel = {
		addProjectDomain: vi.fn().mockResolvedValue({ alreadyPresent: false, verified: true }),
		assignAlias: vi.fn().mockResolvedValue({ alreadyAssigned: false }),
	}
	// Never actually waits — records the requested delays instead.
	const slept: number[] = []
	return {
		vercel,
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
	aliasHost: 'myapp-pr-12.preview.example.com',
	dryRun: false,
}

describe('aliasSet', () => {
	let ctx: ReturnType<typeof makeDeps>

	beforeEach(() => {
		ctx = makeDeps()
	})

	it('hozzáadja a domaint a projekthez, aliast rendel, és visszaadja a https URL-t', async () => {
		const result = await aliasSet(ctx.deps, PARAMS)

		expect(ctx.vercel.addProjectDomain).toHaveBeenCalledWith('myapp-pr-12.preview.example.com')
		expect(ctx.vercel.assignAlias).toHaveBeenCalledWith('dpl_1', 'myapp-pr-12.preview.example.com')
		expect(result).toEqual({
			url: 'https://myapp-pr-12.preview.example.com',
			alreadyAssigned: false,
			domainAdded: true,
		})
	})

	it('idempotens: a projekthez már hozzáadott domain nem hiba', async () => {
		ctx.vercel.addProjectDomain.mockResolvedValue({ alreadyPresent: true, verified: true })

		const result = await aliasSet(ctx.deps, PARAMS)

		expect(ctx.vercel.assignAlias).toHaveBeenCalled()
		expect(result.domainAdded).toBe(false)
	})

	it('idempotens: a már erre a deploymentre mutató alias nem hiba', async () => {
		ctx.vercel.assignAlias.mockResolvedValue({ alreadyAssigned: true })

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

		expect(ctx.vercel.addProjectDomain).not.toHaveBeenCalled()
		expect(ctx.vercel.assignAlias).not.toHaveBeenCalled()
		expect(result.url).toBe('https://myapp-pr-12.preview.example.com')
	})
})
