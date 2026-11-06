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
3. METAR stanice obce jako ground truth (dávkový dotaz na aviationweather.gov, tentýž zdroj jako appka).

Záznamy se ukládají do KV pod `raw/{YYYYMMDDHH}:{mm}`, TTL 14 dní.

### Endpoints

| Endpoint | Funkce |
|---|---|
| `GET /om/v1/forecast?<params>` | proxy na api.open-meteo (TTL 10 min) |
| `GET /om/v1/ensemble?<params>` | proxy na ensemble-api (TTL 15 min) |
| `GET /healthz` | diagnostika (proxy + kolektor) |
| `GET /analysis` | HTML dashboard: náhled + download JSON |
| `GET /analysis/page?h=YYYYMMDDHH` | JSON: všech 12 dílků dané hodiny |
| `GET /analysis/status` | JSON: poslední zápisy, kv připojeno |

### Rozpočet limitů (free tier, propočteno a ověřeno)

| Limit | Sběr | Strop |
|---|---|---|
| Open-Meteo volání | 4 800/den | 10 000 (zbytek = proxy provoz) |
| KV zápisy | 288/den | 1 000 |
| KV objem | ~10 MB/den → ~150 MB | 1 GB (TTL 14 dní) |
| Subrequesty / probuzení | ~20–28 | 50 |
| METAR dotazy | 288/den (dávkově) | bez významného limitu |

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
- `err` — pole chybějících částí (fc/ens/met), pokud něco selhalo.

Párování pro vyhodnocení přesnosti: předpověď z záznamu hodiny H pro
cílový čas T porovnat s METAR `r/i` z záznamu, jehož `met.t` je blízko T.
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
