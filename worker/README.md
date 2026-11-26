# Edge proxy + sběrač historie — Cloudflare Worker (Pilíř A + E)

## Část 1: Transparentní cachující proxy (kolo 8ac)

Klient posílá tentýž dotaz jako dříve, jen s hostem Workera; Worker
přepojí na upstream, výsledek zcacheuje **napříč všemi uživateli** a
vrátí identické JSON.

## Část 2: Sběrač historie předpovědí (kolo 8af)

Cron každých 5 minut probere 1/12 ze 100 předvybraných obcí — každá
obec je nasbírána jednou za hodinu, ve stejnou minutu. Pro každou obec
se zachytí STEJNÉ vstupy, ze kterých appka počítá verdikty:

1. `current` + `minutely_15` (8 kroků = appčin minutecast) + `precipitation_probability`,
2. ensemble srážkové členy na 3×3 mřížce (icon_d2 → icon_eu → ecmwf_ifs025 → gfs_seamless, tryNext jako v appce),
   **kolo 35**: rotace per město — město je způsobilé v UTC hodinách, kdy
   `(townHash(jméno)+hodina)%3===0`, tedy 8 z 24 hodin denně, vždy po 3 h,
   ale s fází posunutou podle jména, takže napříč městy je pokrytá každá
   hodina dne (kolo 9 sbíralo všechna města jen v 8 pevných hodinách a
   2/3 denního cyklu zůstávaly bez ensemblu). Rozpočet beze změny:
   100 měst × 8 město-hodin × 9 bodů = 7 200 volání kvóty/den < 10 000.
   Způsobilost nese záznam v `ensT` (1/0), aby analýza věděla, kterým
   obcím ensemble v danou hodinu mohl chybět nadřízeně. icon_d2 se
   ptá jen uvnitř změřeného polygonu domény (jižní hrana je křivka:
   43,53°N při 5°E → vrchol 43,67°N při 10°E → 43,45°N při 16,3°E;
   Nice a Split selhávají jižním rohem mřížky 3×3), mimo něj jde rovnou
   kaskáda od icon_eu,
3. METAR stanice obce jako ground truth (dávkový dotaz na aviationweather.gov, tentýž zdroj jako appka),
4. **radar RainViewer (kolo 8ag)** — aktuální snímek nad obcí. Worker
   nemá canvas, proto dekóduje PNG dlaždici sám (inflate přes
   `DecompressionStream` + ruční unfiltr řádků, vždy jen dva řádky v
   paměti). Schéma 0 „Black and White dBZ“ + sněhový příznak, zoom 7,
   medián mm/h z 3×3 pixelů — tentýž postup jako radarový „druhý svědek“
   verifikace v appce. Dekodér byl ověřen bitově proti nezávislé
   implementaci na živých snímcích (déšť, sníh, jasno, vadné pixely).

Záznamy se ukládají do KV pod `raw/{YYYYMMDDHH}:{mm}`, TTL 14 dní.

### Endpoints

| Endpoint | Funkce |
|---|---|
| `GET /om/v1/forecast?<params>` | proxy na api.open-meteo (TTL 10 min) |
| `GET /om/v1/ensemble?<params>` | proxy na ensemble-api (TTL 15 min) |
| `GET /chmi/img?u=<path>` | ČHMÚ radarový PNG přes proxy (CORS `*`, whitelist) |
| `GET /chmi/fct?base=YYYYMMDD.HHMM&lead=10..60` | ČHMÚ předpověď z TAR archivu |
| `GET /rv/maps` | passthrough maps.json z api.rainviewer.com (kolo 13) |
| `GET /rv/img?u=<path>` | passthrough radarové dlaždice z tilecache.rainviewer.com (kolo 13) |
| `GET /healthz` | diagnostika (proxy + kolektor + chmi) |
| `GET /analysis` | HTML dashboard: náhled + download JSON |
| `GET /analysis/page?h=YYYYMMDDHH` | JSON: všech 12 dílků dané hodiny |
| `GET /analysis/status` | JSON: poslední zápisy, kv připojeno |

### Rozpočet limitů (free tier, propočteno a ověřeno)

| Limit | Sběr | Strop |
|---|---|---|
| Open-Meteo volání | 4 800/den | 10 000 (zbytek = proxy provoz) |
| KV zápisy | 288/den | 1 000 |
| KV objem | ~10 MB/den → ~150 MB | 1 GB (TTL 14 dní) |
| Subrequesty / probuzení | ~21–26 (nejhorší případ ~30; kolo 35 snížilo ens z 8–9 obcí × 2 modely na 2–3 obce) | 50 |
| METAR dotazy | 288/den (dávkově) | bez významného limitu |
| RainViewer dotazy | 12 maps.json + 288 dlažnic/den | veřejné API bez klíče a limitu |

