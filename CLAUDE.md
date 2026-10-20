# gg-ci

A GuestGuru közös CI-infrastruktúrája: négy GitHub Actions workflow
(`quality-gate`, `policy-gate`, `preview`, `neon-preview`), egy TypeScript CLI, amit a
fogyasztó repók CI-ja hív, és a saját runner VM-jének üzemeltetési szkriptjei
(`runner/`). **A repó publikus**: titok nem kerülhet bele (l. lent).
Nincs deploy: a `main` maga a kiadás (a hívók `@main`-re hivatkoznak), a
`policy-gate.yml`-t pedig az org-ruleset egy immutable commit-SHA-ra pinneli.

A hívók teljes referenciája a **`README.md`** (l. lent); ez a fájl a munkamódot rögzíti.

## Futtatás, teszt

Node ≥ 24. Nincs lint és nincs build lépés.

```bash
npm ci
npm test            # vitest; GNU timeout/shellcheck nélkül pár teszt kimarad (CI futtatja)
npm run typecheck
npm run gg-ci -- <parancs> …     # preview CLI: ensure | destroy | refresh-ttl |
                                 # reset-shared | alias-set | alias-remove
npm run quality-gate -- '<needs-json>'
npm run workflow-policy -- <cél-repo-gyökér>
```

- **Tesztek (GG-szabály):** tesztírás előtt olvasd el: wiki [`tudas/gg-delivery/teszteles`](https://wiki.guest.guru/tudas/gg-delivery/teszteles) — kockázat szerint; vizuális, felirat- és forrásszöveg-teszt nem kerül a kapuba; PR-lánc ≤ 5 perc. A gg-ci kivétel a „konfig/workflow-szövegre nem írunk unit-tesztet” alól: itt a workflow maga a termék.
  Szűk sor (PR-kapu): `npm run typecheck && npm test` (ci.yml, ~30 mp).
  Bő sor: nincs; ma minden teszt a kapuban fut.

A repó térképe:

| hely | mit csinál |
|---|---|
| `.github/workflows/quality-gate.yml` | reusable végső kapu: a hívó `toJSON(needs)`-éből egy `quality-gate / verify` Check Run + egy konfigurálható commit status |
| `.github/workflows/policy-gate.yml` | az org-ruleset injektálja a CÉL-repóba, a pinelt gg-ci SHA-ról — a cél-PR nem tudja lecserélni |
| `.github/workflows/preview.yml` | a teljes preview-domain folyamat: PR + Vercel deployment feloldás, elavulás-döntés, alias, PR-komment |
| `.github/workflows/neon-preview.yml` | per-PR Neon branch + branch-scope-os Vercel preview env |
| `.github/actions/playwright-chromium/` | a Playwright-smoke-ok közös telepítő lépése (IT-1256): böngésző kötelező, apt best-effort, saját kerettel |
| `src/workflow-policy.ts` | a policy: per-repo `policies`, `approvedWorkflowInventories` (workflow-fájl → SHA-256), gg-runner invariánsok (IT-974), central-trust self-check, pin-diagnózis |
| `src/quality-gate.ts` | a `needs` kiértékelése (fail-closed) |
| `src/cli.ts`, `src/commands/`, `src/neon.ts`, `src/vercel.ts` | a preview CLI |
| `src/trust-inventory.json` | a központi bizalmi fájlok hash-manifestje |
| `runner/` | a gg-runner VM (gg-mb, Colima `ci` profil) szkriptjei: `disk-guard.sh` (JOB_COMPLETED hook), `playwright-install.sh` (a VM-ben `/opt/gg-playwright/telepit.sh`), `install.sh` (telepítés + visszamérés, `--check`), IT-1496 |
| `scheduled-dispatch/`, `.github/actions/wide-suite-failure/` | a bő tesztsorok gg-mb-s indítója és közös bukásjelzője (IT-1808, részletek: README); sima PR, re-pin nem kell |

## Kemény szabályok és csapdák

- **A repó publikus, ezért titok nem kerülhet bele** (IT-1496). **Tilos:** titok és
  hozzáférést adó adat (token, kulcs, jelszó, connection string, bypass-titok, privát
  kulcs), ügyfél- és személyes adat, közvetlenül kihasználható biztonsági részlet.
  **Mehet:** belső útvonal, VM- és profilnév, runner-szám, repó- és domainnév,
  app-specifikus alapérték, Vercel/Neon projekt- és team-ID. Őr:
  `test/secret-guard.test.ts`. Miért nem lehet privát: `docs/claude-md-reszletek.md`.
- **A fogyasztó repók PR-jai nem módosíthatják a saját `.github/workflows/`
  fájljaikat.** Bármelyik bájt megváltozása `Workflow content is not approved`,
  amíg a hash itt nincs jóváhagyva. A sorrend háromlépcsős, és a 2. lépés kézi:
  gg-ci PR (új hash az `approvedWorkflowInventories`-ben) → merge → **org-ruleset
  re-pin a friss `main` SHA-ra** → a cél-PR **close/reopen** (a két hívás közé kell
  ~8 mp szünet; a sima „re-run" nem elég, mert a `ref: job.workflow_sha` a régi pint
  örökli).
- **A gg-ci SAJÁT `.github/workflows/` fájljainak módosítása nehezebb**: candidate-SHA
  release-op (ruleset-pin a PR fejére → close/reopen → verify → merge → re-pin a friss
  mainre). Ezzel szemben a `src/`, a `README.md` és az `.github/actionlint.yaml`
  módosítása EGY sima PR — egyik sincs a workflow-inventoryban.
- **`src/workflow-policy.ts` módosításakor frissítsd a saját hashét** a
  `src/trust-inventory.json`-ban (`shasum -a 256 src/workflow-policy.ts`), különben a
  central-trust self-check bukik. Az `npm test` ezt lokálisan elkapja (IT-594).
- **A ruleset-pin globális, egyszálú erőforrás.** Soha ne fusson két gg-ci
  policy-lánc párhuzamosan (két agent, két session): egymás pinjét vágnák felül, és a
  tünet néma — org-szerte minden PR blokkolva marad.
- **Re-pin után minden nyitott GG-PR-t újra kell nyitni** (a `tools` repó
  delivery-doctorában: `pnpm chain reopen`). A re-pin visszamenőleg érvényteleníti a
  már lefutott policy-checket: a PR minden checkje `success` marad, a merge mégis
  `BLOCKED`, és a tünetből semmi nem árulja el az okot.
- **Egy kapu-hívás, nem kettő.** Külön `deployment-gate` job tilos — a policy hibát ad
  rá. Ugyanaz a `quality-gate` hívás publikálja a Check Runt és a commit statust
  (IT-295).
- **A `runs-on` nem input**, hanem egy kifejezés minden jobban:
  `${{ (github.event_name != 'schedule' && vars.GG_CI_RUNNER) || 'ubuntu-latest' }}`.
  A `vars` a HÍVÓ (ill. injektált workflow-nál a CÉL) repóra oldódik fel, ezért a
  hívóknak nincs teendőjük. **Ütemezett (`schedule`) futás mindig `ubuntu-latest`** —
  a saját runner aludhat. A változó törlése az egylépéses vészfék (IT-570).
- **Saját runneren nincs `setup-node` cache** (IT-966): a gg-ci workflow-iban
  `cache: ${{ runner.environment == 'github-hosted' && 'npm' || '' }}` +
  `package-manager-cache: false`, a hívók fix `gg-runner` jobjaiban nincs `cache:`.
  **A policy ellenőrzi** (IT-974, `validateRunnerInvariants`), a `packageManager`-es
  repókban (tools, gg-tracker) a `package-manager-cache: false` kötelező.
- **Saját runneren a `pnpm/action-setup` `dest`-je `${{ runner.temp }}/setup-pnpm`**
  (IT-971; a default a runner-példányok közös HOME-ja). **A policy ellenőrzi** (IT-974). A `services:` konténer viszont **nem köthet fix
  host-portot** (IT-924, közös Docker-daemon): `ports: - 5432` +
  `localhost:${{ job.services.<név>.ports['5432'] }}` — ezt a policy NEM ellenőrzi,
  hívói hash jóváhagyásakor nézd meg.
- **A `runner/` szkriptjei a VM-en élő példány forrása** (IT-1496): módosítás = sima
  PR (a `runner/` nincs a workflow-leltárban, re-pin nem kell), merge után a gg-mb-n
  `runner/install.sh` (csak az eltérőt írja, atomikus cserével, a runnereket nem indítja
  újra), drift-mérés: `runner/install.sh --check`. A VM-en kézzel ne szerkeszd őket.
- **A Playwright-telepítés a gg-ci közös actionje** (`.github/actions/playwright-chromium`,
  IT-1256); módosítása sima PR, re-pin nélkül, és minden hívóra hat. Workflow `run:`-ban
  nyers `playwright install`/`install-deps` tilos (a policy ellenőrzi). `defaults.run`-os
  hívónál a `working-directory` input kell (BPDBv2, irnok: `web`).
- **A PR-hoszt sima deployment-alias, SOHA nem projekt-domain** (IT-1046): az
  `alias-set` csak `<app>-pr-<n>.…` hosztot, csak a saját projekt preview-deployjára ír.
- **A `preview.yml` `stale`-döntései** (README „Preview domain”, és
  `docs/claude-md-reszletek.md`): elavult futás nem nyúl az aliashoz; olvashatatlan
  állapot = nem stale. A hívó smoke-ja a PR-számra ÉS a `stale`-re kapuzzon, a
  `preview-url` ürességére ne — az a valódi hibát nyelné el.
- **Minden action-referencia SHA-ra van pinelve** (IT-277), és a policy-evaluátorok
  üres `NODE_OPTIONS`-szel, `npm ci --ignore-scripts --userconfig=/dev/null`-lal
  futnak: a cél-repó npm-konfigurációja nem kerülhet a bizalmi útvonalba.
- A saját `ci.yml` szándékosan `ubuntu-latest`-en fut, és soha nem fogyaszt secretet,
  és soha nem használ `pull_request_target`-et (publikus repó, fork-PR-ek).

## Jelen állapot (mérve 2026-10-20)

Az org-ruleset (19620909) kötelező `quality-gate / verify` checkje 15 repót, a `GG smoke
gate` ruleset (19738275) 12 repót fed; a bekötést naponta a `tools` delivery-doctor méri.
A privát repók CI-ja saját runneren (`gg-runner`) fut, kivétel a `gg-sales` `ci` és a
`BPDBv2` (Blacksmith); a gg-ci-é a felhőben. A bő tesztsorokat a `scheduled-dispatch/`
indítja (IT-1808). Részletek, repólista, történet: `docs/claude-md-reszletek.md`.

## Hol van a többi tudás

- **`README.md`** — a fogyasztói referencia: minden workflow-input, teljes caller
  példák, az onboarding lépései, és a Vercel/Neon API-k éles méréssel szerzett
  viselkedése. Ha a hívó oldalról kérdeznek, ide nézz.
- **Wiki** (a szervezeti üzemeltetési tudás, a repón kívül):
  `gg_knowledge_get(topic: "gg-delivery")`, al-oldalak `doc: "ci-kapu"` (a kapu három
  rétege, a release-lánc parancsai, a standby-kapcsoló, a runner-üzemeltetés),
  `doc: "meresi-receptek"`, `doc: "repok-allapota"`.
- **`docs/superpowers/`** (spec + három terv, IT-244) — az eredeti kapu-tervezés és a
  mért kiindulóállapot.
- **Agent-memória** (`memoria` skill): keresés „gg-ci" — a döntéstörténet, a ruleset- és
  runner-azonosítók, a költség-mérések és a leckék ott élnek (`project: gg-ci`).
  Kulcsszavak: `workflow-policy`, `quality-gate`, `GG smoke gate`, `GG_CI_STANDBY`,
  `candidate-SHA`, `re-pin`, `self-hosted runner`.
- **Linear**: „Auth/Tools/CI/Tokens” projekt (sarokkövek: `docs/claude-md-reszletek.md`).
- **Kapcsolódó repók**: minden fogyasztó, és a `tools/packages/delivery-doctor`, ami
  naponta méri a bekötések driftjét.
