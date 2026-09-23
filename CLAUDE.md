# gg-ci

A GuestGuru közös, alkalmazás-független CI-infrastruktúrája: négy GitHub Actions
workflow (`quality-gate`, `policy-gate`, `preview`, `neon-preview`) és egy TypeScript
CLI, amit a fogyasztó repók CI-ja hív. **A repó publikus**, és szándékosan csak
általános ragasztó-kódot tartalmaz — minden alkalmazás-specifikus érték input.
Nincs deploy: a `main` maga a kiadás (a hívók `@main`-re hivatkoznak), a
`policy-gate.yml`-t pedig az org-ruleset egy immutable commit-SHA-ra pinneli.

A hívók teljes referenciája (inputok, példa-workflow-k, Vercel/Neon API-tanulságok)
a **`README.md`-ben** van — ez a fájl nem duplikálja, csak a munkamódot rögzíti.

## Futtatás, teszt

Node ≥ 24. Nincs lint és nincs build lépés.

```bash
npm ci
npm test            # vitest run — 12 fájl, 150 teszt, ~2 s (mérve 2026-09-23)
npm run typecheck
npm run gg-ci -- <parancs> …     # preview CLI: ensure | destroy | refresh-ttl |
                                 # reset-shared | alias-set | alias-remove
npm run quality-gate -- '<needs-json>'
npm run workflow-policy -- <cél-repo-gyökér>
```

A repó térképe:

| hely | mit csinál |
|---|---|
| `.github/workflows/quality-gate.yml` | reusable végső kapu: a hívó `toJSON(needs)`-éből egy `quality-gate / verify` Check Run + egy konfigurálható commit status |
| `.github/workflows/policy-gate.yml` | az org-ruleset injektálja a CÉL-repóba, a pinelt gg-ci SHA-ról — a cél-PR nem tudja lecserélni |
| `.github/workflows/preview.yml` | a teljes preview-domain folyamat: PR + Vercel deployment feloldás, elavulás-döntés, alias, PR-komment |
| `.github/workflows/neon-preview.yml` | per-PR Neon branch + branch-scope-os Vercel preview env |
| `src/workflow-policy.ts` | a policy: per-repo `policies`, `approvedWorkflowInventories` (workflow-fájl → SHA-256), gg-runner invariánsok (IT-974), central-trust self-check, pin-diagnózis |
| `src/quality-gate.ts` | a `needs` kiértékelése (fail-closed) |
| `src/cli.ts`, `src/commands/`, `src/neon.ts`, `src/vercel.ts` | a preview CLI |
| `src/trust-inventory.json` | a központi bizalmi fájlok hash-manifestje |

## Kemény szabályok és csapdák

- **Ebbe a repóba nem kerül infrastruktúra-azonosító**: Vercel/Neon projekt- vagy
  team-ID, connection string, domain, token, app-specifikus default érték. Minden
  ilyen workflow-input. Ellenőrzés: `git grep -icE 'prj_|team_|neondb_owner'` → 0.
  Emiatt nem lehet privát sem: a reusable workflow-k saját magukat checkoutolják a
  HÍVÓ `GITHUB_TOKEN`-jével, ami privát gg-ci-t nem lát (IT-285, élesben mérve).
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
  A perzisztens runner `~/.npm`-je megmarad, a GitHub-cache ott ~1 GB letöltés volt,
  jobonként 50–100 s (a jobidő 70–80%-a). Új workflow-ban se tedd vissza. **A policy
  ellenőrzi** (IT-974, `validateRunnerInvariants`): minden inventory-fájl minden
  gg-runneres jobján (`runs-on`-ban `gg-runner` vagy `GG_CI_RUNNER`) a `cache:`
  tilos (csak a fenti feltételes alak megy át), a `package-manager-cache: false`
  pedig ott kötelező, ahol a cél-repó gyökér `package.json`-ja `packageManager`-t
  deklarál (ma: tools, gg-tracker) — pontosan ekkor kapcsolná vissza a setup-node v5.
