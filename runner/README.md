# Runner lemezőr

A `disk-guard.sh` a JOB_COMPLETED hook. A work-diszken 15 GB alatt a
`disk-guard-volumes.sh` segédet indítja, leválasztott bemenettel/kimenettel és üres
`RUNNER_TRACKING_ID`-val. A hook nem vár rá: a saját Worker-nek is ki kell lépnie.
Checkoutot, képet és build cache-t ez a lépcső nem töröl.

A work-diszk korábbi checkout-lépcsője is megmarad: a segéd ütemezése után,
ugyanennél a küszöbnél a hook törli azokat a repo-checkoutokat, amelyek teljes
fájában 14 napja semmi nem változott (`DISK_GUARD_KEEP_DAYS`-szal állítható).
Egy friss fájl mélyen a checkoutban is megőrzi az egész könyvtárat. A `_tool`,
`_actions`, `_temp`, `_PipelineMapping` és `_diag` mindig megmarad. A hook a
checkout-lépcső után újraméri a szabad helyet; a kötettakarító külön is mér.

A segéd az összes Worker hiányát legfeljebb 30 másodpercig várja. Egy közös,
HOME alatti `runner-hooks/disk-guard-volumes.lock` flock kizárja a párhuzamos
segédeket. A Listener folyamatoknak SIGSTOP-ot küld, visszaméri a megállt állapotot,
majd ismét ellenőrzi a Worker-ek hiányát és a Listener-lista egyezését. A megállított
Listener nem tud új Worker-t indítani a mérés és törlés között. Már megállított
Listener esetén kihagyja a takarítást, és azt nem folytatja önhatalmúlag.

Csak `docker volume prune --force` fut, `--all` nélkül: az anonim, egyetlen
konténer által sem hivatkozott kötetek törlődnek. Leállított konténer hivatkozása
is véd. A Docker-kliens kerete 30 másodperc, TERM után további 2 másodperccel KILL.
A kilépési trap CONT-tal folytatja a segéd által megállított Listener-eket siker,
hiba és kezelt jel esetén. Ez nem runner-újraindítás; a `.env` változatlan.
A gép/segéd kényszerített SIGKILL-je nem kezelhető shell trapből.

Az események a meglévő `~/runner-hooks/disk-guard-events.log` naplóba kerülnek:
`volume_prune` (előtte/utána szabad MB és Docker-eredmény), `volume_prune_failed`,
`volume_skip` (futó Worker/felderítési hiba, hiányzó vagy változó runner-lista).
Kihagyáskor a következő job vége újra próbálkozik. A küszöb
`DISK_GUARD_PRUNE_UNDER_GB` (15), a várakozás `DISK_GUARD_VOLUME_WAIT_SECONDS` (30),
a napló `DISK_GUARD_EVENT_LOG` változóval állítható. A rendszerdiszk korábbi
`/tmp` → Playwright → npm lépcsője változatlan.

Telepítés a gazdagépen: `runner/install.sh`, majd `runner/install.sh --check`.
A telepítő előbb a segédet, utána a hookot cseréli atomikusan; nem indít újra
szolgáltatást. Kézi kötettakarítás ugyanazzal a védelemmel a VM-ben:

```bash
bash ~/runner-hooks/disk-guard-volumes.sh /mnt/lima-colima-ci
```

A tesztekben nincs valódi Docker-törlés: a Docker- és folyamatfelderítési határ
izolált, a SIGSTOP/CONT viszont valódi tesztfolyamatokon fut. Linuxon az
`npm test` része a 15 Python-viselkedéspróba; macOS-en ez a teszt kimarad,
a `runner-scripts.test.ts` telepítő- és shellcheck-próbái ott is futnak.