## Část 3: ČHMÚ radar přes proxy (kolo 8ba)

ČHMÚ publikuje radarové snímky bez CORS hlaviček — prohlížeč je nemůže
přečíst do canvasu. Worker je proto protahuje:

- **`GET /chmi/img?u=<path>`** — passthrough PNG z
  `https://www.chmi.cz/files/portal/images/meteorology/radar/` (přísný
  whitelist `/meteorology/weather/radar/*.png`, `..` se odmítá, vrací
  `Access-Control-Allow-Origin: *`). Cache: kompozit 120 s, legenda
  86 400 s.
- **`GET /chmi/fct?base=YYYYMMDD.HHMM&lead=10..60`** — ČHMÚ už
  nepublikuje předpověďní snímky jako PNG, ale jako TAR archiv
  `pacz2gmaps3.fct_z_cappi020.<base>.ft60s10.tar`. Worker TAR stáhne,
  vybalí člena pro daný `lead` (`tarFindMember`: hlavička 512 B, oktalová
  velikost od offsetu 124) a vrátí samotné PNG. Cache 240 s. Platí, že
  `base` je čas výpočtu (ne validita), takže appka posílá poslední
  známý slot a při chybě zkouší o krok starší.

Bez nasazeného Workera (`BP_PROXY`) se ČHMÚ modul v appce vypíná —
přímé čtení z prohlížeče CORS nepustí.

Whelista parametrů: `latitude`, `longitude`, `hourly`, `models`,
`forecast_hours`, `timeformat`, `timezone`. Vše ostatní se zahodí;
číselné hodnoty se validují na rozsah — Worker není otevřená proxy.

Diagnostika: hlavička `x-bp-cache: HIT|MISS` v každé odpovědi.

## Testy

```bash
node --test tests/worker.test.cjs
```

Testy vstřikují mock fetch i mock cache — žádné závislosti, žádná síť.

## Aktivace sběrače (v Cloudflare dashboardu, bez příkazové řádky)

Worker s kódem sběrače je nasazený stejně jako proxy (viz níže). Aby
sběrač běžel, jsou potřeba tři jednorázové kroky v dashboardu:

1. **KV namespace**: Storage & Databases → KV → Create namespace,
   název `bude-prset-history`. Pak ve workeru Settings → Variables and
   Bindings → Add → KV Namespace → název proměnné **`HISTORY`** → vyberte
   vytvořený namespace.
2. **Cron**: Settings → Trigger Events (Triggers) → Add Cron Trigger →
   `*/5 * * * *`.
3. **Redeploy**: aktualizovaný kód `worker/worker.mjs` vložte do editoru
   (Edit code) a Deploy.

Ověření: `<URL>/analysis/status` → `"kv": true`; do hodiny začnou přibývat
klíče `raw/…`. Bez bindingu sběrač tiše stojí (`"kv": false`) — proxy
funguje normálně dál.

## Formát záznamu (pro analýzu)

`GET /analysis/page?h=YYYYMMDDHH` vrací `{ok, h, found, meta, slices}`:
`meta` = seznam 100 obcí (název, země, souřadnice, ICAO), `slices` =
pole dílků té hodiny. Každý dílek má `t` (epoch), `slice` a `p` — mapu
obcí. Na obec:

- `fc.c` — modelový aktuální stav: `{t, iv (interval s), p (mm), mh (mm/h), cd (weather_code)}`,
- `fc.m` — minutecast: 8 kroků `[unixtime, mm/15min, rain, showers, snowfall]` (tj. horizont +2 h),
- `fc.pp` — precipitation_probability na 13 h (první čas `fc.h0`),
- `ens.m` — použitý ensemble model, `ens.t0` — první hodina, `ens.g` —
  9 bodů mřížky × členové × 9 h srážek (mm, 1 desetinné místo),
- `met` — METAR ground truth: `{t (čas pozorování), tp (°C), r (prší), i (0–3 intenzita), s (sníh), th (bouřka), sh (přeháňka), re (recent), vc (v okolí), raw}`,
- `rv` — radar ground truth (kolo 8ag): `{t (čas snímku, ~10 min mřížka), mm (medián mm/h z 3×3 pixelů; 0 = jasno), ec (počet pixelů s odrazem 0–9), sn (sněhový příznak většiny odrazů)}`,
- `ensT` — (kolo 35) 1/0: bylo město v danou hodinu způsobilé pro sběr
  ensemble (rotace měst); 0 znamená nadřízenou absenci `ens` bez chyby,
