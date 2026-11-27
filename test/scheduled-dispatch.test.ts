import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// A bő tesztsorok gg-mb-s indítója (IT-1808): a lista formátuma, és a dispatch.sh
// hamis `gh`-val — a saját futását várja ki, a hibás indítás nem állítja meg a többit,
// a kilépési kód 1, a weekly sorok csak hétfőn mennek, a zár nem marad bent, és a
// launchd-mód csak 01 UTC-kor indít. A `changed` feltételű sor (IT-2165) kimarad, ha az ág
// fején a legutóbbi befejezett futás sikeres, és elindul, ha nem az, ha még nem volt, vagy ha
// ez nem állapítható meg.

const dir = new URL('../scheduled-dispatch/', import.meta.url).pathname
const dispatch = join(dir, 'dispatch.sh')
// A hamis gh: valódi JSON-on futtatja a --jq szűrőt, és a lógó hívása a SIGALRM-ot figyelmen
// kívül hagyja, ahogy a valódi gh. A viselkedését a fájl fejléce írja le.
const ghStub = new URL('./scheduled-dispatch-gh-stub.sh', import.meta.url).pathname

const has = (tool: string) =>
	spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim() !== ''
const hasShellcheck = has('shellcheck')
const hasJq = has('jq')

describe('scheduled-dispatch: shellcheck', () => {
	it.runIf(hasShellcheck || process.env.CI)('passes on dispatch.sh, install.sh and the gh stub', () => {
		const result = spawnSync('shellcheck', ['dispatch.sh', 'install.sh', ghStub], { cwd: dir, encoding: 'utf8' })
		expect(result.error).toBeUndefined()
		expect(result.stdout + result.stderr).toBe('')
		expect(result.status).toBe(0)
	})
})

describe('scheduled-dispatch: schedule.tsv', () => {
	it('every row has repo, workflow file, ref, a known frequency and at most a known condition', () => {
		const rows = readFileSync(join(dir, 'schedule.tsv'), 'utf8')
			.split('\n')
			.filter((line) => line.trim() !== '' && !line.startsWith('#'))
		expect(rows.length).toBeGreaterThan(0)
		for (const row of rows) {
			const [repo, workflow, ref, frequency, condition, ...rest] = row.split('\t')
			expect(rest, row).toEqual([])
			// az ötödik oszlop elhagyható; ha van, csak ismert feltétel lehet
			expect([undefined, 'changed'], row).toContain(condition)
			expect(repo, row).toMatch(/^[A-Za-z0-9_.-]+$/)
			expect(workflow, row).toMatch(/^[A-Za-z0-9_.-]+\.ya?ml$/)
			expect(ref, row).toBe('main')
			expect(['nightly', 'weekly'], row).toContain(frequency)
		}
	})
})

// Az ág feje a hamis gh szerint, és egy másik commit.
const headSha = 'a'.repeat(40)
const otherSha = 'b'.repeat(40)

// Egy futásrekord, ahogy a GitHub „List workflow runs” végpontja adja (a döntéshez használt
// mezőkkel). `conclusion: null` = még folyamatban lévő futás. Alapból a GuestGuru/a repó x.yml
// workflow-jának futása a main ág fején.
const record = (startedAt: string, conclusion: string | null, over: Record<string, unknown> = {}) => ({
	path: '.github/workflows/x.yml',
	head_sha: headSha,
	head_branch: 'main',
	status: conclusion === null ? 'in_progress' : 'completed',
	conclusion,
	created_at: startedAt,
	run_started_at: startedAt,
	run_attempt: 1,
	repository: { full_name: 'GuestGuru/a' },
	...over,
})
const day = (n: number) => `2026-11-${String(n).padStart(2, '0')}T01:30:00Z`

// Egy háttérben futó másik indító, ami a zárat tartja (ugyanaz a flock, mint a dispatch.sh-ban).
const holdLock = (lock: string) =>
	spawn('bash', [
		'-c',
		`exec 9>"$1"; perl -MFcntl=:flock -e 'open(my $fh, ">&=", 9) or exit 2; flock($fh, LOCK_EX | LOCK_NB) or exit 1' && echo locked && exec sleep 30`,
		'holder',
		lock,
	])

