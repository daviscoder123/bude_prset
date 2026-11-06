# Edge proxy — Cloudflare Worker (Pilíř A, kolo 8ac)

Transparentní cachující proxy pro Open-Meteo. Klient posílá tentýž dotaz
jako dříve, jen s hostem Workera; Worker přepojí na upstream, výsledek
zcacheuje **napříč všemi uživateli** a vrátí identické JSON.

## Endpoints

| Endpoint | Upstream | Cache TTL |
|---|---|---|
| `GET /om/v1/forecast?<params>` | `api.open-meteo.com/v1/forecast` | 10 min |
| `GET /om/v1/ensemble?<params>` | `ensemble-api.open-meteo.com/v1/ensemble` | 15 min |
| `GET /healthz` | — | — |

Whelista parametrů: `latitude`, `longitude`, `hourly`, `models`,
`forecast_hours`, `timeformat`, `timezone`. Vše ostatní se zahodí;
číselné hodnoty se validují na rozsah — Worker není otevřená proxy.

Diagnostika: hlavička `x-bp-cache: HIT|MISS` v každé odpovědi.

## Testy

```bash
node --test tests/worker.test.cjs
```

Testy vstřikují mock fetch i mock cache — žádné závislosti, žádná síť.

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
