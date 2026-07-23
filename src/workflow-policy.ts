import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

export type WorkflowPolicy = {
	workflowPath: string
	requiredNeeds: string[]
	uses: string
}

const centralGate =
	'GuestGuru/gg-ci/.github/workflows/quality-gate.yml@main'

const policies: Record<string, WorkflowPolicy> = {
	'GuestGuru/gg-sales': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['ci'],
		uses: centralGate,
	},
	'GuestGuru/gg-design': {
		workflowPath: '.github/workflows/registry.yml',
		requiredNeeds: ['registry', 'meresek'],
		uses: centralGate,
	},
	'GuestGuru/BPDBv2': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['web', 'pipeline'],
		uses: centralGate,
	},
	'GuestGuru/gg-agents': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['ci', 'integration'],
		uses: centralGate,
	},
	'GuestGuru/tools': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['ci'],
		uses: centralGate,
	},
	'GuestGuru/irnok': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['web', 'cloud-function'],
		uses: centralGate,
	},
	'GuestGuru/gg-ci': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['test'],
		uses: './.github/workflows/quality-gate.yml',
	},
}

const approvedWorkflowInventories: Record<string, Record<string, string>> = {
	'GuestGuru/gg-ci': {
		'.github/workflows/ci.yml':
			'745d5ce278a56ab3804272f4185a0b6d68e185878c1f6c4ea34fae2bdd92f0e3',
		'.github/workflows/neon-preview.yml':
			'e45940c86f1932f5b75d0e9b92849a52994bb1503495ce336f0d1a7625abf37a',
		'.github/workflows/policy-gate.yml':
			'797743c577ca6aa00d87ec1413c0ebec3296ccb2f5abef5ac1db2a14c5c0c0fa',
		'.github/workflows/preview-alias.yml':
			'ca031300070019570033a99aa51598163a63813a341ff7c57f7771d190adabf6',
		'.github/workflows/quality-gate.yml':
			'3d5c1c79dcca5d52c8c4293cb02a983980217b21418251dd27df879277013b31',
	},
	'GuestGuru/gg-sales': {
		'.github/workflows/ci.yml':
			'0b5eecc6a4d08af4c92a8704a79a21dbf4cb6188fbd406a2b32901f5b6257576',
		'.github/workflows/preview-alias.yml':
			'08dca5ce6939e333e8ffea8e407141772145913f764a7a981344ed7515926182',
	},
	'GuestGuru/gg-design': {
		'.github/workflows/registry.yml':
			'1556676da86d42ddd443730cba6c2968f362661e9e1038fc187d1649cac3d6a3',
	},
	'GuestGuru/BPDBv2': {
		'.github/workflows/ci.yml':
			'a99896dcdd91bec9c98cd42870bde320345402dd47c5929b96935ec1de9e8d96',
		'.github/workflows/preview-alias.yml':
			'524d91905016436425ec88234f7a3d15bbdabce1a822aa6d392673a64a07443b',
		'.github/workflows/preview-db.yml':
			'e1f418c270c500b04f04e8383d1bcc5faf2b6a6b006b7a86890ca731031e1b18',
	},
	'GuestGuru/gg-agents': {
		'.github/workflows/ci.yml':
			'06d7c1b042438b84168e0cc4f1d9b99d01812df571623c1e42378e53cef14231',
		'.github/workflows/preview-alias.yml':
			'5f0cfd51456130a1ecb6951065c78a9ce4820750cd635b41d390fbb63e3aa88a',
	},
	'GuestGuru/tools': {
		'.github/workflows/ci.yml':
			'e8adc8482ea990fd1161d8b58d5a94c294c65884508d34d226852610c6d445f4',
		'.github/workflows/preview-alias.yml':
			'fdb04ab9bb5073b6547e02fde430442f58d31af9d584823f684f56af45c5a9a0',
		'.github/workflows/preview-db.yml':
			'fcac26e8cf681b44a87debe0a126297ddb0082f134c3bb82a241310edc145f74',
		'.github/workflows/token-expiry.yml':
			'363c7b015d1a2bb4d8284e038e57b281b299f04e1fde12007eb87a0eef10b140',
	},
	'GuestGuru/irnok': {
		'.github/workflows/ci.yml':
			'6fa57e2db9447c3689733c0c044872155fa25dbb58318c55b71e6956d470c298',
		'.github/workflows/preview-alias.yml':
			'75ce44abc0f143b24aae722b50f90bec6affee473b9089b6613386854a61d3ef',
	},
}

const centralTrustManifestContent = readFileSync(
	new URL('./trust-inventory.json', import.meta.url),
	'utf8',
)
const approvedCentralTrustInventory: Record<string, string> = {
	...(JSON.parse(centralTrustManifestContent) as Record<string, string>),
	'src/trust-inventory.json': hashWorkflow(centralTrustManifestContent),
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	return value as UnknownRecord
}