- **Saját runneren a `pnpm/action-setup` `dest`-je `${{ runner.temp }}/setup-pnpm`**
  (IT-971). A default `~/setup-pnpm` a két runner-példány közös HOME-jában van, az
  action pedig minden jobban törli és újratelepíti, így két egyszerre induló job
  egymás alól törli a pnpm-et. **A policy ellenőrzi** (IT-974): gg-runneres jobban a
  `pnpm/action-setup` `with.dest`-je pontosan ez kell legyen, különben a policy-gate
  megnevezi a fájlt, a jobot és a lépést. Mérve 2026-09-23: a 12 ruleset-repó
  `main`-jén 35 gg-runneres job, 35 setup-node és 8 pnpm lépés, nulla sértés.
- **Saját runneren a `services:` konténer nem köthet fix host-portot** (IT-924). A két
  runner-példány közös Docker-daemont használ: `5432:5432` mellett két párhuzamos job
  közül a második `docker start`-ja bukik, és a main `GG deployment gate`-je is elesett
  már. Helyesen `ports: - 5432`, az elérés `localhost:${{ job.services.<név>.ports['5432'] }}`
  (a job a hoszton fut, nincs `container:`). Hívói hash jóváhagyásakor ezt is nézd meg —
  ezt a policy (IT-974) NEM ellenőrzi.
- **A deploy UTÁN nyíló PR-t a `preview.yml` ≤2 percig várja** (IT-983): a Vercel
  `meta.githubPrId` a deployment létrehozásakor rögzül, a `deployment_status` a READY-nél
  tüzel, és DB nélküli appon (gg-design) nincs második futás — a smoke kimaradt, a
  kötelező `GG smoke gate` sosem jött, a PR némán BLOCKED. Üres `githubPrId`-nál a `r`
  lépés a GitHub `commits/{deployment.sha}/pulls` végpontját méri 12 × 10 s-ig (mérve:
  a READY után nyíló PR-ek 58/61-e 60 s-on belül, 60–190 s között nincs eset). A
  határon túl DB-s appon az `ensure` redeployja pótol, gg-designon csak új deployment
  (30 nap alatt 76 PR-ből 1). Auto-újratrigger szándékosan nincs (IT-985): a
  `github.token`-nel POST-olt deployment status **nem indít** futást.
  Hiányzó smoke gate-nél **előbb a runner-sort mérd** (jobs API `started_at`; p50 87 s,
  p90 15 perc), ne retrigger-commitot pusholj.
