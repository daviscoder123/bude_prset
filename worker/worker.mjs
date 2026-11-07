/**
 * „Bude pršet?" — edge proxy + sběrač historie předpovědí (Cloudflare Workers).
 *
 * ČÁST 1 — PROXY (Pilíř A, kolo 8ac): transparentní cachující proxy pro
 * Open-Meteo. Klient posílá tentýž dotaz jako dříve, jen s naším hostem;
 * Worker přepojí na upstream, výsledek zcacheuje napříč uživateli a vrátí
 * identické JSON.
 *
 *   GET /om/v1/forecast?<whitelisted params>  → api.open-meteo.com/v1/forecast
 *   GET /om/v1/ensemble?<whitelisted params> → ensemble-api.open-meteo.com/v1/ensemble
 *   GET /healthz                              → {ok:true, ...}
 *
 *   ČHMÚ passthrough (kolo 8ba): opendata.chmi.cz neposílá CORS, a jeho
 *   radarová předpověď (+10…+60 min) se balí do TAR archivů. Worker proto
 *   dodává dvě věci, které prohlížeč sám nezvládne:
 *
 *   GET /chmi/img?u=<cesta .png>              → passthrough PNG s CORS *
 *   GET /chmi/fct?base=YYYYMMDD.HHMM&lead=NN → člen z předpovědního TARu
 *
 * ČÁST 2 — SBĚRAČ (kolo 8af): cron každou 5. minutu projde 1/12 z 100
 * předvybraných obcí (12 dílků × ~8–9 obcí, deterministicky podle UTC
 * minuty). Pro každou obec zachytí STEJNÉ vstupy, ze kterých appka počítá
 * své verdikty, plus pozorování z METAR jako ground truth:
 *
 *   1. api.open-meteo /v1/forecast — current + minutely_15 (8 kroků po
 *      15 min = appčin „minutecast") + hourly precipitation_probability;
 *   2. ensemble-api /v1/ensemble — srážkové členy na 3×3 mřížce
 *      (±0.1° lat / ±0.15° lon, zrcadlí ensembleGrid aplikace),
 *      model icon_d2 (střední Evropa) nebo icon_eu (okraj);
 *   3. aviationweather.gov /api/data/metar — všechny stanice jednoho
 *      dílku v JEDNOM hromadném dotazu (ground truth: prší/nesní...);
 *   4. RainViewer radar (kolo 8ag) — aktuální snímek nad obcí: PNG
 *      dlaždice (schéma 0 „Black and White dBZ“, zoom 7) se dekóduje
 *      PŘÍMO ve Workeru (žádný canvas; inflate přes DecompressionStream
 *      + ruční unfiltr řádků) a uloží se medián mm/h z 3×3 pixelů —
 *      tentýž postup jako radarový „druhý svědek“ aplikace.
 *
 *   Výsledek se uloží do KV (binding HISTORY) pod klíč
 *   raw/{YYYYMMDDHH}:{mm} s TTL 14 dní.
 *
 *   GET /analysis          → HTML dashboard (náhled + download JSON)
 *   GET /analysis/page?h=YYYYMMDDHH → JSON: všech 12 dílků dané hodiny
 *   GET /analysis/status   → JSON: diagnostika sběru (kv, poslední zápisy)
 *
 * Rozpočet limitů (free tier, propočteno):
 *   Open-Meteo:  100 obcí × 2 dotazy × 24 h = 4 800/den (limit 10 000;
 *                zbytek drží rezervu pro provoz proxy)
 *   METAR:       12 hromadných dotazů/hod = 288/den (bez významného limitu)
 *   KV zápisy:   12/hod = 288/den (limit 1 000)
 *   RainViewer:  12 maps.json + 288 dlažnic/den (veřejné API bez klíče)
 *   Subrequesty: ~21–29 na jedno probuzení (limit 50; nejhorší případ
 *                s ensemble fallbacky ~38)
 *
 * Chyby jedné obce (výpadek API) se tolerují — záznam dostane err značku,
 * ale kolo pokračuje. Bez KV bindingu sběrač tiše stojí (status hlásí
 * kv:false), proxy funguje dál.
 *
 * Testovatelnost: createWorker(deps) umožňuje vstříknout fetchImpl, cache,
 * kv a now (Node testy v tests/worker.test.cjs). Default export je
 * produkční wiring přes env (HISTORY binding + cron trigger).
 */

var UPSTREAMS = {
  "/om/v1/forecast": {
    host: "https://api.open-meteo.com",
    path: "/v1/forecast",
    ttl: 600
  },
  "/om/v1/ensemble": {
    host: "https://ensemble-api.open-meteo.com",
    path: "/v1/ensemble",
    ttl: 900
  }
};

/* ================= ČHMÚ PASSTHROUGH (kolo 8ba) =================
   opendata.chmi.cz servíruje radarové PNG bez hlavičky
   Access-Control-Allow-Origin, takže prohlížeč nepřečte pixely z
   canvasu. Worker tady vrací TUTÉŽ data s CORS * — a navíc umí
   rozbalit předpovědní TAR: od přestavby ČHMÚ (2026) už nejsou
   +10…+60 min snímky samostatné PNG, ale jediný archiv
   pacz2gmaps3.fct_z_cappi020.<base>.ft60s10.tar (60 min ve
   10minutových krocích). Worker archiv vytáhne jednou, zcachuje
   (mění se po 5 minutách) a každému dotazu vybalí jen člena
   <base+lead>.<lead>.png. Whitelist cesty je striktní — proxy
   nesmí být otevřená proxy. */
var CHMI_HOST = "https://opendata.chmi.cz";
var CHMI_PATH_RE = /^\/meteorology\/weather\/radar\/[A-Za-z0-9_.\/-]+$/;
var CHMI_FCT_LEADS = ["10", "20", "30", "40", "50", "60"];
var CHMI_TAR_TTL = 240;        /* archiv se rodí po 5 minutách */

function chmiCacheTtl(path) {
  if (path.indexOf("/scl/") >= 0) return 86400;   /* legenda se skoro nemění */
  return 120;                                     /* kompozit: 5min kroky */
}

/* Vybere z TAR archivu člena končící ".<lead>.png" a vrátí jeho bajty.
   TAR formát: hlavička 512 B (jméno od 0, velikost od 124 v oktalové
   soustavě), pak data zarovnaná na 512 B. Bez dekomprese — PNG vevnitř
   je uložené přímo. Exportuje se kvůli testům. */
export function tarFindMember(bytes, lead) {
  var suffix = "." + lead + ".png";
  var off = 0;
  while (off + 512 <= bytes.length) {
    var name = "";
    for (var i = 0; i < 100; i++) {
      var c = bytes[off + i];
      if (!c) break;
      name += String.fromCharCode(c);
    }
    if (!name) break;                      /* prázdný blok = konec archivu */
    var sizeOct = "";
    for (var s = 0; s < 11; s++) {
      var ch = bytes[off + 124 + s];
      if (!ch || ch === 32) break;
      sizeOct += String.fromCharCode(ch);
    }
    var size = parseInt(sizeOct, 8) || 0;
    var dataOff = off + 512;
    if (size > 0 && name.length >= suffix.length && name.slice(-suffix.length) === suffix) {
      return bytes.slice(dataOff, dataOff + size);
    }
    off = dataOff + Math.ceil(size / 512) * 512;
  }
  return null;
}

/* Parametry, které klient skutečně posílá; vše ostatní se zahodí. */
var ALLOWED_PARAMS = ["latitude", "longitude", "hourly", "models", "forecast_hours", "timeformat", "timezone"];
var ALLOWED_HOURLY = ["precipitation", "snowfall", "temperature_2m", "weathercode"];

