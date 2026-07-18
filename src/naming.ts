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
}

/**
 * Returns the branches that belong to this app's preview prefix but have no
 * matching open PR. Anything outside the prefix is never returned — production,
 * long-lived dev branches and other apps' previews must stay untouched.
 */
export function selectOrphanBranches(
	prefix: string,
	branches: NamedBranch[],
	openPrNumbers: number[],
): NamedBranch[] {
	const open = new Set(openPrNumbers)
	return branches.filter((branch) => {
		const prNumber = prNumberFromBranchName(prefix, branch.name)
		return prNumber !== null && !open.has(prNumber)
	})
}
