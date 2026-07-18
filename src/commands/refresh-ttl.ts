import type { Config } from '../config.js'
import { branchNameForPr, prNumberFromBranchName, selectOrphanBranches } from '../naming.js'
import { type CommandDeps, expiryFrom } from './types.js'

export interface RefreshParams {
	config: Config
	/** `undefined` means the caller could not determine the open PRs — cleanup is unsafe. */
	openPrNumbers: number[] | undefined
	dryRun: boolean
}

export interface RefreshResult {
	refreshed: number
	deleted: number
	skippedCleanup: boolean
}

export async function refreshTtl(deps: CommandDeps, params: RefreshParams): Promise<RefreshResult> {
	const { config, openPrNumbers, dryRun } = params
	const branches = await deps.neon.listBranches()
	const expiresAt = expiryFrom(deps.now(), config.ttlDays)

	if (openPrNumbers === undefined) {
		deps.log('! No open PR list supplied — skipping cleanup to avoid deleting live preview DBs')
		return { refreshed: 0, deleted: 0, skippedCleanup: true }
	}

	const openBranchNames = new Set(openPrNumbers.map((pr) => branchNameForPr(config.branchPrefix, pr)))
	const toRefresh = branches.filter((branch) => openBranchNames.has(branch.name))
	const orphans = selectOrphanBranches(config.branchPrefix, branches, openPrNumbers)

	if (dryRun) {
		deps.log(`[dry-run] would refresh TTL on: ${toRefresh.map((b) => b.name).join(', ') || '(none)'}`)
		deps.log(`[dry-run] would delete: ${orphans.map((b) => b.name).join(', ') || '(none)'}`)
		return { refreshed: 0, deleted: 0, skippedCleanup: false }
	}

	for (const branch of toRefresh) {
		await deps.neon.setExpiry(branch.id, expiresAt)
		deps.log(`= TTL extended on ${branch.name} → ${expiresAt}`)
	}

	for (const branch of orphans) {
		await deps.neon.deleteBranch(branch.id)
		deps.log(`- Deleted orphan branch ${branch.name} (PR #${prNumberFromBranchName(config.branchPrefix, branch.name)} is closed)`)
	}

	return { refreshed: toRefresh.length, deleted: orphans.length, skippedCleanup: false }
}