function json(status, obj, extraHeaders) {
  var h = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store"
  };
  if (extraHeaders) {
    Object.keys(extraHeaders).forEach(function (k) { h[k] = extraHeaders[k]; });
  }
  return new Response(JSON.stringify(obj), { status: status, headers: h });
}

/* Každá položka (i v comma-seznamu více bodů u ensemble) musí být číslo
   v rozsahu. Jinak 400 — do URL pro upstream se nic nevalidovaného nedostane. */
function numericList(value, min, max) {
  var parts = String(value).split(",");
  for (var i = 0; i < parts.length; i++) {
    var n = Number(parts[i]);
    if (!isFinite(n) || n < min || n > max) return false;
  }
  return true;
}

/* Postaví filtrovaný + validovaný query string pro upstream.
   Vrací {qs, err}: err = lidsky čitelný důvod odmítnutí, qs = "" při chybě. */
function buildUpstreamQs(searchParams) {
  var parts = [];
  var seen = {};
  var i, k, v;
  for (i = 0; i < ALLOWED_PARAMS.length; i++) seen[ALLOWED_PARAMS[i]] = false;

  for (i = 0; i < ALLOWED_PARAMS.length; i++) {
    k = ALLOWED_PARAMS[i];
    if (!searchParams.has(k)) continue;
    v = searchParams.get(k);
    if (k === "latitude" && !numericList(v, -90, 90)) return { qs: "", err: "latitude mimo rozsah" };
    if (k === "longitude" && !numericList(v, -180, 180)) return { qs: "", err: "longitude mimo rozsah" };
    if (k === "forecast_hours") {
      var fh = Number(v);
      if (!isFinite(fh) || fh < 1 || fh > 64 || Math.floor(fh) !== fh) return { qs: "", err: "forecast_hours mimo rozsah 1–64" };
    }
    if (k === "hourly") {
      var items = v.split(",");
      for (var j = 0; j < items.length; j++) {
        if (ALLOWED_HOURLY.indexOf(items[j]) < 0) return { qs: "", err: "nepovolená položka hourly" };
      }
    }
    if (k === "models" && !/^[A-Za-z0-9_.,-]+$/.test(v)) return { qs: "", err: "neplatný formát models" };
    parts.push(k + "=" + encodeURIComponent(v));
    seen[k] = true;
  }
  if (!seen.latitude || !seen.longitude) return { qs: "", err: "chybí latitude/longitude" };
  return { qs: parts.join("&"), err: null };
}

/* ================= SBĚRAČ: KONSTANTY A SEZNAM OBCÍ ================= */

export var SLICE_COUNT = 12;          /* 12 průchodů za hodinu (cron po 5 minutách) */
var RAW_TTL = 1209600;         /* TTL surových záznamů: 14 dní */
var RAW_PREFIX = "raw/";

/* 100 obcí: primárně střední Evropa (CZ/SK/AT/DE/CH/PL/HU/SI/HR), doplněno
   o top lokality a rozličné biomy (Alpy, pobřeží, nížiny, Vysočina,
   středomoří, oceán). Každá obec má vlastní METAR stanici — ověřeno proti
   aviationweather.gov (jen stanice, které tam skutečně hlásí). Pořadí
   určuje i přiřazení do dílku (i % 12) — sousedé v seznamu se do sběru
   střídají po 5 minutách, takže každý dílek míchá země i biomy. */