- **Elavult (`stale`) preview-futás nem nyúl az aliashoz** (IT-780) — a sorban álló
  futások befejezési sorrendje megfordulhat, és a felülírt alias halott deploymentre
  mutatna. A `stale` outputot **két** mérés táplálja: egy olcsó a checkout előtt, egy
  közvetlenül az alias-írás előtt (IT-810). A hívó smoke-ja a PR-számra ÉS a
  `stale`-re kapuzzon; a `preview-url` ürességére **ne** — az pont a valódi hibát
  nyelné el. **Per-PR adatbázisos app a `preview-db: true` inputot is adja át**
  (IT-913): egy új PR első deployját a push építi, még a `neon-preview ensure`
  előtt, `PREVIEW_DB_ISOLATED` és a PR migrációi nélkül — a recency ezt nem látja,
  mert a redeploy még nem létezik. A deployment `env` névlistája (a `GET
  /v13/deployments/{host}` válaszban) a bizonyíték; flag nélkül a futás `stale`.
  **Lezárt PR-re sem ír aliast** (IT-975): a zárás `unalias` futása és egy korábban
  indult `deployment_status` futás ugyanabban a sorban cserélhet helyet (gg-sales#43,
  #54 — a lezárt PR hosztja a projekten maradt, IT-970), ezért az `Attach alias` az
  írás előtt a `pulls/{n}` `.state`-jét is méri: `closed` → nincs alias, `stale=true`;
  olvashatatlan állapot = nyitott (a hiányzó smoke gate rosszabb, mint egy hoszt,
  amit a doctor másnap kimér).
- **Minden action-referencia SHA-ra van pinelve** (IT-277), és a policy-evaluátorok
  üres `NODE_OPTIONS`-szel, `npm ci --ignore-scripts --userconfig=/dev/null`-lal
  futnak: a cél-repó npm-konfigurációja nem kerülhet a bizalmi útvonalba.
- A saját `ci.yml` szándékosan `ubuntu-latest`-en fut, és soha nem fogyaszt secretet,
  és soha nem használ `pull_request_target`-et (publikus repó, fork-PR-ek).

## Jelen állapot (2026-09-15)

Mérve ma: az org-ruleset (a „default branch delivery gate") **12 repót** fed le
(`gg-sales`, `gg-design`, `BPDBv2`, `gg-agents`, `tools`, `irnok`, `gg-ci`,
`gg-tracker`, `gg-mcp`, `gg-share`, `gg-ops`, `ainita`), kötelező checkje a
`quality-gate / verify`, és a `policy-gate.yml` pinje a `main` HEAD-jén áll
(nincs elavult pin). Egy második ruleset a `GG smoke gate` commit statust követeli
meg 10 repón (a `gg-ci` és a `gg-mcp` nélkül). A privát repók CI-ja saját
(self-hosted) runneren fut, a publikus gg-ci sajátja a felhőben — **két kivétellel**
(mérve 2026-09-23, a `runs-on` sorokból): a `gg-sales` `ci` jobja
`blacksmith-8vcpu-ubuntu-2404`-en, a `BPDBv2` mindhárom workflow-ja
`blacksmith-2vcpu-ubuntu-2404`-en fut; a takarék-kapcsoló
(`GG_CI_STANDBY`) ma nincs beállítva, tehát normál mód van. A `preview-alias.yml`
2026-09-10 óta nincs (hívó nélkül maradt, IT-761). `npm test`: 140/140 zöld.
A repó 99 commitja túlnyomórészt jóváhagyott hash-bővítés — a mai szerkezet
2026-07-18 (preview-DB CLI) → 07-23 (quality gate, IT-244) → 07-25 (preview.yml,
policy-leltár) → 09-10 (saját runner, IT-570) → 09-11/14 (stale-javítások,
IT-780/IT-810) → 09-23 (gg-runner invariánsok a policyban, IT-974 — a `main`-en
van, a következő ruleset re-pinnel élesedik) lépésekben állt össze.

## Hol van a többi tudás

- **`README.md`** — a fogyasztói referencia: minden workflow-input, teljes caller
  példák, az onboarding lépései, és a Vercel/Neon API-k éles méréssel szerzett
  viselkedése. Ha a hívó oldalról kérdeznek, ide nézz.
- **Wiki** (itt nincs, mert szervezet-specifikus azonosítókat tartalmaz):
  `gg_knowledge_get(topic: "gg-delivery")`, al-oldalak `doc: "ci-kapu"` (a kapu három
  rétege, a release-lánc parancsai, a standby-kapcsoló, a runner-üzemeltetés),
  `doc: "meresi-receptek"`, `doc: "repok-allapota"`.
- **`docs/superpowers/specs/2026-07-23-it-244-gg-ci-upgrade-design.md`** és a
  `docs/superpowers/plans/` három terve — az eredeti kapu-tervezés és a mért
  kiindulóállapot.
- **Agent-memória**: `memory_smart_search "gg-ci"` — a döntéstörténet, a ruleset- és
  runner-azonosítók, a költség-mérések és a leckék ott élnek (`project: gg-ci`).
  Kulcsszavak: `workflow-policy`, `quality-gate`, `GG smoke gate`, `GG_CI_STANDBY`,
  `candidate-SHA`, `re-pin`, `self-hosted runner`.
- **Linear**: „Auth/Tools/CI/Tokens" projekt. Sarokkövek: IT-244, IT-253, IT-271,
  IT-277, IT-278, IT-283, IT-285, IT-295, IT-570, IT-594, IT-761, IT-780, IT-810.
- **Kapcsolódó repók**: minden fogyasztó (`tools`, `irnok`, `gg-tracker`, `gg-sales`,
  `gg-design`, `BPDBv2`, `gg-agents`, `gg-share`, `gg-mcp`, `gg-ops`, `ainita`), és a
  `tools/packages/delivery-doctor`, ami naponta méri a bekötések driftjét.
