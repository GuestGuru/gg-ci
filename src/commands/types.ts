import type { NeonClient } from '../neon.js'
import type { VercelClient } from '../vercel.js'

interface BaseCommandDeps {
	vercel: VercelClient
	log: (message: string) => void
}

/**
 * The alias commands touch Vercel only — they must not require a Neon client.
 * `sleep` is injected for the same reason `now` is: waiting out certificate
 * provisioning must not make the test suite actually sleep.
 */
export interface VercelCommandDeps extends BaseCommandDeps {
	sleep: (ms: number) => Promise<void>
}

export interface CommandDeps extends BaseCommandDeps {
	neon: NeonClient
	now: () => Date
}

export const ISOLATED_FLAG_ENV = 'PREVIEW_DB_ISOLATED'

export function expiryFrom(now: Date, ttlDays: number): string {
	return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString()
}