export var MUNICIPALITIES = [
  /* CZ — 7 */
  { n: "Praha", cc: "CZ", lat: 50.10, lon: 14.26, icao: "LKPR" },
  { n: "Brno", cc: "CZ", lat: 49.15, lon: 16.69, icao: "LKTB" },
  { n: "Ostrava", cc: "CZ", lat: 49.69, lon: 18.11, icao: "LKMT" },
  { n: "Pardubice", cc: "CZ", lat: 50.01, lon: 15.74, icao: "LKPD" },
  { n: "Karlovy Vary", cc: "CZ", lat: 50.20, lon: 12.91, icao: "LKKV" },
  { n: "Plzeň", cc: "CZ", lat: 49.75, lon: 13.38, icao: "LKLN" },
  { n: "Náměšť nad Oslavou", cc: "CZ", lat: 49.17, lon: 16.17, icao: "LKNA" },
  /* SK — 6 */
  { n: "Bratislava", cc: "SK", lat: 48.17, lon: 17.21, icao: "LZIB" },
  { n: "Košice", cc: "SK", lat: 48.66, lon: 21.24, icao: "LZKZ" },
  { n: "Piešťany", cc: "SK", lat: 48.61, lon: 17.83, icao: "LZPP" },
  { n: "Žilina", cc: "SK", lat: 49.23, lon: 18.61, icao: "LZZI" },
  { n: "Sliač", cc: "SK", lat: 48.64, lon: 19.14, icao: "LZSL" },
  { n: "Poprad", cc: "SK", lat: 49.07, lon: 20.30, icao: "LZTT" },
  /* AT — 7 */
  { n: "Vídeň", cc: "AT", lat: 48.12, lon: 16.58, icao: "LOWW" },
  { n: "Štýrský Hradec", cc: "AT", lat: 47.00, lon: 15.45, icao: "LOWG" },
  { n: "Innsbruck", cc: "AT", lat: 47.26, lon: 11.34, icao: "LOWI" },
  { n: "Salzburg", cc: "AT", lat: 47.79, lon: 13.00, icao: "LOWS" },
  { n: "Linec", cc: "AT", lat: 48.23, lon: 14.19, icao: "LOWL" },
  { n: "Celovec", cc: "AT", lat: 46.65, lon: 14.32, icao: "LOWK" },
  { n: "Vídeňské Nové Město", cc: "AT", lat: 47.82, lon: 16.23, icao: "LOAN" },
  /* DE — 20 */
  { n: "Berlín", cc: "DE", lat: 52.38, lon: 13.53, icao: "EDDB" },
  { n: "Mnichov", cc: "DE", lat: 48.35, lon: 11.81, icao: "EDDM" },
  { n: "Frankfurt nad Mohanem", cc: "DE", lat: 50.05, lon: 8.60, icao: "EDDF" },
  { n: "Hamburk", cc: "DE", lat: 53.63, lon: 9.99, icao: "EDDH" },
  { n: "Stuttgart", cc: "DE", lat: 48.69, lon: 9.22, icao: "EDDS" },
  { n: "Kolín nad Rýnem", cc: "DE", lat: 50.87, lon: 7.16, icao: "EDDK" },
  { n: "Lipsko", cc: "DE", lat: 51.44, lon: 12.24, icao: "EDDP" },
  { n: "Norimberk", cc: "DE", lat: 49.50, lon: 11.06, icao: "EDDN" },
  { n: "Hannover", cc: "DE", lat: 52.47, lon: 9.68, icao: "EDDV" },
  { n: "Drážďany", cc: "DE", lat: 51.13, lon: 13.75, icao: "EDDC" },
  { n: "Erfurt", cc: "DE", lat: 50.98, lon: 10.96, icao: "EDDE" },
  { n: "Brémy", cc: "DE", lat: 53.05, lon: 8.79, icao: "EDDW" },
  { n: "Kiel", cc: "DE", lat: 54.38, lon: 10.14, icao: "EDHK" },
  { n: "Lübeck", cc: "DE", lat: 53.81, lon: 10.72, icao: "EDHL" },
  { n: "Friedrichshafen", cc: "DE", lat: 47.67, lon: 9.51, icao: "EDNY" },
  { n: "Karlsruhe", cc: "DE", lat: 48.78, lon: 8.08, icao: "EDSB" },
  { n: "Dortmund", cc: "DE", lat: 51.52, lon: 7.61, icao: "EDLW" },
  { n: "Braunschweig", cc: "DE", lat: 52.32, lon: 10.56, icao: "EDVE" },
  { n: "Hof", cc: "DE", lat: 50.29, lon: 11.86, icao: "EDQM" },
  { n: "Emden", cc: "DE", lat: 53.39, lon: 7.23, icao: "EDWE" },
  /* CH — 9 */
  { n: "Curych", cc: "CH", lat: 47.48, lon: 8.54, icao: "LSZH" },
  { n: "Ženeva", cc: "CH", lat: 46.25, lon: 6.13, icao: "LSGG" },
  { n: "Bern", cc: "CH", lat: 46.91, lon: 7.50, icao: "LSZB" },
  { n: "Lugano", cc: "CH", lat: 46.00, lon: 8.91, icao: "LSZA" },
  { n: "Samedan", cc: "CH", lat: 46.53, lon: 9.88, icao: "LSZS" },
  { n: "Sion", cc: "CH", lat: 46.22, lon: 7.33, icao: "LSGS" },
  { n: "Payerne", cc: "CH", lat: 46.82, lon: 6.94, icao: "LSMP" },
  { n: "Locarno", cc: "CH", lat: 46.17, lon: 8.88, icao: "LSZL" },
  { n: "Basilej", cc: "CH", lat: 47.56, lon: 7.59, icao: "LFSB" },
  /* PL — 11 */
  { n: "Varšava", cc: "PL", lat: 52.16, lon: 20.96, icao: "EPWA" },
  { n: "Krakov", cc: "PL", lat: 50.08, lon: 19.80, icao: "EPKK" },
  { n: "Gdaňsk", cc: "PL", lat: 54.38, lon: 18.47, icao: "EPGD" },
  { n: "Vratislav", cc: "PL", lat: 51.10, lon: 16.90, icao: "EPWR" },
  { n: "Poznaň", cc: "PL", lat: 52.42, lon: 16.85, icao: "EPPO" },
  { n: "Katovice", cc: "PL", lat: 50.48, lon: 19.09, icao: "EPKT" },
  { n: "Řešov", cc: "PL", lat: 50.11, lon: 22.03, icao: "EPRZ" },
  { n: "Štětín", cc: "PL", lat: 53.59, lon: 14.90, icao: "EPSC" },
  { n: "Lodž", cc: "PL", lat: 51.72, lon: 19.40, icao: "EPLL" },
  { n: "Bydhošť", cc: "PL", lat: 53.10, lon: 18.00, icao: "EPBY" },
  { n: "Zelená Hora", cc: "PL", lat: 52.14, lon: 15.78, icao: "EPZG" },
  /* HU — 5 */
  { n: "Budapešť", cc: "HU", lat: 47.44, lon: 19.26, icao: "LHBP" },
  { n: "Debrecín", cc: "HU", lat: 47.49, lon: 21.61, icao: "LHDC" },
  { n: "Pécs", cc: "HU", lat: 45.99, lon: 18.24, icao: "LHPP" },
  { n: "Balaton", cc: "HU", lat: 46.69, lon: 17.16, icao: "LHSM" },
  { n: "Kecskemét", cc: "HU", lat: 46.92, lon: 19.75, icao: "LHKE" },
  /* SI — 3 */
  { n: "Lublaň", cc: "SI", lat: 46.22, lon: 14.48, icao: "LJLJ" },
  { n: "Maribor", cc: "SI", lat: 46.48, lon: 15.68, icao: "LJMB" },
  { n: "Portorož", cc: "SI", lat: 45.47, lon: 13.62, icao: "LJPZ" },
  /* HR — 4 */
  { n: "Záhřeb", cc: "HR", lat: 45.73, lon: 16.05, icao: "LDZA" },
  { n: "Split", cc: "HR", lat: 43.54, lon: 16.30, icao: "LDSP" },
  { n: "Rijeka", cc: "HR", lat: 45.22, lon: 14.57, icao: "LDRI" },
  { n: "Dubrovník", cc: "HR", lat: 42.56, lon: 18.27, icao: "LDDU" },
  /* IT — 6 */
  { n: "Miláno", cc: "IT", lat: 45.46, lon: 9.26, icao: "LIML" },
  { n: "Benátky", cc: "IT", lat: 45.51, lon: 12.35, icao: "LIPZ" },
  { n: "Bolzano", cc: "IT", lat: 46.46, lon: 11.33, icao: "LIPB" },
  { n: "Terst", cc: "IT", lat: 45.83, lon: 13.47, icao: "LIPQ" },
  { n: "Turín", cc: "IT", lat: 45.20, lon: 7.65, icao: "LIMF" },
  { n: "Řím", cc: "IT", lat: 41.80, lon: 12.25, icao: "LIRF" },
  /* FR — 4 */
  { n: "Paříž", cc: "FR", lat: 49.02, lon: 2.54, icao: "LFPG" },
  { n: "Lyon", cc: "FR", lat: 45.73, lon: 5.08, icao: "LFLL" },
  { n: "Štrasburk", cc: "FR", lat: 48.55, lon: 7.64, icao: "LFST" },
  { n: "Nice", cc: "FR", lat: 43.66, lon: 7.22, icao: "LFMN" },
  /* GB — 2 */
  { n: "Londýn", cc: "GB", lat: 51.48, lon: -0.46, icao: "EGLL" },
  { n: "Manchester", cc: "GB", lat: 53.35, lon: -2.28, icao: "EGCC" },
  /* NL — 2 */
  { n: "Amsterdam", cc: "NL", lat: 52.31, lon: 4.79, icao: "EHAM" },
  { n: "Rotterdam", cc: "NL", lat: 51.95, lon: 4.44, icao: "EHRD" },
  /* BE / LU — 2 */
  { n: "Brusel", cc: "BE", lat: 50.90, lon: 4.53, icao: "EBBR" },
  { n: "Lucemburk", cc: "LU", lat: 49.63, lon: 6.20, icao: "ELLX" },
  /* RO — 2 */
  { n: "Bukurešť", cc: "RO", lat: 44.57, lon: 26.10, icao: "LROP" },
  { n: "Kluž", cc: "RO", lat: 46.78, lon: 23.68, icao: "LRCL" },
  /* jihovýchod a východ — 4 */
  { n: "Bělehrad", cc: "RS", lat: 44.82, lon: 20.29, icao: "LYBE" },
  { n: "Lvov", cc: "UA", lat: 49.81, lon: 23.96, icao: "UKLL" },
  { n: "Sofie", cc: "BG", lat: 42.70, lon: 23.32, icao: "LBSF" },
  { n: "Dublin", cc: "IE", lat: 53.42, lon: -6.27, icao: "EIDW" },
  /* sever Evropy — 5 */
  { n: "Kodaně", cc: "DK", lat: 55.62, lon: 12.66, icao: "EKCH" },
  { n: "Helsinky", cc: "FI", lat: 60.32, lon: 24.96, icao: "EFHK" },
  { n: "Bergen", cc: "NO", lat: 60.32, lon: 5.25, icao: "ENBR" },
  { n: "Stockholm", cc: "SE", lat: 59.65, lon: 17.92, icao: "ESSA" },
  { n: "Riga", cc: "LV", lat: 56.95, lon: 23.97, icao: "EVRA" },
  { n: "Šiauliai", cc: "LT", lat: 55.90, lon: 23.40, icao: "EYSA" }
];

