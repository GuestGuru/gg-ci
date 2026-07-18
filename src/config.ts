export type Command = 'ensure' | 'destroy' | 'refresh-ttl' | 'reset-shared'

const COMMANDS: Command[] = ['ensure', 'destroy', 'refresh-ttl', 'reset-shared']

export interface Config {
	neonApiKey: string
	vercelToken: string
	neonProjectId: string
	parentBranchId: string
	roleName: string
	databaseName: string
	vercelProjectId: string
	vercelTeamId: string
	branchPrefix: string
	sharedBranchName: string
	envVarName: string
	ttlDays: number
}

export interface ParsedArgs {
	command: Command
	config: Config
	prNumber?: number
	gitBranch?: string
	openPrNumbers?: number[]
	dryRun: boolean
}

function toFlagMap(argv: string[]): Map<string, string> {
	const flags = new Map<string, string>()
	for (const arg of argv) {
		if (!arg.startsWith('--')) continue
		const [key, ...rest] = arg.slice(2).split('=')
		if (!key) continue
		flags.set(key, rest.join('='))
	}
	return flags
}

function required(flags: Map<string, string>, key: string): string {
	const value = flags.get(key)
	if (!value) throw new Error(`Missing required argument: --${key}`)
	return value
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
	const value = env[key]
	if (!value) throw new Error(`Missing required env var: ${key}`)
	return value
}

function parsePrNumbers(raw: string): number[] {
	return raw
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.map((part) => {
			const parsed = Number(part)
			if (!Number.isInteger(parsed)) throw new Error(`Invalid PR number: ${part}`)
			return parsed
		})
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ParsedArgs {
	const command = argv[0] as Command
	if (!COMMANDS.includes(command)) {
		throw new Error(`Unknown command: ${argv[0] ?? '(none)'}. Expected one of ${COMMANDS.join(', ')}`)
	}

	const flags = toFlagMap(argv.slice(1))

	// Collect all required flag strings first, before numeric parsing
	const neonProjectId = required(flags, 'neon-project-id')
	const parentBranchId = required(flags, 'parent-branch-id')
	const roleName = required(flags, 'role-name')
	const databaseName = required(flags, 'database-name')
	const vercelProjectId = required(flags, 'vercel-project-id')
	const vercelTeamId = required(flags, 'vercel-team-id')
	const branchPrefix = required(flags, 'branch-prefix')
	const sharedBranchName = required(flags, 'shared-branch-name')
	const envVarName = required(flags, 'env-var-name')
	const ttlRaw = required(flags, 'ttl-days')

	// Now do numeric parsing
	const ttlDays = Number(ttlRaw)
	if (!Number.isInteger(ttlDays) || ttlDays <= 0) {
		throw new Error(`Invalid --ttl-days: ${ttlRaw}`)
	}

	const config: Config = {
		neonApiKey: requiredEnv(env, 'NEON_API_KEY'),
		vercelToken: requiredEnv(env, 'VERCEL_TOKEN'),
		neonProjectId,
		parentBranchId,
		roleName,
		databaseName,
		vercelProjectId,
		vercelTeamId,
		branchPrefix,
		sharedBranchName,
		envVarName,
		ttlDays,
	}

	const parsed: ParsedArgs = { command, config, dryRun: flags.has('dry-run') }

	if (command === 'ensure' || command === 'destroy') {
		parsed.prNumber = Number(required(flags, 'pr-number'))
		if (!Number.isInteger(parsed.prNumber)) throw new Error('Invalid --pr-number')
		parsed.gitBranch = required(flags, 'git-branch')
	}

	if (command === 'refresh-ttl') {
		const raw = flags.get('open-pr-numbers')
		parsed.openPrNumbers = raw === undefined ? undefined : parsePrNumbers(raw)
	}

	return parsed
}