- `err` — pole chybějících částí (fc/ens/met/rv), pokud něco selhalo
  (`ens` se hlásí jen u způsobilých měst, `ensT`=1).

Párování pro vyhodnocení přesnosti: předpověď z záznamu hodiny H pro
cílový čas T porovnat s METAR `r/i` z záznamu, jehož `met.t` je blízko T,
a nezávisle s radarem `rv.mm` ze záznamu, jehož `rv.t` je blízko T.
Radar měří ve výšce (virga ani bright band mu nedělají dobře) a je to
globální mozaika — kde METAR mlčí nebo je daleko, radar je ground truth
přímo v lokalitě; kde se rozcházejí, má METAR přednost (stejná pravidla
poctivosti jako ve verifikaci appky).
Dashboard `/analysis` umí hodinu/den stáhnout jako JSON soubor.

## Nasazení (jednou, na vašem stroji)

1. Účet na Cloudflare (zdarma) → https://dash.cloudflare.com/sign-up
2. Z kořene repa:
   ```bash
   npx wrangler login      # otevře prohlížeč, přihlášení k CF účtu
   npx wrangler deploy     # čte worker/wrangler.jsonc, nahraje worker
   ```
3. Wrangler vypíše URL ve tvaru
   `https://bude-prset-proxy.<vase-subdomena>.workers.dev`
4. Ověření: otevřete `<URL>/healthz` → `{"ok":true,...}` a zkuste
   `<URL>/om/v1/forecast?latitude=49.195&longitude=16.607&hourly=precipitation,snowfall&models=icon_seamless&forecast_hours=25&timeformat=unixtime&timezone=auto`
5. Aktivace v aplikaci: v `src/main.js` nastavte
   `var BP_PROXY = "https://bude-prset-proxy.<subdomena>.workers.dev";`
   spusťte `npm run build` a commitněte `src/main.js` + `index.html`.
   Prázdný BP_PROXY = přímá cesta k Open-Meteo beze změny chování.

## Limity (free tier, ověřeno listopad 2026)

- 100 000 requestů/den — pro tuto aplikaci prakticky neomezeno.
- 10 ms CPU/request — passthrough hluboko pod limitem.
- Worker nezpracovává radarová PNG ani METAR — ty zůstávají v klientovi.

## Proč passthrough a ne agregace verdiktů

Logika výpočtu verdiktů zůstává v klientovi (testovaná, kalibrovaná).
Worker je tenký a nahraditelný — jeho výpadek klient přežije přímým
fallbackem na Open-Meteo (nouzové cesty v `load()` jsou vždy přímé).

## Část 4: RainViewer passthrough (kolo 13)

Měřený důvod: na některých mobilních sítích přímé dotazy prohlížeče na
cizí domény (api./tilecache.rainviewer.com, aviationweather.gov) padají
i tehdy, když tentýž server z jiné sítě odpovídá 200 — zatímco všechno,
co putuje přes tento Worker na Cloudflare, jede. Appka proto radarové
dlaždice a maps.json načítá primárně přímo (CDN, rychlé), a teprve po
selhání přímé cesty zkouší:

- **`GET /rv/maps`** — passthrough
  `https://api.rainviewer.com/public/weather-maps.json`, cache 60 s.
- **`GET /rv/img?u=<path>`** — passthrough dlaždice z
  `https://tilecache.rainviewer.com`, cache 3600 s (snímek pod
  neměnným hashem se nemění). Whitelist přijímá PŘESNĚ tvar, který
  posílá appka (`rvTile`), tedy
  `/v2/radar/<hash>/256/<z>/<x>/<y>/<schéma>/<smooth>_<sníh>.png` —
  nic jiného (maska pokrytí, jiné velikosti, cesta ven) Worker
  neprotáhne, není to otevřená png proxy.

### Nasazení kola 13 (v příkazové řádce)

```bash
npx wrangler deploy      # z kořene repa, čte worker/wrangler.jsonc
```

Ověření: `<URL>/healthz` → v `endpoints` přibude `"rv":["/rv/maps","/rv/img"]`;
dále `curl <URL>/rv/maps` vrátí maps.json a
`curl "<URL>/rv/img?u=%2Fv2%2Fradar%2F<hash>%2F256%2F7%2F69%2F43%2F0%2F0_1.png"`
vrátí image/png (hash vemte z `/rv/maps`, pole `radar.past[].path`).

Bez nasazení kola 13 appka funguje jako dřív: `/rv/*` vrátí 404,
fallback se vzdá a verdikt drží pozemní pravda (kolo 12c).
