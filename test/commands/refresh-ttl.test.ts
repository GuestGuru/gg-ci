import { beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshTtl } from '../../src/commands/refresh-ttl.js'
import type { Config } from '../../src/config.js'

const CONFIG: Config = {
	neonApiKey: 'k',
	vercelToken: 't',
	neonProjectId: 'proj_1',
	parentBranchId: 'br-parent',
	roleName: 'role',
	databaseName: 'db',
	vercelProjectId: 'prj_1',
	vercelTeamId: 'team_1',
	branchPrefix: 'preview/app',
	sharedBranchName: 'preview-shared',
	envVarName: 'DB_URL',
	ttlDays: 7,
}

const BRANCHES = [
	{ id: 'br-1', name: 'preview/app/pr-1', creation_source: 'console' },
	{ id: 'br-2', name: 'preview/app/pr-2', creation_source: 'console' },
	{ id: 'br-shared', name: 'preview-shared', creation_source: 'console' },
	{ id: 'br-prod', name: 'production', creation_source: 'console' },
	// A natív Neon–Vercel integráció branche: névre illeszkedne, de NEM a miénk.
	{ id: 'br-native', name: 'preview/app/pr-9', creation_source: 'vercel' },
]

function makeDeps() {
	const neon = {
		listBranches: vi.fn().mockResolvedValue(BRANCHES),
		setExpiry: vi.fn(),
		deleteBranch: vi.fn(),
	}
	return {
		neon,
		deps: {
			neon: neon as never,
			vercel: {} as never,
			log: vi.fn(),
			now: () => new Date('2026-07-18T00:00:00.000Z'),
		},
	}
}

describe('refreshTtl', () => {
	let ctx: ReturnType<typeof makeDeps>

	beforeEach(() => {
		ctx = makeDeps()
	})

	it('megtolja a nyitott PR-ek TTL-jét és törli az árvákat', async () => {
		const result = await refreshTtl(ctx.deps, { config: CONFIG, openPrNumbers: [1], dryRun: false })

		expect(ctx.neon.setExpiry).toHaveBeenCalledWith('br-1', '2026-07-25T00:00:00.000Z')
		expect(ctx.neon.setExpiry).not.toHaveBeenCalledWith('br-2', expect.anything())
		expect(ctx.neon.deleteBranch).toHaveBeenCalledWith('br-2')
		expect(ctx.neon.deleteBranch).toHaveBeenCalledTimes(1)
		expect(result).toEqual({ refreshed: 1, deleted: 1, skippedCleanup: false })
	})

	it('SOHA nem nyúl a shared és a production branchhez', async () => {
		await refreshTtl(ctx.deps, { config: CONFIG, openPrNumbers: [], dryRun: false })

		expect(ctx.neon.deleteBranch).not.toHaveBeenCalledWith('br-shared')
		expect(ctx.neon.deleteBranch).not.toHaveBeenCalledWith('br-prod')
	})

	it('undefined PR-lista esetén KIHAGYJA a takarítást', async () => {
		const result = await refreshTtl(ctx.deps, {
			config: CONFIG,
			openPrNumbers: undefined,
			dryRun: false,
		})

		expect(ctx.neon.deleteBranch).not.toHaveBeenCalled()
		expect(result.skippedCleanup).toBe(true)
		expect(ctx.deps.log).toHaveBeenCalledWith(expect.stringContaining('skipping cleanup'))
	})

	it('üres, de megadott PR-lista esetén takarít', async () => {
		const result = await refreshTtl(ctx.deps, { config: CONFIG, openPrNumbers: [], dryRun: false })

		expect(ctx.neon.deleteBranch).toHaveBeenCalledTimes(2)
		expect(result).toEqual({ refreshed: 0, deleted: 2, skippedCleanup: false })
	})

	it('a Vercel-integráció branchét soha nem törli, akkor sem ha illeszkedik a névre', async () => {
		await refreshTtl(ctx.deps, { config: CONFIG, openPrNumbers: [], dryRun: false })

		expect(ctx.neon.deleteBranch).not.toHaveBeenCalledWith('br-native')
		expect(ctx.neon.deleteBranch).toHaveBeenCalledWith('br-1')
		expect(ctx.neon.deleteBranch).toHaveBeenCalledWith('br-2')
	})

	it('dry-run módban semmit nem módosít', async () => {
		const result = await refreshTtl(ctx.deps, { config: CONFIG, openPrNumbers: [1], dryRun: true })

		expect(ctx.neon.setExpiry).not.toHaveBeenCalled()
		expect(ctx.neon.deleteBranch).not.toHaveBeenCalled()
		expect(result).toEqual({ refreshed: 0, deleted: 0, skippedCleanup: false })
	})
})
