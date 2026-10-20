import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// A bő tesztsorok közös bukásjelzője (IT-1808). A szkriptet hamis `gh`-val
// futtatjuk: a stub naplózza a hívásait, és a STUB_ISSUES listát adja vissza a
// nyitott issue-k lekérdezésére, így az új issue és a komment ága is mérhető.

const actionDir = new URL('../.github/actions/wide-suite-failure/', import.meta.url).pathname
const script = join(actionDir, 'notify.sh')

const ghStub = `#!/bin/bash
echo "$*" >> "$STUB_LOG"
if [[ "$1" == api ]]; then printf '%s' "$STUB_ISSUES"; fi
`

describe('wide-suite-failure action (IT-1808)', () => {
	let stubDir: string
	let log: string

	beforeEach(() => {
		stubDir = mkdtempSync(join(tmpdir(), 'gg-ci-wide-'))
		log = join(stubDir, 'calls.log')
		writeFileSync(log, '')
		writeFileSync(join(stubDir, 'gh'), ghStub)
		chmodSync(join(stubDir, 'gh'), 0o755)
	})

	afterEach(() => rmSync(stubDir, { recursive: true, force: true }))

	const run = (issues: string) =>
		spawnSync('/bin/bash', [script], {
			encoding: 'utf8',
			env: {
				PATH: `${stubDir}:/usr/bin:/bin`,
				STUB_LOG: log,
				STUB_ISSUES: issues,
				TITLE: 'Bő sor bukás: E2E wide',
				ASSIGNEE: 'kratam',
				RUN_URL: 'https://github.com/GuestGuru/x/actions/runs/7',
				GITHUB_REPOSITORY: 'GuestGuru/x',
				GITHUB_SHA: 'abc123',
				GITHUB_WORKFLOW: 'E2E wide',
			},
		})
	const calls = () => readFileSync(log, 'utf8').trim().split('\n')

	it('opens a new assigned issue when none is open with the title', () => {
		const result = run('')
		expect(result.status, result.stderr).toBe(0)
		// a törzs többsoros, ezért a teljes naplót nézzük
		const all = readFileSync(log, 'utf8')
		expect(all).toContain('issue create -R GuestGuru/x --title Bő sor bukás: E2E wide --body')
		expect(all).toContain('https://github.com/GuestGuru/x/actions/runs/7')
		expect(all).toMatch(/Commit: `abc123`\.\s--assignee kratam/)
	})

	it('comments on the open issue with the same title instead of opening another', () => {
		const result = run('12\n')
		expect(result.status, result.stderr).toBe(0)
		const lines = calls()
		expect(lines.some((line) => line.startsWith('issue comment 12 -R GuestGuru/x'))).toBe(true)
		expect(lines).toContain('issue edit 12 -R GuestGuru/x --add-assignee kratam')
		expect(lines.some((line) => line.startsWith('issue create'))).toBe(false)
	})

	it('fails loudly when gh fails', () => {
		writeFileSync(join(stubDir, 'gh'), '#!/bin/bash\nexit 1\n')
		expect(run('').status).not.toBe(0)
	})

	it('passes the token and inputs to the script', () => {
		const action = parse(readFileSync(join(actionDir, 'action.yml'), 'utf8'))
		expect(action.inputs.title.required).toBe(true)
		expect(action.inputs.assignee.default).toBe('kratam')
		const [step] = action.runs.steps
		expect(step.env.GH_TOKEN).toBe('${{ github.token }}')
		expect(step.run).toBe('bash "$GITHUB_ACTION_PATH/notify.sh"')
	})
})
