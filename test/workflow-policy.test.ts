import { describe, expect, it } from 'vitest'
import {
	centralTrustInventory,
	hashWorkflow,
	policyForRepository,
	validateWorkflowPolicy,
	workflowInventoryForRepository,
} from '../src/workflow-policy.js'

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
  deployment-gate:
    name: deployment-gate
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
		})
		expect(policyForRepository('GuestGuru/gg-design')?.requiredNeeds).toEqual([
			'registry',
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

	it('requires a distinct Vercel deployment gate with the same dependencies', () => {
		const missing = validSalesWorkflow.replace(
			/  deployment-gate:[\s\S]*$/,
			'',
		)
		const weakened = validSalesWorkflow.replace(
			'  deployment-gate:\n    name: deployment-gate\n    if: ${{ always() }}\n    needs: [ci]',
			'  deployment-gate:\n    name: deployment-gate\n    if: ${{ success() }}\n    needs: []',
		)

		expect(
			validateWorkflowPolicy('GuestGuru/gg-sales', missing, salesInventory),
		).toContain('Workflow must define a deployment-gate job')
		expect(
			validateWorkflowPolicy('GuestGuru/gg-sales', weakened, salesInventory),
		).toEqual(
			expect.arrayContaining([
				'deployment-gate.if must be exactly ${{ always() }}',
				'deployment-gate.needs must be exactly [ci]',
			]),
		)
	})

	it('requires the deployment gate to publish the dedicated Vercel status', () => {
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
			'deployment-gate.with.status-context must be exactly GG deployment gate',
		)
		expect(
			validateWorkflowPolicy('GuestGuru/gg-sales', changed, salesInventory),
		).toContain(
			'deployment-gate.with.status-context must be exactly GG deployment gate',
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

	it('rejects changes to the central trust implementation', () => {
		const workflow = `
jobs:
  test: {}
  quality-gate:
    if: \${{ always() }}
    needs: [test]
    uses: ./.github/workflows/quality-gate.yml
    with:
      needs-json: \${{ toJSON(needs) }}
`
		const changedTrust = {
			...centralTrustInventory(),
			'src/quality-gate.ts': hashWorkflow('export const pass = true'),
		}

		expect(
			validateWorkflowPolicy(
				'GuestGuru/gg-ci',
				workflow,
				workflowInventoryForRepository('GuestGuru/gg-ci') ?? {},
				changedTrust,
			),
		).toContain('Central trust file is not approved: src/quality-gate.ts')

		const changedManifest = {
			...centralTrustInventory(),
			'src/trust-inventory.json': hashWorkflow('{"poisoned":true}'),
		}
		expect(
			validateWorkflowPolicy(
				'GuestGuru/gg-ci',
				workflow,
				workflowInventoryForRepository('GuestGuru/gg-ci') ?? {},
				changedManifest,
			),
		).toContain('Central trust file is not approved: src/trust-inventory.json')
	})
})
