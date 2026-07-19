import type { NeonClient } from '../neon.js'
import type { VercelClient } from '../vercel.js'

/** The alias commands touch Vercel only — they must not require a Neon client. */
export interface VercelCommandDeps {
	vercel: VercelClient
	log: (message: string) => void
}

export interface CommandDeps extends VercelCommandDeps {
	neon: NeonClient
	now: () => Date
}

export const ISOLATED_FLAG_ENV = 'PREVIEW_DB_ISOLATED'

export function expiryFrom(now: Date, ttlDays: number): string {
	return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString()
}