/* Pořadí MUNICIPALITIES je jediný zdroj přiřazení do dílku: i % 12.
   Zaručuje, že každá obec je nasbírána právě jednou za hodinu, ve stejnou
   minutu, a že výpadky jednoho probuzení neztratí data ostatních. */
export function placesForSlice(slice) {
  var out = [];
  for (var i = 0; i < MUNICIPALITIES.length; i++) {
    if (i % SLICE_COUNT === slice) out.push(MUNICIPALITIES[i]);
  }
  return out;
}

/* Zrcadlí ensembleCandidates aplikace: icon_d2 EPS (2,2 km) uvnitř boxu
   střední Evropy, jinak icon_eu EPS (7 km). */
export function ensModelFor(lat, lon) {
  return ensCandidates(lat, lon)[0];
}

/* Zrcadlí ensembleCandidates aplikace: pořadí modelů pro fallback.
   Okrajové obce (mřížka 3×3 může přesáhnout doménu) spadnou na další
   model — stejný tryNext mechanismus jako v appce. */
export function ensCandidates(lat, lon) {
  var c = [];
  if (lat >= 43.2 && lat <= 58.1 && lon >= -3.9 && lon <= 20.3) c.push("icon_d2");
  if (lat >= 29.5 && lat <= 70.5 && lon >= -23.5 && lon <= 45) c.push("icon_eu");
  c.push("ecmwf_ifs025");
  c.push("gfs_seamless");
  return c;
}

/* Zrcadlí ensembleGrid aplikace: střed + 8 okolních bodů (±0.1° lat,
   ±0.15° lon ~ 11×11 km). Appka z těchto bodů počítá NEP pravděpodobnost. */
export function ensGrid(lat, lon) {
  var pts = [[+lat.toFixed(4), +lon.toFixed(4)]];
  for (var a = -1; a <= 1; a++) {
    for (var b = -1; b <= 1; b++) {
      if (a === 0 && b === 0) continue;
      pts.push([+ (lat + a * 0.1).toFixed(4), + (lon + b * 0.15).toFixed(4)]);
    }
  }
  return pts;
}

export function buildFcUrl(p) {
  return "https://api.open-meteo.com/v1/forecast?latitude=" + p.lat + "&longitude=" + p.lon
    + "&current=precipitation,rain,showers,snowfall,weather_code"
    + "&minutely_15=precipitation,rain,showers,snowfall&forecast_minutely_15=8"
    + "&hourly=precipitation_probability&forecast_hours=13"
    + "&timeformat=unixtime&timezone=UTC";
}

export function buildEnsUrl(p, model) {
  var g = ensGrid(p.lat, p.lon);
  return "https://ensemble-api.open-meteo.com/v1/ensemble?latitude="
    + g.map(function (q) { return q[0]; }).join(",")
    + "&longitude=" + g.map(function (q) { return q[1]; }).join(",")
    + "&hourly=precipitation&models=" + (model || ensModelFor(p.lat, p.lon))
    + "&forecast_hours=9&timeformat=unixtime&timezone=UTC";
}

function metarUrl(icaos) {
  return "https://aviationweather.gov/api/data/metar?ids=" + icaos.join(",") + "&format=json";
}

/* ---- kvantizace (drží záznamy malé) ---- */
function q1(v) { return (typeof v === "number" && isFinite(v) && v >= 0) ? Math.round(v * 10) / 10 : null; }
function q2(v) { return (typeof v === "number" && isFinite(v) && v >= 0) ? Math.round(v * 100) / 100 : null; }

/* ---- METAR: přítomné počasí z tokenů ----
   Gramatika: [intenzita](deskriptor)(jev)[jev], intenzita -/+/VC/RE.
   Zajímají nás srážkové jevy (RA, DZ, SN, SG, PL, IC, GR, GS, UP);
   mlhy a zamlžení (BR, FG, HZ...) záměrně NEjsou jevy v tomto testu. */
var WX_TOKEN_RE = /^(-|\+|VC|RE)?(MI|BC|PR|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|PL|IC|GR|GS|UP)?(DZ|RA|SN|SG|PL|IC|GR|GS|UP)?$/;

export function parseMetar(rawOb) {
  var out = { raw: String(rawOb), r: 0, i: 0, s: 0, th: 0, sh: 0, re: 0, vc: 0 };
  var toks = String(rawOb).replace(/^METAR |^SPECI /, "").split(/\s+/);
  for (var i = 0; i < toks.length; i++) {
    /* Konec hlavního těla zprávy: trendové skupiny (TEMPO/BECMG — předpověď
       vývoje, nikoli pozorování), NOSIG a RMK nesmí do hodnocení aktuálního
       počasí. Jinak by např. „TEMPO 2000 -DZRA BR“ z Basileje (11× za noc,
       aktuálně jen zataženo s mlhou) počítalo jako reálný déšť. */
    if (toks[i] === "TEMPO" || toks[i] === "BECMG" || toks[i] === "NOSIG" || toks[i] === "RMK") break;
    var m = WX_TOKEN_RE.exec(toks[i]);
    if (!m) continue;
    var pre = m[1] || "", desc = m[2] || "";
    var jevy = (m[3] || "") + (m[4] || "");
    if (!desc && !jevy) continue;
    if (pre === "VC") { out.vc = 1; continue; }
    if (pre === "RE") { if (jevy.indexOf("RA") >= 0 || jevy.indexOf("DZ") >= 0) out.re = 1; continue; }
    if (jevy.indexOf("RA") >= 0 || jevy.indexOf("DZ") >= 0 || jevy.indexOf("UP") >= 0) {
      out.r = 1;
      out.i = pre === "-" ? 1 : (pre === "+" ? 3 : 2);
    }
    if (jevy.indexOf("SN") >= 0 || jevy.indexOf("SG") >= 0 || jevy.indexOf("PL") >= 0
      || jevy.indexOf("IC") >= 0 || jevy.indexOf("GR") >= 0 || jevy.indexOf("GS") >= 0) {
      out.s = 1;
    }
    if (desc.indexOf("TS") >= 0 || pre === "TS") out.th = 1;
    if (desc.indexOf("SH") >= 0) out.sh = 1;
  }
  return out;
}

/* ---- parsování forecast odpovědi (current + minutely_15 + probability) ---- */
export function parseFc(body) {
  var j = typeof body === "string" ? JSON.parse(body) : body;
  var out = { c: null, m: null, pp: null, h0: null };
  var c = j && j.current;
  if (c && typeof c.time === "number") {
    var mh = null;
    if (typeof c.precipitation === "number" && typeof c.interval === "number" && c.interval > 0) {
      mh = q2(c.precipitation * 3600 / c.interval);
    }
    out.c = { t: c.time, iv: c.interval, p: q2(c.precipitation), mh: mh, cd: c.weather_code };
  }
  var m15 = j && j.minutely_15;
  if (m15 && Array.isArray(m15.time) && m15.time.length) {
    out.m = m15.time.map(function (ts, i) {
      return [ts, q2(m15.precipitation && m15.precipitation[i]),
        q2(m15.rain && m15.rain[i]), q2(m15.showers && m15.showers[i]),
        q2(m15.snowfall && m15.snowfall[i])];
    });
  }
  var h = j && j.hourly;
  if (h && Array.isArray(h.precipitation_probability)) {
    out.pp = h.precipitation_probability.map(function (v) {
      return (typeof v === "number" && isFinite(v)) ? Math.round(v) : null;
    });
    out.h0 = Array.isArray(h.time) ? h.time[0] : null;
  }
  return out;
}

