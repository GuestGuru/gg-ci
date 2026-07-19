import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aliasSet } from '../../src/commands/alias-set.js'

function makeDeps() {
	const vercel = { assignAlias: vi.fn().mockResolvedValue({ alreadyAssigned: false }) }
	return {
		vercel,
		deps: { vercel: vercel as never, log: vi.fn() },
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

	it('új aliast rendel a deploymenthez, és visszaadja a https URL-t', async () => {
		const result = await aliasSet(ctx.deps, PARAMS)

		expect(ctx.vercel.assignAlias).toHaveBeenCalledWith('dpl_1', 'myapp-pr-12.preview.example.com')
		expect(result).toEqual({
			url: 'https://myapp-pr-12.preview.example.com',
			alreadyAssigned: false,
		})
	})

	it('idempotens: a már erre a deploymentre mutató alias nem hiba', async () => {
		ctx.vercel.assignAlias.mockResolvedValue({ alreadyAssigned: true })

		const result = await aliasSet(ctx.deps, PARAMS)

		expect(result).toEqual({
			url: 'https://myapp-pr-12.preview.example.com',
			alreadyAssigned: true,
		})
	})

	it('dry-run módban nem hív írás-API-t', async () => {
		const result = await aliasSet(ctx.deps, { ...PARAMS, dryRun: true })

		expect(ctx.vercel.assignAlias).not.toHaveBeenCalled()
		expect(result.url).toBe('https://myapp-pr-12.preview.example.com')
	})
})
