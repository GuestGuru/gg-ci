import { describe, expect, it } from 'vitest'
import {
	policyForRepository,
	validateWorkflowPolicy,
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
`

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
		expect(validateWorkflowPolicy('GuestGuru/gg-sales', validSalesWorkflow)).toEqual([])
	})

	it('rejects missing mandatory dependencies', () => {
		const workflow = validSalesWorkflow.replace('needs: [ci]', 'needs: []')

		expect(validateWorkflowPolicy('GuestGuru/gg-sales', workflow)).toContain(
			'quality-gate.needs must be exactly [ci]',
		)
	})

	it('rejects dependencies added to fabricate the gate input', () => {
		const workflow = validSalesWorkflow.replace('needs: [ci]', 'needs: [ci, optional]')

		expect(validateWorkflowPolicy('GuestGuru/gg-sales', workflow)).toContain(
			'quality-gate.needs must be exactly [ci]',
		)
	})

	it('rejects mutable or non-central reusable workflow references', () => {
		const workflow = validSalesWorkflow.replace(
			'quality-gate.yml@main',
			'quality-gate.yml@codex/it-244-gg-ci-upgrade',
		)

		expect(validateWorkflowPolicy('GuestGuru/gg-sales', workflow)).toContain(
			'quality-gate.uses must be GuestGuru/gg-ci/.github/workflows/quality-gate.yml@main',
		)
	})

	it('rejects a condition or input that can bypass the real needs context', () => {
		const workflow = validSalesWorkflow
			.replace('if: ${{ always() }}', 'if: ${{ success() }}')
			.replace('needs-json: ${{ toJSON(needs) }}', "needs-json: '{}'")

		expect(validateWorkflowPolicy('GuestGuru/gg-sales', workflow)).toEqual(
			expect.arrayContaining([
				'quality-gate.if must be exactly ${{ always() }}',
				'quality-gate.with.needs-json must be exactly ${{ toJSON(needs) }}',
			]),
		)
	})

	it('fails closed for unknown repositories and malformed workflows', () => {
		expect(validateWorkflowPolicy('GuestGuru/unknown', validSalesWorkflow)).toContain(
			'No workflow policy is configured for GuestGuru/unknown',
		)
		expect(validateWorkflowPolicy('GuestGuru/gg-sales', 'jobs: [')).toContain(
			'Workflow YAML is invalid',
		)
	})
})
