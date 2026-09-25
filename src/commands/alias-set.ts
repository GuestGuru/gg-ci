import { VercelApiError } from '../vercel.js'
import type { VercelCommandDeps } from './types.js'

export interface AliasSetParams {
	deploymentId: string
	aliasHost: string
	dryRun: boolean
}

export interface AliasSetResult {
	url: string
	alreadyAssigned: boolean
	domainAdded: boolean
	/** The git branch the host is bound to — empty in dry-run. */
	gitBranch: string
}

/**
 * `cert_missing` is not a failure — it means Vercel is still issuing the TLS
 * certificate for a hostname it has just seen for the first time. Measured
 * against the live API, the certificate lands in roughly 12 seconds, after
 * which the identical call succeeds. Without this retry the *first* alias of
 * every PR would fail on a zone that gets one certificate per host.
 *
 * A zone with a wildcard certificate never takes this path — a new host is served
 * by the wildcard on the first call (README, "Vercel alias API notes"). The retry
 * stays as the safety net for callers whose zone has no wildcard.
 */
const CERT_MISSING_CODE = 'cert_missing'
const CERT_RETRY_DELAY_MS = 5_000
const CERT_MAX_ATTEMPTS = 15 // 14 waits ≈ 70 s

function isCertMissing(error: unknown): boolean {
	return error instanceof VercelApiError && error.code === CERT_MISSING_CODE
}

async function assignWithCertRetry(
	deps: VercelCommandDeps,
	deploymentId: string,
	aliasHost: string,
): Promise<{ alreadyAssigned: boolean }> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await deps.vercel.assignAlias(deploymentId, aliasHost)
		} catch (error) {
			// Every other error code fails immediately — only cert issuance is transient.
			if (!isCertMissing(error)) throw error
			if (attempt >= CERT_MAX_ATTEMPTS) {
				deps.log(`! Certificate for ${aliasHost} still not ready after ${attempt} attempts — giving up`)
				throw error
			}
			deps.log(
				`… Certificate for ${aliasHost} is still being issued (attempt ${attempt}/${CERT_MAX_ATTEMPTS}) — retrying in ${CERT_RETRY_DELAY_MS / 1000}s`,
			)
			await deps.sleep(CERT_RETRY_DELAY_MS)
		}
	}
}

/**
 * Points a preview domain at a preview deployment, so the PR is reachable on a
 * host under the app's own domain instead of the `*.vercel.app` one.
 *
 * Attaching the host to the project is part of the job: a per-PR hostname does
 * not exist until the PR does, so it cannot have been added by hand up front.
 *
 * The host is bound to the deployment's git branch (IT-1046). Without the binding it
 * is a production domain, and the next production deployment takes it over — the PR
 * link then serves the live site and the production database while still looking
 * like the PR. The branch comes from the deployment itself, so the caller workflows
 * need no new input; a production deployment, or one without a git branch, is refused
 * rather than aliased unbound.
 */
export async function aliasSet(deps: VercelCommandDeps, params: AliasSetParams): Promise<AliasSetResult> {
	const { deploymentId, aliasHost, dryRun } = params
	const url = `https://${aliasHost}`

	if (dryRun) {
		deps.log(`[dry-run] would add ${aliasHost} to the project, bound to the deployment's git branch`)
		deps.log(`[dry-run] would alias ${aliasHost} → deployment ${deploymentId}`)
		return { url, alreadyAssigned: false, domainAdded: false, gitBranch: '' }
	}

	const deployment = await deps.vercel.getDeployment(deploymentId)
	if (deployment.target === 'production') {
		throw new Error(`${deploymentId} is a production deployment — refusing to alias the preview host ${aliasHost} to it`)
	}
	const gitBranch = deployment.gitBranch
	if (!gitBranch) {
		throw new Error(
			`${deploymentId} has no git branch — ${aliasHost} would become an unbound (production) domain, refusing`,
		)
	}

	const domain = await deps.vercel.addProjectDomain(aliasHost, gitBranch)
	if (!domain.alreadyPresent) {
		deps.log(`+ Added ${aliasHost} to the project, bound to ${gitBranch} (verified=${domain.verified})`)
	} else if (domain.rebound) {
		deps.log(`~ ${aliasHost} was already attached — re-bound to ${gitBranch}`)
	} else {
		deps.log(`= ${aliasHost} is already attached to the project, bound to ${gitBranch}`)
	}
	if (!domain.verified) {
		// A sub-domain of an apex the team owns comes back verified straight away; an
		// unverified one has an outstanding DNS challenge and will not serve the alias.
		deps.log(`! ${aliasHost} is not verified — the apex domain may not belong to this Vercel team`)
	}

	const { alreadyAssigned } = await assignWithCertRetry(deps, deploymentId, aliasHost)
	deps.log(
		alreadyAssigned
			? `= ${aliasHost} already points at ${deploymentId}`
			: `+ Aliased ${aliasHost} → ${deploymentId}`,
	)

	return { url, alreadyAssigned, domainAdded: !domain.alreadyPresent, gitBranch }
}
