import { branchNameForPr } from '../naming.js'
import type { Config } from '../config.js'
import { type CommandDeps, ISOLATED_FLAG_ENV, expiryFrom } from './types.js'

export interface EnsureParams {
	config: Config
	prNumber: number
	gitBranch: string
	dryRun: boolean
}

export interface EnsureResult {
	branchId: string
	branchCreated: boolean
	envCreated: boolean
	redeployed: boolean
}

export async function ensure(deps: CommandDeps, params: EnsureParams): Promise<EnsureResult> {
	const { config, prNumber, gitBranch, dryRun } = params
	const branchName = branchNameForPr(config.branchPrefix, prNumber)
	const expiresAt = expiryFrom(deps.now(), config.ttlDays)

	const existing = await deps.neon.findBranchByName(branchName)
	const existingEnvs = await deps.vercel.listBranchEnvs(gitBranch)
	const hasEnv = (key: string): boolean => existingEnvs.some((env) => env.key === key)
	// The unpooled var counts too: an app that adds the input to an already-open PR
	// must get a redeploy, otherwise the running deployment never sees the new var.
	const envExists =
		hasEnv(config.envVarName) && (!config.unpooledEnvVarName || hasEnv(config.unpooledEnvVarName))

	if (dryRun) {
		deps.log(`[dry-run] would ${existing ? 'refresh TTL on' : 'create'} ${branchName}`)
		deps.log(`[dry-run] would ${envExists ? 'update' : 'create'} env vars on branch ${gitBranch}`)
		if (config.unpooledEnvVarName) {
			deps.log(`[dry-run] would write the unpooled URI into ${config.unpooledEnvVarName}`)
		}
		if (!envExists) deps.log('[dry-run] would request a redeploy')
		return { branchId: existing?.id ?? '', branchCreated: false, envCreated: false, redeployed: false }
	}

	let branchId: string
	let branchCreated = false

	if (existing) {
		branchId = existing.id
		await deps.neon.setExpiry(branchId, expiresAt)
		deps.log(`= Reusing ${branchName}, TTL extended to ${expiresAt}`)
	} else {
		const created = await deps.neon.createBranch(branchName, expiresAt)
		branchId = created.id
		branchCreated = true
		await deps.neon.waitReady(branchId)
		deps.log(`+ Created ${branchName} (id=${branchId}), expires ${expiresAt}`)
	}

	const uri = await deps.neon.connectionUri(branchId)
	await deps.vercel.upsertEnv(config.envVarName, uri, gitBranch, true)
	if (config.unpooledEnvVarName) {
		const directUri = await deps.neon.connectionUri(branchId, false)
		await deps.vercel.upsertEnv(config.unpooledEnvVarName, directUri, gitBranch, true)
	}
	await deps.vercel.upsertEnv(ISOLATED_FLAG_ENV, '1', gitBranch, false)
	deps.log(`+ Vercel preview env set for git branch ${gitBranch}`)

	// The very first deploy of a new PR is created before this workflow finishes,
	// so it would still be pointing at the shared fallback DB. Redeploy to move it
	// onto its own branch. Later pushes already have the env var at deploy time.
	let redeployed = false
	if (!envExists) {
		try {
			const deployment = await deps.vercel.latestPreviewDeployment(gitBranch)
			if (deployment) {
				await deps.vercel.redeploy(deployment.id, deployment.name)
				redeployed = true
				deps.log(`+ Redeploy requested for ${deployment.id}`)
			} else {
				deps.log('= No existing preview deployment to redeploy')
			}
		} catch (error) {
			// Non-fatal: the next push creates a deployment that already has the env var.
			deps.log(`! Redeploy failed (non-fatal): ${error instanceof Error ? error.message : error}`)
		}
	}

	return { branchId, branchCreated, envCreated: !envExists, redeployed }
}
