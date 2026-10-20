# A CLAUDE.md kiszervezett részletei

A `CLAUDE.md` minden agent-session elején betöltődik, ezért legfeljebb 10 KB
(IT-1809, 2026-10-20). Ami innen hiányzik onnan, az itt van: a szabályok
indoklása, a mért részletek és a történet. A szabály maga a `CLAUDE.md`-ben maradt.

## Titok és publikusság (Tamás, 2026-10-09, IT-1496)

A korábbi „semmi infrastruktúra-azonosító” szabályt váltja. A
workflow-inputos általánosság ajánlott, ahol több hívó használja, de nem kötelező.
A `test/secret-guard.test.ts` minden verziókövetett fájlban titok ALAKÚ szöveget
keres (connection string jelszóval, privát kulcs, GitHub/Neon/Linear/Slack/LLM/AWS-kulcs),
az `npm test` része. **Privát nem lehet**: a reusable workflow-k saját magukat
checkoutolják a HÍVÓ `GITHUB_TOKEN`-jével, ami privát gg-ci-t nem lát (IT-285,
élesben mérve).

## Saját runner: cache és pnpm

- `setup-node` cache nélkül: a perzisztens `~/.npm` megmarad, a GitHub-cache a
  saját runneren ~1 GB, 50–100 s jobonként (IT-966).
- `pnpm/action-setup` `dest`: a default `~/setup-pnpm` a runner-példányok
  (2026-10-06 óta négy, IT-1323) közös HOME-ja, és az action minden jobban törli —
  két egyszerre induló job egymás alól törli a pnpm-et (IT-971).

## Playwright-action (IT-1256)

A logika az `install.sh`-ban, tesztje a `test/playwright-chromium-action.test.ts`,
a hívók `@main`-nel hivatkoznak rá. A böngésző kötelező, az `install-deps`
best-effort, 120 mp-es kerettel (GNU `timeout` a szkriptben, mert composite lépésen
nincs `timeout-minutes`; előzmény IT-782, IT-1253). A composite lépés a job
`defaults.run` mappáját nem örökli, ezért kell a `working-directory` input.

## PR-hoszt mint alias (IT-1046, mérve 2026-09-25)

A kötetlen projekt-domain production-domain (minden prod-deploy elviszi, a PR-link
az éles kódot és DB-t mutatja); a git-ághoz kötött preview-domainen a
Vercel-védelem 302/401-et ad a smoke-nak (gg-ci#93 → #94). Az `alias-set` sima
aliast ír, és alias-szintű Deployment Protection Exceptiont tesz rá
(`alias-protection-override`), ha a projekt védelme szűkebb az `all`-nál.
Elutasítja a nem PR-hosztot (`<app>-pr-<n>.…`), a production és az idegen projekt
deployját, és a más projekt aliasát; a régi projekt-domaint leválasztja.

## A `preview.yml` `stale`-döntései

A deploy UTÁN nyíló PR-t a PR-feloldás ≤2 percig várja a GitHub
`commits/{sha}/pulls`-ból (IT-983; auto-újratrigger szándékosan nincs, IT-985 —
hiányzó smoke gate-nél előbb a runner-sort mérd, jobs API `started_at`). A
`stale`-t két mérés táplálja, egy a checkout előtt, egy az írás előtt
(IT-780/IT-810). Per-PR adatbázisos hívó `preview-db: true`-val jelzi, hogy a
`PREVIEW_DB_ISOLATED` nélkül épült deploy `stale` (IT-913). Lezárt PR-re az
`Attach alias` nem ír (IT-975, a `pulls/{n}` `.state` az írás előtt).

## A CLAUDE.md „Jelen állapot” fejezete 2026-10-20-án (a `main`-en, IT-1808)

Az org-ruleset („GG default branch delivery gate”) **15 repót** fed le (`gg-sales`,
`gg-design`, `BPDBv2`, `gg-agents`, `tools`, `irnok`, `gg-ci`, `gg-tracker`, `gg-mcp`,
`gg-share`, `gg-ops`, `ainita`, `gg-brain`, `gg-inbox`, `guestguru2026`), kötelező
checkje a `quality-gate / verify`; a `GG smoke gate` commit statust egy második ruleset
követeli meg 12 repón. A privát repók CI-ja saját runneren fut, a publikus gg-ci sajátja a
felhőben (2026-09-23-án kivétel: a `gg-sales` `ci` és a `BPDBv2` Blacksmith-en). A
`GG_CI_STANDBY` nincs beállítva. A bő tesztsorokat a `scheduled-dispatch/` indítja (IT-1808).
A szerkezet története az agent-memóriában van.

## A CLAUDE.md „Jelen állapot” fejezete 2026-09-23-án

Az org-ruleset (a „default branch delivery gate") **12 repót** fed le (`gg-sales`,
`gg-design`, `BPDBv2`, `gg-agents`, `tools`, `irnok`, `gg-ci`, `gg-tracker`, `gg-mcp`,
`gg-share`, `gg-ops`, `ainita`), kötelező checkje a `quality-gate / verify`; egy
második ruleset a `GG smoke gate` commit statust követeli meg 10 repón (a `gg-ci` és a
`gg-mcp` nélkül). A privát repók CI-ja saját (self-hosted) runneren fut, a publikus
gg-ci sajátja a felhőben — két kivétel (mérve 2026-09-23): a `gg-sales` `ci` jobja
`blacksmith-8vcpu-ubuntu-2404`-en, a `BPDBv2` mindhárom workflow-ja
`blacksmith-2vcpu-ubuntu-2404`-en. A takarék-kapcsoló (`GG_CI_STANDBY`) nincs
beállítva. A `preview-alias.yml` 2026-09-10 óta nincs (IT-761). A szerkezet
2026-07-18 (preview-DB CLI) → 07-23 (quality gate, IT-244) → 07-25 (preview.yml,
policy-leltár) → 09-10 (saját runner, IT-570) → 09-11/14 (stale-javítások,
IT-780/IT-810) → 09-23 (gg-runner invariánsok a policyban, IT-974; preview-db,
késői PR, lezárt PR — IT-913/983/975; mind a 9 per-PR DB-s hívó `preview-db: true`)
lépésekben állt össze.

## Linear-sarokkövek

„Auth/Tools/CI/Tokens” projekt: IT-244, IT-253, IT-271, IT-277, IT-278, IT-283,
IT-285, IT-295, IT-570, IT-594, IT-761, IT-780, IT-810, IT-913, IT-974, IT-975, IT-983.
