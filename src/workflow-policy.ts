import { execFileSync } from 'node:child_process'
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
	'GuestGuru/ainita': {
		workflowPath: '.github/workflows/ci.yml',
		requiredNeeds: ['ci'],
		uses: centralGate,
		statusContext: 'GG deployment gate',
	},
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
	'GuestGuru/gg-ops': {
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
	'GuestGuru/ainita': {
		'.github/workflows/ci.yml':
			'2bb8597f83769854087e0fb5ce7526a6329a4fcf1661784ddc9c30695c0c159d',
		'.github/workflows/preview-alias.yml':
			'c8a4230805268eb19ed430147f1af3ee0ed32aea13716eeff15053ad83f0dd41',
		'.github/workflows/preview-db.yml':
			'5dd303b6c3e41570faf47d75b0be9303bf1e68526a46bbe36ebd6166f3ae22b9',
	},
	'GuestGuru/gg-share': {
		'.github/workflows/ci.yml':
			'c8b1abd956de1be236aa67d37ca3bb1120f95557ed8bebde56f578ab00a9a899',
		'.github/workflows/preview-alias.yml':
			'25722752cba7384cc4a3e97576d9a9a266172416a20ca80cb33ad86231da38f8',
		'.github/workflows/preview-db.yml':
			'ef72e4279f6f2cfdf4ce7a34ad46900860adc6c76ad217afe7ae8b06aa352ad0',
	},
	'GuestGuru/gg-mcp': {
		'.github/workflows/ci.yml':
			'02c70f0ec757d26011117ebf8964faccc9c5c46ee835ebad83962df1ee35b467',
	},
	'GuestGuru/gg-ci': {
		'.github/workflows/ci.yml':
			'3fc6c8a4df55f972e91821f511e3716d78d9517cf4da28d5e37cec6d0e504001',
		'.github/workflows/neon-preview.yml':
			'9c2eb2903a0fa765528c7f78619f8a7f0ae6d1294615c5425a31c07ee9f1377e',
		'.github/workflows/policy-gate.yml':
			'3b22e34d2de7d6ab5545f9170d469d4ba396bdda74abb3dd56feb3893cc13483',
		'.github/workflows/preview.yml':
			'b9ea4490f811125a2ca2bcc6db78d222f3c4c82e3938396af9f8a68d4a402319',
		'.github/workflows/quality-gate.yml':
			'2140fef05a400af95c7276d67cbbdd1ac5823e58f2d28dd862366af6e976add6',
	},
	'GuestGuru/gg-sales': {
		'.github/workflows/ci.yml':
			'1e245fe8a3fc413c1a2b9d30e840e84e78b4c20ab8be0012869d1895c3657bcb',
		'.github/workflows/preview-alias.yml':
			'1f11b5be7b9da998c4772485cec48b1a6310e46a6e7b512a0e6a1364e3bd2e3c',
		'.github/workflows/preview-db.yml':
			'9bab599cdb1b2e41eba83409ae0f22ebd4cccd45d6bc911ee2ecf767d2eb4364',
	},
	'GuestGuru/gg-design': {
		'.github/workflows/registry.yml':
			'5d276b222571f6259f148f1e4c112f8875313f6612dfda93a1740e3b29835ed6',
		'.github/workflows/preview.yml':
			'179a88afab8fbdc81de06d45c8032b23890201bd3cadd7b25a34b7cc178aa55a',
	},
	'GuestGuru/BPDBv2': {
		'.github/workflows/ci.yml':
			'cd6b7a280895fe632ea553583071f173848b7945cff8877e00073902a8c98e0b',
		'.github/workflows/preview-alias.yml':
			'720ae81fd37b799cb1b9e8c7842dab56bf9f91fc835537ea3555932b846842e6',
		'.github/workflows/preview-db.yml':
			'b1df229d717e3674d984b0c60cf9d9c27000be2ea93c1eb1a5fc18479bb77508',
	},
	'GuestGuru/gg-agents': {
		'.github/workflows/ci.yml':
			'5731363cc42c19a749430336d9ee8ccfb084c285b728efd15e6e99f77aec6d38',
		'.github/workflows/preview-alias.yml':
			'76c3ae3a7cb4e78f5d7001df964810cd1d9fd17c92b9853a7b6141bdf222c553',
		'.github/workflows/preview-db.yml':
			'9f32bc480118ebda9f696ee7465453de6f7f00410e40b124f37863582533717c',
	},
	'GuestGuru/gg-ops': {
		'.github/workflows/ci.yml':
			'00ebd488d8d0e6616f3af7d396bcad33bcfd9a5224cb9e1d232446ef0321ec79',
		'.github/workflows/preview-alias.yml':
			'021fb8cd06f656dd4a4e8a9283012a70ff20824e32ee30491e52d655952fa980',
		'.github/workflows/preview-db.yml':
			'bf585bdebf555f5a4084c2f62024d2e8185665a12c98408898d5351b6c609fd1',
	},
	'GuestGuru/tools': {
		'.github/workflows/ci.yml':
			'0f077278104ce91ed2774e4b6310c42b77fdbd69eb401e1c3c2fd1de120fca91',
		'.github/workflows/delivery-doctor.yml':
			'46a6f754476399e6015a81bffb32eec7230df34a8f966a4cd805a85a9e5d09ea',
		'.github/workflows/preview-alias.yml':
			'4da592d118e2214cc0573befc427cf49d9c400757551ebfb3ab9f7e6b7fb6b0e',
		'.github/workflows/preview-db.yml':
			'993326888ae69ac03f42f7493c7446c2206a5ebb150c5198ca8051f9bf31e07f',
		'.github/workflows/publish-auth.yml':
			'e92dd66174e030a3b2c6704d183dd4e752c7d1589041923f90b0b0d6ca1a60b8',
		'.github/workflows/token-expiry.yml':
			'25e0fd53ed3c0c84649e8cf8248e0ca9fc2dc94559ffb0ce5c82e0325c6fc531',
	},
	'GuestGuru/irnok': {
		'.github/workflows/ci.yml':
			'752f8d831f64ceff276ec7ec65a3a4bf87a1618ab5f6643aa58f4034b0f1f498',
		'.github/workflows/preview-alias.yml':
			'88f265aa6a850bfe4fc0d2c6046c47098c83fd30e55d7e95ae48ceaf7d60551e',
		'.github/workflows/preview-db.yml':
			'd2de948bd8611ad452d397412e533f85e183bdc5dc0ad95488c2dcf6936b53e3',
	},
	'GuestGuru/gg-tracker': {
		'.github/workflows/ci.yml':
			'f5a002a77d3369af3bd58b1e13f6980bb6cf5ef0298acedf3bc7dc6ae15cacf9',
		'.github/workflows/preview-alias.yml':
			'5595e8264e7d0db1d9c6f317a79a600d5f3d83fa0e5fba58c5d2b4a36b46588d',
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

// Every file in .github/workflows, path → content. The hash inventory and the
// gg-runner invariants (IT-974) both read from this one listing.
export function collectWorkflowSources(
	targetRoot: string,
): Record<string, string> {
	const workflowDirectory = join(targetRoot, '.github/workflows')
	return Object.fromEntries(
		readdirSync(workflowDirectory, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => {
				const relativePath = `.github/workflows/${entry.name}`
				return [relativePath, readFileSync(join(targetRoot, relativePath), 'utf8')]
			}),
	)
}

export function hashWorkflowSources(
	sources: Record<string, string>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(sources).map(([path, content]) => [path, hashWorkflow(content)]),
	)
}

export function collectWorkflowInventory(
	targetRoot: string,
): Record<string, string> {
	return hashWorkflowSources(collectWorkflowSources(targetRoot))
}

// --- gg-runner invariánsok (IT-974) -----------------------------------------
//
// Két, mérésből született szabály minden olyan jobra, ami a GG saját
// (self-hosted) runnerén fut — a `runs-on` a `gg-runner` címkét vagy a
// `vars.GG_CI_RUNNER` kifejezést tartalmazza:
//
//   1. IT-966: az `actions/setup-node` lépésben nincs `cache:` (a perzisztens
//      runner ~/.npm-je jobról jobra megmarad, a GitHub-cache visszaállítása
//      ott 1,07 GB letöltés volt, a jobidő 70–80%-a). Az egyetlen megengedett
//      `cache:` a gg-ci saját workflow-inak feltételes alakja, mert ugyanaz a
//      job a vészfék (a GG_CI_RUNNER törlése) után felhős runnerre kerül, ahol
//      a cache hasznos. A `package-manager-cache: false` ott kötelező, ahol a
//      cél-repó gyökér `package.json`-ja `packageManager`-t (vagy
//      `devEngines.packageManager`-t) deklarál — a setup-node v5 pontosan
//      ebből kapcsolja vissza magától a cache-t `cache:` nélkül is (mérve
//      2026-09-23: tools, gg-tracker). Ahol nincs ilyen mező, a sor hatástalan,
//      ezért nem követeljük; a mező felvétele viszont a policy-t azonnal
//      elbuktatja, amíg a workflow nem tiltja le a cache-t.
//   2. IT-971: a `pnpm/action-setup` lépésben `dest: ${{ runner.temp }}/setup-pnpm`.
//      A default `~/setup-pnpm` a két runner-példány közös HOME-jában van, és az
//      action minden futáskor törli és újratelepíti — két egyszerre induló job
//      egymás alól törölte a pnpm-et.
//
// A szabály minden inventory-fájlra fut (nem csak a hívó ci.yml-re), és
// fail-closed: a sértés a hash-jóváhagyás pillanatában ad hibát, nem a runneren.
// Egy reusable-hívás (`uses:` job-szinten, nincs `steps`) nem érintett — annak
// a jobjait a hívott workflow saját inventoryja fedi.

const GG_RUNNER_LABEL = 'gg-runner'
const GG_RUNNER_VARIABLE = 'GG_CI_RUNNER'
const CONDITIONAL_NPM_CACHE =
	"${{ runner.environment == 'github-hosted' && 'npm' || '' }}"
const PNPM_DEST = '${{ runner.temp }}/setup-pnpm'

function mentionsGgRunner(value: unknown): boolean {
	if (typeof value === 'string') {
		return value.includes(GG_RUNNER_LABEL) || value.includes(GG_RUNNER_VARIABLE)
	}
	if (Array.isArray(value)) return value.some(mentionsGgRunner)
	const record = asRecord(value)
	// `runs-on: { group: …, labels: … }` alak.
	return record ? mentionsGgRunner(record.labels) : false
}

function usesAction(step: UnknownRecord, action: string): boolean {
	const uses = step.uses
	return typeof uses === 'string' && (uses === action || uses.startsWith(`${action}@`))
}

export type WorkflowSourcesEvidence = {
	// Path → content of every file in the target's .github/workflows.
	sources: Record<string, string>
	// True when the target's root package.json declares `packageManager` or
	// `devEngines.packageManager` — the trigger of setup-node v5's automatic
	// cache. Fail-closed: an unreadable package.json counts as declared.
	packageManagerDeclared: boolean
}

export function packageJsonDeclaresPackageManager(targetRoot: string): boolean {
	let content: string
	try {
		content = readFileSync(join(targetRoot, 'package.json'), 'utf8')
	} catch {
		// No root package.json (e.g. a monorepo with per-directory packages):
		// setup-node has nothing to detect from.
		return false
	}
	try {
		const packageJson = asRecord(JSON.parse(content))
		return (
			packageJson?.packageManager !== undefined ||
			asRecord(packageJson?.devEngines)?.packageManager !== undefined
		)
	} catch {
		return true
	}
}

export function validateRunnerInvariants(
	evidence: WorkflowSourcesEvidence,
): string[] {
	const { sources, packageManagerDeclared } = evidence
	const errors: string[] = []
	for (const path of Object.keys(sources).sort()) {
		let workflow: unknown
		try {
			workflow = parse(sources[path] ?? '')
		} catch {
			errors.push(`Workflow YAML is invalid: ${path}`)
			continue
		}
		const jobs = asRecord(asRecord(workflow)?.jobs) ?? {}
		for (const jobName of Object.keys(jobs).sort()) {
			const job = asRecord(jobs[jobName])
			if (!job || !mentionsGgRunner(job['runs-on'])) continue
			const steps = Array.isArray(job.steps) ? job.steps : []
			steps.forEach((rawStep, index) => {
				const step = asRecord(rawStep)
				if (!step) return
				const where = `${path}: job ${jobName} runs on gg-runner, so step ${index + 1}`
				const inputs = asRecord(step.with) ?? {}
				if (usesAction(step, 'actions/setup-node')) {
					const cache = inputs.cache
					if (cache !== undefined && cache !== '' && cache !== CONDITIONAL_NPM_CACHE) {
						errors.push(
							`${where} (actions/setup-node) must not set cache: — the persistent runner keeps ~/.npm and the pnpm store between jobs, restoring the GitHub cache there only re-downloads them (IT-966); remove the cache: line, or use exactly ${CONDITIONAL_NPM_CACHE} in a job that can also land on a GitHub-hosted runner`,
						)
					}
					if (packageManagerDeclared && inputs['package-manager-cache'] !== false) {
						errors.push(
							`${where} (actions/setup-node) must set package-manager-cache: false — this repository's package.json declares a packageManager, from which setup-node v5 switches the GitHub cache back on by itself (IT-966)`,
						)
					}
				}
				if (usesAction(step, 'pnpm/action-setup') && inputs.dest !== PNPM_DEST) {
					errors.push(
						`${where} (pnpm/action-setup) must set with.dest: ${PNPM_DEST} — the default ~/setup-pnpm is shared by the runner instances' common HOME, and the action deletes and reinstalls it on every run, so two jobs starting together remove each other's pnpm (IT-971)`,
					)
				}
			})
		}
	}
	return errors
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
	// Every workflow file's content plus the package.json evidence; when given,
	// the gg-runner invariants (IT-974) run on all of them. `run` always passes it.
	workflowSources?: WorkflowSourcesEvidence,
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
		...(workflowSources ? validateRunnerInvariants(workflowSources) : []),
		...centralErrors,
	]
}

