import { ensure } from './commands/ensure.js'
import { destroy } from './commands/destroy.js'
import { refreshTtl } from './commands/refresh-ttl.js'
import { resetShared } from './commands/reset-shared.js'
import type { CommandDeps } from './commands/types.js'
import { parseArgs } from './config.js'
import { NeonClient } from './neon.js'
import { VercelClient } from './vercel.js'

async function main(): Promise<void> {
	const { command, config, prNumber, gitBranch, openPrNumbers, dryRun } = parseArgs(
		process.argv.slice(2),
		process.env,
	)

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
