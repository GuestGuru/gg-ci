const API_BASE = 'https://api.vercel.com'

export interface VercelEnv {
	id: string
	key: string
	gitBranch?: string
	target?: string[]
}

export interface VercelConfig {
	vercelToken: string
	vercelProjectId: string
	vercelTeamId: string
}

export interface VercelAlias {
	uid: string
	alias: string
	deploymentId?: string | null
}

export interface VercelProjectDomain {
	name: string
	/** `false` means a DNS challenge is outstanding — the domain cannot serve an alias yet. */
	verified: boolean
}

/** Safety net for the alias pagination loop — one page is 100 aliases. */
const MAX_ALIAS_PAGES = 20

/**
 * Carries the Vercel error `code` alongside the status, because several
 * outcomes are only distinguishable by code — most importantly `cert_missing`,
 * a *transient* 400 that must be retried rather than treated as a failure.
 */
export class VercelApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message)
		this.name = 'VercelApiError'
	}
}

function errorCodeFrom(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body) as { error?: { code?: string } }
		return parsed.error?.code
	} catch {
		return undefined
	}
}

export class VercelClient {
	constructor(
		private readonly config: VercelConfig,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	private async request<T>(
		method: string,
		route: string,
		body?: unknown,
		okStatuses: number[] = [],
	): Promise<T | undefined> {
		const res = await this.fetchImpl(`${API_BASE}${route}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.config.vercelToken}`,
				'Content-Type': 'application/json',
			},
			body: body ? JSON.stringify(body) : undefined,
		})
		if (okStatuses.includes(res.status)) return undefined
		if (!res.ok) {
			const body = await res.text()
			throw new VercelApiError(
				`Vercel API ${method} ${route.split('?')[0]} → ${res.status}: ${body}`,
				res.status,
				errorCodeFrom(body),
			)
		}
		const text = await res.text()
		return (text ? JSON.parse(text) : {}) as T
	}

	private get team(): string {
		return `teamId=${this.config.vercelTeamId}`
	}

	/** Only vars scoped to this exact git branch — branch-less preview vars are the shared fallback. */
	async listBranchEnvs(gitBranch: string): Promise<VercelEnv[]> {
		const result = await this.request<{ envs: VercelEnv[] }>(
			'GET',
			`/v9/projects/${this.config.vercelProjectId}/env?${this.team}`,
		)
		return (result?.envs ?? []).filter((env) => env.gitBranch === gitBranch)
	}

	async upsertEnv(key: string, value: string, gitBranch: string, encrypted: boolean): Promise<void> {
		await this.request(
			'POST',
			`/v10/projects/${this.config.vercelProjectId}/env?upsert=true&${this.team}`,
			{
				key,
				value,
				type: encrypted ? 'encrypted' : 'plain',
				target: ['preview'],
				gitBranch,
			},
		)
	}

	async deleteEnv(envId: string): Promise<void> {
		await this.request(
			'DELETE',
			`/v9/projects/${this.config.vercelProjectId}/env/${envId}?${this.team}`,
			undefined,
			[404],
		)
	}

	async latestPreviewDeployment(gitBranch: string): Promise<{ id: string; name: string } | null> {
		const params = new URLSearchParams({
			projectId: this.config.vercelProjectId,
			target: 'preview',
			limit: '1',
			'meta-githubCommitRef': gitBranch,
			teamId: this.config.vercelTeamId,
		})
		const result = await this.request<{ deployments: { uid: string; name: string }[] }>(
			'GET',
			`/v6/deployments?${params}`,
		)
		const deployment = result?.deployments?.[0]
		return deployment ? { id: deployment.uid, name: deployment.name } : null
	}

	/**
	 * Redeploys an existing deployment. Both `deploymentId` and `name` (the project
	 * name) are required by the API. `target` is deliberately NOT sent: it only accepts
	 * 'production', 'staging' or a custom environment, and passing 'preview' returns 400.
	 * Omitting it inherits the source deployment's preview target.
	 */
	async redeploy(deploymentId: string, name: string): Promise<void> {
		await this.request('POST', `/v13/deployments?forceNew=1&${this.team}`, {
			deploymentId,
			name,
		})
	}

	/** The domain as configured on *this* project, or null if it is not attached to it. */
	async findProjectDomain(host: string): Promise<VercelProjectDomain | null> {
		const result = await this.request<VercelProjectDomain>(
			'GET',
			`/v9/projects/${this.config.vercelProjectId}/domains/${host}?${this.team}`,
			undefined,
			[404],
		)
		return result ?? null
	}

	/**
	 * Attaches `host` to the project, which must happen before it can be aliased —
	 * a per-PR hostname cannot be added by hand ahead of time.
	 *
	 * Idempotency cannot be keyed on the status code here, and getting that wrong
	 * would be dangerous: a domain already on *this* project fails with **400**,
	 * while **409** means it is held by *another* Vercel project. Swallowing 409
	 * would silently alias into someone else's domain. So a failed add is resolved
	 * by asking whether the domain is on this project after all — if it is, the add
	 * was a no-op; if it is not, the original error stands.
	 */
	async addProjectDomain(host: string): Promise<{ alreadyPresent: boolean; verified: boolean }> {
		try {
			const result = await this.request<VercelProjectDomain>(
				'POST',
				`/v10/projects/${this.config.vercelProjectId}/domains?${this.team}`,
				{ name: host },
			)
			return { alreadyPresent: false, verified: result?.verified ?? false }
		} catch (error) {
			if (!(error instanceof VercelApiError)) throw error
			const existing = await this.findProjectDomain(host)
			if (!existing) throw error
			return { alreadyPresent: true, verified: existing.verified }
		}
	}

	/**
	 * Detaches `host` from the project. 404 is not an error: the domain is already
	 * gone, which is the desired end state.
	 */
	async deleteProjectDomain(host: string): Promise<void> {
		await this.request(
			'DELETE',
			`/v9/projects/${this.config.vercelProjectId}/domains/${host}?${this.team}`,
			undefined,
			[404],
		)
	}

	/**
	 * Points `alias` at `deploymentId`. Idempotent by way of the API itself:
	 *
	 * - an alias currently held by *another* deployment is moved over (200), so
	 *   re-running on a new deployment of the same PR is the normal path;
	 * - an alias already held by *this* deployment answers 409, which is a
	 *   success for our purposes, not a failure.
	 *
	 * Returns whether the 409 (already-assigned) branch was taken.
	 */
	async assignAlias(deploymentId: string, alias: string): Promise<{ alreadyAssigned: boolean }> {
		const result = await this.request<{ uid: string; alias: string }>(
			'POST',
			`/v2/deployments/${deploymentId}/aliases?${this.team}`,
			{ alias },
			[409],
		)
		return { alreadyAssigned: result === undefined }
	}

	/** Every alias of this project, following the timestamp-cursor pagination. */
	async listAliases(): Promise<VercelAlias[]> {
		const aliases: VercelAlias[] = []
		let until: number | undefined

		for (let page = 0; page < MAX_ALIAS_PAGES; page += 1) {
			const params = new URLSearchParams({
				projectId: this.config.vercelProjectId,
				limit: '100',
				teamId: this.config.vercelTeamId,
			})
			if (until !== undefined) params.set('until', String(until))

			const result = await this.request<{
				aliases: VercelAlias[]
				pagination?: { next: number | null }
			}>('GET', `/v4/aliases?${params}`)

			aliases.push(...(result?.aliases ?? []))
			const next = result?.pagination?.next
			if (next === undefined || next === null) break
			until = next
		}

		return aliases
	}

	async findAlias(host: string): Promise<VercelAlias | null> {
		const aliases = await this.listAliases()
		return aliases.find((alias) => alias.alias === host) ?? null
	}

	/** 404 is not an error: the alias is already gone, which is the desired end state. */
	async deleteAlias(aliasId: string): Promise<void> {
		await this.request('DELETE', `/v2/aliases/${aliasId}?${this.team}`, undefined, [404])
	}
}
