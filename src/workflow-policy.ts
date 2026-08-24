import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

export type WorkflowPolicy = {
	workflowPath: string
	requiredNeeds: string[]
	uses: string
	// The commit status the single quality-gate call must publish (IT-295).
	// Absent for gg-ci, which deploys nothing. Before IT-295 a separate
	// deployment-gate job ran the SAME evaluation on a second VM just to
	// publish this status — with per-job minute-rounded billing that was one
	// wasted minute on every CI run in every repository.
	statusContext?: string
}

const centralGate =
	'GuestGuru/gg-ci/.github/workflows/quality-gate.yml@main'

const policies: Record<string, WorkflowPolicy> = {
	'GuestGuru/gg-sales': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['ci'],
		uses: centralGate,
		statusContext: 'GG deployment gate',
	},
	'GuestGuru/gg-design': {
		workflowPath: '.github/workflows/registry.yml',
		requiredNeeds: ['registry', 'forras', 'meresek'],
		uses: centralGate,
		statusContext: 'GG deployment gate',
	},
	'GuestGuru/BPDBv2': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['web', 'pipeline'],
		uses: centralGate,
		statusContext: 'GG deployment gate',
	},
	'GuestGuru/gg-agents': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['ci', 'integration'],
		uses: centralGate,
		statusContext: 'GG deployment gate',
	},
	'GuestGuru/tools': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['ci'],
		uses: centralGate,
		statusContext: 'GG deployment gate',
	},
	'GuestGuru/irnok': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['web', 'cloud-function'],
		uses: centralGate,
		statusContext: 'GG deployment gate',
	},
	'GuestGuru/gg-tracker': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['build'],
		uses: centralGate,
		statusContext: 'GG deployment gate',
	},
	'GuestGuru/gg-ci': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['test'],
		uses: './.github/workflows/quality-gate.yml',
	},
	// A gg-mcp NEM Vercel-projekt (systemd a marveenen), tehát a szabványból csak
	// a merge-kapu értelmezhető rá — a `GG deployment gate` status-contextet mégis
	// megtartja, mert az org-ruleset ezt a nevet követeli.
	'GuestGuru/gg-mcp': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['ci'],
		uses: centralGate,
		statusContext: 'GG deployment gate',
	},
	// gg-share — védett statikus oldalak megosztása (share.guest.guru).
	'GuestGuru/gg-share': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['ci'],
		uses: centralGate,
		statusContext: 'GG deployment gate',
	},
}

