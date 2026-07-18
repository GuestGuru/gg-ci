import { describe, expect, it } from 'vitest'
import { branchNameForPr, prNumberFromBranchName } from '../src/naming.js'

describe('branchNameForPr', () => {
	it('a prefixből és a PR számából képzi a nevet', () => {
		expect(branchNameForPr('preview/gg-tracker', 42)).toBe('preview/gg-tracker/pr-42')
	})
})

describe('prNumberFromBranchName', () => {
	it('visszaadja a PR számát', () => {
		expect(prNumberFromBranchName('preview/gg-tracker', 'preview/gg-tracker/pr-42')).toBe(42)
	})

	it('null idegen prefixre', () => {
		expect(prNumberFromBranchName('preview/gg-tracker', 'preview/tools/pr-42')).toBeNull()
	})

	it('null a nem PR-branchekre', () => {
		expect(prNumberFromBranchName('preview/gg-tracker', 'preview-shared')).toBeNull()
		expect(prNumberFromBranchName('preview/gg-tracker', 'production')).toBeNull()
	})

	it('nem matchel részleges nevet', () => {
		expect(prNumberFromBranchName('preview/gg-tracker', 'preview/gg-tracker/pr-42/extra')).toBeNull()
		expect(prNumberFromBranchName('preview/gg-tracker', 'preview/gg-tracker/pr-abc')).toBeNull()
	})

	it('a prefix regex-karaktereit literálként kezeli', () => {
		expect(prNumberFromBranchName('preview.x', 'previewYx/pr-7')).toBeNull()
	})
})
