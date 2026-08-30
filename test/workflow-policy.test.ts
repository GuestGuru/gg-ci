import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
	centralTrustInventory,
	hashWorkflow,
	policyForRepository,
	policySourceLine,
	resolvePolicySource,
	run,
	stalePinDiagnosis,
	validateWorkflowPolicy,
	workflowInventoryForRepository,
} from '../src/workflow-policy.js'

// IT-295 óta EGY gate-hívás van: a quality-gate maga publikálja a
// `GG deployment gate` commit statust. A külön deployment-gate job ugyanazt a
// kiértékelést futtatta még egyszer, egy második VM-en — a jobonkénti percre
// kerekített számlázás mellett ez futásonként 1 elpazarolt perc volt.
const validSalesWorkflow = `
name: CI
on: pull_request
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  quality-gate:
    name: quality-gate
    if: \${{ always() }}
    needs: [ci]
    uses: GuestGuru/gg-ci/.github/workflows/quality-gate.yml@main
    with:
      needs-json: \${{ toJSON(needs) }}
      status-context: GG deployment gate
`

const salesInventory =
	workflowInventoryForRepository('GuestGuru/gg-sales') ?? {}

describe('workflow policy', () => {
	it('maps every protected repository to its canonical workflow and jobs', () => {
		expect(policyForRepository('GuestGuru/gg-sales')).toEqual({
			workflowPath: '.github/workflows/ci.yml',
			requiredNeeds: ['ci'],
			uses: 'GuestGuru/gg-ci/.github/workflows/quality-gate.yml@main',
			statusContext: 'GG deployment gate',
		})
		// A `forras` job (lint + typecheck + build) az IT-274-ben került be: a
		// gg-design addig SEM lintet, SEM typecheckot, SEM buildet nem futtatott,
		// pedig ez a repo szállítja a komponenseket a másik hét appnak.
		expect(policyForRepository('GuestGuru/gg-design')?.requiredNeeds).toEqual([
			'registry',
			'forras',
			'meresek',
		])
		expect(policyForRepository('GuestGuru/BPDBv2')?.requiredNeeds).toEqual([
			'web',
			'pipeline',
		])
		expect(policyForRepository('GuestGuru/gg-agents')?.requiredNeeds).toEqual([
			'ci',
			'integration',
		])
		expect(policyForRepository('GuestGuru/tools')?.requiredNeeds).toEqual(['ci'])
		expect(policyForRepository('GuestGuru/irnok')?.requiredNeeds).toEqual([
			'web',
			'cloud-function',
		])
		expect(policyForRepository('GuestGuru/gg-ci')).toEqual({
			workflowPath: '.github/workflows/ci.yml',
			requiredNeeds: ['test'],
			uses: './.github/workflows/quality-gate.yml',
		})
	})

	it('accepts the exact canonical gate', () => {
		expect(
			validateWorkflowPolicy(
				'GuestGuru/gg-sales',
				validSalesWorkflow,
				salesInventory,
			),
		).toEqual([])
	})

	it('rejects missing mandatory dependencies', () => {
		const workflow = validSalesWorkflow.replace('needs: [ci]', 'needs: []')

		expect(validateWorkflowPolicy('GuestGuru/gg-sales', workflow, salesInventory)).toContain(
			'quality-gate.needs must be exactly [ci]',
		)
	})

	it('rejects a leftover deployment-gate job (merged into quality-gate, IT-295)', () => {
		const withLeftover =
			validSalesWorkflow +
			`  deployment-gate:
    name: deployment-gate
    if: \${{ always() }}
    needs: [ci]
    uses: GuestGuru/gg-ci/.github/workflows/quality-gate.yml@main
    with:
      needs-json: \${{ toJSON(needs) }}
      status-context: GG deployment gate
`

		expect(
			validateWorkflowPolicy('GuestGuru/gg-sales', withLeftover, salesInventory),
		).toContain(
			'deployment-gate job must be removed — quality-gate publishes the GG deployment gate status (IT-295)',
		)
	})

	it('requires the quality gate to publish the dedicated Vercel status', () => {
		const missing = validSalesWorkflow.replace(
			'\n      status-context: GG deployment gate',
			'',
		)
		const changed = validSalesWorkflow.replace(
			'status-context: GG deployment gate',
			'status-context: quality-gate / verify',
		)

		expect(
			validateWorkflowPolicy('GuestGuru/gg-sales', missing, salesInventory),
		).toContain(
			'quality-gate.with.status-context must be exactly GG deployment gate',
		)
		expect(
			validateWorkflowPolicy('GuestGuru/gg-sales', changed, salesInventory),
		).toContain(
			'quality-gate.with.status-context must be exactly GG deployment gate',
		)
	})

	it('rejects dependencies added to fabricate the gate input', () => {
		const workflow = validSalesWorkflow.replace('needs: [ci]', 'needs: [ci, optional]')

		expect(validateWorkflowPolicy('GuestGuru/gg-sales', workflow, salesInventory)).toContain(
			'quality-gate.needs must be exactly [ci]',
		)
	})

	it('rejects mutable or non-central reusable workflow references', () => {
		const workflow = validSalesWorkflow.replace(
			'quality-gate.yml@main',
			'quality-gate.yml@codex/it-244-gg-ci-upgrade',
		)

		expect(validateWorkflowPolicy('GuestGuru/gg-sales', workflow, salesInventory)).toContain(
			'quality-gate.uses must be GuestGuru/gg-ci/.github/workflows/quality-gate.yml@main',
		)
	})

	it('rejects a condition or input that can bypass the real needs context', () => {
		const workflow = validSalesWorkflow
			.replace('if: ${{ always() }}', 'if: ${{ success() }}')
			.replace('needs-json: ${{ toJSON(needs) }}', "needs-json: '{}'")

		expect(validateWorkflowPolicy('GuestGuru/gg-sales', workflow, salesInventory)).toEqual(
			expect.arrayContaining([
				'quality-gate.if must be exactly ${{ always() }}',
				'quality-gate.with.needs-json must be exactly ${{ toJSON(needs) }}',
			]),
		)
	})

	it('fails closed for unknown repositories and malformed workflows', () => {
		expect(
			validateWorkflowPolicy('GuestGuru/unknown', validSalesWorkflow, {}),
		).toContain('No workflow policy is configured for GuestGuru/unknown')
		expect(
			validateWorkflowPolicy('GuestGuru/gg-sales', 'jobs: [', salesInventory),
		).toContain('Workflow YAML is invalid')
	})

	it('rejects changed, added, or removed workflow files', () => {
		const changed = {
			...salesInventory,
			'.github/workflows/ci.yml': hashWorkflow('jobs: { ci: { steps: [] } }'),
		}
		const added = {
			...salesInventory,
			'.github/workflows/spoof.yml': hashWorkflow('name: quality-gate / verify'),
		}
		const missing = { ...salesInventory }
		delete missing['.github/workflows/preview-alias.yml']

		expect(
			validateWorkflowPolicy('GuestGuru/gg-sales', validSalesWorkflow, changed),
		).toContain('Workflow content is not approved: .github/workflows/ci.yml')
		expect(
			validateWorkflowPolicy('GuestGuru/gg-sales', validSalesWorkflow, added),
		).toContain('Unexpected workflow file: .github/workflows/spoof.yml')
		expect(
			validateWorkflowPolicy('GuestGuru/gg-sales', validSalesWorkflow, missing),
		).toContain('Required workflow file is missing: .github/workflows/preview-alias.yml')
	})

	it('uses stable SHA-256 workflow hashes', () => {
		expect(hashWorkflow('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		)
	})

	describe('central trust (gg-ci self-check)', () => {
		const ggciWorkflow = `
jobs:
  test: {}
  quality-gate:
    name: quality-gate
    if: \${{ always() }}
    needs: [test]
    uses: ./.github/workflows/quality-gate.yml
    with:
      needs-json: \${{ toJSON(needs) }}
`
		const ggciInventory = workflowInventoryForRepository('GuestGuru/gg-ci') ?? {}

		// A realistic manifest never lists itself; drop the programmatic self entry.
		const manifest = { ...centralTrustInventory() }
		delete manifest['src/trust-inventory.json']

		const validate = (evidence: {
			manifest: Record<string, string>
			actual: Record<string, string>
		}) =>
			validateWorkflowPolicy(
				'GuestGuru/gg-ci',
				ggciWorkflow,
				ggciInventory,
				evidence,
			)

		it('accepts a self-consistent manifest — every declared file matches', () => {
			// Files hash to exactly what the manifest declares.
			expect(validate({ manifest, actual: { ...manifest } })).toEqual([])
		})

		it('rejects a status-context on the gg-ci gate — gg-ci deploys nothing', () => {
			const withContext = ggciWorkflow.replace(
				'needs-json: ${{ toJSON(needs) }}',
				'needs-json: ${{ toJSON(needs) }}\n      status-context: GG deployment gate',
			)
			expect(
				validateWorkflowPolicy(
					'GuestGuru/gg-ci',
					withContext,
					ggciInventory,
					{ manifest, actual: { ...manifest } },
				),
			).toContain('quality-gate.with.status-context must be omitted')
		})

		it('accepts a declared change to a trusted file (updated hash in the manifest)', () => {
			// A trusted file changed AND its hash was updated in the manifest: the
			// manifest and the files still agree, so the change is allowed. This is
			// the case the old baked-in comparison deadlocked.
			const newHash = hashWorkflow('export const pass = true')
			const updatedManifest = { ...manifest, 'src/quality-gate.ts': newHash }
			expect(
				validate({
					manifest: updatedManifest,
					actual: { ...updatedManifest },
				}),
			).toEqual([])
		})

		it('rejects an undeclared change — file hash drifts from the manifest', () => {
			const actual = {
				...manifest,
				'src/quality-gate.ts': hashWorkflow('export const pass = true'),
			}
			expect(validate({ manifest, actual })).toContain(
				'Central trust file is not approved: src/quality-gate.ts',
			)
		})

		it('rejects dropping a pinned trusted file from the manifest', () => {
			const shrunk = { ...manifest }
			delete shrunk['src/workflow-policy.ts']
			expect(validate({ manifest: shrunk, actual: { ...shrunk } })).toContain(
				'Central trust file must stay in the manifest: src/workflow-policy.ts',
			)
		})

		it('rejects a declared file that is absent from the tree', () => {
			const actual = { ...manifest }
			delete actual['src/quality-gate.ts']
			expect(validate({ manifest, actual })).toContain(
				'Central trust file is missing: src/quality-gate.ts',
			)
		})
	})
})

// IT-594. A policy-gate-et az org-ruleset egy IMMUTABLE gg-ci sha-ra pinneli, és
// a workflow ebből a commitból veszi a teljes policy-implementációt — a
// jóváhagyott hasheket is. Ha egy hash már a mainen van, de a pin még a korábbi
// commiton áll, a CÉL-repo azt látja, hogy „Workflow content is not approved",
// miközben a tartalom jóvá VAN hagyva. A tünet a cél-repóban van, az ok a
// gg-ci-ben; a rerun sem segít (a `ref: job.workflow_sha` a régi sha-t örökli).
describe('policy source diagnostics (IT-594)', () => {
	const pinned = 'eda86e0f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60'
	const main = '1690247a611b8679cbbe05d86c4114cbf55f1d5e'
	const workflowRef =
		'GuestGuru/gg-ci/.github/workflows/policy-gate.yml@refs/heads/main'

	describe('resolvePolicySource', () => {
		it('names the commit the trusted checkout actually runs from', () => {
			// A checkout HEAD-je a hiteles válasz a „melyik commitból fut" kérdésre:
			// a workflow `ref: job.workflow_sha`-val hozza le a policyt.
			expect(
				resolvePolicySource(
					{ GITHUB_WORKFLOW_REF: workflowRef, GITHUB_WORKFLOW_SHA: main },
					() => pinned,
				),
			).toEqual({ repository: 'GuestGuru/gg-ci', sha: pinned })
		})

		it('falls back to GITHUB_WORKFLOW_SHA when the checkout HEAD is unreadable', () => {
			expect(
				resolvePolicySource(
					{ GITHUB_WORKFLOW_REF: workflowRef, GITHUB_WORKFLOW_SHA: main },
					() => undefined,
				),
			).toEqual({ repository: 'GuestGuru/gg-ci', sha: main })
		})

		it('ignores a workflow ref that is not owner/repo/path', () => {
			expect(
				resolvePolicySource({ GITHUB_WORKFLOW_REF: 'nonsense' }, () => pinned)
					.repository,
			).toBeUndefined()
		})
	})

	describe('policySourceLine', () => {
		it('names the repository and commit the policy ran from', () => {
			expect(policySourceLine({ repository: 'GuestGuru/gg-ci', sha: pinned })).toContain(
				`GuestGuru/gg-ci@${pinned}`,
			)
		})

		it('says so instead of guessing when the source commit is unknown', () => {
			expect(policySourceLine({})).toMatch(/unknown/i)
		})
	})

	describe('stalePinDiagnosis', () => {
		it('points at the stale ruleset pin when the policy is not running from main', () => {
			const lines = stalePinDiagnosis(
				{ repository: 'GuestGuru/gg-ci', sha: pinned },
				main,
			).join('\n')
			expect(lines).toContain(main)
			expect(lines).toMatch(/re-pin/i)
			expect(lines).toMatch(/close\/reopen/i)
		})

		it('rules the stale pin out when the pin already matches main', () => {
			const lines = stalePinDiagnosis(
				{ repository: 'GuestGuru/gg-ci', sha: pinned },
				pinned,
			).join('\n')
			expect(lines).toMatch(/up to date/i)
			expect(lines).not.toMatch(/re-pin/i)
		})

		it('still names the stale pin when the policy commit itself is unknown', () => {
			const lines = stalePinDiagnosis({ repository: 'GuestGuru/gg-ci' }, main).join(
				'\n',
			)
			expect(lines).toMatch(/unknown/i)
			expect(lines).toMatch(/re-pin/i)
		})

		it('stays honest when main cannot be read', () => {
			const lines = stalePinDiagnosis(
				{ repository: 'GuestGuru/gg-ci', sha: pinned },
				undefined,
			).join('\n')
			expect(lines).toMatch(/could not/i)
			expect(lines).toMatch(/stale/i)
		})
	})

	describe('run', () => {
		it('prints the stale-pin diagnosis after the policy errors', () => {
			const root = mkdtempSync(join(tmpdir(), 'gg-ci-policy-'))
			mkdirSync(join(root, '.github/workflows'), { recursive: true })
			writeFileSync(join(root, '.github/workflows/ci.yml'), 'jobs: {}\n')
			const errors: string[] = []
			const spy = vi
				.spyOn(console, 'error')
				.mockImplementation((message) => void errors.push(String(message)))
			let code: number
			try {
				code = run(
					[root],
					{
						GITHUB_REPOSITORY: 'GuestGuru/gg-sales',
						GITHUB_WORKFLOW_REF: workflowRef,
					},
					{ readCheckoutSha: () => pinned, readMainSha: () => main },
				)
			} finally {
				spy.mockRestore()
				rmSync(root, { recursive: true, force: true })
			}

			const output = errors.join('\n')
			expect(code).toBe(1)
			expect(output).toContain('Workflow must define a quality-gate job')
			expect(output).toContain(pinned)
			expect(output).toMatch(/re-pin/i)
		})

		it('names the policy source on the success path, without querying main', () => {
			// Ez a gg-ci SAJÁT fáján fut: ha pirosra vált, a legvalószínűbb ok, hogy
			// egy central fájl változott, de a `src/trust-inventory.json` önhashe
			// nem lett frissítve — pontosan az a hiba, amit a CI-ban a policy-gate
			// dobna, csak itt már a `npm test` megmondja.
			const logs: string[] = []
			const spy = vi
				.spyOn(console, 'log')
				.mockImplementation((message) => void logs.push(String(message)))
			let code: number
			try {
				code = run(
					[process.cwd()],
					{
						GITHUB_REPOSITORY: 'GuestGuru/gg-ci',
						GITHUB_WORKFLOW_REF: workflowRef,
					},
					{
						readCheckoutSha: () => pinned,
						readMainSha: () => {
							throw new Error('main must not be queried on the success path')
						},
					},
				)
			} finally {
				spy.mockRestore()
			}

			expect(code).toBe(0)
			expect(logs.join('\n')).toContain(pinned)
		})
	})
})
