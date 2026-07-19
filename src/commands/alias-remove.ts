import type { VercelCommandDeps } from './types.js'

export interface AliasRemoveParams {
	aliasHost: string
	dryRun: boolean
}

export interface AliasRemoveResult {
	removed: boolean
}

/**
 * Detaches a preview domain. Idempotent: an alias that does not exist (already
 * removed, or never created because the PR never got a preview deploy) is the
 * desired end state, not an error.
 */
export async function aliasRemove(
	deps: VercelCommandDeps,
	params: AliasRemoveParams,
): Promise<AliasRemoveResult> {
	const { aliasHost, dryRun } = params
	const existing = await deps.vercel.findAlias(aliasHost)

	if (dryRun) {
		deps.log(`[dry-run] would remove alias ${aliasHost} (${existing ? existing.uid : 'absent'})`)
		return { removed: false }
	}

	if (!existing) {
		deps.log(`= No alias named ${aliasHost} — nothing to remove`)
		return { removed: false }
	}

	await deps.vercel.deleteAlias(existing.uid)
	deps.log(`- Removed alias ${aliasHost} (${existing.uid})`)
	return { removed: true }
}
