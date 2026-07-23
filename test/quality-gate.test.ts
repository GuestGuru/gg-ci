import { describe, expect, it } from 'vitest'
import { evaluateNeeds } from '../src/quality-gate.js'

describe('evaluateNeeds', () => {
	it('csak akkor zöld, ha minden kötelező job sikeres', () => {
		expect(
			evaluateNeeds(
				JSON.stringify({
					lint: { result: 'success', outputs: {} },
					test: { result: 'success', outputs: {} },
				}),
			),
		).toEqual({
			passed: true,
			failures: [],
		})
	})

	it.each(['failure', 'cancelled', 'skipped'])(
		'elutasítja a(z) %s eredményű kötelező jobot',
		(result) => {
			expect(evaluateNeeds(JSON.stringify({ test: { result, outputs: {} } }))).toEqual({
				passed: false,
				failures: [{ job: 'test', result }],
			})
		},
	)

	it('elutasítja az üres needs objektumot', () => {
		expect(() => evaluateNeeds('{}')).toThrow(/legalább egy/)
	})

	it('érthető hibát ad érvénytelen JSON-ra', () => {
		expect(() => evaluateNeeds('not-json')).toThrow(/érvénytelen JSON/)
	})
})
