const API_BASE = 'https://console.neon.tech/api/v2'

export interface NeonBranch {
	id: string
	name: string
	current_state?: string
	expires_at?: string
}

export interface NeonConfig {
	neonApiKey: string
	neonProjectId: string
	parentBranchId: string
	roleName: string
	databaseName: string
}

export class NeonClient {
	constructor(
		private readonly config: NeonConfig,
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
				Authorization: `Bearer ${this.config.neonApiKey}`,
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: body ? JSON.stringify(body) : undefined,
		})
		if (okStatuses.includes(res.status)) return undefined
		const text = await res.text()
		if (!res.ok) {
			throw new Error(`Neon API ${method} ${route} → ${res.status}: ${text}`)
		}
		return (text ? JSON.parse(text) : {}) as T
	}

	private get projectRoute(): string {
		return `/projects/${this.config.neonProjectId}`
	}

	async listBranches(): Promise<NeonBranch[]> {
		const result = await this.request<{ branches: NeonBranch[] }>('GET', `${this.projectRoute}/branches`)
		return result?.branches ?? []
	}

	async findBranchByName(name: string): Promise<NeonBranch | null> {
		const branches = await this.listBranches()
		return branches.find((branch) => branch.name === name) ?? null
	}

	async createBranch(name: string, expiresAt: string): Promise<NeonBranch> {
		const result = await this.request<{ branch: NeonBranch }>('POST', `${this.projectRoute}/branches`, {
			branch: { name, parent_id: this.config.parentBranchId, expires_at: expiresAt },
			endpoints: [{ type: 'read_write' }],
		})
		if (!result?.branch) throw new Error(`Neon branch creation returned no branch for ${name}`)
		return result.branch
	}

	async setExpiry(branchId: string, expiresAt: string): Promise<void> {
		await this.request('PATCH', `${this.projectRoute}/branches/${branchId}`, {
			branch: { expires_at: expiresAt },
		})
	}

	/** Deleting an already-missing branch is a no-op, so `destroy` stays idempotent. */
	async deleteBranch(branchId: string): Promise<void> {
		await this.request('DELETE', `${this.projectRoute}/branches/${branchId}`, undefined, [404])
	}

	async resetFromParent(branchId: string): Promise<void> {
		await this.request('POST', `${this.projectRoute}/branches/${branchId}/restore`, {
			source_branch_id: this.config.parentBranchId,
		})
	}

	async connectionUri(branchId: string): Promise<string> {
		const params = new URLSearchParams({
			branch_id: branchId,
			database_name: this.config.databaseName,
			role_name: this.config.roleName,
			pooled: 'true',
		})
		const result = await this.request<{ uri: string }>(
			'GET',
			`${this.projectRoute}/connection_uri?${params}`,
		)
		if (!result?.uri) throw new Error(`Neon returned no connection URI for ${branchId}`)
		return result.uri
	}

	async waitReady(branchId: string, timeoutMs = 30_000, pollMs = 1500): Promise<void> {
		const deadline = Date.now() + timeoutMs
		for (;;) {
			const branches = await this.listBranches()
			const branch = branches.find((candidate) => candidate.id === branchId)
			if (branch?.current_state === 'ready') return
			if (Date.now() >= deadline) {
				throw new Error(`Neon branch ${branchId} did not become ready in ${timeoutMs}ms`)
			}
			await new Promise((resolve) => setTimeout(resolve, pollMs))
		}
	}
}
