import type { NeonClient } from '../neon.js'
import type { VercelClient } from '../vercel.js'

export interface CommandDeps {
	neon: NeonClient
	vercel: VercelClient
	log: (message: string) => void
	now: () => Date
}

export const ISOLATED_FLAG_ENV = 'PREVIEW_DB_ISOLATED'

export function expiryFrom(now: Date, ttlDays: number): string {
	return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString()
}