// --- Honnan fut ez a policy? (IT-594) ---------------------------------------
//
// Az org-ruleset a required policy workflow-t egy IMMUTABLE gg-ci sha-ra
// pinneli, és a workflow EBBŐL a commitból checkoutolja a teljes
// implementációt — az `approvedWorkflowInventories` hasheit is. Ha egy hash már
// a mainen van, de a pint nem vitték utána, a CÉL-repo azt látja, hogy
// „Workflow content is not approved", miközben a tartalom jóvá VAN hagyva: a
// tünet a cél-repóban jelenik meg, az ok a gg-ci-ben van, és a bukott futás
// rerunja sem segít (a `ref: job.workflow_sha` a régi sha-t örökli). Ezért
// minden futás megmondja, melyik commitból fut, és bukáskor összeveti a main
// HEAD-jével — így a kimenetből eldől, elavult pin vagy valódi policy-sértés.

export type PolicySource = {
	repository?: string
	sha?: string
}

export type PolicyRunDeps = {
	readCheckoutSha?: () => string | undefined
	readMainSha?: (repository: string) => string | undefined
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/

// A trusted checkout HEAD-je a hiteles válasz: a policy-gate `ref:
// job.workflow_sha`-val hozza le ezt a fát, tehát a detached HEAD PONTOSAN a
// pinnelt commit. A GITHUB_WORKFLOW_SHA csak fallback, ha a checkoutnak nincs
// olvasható .git-je.
function readCheckoutHeadSha(): string | undefined {
	try {
		const head = readFileSync(
			new URL('../.git/HEAD', import.meta.url),
			'utf8',
		).trim()
		return COMMIT_SHA_PATTERN.test(head) ? head : undefined
	} catch {
		return undefined
	}
}

// GITHUB_WORKFLOW_REF alakja:
// "<owner>/<repo>/.github/workflows/policy-gate.yml@refs/heads/main"
export function resolvePolicySource(
	env: NodeJS.ProcessEnv,
	readCheckoutSha: () => string | undefined = readCheckoutHeadSha,
): PolicySource {
	const [owner, name] = (env.GITHUB_WORKFLOW_REF ?? '').split('/')
	const repository = owner && name ? `${owner}/${name}` : ''
	const sha = readCheckoutSha() ?? env.GITHUB_WORKFLOW_SHA ?? ''
	return {
		repository: REPOSITORY_PATTERN.test(repository) ? repository : undefined,
		sha: COMMIT_SHA_PATTERN.test(sha) ? sha : undefined,
	}
}

export function policySourceLine(source: PolicySource): string {
	const repository = source.repository ?? 'the trusted policy repository'
	if (!source.sha) {
		return `Policy source: ${repository}@unknown — neither the trusted checkout's HEAD nor GITHUB_WORKFLOW_SHA named a commit.`
	}
	return `Policy source: ${repository}@${source.sha} — the commit the organization ruleset pins .github/workflows/policy-gate.yml to.`
}

export function stalePinDiagnosis(
	source: PolicySource,
	mainSha?: string,
): string[] {
	const repository = source.repository ?? 'the policy repository'
	const repin = `re-pin the organization ruleset's required workflow to main's SHA (org admin), then close/reopen this pull request — a re-run inherits the old pin.`

	if (!source.sha) {
		return [
			`Whether the ruleset pin is stale is unknown here, because this policy's own commit could not be determined. If a ${repository} pull request has already approved the content above, ${repin}`,
		]
	}
	if (!mainSha) {
		return [
			`Could not read ${repository} main's SHA to compare against. If the content above was approved by a ${repository} commit newer than the pinned one, the pin is stale: ${repin}`,
		]
	}
	if (mainSha === source.sha) {
		return [
			`${repository} main is at the same commit, so the ruleset pin is up to date — this is a real policy violation, not a stale pin.`,
		]
	}
	return [
		`${repository} main is at ${mainSha}, which is NOT the pinned commit — this run evaluated an older policy than main's.`,
		`If the content above was approved in a ${repository} pull request that has since merged, that is the cause: ${repin}`,
	]
}

// A gg-ci publikus, ezért a main HEAD token nélkül is olvasható. `git
// ls-remote` és nem a REST API: az utóbbi hitelesítés nélkül 60 kérés/óra/IP,
// megosztott runner-IP-kkel megbízhatatlan.
function readMainShaFromRemote(repository: string): string | undefined {
	if (!REPOSITORY_PATTERN.test(repository)) return undefined
	try {
		const output = execFileSync(
			'git',
			[
				'ls-remote',
				`https://github.com/${repository}.git`,
				'refs/heads/main',
			],
			{ encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] },
		)
		const sha = output.split(/\s/)[0] ?? ''
		return COMMIT_SHA_PATTERN.test(sha) ? sha : undefined
	} catch {
		return undefined
	}
}