const approvedWorkflowInventories: Record<string, Record<string, string>> = {
	'GuestGuru/gg-share': {
		'.github/workflows/ci.yml':
			'e893eb18cacc5ad0be6b698776c0c3bc791990b212b9f240cb5be75b3d3628b5',
		'.github/workflows/preview-alias.yml':
			'af99ad81dc6b82f7e9bc6439191e76f054edf5ddccbc5e56309284fe278e730d',
		'.github/workflows/preview-db.yml':
			'ef72e4279f6f2cfdf4ce7a34ad46900860adc6c76ad217afe7ae8b06aa352ad0',
	},
	'GuestGuru/gg-mcp': {
		'.github/workflows/ci.yml':
			'f29487cb7c9219bcfcd8aac0bab6b8b08e08770a1b1b325718c66f022f11e1f7',
	},
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
			'72335f79b96f7f76a49d59807266889c8f90c1c98b9e64933151af7d8f2e120b',
		'.github/workflows/quality-gate.yml':
			'7c2034e1d46ebcf6f3e80a5cffd5dd68f4f274803ecc301b94354721017bc160',
	},
	'GuestGuru/gg-sales': {
		'.github/workflows/ci.yml':
			'15f199bf5bc56dbf8966f10f521b9e47de563e7f478b4772b387ca601b4f2d97',
		'.github/workflows/preview-alias.yml':
			'29b1443821e140721ece0a369b7ca67503f2f9d8a6a7441988cce1a74c0ca85d',
	},
	'GuestGuru/gg-design': {
		'.github/workflows/registry.yml':
			'a4621e2d63ceb3d59b110b47f87aaee9d2641e65febd6477c0ab3dbc76cda2b4',
	},
	'GuestGuru/BPDBv2': {
		'.github/workflows/ci.yml':
			'04a796504d09ff59c22981fc6fe2bb1e203c58a51a6b9992798a876d23697404',
		'.github/workflows/preview-alias.yml':
			'e3547548c88d27da6afe7b72b0554852962e7a1192121a276be44224e474dc34',
		'.github/workflows/preview-db.yml':
			'a54d0977fc5dd2309d921987b5bda620f54d415e429855d8dba6a617f1645326',
	},
	'GuestGuru/gg-agents': {
		'.github/workflows/ci.yml':
			'2dd70890e23b76bd4ad65684d6ef0b971d9ac440a8060a91becedb83e42a5d4f',
		'.github/workflows/preview-alias.yml':
			'082f4fbf6f4d4a064d824afe6e69b1ab4ad418f7d43bfc07f156f5cf4fa08bca',
	},
	'GuestGuru/tools': {
		'.github/workflows/ci.yml':
			'7cf0127957915ca2e2f39bbdb78f6fedeaf5d3a76cfa73e8e0627e5f65952ae4',
		'.github/workflows/delivery-doctor.yml':
			'31df9dc92e92d6ef4725d305426a7d1d8c5124a723a62576c921da0535242fa2',
		'.github/workflows/preview-alias.yml':
			'be8b3e7f7f145918e452466d5133320600a1421dd9aecfce322bc38b2058bedd',
		'.github/workflows/preview-db.yml':
			'993326888ae69ac03f42f7493c7446c2206a5ebb150c5198ca8051f9bf31e07f',
		'.github/workflows/publish-auth.yml':
			'7e6bc79345253c92b1454315d1530abe7a516e7ef895bdbdfc676e7cc057eedc',
		'.github/workflows/token-expiry.yml':
			'cd228edc9c8abc0da0f04c085417e17a12ffcb2d4c9e98d198ef1d84a12a3c1c',
	},
	'GuestGuru/irnok': {
		'.github/workflows/ci.yml':
			'ac81090e10632d101829ca3ff10058bf5ce4451031d178b5fd2678601e984f83',
		'.github/workflows/preview-alias.yml':
			'd5cbdc7f070ebd3db407a0284951bb5d4ec6e3c42613320f413f281e1805b7ce',
		'.github/workflows/preview-db.yml':
			'd2de948bd8611ad452d397412e533f85e183bdc5dc0ad95488c2dcf6936b53e3',
	},
	'GuestGuru/gg-tracker': {
		'.github/workflows/ci.yml':
			'9b6f11d17c710654747d405823f5209ebe2ffa1854ba0cf2a49007dc657ea355',
		'.github/workflows/preview-alias.yml':
			'f7e8e38e6d80ffdecebc6b27740571f169d811bd5a49b73030d20aac57f27e56',
		'.github/workflows/preview-db.yml':
			'5ce68336d44583d84b9389e7565ad6b68456755dbb451b4e1d686ccdb230ebca',
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

// Validates the single quality-gate job (IT-295). The gate both closes the
// merge path (its check run is the ruleset-required `quality-gate / verify`)
// and — where the policy declares a statusContext — publishes the commit
// status the Vercel production Deployment Check waits for. One evaluation,
// one job, one billable minute.
function validateGate(
	jobs: UnknownRecord | undefined,
	policy: WorkflowPolicy,
): string[] {
	const gateName = 'quality-gate'
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
	if (policy.statusContext) {
		if (inputs?.['status-context'] !== policy.statusContext) {
			errors.push(
				`quality-gate.with.status-context must be exactly ${policy.statusContext}`,
			)
		}
	} else if (inputs && 'status-context' in inputs) {
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
	const errors = validateGate(jobs, policy)
	// IT-295: the deployment-gate job merged into quality-gate. A leftover copy
	// would run the same evaluation on a second VM — exactly the billing waste
	// the merge removed — so its presence is an error, not a tolerated no-op.
	if (jobs && 'deployment-gate' in jobs) {
		errors.push(
			'deployment-gate job must be removed — quality-gate publishes the GG deployment gate status (IT-295)',
		)
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
