import { describe, expect, it } from 'vitest'
import { branchNameForPr, prNumberFromBranchName, selectOrphanBranches } from '../src/naming.js'

describe('branchNameForPr', () => {
	it('a prefixből és a PR számából képzi a nevet', () => {
		expect(branchNameForPr('preview/app', 42)).toBe('preview/app/pr-42')
	})
})

describe('prNumberFromBranchName', () => {
	it('visszaadja a PR számát', () => {
		expect(prNumberFromBranchName('preview/app', 'preview/app/pr-42')).toBe(42)
	})

	it('null idegen prefixre', () => {
		expect(prNumberFromBranchName('preview/app', 'preview/other-app/pr-42')).toBeNull()
	})

	it('null a nem PR-branchekre', () => {
		expect(prNumberFromBranchName('preview/app', 'preview-shared')).toBeNull()
		expect(prNumberFromBranchName('preview/app', 'production')).toBeNull()
	})

	it('nem matchel részleges nevet', () => {
		expect(prNumberFromBranchName('preview/app', 'preview/app/pr-42/extra')).toBeNull()
		expect(prNumberFromBranchName('preview/app', 'preview/app/pr-abc')).toBeNull()
	})

	it('a prefix regex-karaktereit literálként kezeli', () => {
		expect(prNumberFromBranchName('preview.x', 'previewYx/pr-7')).toBeNull()
	})
})

describe('selectOrphanBranches', () => {
	const prefix = 'preview/app'
	const branches = [
		{ id: 'br-1', name: 'preview/app/pr-1' },
		{ id: 'br-2', name: 'preview/app/pr-2' },
		{ id: 'br-3', name: 'preview/app/pr-3' },
		{ id: 'br-shared', name: 'preview-shared' },
		{ id: 'br-prod', name: 'production' },
		{ id: 'br-dev', name: 'long-lived-dev' },
		{ id: 'br-ci', name: 'ci-123-1' },
		{ id: 'br-other', name: 'preview/other-app/pr-1' },
	]

	it('csak a nyitott PR nélküli saját preview brancheket adja vissza', () => {
		expect(selectOrphanBranches(prefix, branches, [1, 3])).toEqual([
			{ id: 'br-2', name: 'preview/app/pr-2' },
		])
	})

	it('SOHA nem választ ki idegen branchet', () => {
		const orphans = selectOrphanBranches(prefix, branches, [])
		const names = orphans.map((b) => b.name)
		expect(names).toEqual([
			'preview/app/pr-1',
			'preview/app/pr-2',
			'preview/app/pr-3',
		])
		expect(names).not.toContain('production')
		expect(names).not.toContain('long-lived-dev')
		expect(names).not.toContain('preview-shared')
		expect(names).not.toContain('ci-123-1')
		expect(names).not.toContain('preview/other-app/pr-1')
	})

	it('üres, ha minden PR nyitva van', () => {
		expect(selectOrphanBranches(prefix, branches, [1, 2, 3])).toEqual([])
	})

	it('nem zavarja meg a nyitott PR-lista extra eleme', () => {
		expect(selectOrphanBranches(prefix, branches, [1, 2, 3, 99])).toEqual([])
	})
})
