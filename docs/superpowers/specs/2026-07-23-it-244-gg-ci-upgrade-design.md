# IT-244 — GG CI upgrade design

## Cél

A GuestGuru alkalmazásrepók szállítási folyamata három garanciát adjon:

1. piros vagy hiányzó CI-val ne lehessen a default branchre kerülni;
2. a Vercel production domain ne váltson olyan commitra, amelynek a `main` CI-je piros;
3. az autonóm agentek köztes pushai ne küldjenek emailt minden átmeneti hibáról, miközben a végső állapot és a preview URL továbbra is látható.

A scope repói: `gg-sales`, `gg-design`, `BPDBv2`, `gg-agents`, `tools`, `irnok` és a közös `gg-ci`.

## Mért kiindulóállapot (2026-07-23)

| Repo | Legutóbbi default-branch CI | Jelenlegi fő check(ek) | Default branch védelem |
|---|---|---|---|
| `gg-sales` | zöld | `ci` | nincs |
| `gg-design` | zöld | `registry`, `meresek` | nincs |
| `BPDBv2` | zöld | `web`, `pipeline` | nincs |
| `gg-agents` | zöld | `test · typecheck · build`, `db-integration (postgres)` | nincs |
| `tools` | zöld | `ci` | nincs |
| `irnok` | zöld | `web`, `cloud-function` | nincs |
| `gg-ci` | zöld | `test` | nincs |

GitHub API-ból egyik repón sem látszik branch protection vagy ruleset. Ez azt jelenti, hogy a CI jelenleg információ, nem technikai merge-kapu.

A Vercel projektek mind közvetlen GitHub-integrációval, `main` production branchcsel és automatikus production domain-hozzárendeléssel futnak. A Vercel buildhiba önmagában megakadályozza az adott build élesítését, de a külön GitHub CI eredménye nincs production promotion gate-ként beállítva.

A sales legutóbbi új PR-jének első preview buildje ténylegesen `migrate:ci` alatt bukott (`dpl_9D4pJfZf6RfMA86VdmzPKeGt27rY`): a Neon natív integráció már beadta a kapcsolatot, de a friss preview endpoint még nem fogadott kapcsolatot. Egy későbbi push ugyanazon a PR-en zöld buildet adott. Ez valódi readiness-verseny, nem hibás SQL.

## Megvizsgált megközelítések

### A. Repónkénti ruleset a ma létező checknevekkel

Minden repó saját rulesetet kapna a saját jobneveivel.

Előny: nincs workflow-kódmódosítás, gyorsan bekapcsolható.

Hátrány: hét, egymástól eltérő policy marad; egy job átnevezése vagy felosztása könnyen csendes driftet okoz; Vercelben is repónként más checket kell karbantartani.

### B. Egységes `quality-gate` check + szervezeti ruleset — választott

Minden fő CI-workflow végén ugyanaz a downstream check fut. A repo-specifikus jobok eredményét a `gg-ci` publikus reusable workflow-ja értékeli. Egy, a rulesetből központilag forrásolt policy workflow ellenőrzi, hogy a PR nem írta-e át vagy kerülte-e meg ezt a bekötést. Egyetlen szervezeti ruleset és minden Vercel projekt ugyanazt a checknevet várja.

Előny: egy policy, stabil checknév, egyszerű audit, a repók saját tesztjei változatlanok maradnak.

Hátrány: egyszeri, több repós rollout kell; a `gg-ci` reusable workflow-ját előbb elérhetővé kell tenni.

### C. Minden deploy GitHub Actionsből, Vercel git-auto-deploy nélkül

A CI után `vercel deploy --prebuilt` indulna.

Előny: egyetlen, teljesen soros pipeline.

Hátrány: nagyobb secretfelület, megszakadna vagy újraépítendő lenne a natív Vercel/Neon preview-integráció, és az alkalmazások mai deployment esemény-alapú alias/smoke folyamata is átírást igényelne. A jelenlegi célhoz aránytalan.

## 1. Egységes quality gate

A `gg-ci` új `.github/workflows/quality-gate.yml` reusable workflow-ja egy `needs-json` string inputot kap. A hívó CI-workflow downstream jobja:

- `if: always()` feltétellel akkor is lefut, ha egy előfeltétel bukott;
- `needs` alatt felsorolja a repo összes kötelező CI-jobját;
- `${{ toJSON(needs) }}` formában átadja azok eredményét;
- csak akkor zöld, ha minden felsorolt job eredménye `success`.

A publikus check neve minden repóban azonos lesz. A pontos, GitHub által renderelt nevet teszt-PR-en mérjük meg, és csak ezt követően kerül a rulesetbe. Nem feltételezzük előre, hogy a UI a caller- vagy a reusable-job nevét használja.

A gate nem helyettesíti a repo tesztjeit; kizárólag egy stabil, közös policy-interfész föléjük.

## 2. GitHub szervezeti ruleset

Egy aktív GuestGuru organization-level branch ruleset célozza a scope hét repójának default branchét.

Szabályok:

