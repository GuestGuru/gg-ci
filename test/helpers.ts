import type { Mock } from 'vitest'

/**
 * Returns the recorded arguments of the mock call at `index`, typed as a
 * defined tuple instead of `Parameters<T> | undefined`.
 *
 * Under `noUncheckedIndexedAccess`, `mock.mock.calls[index]` is typed as
 * possibly `undefined`, which makes ad-hoc `const [url, init] =
 * fetchMock.mock.calls[0]` destructuring a type error. This helper narrows
 * that for tests and fails fast with a readable message if the call was
 * never made, instead of a confusing "Cannot read properties of undefined"
 * error at the point of use.
 */
export function mockCallArgs<T extends (...args: any[]) => any>(
	mock: Mock<T>,
	index = 0,
): Parameters<T> {
	const call = mock.mock.calls[index]
	if (call === undefined) {
		throw new Error(
			`Expected mock to have recorded a call at index ${index}, but it only recorded ${mock.mock.calls.length} call(s).`,
		)
	}
	return call
}