function validateGate(
	jobs: UnknownRecord | undefined,
	gateName: 'quality-gate' | 'deployment-gate',
	policy: WorkflowPolicy,
): string[] {
	const gate = asRecord(jobs?.[gateName])
	if (!gate) return [`Workflow must define a ${gateName} job`]

	const errors: string[] = []
	if (gate.name !== gateName) {
		errors.push(`${gateName}.name must be exactly ${gateName}`)
	}
	if (gate.if !== '${{ always() }}') {
		errors.push(`${gateName}.if must be exactly \${{ always() }}`)
	}
	if (
		!Array.isArray(gate.needs) ||
		gate.needs.length !== policy.requiredNeeds.length ||
		gate.needs.some((need, index) => need !== policy.requiredNeeds[index])
	) {
		errors.push(
			`${gateName}.needs must be exactly [${policy.requiredNeeds.join(', ')}]`,
		)
	}
	if (gate.uses !== policy.uses) {
		errors.push(`${gateName}.uses must be ${policy.uses}`)
	}

	const inputs = asRecord(gate.with)
	if (inputs?.['needs-json'] !== '${{ toJSON(needs) }}') {
		errors.push(
			`${gateName}.with.needs-json must be exactly \${{ toJSON(needs) }}`,
		)
	}
	return errors
}

export function policyForRepository(repository: string): WorkflowPolicy | undefined {
	return policies[repository]
}

export function hashWorkflow(content: string): string {
	return createHash('sha256').update(content).digest('hex')
}

export function workflowInventoryForRepository(
	repository: string,
): Record<string, string> | undefined {
	return approvedWorkflowInventories[repository]
}

export function centralTrustInventory(): Record<string, string> {
	return approvedCentralTrustInventory
}

export function collectCentralTrustInventory(
	targetRoot: string,
): Record<string, string> {
	return Object.fromEntries(
		Object.keys(approvedCentralTrustInventory).map((relativePath) => [
			relativePath,
			hashWorkflow(readFileSync(join(targetRoot, relativePath), 'utf8')),
		]),
	)
}

export function collectWorkflowInventory(
	targetRoot: string,
): Record<string, string> {
	const workflowDirectory = join(targetRoot, '.github/workflows')
	return Object.fromEntries(
		readdirSync(workflowDirectory, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => {
				const relativePath = `.github/workflows/${entry.name}`
				return [
					relativePath,
					hashWorkflow(readFileSync(join(targetRoot, relativePath), 'utf8')),
				]
			}),
	)
}

function validateWorkflowInventory(
	expected: Record<string, string>,
	actual: Record<string, string>,
): string[] {
	const errors: string[] = []
	for (const path of Object.keys(expected).sort()) {
		if (!(path in actual)) {
			errors.push(`Required workflow file is missing: ${path}`)
		} else if (actual[path] !== expected[path]) {
			errors.push(`Workflow content is not approved: ${path}`)
		}
	}
	for (const path of Object.keys(actual).sort()) {
		if (!(path in expected)) errors.push(`Unexpected workflow file: ${path}`)
	}
	return errors
}

function validateCentralTrustInventory(
	actual: Record<string, string>,
): string[] {
	const errors: string[] = []
	for (const path of Object.keys(approvedCentralTrustInventory).sort()) {
		if (!(path in actual)) {
			errors.push(`Central trust file is missing: ${path}`)
		} else if (actual[path] !== approvedCentralTrustInventory[path]) {
			errors.push(`Central trust file is not approved: ${path}`)
		}
	}
	return errors
}

export function validateWorkflowPolicy(
	repository: string,
	workflowYaml: string,
	actualInventory: Record<string, string>,
	actualCentralTrustInventory?: Record<string, string>,
): string[] {
	const policy = policyForRepository(repository)
	if (!policy) return [`No workflow policy is configured for ${repository}`]
	const expectedInventory = workflowInventoryForRepository(repository)
	if (!expectedInventory) {
		return [`No workflow inventory is configured for ${repository}`]
	}

	let workflow: unknown
	try {
		workflow = parse(workflowYaml)
	} catch {
		return ['Workflow YAML is invalid']
	}

	const jobs = asRecord(asRecord(workflow)?.jobs)
	const errors = validateGate(jobs, 'quality-gate', policy)
	if (repository !== 'GuestGuru/gg-ci') {
		errors.push(...validateGate(jobs, 'deployment-gate', policy))
	}

	const centralErrors =
		repository === 'GuestGuru/gg-ci'
			? validateCentralTrustInventory(actualCentralTrustInventory ?? {})
			: []

	return [
		...errors,
		...validateWorkflowInventory(expectedInventory, actualInventory),
		...centralErrors,
	]
}

export function run(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
	const repository = env.GITHUB_REPOSITORY ?? ''
	const policy = policyForRepository(repository)
	if (!policy) {
		console.error(`workflow-policy: no policy configured for ${repository || '(missing repository)'}`)
		return 1
	}

	const targetRoot = argv[0] ?? '.'
	let workflowYaml: string
	let actualInventory: Record<string, string>
	let actualCentralTrustInventory: Record<string, string> | undefined
	try {
		workflowYaml = readFileSync(join(targetRoot, policy.workflowPath), 'utf8')
		actualInventory = collectWorkflowInventory(targetRoot)
		if (repository === 'GuestGuru/gg-ci') {
			actualCentralTrustInventory = collectCentralTrustInventory(targetRoot)
		}
	} catch {
		console.error(
			`workflow-policy: cannot read ${policy.workflowPath} or workflow inventory`,
		)
		return 1
	}

	const errors = validateWorkflowPolicy(
		repository,
		workflowYaml,
		actualInventory,
		actualCentralTrustInventory,
	)
	if (errors.length === 0) {
		console.log(`workflow-policy: ${repository} uses the canonical quality gate`)
		return 0
	}

	for (const error of errors) console.error(`workflow-policy: ${error}`)
	return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = run(process.argv.slice(2))
}
