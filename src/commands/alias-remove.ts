import type { VercelCommandDeps } from './types.js'

export interface AliasRemoveParams {
	aliasHost: string
	dryRun: boolean
}

export interface AliasRemoveResult {
	aliasRemoved: boolean
	domainRemoved: boolean
}

/**
 * Tears down a preview host: first the alias, then the project domain.
 *
 * Removing the alias alone is not enough, and the leftover state is worse than a
 * 404. A domain attached to a project without a git-branch binding falls back to
 * the **production** deployment on its own, so Vercel silently re-creates the
 * alias against production shortly after it is deleted: the closed PR's link
 * then answers 200 and serves the live site, and a reviewer clicking it believes
 * they are looking at the PR. Measured on a real PR close, 2026-07-19.
 *
 * Order matters — deleting the domain first would leave a window in which Vercel
 * can put the alias back.
 *
 * Idempotent throughout: a missing alias or a missing domain (already cleaned up,
 * or never created because the PR got no preview deploy) is the desired end
 * state, not an error.
 */
export async function aliasRemove(
	deps: VercelCommandDeps,
	params: AliasRemoveParams,
): Promise<AliasRemoveResult> {
	const { aliasHost, dryRun } = params
	const existingAlias = await deps.vercel.findAlias(aliasHost)
	const existingDomain = await deps.vercel.findProjectDomain(aliasHost)

	if (dryRun) {
		deps.log(`[dry-run] would remove alias ${aliasHost} (${existingAlias ? existingAlias.uid : 'absent'})`)
		deps.log(
			`[dry-run] would remove project domain ${aliasHost} (${existingDomain ? 'present' : 'absent'})`,
		)
		return { aliasRemoved: false, domainRemoved: false }
	}

	if (existingAlias) {
		await deps.vercel.deleteAlias(existingAlias.uid)
		deps.log(`- Removed alias ${aliasHost} (${existingAlias.uid})`)
	} else {
		deps.log(`= No alias named ${aliasHost} — nothing to remove`)
	}

	if (existingDomain) {
		await deps.vercel.deleteProjectDomain(aliasHost)
		deps.log(`- Removed project domain ${aliasHost}`)
	} else {
		deps.log(`= ${aliasHost} is not attached to the project — nothing to detach`)
	}

	return { aliasRemoved: Boolean(existingAlias), domainRemoved: Boolean(existingDomain) }
}
