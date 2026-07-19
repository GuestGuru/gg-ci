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

/** Safety net for the alias pagination loop — one page is 100 aliases. */
const MAX_ALIAS_PAGES = 20

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
			throw new Error(`Vercel API ${method} ${route.split('?')[0]} → ${res.status}: ${await res.text()}`)
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
