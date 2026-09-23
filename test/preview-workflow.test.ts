import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// A központi `preview.yml`-t nem lehet unit-tesztelni: a logikája egy GitHub
// Actions job, ami a Vercel API-val beszél. A SZERKEZETE viszont rögzíthető —
// és az IT-810 pont ott tört el: a késői elavulás-ág helyesen NEM írta felül az
// aliast, de ezt a döntést nem adta tovább a hívóknak, így azok üres
// `preview-url`-re futtatták a smoke-jukat, és piros státuszt írtak egy hibátlan
// commitra (GuestGuru/gg-ops#16, 2026-09-14).
//
// Ezek a tesztek a két elavulás-mérés és a hívók közti ÚT-at őrzik. Ha valaki
// újra elvágja, itt bukik el, nem egy idegen repó PR-jén, három nappal később.

type Step = { id?: string; name?: string; if?: string; run?: string }
type Workflow = {
	on?: { workflow_call?: { outputs?: Record<string, { value?: string }> } }
	jobs: Record<string, { outputs?: Record<string, string>; steps?: Step[] }>
}

const source = readFileSync(
	fileURLToPath(new URL('../.github/workflows/preview.yml', import.meta.url)),
	'utf8',
)
const workflow = parse(source) as Workflow & Record<string, unknown>

// YAML 1.1-ben az `on` kulcs boolean lenne; a `yaml` csomag 1.2-t olvas, ahol
// string marad. Mindkettőt elfogadjuk, hogy egy parser-frissítés ne némítsa el
// ezt a fájlt.
const workflowCall = (workflow.on ?? (workflow as Record<string, Workflow['on']>)['true'])
	?.workflow_call
const previewJob = workflow.jobs.preview
const aliasStep = previewJob?.steps?.find((s) => s.id === 'alias')

describe('preview.yml — az elavulás-jelzés útja a hívókig', () => {
	it('a job `stale` outputja MINDKÉT mérésből táplálkozik', () => {
		const value = previewJob?.outputs?.stale ?? ''
		// A korai, olcsó mérés a checkout előtt fut (`r`), a késői közvetlenül az
		// alias írása előtt (`alias`). IT-810 előtt csak az első szerepelt itt.
		expect(value).toContain('steps.r.outputs.stale')
		expect(value).toContain('steps.alias.outputs.stale')
	})

	it('a reusable workflow a job outputját adja tovább', () => {
		expect(workflowCall?.outputs?.stale?.value).toContain('jobs.preview.outputs.stale')
	})

	// Az alias-lépés egy kilépő ága a jelzőjétől a saját `exit 0`-jáig.
	const exitingBranch = (marker: string) => {
		const run = aliasStep?.run ?? ''
		const start = run.indexOf(marker)
		return start < 0 ? '' : run.slice(start, run.indexOf('exit 0', start))
	}

	it('a késői elavulás-ág `stale=true`-t ír, mielőtt kilép', () => {
		const branch = exitingBranch('became newer while this run was preparing')
		expect(branch).not.toBe('')
		expect(branch).toContain('stale=true')
		expect(branch).toContain('$GITHUB_OUTPUT')
	})

	it('a lezárt-PR-ág is `stale=true`-t ír, mielőtt kilép (IT-975)', () => {
		// A zárás `unalias` futása és egy korábban indult `deployment_status`
		// futás a runner-sorban helyet cserélhet (gg-sales#43, #54): az alias
		// írása előtt a PR állapota is mérés, és a hívó smoke-ja ugyanúgy kimarad.
		const branch = exitingBranch('is closed — leaving the alias alone')
		expect(branch).not.toBe('')
		expect(branch).toContain('stale=true')
		expect(branch).toContain('$GITHUB_OUTPUT')
		expect(aliasStep?.run).toContain('pulls/${PR}')
	})

	it('elavult deploymenten nem fut az alias-lépés (IT-780)', () => {
		expect(aliasStep?.if).toContain("steps.r.outputs.stale != 'true'")
	})
})
