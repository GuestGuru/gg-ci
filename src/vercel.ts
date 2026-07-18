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

	async latestPreviewDeployment(gitBranch: string): Promise<string | null> {
		const params = new URLSearchParams({
			projectId: this.config.vercelProjectId,
			target: 'preview',
			limit: '1',
			'meta-githubCommitRef': gitBranch,
			teamId: this.config.vercelTeamId,
		})
		const result = await this.request<{ deployments: { uid: string }[] }>(
			'GET',
			`/v6/deployments?${params}`,
		)
		return result?.deployments?.[0]?.uid ?? null
	}

	async redeploy(deploymentId: string): Promise<void> {
		await this.request('POST', `/v13/deployments?forceNew=1&${this.team}`, {
			deploymentId,
			target: 'preview',
		})
	}
}
