import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NeonClient } from '../src/neon.js'
import { mockCallArgs } from './helpers.js'

const CONFIG = {
	neonApiKey: 'key',
	neonProjectId: 'proj_1',
	parentBranchId: 'br-parent',
	roleName: 'app_role',
	databaseName: 'app_db',
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('NeonClient', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
	})

	function client() {
		return new NeonClient(CONFIG, fetchMock as unknown as typeof fetch)
	}

	it('név szerint megtalálja a branchet', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ branches: [{ id: 'br-1', name: 'preview/app/pr-1' }] }),
		)
		const found = await client().findBranchByName('preview/app/pr-1')
		expect(found).toEqual({ id: 'br-1', name: 'preview/app/pr-1' })
		const [url, init] = mockCallArgs(fetchMock)
		expect(url).toBe('https://console.neon.tech/api/v2/projects/proj_1/branches')
		expect(init.headers.Authorization).toBe('Bearer key')
	})

	it('null, ha nincs ilyen nevű branch', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ branches: [{ id: 'br-1', name: 'other' }] }))
		expect(await client().findBranchByName('preview/app/pr-1')).toBeNull()
	})

	it('a parent branchről forkol, TTL-lel', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ branch: { id: 'br-new', name: 'n' } }))
		const branch = await client().createBranch('n', '2026-08-01T00:00:00.000Z')
		expect(branch.id).toBe('br-new')
		const [url, init] = mockCallArgs(fetchMock)
		expect(url).toBe('https://console.neon.tech/api/v2/projects/proj_1/branches')
		expect(init.method).toBe('POST')
		expect(JSON.parse(init.body)).toEqual({
			branch: { name: 'n', parent_id: 'br-parent', expires_at: '2026-08-01T00:00:00.000Z' },
			endpoints: [{ type: 'read_write' }],
		})
	})

	it('PATCH-csel tolja a lejáratot', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({}))
		await client().setExpiry('br-1', '2026-08-01T00:00:00.000Z')
		const [url, init] = mockCallArgs(fetchMock)
		expect(url).toBe('https://console.neon.tech/api/v2/projects/proj_1/branches/br-1')
		expect(init.method).toBe('PATCH')
		expect(JSON.parse(init.body)).toEqual({ branch: { expires_at: '2026-08-01T00:00:00.000Z' } })
	})

	it('a restore endpointtal reseteli a branchet a parentről', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({}))
		await client().resetFromParent('br-shared')
		const [url, init] = mockCallArgs(fetchMock)
		expect(url).toBe('https://console.neon.tech/api/v2/projects/proj_1/branches/br-shared/restore')
		expect(init.method).toBe('POST')
		expect(JSON.parse(init.body)).toEqual({ source_branch_id: 'br-parent' })
	})

	it('pooled connection URI-t kér a megadott role-lal és DB-vel', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ uri: 'postgres://x' }))
		expect(await client().connectionUri('br-1')).toBe('postgres://x')
		const [url] = mockCallArgs(fetchMock)
		expect(url).toContain('/projects/proj_1/connection_uri?')
		expect(url).toContain('branch_id=br-1')
		expect(url).toContain('database_name=app_db')
		expect(url).toContain('role_name=app_role')
		expect(url).toContain('pooled=true')
	})

	it('pooled=false-szal a direkt (unpooled) URI-t kéri', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ uri: 'postgres://direct' }))
		expect(await client().connectionUri('br-1', false)).toBe('postgres://direct')
		const [url] = mockCallArgs(fetchMock)
		expect(url).toContain('branch_id=br-1')
		expect(url).toContain('pooled=false')
	})

	it('a 404-es törlést nem tekinti hibának', async () => {
		fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }))
		await expect(client().deleteBranch('br-gone')).resolves.toBeUndefined()
		const [url, init] = mockCallArgs(fetchMock)
		expect(url).toBe('https://console.neon.tech/api/v2/projects/proj_1/branches/br-gone')
		expect(init.method).toBe('DELETE')
	})

	it('hibát dob nem-ok válaszra', async () => {
		fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))
		await expect(client().listBranches()).rejects.toThrow(/500/)
	})

	it('a waitReady addig pollozik, amíg ready nem lesz', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ branches: [{ id: 'br-1', name: 'n', current_state: 'init' }] }))
			.mockResolvedValueOnce(jsonResponse({ branches: [{ id: 'br-1', name: 'n', current_state: 'ready' }] }))
		await client().waitReady('br-1', 5000, 0)
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('a waitReady hibázik timeout után', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(jsonResponse({ branches: [{ id: 'br-1', name: 'n', current_state: 'init' }] })),
		)
		await expect(client().waitReady('br-1', 1, 0)).rejects.toThrow(/did not become ready/)
	})
})
