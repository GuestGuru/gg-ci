import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensure } from '../../src/commands/ensure.js'
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

function makeDeps() {
	const neon = {
		findBranchByName: vi.fn(),
		createBranch: vi.fn(),
		setExpiry: vi.fn(),
		waitReady: vi.fn(),
		connectionUri: vi.fn().mockResolvedValue('postgres://preview'),
	}
	const vercel = {
		listBranchEnvs: vi.fn().mockResolvedValue([]),
		upsertEnv: vi.fn(),
		latestPreviewDeployment: vi.fn().mockResolvedValue({ id: 'dpl_1', name: 'my-project' }),
		redeploy: vi.fn(),
	}
	return {
		neon,
		vercel,
		deps: {
			neon: neon as never,
			vercel: vercel as never,
			log: vi.fn(),
			now: () => new Date('2026-07-18T00:00:00.000Z'),
		},
	}
}

const PARAMS = { config: CONFIG, prNumber: 42, gitBranch: 'feat/x', dryRun: false }

describe('ensure', () => {
	let ctx: ReturnType<typeof makeDeps>

	beforeEach(() => {
		ctx = makeDeps()
	})

	it('új PR-nél branchet forkol 7 napos TTL-lel', async () => {
		ctx.neon.findBranchByName.mockResolvedValue(null)
		ctx.neon.createBranch.mockResolvedValue({ id: 'br-new', name: 'preview/app/pr-42' })

		const result = await ensure(ctx.deps, PARAMS)

		expect(ctx.neon.createBranch).toHaveBeenCalledWith(
			'preview/app/pr-42',
			'2026-07-25T00:00:00.000Z',
		)
		expect(ctx.neon.waitReady).toHaveBeenCalledWith('br-new')
		expect(result.branchCreated).toBe(true)
		expect(result.branchId).toBe('br-new')
	})

	it('meglévő branchnél csak a TTL-t tolja, nem forkol újra', async () => {
		ctx.neon.findBranchByName.mockResolvedValue({ id: 'br-old', name: 'preview/app/pr-42' })

		const result = await ensure(ctx.deps, PARAMS)

		expect(ctx.neon.createBranch).not.toHaveBeenCalled()
		expect(ctx.neon.setExpiry).toHaveBeenCalledWith('br-old', '2026-07-25T00:00:00.000Z')
		expect(result.branchCreated).toBe(false)
	})

	it('beállítja mindkét env vart branch scope-pal', async () => {
		ctx.neon.findBranchByName.mockResolvedValue({ id: 'br-old', name: 'x' })

		await ensure(ctx.deps, PARAMS)

		expect(ctx.vercel.upsertEnv).toHaveBeenCalledWith('DB_URL', 'postgres://preview', 'feat/x', true)
		expect(ctx.vercel.upsertEnv).toHaveBeenCalledWith('PREVIEW_DB_ISOLATED', '1', 'feat/x', false)
	})

	it('redeployt kér, ha az env var most jött létre', async () => {
		ctx.neon.findBranchByName.mockResolvedValue({ id: 'br-old', name: 'x' })
		ctx.vercel.listBranchEnvs.mockResolvedValue([])

		const result = await ensure(ctx.deps, PARAMS)

		expect(ctx.vercel.redeploy).toHaveBeenCalledWith('dpl_1', 'my-project')
		expect(result.redeployed).toBe(true)
	})

	it('NEM kér redeployt, ha az env var már létezett', async () => {
		ctx.neon.findBranchByName.mockResolvedValue({ id: 'br-old', name: 'x' })
		ctx.vercel.listBranchEnvs.mockResolvedValue([{ id: 'e1', key: 'DB_URL', gitBranch: 'feat/x' }])

		const result = await ensure(ctx.deps, PARAMS)

		expect(ctx.vercel.redeploy).not.toHaveBeenCalled()
		expect(result.redeployed).toBe(false)
	})

	it('a redeploy hibája nem buktatja el az ensure-t', async () => {
		ctx.neon.findBranchByName.mockResolvedValue({ id: 'br-old', name: 'x' })
		ctx.vercel.redeploy.mockRejectedValue(new Error('vercel down'))

		const result = await ensure(ctx.deps, PARAMS)

		expect(result.redeployed).toBe(false)
		expect(ctx.deps.log).toHaveBeenCalledWith(expect.stringContaining('Redeploy failed'))
	})

	it('nincs deploy a branchen → nincs redeploy, nincs hiba', async () => {
		ctx.neon.findBranchByName.mockResolvedValue({ id: 'br-old', name: 'x' })
		ctx.vercel.latestPreviewDeployment.mockResolvedValue(null)

		const result = await ensure(ctx.deps, PARAMS)

		expect(ctx.vercel.redeploy).not.toHaveBeenCalled()
		expect(result.redeployed).toBe(false)
	})

	it('dry-run módban semmit nem módosít', async () => {
		ctx.neon.findBranchByName.mockResolvedValue(null)

		const result = await ensure(ctx.deps, { ...PARAMS, dryRun: true })

		expect(ctx.neon.createBranch).not.toHaveBeenCalled()
		expect(ctx.vercel.upsertEnv).not.toHaveBeenCalled()
		expect(ctx.vercel.redeploy).not.toHaveBeenCalled()
		expect(result.branchCreated).toBe(false)
	})

	it('sosem logolja a connection stringet', async () => {
		ctx.neon.findBranchByName.mockResolvedValue({ id: 'br-old', name: 'x' })

		await ensure(ctx.deps, PARAMS)

		for (const call of (ctx.deps.log as ReturnType<typeof vi.fn>).mock.calls) {
			expect(String(call[0])).not.toContain('postgres://preview')
		}
	})
})
