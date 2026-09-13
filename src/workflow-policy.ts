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
			'af36c3ccb0cf2e5734cadc502ad6b9aa3dc540418e889b162bb6229c81f59647',
		'.github/workflows/preview-alias.yml':
			'81b06b6ad66224651b36c4923eb448105f5849e99275c554dc9bdf7c94d455be',
		'.github/workflows/preview-db.yml':
			'5dd303b6c3e41570faf47d75b0be9303bf1e68526a46bbe36ebd6166f3ae22b9',
	},
	'GuestGuru/gg-share': {
		'.github/workflows/ci.yml':
			'd50f42b4379b1d8417b85a4fd0d3191d94b06fa2ee3c128ae94dee4f6806e392',
		'.github/workflows/preview-alias.yml':
			'd525a6c7ff25f2ffd9d772a4977c527fa7c308f541e66ca0851b4adb5fcfb151',
		'.github/workflows/preview-db.yml':
			'ef72e4279f6f2cfdf4ce7a34ad46900860adc6c76ad217afe7ae8b06aa352ad0',
	},
	'GuestGuru/gg-mcp': {
		'.github/workflows/ci.yml':
			'f1e4773d59b9b8a7337a7400b879b6dd3da6ada7ec4fa8e7ae62b78a57fa1838',
	},
	'GuestGuru/gg-ci': {
		'.github/workflows/ci.yml':
			'3fc6c8a4df55f972e91821f511e3716d78d9517cf4da28d5e37cec6d0e504001',
		'.github/workflows/neon-preview.yml':
			'2b90ae54788591afcd45febdc59be1489310e5f193687a0744f8b9fd73530fdf',
		'.github/workflows/policy-gate.yml':
			'b5e629a4d70094a37601ce3fa9b2581ebde44c23ba026e0e96cefb6739ca8d78',
		'.github/workflows/preview.yml':
			'773857fcd41f10b4da06259bd66ddee646a3e5842bfff9628234bb7eb3bc9eee',
		'.github/workflows/quality-gate.yml':
			'c17612b20c64accf05bfd1a89d1c33dcf052be450089f79e94a9452f9f2e3893',
	},
	'GuestGuru/gg-sales': {
		'.github/workflows/ci.yml':
			'1e245fe8a3fc413c1a2b9d30e840e84e78b4c20ab8be0012869d1895c3657bcb',
		'.github/workflows/preview-alias.yml':
			'd5fc8a6a850b828f16e6fd10e8a5887a2ffaa04e1cdc3d7c36a10547fb17947e',
		'.github/workflows/preview-db.yml':
			'9bab599cdb1b2e41eba83409ae0f22ebd4cccd45d6bc911ee2ecf767d2eb4364',
	},
	'GuestGuru/gg-design': {
		'.github/workflows/registry.yml':
			'3bd18d29663ba3da5a52d90b09fc2a62211d33b239cbd4fce9db2ed13cf4e0ec',
		'.github/workflows/preview.yml':
			'bad70d6524bb5578f4c9e26be15e293a929dacb1d42abd32fe0377573cbd6ab2',
	},
	'GuestGuru/BPDBv2': {
		'.github/workflows/ci.yml':
			'cd6b7a280895fe632ea553583071f173848b7945cff8877e00073902a8c98e0b',
		'.github/workflows/preview-alias.yml':
			'd8efd55b83c9d18f996bf58531c5b3f8b72ef32ac65051984c0daaddf5d67602',
		'.github/workflows/preview-db.yml':
			'b1df229d717e3674d984b0c60cf9d9c27000be2ea93c1eb1a5fc18479bb77508',
	},
	'GuestGuru/gg-agents': {
		'.github/workflows/ci.yml':
			'd0fcab0eed04ecb53c55a54e1922b46bca501ec2556193210ba0d824c0f69812',
		'.github/workflows/preview-alias.yml':
			'd26d3a471f1cf8b855d942154dc4e3aaadffc0dc5e3c366addea56bc7df956a4',
		'.github/workflows/preview-db.yml':
			'9f32bc480118ebda9f696ee7465453de6f7f00410e40b124f37863582533717c',
	},
	'GuestGuru/gg-ops': {
		'.github/workflows/ci.yml':
			'0acccd15d0988e9b946e2e17583fac8feff1fd720bc49f4f0de8a02abee3a5b6',
	},
	'GuestGuru/tools': {
		'.github/workflows/ci.yml':
			'ed521bde7f4ef2305e69f66a1659ee55d59bd7f0e669e0a7337f5d4e8e9fddc2',
		'.github/workflows/delivery-doctor.yml':
			'46a6f754476399e6015a81bffb32eec7230df34a8f966a4cd805a85a9e5d09ea',
		'.github/workflows/preview-alias.yml':
			'02a0ce06d4700750696de9789c42fbd66271de716d787f30138488fc1e4f9c90',
		'.github/workflows/preview-db.yml':
			'993326888ae69ac03f42f7493c7446c2206a5ebb150c5198ca8051f9bf31e07f',
		'.github/workflows/publish-auth.yml':
			'3e435b51a35d0580929b6847e773a3bd1f2406a89cf7e057bffed9e61ab4349d',
		'.github/workflows/token-expiry.yml':
			'25e0fd53ed3c0c84649e8cf8248e0ca9fc2dc94559ffb0ce5c82e0325c6fc531',
	},
	'GuestGuru/irnok': {
		'.github/workflows/ci.yml':
			'c088da7e92a1d650f75307a18dc47d076c71cc842b669de0e6830948a794be87',
		'.github/workflows/preview-alias.yml':
			'52a2d83907be3a8e0b16b50c9e3b2d6173a87898b3acdbfd97b2ff4143087d33',
		'.github/workflows/preview-db.yml':
			'd2de948bd8611ad452d397412e533f85e183bdc5dc0ad95488c2dcf6936b53e3',
	},
	'GuestGuru/gg-tracker': {
		'.github/workflows/ci.yml':
			'a5d5f792a396d33082795b0503323b37b96e191af6feb8f6ef3b4ff349fd6134',
		'.github/workflows/preview-alias.yml':
			'13ee8171e1a9f6de5f178d5e363dba13bc022b9ef148bc7065e5fe9ff038d3b8',
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
