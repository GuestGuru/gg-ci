import type { Config } from '../config.js'
import { branchNameForPr } from '../naming.js'
import { type CommandDeps, ISOLATED_FLAG_ENV } from './types.js'

export interface DestroyParams {
	config: Config
	prNumber: number
	gitBranch: string
	dryRun: boolean
}

export interface DestroyResult {
	branchDeleted: boolean
	envsDeleted: number
}

export async function destroy(deps: CommandDeps, params: DestroyParams): Promise<DestroyResult> {
	const { config, prNumber, gitBranch, dryRun } = params
	const branchName = branchNameForPr(config.branchPrefix, prNumber)
	const ownedKeys = new Set([config.envVarName, ISOLATED_FLAG_ENV])
	if (config.unpooledEnvVarName) ownedKeys.add(config.unpooledEnvVarName)

	const branch = await deps.neon.findBranchByName(branchName)
	const envs = (await deps.vercel.listBranchEnvs(gitBranch)).filter((env) => ownedKeys.has(env.key))

	if (dryRun) {
		deps.log(`[dry-run] would delete branch ${branchName} (${branch ? branch.id : 'absent'})`)
		deps.log(`[dry-run] would delete ${envs.length} env var(s) on ${gitBranch}`)
		return { branchDeleted: false, envsDeleted: 0 }
	}

	if (branch) {
		await deps.neon.deleteBranch(branch.id)
		deps.log(`- Deleted Neon branch ${branchName} (${branch.id})`)
	} else {
		deps.log(`= No Neon branch named ${branchName} — nothing to delete`)
	}

	for (const env of envs) {
		await deps.vercel.deleteEnv(env.id)
		deps.log(`- Deleted Vercel env ${env.key} on ${gitBranch}`)
	}

	return { branchDeleted: Boolean(branch), envsDeleted: envs.length }
}
