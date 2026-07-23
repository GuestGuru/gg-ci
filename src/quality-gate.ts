import { pathToFileURL } from 'node:url'

type Need = {
	result?: unknown
}

export type QualityGateResult = {
	passed: boolean
	failures: Array<{ job: string; result: string }>
}

export function evaluateNeeds(json: string): QualityGateResult {
	let parsed: unknown
	try {
		parsed = JSON.parse(json)
	} catch {
		throw new Error('A quality-gate inputja érvénytelen JSON.')
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('A quality-gate inputja nem needs objektum.')
	}

	const entries = Object.entries(parsed as Record<string, Need>)
	if (entries.length === 0) {
		throw new Error('A quality-gate-hez legalább egy kötelező job kell.')
	}

	const failures = entries
		.map(([job, need]) => ({ job, result: String(need?.result ?? 'missing') }))
		.filter(({ result }) => result !== 'success')

	return { passed: failures.length === 0, failures }
}

export function run(argv: string[]): number {
	const result = evaluateNeeds(argv[0] ?? '')
	if (result.passed) {
		console.log('quality-gate: minden kötelező job sikeres')
		return 0
	}

	for (const failure of result.failures) {
		console.error(`quality-gate: ${failure.job} → ${failure.result}`)
	}
	return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = run(process.argv.slice(2))
}
