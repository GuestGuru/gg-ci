import { aliasRemove } from './commands/alias-remove.js'
import { aliasSet } from './commands/alias-set.js'
import { ensure } from './commands/ensure.js'
import { destroy } from './commands/destroy.js'
import { refreshTtl } from './commands/refresh-ttl.js'
import { resetShared } from './commands/reset-shared.js'
import type { CommandDeps, VercelCommandDeps } from './commands/types.js'
import { isAliasCommand, parseAliasArgs, parseArgs } from './config.js'
import { NeonClient } from './neon.js'
import { VercelClient } from './vercel.js'

/**
 * Alias commands never construct a Neon client, so they must be routed before
 * `parseArgs` — which would otherwise demand NEON_API_KEY and the Neon inputs.
 */
async function runAlias(argv: string[]): Promise<void> {
	const { command, config, deploymentId, aliasHost, dryRun } = parseAliasArgs(argv, process.env)

	const deps: VercelCommandDeps = {
		vercel: new VercelClient(config),
		log: (message) => console.log(message),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	}

	if (command === 'alias-set') {
		if (!deploymentId) throw new Error('alias-set requires --deployment-id')
		const result = await aliasSet(deps, { deploymentId, aliasHost, dryRun })
		console.log(`✓ alias-set done (${result.alreadyAssigned ? 'already assigned' : 'assigned'})`)
		// Machine-readable line the reusable workflow turns into its `preview-url` output.
		console.log(`preview-url=${result.url}`)
		return
	}

	const result = await aliasRemove(deps, { aliasHost, dryRun })
	console.log(
		`✓ alias-remove done (alias removed=${result.aliasRemoved}, domain removed=${result.domainRemoved})`,
	)
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2)
	const rawCommand = argv[0] ?? ''

	if (isAliasCommand(rawCommand)) {
		await runAlias(argv)
		return
	}

	const { command, config, prNumber, gitBranch, openPrNumbers, dryRun } = parseArgs(argv, process.env)

	const deps: CommandDeps = {
		neon: new NeonClient(config),
		vercel: new VercelClient(config),
		log: (message) => console.log(message),
		now: () => new Date(),
	}

	switch (command) {
		case 'ensure': {
			if (prNumber === undefined || !gitBranch) throw new Error('ensure requires --pr-number and --git-branch')
			const result = await ensure(deps, { config, prNumber, gitBranch, dryRun })
			console.log(`✓ ensure done (branch ${result.branchId}, redeployed=${result.redeployed})`)
			break
		}
		case 'destroy': {
			if (prNumber === undefined || !gitBranch) throw new Error('destroy requires --pr-number and --git-branch')
			const result = await destroy(deps, { config, prNumber, gitBranch, dryRun })
			console.log(`✓ destroy done (branch deleted=${result.branchDeleted}, envs=${result.envsDeleted})`)
			break
		}
		case 'refresh-ttl': {
			const result = await refreshTtl(deps, { config, openPrNumbers, dryRun })
			console.log(`✓ refresh-ttl done (refreshed=${result.refreshed}, deleted=${result.deleted})`)
			break
		}
		case 'reset-shared': {
			await resetShared(deps, { config, dryRun })
			console.log('✓ reset-shared done')
			break
		}
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
})
