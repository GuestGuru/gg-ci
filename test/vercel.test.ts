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
		// No `target`: Vercel rejects `target: 'preview'` with 400 — that field only accepts
		// 'production', 'staging' or a custom environment. Omitting it yields a preview deploy.
		expect(JSON.parse(init.body)).toEqual({ deploymentId: 'dpl_1', name: 'my-project' })
	})

	it('a deployment projektjét és targetjét olvassa', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'dpl_1', projectId: 'prj_1', target: 'production', url: 'x' }))

		expect(await client().getDeployment('dpl_1')).toEqual({ id: 'dpl_1', projectId: 'prj_1', target: 'production' })
		expect(mockCallArgs(fetchMock)[0]).toBe('https://api.vercel.com/v13/deployments/dpl_1?teamId=team_1')
	})

	it('a preview deployment targetje null', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'dpl_1', projectId: 'prj_1', target: null }))

		expect((await client().getDeployment('dpl_1')).target).toBeNull()
	})

	it('a projekt védelmi scope-jait olvassa (null = kikapcsolva)', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ ssoProtection: { deploymentType: 'all_except_custom_domains' }, passwordProtection: null }),
		)

		expect(await client().getProjectProtection()).toEqual({ sso: 'all_except_custom_domains', password: null })
		expect(mockCallArgs(fetchMock)[0]).toBe('https://api.vercel.com/v9/projects/prj_1?teamId=team_1')
	})

	it('egy aliast hosztnév szerint, team-szinten olvas; a 404 null', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ uid: 'a1', alias: 'myapp-pr-12.preview.example.com', projectId: 'prj_2' }))
			.mockResolvedValueOnce(new Response('', { status: 404 }))

		expect((await client().getAlias('myapp-pr-12.preview.example.com'))?.projectId).toBe('prj_2')
		expect(mockCallArgs(fetchMock)[0]).toBe(
			'https://api.vercel.com/v4/aliases/myapp-pr-12.preview.example.com?teamId=team_1',
		)
		expect(await client().getAlias('myapp-pr-13.preview.example.com')).toBeNull()
	})

	it('védelmi kivételt tesz az aliasra', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ protectionBypass: { '*': { scope: 'alias-protection-override' } } }))

		expect(await client().createAliasProtectionOverride('a1')).toBe(true)

		const [url, init] = mockCallArgs(fetchMock)
		expect(url).toBe('https://api.vercel.com/aliases/a1/protection-bypass?teamId=team_1')
		expect(init.method).toBe('PATCH')
		expect(JSON.parse(init.body)).toEqual({ override: { scope: 'alias-protection-override', action: 'create' } })
	})

	it('a már meglévő kivétel (400 exception_already_exists) nem hiba, a többi 400 igen', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ error: { code: 'exception_already_exists' } }, 400))
			.mockResolvedValueOnce(jsonResponse({ error: { code: 'bad_request' } }, 400))

		expect(await client().createAliasProtectionOverride('a1')).toBe(false)
		await expect(client().createAliasProtectionOverride('a1')).rejects.toThrow(/400/)
	})

	it('leválasztja a domaint a projektről', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({}))
		await client().deleteProjectDomain('pr-12.preview.example.com')
		const [url, init] = mockCallArgs(fetchMock)
		expect(url).toBe(
			'https://api.vercel.com/v9/projects/prj_1/domains/pr-12.preview.example.com?teamId=team_1',
		)
		expect(init.method).toBe('DELETE')
	})

	it('a 404-es domain törlést nem tekinti hibának', async () => {
		fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }))
		await expect(client().deleteProjectDomain('pr-12.preview.example.com')).resolves.toBeUndefined()
	})

	it('null, ha a domain nincs a projekten', async () => {
		fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }))
		expect(await client().findProjectDomain('pr-12.preview.example.com')).toBeNull()
	})

	it('a hibakódot kiolvassa a válasz törzséből', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'cert_missing' } }, 400))

		await expect(client().assignAlias('dpl_1', 'pr-12.preview.example.com')).rejects.toMatchObject({
			status: 400,
			code: 'cert_missing',
		})
	})

	it('aliast rendel a deploymenthez', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ uid: 'alias_1', alias: 'pr-12.preview.example.com' }))

		const result = await client().assignAlias('dpl_1', 'pr-12.preview.example.com')

		const [url, init] = mockCallArgs(fetchMock)
		expect(url).toBe('https://api.vercel.com/v2/deployments/dpl_1/aliases?teamId=team_1')
		expect(init.method).toBe('POST')
		expect(JSON.parse(init.body)).toEqual({ alias: 'pr-12.preview.example.com' })
		expect(result).toEqual({ alreadyAssigned: false })
	})

	it('a 409-et sikerként kezeli — az alias már erre a deploymentre mutat', async () => {
		fetchMock.mockResolvedValueOnce(new Response('already assigned', { status: 409 }))
		expect(await client().assignAlias('dpl_1', 'pr-12.preview.example.com')).toEqual({
			alreadyAssigned: true,
		})
	})

	it('név szerint találja meg a projekt aliasát', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				aliases: [
					{ uid: 'a1', alias: 'other.preview.example.com', deploymentId: 'dpl_0' },
					{ uid: 'a2', alias: 'pr-12.preview.example.com', deploymentId: 'dpl_1' },
				],
				pagination: { count: 2, next: null, prev: null },
			}),
		)

		const alias = await client().findAlias('pr-12.preview.example.com')

		expect(alias?.uid).toBe('a2')
		const [url] = mockCallArgs(fetchMock)
		expect(url).toContain('/v4/aliases?')
		expect(url).toContain('projectId=prj_1')
		expect(url).toContain('teamId=team_1')
	})

	it('lapozva gyűjti be az aliasokat', async () => {
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({
					aliases: [{ uid: 'a1', alias: 'one.preview.example.com' }],
					pagination: { count: 1, next: 1700000000000, prev: null },
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					aliases: [{ uid: 'a2', alias: 'two.preview.example.com' }],
					pagination: { count: 1, next: null, prev: null },
				}),
			)

		const aliases = await client().listAliases()

		expect(aliases.map((a) => a.uid)).toEqual(['a1', 'a2'])
		expect(mockCallArgs(fetchMock, 1)[0]).toContain('until=1700000000000')
	})

	it('null, ha nincs ilyen nevű alias', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ aliases: [], pagination: { count: 0, next: null } }))
		expect(await client().findAlias('pr-12.preview.example.com')).toBeNull()
	})

	it('a 404-es alias törlést nem tekinti hibának', async () => {
		fetchMock.mockResolvedValueOnce(new Response('gone', { status: 404 }))
		await expect(client().deleteAlias('a1')).resolves.toBeUndefined()
	})

	it('id alapján töröl aliast', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'SUCCESS' }))
		await client().deleteAlias('a1')
		const [url, init] = mockCallArgs(fetchMock)
		expect(url).toBe('https://api.vercel.com/v2/aliases/a1?teamId=team_1')
		expect(init.method).toBe('DELETE')
	})

	it('hibát dob nem-ok válaszra', async () => {
		fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))
		await expect(client().listBranchEnvs('feat/x')).rejects.toThrow(/500/)
	})
})