function reportFailure(
	errors: string[],
	source: PolicySource,
	deps: PolicyRunDeps,
): number {
	for (const error of errors) console.error(`workflow-policy: ${error}`)
	console.error(`workflow-policy: ${policySourceLine(source)}`)
	const mainSha = source.repository
		? (deps.readMainSha ?? readMainShaFromRemote)(source.repository)
		: undefined
	for (const line of stalePinDiagnosis(source, mainSha)) {
		console.error(`workflow-policy: ${line}`)
	}
	return 1
}

export function run(
	argv: string[],
	env: NodeJS.ProcessEnv = process.env,
	deps: PolicyRunDeps = {},
): number {
	const repository = env.GITHUB_REPOSITORY ?? ''
	const source = resolvePolicySource(env, deps.readCheckoutSha)
	const policy = policyForRepository(repository)
	if (!policy) {
		return reportFailure(
			[`no policy configured for ${repository || '(missing repository)'}`],
			source,
			deps,
		)
	}

	const targetRoot = argv[0] ?? '.'
	let workflowYaml: string
	let workflowSources: WorkflowSourcesEvidence
	let actualInventory: Record<string, string>
	let centralTrust: CentralTrustEvidence | undefined
	try {
		workflowYaml = readFileSync(join(targetRoot, policy.workflowPath), 'utf8')
		workflowSources = {
			sources: collectWorkflowSources(targetRoot),
			packageManagerDeclared: packageJsonDeclaresPackageManager(targetRoot),
		}
		actualInventory = hashWorkflowSources(workflowSources.sources)
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
		return reportFailure(
			[`cannot read ${policy.workflowPath} or workflow inventory`],
			source,
			deps,
		)
	}

	const errors = validateWorkflowPolicy(
		repository,
		workflowYaml,
		actualInventory,
		centralTrust,
		workflowSources,
	)
	if (errors.length === 0) {
		console.log(`workflow-policy: ${repository} uses the canonical quality gate`)
		console.log(`workflow-policy: ${policySourceLine(source)}`)
		return 0
	}

	return reportFailure(errors, source, deps)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = run(process.argv.slice(2))
}
