/** Escapes regex metacharacters so a prefix is matched literally. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function branchNameForPr(prefix: string, prNumber: number): string {
	return `${prefix}/pr-${prNumber}`
}

export function prNumberFromBranchName(prefix: string, name: string): number | null {
	const match = name.match(new RegExp(`^${escapeRegExp(prefix)}/pr-(\\d+)$`))
	if (!match?.[1]) return null
	return Number(match[1])
}

export interface NamedBranch {
	id: string
	name: string
	/** Neon's `creation_source`: 'vercel' for branches the native integration owns. */
	creationSource?: string
}

/** Branches created by the native Neon–Vercel integration are never ours to delete. */
const FOREIGN_CREATION_SOURCES = new Set(['vercel'])

/**
 * Returns the branches that belong to this app's preview prefix but have no
 * matching open PR. Anything outside the prefix is never returned — production,
 * long-lived dev branches and other apps' previews must stay untouched.
 *
 * Prefix matching alone is not sufficient protection. Where an app uses the native
 * Neon–Vercel integration, that integration names its branches after the GIT BRANCH
 * (`preview/<git-branch>`), so a sibling app's branch called `<app>/pr-7` would
 * produce `preview/<app>/pr-7` — a name indistinguishable from ours. Excluding
 * `creation_source === 'vercel'` makes that a technical guarantee rather than a
 * naming convention someone can unknowingly violate.
 */
export function selectOrphanBranches(
	prefix: string,
	branches: NamedBranch[],
	openPrNumbers: number[],
): NamedBranch[] {
	const open = new Set(openPrNumbers)
	return branches.filter((branch) => {
		if (branch.creationSource && FOREIGN_CREATION_SOURCES.has(branch.creationSource)) return false
		const prNumber = prNumberFromBranchName(prefix, branch.name)
		return prNumber !== null && !open.has(prNumber)
	})
}