/* ---- parsování ensemble odpovědi — zrcadlí ensembleFromJson aplikace ----
   Klíče precipitation_memberN (+ případný deterministický „precipitation"
   jako nultý člen). Vrací pole bodů [{t0, v:[[člen][9 hodin]...]}...],
   pořadí bodů = pořadí v dotazu (první = střed obce). */
export function parseEns(body) {
  var j = typeof body === "string" ? JSON.parse(body) : body;
  var pts = Array.isArray(j) ? j : [j];
  var out = [];
  for (var i = 0; i < pts.length; i++) {
    var h = (pts[i] && pts[i].hourly) || {};
    var keys = Object.keys(h).filter(function (k) { return k.indexOf("precipitation_member") === 0; });
    if (h.precipitation) keys.unshift("precipitation");
    if (keys.length < 5) continue;
    var members = [];
    for (var k = 0; k < keys.length; k++) {
      var arr = h[keys[k]] || [];
      var row = [];
      var any = false;
      for (var v = 0; v < 9; v++) {
        var q = q1(arr[v]);
        row.push(q);
        if (q != null) any = true;
      }
      if (any) members.push(row);
    }
    if (members.length >= 5) out.push({ t0: Array.isArray(h.time) ? h.time[0] : null, v: members });
  }
  return out.length ? out : null;
}

/* ================= RADAR RAINVIEWER (kolo 8ag) =================
   Aplikace čte radar přes <img>+canvas; Worker canvas nemá. PNG ale
   zvládne dekódovat sám: IDAT je zlib proud (DecompressionStream),
   unfiltr řádků je pět krátkých aritmetik. Dlaždice 256×256, 8 bitů,
   RGBA (ověřeno na živém snímku). Čteme jen výřez (2r+1)² kolem
   obce — ostatní řádky se sice musí unfiltrovat (filtry odkazují na
   řádek předchozí), ale v paměti držíme vždy jen dva řádky. */

var RV_Z = 7;                                   /* detail intenzity — nativní maximum appky */
var RV_OPTS = "/0/0_1.png";                     /* schéma 0 (dBZ v červeném kanálu) + sněhový příznak */
var RV_TOL_MS = 12 * 60 * 1000;                  /* snímek nesmí být starší ~12 min */
var RV_MAPS_URL = "https://api.rainviewer.com/public/weather-maps.json";
var RV_SANE_MMH = 150;                          /* strop fyzikální kontrola — jako MAX_SANE_MMH appky */
var RV_MAPS_TTL = 5 * 60 * 1000;                /* maps.json v izolátu 5 min (appka stejně) */
var MAPS_MEM = { t: 0, v: null };               /* izolát zaniká, cache je jen optimalizace */

/* Zrcadlí tileCoords aplikace. */
export function tileCoords(lat, lon, z) {
  var n = Math.pow(2, z);
  var latR = lat * Math.PI / 180;
  var xf = (lon + 180) / 360 * n;
  var yf = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
  var tx = Math.floor(xf), ty = Math.floor(yf);
  return { z: z, n: n, tx: tx, ty: ty, px: Math.floor((xf - tx) * 256), py: Math.floor((yf - ty) * 256) };
}

/* Zrcadlí dbzToMm aplikace: Z=200·R^1,6 déšť, Z=2000·R² sníh (vodní
   ekvivalent). Pod 10 dBZ šum/mrholení → 0, nad 75 dBZ vadný pixel → 0. */
export function dbzToMm(dbz, isSnow) {
  if (dbz == null || typeof dbz !== "number" || isNaN(dbz)) return 0;
  if (dbz < 10) return 0;
  if (dbz > 75) return 0;
  var zlin = Math.pow(10, dbz / 10);
  var mm = isSnow ? Math.sqrt(zlin / 2000) : Math.pow(zlin / 200, 1 / 1.6);
  return Math.min(mm, RV_SANE_MMH);
}

/* Ze weather-maps.json vybere snímek z radar.past nejbližší času now.
   Vrací {host, path, time} nebo null (žádný čerstvý snímek / rozbitý JSON). */
export function pickFrame(mapsJson, nowMs) {
  try {
    var j = typeof mapsJson === "string" ? JSON.parse(mapsJson) : mapsJson;
    var past = (j && j.radar && j.radar.past) || [];
    var best = null, bestDt = Infinity;
    for (var i = 0; i < past.length; i++) {
      var dt = Math.abs(past[i].time * 1000 - nowMs);
      if (dt < bestDt) { bestDt = dt; best = past[i]; }
    }
    if (!best || bestDt > RV_TOL_MS) return null;
    return { host: j.host || "https://tilecache.rainviewer.com", path: best.path, time: best.time };
  } catch (e) { return null; }
}

export function rvTileUrl(host, path, tc) {
  return host + path + "/256/" + tc.z + "/" + tc.tx + "/" + tc.ty + RV_OPTS;
}

/* ---- PNG dekodér (jen výřez) ---- */

