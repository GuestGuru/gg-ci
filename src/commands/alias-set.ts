import { ALIAS_PROTECTION_OVERRIDE, VercelApiError } from '../vercel.js'
import type { VercelCommandDeps } from './types.js'

export interface AliasSetParams {
	deploymentId: string
	aliasHost: string
	dryRun: boolean
}

export interface AliasSetResult {
	url: string
	alreadyAssigned: boolean
	/** A pre-IT-1046 project domain of the same name was detached (see `aliasSet`). */
	legacyDomainDetached: boolean
	/** Deployment Protection Exception on the alias: created now, already there, or not needed. */
	protectionOverride: 'created' | 'present' | 'not-needed'
}

/**
 * The host must be a PR host: its first label ends in `-pr-<number>`, as every caller's
 * `alias-host-pattern` (`<app>-pr-{pr}.preview.…`) produces. This is what makes the
 * legacy clean-up below safe — `alias-set` may detach a project domain of this name,
 * and a mis-set pattern must never make that a production domain.
 */
const PR_HOST = /^[a-z0-9-]+-pr-\d+\./

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
 * Points a PR host at the PR's preview deployment, so the PR is reachable on a host
 * under the app's own domain instead of the `*.vercel.app` one.
 *
 * ⚠️ The host is a **deployment alias only, never a project domain** (IT-1046). A
 * project domain without a git-branch binding is a production domain: Vercel moves it
 * onto every new production deployment, so an open PR's link served the live site and
 * the production database while still looking like the PR (measured 2026-09-25,
 * `tools-pr-157`). Binding the domain to the PR's branch (gg-ci#93) stopped that, but
 * made it a preview domain behind Deployment Protection, and every PR smoke got 302/401
 * (reverted in gg-ci#94). A plain alias is neither: a production deployment does not
 * take it over, and nothing re-creates it after `alias-remove` (measured on a scratch
 * project, 2026-09-25). It is protected like any preview URL, so `alias-set` makes the
 * alias a Deployment Protection Exception — the host stays as reachable as the old
 * production-domain host was, while the deployment's `*.vercel.app` URLs stay protected.
 *
 * Refuses, before any write: a host that is not a PR host, a deployment of another
 * project, a production deployment, and a host whose alias belongs to another project.
 */
export async function aliasSet(deps: VercelCommandDeps, params: AliasSetParams): Promise<AliasSetResult> {
	const { deploymentId, aliasHost, dryRun } = params
	const url = `https://${aliasHost}`

	if (!PR_HOST.test(aliasHost)) {
		throw new Error(`${aliasHost} is not a PR host (<app>-pr-<number>.…) — refusing to alias it`)
	}

	if (dryRun) {
		deps.log(`[dry-run] would alias ${aliasHost} → deployment ${deploymentId} (deployment alias, no project domain)`)
		deps.log(`[dry-run] would make ${aliasHost} a Deployment Protection Exception if the project is protected`)
		return { url, alreadyAssigned: false, legacyDomainDetached: false, protectionOverride: 'not-needed' }
	}

	const projectId = deps.vercel.projectId
	const deployment = await deps.vercel.getDeployment(deploymentId)
	if (deployment.projectId !== projectId) {
		throw new Error(
			`${deploymentId} belongs to project ${deployment.projectId ?? '(unknown)'}, not ${projectId} — refusing to alias ${aliasHost} to it`,
		)
	}
	if (deployment.target === 'production') {
		throw new Error(`${deploymentId} is a production deployment — refusing to alias the PR host ${aliasHost} to it`)
	}

	const existing = await deps.vercel.getAlias(aliasHost)
	if (existing?.projectId && existing.projectId !== projectId) {
		throw new Error(`${aliasHost} is an alias of project ${existing.projectId}, not ${projectId} — refusing to take it over`)
	}

	// A host attached as a project domain before IT-1046 is the hijack vector itself —
	// detach it. Detaching also drops its alias (measured), which the assign below
	// re-creates as a plain alias a moment later.
	const legacyDomainDetached = Boolean(await deps.vercel.findProjectDomain(aliasHost))
	if (legacyDomainDetached) {
		await deps.vercel.deleteProjectDomain(aliasHost)
		deps.log(`- Detached ${aliasHost} from the project domains (pre-IT-1046 host, a production-domain hijack risk)`)
	}

	const { alreadyAssigned } = await assignWithCertRetry(deps, deploymentId, aliasHost)
	deps.log(
		alreadyAssigned
			? `= ${aliasHost} already points at ${deploymentId}`
			: `+ Aliased ${aliasHost} → ${deploymentId}`,
	)

	const protectionOverride = await ensureProtectionOverride(deps, aliasHost)
	return { url, alreadyAssigned, legacyDomainDetached, protectionOverride }
}

/**
 * Keeps the PR host exactly as reachable as it was while it was a (production)
 * project domain. `all` protects production domains too, so there the host stays
 * protected; with any narrower scope (`all_except_custom_domains`, the legacy
 * `prod_deployment_urls_and_all_previews`) the alias gets a Deployment Protection
 * Exception; with no protection there is nothing to except.
 */
async function ensureProtectionOverride(
	deps: VercelCommandDeps,
	aliasHost: string,
): Promise<AliasSetResult['protectionOverride']> {
	const { sso, password } = await deps.vercel.getProjectProtection()
	const scopes = [sso, password].filter((scope): scope is string => Boolean(scope))
	if (scopes.length === 0 || scopes.includes('all')) {
		deps.log(`= Project protection ${scopes.join('+') || 'off'} — no protection exception for ${aliasHost}`)
		return 'not-needed'
	}

	const alias = await deps.vercel.getAlias(aliasHost)
	if (!alias) throw new Error(`${aliasHost} was aliased but cannot be read back`)
	const present = Object.values(alias.protectionBypass ?? {}).some(
		(bypass) => bypass?.scope === ALIAS_PROTECTION_OVERRIDE,
	)
	if (present || !(await deps.vercel.createAliasProtectionOverride(alias.uid))) {
		deps.log(`= ${aliasHost} is already a Deployment Protection Exception`)
		return 'present'
	}
	deps.log(`+ ${aliasHost} is now a Deployment Protection Exception (project protection: ${scopes.join('+')})`)
	return 'created'
}