- minden módosítás pull requesten keresztül történjen;
- az egységes quality gate legyen kötelező és a GitHub Actions appból származzon;
- force push és branch törlés legyen tiltva;
- nyitott review thread mellett ne lehessen merge-elni;
- általános kötelező approving review ne legyen;
- a ruleset a `gg-ci/.github/workflows/policy-gate.yml` szervezeti required workflow-ját futtassa, amely a cél-PR-től független kóddal ellenőrzi a caller workflow pontos bekötését;
- a gate-et meghatározó workflow- és központi CI-fájlokhoz legyen CODEOWNERS, de egyszemélyes szervezetben ne legyen bekapcsolva a kötelező code-owner review;
- ne legyen állandó bypass actor.

A rollout kétfázisú: a workflow-k bevezetése és zöld tesztelése alatt a ruleset disabled állapotban marad; aktív csak akkor lesz, amikor a központi policy workflow már a `gg-ci` default branchén van, és mind a hét repó ugyanazt a zöld checket ténylegesen kibocsátotta. A kötelező code-owner review csak akkor aktiválható, ha a PR szerzőjén kívül van legalább egy jogosult reviewer; a jelenlegi egyszemélyes orgban ez deadlock lenne. A központi required workflow e nélkül is megakadályozza, hogy egy cél-PR saját maga lazítsa fel a gate definícióját.

## 3. Vercel production Deployment Checks

A hat Vercel alkalmazásprojekt production környezetében ugyanaz az egységes GitHub check lesz required Deployment Check.

Eredmény:

1. a `main` commitból a Vercel build létrejöhet;
2. a production domain csak a build és a `main` quality gate sikere után vált;
3. egy PR-en zöld, de a merge commiton piros CI nem jut éles forgalomhoz.

Ez a GitHub ruleset kiegészítése, nem helyettesítése. A GitHub ruleset a branchbe jutást, a Vercel check az éles domain promotiont védi.

## 4. Sales preview DB readiness

A `gg-sales/scripts/migrate.ts` a kapcsolat felépítését külön, tesztelhető függvénybe szervezi.

Viselkedés:

- production és lokális futás változatlanul fail-fast;
- Vercel preview (`VERCEL_ENV=preview`) alatt csak a kezdeti `pool.connect()` kap rövid, korlátos újrapróbálást;
- a késleltetés exponenciálisan nő, majd 15 másodpercnél plafonál;
- a teljes várakozási ablak legfeljebb 90 másodperc;
- ha a kapcsolat egyszer létrejött, minden SQL- vagy migrációs hiba azonnal bukik, retry nélkül;
- hiányzó DB URL azonnali konfigurációs hiba marad.

Ez célzottan a Neon endpoint readiness-versenyt kezeli, és nem maszkol hibás migrációt.

## 5. Értesítési modell

Technikailag nincs megbízható „ez volt az agent utolsó push-a” esemény. Emiatt az email-csatorna nem tud egyszerre köztesen csendes és a végén automatikusan beszédes lenni.

A választott modell:

- GitHub Actions workflow-email: kikapcsolva a felhasználónál; a webes Actions státusz megmarad;
- Vercel Deployment Failures és Deployment Promotions email: kikapcsolva, a webes értesítés megmarad;
- Vercel PR-kommentek megmaradnak, mert egy helyen tartják a preview URL-t;
- a GG preview workflow saját kommentje `--edit-last`/marker alapján egyetlen kommentet frissít, nem hoz létre újat minden pushnál;
- a végső siker/hiba kommunikációját az aktív agent-feladat és a PR quality gate adja.

A számlázási, domain- és biztonsági értesítésekhez nem nyúlunk.

## Hibakezelés és visszaállítás

- A ruleset rollout előtt disabled; aktiválás után API-ból visszaolvassuk.
- Ha a közös check egy repón nem jelenik meg, az a repo kimarad az aktív targetből a javításig.
- A Vercel Deployment Check beállítás repónként visszavonható, és nem módosít adatot vagy sémát.
- A sales retry kimerülése ugyanazzal a nem nulla exitkóddal bukik, mint ma.
- Külső platformbeállítást csak visszaolvasással tekintünk késznek.

## Verifikáció

1. `gg-ci`: unit teszt + typecheck + workflow lint.
2. Minden caller repo: a saját teljes CI-je + workflow lint.
3. Teszt-PR: a közös quality gate pontos neve és bukási propagációja.
4. GitHub: ruleset API-visszaolvasás, majd kontrollált piros check mellett merge tiltás.
5. Sales: fake-timeres unit teszt a retryra, majd vadonatúj teszt-PR első Vercel buildje legyen zöld üres redeploy commit nélkül.
6. Vercel: mind a hat projekt production Deployment Check beállításának visszaolvasása; kontrollált piros `main` check esetén a domain ne promotálódjon.
7. Értesítés: GitHub és Vercel UI-visszaellenőrzés, hogy az email csatorna ki, a webes csatorna be maradt.

## Hivatkozások

- [GitHub organization rulesets](https://docs.github.com/en/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization)
- [GitHub ruleset rules](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [GitHub Actions notifications](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)
- [Vercel Deployment Checks](https://vercel.com/docs/deployment-checks)
- [Vercel notifications](https://vercel.com/docs/notifications)