// Minden eset több bash/perl/stub processzt indít: terhelt gépen az 5 s-os alapkeret kevés.
describe.runIf(hasJq || process.env.CI)('scheduled-dispatch: dispatch.sh', { timeout: 20_000 }, () => {
	let tmp: string
	// A hamis GitHub állapota: a futásrekordok, és az ág feje hívásonként (az utolsó ismétlődik).
	const fixtures = (runs: object[], heads: string[] = [headSha]) => {
		writeFileSync(join(tmp, 'runs.json'), JSON.stringify(runs))
		writeFileSync(join(tmp, 'heads'), `${heads.join('\n')}\n`)
	}
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), 'gg-dispatch-'))
		writeFileSync(join(tmp, 'calls'), '')
		writeFileSync(join(tmp, 'argv'), '')
		fixtures([])
		writeFileSync(
			join(tmp, 'list.tsv'),
			['# komment', 'a\tx.yml\tmain\tnightly', 'b\ty.yml\tmain\tnightly', 'c\tz.yml\tmain\tweekly', ''].join('\n'),
		)
	})
	afterEach(() => rmSync(tmp, { recursive: true, force: true }))

	const env = (extra: Record<string, string>) => ({
		...process.env,
		GG_DISPATCH_GH: ghStub,
		GG_DISPATCH_LIST: join(tmp, 'list.tsv'),
		GG_DISPATCH_POLL_SECONDS: '0',
		GG_DISPATCH_LOCK: join(tmp, 'lock'),
		GG_DISPATCH_RUN_NOW: join(tmp, 'run-now'),
		GH_CALLS: join(tmp, 'calls'),
		GH_ARGV: join(tmp, 'argv'),
		FIXTURES: tmp,
		FAIL_REPO: 'nothing',
		NOURL_REPO: 'nothing',
		...extra,
	})
	// A szinkron gyerekfolyamatot a Vitest időkerete nem tudja megszakítani, ezért sajátot kap:
	// ha az indító beragadna (pl. egy időkeret nélküli hívásban), a futás itt ér véget, státusz
	// nélkül, és a teszt elbukik. A lógó stub-hívások ezért 300 mp-ig tartanának; faliórát nem mérünk.
	const run = (args: string[], extra: Record<string, string>) =>
		spawnSync('bash', [dispatch, ...args], {
			encoding: 'utf8',
			env: env(extra),
			timeout: 60_000,
			killSignal: 'SIGKILL',
		})
	const logged = (file: string, prefix: string) =>
		readFileSync(join(tmp, file), 'utf8')
			.split('\n')
			.filter((line) => line.startsWith(prefix))
	const calls = (prefix: string) => logged('calls', prefix)
	// ugyanazok a hívások argumentumhatárokkal: [arg1][arg2]…
	const argv = (prefix: string) => logged('argv', prefix)
	const dispatchedWorkflows = () => calls('workflow run').map((line) => line.split(' ')[2])

	it('dispatches only the nightly rows on a weekday other than Monday, and watches each own run', () => {
		const result = run([], { GG_DISPATCH_WEEKDAY: '3' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(calls('workflow run')).toEqual([
			'workflow run x.yml -R GuestGuru/a --ref main',
			'workflow run y.yml -R GuestGuru/b --ref main',
		])
		// pontosan a gh által visszaadott futást várja ki, nem egy listából keresett korábbit
		expect(calls('run watch')).toEqual([
			'run watch 1001 -R GuestGuru/a --exit-status --interval 0',
			'run watch 1002 -R GuestGuru/b --exit-status --interval 0',
		])
		expect(calls('run list')).toEqual([])
		// feltétel nélküli sorra nincs előzetes lekérdezés
		expect(calls('api')).toEqual([])
		expect(result.stdout).toContain('kész: success: https://github.com/GuestGuru/a/actions/runs/1001')
	})

	it('adds the weekly rows after the nightly ones on Monday', () => {
		const result = run([], { GG_DISPATCH_WEEKDAY: '1' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml', 'z.yml'])
	})

	it('keeps going after a failed dispatch and exits non-zero', () => {
		const result = run(['nightly'], { FAIL_REPO: 'GuestGuru/a' })
		expect(result.status).toBe(1)
		expect(calls('workflow run')).toHaveLength(2)
		expect(result.stdout).toContain('HIBA: nem indult: GuestGuru/a x.yml@main')
		expect(result.stdout).toContain('kész: success')
	})

	it('does not guess a run when gh returns no run URL', () => {
		const result = run(['nightly'], { NOURL_REPO: 'GuestGuru/a' })
		expect(result.status).toBe(1)
		expect(result.stdout).toContain('nem adta vissza a futás URL-jét: GuestGuru/a')
		expect(calls('run watch')).toHaveLength(1)
	})

	it('reports a failed run, goes on with the next row and exits non-zero', () => {
		const result = run(['nightly'], { WATCH_FAIL: '1001' })
		expect(result.status).toBe(1)
		expect(result.stdout).toContain('HIBA: failure: https://github.com/GuestGuru/a/actions/runs/1001')
		expect(result.stdout).toContain('kész: success: https://github.com/GuestGuru/b/actions/runs/1002')
	})

	it('re-watches the same run after a transient watch error while the run is still going', () => {
		const result = run(['nightly'], { WATCH_FLAKY: '1', VIEW_STATE: 'in_progress ' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(calls('run watch')).toEqual([
			'run watch 1001 -R GuestGuru/a --exit-status --interval 0',
			'run watch 1001 -R GuestGuru/a --exit-status --interval 0',
			'run watch 1002 -R GuestGuru/b --exit-status --interval 0',
		])
		expect(result.stdout).toContain('a futás nem ért véget (in_progress ), újra figyelem')
		expect(result.stdout).toContain('kész: success: https://github.com/GuestGuru/a/actions/runs/1001')
	})

	it('counts a run that finished successfully as success even if the watch errored', () => {
		const result = run(['nightly'], { WATCH_FAIL: '1001', VIEW_STATE: 'completed success' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(result.stdout).toContain('kész: success: https://github.com/GuestGuru/a/actions/runs/1001')
	})

	// A közös keret a watch utáni állapotlekérésre és az alvásra is érvényes: sem egy beragadt
	// `run view`, sem a keretnél hosszabb poll nem csúsztatja túl (mindkettő 300 mp-ig tartana).
	it.each([
		['a hanging run view', { VIEW_SLEEP: '300' }],
		['a poll longer than the remaining time', { VIEW_STATE: 'in_progress ', GG_DISPATCH_POLL_SECONDS: '300' }],
	])('keeps the wait budget after a watch error with %s', (_name, extra) => {
		const result = run(['weekly'], { WATCH_FLAKY: '1', GG_DISPATCH_WAIT_SECONDS: '3', ...extra })
		expect(result.status).toBe(1)
		expect(result.stdout).toContain('3 mp után sem ért véget')
	})

	it('stops waiting after GG_DISPATCH_WAIT_SECONDS and moves on to the next row', () => {
		const result = run(['nightly'], { WATCH_SLEEP: '300', GG_DISPATCH_WAIT_SECONDS: '2' })
		expect(result.status).toBe(1)
		// mindkét sor elindult, és mindkettő a saját keretének lejártakor adta fel a várakozást
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		expect(calls('run watch')).toHaveLength(2)
		expect(result.stdout.split('\n').filter((line) => line.includes('2 mp után sem ért véget'))).toHaveLength(2)
	})

	it('refuses to run while another dispatcher holds the lock', async () => {
		const holder = holdLock(join(tmp, 'lock'))
		await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()))
		const result = run(['nightly'], {})
		holder.kill('SIGKILL')
		expect(result.status).toBe(1)
		expect(result.stdout).toContain('már fut')
		expect(calls('workflow run')).toEqual([])
	})

	it('runs after the previous dispatcher was killed (no stale lock)', async () => {
		const holder = holdLock(join(tmp, 'lock'))
		await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()))
		holder.kill('SIGKILL')
		await new Promise((resolve) => holder.once('exit', resolve))
		const result = run(['nightly'], {})
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(calls('workflow run')).toHaveLength(2)
	})

	it('scheduled mode exits quietly outside 01 UTC and runs at 01 UTC', () => {
		const quiet = run(['scheduled'], { GG_DISPATCH_HOUR: '00', GG_DISPATCH_WEEKDAY: '3' })
		expect(quiet.status).toBe(0)
		expect(quiet.stdout).toBe('')
		expect(calls('workflow run')).toEqual([])

		const night = run(['scheduled'], { GG_DISPATCH_HOUR: '01', GG_DISPATCH_WEEKDAY: '1' })
		expect(night.status, night.stdout + night.stderr).toBe(0)
		expect(calls('workflow run')).toHaveLength(3)
	})

	it('scheduled mode runs once at any hour when the run-now file exists, and removes it', () => {
		writeFileSync(join(tmp, 'run-now'), '')
		const result = run(['scheduled'], { GG_DISPATCH_HOUR: '14', GG_DISPATCH_WEEKDAY: '3' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(result.stdout).toContain('kézi indítás (run-now)')
		expect(calls('workflow run')).toHaveLength(2)
		expect(existsSync(join(tmp, 'run-now'))).toBe(false)
	})

	// --- a `changed` feltétel (IT-2165) ---

	const conditionalList = () =>
		writeFileSync(
			join(tmp, 'list.tsv'),
			['a\tx.yml\tmain\tnightly\tchanged', 'b\ty.yml\tmain\tnightly', ''].join('\n'),
		)
	const skipped = 'kihagyva, a fej legutóbbi futása sikeres: GuestGuru/a x.yml@main (aaaaaaaaa)'
	const undetermined =
		'figyelmeztetés: nem állapítható meg, sikeres-e a fej legutóbbi futása, ezért elindul: GuestGuru/a x.yml@main'
	const moved =
		'az ág feje az ellenőrzés közben elmozdult vagy nem olvasható újra, ezért elindul: GuestGuru/a x.yml@main'

	it('skips a changed row when the latest attempt on the head of the branch is a completed success', () => {
		conditionalList()
		// A fejen a legutóbb indult kísérlet zöld. Minden más rekord olyan, amelyet valamelyik szűrő
		// kizár: ha a lekérdezésből kimaradna a commit, az ág vagy a workflow szűrője, egy újabb, nem
		// zöld rekord kerülne előre, és a sor (hibásan) elindulna.
		fixtures([
			record(day(20), 'failure'),
			record(day(21), 'success'),
			record(day(23), 'failure', { head_sha: otherSha }),
			record(day(24), 'failure', { head_branch: 'feature' }),
			record(day(25), 'failure', { path: '.github/workflows/other.yml' }),
			record(day(26), 'failure', { repository: { full_name: 'GuestGuru/zzz' } }),
		])
		const result = run(['nightly'], {})
		expect(result.status, result.stdout + result.stderr).toBe(0)
		// Pontosan ez a három olvasó hívás megy ki, és csak a feltételes sorra: az ág feje, a
		// workflow futásai ezen a commiton és ágon, majd kihagyás előtt újra a fej. A jq-program
		// szövegét nem rögzítjük: a stub valódi jq-val futtatja, a döntést a rekordok adják.
		const head = '[api][repos/GuestGuru/a/git/ref/heads/main][--jq][.object.sha]'
		expect(argv('[api]').map((line) => line.replace(/\[--jq\]\[ .*$/, '[--jq][…]'))).toEqual([
			head,
			`[api][repos/GuestGuru/a/actions/workflows/x.yml/runs?head_sha=${headSha}&branch=main&per_page=100][--jq][…]`,
			head,
		])
		expect(dispatchedWorkflows()).toEqual(['y.yml'])
		expect(argv('[workflow]')).toEqual(['[workflow][run][y.yml][-R][GuestGuru/b][--ref][main]'])
		expect(result.stdout).toContain(skipped)
	})

	it.each([
		['a failed run was followed by a green one', [record(day(20), 'failure'), record(day(21), 'success')]],
		[
			'an older failed run was re-run later and went green',
			[record(day(20), 'success', { run_started_at: day(26), run_attempt: 2 }), record(day(21), 'failure')],
		],
	])('skips a changed row when %s', (_name, runs) => {
		conditionalList()
		fixtures(runs)
		const result = run(['nightly'], {})
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatchedWorkflows()).toEqual(['y.yml'])
		expect(result.stdout).toContain(skipped)
	})

	// Nem hiba: a fejen egyszerűen nincs érvényes zöld bizonyíték, ezért a sor figyelmeztetés nélkül
	// indul. A legutóbb indult kísérlet dönt, tehát egy korábbi zöld nem takarja el a későbbi pirosat.
	it.each([
		['the head has no run yet', []],
		['a green run was followed by a failed one', [record(day(20), 'success'), record(day(21), 'failure')]],
		['the latest completed run was cancelled', [record(day(20), 'success'), record(day(21), 'cancelled')]],
		['the only run on the head is still in progress', [record(day(21), null)]],
		['a newer run is still in progress after a green one', [record(day(20), 'success'), record(day(21), null)]],
		['the latest run is still queued', [record(day(20), 'success'), record(day(21), null, { status: 'queued' })]],
		[
			// A bukott futást épp újrafuttatják: a rekordja már nem mutatja a korábbi bukást, de a még
			// tartó kísérlet nem zöld bizonyíték, és nem takarhatja el a régebbi zöld futás.
			'a failed run is being re-run while an older run is green',
			[record(day(20), 'success'), record(day(21), null, { run_started_at: day(26), run_attempt: 2 })],
		],
		[
			'an older green run was re-run later and failed, although a newer run is green',
			[record(day(20), 'failure', { run_started_at: day(26), run_attempt: 2 }), record(day(21), 'success')],
		],
		['the only green run is on another branch', [record(day(21), 'success', { head_branch: 'feature' })]],
		['the only green run is on another commit', [record(day(21), 'success', { head_sha: otherSha })]],
		[
			'the only green run belongs to another workflow',
			[record(day(21), 'success', { path: '.github/workflows/other.yml' })],
		],
	])('dispatches a changed row without a warning when %s', (_name, runs) => {
		conditionalList()
		fixtures(runs)
		const result = run(['nightly'], {})
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		expect(result.stdout).not.toContain('kihagyva')
		expect(result.stdout).not.toContain('nem állapítható meg')
		expect(result.stdout).not.toContain('elmozdult')
	})

	// A kihagyás előtt az ág fejét újra kiolvassa: ha közben új commit érkezett (vagy a fej nem
	// olvasható), a zöld bizonyíték már nem a mostani fejre szól, ezért a sor elindul.
	it.each([
		['the branch moved to another commit during the check', [headSha, otherSha], {}],
		['the head cannot be read again', [headSha], { HEAD_FAIL_AT: '2' }],
		['the second read returns no commit SHA', [headSha, 'null'], {}],
	])('dispatches a changed row with a green head when %s', (_name, heads, extra) => {
		conditionalList()
		fixtures([record(day(21), 'success')], heads)
		const result = run(['nightly'], extra)
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		expect(result.stdout).toContain(moved)
		expect(result.stdout).not.toContain('kihagyva')
	})

	// Fail-open: kihagyni csak pozitív bizonyítékra szabad. Ha a változás nem állapítható meg, a sor
	// elindul — egy fölös futás olcsóbb, mint egy csendben kimaradó tesztsor. A fejen minden esetben
	// van zöld futás, tehát a sor kimaradna, ha a hibás ág nem érvényesülne. A shell a szűrőtől
	// egyetlen rögzített szót fogad el zöldként; a nyers válaszok itt a szűrő helyett jönnek.
	it.each([
		['the head lookup fails', {}, { HEAD_FAIL_AT: 'all' }],
		['the head lookup returns no commit SHA', { heads: ['null'] }, {}],
		['the run lookup fails', {}, { RUNS_FAIL: '1' }],
		['the run lookup prints a green answer but exits non-zero', {}, { RUNS_EXIT: '1' }],
		['the run lookup returns nothing', {}, { RUNS_RAW: '' }],
		['the answer only starts with green', {}, { RUNS_RAW: 'greenish' }],
		['the answer is green with a different case', {}, { RUNS_RAW: 'Green' }],
		['the answer has something after green', {}, { RUNS_RAW: 'green success' }],
		['the answer is a run projection instead of a verdict', {}, { RUNS_RAW: `${headSha} main completed success` }],
		['the answer is a count instead of a verdict', {}, { RUNS_RAW: '3' }],
		['the history is reported as truncated', {}, { RUNS_RAW: 'truncated' }],
		['the latest attempt is reported as ambiguous', {}, { RUNS_RAW: 'ambiguous' }],
		['the latest attempt is reported as unexpected', {}, { RUNS_RAW: 'unexpected' }],
	])('dispatches a changed row with a warning when %s', (_name, state, extra) => {
		conditionalList()
		fixtures([record(day(21), 'success')], (state as { heads?: string[] }).heads)
		const result = run(['nightly'], extra)
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(result.stdout).toContain(undetermined)
		expect(result.stdout).not.toContain('kihagyva')
	})

	// A szűrő rögzített válaszai közül csak a `green` hagy ki; a többi ismert válasz csendben indít.
	it.each([['none'], ['red'], ['active']])('dispatches a changed row quietly when the verdict is %s', (verdict) => {
		conditionalList()
		const result = run(['nightly'], { RUNS_RAW: verdict })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		expect(result.stdout).not.toContain('nem állapítható meg')
	})

	it('rejects a ref that cannot be put into the filter unquoted, and dispatches the row', () => {
		writeFileSync(join(tmp, 'list.tsv'), ['a\tx.yml\tma"in\tnightly\tchanged', ''].join('\n'))
		fixtures([record(day(21), 'success', { head_branch: 'ma"in' })])
		const result = run(['nightly'], {})
		expect(calls('api')).toEqual([])
		expect(calls('workflow run')).toEqual(['workflow run x.yml -R GuestGuru/a --ref ma"in'])
		expect(result.stdout).toContain('nem állapítható meg')
	})

	// Ha a futások listájából nem derül ki egyértelműen a legutóbbi kísérlet, az indító nem
	// találgat: a sor figyelmeztetéssel elindul. A válaszok itt a valódi szűrőből jönnek.
	it.each([
		[
			'the history does not fit on one page',
			Array.from({ length: 101 }, (_, i) => record(`2026-10-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, 'success')),
		],
		[
			'two attempts started in the same second',
			[record(day(21), 'success'), record(day(21), 'failure')],
		],
		['the latest start time is missing', [record(day(21), 'success', { run_started_at: null })]],
		[
			// a dátum nélküli piros futás nem tűnhet el a dátummal rendelkező zöld mögött
			'a failed run without a start time stands next to a dated green one',
			[record(day(21), 'success'), record(day(22), 'failure', { run_started_at: null })],
		],
		['a start time is an empty string', [record(day(21), 'success'), record(day(22), 'failure', { run_started_at: '' })]],
		['the start time of a green run is a number', [record(day(21), 'success', { run_started_at: 1764200000 })]],
		['the start time is not a UTC timestamp', [record(day(21), 'success', { run_started_at: '2026-11-21 01:30' })]],
		['a start time is the zero date', [record(day(21), 'success'), record('0000-00-00T00:00:00Z', 'failure')]],
		['a start time ends with a newline', [record(day(21), 'success', { run_started_at: `${day(21)}\n` })]],
		// A mezőket a jq hasonlítja össze a JSON-értékeken: amit a shell levágna vagy elnyelne
		// (kimenet végi sortörés, NUL bájt), az nem adhat zöld választ.
		['the conclusion is success followed by a newline', [record(day(21), 'success\n')]],
		['the conclusion contains a NUL byte', [record(day(21), 'succ\u0000ess')]],
		['the status is completed followed by a newline', [record(day(21), 'success', { status: 'completed\n' })]],
		['the status is unknown', [record(day(21), 'success', { status: 'sleeping' })]],
		['the conclusion is unknown', [record(day(21), 'weird')]],
		['a completed run has no conclusion', [record(day(21), null, { status: 'completed' })]],
	])('dispatches a changed row with a warning when %s', (_name, runs) => {
		conditionalList()
		fixtures(runs)
		const result = run(['nightly'], {})
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(result.stdout).toContain(undetermined)
		expect(result.stdout).not.toContain('kihagyva')
	})

	// Ha a GitHub nem alkalmazná a kérés szűrőit, a legutóbbi kísérlet más commitra vagy ágra
	// szólhatna: a szűrő ezt maga is ellenőrzi, és nem fogadja el zöldnek.
	it.each([
		['another commit', { head_sha: otherSha }],
		['another branch', { head_branch: 'feature' }],
		['a branch that differs only in case', { head_branch: 'Main' }],
	])('dispatches with a warning when the latest attempt returned is green but for %s', (_name, over) => {
		conditionalList()
		fixtures([record(day(20), 'success'), record(day(21), 'success', over)])
		const result = run(['nightly'], { RUNS_IGNORE_FILTERS: '1' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		expect(result.stdout).toContain(undetermined)
	})

	// A lógó hívás 300 mp-ig tartana, és a SIGALRM-ot figyelmen kívül hagyja, mint a valódi gh. Ha
	// az indító nem állítaná le, a futtató 60 mp-es saját kerete érne véget, státusz nélkül. A keret
	// 3 mp, hogy terhelt gépen a rendben lefutó hívások se fussanak ki belőle.
	it.each([
		['head lookup', { HEAD_SLEEP: '300' }, 1],
		['run lookup', { RUNS_SLEEP: '300' }, 2],
	])('stops a hanging %s after GG_DISPATCH_CALL_SECONDS and dispatches the row', (_name, extra, lookups) => {
		conditionalList()
		fixtures([record(day(21), 'success')])
		const result = run(['nightly'], { GG_DISPATCH_CALL_SECONDS: '3', ...extra })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		expect(result.stdout).toContain(undetermined)
		// a szándékolt hívásnál állt meg: a fej lekérdezése után nincs több, a futásoké a második
		expect(calls('api')).toHaveLength(lookups)
		expect(calls('api')[lookups - 1]).toContain(lookups === 1 ? '/git/ref/heads/main' : '/runs?')
	})

	it('stops a hanging dispatch after GG_DISPATCH_CALL_SECONDS, does not retry it, and goes on', () => {
		const result = run(['nightly'], { GG_DISPATCH_CALL_SECONDS: '3', RUN_SLEEP_FIRST: '300' })
		expect(result.status).toBe(1)
		expect(calls('workflow run')).toEqual([
			'workflow run x.yml -R GuestGuru/a --ref main',
			'workflow run y.yml -R GuestGuru/b --ref main',
		])
		expect(result.stdout).toContain(
			'HIBA: az indítás 3 mp alatt nem válaszolt (a futás ettől még létrejöhetett), továbblépek: GuestGuru/a x.yml@main',
		)
		// a lógó indítás futását nem figyeljük (nincs URL-je), a következő sorét igen
		expect(calls('run watch')).toHaveLength(1)
		expect(result.stdout).toContain('kész: success')
	})

	it('kills a hanging lookup that ignores SIGTERM as well, and goes on', () => {
		conditionalList()
		fixtures([record(day(21), 'success')])
		const result = run(['nightly'], { GG_DISPATCH_CALL_SECONDS: '2', HEAD_SLEEP: '300', HANG_IGNORE_TERM: '1' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		expect(result.stdout).toContain(undetermined)
	})

	// Ha a GG_DISPATCH_GH egy burkolószkript, amely a gh-t gyerekként indítja, a közvetlen gyerek
	// leállítása nem elég: a lógó unoka nyitva tartaná a kimenetet. A keret az egész csoportra szól.
	it('stops a hanging call that runs as a child of the command, not as the command itself', () => {
		conditionalList()
		fixtures([record(day(21), 'success')])
		const result = run(['nightly'], { GG_DISPATCH_CALL_SECONDS: '3', HEAD_SLEEP: '300', HANG_AS_CHILD: '1' })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		expect(result.stdout).toContain(undetermined)
	})

	it('does not mistake a command that exits 142 by itself for an expired deadline', () => {
		const result = run(['nightly'], { FAIL_REPO: 'GuestGuru/a', RUN_EXIT: '142' })
		expect(result.status).toBe(1)
		expect(result.stdout).toContain('HIBA: nem indult: GuestGuru/a x.yml@main')
		expect(result.stdout).not.toContain('nem válaszolt')
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
	})

	// Egy elgépelt keret nem kapcsolhatja ki a határidőt (a nulla vagy nem szám `alarm` nem jár le),
	// és nem állíthatja meg a ciklust aritmetikai hibával: az alapérték lép a helyére.
	it.each([
		['GG_DISPATCH_CALL_SECONDS', '0', '60'],
		['GG_DISPATCH_CALL_SECONDS', 'abc', '60'],
		['GG_DISPATCH_WAIT_SECONDS', '-5', '5400'],
		['GG_DISPATCH_WAIT_SECONDS', '1e3', '5400'],
		['GG_DISPATCH_POLL_SECONDS', 'soon', '30'],
	])('falls back to the default when %s is %s', (name, value, fallback) => {
		const result = run(['nightly'], { [name]: value })
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(result.stdout).toContain(`figyelmeztetés: érvénytelen ${name} (${value}), az alapérték (${fallback}) érvényes`)
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		expect(result.stderr).toBe('')
	})

	// A `08` számnak látszik, de a bash aritmetikájában hibás oktális érték, a gh pedig elutasítja
	// intervallumként. Érvényesítés nélkül a várakozási ágon a ciklus megszakadt, a második sor
	// kimaradt, és a kör mégis sikeresnek jelentette magát.
	it('replaces a poll interval with a leading zero and still reaches the next row', () => {
		const result = run(['nightly'], {
			GG_DISPATCH_POLL_SECONDS: '08',
			GG_DISPATCH_WAIT_SECONDS: '3',
			WATCH_FLAKY: '1',
			VIEW_STATE: 'in_progress ',
		})
		expect(result.stdout).toContain('figyelmeztetés: érvénytelen GG_DISPATCH_POLL_SECONDS (08), az alapérték (30) érvényes')
		expect(calls('run watch')[0]).toBe('run watch 1001 -R GuestGuru/a --exit-status --interval 30')
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		expect(result.stdout).not.toContain('megszakadt')
		expect(result.stderr).toBe('')
	})

	// Ha az indítót egy felügyelt hívás közben leállítják, a zárat senki sem tarthatja tovább:
	// a következő indítás azonnal mehet, akkor is, ha a félbemaradt hívás még él.
	it('releases the lock when the dispatcher is killed during a supervised call', async () => {
		conditionalList()
		const first = spawn('bash', [dispatch, 'nightly'], {
			env: env({ HEAD_SLEEP: '15', GG_DISPATCH_CALL_SECONDS: '10' }),
			stdio: 'ignore',
		})
		// megvárjuk, amíg a fej lekérdezése elindul (a hívás megjelenik a naplóban)
		for (let i = 0; i < 200 && calls('api').length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50))
		expect(calls('api')).toHaveLength(1)
		first.kill('SIGKILL')
		await new Promise((resolve) => first.once('exit', resolve))
		const second = run(['nightly'], {})
		expect(second.stdout).not.toContain('már fut')
		expect(second.status, second.stdout + second.stderr).toBe(0)
	})

	it('releases the lock when the dispatcher is killed while it sleeps between two watches', async () => {
		// az első watch hibázik, a futás még tart: az indító a következő figyelés előtt alszik
		const first = spawn('bash', [dispatch, 'nightly'], {
			env: env({ WATCH_FLAKY: '1', VIEW_STATE: 'in_progress ', GG_DISPATCH_POLL_SECONDS: '10' }),
			stdio: 'ignore',
		})
		// megvárjuk, amíg az indítónak tényleg van alvó gyereke (nem a `run view` fut még)
		const sleeping = () => spawnSync('pgrep', ['-P', String(first.pid), '-x', 'sleep']).status === 0
		for (let i = 0; i < 200 && !sleeping(); i++) await new Promise((resolve) => setTimeout(resolve, 50))
		expect(sleeping()).toBe(true)
		first.kill('SIGKILL')
		await new Promise((resolve) => first.once('exit', resolve))
		const second = run(['weekly'], {})
		expect(second.stdout).not.toContain('már fut')
		expect(second.status, second.stdout + second.stderr).toBe(0)
	})

	it('reports an unknown condition, still dispatches the row and exits non-zero', () => {
		writeFileSync(join(tmp, 'list.tsv'), ['a\tx.yml\tmain\tnightly\tsometimes', ''].join('\n'))
		fixtures([record(day(21), 'success')])
		const result = run(['nightly'], {})
		expect(result.status).toBe(1)
		expect(calls('api')).toEqual([])
		expect(calls('workflow run')).toEqual(['workflow run x.yml -R GuestGuru/a --ref main'])
		expect(result.stdout).toContain(
			'HIBA: ismeretlen feltétel (sometimes), a sor feltétel nélkül indul: GuestGuru/a x.yml@main',
		)
	})

	it('applies the condition per frequency: a changed weekly row is not looked up on a weekday', () => {
		writeFileSync(
			join(tmp, 'list.tsv'),
			['a\tx.yml\tmain\tnightly', 'c\tz.yml\tmain\tweekly\tchanged', ''].join('\n'),
		)
		fixtures([
			record(day(21), 'success', { path: '.github/workflows/z.yml', repository: { full_name: 'GuestGuru/c' } }),
		])
		const weekday = run([], { GG_DISPATCH_WEEKDAY: '3' })
		expect(weekday.status, weekday.stdout + weekday.stderr).toBe(0)
		expect(calls('api')).toEqual([])
		expect(calls('workflow run')).toEqual(['workflow run x.yml -R GuestGuru/a --ref main'])

		const monday = run([], { GG_DISPATCH_WEEKDAY: '1' })
		expect(monday.status, monday.stdout + monday.stderr).toBe(0)
		// hétfőn a nightly sor újra megy, a zöld fejű weekly sor kimarad
		expect(calls('workflow run')).toHaveLength(2)
		expect(monday.stdout).toContain('kihagyva, a fej legutóbbi futása sikeres: GuestGuru/c z.yml@main')
	})

	// --- a lista: sem a sorvég, sem egy hibás sor miatt nem maradhat ki csendben egy tesztsor ---

	it('dispatches the last row even when the list does not end with a newline', () => {
		writeFileSync(join(tmp, 'list.tsv'), 'a\tx.yml\tmain\tnightly\nb\ty.yml\tmain\tnightly\tchanged')
		const result = run(['nightly'], {})
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatchedWorkflows()).toEqual(['x.yml', 'y.yml'])
		// a feltétel az utolsó, sortörés nélküli sorban is érvényes: a b sorra volt lekérdezés
		expect(calls('api').length).toBeGreaterThan(0)
	})

	it('reads a list with CRLF line endings: the frequency and the condition still match', () => {
		writeFileSync(
			join(tmp, 'list.tsv'),
			['# komment', 'a\tx.yml\tmain\tnightly\tchanged', 'b\ty.yml\tmain\tnightly', ''].join('\r\n'),
		)
		fixtures([record(day(21), 'success')])
		const result = run(['nightly'], {})
		expect(result.status, result.stdout + result.stderr).toBe(0)
		expect(dispatchedWorkflows()).toEqual(['y.yml'])
		expect(result.stdout).toContain(skipped)
		expect(result.stdout).not.toContain('HIBA')
	})

	it('reports every malformed row once, skips it, runs the rest and exits non-zero', () => {
		writeFileSync(
			join(tmp, 'list.tsv'),
			[
				'# komment',
				'a\tx.yml\t\tnightly\tchanged', // üres ref: a mezők nem csúszhatnak el
				'b\ty.yml\tmain\tnightly',
				'c\tz.yml\tmain\tsometimes', // ismeretlen gyakoriság
				'd\tw.yml\tmain\tweekly\tchanged\textra', // túl sok mező
				'e\tv.yml\tmain', // túl kevés mező
				'\tu.yml\tmain\tnightly', // üres repó
				'f\tt.yml\t\tmain\tnightly', // üres mező középen: összevonva érvényes sornak látszana
				'',
			].join('\n'),
		)
		// mindkét gyakoriság fut: a hibás sor ettől még csak egyszer jelenik meg
		const result = run(['all'], {})
		expect(result.status).toBe(1)
		expect(dispatchedWorkflows()).toEqual(['y.yml'])
		expect(calls('api')).toEqual([])
		const errors = result.stdout.split('\n').filter((line) => line.includes('HIBA: hibás sor a listában'))
		expect(errors.map((line) => line.replace(/^\S+ /, '').replace(/\t/g, '→'))).toEqual([
			'HIBA: hibás sor a listában, nem indítható (2. sor): a→x.yml→→nightly→changed',
			'HIBA: hibás sor a listában, nem indítható (4. sor): c→z.yml→main→sometimes',
			'HIBA: hibás sor a listában, nem indítható (5. sor): d→w.yml→main→weekly→changed→extra',
			'HIBA: hibás sor a listában, nem indítható (6. sor): e→v.yml→main',
			'HIBA: hibás sor a listában, nem indítható (7. sor): →u.yml→main→nightly',
			'HIBA: hibás sor a listában, nem indítható (8. sor): f→t.yml→→main→nightly',
		])
	})

	it.each([
		['has no dispatchable row', '# csak komment\n\n', 'HIBA: a listában nincs indítható sor'],
		['cannot be read', null, 'HIBA: a lista nem olvasható'],
	])('exits non-zero without dispatching when the list %s', (_name, content, message) => {
		if (content === null) rmSync(join(tmp, 'list.tsv'))
		else writeFileSync(join(tmp, 'list.tsv'), content)
		const result = run(['nightly'], {})
		expect(result.status).toBe(1)
		expect(result.stdout).toContain(message)
		expect(readFileSync(join(tmp, 'calls'), 'utf8')).toBe('')
	})
})
