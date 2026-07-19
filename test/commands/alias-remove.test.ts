import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aliasRemove } from '../../src/commands/alias-remove.js'

const HOST = 'myapp-pr-12.preview.example.com'

function makeDeps() {
	// Records the order of the write calls — deleting the domain before the alias
	// would let Vercel re-create the alias against production in between.
	const calls: string[] = []
	const vercel = {
		findAlias: vi.fn().mockResolvedValue(null),
		findProjectDomain: vi.fn().mockResolvedValue(null),
		deleteAlias: vi.fn(async () => {
			calls.push('deleteAlias')
		}),
		deleteProjectDomain: vi.fn(async () => {
			calls.push('deleteProjectDomain')
		}),
	}
	return {
		vercel,
		calls,
		deps: { vercel: vercel as never, log: vi.fn(), sleep: vi.fn(async () => {}) },
	}
}

const PARAMS = { aliasHost: HOST, dryRun: false }

describe('aliasRemove', () => {
	let ctx: ReturnType<typeof makeDeps>

	beforeEach(() => {
		ctx = makeDeps()
	})

	it('az aliast és a projekt-domaint is törli, ebben a sorrendben', async () => {
		ctx.vercel.findAlias.mockResolvedValue({ uid: 'alias_1', alias: HOST, deploymentId: 'dpl_1' })
		ctx.vercel.findProjectDomain.mockResolvedValue({ name: HOST, verified: true })

		const result = await aliasRemove(ctx.deps, PARAMS)

		expect(ctx.vercel.deleteAlias).toHaveBeenCalledWith('alias_1')
		expect(ctx.vercel.deleteProjectDomain).toHaveBeenCalledWith(HOST)
		expect(ctx.calls).toEqual(['deleteAlias', 'deleteProjectDomain'])
		expect(result).toEqual({ aliasRemoved: true, domainRemoved: true })
	})

	it('csak a domain létezik — nem hiba, a domaint elviszi', async () => {
		ctx.vercel.findAlias.mockResolvedValue(null)
		ctx.vercel.findProjectDomain.mockResolvedValue({ name: HOST, verified: true })

		const result = await aliasRemove(ctx.deps, PARAMS)

		expect(ctx.vercel.deleteAlias).not.toHaveBeenCalled()
		expect(ctx.vercel.deleteProjectDomain).toHaveBeenCalledWith(HOST)
		expect(result).toEqual({ aliasRemoved: false, domainRemoved: true })
	})

	it('csak az alias létezik — a hiányzó domain nem hiba', async () => {
		ctx.vercel.findAlias.mockResolvedValue({ uid: 'alias_1', alias: HOST })
		ctx.vercel.findProjectDomain.mockResolvedValue(null)

		const result = await aliasRemove(ctx.deps, PARAMS)

		expect(ctx.vercel.deleteProjectDomain).not.toHaveBeenCalled()
		expect(result).toEqual({ aliasRemoved: true, domainRemoved: false })
	})

	it('idempotens: egyik sem létezik — sikerrel tér vissza', async () => {
		const result = await aliasRemove(ctx.deps, PARAMS)

		expect(ctx.vercel.deleteAlias).not.toHaveBeenCalled()
		expect(ctx.vercel.deleteProjectDomain).not.toHaveBeenCalled()
		expect(result).toEqual({ aliasRemoved: false, domainRemoved: false })
	})

	it('dry-run módban egyik írás-API-t sem hívja', async () => {
		ctx.vercel.findAlias.mockResolvedValue({ uid: 'alias_1', alias: HOST })
		ctx.vercel.findProjectDomain.mockResolvedValue({ name: HOST, verified: true })

		const result = await aliasRemove(ctx.deps, { ...PARAMS, dryRun: true })

		expect(ctx.vercel.deleteAlias).not.toHaveBeenCalled()
		expect(ctx.vercel.deleteProjectDomain).not.toHaveBeenCalled()
		expect(result).toEqual({ aliasRemoved: false, domainRemoved: false })
	})
})
