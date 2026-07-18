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
