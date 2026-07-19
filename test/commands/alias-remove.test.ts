import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aliasRemove } from '../../src/commands/alias-remove.js'

function makeDeps() {
	const vercel = { findAlias: vi.fn().mockResolvedValue(null), deleteAlias: vi.fn() }
	return {
		vercel,
		deps: { vercel: vercel as never, log: vi.fn(), sleep: vi.fn(async () => {}) },
	}
}

const PARAMS = { aliasHost: 'myapp-pr-12.preview.example.com', dryRun: false }

describe('aliasRemove', () => {
	let ctx: ReturnType<typeof makeDeps>

	beforeEach(() => {
		ctx = makeDeps()
	})

	it('törli a megtalált aliast az id-je alapján', async () => {
		ctx.vercel.findAlias.mockResolvedValue({
			uid: 'alias_1',
			alias: 'myapp-pr-12.preview.example.com',
			deploymentId: 'dpl_1',
		})

		const result = await aliasRemove(ctx.deps, PARAMS)

		expect(ctx.vercel.deleteAlias).toHaveBeenCalledWith('alias_1')
		expect(result).toEqual({ removed: true })
	})

	it('idempotens: nem létező aliasra sikerrel tér vissza', async () => {
		ctx.vercel.findAlias.mockResolvedValue(null)

		const result = await aliasRemove(ctx.deps, PARAMS)

		expect(ctx.vercel.deleteAlias).not.toHaveBeenCalled()
		expect(result).toEqual({ removed: false })
	})

	it('dry-run módban nem hív írás-API-t', async () => {
		ctx.vercel.findAlias.mockResolvedValue({ uid: 'alias_1', alias: PARAMS.aliasHost })

		const result = await aliasRemove(ctx.deps, { ...PARAMS, dryRun: true })

		expect(ctx.vercel.deleteAlias).not.toHaveBeenCalled()
		expect(result).toEqual({ removed: false })
	})
})
