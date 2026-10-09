import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// A repó PUBLIKUS. A házszabály (Tamás, 2026-10-09, IT-1496): belső útvonal, VM- és
// profilnév, runner-szám, repó- és domainnév, projekt- és team-ID bekerülhet; titok
// és hozzáférést adó adat nem. Ez az őr a titok ALAKÚ szövegeket keresi minden
// verziókövetett fájlban — az azonosítókat szándékosan nem (a régi
// `prj_|team_|guest\.guru` grep helyett). Új titok-fajtánál ide kerüljön a minta.

const repoRoot = new URL('..', import.meta.url).pathname
const self = 'test/secret-guard.test.ts'

// név → minta; a minták titok alakúak, nem azonosító alakúak
const secretPatterns: Record<string, RegExp> = {
	// séma://felhasználó:jelszó@hoszt — pl. Postgres connection string jelszóval
	'connection string with password': /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`]+:[^\s/@"'`$]+@/,
	'private key': /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	'GitHub token': /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/,
	'Neon API key': /\bnapi_[a-z0-9]{30,}/,
	'Linear API key': /\blin_api_[A-Za-z0-9]{20,}/,
	'Slack token': /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
	'LLM API key': /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
	'AWS access key': /\bAKIA[0-9A-Z]{16}\b/,
}

const findSecrets = (text: string) =>
	Object.entries(secretPatterns)
		.filter(([, re]) => re.test(text))
		.map(([name]) => name)

describe('secret guard (IT-1496)', () => {
	it('recognises each kind of secret it is meant to catch', () => {
		// futásidőben összerakva, hogy maga a forrás ne hordozzon titok alakú szöveget
		const samples: Record<string, string> = {
			'connection string with password': `postgresql://app_owner:${'x'.repeat(12)}@db.example.com/app`,
			'private key': `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----`,
			'GitHub token': `token: gh${'p'}_${'A1'.repeat(18)}`,
			'Neon API key': `napi_${'a1'.repeat(30)}`,
			'Linear API key': `lin_api_${'Ab3'.repeat(10)}`,
			'Slack token': `xox${'b'}-1234-5678-${'a'.repeat(12)}`,
			'LLM API key': `sk-${'ant'}-${'a1B2'.repeat(10)}`,
			'AWS access key': `AKIA${'ABCD2345'.repeat(2)}`,
		}
		for (const [name, sample] of Object.entries(samples)) {
			expect(findSecrets(sample), name).toEqual([name])
		}
	})

	it('allows identifiers, paths and placeholders the house rule permits', () => {
		for (const allowed of [
			'prj_1AbCdEfGhIjKlMnOpQrStUv',
			'team_AbCdEfGhIjKlMnOpQrStUv',
			'https://gg-mb.example.ts.net:8443/',
			'/home/kratam.guest/runner-hooks/disk-guard.sh',
			'colima ssh -p ci',
			'postgresql://user@host/db',
			'postgresql://${{ secrets.USER }}:${{ secrets.PASSWORD }}@host/db',
			'DATABASE_URL=$DATABASE_URL',
		]) {
			expect(findSecrets(allowed), allowed).toEqual([])
		}
	})

	it('finds no secret-shaped text in any tracked file', () => {
		const listed = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
		expect(listed.status).toBe(0)
		const files = listed.stdout.split('\0').filter((f) => f && f !== self && f !== 'package-lock.json')
		expect(files.length).toBeGreaterThan(20)
		const hits = files.flatMap((file) => {
			const text = readFileSync(join(repoRoot, file), 'utf8')
			return findSecrets(text).map((name) => `${file}: ${name}`)
		})
		expect(hits).toEqual([])
	})
})
