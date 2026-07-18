import type { Config } from '../config.js'
import type { CommandDeps } from './types.js'

/**
 * Resets the long-lived shared preview branch back to production, so its schema
 * and data never drift. Preview deploys without their own DB run against it.
 */
export async function resetShared(
	deps: CommandDeps,
	params: { config: Config; dryRun: boolean },
): Promise<void> {
	const { config, dryRun } = params
	const branch = await deps.neon.findBranchByName(config.sharedBranchName)
	if (!branch) {
		throw new Error(
			`Shared preview branch "${config.sharedBranchName}" not found — create it first (see README setup)`,
		)
	}

	if (dryRun) {
		deps.log(`[dry-run] would reset ${branch.name} (${branch.id}) from ${config.parentBranchId}`)
		return
	}

	await deps.neon.resetFromParent(branch.id)
	deps.log(`= Reset ${branch.name} from ${config.parentBranchId}`)
}
