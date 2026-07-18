import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VercelClient } from '../src/vercel.js'
import { mockCallArgs } from './helpers.js'

const CONFIG = { vercelToken: 'tok', vercelProjectId: 'prj_1', vercelTeamId: 'team_1' }

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('VercelClient', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
	})

	function client() {
		return new VercelClient(CONFIG, fetchMock as unknown as typeof fetch)
	}

	it('csak az adott git branch preview env varjait adja vissza', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				envs: [
					{ id: 'e1', key: 'DB_URL', target: ['preview'], gitBranch: 'feat/x' },
					{ id: 'e2', key: 'DB_URL', target: ['preview'], gitBranch: 'feat/y' },
					{ id: 'e3', key: 'DB_URL', target: ['preview'] },
					{ id: 'e4', key: 'OTHER', target: ['production'] },
				],
			}),
		)
		const envs = await client().listBranchEnvs('feat/x')
		expect(envs.map((e) => e.id)).toEqual(['e1'])
	})

	it('upsert=true-val hozza létre az env vart branch scope-pal', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ created: {} }, 201))
		await client().upsertEnv('DB_URL', 'postgres://x', 'feat/x', true)
		const [url, init] = mockCallArgs(fetchMock)
		expect(url).toBe('https://api.vercel.com/v10/projects/prj_1/env?upsert=true&teamId=team_1')
		expect(init.method).toBe('POST')
		expect(init.headers.Authorization).toBe('Bearer tok')
		expect(JSON.parse(init.body)).toEqual({
			key: 'DB_URL',
			value: 'postgres://x',
			type: 'encrypted',
			target: ['preview'],
			gitBranch: 'feat/x',
		})
	})

	it('plain típust használ, ha nem titkos', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ created: {} }, 201))
		await client().upsertEnv('FLAG', '1', 'feat/x', false)
		expect(JSON.parse(mockCallArgs(fetchMock)[1].body).type).toBe('plain')
	})

	it('a 404-es env törlést nem tekinti hibának', async () => {
		fetchMock.mockResolvedValueOnce(new Response('gone', { status: 404 }))
		await expect(client().deleteEnv('e1')).resolves.toBeUndefined()
	})

	it('megtalálja a branch legutóbbi preview deployjának id-jét és nevét', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ deployments: [{ uid: 'dpl_1', name: 'my-project' }, { uid: 'dpl_0', name: 'my-project' }] }),
		)
		expect(await client().latestPreviewDeployment('feat/x')).toEqual({ id: 'dpl_1', name: 'my-project' })
		const [url] = mockCallArgs(fetchMock)
		expect(url).toContain('projectId=prj_1')
		expect(url).toContain('target=preview')
		expect(url).toContain(`meta-githubCommitRef=${encodeURIComponent('feat/x')}`)
	})

	it('null, ha nincs deploy a branchen', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ deployments: [] }))
		expect(await client().latestPreviewDeployment('feat/x')).toBeNull()
	})

	it('deploymentId-val és névvel kér redeployt', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'dpl_2' }))
		await client().redeploy('dpl_1', 'my-project')
		const [url, init] = mockCallArgs(fetchMock)
		expect(url).toBe('https://api.vercel.com/v13/deployments?forceNew=1&teamId=team_1')
		expect(JSON.parse(init.body)).toEqual({ deploymentId: 'dpl_1', name: 'my-project', target: 'preview' })
	})

	it('hibát dob nem-ok válaszra', async () => {
		fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))
		await expect(client().listBranchEnvs('feat/x')).rejects.toThrow(/500/)
	})
})
