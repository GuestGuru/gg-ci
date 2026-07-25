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
			'0b9fa5ed529156ada2cdd7d15d3d726d25e62b632ac768ad402cd806381caeb2',
		'.github/workflows/neon-preview.yml':
			'0381be4d6510f4e596188b30fe891ef107ab945463377ec7e56c56468b88c353',
		'.github/workflows/policy-gate.yml':
			'e5e19e5e68c2ed229f391c148f5f8c3676f494106e2c1c6bc85ba6241bf51972',
		'.github/workflows/preview-alias.yml':
			'32bff2300d444bfde9c44ddf0b2483e0d371c1bdf782a35a100ba50eeab11d6f',
		'.github/workflows/preview.yml':
			'b6da564fa19f8d32ad98be45561a3f423ba7cd56b0d45fbd8d587e75fd85fd27',
		'.github/workflows/quality-gate.yml':
			'320459bacf57f314cc2ebaf10f90570b403224a43d1c440d6175149199abbcd7',
	},
	'GuestGuru/gg-sales': {
		'.github/workflows/ci.yml':
			'6a71d52a1597762221e09e0c51598a3f5819127c80e2bde081166bea630ae61e',
		'.github/workflows/preview-alias.yml':
			'29b1443821e140721ece0a369b7ca67503f2f9d8a6a7441988cce1a74c0ca85d',
	},
	'GuestGuru/gg-design': {
		'.github/workflows/registry.yml':
			'd0a03801195fe3bdfdf9a50ecaf6f1a3553e5ac4b30a9132514920a701cf5153',
	},
	'GuestGuru/BPDBv2': {
		'.github/workflows/ci.yml':
			'004bf9e7481463a20c886f202f912ba0ed4e7bddc1b2a46a05a180d1901d90ff',
		'.github/workflows/preview-alias.yml':
			'4dab7eb1b102af2f0807c4e888cf6f2cc4886c6e43fb5dcb47c4fbf90eeee24d',
		'.github/workflows/preview-db.yml':
			'59834e9e0f337cffe570cd58eaea22a8f17145d59c36692076e54135be5e4090',
	},
	'GuestGuru/gg-agents': {
		'.github/workflows/ci.yml':
			'89f72fef65ff461b80cb2a67c5b9f7a2343409dd47fe43aad83c5dfba6a00197',
		'.github/workflows/preview-alias.yml':
			'6300f44c1412c19c38d139df6c15da72e2936da426457c110222e797529045a4',
	},
	'GuestGuru/tools': {
		'.github/workflows/ci.yml':
			'fbb66b12181b2c3d5e14b3a8c98f39c194cc101778899094b0d4315cbb7ff9ad',
		'.github/workflows/preview-alias.yml':
			'67194fb6ff02a566e4c073aa29aa874ad9251dd9344c8c4473e9d22e93027bb3',
		'.github/workflows/preview-db.yml':
			'a59d2f80f7730159cb884f62b76283b29cae7ff8243cc9786d54885227928b7b',
		'.github/workflows/publish-auth.yml':
			'cd47f472cc1bd29fb1622a07de6e7e3d5431470b86b79d547066bc1f44c86b0e',
		'.github/workflows/token-expiry.yml':
			'1a51b0cbda1a520dbdaed0f1cbf56dde1508412bf3a4c694542cc9dd2cd88731',
	},
	'GuestGuru/irnok': {
		'.github/workflows/ci.yml':
			'ba07145cb977be1427a8e7680fb9aab8fd3373b38cb64ba9d2c0697d99920453',
		'.github/workflows/preview-alias.yml':
			'd5cbdc7f070ebd3db407a0284951bb5d4ec6e3c42613320f413f281e1805b7ce',
		'.github/workflows/preview-db.yml':
			'7e7ff939db4ef85f2bc29e0dfe677ba0ac61075e7a7de8460957bacc06e266c1',
	},
	'GuestGuru/gg-tracker': {
		'.github/workflows/ci.yml':
			'd68d2ab2f7da18f86807bebe6d5518938d66db87eefcaf1a054df3dbe5646b54',
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
