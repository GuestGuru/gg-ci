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
		requiredNeeds: ['registry', 'forras', 'meresek'],
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
	'GuestGuru/gg-tracker': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['build'],
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
			'3fc6c8a4df55f972e91821f511e3716d78d9517cf4da28d5e37cec6d0e504001',
		'.github/workflows/neon-preview.yml':
			'f259b356c74c2f89a7d70206dbb2eb6b36fa79c0bf841d6b735e56c01309e7d2',
		'.github/workflows/policy-gate.yml':
			'e5e19e5e68c2ed229f391c148f5f8c3676f494106e2c1c6bc85ba6241bf51972',
		'.github/workflows/preview-alias.yml':
			'b1028f339db194a7211a3838bd6e3748d7e690009c108bd8227c02cbce87c61e',
		'.github/workflows/preview.yml':
			'ad03f5ff525c4b65f30befb34f4da345697582646e81ad6155a013c8ae8682b9',
		'.github/workflows/quality-gate.yml':
			'320459bacf57f314cc2ebaf10f90570b403224a43d1c440d6175149199abbcd7',
	},
	'GuestGuru/gg-sales': {
		'.github/workflows/ci.yml':
			'1f32c1a2cfdf71872d0d634d69e02f1a11086d95ff0fad948dba7a669d725767',
		'.github/workflows/preview-alias.yml':
			'29b1443821e140721ece0a369b7ca67503f2f9d8a6a7441988cce1a74c0ca85d',
	},
	'GuestGuru/gg-design': {
		'.github/workflows/registry.yml':
			'ba1df9639fb4e9ce3bbbabc2df225c9fef65bfaf6592be11d2226ee4d3551837',
	},
	'GuestGuru/BPDBv2': {
		'.github/workflows/ci.yml':
			'9a4b478b74fdee8de9193dc7590917d6bc81b1f5ca5a7328dd34c1504c88ba57',
		'.github/workflows/preview-alias.yml':
			'4dab7eb1b102af2f0807c4e888cf6f2cc4886c6e43fb5dcb47c4fbf90eeee24d',
		'.github/workflows/preview-db.yml':
			'59834e9e0f337cffe570cd58eaea22a8f17145d59c36692076e54135be5e4090',
	},
	'GuestGuru/gg-agents': {
		'.github/workflows/ci.yml':
			'8db35ede20d5e3b5587d6c23099c2da8d41a11253a5bd5c1405240e37e345a49',
		'.github/workflows/preview-alias.yml':
			'cd336cb295215b54ba08b80a210458483e6a9a1e84bbd3dc3999dd425ffada09',
	},
	'GuestGuru/tools': {
		'.github/workflows/ci.yml':
			'381e78653325913a817e3fb6cc63640d4a37a04baaa224839d6b9e80d07ce32b',
		'.github/workflows/preview-alias.yml':
			'44f35219ced1e6bf9dc82d99212de8694845133cd89c490fa46b244a5575d2c1',
		'.github/workflows/preview-db.yml':
			'a59d2f80f7730159cb884f62b76283b29cae7ff8243cc9786d54885227928b7b',
		'.github/workflows/publish-auth.yml':
			'7e6bc79345253c92b1454315d1530abe7a516e7ef895bdbdfc676e7cc057eedc',
		'.github/workflows/token-expiry.yml':
			'1195c868da3590b4dd0516c88b27919a0114f81374d0dae9ed63a9da5b73fb68',
	},
	'GuestGuru/irnok': {
		'.github/workflows/ci.yml':
			'd3e9aeb993a60bb766015df823d81e7435436066953e8557d5cb47fa36507b32',
		'.github/workflows/preview-alias.yml':
			'd5cbdc7f070ebd3db407a0284951bb5d4ec6e3c42613320f413f281e1805b7ce',
		'.github/workflows/preview-db.yml':
			'7e7ff939db4ef85f2bc29e0dfe677ba0ac61075e7a7de8460957bacc06e266c1',
	},
	'GuestGuru/gg-tracker': {
		'.github/workflows/ci.yml':
			'bf9be761721878954e25cb6fbb753a41bb8251923bf0134587c4e47ad68894c5',
		'.github/workflows/preview-alias.yml':
			'f7e8e38e6d80ffdecebc6b27740571f169d811bd5a49b73030d20aac57f27e56',
		'.github/workflows/preview-db.yml':
			'a87ea43503eff61918229acca1e73faec3fd6354e70c91fe4eb0080c9caf42d8',
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
	if (
		gateName === 'deployment-gate' &&
		inputs?.['status-context'] !== 'GG deployment gate'
	) {
		errors.push(
			'deployment-gate.with.status-context must be exactly GG deployment gate',
		)
	}
	if (
		gateName === 'quality-gate' &&
		inputs &&
		'status-context' in inputs
	) {
		errors.push('quality-gate.with.status-context must be omitted')
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

export function collectCentralTrustHashes(
	targetRoot: string,
	relativePaths: string[],
): Record<string, string> {
	const hashes: Record<string, string> = {}
	for (const relativePath of relativePaths) {
		try {
			hashes[relativePath] = hashWorkflow(
				readFileSync(join(targetRoot, relativePath), 'utf8'),
			)
		} catch {
			// Missing file: leave it out so validateCentralTrust reports it as
			// missing with a precise message instead of failing the whole run.
		}
	}
	return hashes
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

export type CentralTrustEvidence = {
	// The target repository's own src/trust-inventory.json, parsed.
	manifest: Record<string, string>
	// SHA-256 of the target's files for every path we need to check.
	actual: Record<string, string>
}

// Validates the gg-ci repository's own trusted sources.
//
// The comparison is deliberately SELF-CONSISTENT: the target's central files
// are checked against the target's OWN manifest (src/trust-inventory.json), not
// against the hashes baked into this trusted checker. Comparing to the baked-in
// hashes would deadlock every update to the trusted sources — including this
// policy file itself: the trusted checker runs from `main`, so any PR that
// changes a central file would never match `main`'s frozen hash and could never
// land through the required policy gate.
//
// What the check still guarantees:
//   1. Completeness — every path the trusted baseline pins must stay declared
//      in the manifest (a trusted file cannot be silently dropped from it).
//   2. Integrity — every file the manifest declares must exist and hash to its
//      declared value, so a changed central file is only accepted when the same
//      PR updates its hash in the manifest (visible in the diff).
//
// It intentionally does NOT decide whether such a change is *authorized* — that
// is governed by human review of the gg-ci PR, not by a hash comparison.
function validateCentralTrust(evidence: CentralTrustEvidence): string[] {
	const { manifest, actual } = evidence
	const errors: string[] = []

	// (1) The pinned trusted paths must remain declared in the manifest. The
	// manifest never lists itself, so skip the self entry.
	for (const path of Object.keys(approvedCentralTrustInventory).sort()) {
		if (path === 'src/trust-inventory.json') continue
		if (!(path in manifest)) {
			errors.push(`Central trust file must stay in the manifest: ${path}`)
		}
	}

	// (2) Every declared file must exist and match its declared hash.
	for (const path of Object.keys(manifest).sort()) {
		if (!(path in actual)) {
			errors.push(`Central trust file is missing: ${path}`)
		} else if (actual[path] !== manifest[path]) {
			errors.push(`Central trust file is not approved: ${path}`)
		}
	}

	return errors
}

export function validateWorkflowPolicy(
	repository: string,
	workflowYaml: string,
	actualInventory: Record<string, string>,
	centralTrust?: CentralTrustEvidence,
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
			? validateCentralTrust(centralTrust ?? { manifest: {}, actual: {} })
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
	let centralTrust: CentralTrustEvidence | undefined
	try {
		workflowYaml = readFileSync(join(targetRoot, policy.workflowPath), 'utf8')
		actualInventory = collectWorkflowInventory(targetRoot)
		if (repository === 'GuestGuru/gg-ci') {
			const manifestContent = readFileSync(
				join(targetRoot, 'src/trust-inventory.json'),
				'utf8',
			)
			const manifest = JSON.parse(manifestContent) as Record<string, string>
			// Hash both what the manifest declares and every pinned baseline path,
			// so a pinned file that the manifest fails to declare is still surfaced.
			const pathsToHash = Array.from(
				new Set([
					...Object.keys(manifest),
					...Object.keys(approvedCentralTrustInventory).filter(
						(path) => path !== 'src/trust-inventory.json',
					),
				]),
			)
			const actual = collectCentralTrustHashes(targetRoot, pathsToHash)
			centralTrust = { manifest, actual }
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
		centralTrust,
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
