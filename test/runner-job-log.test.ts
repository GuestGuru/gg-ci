import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// A runner job-naplója (IT-2011): hamis /proc-kal és GITHUB_* környezettel fut,
// a valódi jq-val. A kezdési idő ISO-alakja GNU date-et kér, ezért azt nem méri.

const script = new URL('../runner/job-log.sh', import.meta.url).pathname
const hasJq = spawnSync('/bin/sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim() !== ''

describe.runIf(hasJq || process.env.CI)('runner/job-log.sh (IT-2011)', () => {
	let root: string
	let proc: string
	const logFile = () => join(root, 'runner-hooks', 'job-log.jsonl')

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'gg-ci-job-log-'))
		proc = join(root, 'proc')
		const now = Math.floor(Date.now() / 1000)
		// a VM 1000 s-a fut; a Worker 700 s-nál indult (100 Hz) → 300 s-os job
		mkdirSync(proc)
		writeFileSync(join(proc, 'stat'), `cpu 1 2 3\nbtime ${now - 1000}\n`)
		writeFileSync(join(proc, 'loadavg'), '3.25 2.00 1.00 2/300 4242\n')
		writeFileSync(join(proc, 'meminfo'), 'MemTotal: 10000000 kB\nMemAvailable: 4096000 kB\n')
		for (const pid of ['4242', '77']) {
			mkdirSync(join(proc, pid))
			writeFileSync(join(proc, pid, 'comm'), 'Runner.Worker\n')
		}
		// utime stime cutime cstime = 100 50 30000 9850 tick → 400 CPU-s
		writeFileSync(
			join(proc, '4242', 'stat'),
			'4242 (Runner.Worker) S 1 2 3 4 5 6 7 8 9 10 100 50 30000 9850 20 0 1 0 70000 999 1\n',
		)
	})

	afterEach(() => {
		rmSync(root, { recursive: true, force: true })
	})

	const run = (env: Record<string, string>) => {
		const result = spawnSync('/bin/bash', [script], {
			encoding: 'utf8',
			env: {
				PATH: process.env.PATH ?? '/usr/bin:/bin',
				HOME: root,
				JOB_LOG_PROC: proc,
				JOB_LOG_WORKER_PID: '4242',
				GITHUB_REPOSITORY: 'GuestGuru/gg-inbox',
				GITHUB_WORKFLOW: 'ci',
				GITHUB_JOB: 'test',
				GITHUB_RUN_ID: '123',
				RUNNER_NAME: 'gg-ci-vm-2',
				...env,
			},
		})
		return { status: result.status, out: result.stdout + result.stderr }
	}
	const lines = () =>
		readFileSync(logFile(), 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l))

	it('logs a pull_request job with duration, CPU, issue and VM context', () => {
		const event = join(root, 'event.json')
		writeFileSync(
			event,
			JSON.stringify({
				pull_request: {
					number: 17,
					title: 'feat: inbox szűrő (IT-1999)',
					head: { ref: 'agent/task-abc' },
					user: { login: 'kratam' },
				},
			}),
		)
		const r = run({ GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'pull_request' })
		expect(r.status).toBe(0)
		expect(r.out).toContain('CI job-napló:')
		const [line] = lines()
		expect(line).toMatchObject({
			repo: 'GuestGuru/gg-inbox',
			workflow: 'ci',
			job: 'test',
			run_id: 123,
			event: 'pull_request',
			head_ref: 'agent/task-abc',
			pr: 17,
			pr_author: 'kratam',
			issue: 'IT-1999',
			agent: 'autoagent',
			cpu_s: 400,
			runner: 'gg-ci-vm-2',
			workers_running: 2,
			vm_load1: 3.25,
			vm_mem_avail_mb: 4000,
		})
		expect(line.duration_s).toBeGreaterThanOrEqual(299)
		expect(line.duration_s).toBeLessThanOrEqual(302)
		expect(line.cpu_cores).toBeCloseTo(400 / line.duration_s, 1)
	})

	it('takes the issue from the branch first and the agent from a push commit trailer', () => {
		const event = join(root, 'event.json')
		writeFileSync(
			event,
			JSON.stringify({
				head_commit: {
					message:
						'fix: valami (IT-5)\n\nClaude-Session: https://claude.ai/code/session_01ABCdef\n',
				},
			}),
		)
		run({ GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'it-2011-ci-job-log' })
		expect(lines()[0]).toMatchObject({
			issue: 'IT-2011',
			agent: 'claude',
			session: 'session_01ABCdef',
			pr: null,
			head_ref: null,
		})
	})

	it('never fails the job: no Worker, no event file, unwritable log', () => {
		const noWorker = run({ JOB_LOG_WORKER_PID: '999999' })
		expect(noWorker.status).toBe(0)
		expect(lines()[0]).toMatchObject({ cpu_s: null, duration_s: null, issue: null, repo: 'GuestGuru/gg-inbox' })

		const unwritable = run({ JOB_LOG_FILE: join(root, 'event.json', 'x', 'log.jsonl') })
		expect(unwritable.status).toBe(0)
	})

	it('rotates the log above the size limit', () => {
		mkdirSync(join(root, 'runner-hooks'))
		writeFileSync(logFile(), 'x'.repeat(100))
		run({ JOB_LOG_MAX_BYTES: '50' })
		expect(readFileSync(`${logFile()}.1`, 'utf8')).toBe('x'.repeat(100))
		expect(lines()).toHaveLength(1)
	})
})
