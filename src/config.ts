import type { VercelConfig } from './vercel.js'

/** Commands that manage a Neon preview branch — they need the full Neon config. */
export type Command = 'ensure' | 'destroy' | 'refresh-ttl' | 'reset-shared'

/** Commands that only talk to Vercel — requiring Neon inputs for them would be noise. */
export type AliasCommand = 'alias-set' | 'alias-remove'

const COMMANDS: Command[] = ['ensure', 'destroy', 'refresh-ttl', 'reset-shared']

const ALIAS_COMMANDS: AliasCommand[] = ['alias-set', 'alias-remove']

export function isAliasCommand(value: string): value is AliasCommand {
	return (ALIAS_COMMANDS as string[]).includes(value)
}

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

export interface ParsedAliasArgs {
	command: AliasCommand
	config: VercelConfig
	/** Required for `alias-set` only — `alias-remove` resolves the alias by host. */
	deploymentId?: string
	aliasHost: string
	dryRun: boolean
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
		const known = [...COMMANDS, ...ALIAS_COMMANDS].join(', ')
		throw new Error(`Unknown command: ${argv[0] ?? '(none)'}. Expected one of ${known}`)
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
		const prNumberRaw = required(flags, 'pr-number')
		parsed.prNumber = Number(prNumberRaw)
		if (!Number.isInteger(parsed.prNumber)) throw new Error(`Invalid --pr-number: ${prNumberRaw}`)
		parsed.gitBranch = required(flags, 'git-branch')
	}

	if (command === 'refresh-ttl') {
		const raw = flags.get('open-pr-numbers')
		parsed.openPrNumbers = raw === undefined ? undefined : parsePrNumbers(raw)
	}

	return parsed
}

/**
 * The Vercel API wants a bare hostname. Passing a URL (or a host with a path)
 * would otherwise be accepted here and fail much later with an opaque 400.
 */
function assertHostname(value: string): string {
	if (value.includes('://') || value.includes('/')) {
		throw new Error(`Invalid --alias-host: ${value} — expected a bare hostname, not a URL`)
	}
	return value
}

/**
 * Separate entry point from `parseArgs`: the alias commands need neither the
 * Neon inputs nor NEON_API_KEY, and demanding them would force every caller to
 * pass irrelevant identifiers.
 */
export function parseAliasArgs(argv: string[], env: NodeJS.ProcessEnv): ParsedAliasArgs {
	const command = argv[0] ?? ''
	if (!isAliasCommand(command)) {
		throw new Error(`Unknown command: ${argv[0] ?? '(none)'}. Expected one of ${ALIAS_COMMANDS.join(', ')}`)
	}

	const flags = toFlagMap(argv.slice(1))

	const config: VercelConfig = {
		vercelToken: requiredEnv(env, 'VERCEL_TOKEN'),
		vercelProjectId: required(flags, 'vercel-project-id'),
		vercelTeamId: required(flags, 'vercel-team-id'),
	}

	const parsed: ParsedAliasArgs = {
		command,
		config,
		aliasHost: assertHostname(required(flags, 'alias-host')),
		dryRun: flags.has('dry-run'),
	}

	if (command === 'alias-set') {
		parsed.deploymentId = required(flags, 'deployment-id')
	}

	return parsed
}
