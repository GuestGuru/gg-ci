import { beforeEach, describe, expect, it, vi } from 'vitest'
import { destroy } from '../../src/commands/destroy.js'
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
	const neon = { findBranchByName: vi.fn(), deleteBranch: vi.fn() }
	const vercel = { listBranchEnvs: vi.fn().mockResolvedValue([]), deleteEnv: vi.fn() }
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

describe('destroy', () => {
	let ctx: ReturnType<typeof makeDeps>

	beforeEach(() => {
		ctx = makeDeps()
	})

	it('törli a branchet és mindkét env vart', async () => {
		ctx.neon.findBranchByName.mockResolvedValue({ id: 'br-1', name: 'preview/app/pr-42' })
		ctx.vercel.listBranchEnvs.mockResolvedValue([
			{ id: 'e1', key: 'DB_URL', gitBranch: 'feat/x' },
			{ id: 'e2', key: 'PREVIEW_DB_ISOLATED', gitBranch: 'feat/x' },
		])

		const result = await destroy(ctx.deps, PARAMS)

		expect(ctx.neon.deleteBranch).toHaveBeenCalledWith('br-1')
		expect(ctx.vercel.deleteEnv).toHaveBeenCalledWith('e1')
		expect(ctx.vercel.deleteEnv).toHaveBeenCalledWith('e2')
		expect(result).toEqual({ branchDeleted: true, envsDeleted: 2 })
	})

	it('nem törli más kulcsú env varokat', async () => {
		ctx.neon.findBranchByName.mockResolvedValue(null)
		ctx.vercel.listBranchEnvs.mockResolvedValue([
			{ id: 'e1', key: 'DB_URL', gitBranch: 'feat/x' },
			{ id: 'e9', key: 'SOME_OTHER_VAR', gitBranch: 'feat/x' },
		])

		const result = await destroy(ctx.deps, PARAMS)

		expect(ctx.vercel.deleteEnv).toHaveBeenCalledWith('e1')
		expect(ctx.vercel.deleteEnv).not.toHaveBeenCalledWith('e9')
		expect(result.envsDeleted).toBe(1)
	})

	it('idempotens: hiányzó branch és env var nem hiba', async () => {
		ctx.neon.findBranchByName.mockResolvedValue(null)
		ctx.vercel.listBranchEnvs.mockResolvedValue([])

		const result = await destroy(ctx.deps, PARAMS)

		expect(ctx.neon.deleteBranch).not.toHaveBeenCalled()
		expect(result).toEqual({ branchDeleted: false, envsDeleted: 0 })
	})

	it('törli az unpooled env vart is, ha az konfigurálva van', async () => {
		ctx.neon.findBranchByName.mockResolvedValue(null)
		ctx.vercel.listBranchEnvs.mockResolvedValue([
			{ id: 'e1', key: 'DB_URL', gitBranch: 'feat/x' },
			{ id: 'e2', key: 'DB_URL_UNPOOLED', gitBranch: 'feat/x' },
		])

		const result = await destroy(ctx.deps, {
			...PARAMS,
			config: { ...CONFIG, unpooledEnvVarName: 'DB_URL_UNPOOLED' },
		})

		expect(ctx.vercel.deleteEnv).toHaveBeenCalledWith('e1')
		expect(ctx.vercel.deleteEnv).toHaveBeenCalledWith('e2')
		expect(result.envsDeleted).toBe(2)
	})

	it('unpooled config nélkül nem nyúl az unpooled kulcshoz', async () => {
		ctx.neon.findBranchByName.mockResolvedValue(null)
		ctx.vercel.listBranchEnvs.mockResolvedValue([
			{ id: 'e1', key: 'DB_URL', gitBranch: 'feat/x' },
			{ id: 'e2', key: 'DB_URL_UNPOOLED', gitBranch: 'feat/x' },
		])

		const result = await destroy(ctx.deps, PARAMS)

		expect(ctx.vercel.deleteEnv).not.toHaveBeenCalledWith('e2')
		expect(result.envsDeleted).toBe(1)
	})

	it('dry-run módban semmit nem töröl', async () => {
		ctx.neon.findBranchByName.mockResolvedValue({ id: 'br-1', name: 'x' })
		ctx.vercel.listBranchEnvs.mockResolvedValue([{ id: 'e1', key: 'DB_URL', gitBranch: 'feat/x' }])

		const result = await destroy(ctx.deps, { ...PARAMS, dryRun: true })

		expect(ctx.neon.deleteBranch).not.toHaveBeenCalled()
		expect(ctx.vercel.deleteEnv).not.toHaveBeenCalled()
		expect(result).toEqual({ branchDeleted: false, envsDeleted: 0 })
	})
})
