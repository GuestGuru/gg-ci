import { describe, expect, it } from 'vitest'
import { policyForRepository, validateWorkflowPolicy, workflowInventoryForRepository } from '../src/workflow-policy.js'

const mainPushContext = "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 'GG deployment gate' || '' }}"
const workflow = `
jobs:
  ci:
    runs-on: [self-hosted, app-runner]
  quality-gate:
    name: quality-gate
    if: \${{ always() }}
    needs: [ci]
    uses: GuestGuru/gg-ci/.github/workflows/quality-gate.yml@main
    with:
      needs-json: \${{ toJSON(needs) }}
      status-context: ${mainPushContext}
`

describe('a gg-inbox production-status határa', () => {
  it('a main push feltételét pontosan pineli a policy', () => {
    expect(policyForRepository('GuestGuru/gg-inbox')).toEqual({
      workflowPath: '.github/workflows/ci.yml', requiredNeeds: ['ci'],
      uses: 'GuestGuru/gg-ci/.github/workflows/quality-gate.yml@main',
      statusContext: mainPushContext,
    })
  })
  it('elfogadja a main-only kontextust, és elutasítja a feltétel nélküli PR publikálást', () => {
    expect(validateWorkflowPolicy('GuestGuru/gg-inbox', workflow, workflowInventoryForRepository('GuestGuru/gg-inbox') ?? {})).toEqual([])
    expect(validateWorkflowPolicy('GuestGuru/gg-inbox', workflow.replace(mainPushContext, 'GG deployment gate'), workflowInventoryForRepository('GuestGuru/gg-inbox') ?? {})).not.toEqual([])
  })
})