async function inflateZlib(chunks) {
  var total = 0;
  for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
  var z = new Uint8Array(total);
  var off = 0;
  for (var k = 0; k < chunks.length; k++) { z.set(chunks[k], off); off += chunks[k].length; }
  var DS = (typeof DecompressionStream !== "undefined") ? DecompressionStream : null;
  if (!DS) throw new Error("runtime bez DecompressionStream");
  var stream = new Blob([z]).stream().pipeThrough(new DS("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a, b, c) {
  var p = a + b - c;
  var pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/* Dekóduje PNG (8bit RGBA, neklacovaný) a vrátí výřez (2r+1)² pixelů
   kolem [px,py] jako pole {d: dBZ|null, s: sníh, m: mm/h}. Alfa 0 =
   bez odrazu → d:null, m:0 (přesně jako readTilePatch aplikace).
   Jakákoli chyba → null (nikdy nevyhazuje). */
export async function pngDecodePatch(bytes, px, py, r) {
  try {
    if (!bytes || bytes.length < 8) return null;
    var sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (var s = 0; s < 8; s++) if (bytes[s] !== sig[s]) return null;
    var pos = 8, w = 0, h = 0, idat = [], seenIhdr = false;
    while (pos + 8 <= bytes.length) {
      var len = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
      if (pos + 12 + len > bytes.length) return null;
      var type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      var data = bytes.subarray(pos + 8, pos + 8 + len);
      if (type === "IHDR") {
        w = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
        h = ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
        if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) return null; /* 8bit RGBA, bez interlacingu */
        seenIhdr = true;
      } else if (type === "IDAT") {
        idat.push(data);
      }
      pos += 12 + len;
      if (type === "IEND") break;
    }
    if (!seenIhdr || !w || !h || !idat.length) return null;
    var raw = await inflateZlib(idat);
    var bpp = 4, stride = w * bpp;
    if (raw.length < (stride + 1) * h) return null;
    var x0 = Math.max(0, Math.min(w - 1 - 2 * r, px - r));
    var y0 = Math.max(0, Math.min(h - 1 - 2 * r, py - r));
    var n = 2 * r + 1;
    var prev = new Uint8Array(stride), cur = new Uint8Array(stride);
    var out = new Array(n * n), oi = 0;
    for (var y = 0; y < h; y++) {
      var f = raw[y * (stride + 1)];
      var rs = y * (stride + 1) + 1;
      for (var x = 0; x < stride; x++) cur[x] = raw[rs + x];
      if (f === 1) { for (var x1 = bpp; x1 < stride; x1++) cur[x1] = (cur[x1] + cur[x1 - bpp]) & 255; }
      else if (f === 2) { for (var x2 = 0; x2 < stride; x2++) cur[x2] = (cur[x2] + prev[x2]) & 255; }
      else if (f === 3) { for (var x3 = 0; x3 < stride; x3++) { var le = x3 < bpp ? 0 : cur[x3 - bpp]; cur[x3] = (cur[x3] + ((le + prev[x3]) >> 1)) & 255; } }
      else if (f === 4) { for (var x4 = 0; x4 < stride; x4++) { cur[x4] = (cur[x4] + paeth(x4 < bpp ? 0 : cur[x4 - bpp], prev[x4], x4 < bpp ? 0 : prev[x4 - bpp])) & 255; } }
      else if (f > 4) return null;
      if (y >= y0 && y < y0 + n) {
        for (var p = 0; p < n; p++) {
          var xi = (x0 + p) * bpp;
          if (cur[xi + 3] === 0) { out[oi] = { d: null, s: false, m: 0 }; }
          else {
            var red = cur[xi];
            var snow = (red & 128) !== 0;
            var dbz = (red & 127) - 32;
            out[oi] = { d: dbz, s: snow, m: dbzToMm(dbz, snow) };
          }
          oi++;
        }
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return out;
  } catch (e) { return null; }
}

/* maps.json s keší izolátu (5 min); chybu vrací jako výjimku, voličel
   v collectSlice ji toleruje (radar jen chybí v záznamu). */
async function radarFrame(fetchImpl, nowMs) {
  if (MAPS_MEM.v && nowMs - MAPS_MEM.t < RV_MAPS_TTL) return MAPS_MEM.v;
  var res = await fetchImpl(RV_MAPS_URL, { headers: { "user-agent": "bude-prset-proxy/1.0" } });
  if (!res.ok) throw new Error("maps " + res.status);
  var frame = pickFrame(await res.text(), nowMs);
  MAPS_MEM = { t: nowMs, v: frame };
  return frame;
}

/* Jedno radarové čtení pro obec: medián mm/h z 3×3 pixelů (r=1) kolem
   obce + sněhový příznak většiny odrazů. Vrací {t, mm, ec, sn}. */
async function rvRead(fetchImpl, frame, p) {
  var tc = tileCoords(p.lat, p.lon, RV_Z);
  var res = await fetchImpl(rvTileUrl(frame.host, frame.path, tc), { headers: { "user-agent": "bude-prset-proxy/1.0" } });
  if (!res.ok) throw new Error("tile " + res.status);
  var patch = await pngDecodePatch(new Uint8Array(await res.arrayBuffer()), tc.px, tc.py, 1);
  if (!patch) throw new Error("tile decode");
  var vals = patch.map(function (q) { return q.m; }).filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; });
  if (!vals.length) throw new Error("tile bez dat");
  var echo = patch.filter(function (q) { return q.d != null; }).length;
  return {
    t: frame.time,
    mm: q2(vals[Math.floor(vals.length / 2)]),
    ec: echo,
    sn: patch.filter(function (q) { return q.d != null && q.s; }).length * 2 > echo ? 1 : 0
  };
}

/* ---- klíč raw záznamu ---- */
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function hourKey(d) {
  return "" + d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + pad2(d.getUTCHours());
}
function rawKey(h, minute) { return RAW_PREFIX + h + ":" + pad2(minute); }

/* ---- jedno probuzení cronu: sebere svůj dílek obcí ---- */
async function collectSlice(deps, slice, now) {
  var fetchImpl = deps.fetchImpl;
  var places = placesForSlice(slice);
  var h = hourKey(now);
  var minute = now.getUTCMinutes();

  /* METAR pro celý dílek v jednom hromadném dotazu (1 subrequest). */
  var metMap = {};
  var metP = (async function () {
    try {
      var ids = places.map(function (p) { return p.icao; });
      var res = await fetchImpl(metarUrl(ids), { headers: { "user-agent": "bude-prset-proxy/1.0" } });
      if (!res.ok) return;
      var arr = await res.json();
      if (!Array.isArray(arr)) return;
      arr.forEach(function (m) {
        if (m && m.icaoId) metMap[m.icaoId] = m;
      });
    } catch (e) { /* ground truth chybí → záznam zůstane bez met */ }
  })();

  var record = { t: Math.floor(now.getTime() / 1000), h: h, slice: slice, p: {} };

  /* Radar RainViewer: snímek sdílený pro celý dílek (1 dotaz na
     maps.json, keš izolátu 5 min), pak 1 dlaždice na obec. */
  var rvFrame = null;
  try { rvFrame = await radarFrame(fetchImpl, now.getTime()); } catch (e) { rvFrame = null; }

  await Promise.all(places.map(async function (p) {
    var entry = { n: p.n, cc: p.cc, lat: p.lat, lon: p.lon, icao: p.icao };
    var errs = [];
    try {
      var r = await fetchImpl(buildFcUrl(p), { headers: { "user-agent": "bude-prset-proxy/1.0" } });
      if (!r.ok) throw new Error("fc " + r.status);
      entry.fc = parseFc(await r.text());
    } catch (e) { errs.push("fc"); }
    try {
      var parsed = null, usedModel = null;
      var cands = ensCandidates(p.lat, p.lon);
      for (var ci = 0; ci < cands.length && !parsed; ci++) {
        try {
          var r2 = await fetchImpl(buildEnsUrl(p, cands[ci]), { headers: { "user-agent": "bude-prset-proxy/1.0" } });
          if (!r2.ok) continue;                    /* doména modelu — zkusíme další */
          parsed = parseEns(await r2.text());
          if (parsed) usedModel = cands[ci];
        } catch (e2) { /* další kandidát */ }
      }
      if (!parsed) throw new Error("ens bez clenu");
      entry.ens = { m: usedModel, t0: parsed[0] && parsed[0].t0, g: parsed.map(function (pt) { return pt.v; }) };
    } catch (e) { errs.push("ens"); }
    if (rvFrame) {
      try { entry.rv = await rvRead(fetchImpl, rvFrame, p); }
      catch (e) { /* radar chybí → err níže */ }
    }
    record.p[p.n] = entry;
  }));

  await metP;
  Object.keys(record.p).forEach(function (name) {
    var e = record.p[name];
    var m = metMap[e.icao];
    if (m) {
      var pm = parseMetar(m.rawOb || "");
      e.met = { t: (typeof m.obsTime === "number" ? m.obsTime : null), tp: (typeof m.temp === "number" ? m.temp : null), r: pm.r, i: pm.i, s: pm.s, th: pm.th, sh: pm.sh, re: pm.re, vc: pm.vc, raw: pm.raw };
    }
    var errs = [];
    if (!e.fc) errs.push("fc");
    if (!e.ens) errs.push("ens");
    if (!e.met) errs.push("met");
    if (!e.rv) errs.push("rv");
    if (errs.length) e.err = errs;
  });

  return { key: rawKey(h, minute), record: record };
}

/* ================= DASHBOARD /analysis ================= */

function analysisHtml() {
  var esc = JSON.stringify;
  return "<!doctype html><html lang=\"cs\"><head><meta charset=\"utf-8\">"
    + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<title>Bude pršet? — sběr předpovědí</title><style>"
    + "body{font-family:system-ui,sans-serif;margin:1rem;max-width:60rem;color:#123}"
    + "table{border-collapse:collapse;font-size:.85rem;width:100%}"
    + "td,th{border-bottom:1px solid #ddd;padding:.25rem .4rem;text-align:left}"
    + "button{margin:.2rem .3rem .2rem 0;padding:.4rem .7rem}"
    + "input,select{padding:.35rem}"
    + ".ok{color:#0a7}.bad{color:#c33}.muted{color:#789}"
    + "</style></head><body>"
    + "<h2>Sběř předpovědí — 100 obcí, 1× za hodinu</h2>"
    + "<p id=\"status\" class=\"muted\">načítám status…</p>"
    + "<p><label>Datum <input type=\"date\" id=\"d\"></label>"
    + " <label>Hodina (UTC) <input type=\"number\" id=\"hh\" min=\"0\" max=\"23\" value=\"" + new Date().getUTCHours() + "\"></label>"
    + "<button id=\"bPrev\">Náhled hodiny</button>"
    + "<button id=\"bHour\">Stáhnout JSON hodiny</button>"
    + "<button id=\"bDay\">Stáhnout JSON celého dne</button></p>"
    + "<div id=\"tbl\"></div><script>"
    + "var S=" + esc("/analysis/status") + ",P=" + esc("/analysis/page") + ";"
    + "function pad(n){return (n<10?'0':'')+n}"
    + "function hkey(){var d=document.getElementById('d').value.replace(/-/g,'');return d+pad(+document.getElementById('hh').value)}"
    + "function dl(name,obj){var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(obj)],{type:'application/json'}));a.download=name;a.click()}"
    + "fetch(S).then(r=>r.json()).then(s=>{document.getElementById('status').textContent="
    + "'KV: '+(s.kv?'připojeno':'CHYBÍ')+' · obcí: '+s.places+' · poslední zápis: '+(s.last?s.last.key+' ('+s.last.n_ok+' obcí bez chyby)':'—')}).catch(e=>{document.getElementById('status').textContent='status nedostupný'})"
    + "document.getElementById('bPrev').onclick=function(){var h=hkey();"
    + "fetch(P+'?h='+h).then(r=>r.json()).then(show)}"
    + "document.getElementById('bHour').onclick=function(){var h=hkey();"
    + "fetch(P+'?h='+h).then(r=>r.json()).then(j=>dl('bp-'+h+'.json',j))}"
    + "document.getElementById('bDay').onclick=async function(){"
    + "var day=document.getElementById('d').value.replace(/-/g,'');var all={};"
    + "for(var hh=0;hh<24;hh++){var h=day+pad(hh);"
    + "try{var j=await (await fetch(P+'?h='+h)).json();if(j&&j.found&&j.found.length)all[h]=j}catch(e){}}"
    + "dl('bp-'+day+'.json',all)}"
    + "function show(j){if(!j||!j.found||!j.found.length){document.getElementById('tbl').textContent='Pro tuto hodinu zatím nejsou žádné záznamy.';return}"
    + "var rows='';j.meta.forEach(function(m){var s=(j.slices||[]).map(function(sl){return sl.p[m.n]}).filter(Boolean)[0];"
    + "if(!s){rows+='<tr><td>'+m.n+'</td><td colspan=6 class=muted>dosud nesebráno</td></tr>';return}"
    + "var nc=function(v){return v==null?'—':v};"
    + "var m15=s.fc&&s.fc.m?[2,3,4].map(function(i){return s.fc.m[i]?nc(s.fc.m[i][1]*4):'—'}):['—','—','—'];"
    + "var pe=0,ne=0;if(s.ens&&s.ens.g&&s.ens.g[0]){s.ens.g[0].forEach(function(mem){var hit=false;for(var i=0;i<3;i++){if(mem[i]!=null&&mem[i]>=0.1){hit=true}}if(hit)pe++});ne=s.ens.g[0].length}"
    + "rows+='<tr><td>'+m.n+' <span class=muted>'+m.cc+'</span></td>'"
    + "+'<td>'+(s.met?(s.met.r?'<span class=bad>★ PRŠÍ</span>':'ne'):'—')+'</td>'"
    + "+'<td>'+nc(s.fc&&s.fc.c?s.fc.c.mh:'—')+'</td>'"
    + "+'<td>'+m15[0]+'/'+m15[1]+'/'+m15[2]+'</td>'"
    + "+'<td>'+(ne?Math.round(100*pe/ne)+' %':'—')+'</td>'"
    + "+'<td class=muted>'+(s.err?'chybí: '+s.err.join(','):'ok')+'</td></tr>'})"
    + "document.getElementById('tbl').innerHTML='<table><tr><th>Obec</th><th>METAR</th><th>model nyní mm/h</th><th>nowcast +30/45/60 min mm/h</th><th>ensemble P(0–3 h)</th><th>stav</th></tr>'+rows+'</table>'}"
    + "</script></body></html>";
}

/* ================= WORKER ================= */

export function createWorker(deps) {
  var fetchImpl = deps.fetchImpl;
  var cache = deps.cache || null;
  var kv = deps.kv || null;
  var nowFn = deps.now || function () { return new Date(); };

  async function handle(request) {
    var u = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" } });
    if (request.method !== "GET") return json(405, { error: "pouze GET" });

    if (u.pathname === "/healthz") {
      return json(200, {
        ok: true, service: "bude-prset-proxy", endpoints: Object.keys(UPSTREAMS),
        collector: { places: MUNICIPALITIES.length, slices: SLICE_COUNT, kv: !!kv },
        analysis: ["/analysis", "/analysis/page", "/analysis/status"],
        chmi: ["/chmi/img", "/chmi/fct"]
      });
    }

    if (u.pathname === "/analysis") {
      return new Response(analysisHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
      });
    }

    if (u.pathname === "/analysis/status") {
      var now = nowFn();
      var out = { ok: true, kv: !!kv, places: MUNICIPALITIES.length, slices: SLICE_COUNT, recent: [], last: null };
      if (!kv) return json(200, out);
      /* Projdeme klíče zpětně od teď (max ~13 čtení) a vrátíme souhrn. */
      var curH = new Date(now.getTime() - 5 * 60 * 1000);
      var candidates = [];
      for (var back = 0; back < 3; back++) {
        var d = new Date(curH.getTime() - back * 60 * 60 * 1000);
        var hk = hourKey(d);
        var maxM = back === 0 ? Math.floor(d.getUTCMinutes() / 5) : 11;
        for (var s = maxM; s >= 0; s--) candidates.push(rawKey(hk, s * 5));
      }
      for (var ci = 0; ci < candidates.length && out.recent.length < 13; ci++) {
        var val = await kv.get(candidates[ci]);
        if (!val) continue;
        var rec = JSON.parse(val);
        var names = Object.keys(rec.p || {});
        var nok = names.filter(function (n) { return !rec.p[n].err; }).length;
        var entry = { key: candidates[ci], t: rec.t, n: names.length, n_ok: nok };
        out.recent.push(entry);
        if (!out.last) out.last = entry;
      }
      return json(200, out);
    }

    if (u.pathname === "/analysis/page") {
      var h = u.searchParams.get("h") || "";
      if (!/^\d{10}$/.test(h)) return json(400, { error: "parametr h musí být YYYYMMDDHH (10 číslic)" });
      if (!kv) return json(503, { error: "KV binding HISTORY není připojen" });
      var slices = [];
      var found = [];
      for (var mm = 0; mm < SLICE_COUNT; mm++) {
        var key = RAW_PREFIX + h + ":" + pad2(mm * 5);
        var v = await kv.get(key);
        if (v) {
          found.push(pad2(mm * 5));
          slices.push(JSON.parse(v));
        }
      }
      return json(200, {
        ok: true, h: h, found: found,
        meta: MUNICIPALITIES.map(function (m) { return { n: m.n, cc: m.cc, lat: m.lat, lon: m.lon, icao: m.icao }; }),
        slices: slices
      });
    }

    /* --- ČHMÚ: kompozit/legenda (passthrough PNG s CORS *) --- */
    if (u.pathname === "/chmi/img") {
      var cp = u.searchParams.get("u") || "";
      if (cp.charAt(0) !== "/" || cp.slice(-4).toLowerCase() !== ".png"
         || cp.indexOf("..") >= 0 || !CHMI_PATH_RE.test(cp))
        return json(400, { error: "cesta musí být .png pod /meteorology/weather/radar/" });
      var chmiUrl = CHMI_HOST + cp;
      var chmiTtl = chmiCacheTtl(cp);
      if (cache) {
        var chHit = await cache.match(chmiUrl);
        if (chHit) {
          var chHitBody = await chHit.arrayBuffer();
          return new Response(chHitBody, {
            status: 200,
            headers: {
              "content-type": "image/png", "access-control-allow-origin": "*",
              "cache-control": "public, max-age=" + chmiTtl, "x-bp-cache": "HIT"
            }
          });
        }
      }
      var chUp;
      try {
        chUp = await fetchImpl(chmiUrl, { headers: { "user-agent": "bude-prset-proxy/1.0 (+https://github.com/daviscoder123/bude_prset)" } });
      } catch (e) {
        return json(502, { error: "ČHMÚ nedostupné", detail: String(e && e.message || e) });
      }
      if (!chUp.ok) return json(chUp.status === 404 ? 404 : 502, { error: "ČHMÚ vrátilo " + chUp.status });
      var chBody = new Uint8Array(await chUp.arrayBuffer());
      if (cache) {
        try {
          await cache.put(chmiUrl, new Response(chBody, {
            status: 200,
            headers: { "content-type": "image/png", "cache-control": "public, max-age=" + chmiTtl }
          }));
        } catch (e) { /* cache je doplněk */ }
      }
      return new Response(chBody, {
        status: 200,
        headers: {
          "content-type": "image/png", "access-control-allow-origin": "*",
          "cache-control": "public, max-age=" + chmiTtl, "x-bp-cache": "MISS"
        }
      });
    }

    /* --- ČHMÚ: předpověď z TAR archivu (jeden člen jako PNG) --- */
    if (u.pathname === "/chmi/fct") {
      var fBase = u.searchParams.get("base") || "";
      var fLead = u.searchParams.get("lead") || "";
      if (!/^\d{8}\.\d{4}$/.test(fBase)) return json(400, { error: "base musí být YYYYMMDD.HHMM" });
      if (CHMI_FCT_LEADS.indexOf(fLead) < 0) return json(400, { error: "lead musí být 10–60 po deseti" });
      var tarUrl = CHMI_HOST + "/meteorology/weather/radar/composite/fct_pseudocappi2km/png/"
        + "pacz2gmaps3.fct_z_cappi020." + fBase + ".ft60s10.tar";
      var tarBytes = null;
      if (cache) {
        var tarHit = await cache.match(tarUrl);
        if (tarHit) tarBytes = new Uint8Array(await tarHit.arrayBuffer());
      }
      if (!tarBytes) {
        var tarUp;
        try {
          tarUp = await fetchImpl(tarUrl, { headers: { "user-agent": "bude-prset-proxy/1.0 (+https://github.com/daviscoder123/bude_prset)" } });
        } catch (e) {
          return json(502, { error: "ČHMÚ nedostupné", detail: String(e && e.message || e) });
        }
        if (!tarUp.ok) return json(tarUp.status === 404 ? 404 : 502, { error: "ČHMÚ vrátilo " + tarUp.status });
        tarBytes = new Uint8Array(await tarUp.arrayBuffer());
        if (cache) {
          try {
            await cache.put(tarUrl, new Response(tarBytes, {
              status: 200,
              headers: { "content-type": "application/x-tar", "cache-control": "public, max-age=" + CHMI_TAR_TTL }
            }));
          } catch (e) { /* cache je doplněk */ }
        }
      }
      var member = tarFindMember(tarBytes, fLead);
      if (!member) return json(404, { error: "v TARu není člen +" + fLead + " min" });
      return new Response(member, {
        status: 200,
        headers: {
          "content-type": "image/png", "access-control-allow-origin": "*",
          "cache-control": "public, max-age=" + CHMI_TAR_TTL, "x-bp-cache": "MISS"
        }
      });
    }

    var up = UPSTREAMS[u.pathname];
    if (!up) return json(404, { error: "neznámý endpoint" });

    var b = buildUpstreamQs(u.searchParams);
    if (b.err) return json(400, { error: b.err });

    var upstreamUrl = up.host + up.path + "?" + b.qs;

    if (cache) {
      var hit = await cache.match(upstreamUrl);
      if (hit) {
        var hitBody = await hit.text();
        var hitHeaders = {};
        hit.headers.forEach(function (val, key) { hitHeaders[key] = val; });
        hitHeaders["x-bp-cache"] = "HIT";
        /* CORS není v uložené kopii — doplníme vždy (hit i miss ho musí mít). */
        if (!hitHeaders["access-control-allow-origin"]) hitHeaders["access-control-allow-origin"] = "*";
        return new Response(hitBody, { status: 200, headers: hitHeaders });
      }
    }

    var upstream;
    try {
      upstream = await fetchImpl(upstreamUrl, { headers: { "user-agent": "bude-prset-proxy/1.0 (+https://github.com/daviscoder123/bude_prset)" } });
    } catch (e) {
      return json(502, { error: "upstream nedostupný", detail: String(e && e.message || e) });
    }
    if (!upstream.ok) {
      return json(502, { error: "upstream vrátil " + upstream.status, upstream_status: upstream.status });
    }

    var body = await upstream.text();
    var outHeaders = { "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=" + up.ttl, "x-bp-cache": "MISS" };

    if (cache) {
      try {
        var storeHeaders = { "content-type": outHeaders["content-type"], "cache-control": "public, max-age=" + up.ttl };
        await cache.put(upstreamUrl, new Response(body, { status: 200, headers: storeHeaders }));
      } catch (e) {
        /* Cache je doplněk — nezaznamenaný zápis nesmí shodit odpověď. */
      }
    }
    return new Response(body, { status: 200, headers: outHeaders });
  }

  async function scheduled(event) {
    if (!kv) return { ok: false, reason: "bez KV bindingu HISTORY sběrač stojí" };
    try {
      var now = new Date(event.scheduledTime);
      var slice = Math.floor(now.getUTCMinutes() / 5) % SLICE_COUNT;
      var res = await collectSlice({ fetchImpl: fetchImpl }, slice, now);
      await kv.put(res.key, JSON.stringify(res.record), { expirationTtl: RAW_TTL });
      return { ok: true, key: res.key, places: Object.keys(res.record.p).length };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  }

  return {
    fetch: function (request) {
      return handle(request).catch(function (e) {
        return json(500, { error: "worker selhal", detail: String(e && e.message || e) });
      });
    },
    scheduled: scheduled
  };
}

export default {
  fetch: function (request, env) {
    return createWorker({
      fetchImpl: fetch,
      cache: (typeof caches !== "undefined" && caches.default) || null,
      kv: (env && env.HISTORY) || null
    }).fetch(request);
  },
  scheduled: function (event, env) {
    return createWorker({
      fetchImpl: fetch,
      cache: (typeof caches !== "undefined" && caches.default) || null,
      kv: (env && env.HISTORY) || null
    }).scheduled(event);
  }
};
