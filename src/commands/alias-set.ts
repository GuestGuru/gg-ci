import type { VercelCommandDeps } from './types.js'

export interface AliasSetParams {
	deploymentId: string
	aliasHost: string
	dryRun: boolean
}

export interface AliasSetResult {
	url: string
	alreadyAssigned: boolean
}

/**
 * Points a preview domain at a preview deployment, so the PR is reachable on a
 * host under the app's own domain instead of the `*.vercel.app` one.
 */
export async function aliasSet(deps: VercelCommandDeps, params: AliasSetParams): Promise<AliasSetResult> {
	const { deploymentId, aliasHost, dryRun } = params
	const url = `https://${aliasHost}`

	if (dryRun) {
		deps.log(`[dry-run] would alias ${aliasHost} → deployment ${deploymentId}`)
		return { url, alreadyAssigned: false }
	}

	const { alreadyAssigned } = await deps.vercel.assignAlias(deploymentId, aliasHost)
	deps.log(
		alreadyAssigned
			? `= ${aliasHost} already points at ${deploymentId}`
			: `+ Aliased ${aliasHost} → ${deploymentId}`,
	)

	return { url, alreadyAssigned }
}
