/**
 * Testy edge proxy (worker/worker.mjs) — Pilíř A, kolo 8ac.
 * Node --test, nula závislostí. Worker je ES modul (worker.mjs),
 * proto se v testech načítá přes dynamic import; fetchImpl a cache
 * se vstřikují přes createWorker(deps).
 */
const test = require("node:test");
const assert = require("node:assert");

/* Jednoduchá mock cache se stejným kontraktem jako CF Cache API. */
function mockCache() {
  const store = new Map();
  return {
    calls: 0,
    async match(url) {
      this.calls++;
      return store.get(url);
    },
    async put(url, resp) {
      store.set(url, resp);
    }
  };
}

/* Mock upstream fetch: počítá volání a vrací připravenou odpověď. */
function mockFetch(responseFactory) {
  const state = { urls: [], calls: 0 };
  const impl = async (url) => {
    state.calls++;
    state.urls.push(url);
    return responseFactory(url, state.calls);
  };
  return { impl, state };
}

function okJson(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
}

const QS = "latitude=49.195&longitude=16.607&hourly=precipitation,snowfall&models=icon_seamless&forecast_hours=25&timeformat=unixtime&timezone=auto";

async function workerWith(deps) {
  const { createWorker } = await import("../worker/worker.mjs");
  return createWorker(deps);
}

test("healthz vrací ok a seznam endpointů", async () => {
  const w = await workerWith({ fetchImpl: async () => { throw new Error("nesmi se volat"); } });
  const r = await w.fetch(new Request("https://w.example/healthz"));
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.ok(j.ok);
  assert.ok(Array.isArray(j.endpoints));
  assert.ok(j.endpoints.includes("/om/v1/forecast"));
});

test("forecast: passthrough na api.open-meteo se stejnými parametry, MISS + CORS", async () => {
  const up = mockFetch(() => okJson({ dummy: 1 }));
  const w = await workerWith({ fetchImpl: up.impl });
  const r = await w.fetch(new Request("https://w.example/om/v1/forecast?" + QS));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get("x-bp-cache"), "MISS");
  assert.strictEqual(r.headers.get("access-control-allow-origin"), "*");
  const j = await r.json();
  assert.strictEqual(j.dummy, 1);
  /* upstream dostane přesnou kopii povolených parametrů */
  assert.strictEqual(up.state.calls, 1);
  const u = new URL(up.state.urls[0]);
  assert.strictEqual(u.host, "api.open-meteo.com");
  assert.strictEqual(u.pathname, "/v1/forecast");
  assert.strictEqual(u.searchParams.get("models"), "icon_seamless");
  assert.strictEqual(u.searchParams.get("forecast_hours"), "25");
});

test("cache: druhý totožný dotaz trefí cache — upstream se nevolá, hlavička HIT", async () => {
  const up = mockFetch(() => okJson({ n: Math.random() }));
  const cache = mockCache();
  const w = await workerWith({ fetchImpl: up.impl, cache });
  const r1 = await w.fetch(new Request("https://w.example/om/v1/forecast?" + QS));
  const r2 = await w.fetch(new Request("https://w.example/om/v1/forecast?" + QS));
  assert.strictEqual(up.state.calls, 1);
  assert.strictEqual(r1.headers.get("x-bp-cache"), "MISS");
  assert.strictEqual(r2.headers.get("x-bp-cache"), "HIT");
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.headers.get("access-control-allow-origin"), "*");
  const b1 = await r1.json();
  const b2 = await r2.json();
  assert.deepStrictEqual(b1, b2);
});

test("ensemble: passthrough na ensemble-api.open-meteo s více body", async () => {
  const up = mockFetch(() => okJson({ ens: true }));
  const w = await workerWith({ fetchImpl: up.impl });
  const qs = "latitude=49.1,49.2&longitude=16.6,16.7&hourly=precipitation&models=icon_seamless&forecast_hours=13&timezone=auto";
  const r = await w.fetch(new Request("https://w.example/om/v1/ensemble?" + qs));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(new URL(up.state.urls[0]).host, "ensemble-api.open-meteo.com");
  assert.strictEqual(new URL(up.state.urls[0]).searchParams.get("latitude"), "49.1,49.2");
});

test("whitelista: nepovolený parametr se zahodí, povolené se zachovají", async () => {
  const up = mockFetch(() => okJson({}));
  const w = await workerWith({ fetchImpl: up.impl });
  const r = await w.fetch(new Request("https://w.example/om/v1/forecast?" + QS + "&evil=injection&apikey=x"));
  assert.strictEqual(r.status, 200);
  const u = new URL(up.state.urls[0]);
  assert.strictEqual(u.searchParams.get("evil"), null);
  assert.strictEqual(u.searchParams.get("apikey"), null);
  assert.strictEqual(u.searchParams.get("models"), "icon_seamless");
});

test("validace: latitude mimo rozsah → 400, upstream se nevolá", async () => {
  const up = mockFetch(() => okJson({}));
  const w = await workerWith({ fetchImpl: up.impl });
  const r = await w.fetch(new Request("https://w.example/om/v1/forecast?latitude=999&longitude=16&hourly=precipitation&forecast_hours=5&timezone=auto"));
  assert.strictEqual(r.status, 400);
  assert.strictEqual(up.state.calls, 0);
  const j = await r.json();
  assert.ok(j.error);
});

test("validace: neznámá hourly položka → 400", async () => {
  const w = await workerWith({ fetchImpl: async () => okJson({}) });
  const r = await w.fetch(new Request("https://w.example/om/v1/forecast?latitude=49&longitude=16&hourly=precipitation,evil_field&forecast_hours=5&timezone=auto"));
  assert.strictEqual(r.status, 400);
});

test("validace: forecast_hours nad 64 → 400", async () => {
  const w = await workerWith({ fetchImpl: async () => okJson({}) });
  const r = await w.fetch(new Request("https://w.example/om/v1/forecast?latitude=49&longitude=16&hourly=precipitation&forecast_hours=500&timezone=auto"));
  assert.strictEqual(r.status, 400);
});

test("chybějící latitude/longitude → 400", async () => {
  const w = await workerWith({ fetchImpl: async () => okJson({}) });
  const r = await w.fetch(new Request("https://w.example/om/v1/forecast?hourly=precipitation&forecast_hours=5"));
  assert.strictEqual(r.status, 400);
});

test("upstream 500 → 502 s JSON chybou", async () => {
  const up = mockFetch(() => new Response("boom", { status: 500 }));
  const w = await workerWith({ fetchImpl: up.impl });
  const r = await w.fetch(new Request("https://w.example/om/v1/forecast?" + QS));
  assert.strictEqual(r.status, 502);
  const j = await r.json();
  assert.ok(String(j.error).indexOf("500") >= 0);
});

test("síťová chyba upstreamu → 502, ne výjimka", async () => {
  const w = await workerWith({ fetchImpl: async () => { throw new Error("dns fail"); } });
  const r = await w.fetch(new Request("https://w.example/om/v1/forecast?" + QS));
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.headers.get("access-control-allow-origin"), "*");
});

test("neznámý endpoint → 404, POST → 405, OPTIONS → 204 s CORS", async () => {
  const w = await workerWith({ fetchImpl: async () => okJson({}) });
  assert.strictEqual((await w.fetch(new Request("https://w.example/om/v1/nonsense?" + QS))).status, 404);
  assert.strictEqual((await w.fetch(new Request("https://w.example/om/v1/forecast?" + QS, { method: "POST" }))).status, 405);
  const o = await w.fetch(new Request("https://w.example/om/v1/forecast", { method: "OPTIONS" }));
  assert.strictEqual(o.status, 204);
  assert.strictEqual(o.headers.get("access-control-allow-origin"), "*");
});

test("rozepsaný dotaz (jiné models) nemine cache prvního → 2 upstream volání", async () => {
  const up = mockFetch(() => okJson({}));
  const cache = mockCache();
  const w = await workerWith({ fetchImpl: up.impl, cache });
  await w.fetch(new Request("https://w.example/om/v1/forecast?" + QS));
  await w.fetch(new Request("https://w.example/om/v1/forecast?" + QS.replace("icon_seamless", "gfs_seamless")));
  assert.strictEqual(up.state.calls, 2);
});

/* ================= SBĚRAČ HISTORIE (kolo 8af) ================= */

async function collector() {
  return await import("../worker/worker.mjs");
}

/* Mock KV se stejným kontraktem jako CF KV namespace. */
function mockKv() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k).v : null; },
    async put(k, v, opts) { store.set(k, { v, opts }); }
  };
}

/* Fixture odpovědí: forecast / ensemble / METAR podle URL. */
function fcFixture() {
  return {
    current: { time: 1794000000, interval: 900, precipitation: 0.25, rain: 0.25, showers: 0, snowfall: 0, weather_code: 51 },
    minutely_15: {
      time: [1794000000, 1794000900, 1794001800, 1794002700, 1794003600, 1794004500, 1794005400, 1794006300],
      precipitation: [0.1, 0.2, 0.5, 0.4, 0.1, 0, 0, 0],
      rain: [0.1, 0.2, 0.5, 0.4, 0.1, 0, 0, 0],
      showers: [0, 0, 0, 0, 0, 0, 0, 0],
      snowfall: [0, 0, 0, 0, 0, 0, 0, 0]
    },
    hourly: {
      time: [1794000000, 1794003600, 1794007200],
      precipitation_probability: [85, 60, 30]
    }
  };
}

function ensFixture() {
  const pts = [];
  for (let i = 0; i < 9; i++) {
    const h = { time: [1794000000, 1794003600, 1794007200] };
    for (let m = 1; m <= 6; m++) {
      h["precipitation_member" + m] = [0, 0.2 * m / 10, 0, 0, 0, 0, 0, 0, 0];
    }
    pts.push({ hourly: h });
  }
  return pts;
}

function collectorFetch(opts) {
  opts = opts || {};
  const state = { urls: [], calls: 0 };
  const impl = async (url) => {
    state.calls++;
    state.urls.push(url);
    if (opts.failIf && opts.failIf(url)) {
      return new Response("upstream error", { status: 500 });
    }
    if (url.indexOf("ensemble-api.open-meteo.com") >= 0) return okJson(ensFixture());
    if (url.indexOf("api.open-meteo.com") >= 0) return okJson(fcFixture());
    if (url.indexOf("aviationweather.gov") >= 0) {
      return okJson([{ icaoId: "LKPR", obsTime: 1794000300, temp: 2, rawOb: "METAR LKPR 061930Z 07006KT 8000 -RA NSC 01/M00 Q1025 NOSIG" }]);
    }
    return new Response("{}", { status: 404 });
  };
  return { impl, state };
}

test("sběrač: 100 obcí s unikátními názvy, stanicemi a platnými souřadnicemi", async () => {
  const m = await collector();
  assert.strictEqual(m.MUNICIPALITIES.length, 100);
  const names = new Set(), icaos = new Set();
  m.MUNICIPALITIES.forEach((p) => {
    assert.ok(p.n && p.cc && p.icao, "všechny položky vyplněny: " + JSON.stringify(p));
    assert.ok(!names.has(p.n), "duplicitní název: " + p.n);
    assert.ok(!icaos.has(p.icao), "duplicitní stanice: " + p.icao);
    names.add(p.n); icaos.add(p.icao);
    assert.ok(p.lat >= 41 && p.lat <= 61 && p.lon >= -7 && p.lon <= 27, "souřadnice v Evropě: " + p.n);
    assert.match(p.icao, /^[A-Z]{4}$/);
  });
});

test("sběrač: 12 dílků pokryje všech 100 obcí, každá právě jednou", async () => {
  const m = await collector();
  const seen = [];
  for (let s = 0; s < m.SLICE_COUNT; s++) {
    m.placesForSlice(s).forEach((p) => seen.push(p.n));
  }
  assert.strictEqual(seen.length, 100);
  assert.strictEqual(new Set(seen).size, 100);
  /* dílek ~8–9 obcí → rozumné rozdělení pro limit 50 subrequestů */
  for (let s = 0; s < m.SLICE_COUNT; s++) {
    const n = m.placesForSlice(s).length;
    assert.ok(n >= 8 && n <= 9, "dílek " + s + " má " + n + " obcí");
  }
});

test("sběrač: výběr ensemble modelu zrcadlí appku (icon_d2 box vs icon_eu)", async () => {
  const m = await collector();
  assert.strictEqual(m.ensModelFor(50.10, 14.26), "icon_d2");   /* Praha */
  assert.strictEqual(m.ensModelFor(49.15, 16.69), "icon_d2");   /* Brno */
  assert.strictEqual(m.ensModelFor(41.80, 12.25), "icon_eu");   /* Řím (jih) */
  assert.strictEqual(m.ensModelFor(42.70, 23.32), "icon_eu");   /* Sofie (jih) */
  assert.strictEqual(m.ensModelFor(44.82, 20.29), "icon_d2");   /* Bělehrad (u kraje boxu) */
  assert.strictEqual(m.ensModelFor(49.81, 23.96), "icon_eu");   /* Lvov (východ) */
  assert.strictEqual(m.ensModelFor(60.32, 24.96), "icon_eu");   /* Helsinky (sever) */
});

test("sběrač: URL zrcadlí vstupy aplikace (minutely_15, 3×3 mřížka, 9 hodin)", async () => {
  const m = await collector();
  const p = m.MUNICIPALITIES[0]; /* Praha */
  const fc = new URL(m.buildFcUrl(p));
  assert.strictEqual(fc.host, "api.open-meteo.com");
  assert.strictEqual(fc.pathname, "/v1/forecast");
  assert.strictEqual(fc.searchParams.get("current"), "precipitation,rain,showers,snowfall,weather_code");
  assert.strictEqual(fc.searchParams.get("minutely_15"), "precipitation,rain,showers,snowfall");
  assert.strictEqual(fc.searchParams.get("forecast_minutely_15"), "8");
  assert.strictEqual(fc.searchParams.get("forecast_hours"), "13");
  const ens = new URL(m.buildEnsUrl(p));
  assert.strictEqual(ens.host, "ensemble-api.open-meteo.com");
  assert.strictEqual(ens.pathname, "/v1/ensemble");
  const lats = ens.searchParams.get("latitude").split(",").map(Number);
  const lons = ens.searchParams.get("longitude").split(",").map(Number);
  assert.strictEqual(lats.length, 9);
  assert.strictEqual(lons.length, 9);
  /* střed první, okolí ±0.1 lat / ±0.15 lon — jako ensembleGrid aplikace */
  assert.strictEqual(lats[0], p.lat);
  assert.strictEqual(lons[0], p.lon);
  assert.strictEqual(lats[1], +(p.lat - 0.1).toFixed(4));
  assert.strictEqual(lons[1], +(p.lon - 0.15).toFixed(4));
  assert.strictEqual(ens.searchParams.get("models"), "icon_d2");
  assert.strictEqual(ens.searchParams.get("forecast_hours"), "9");
  /* mřížka souhlasí s aplikovanou funkcí ensGrid */
  const g = m.ensGrid(p.lat, p.lon);
  g.forEach((q, i) => {
    assert.strictEqual(lats[i], q[0]);
    assert.strictEqual(lons[i], q[1]);
  });
});

test("METAR parser: intenzita, déšť, sníh, bouřka, přeháňka, recent, vicinity", async () => {
  const m = await collector();
  let p = m.parseMetar("METAR LKPR 061930Z 07006KT 8000 -RA NSC 01/M00 Q1025 NOSIG");
  assert.strictEqual(p.r, 1); assert.strictEqual(p.i, 1); assert.strictEqual(p.s, 0);
  p = m.parseMetar("METAR LKPR 061930Z 07006KT 8000 SHRA SCT020 01/M00 Q1025");
  assert.strictEqual(p.r, 1); assert.strictEqual(p.i, 2); assert.strictEqual(p.sh, 1);
  p = m.parseMetar("SPECI LKPR 061945Z 07006KT 4000 +TSRA BKN020CB 01/M00 Q1023");
  assert.strictEqual(p.r, 1); assert.strictEqual(p.i, 3); assert.strictEqual(p.th, 1);
  p = m.parseMetar("METAR LKPR 061930Z 07006KT 8000 RASN NSC 01/M00 Q1025");
  assert.strictEqual(p.r, 1); assert.strictEqual(p.s, 1);
  p = m.parseMetar("METAR LKPR 061930Z 07006KT CAVOK 01/M00 Q1025 NOSIG");
  assert.strictEqual(p.r, 0); assert.strictEqual(p.s, 0); assert.strictEqual(p.i, 0);
  p = m.parseMetar("METAR LKPR 061930Z 07006KT 8000 RERA NSC 01/M00 Q1025");
  assert.strictEqual(p.r, 0); assert.strictEqual(p.re, 1);
  p = m.parseMetar("METAR LKPR 061930Z 07006KT 9999 VCSH NSC 01/M00 Q1025");
  assert.strictEqual(p.r, 0); assert.strictEqual(p.vc, 1);
  p = m.parseMetar("METAR LKPR 061930Z 07006KT 8000 -SN NSC M02/M03 Q1025");
  assert.strictEqual(p.r, 0); assert.strictEqual(p.s, 1);
  /* klíčová slova METARu se nesmí splést s jevy */
  p = m.parseMetar("METAR LKPR 061930Z 07006KT 8000 NSC 01/M00 Q1025 NOSIG AUTO");
  assert.strictEqual(p.r, 0); assert.strictEqual(p.s, 0); assert.strictEqual(p.th, 0);
});

test("parsování forecast odpovědi: mm/h z current, 15min kroky, probability", async () => {
  const m = await collector();
  const f = m.parseFc(fcFixture());
  /* 0.25 mm za 900 s = 1 mm/h */
  assert.strictEqual(f.c.mh, 1);
  assert.strictEqual(f.c.p, 0.25);
  assert.strictEqual(f.c.cd, 51);
  assert.strictEqual(f.m.length, 8);
  assert.strictEqual(f.m[0][0], 1794000000);
  assert.strictEqual(f.m[2][1], 0.5);
  assert.deepStrictEqual(f.pp, [85, 60, 30]);
  assert.strictEqual(f.h0, 1794000000);
});

test("parsování ensemble odpovědi: 9 bodů × členové jako v appce", async () => {
  const m = await collector();
  const pts = m.parseEns(ensFixture());
  assert.strictEqual(pts.length, 9);
  assert.strictEqual(pts[0].v.length, 6);      /* member1–member6 */
  assert.strictEqual(pts[0].v[0].length, 9);   /* 9 hodin */
  assert.strictEqual(pts[0].v[5][1], 0.1);     /* 0.2*5/10 zaokrouhleno na 0.1 */
  /* deterministický běh se NEvezme (v appce až po klíčích _memberN) */
  const withDet = [{ hourly: Object.assign({ precipitation: [9, 9, 9, 9, 9, 9, 9, 9, 9] }, ensFixture()[0].hourly) }];
  const p2 = m.parseEns(withDet);
  assert.strictEqual(p2[0].v.length, 7);
  assert.strictEqual(p2[0].v[0][0], 9);
});

test("cron: jedno probuzení sebere svůj dílek a zapíše JEDEN klíč s TTL 14 dní", async () => {
  const m = await collector();
  const up = collectorFetch();
  const kv = mockKv();
  /* 14:00 UTC → dílek 0 → obsahuje Prahu (index 0) */
  const w = m.createWorker({ fetchImpl: up.impl, kv, now: () => new Date(Date.UTC(2026, 10, 6, 14, 0)) });
  const res = await w.scheduled({ scheduledTime: Date.UTC(2026, 10, 6, 14, 0) });
  assert.ok(res.ok, JSON.stringify(res));
  assert.strictEqual(res.key, "raw/2026110614:00");
  assert.strictEqual(kv.store.size, 1);
  const stored = kv.store.get("raw/2026110614:00");
  assert.strictEqual(stored.opts.expirationTtl, 1209600);
  const rec = JSON.parse(stored.v);
  assert.strictEqual(rec.slice, 0);
  assert.strictEqual(Object.keys(rec.p).length, m.placesForSlice(0).length);
  /* METAR šel v jednom hromadném dotazu pro celý dílek */
  assert.strictEqual(up.state.urls.filter((u) => u.indexOf("aviationweather.gov") >= 0).length, 1);
  /* každá obec má forecast i ensemble; METAR vrátila fixture jen LKPR */
  Object.keys(rec.p).forEach((n) => {
    assert.ok(rec.p[n].fc, "fc u " + n);
    assert.ok(rec.p[n].ens, "ens u " + n);
  });
  /* Praha (LKPR) má ground truth z fixture: -RA → déšť, slabý */
  const pra = rec.p["Praha"];
  assert.ok(pra, "dílek 0 obsahuje Prahu");
  assert.ok(!pra.err, "Praha bez chyb: " + JSON.stringify(pra.err));
  assert.strictEqual(pra.met.r, 1);
  assert.strictEqual(pra.met.i, 1);
  assert.ok(rec.p[m.placesForSlice(0)[1].n].err.indexOf("met") >= 0, "ostatní obce hlásí chybějící METAR");
});

test("cron: výpadek jednoho upstreamu shodí jen dotčené obce, kolo proběhne", async () => {
  const m = await collector();
  const up = collectorFetch({ failIf: (u) => u.indexOf("ensemble-api") >= 0 });
  const kv = mockKv();
  const w = m.createWorker({ fetchImpl: up.impl, kv });
  const res = await w.scheduled({ scheduledTime: Date.UTC(2026, 10, 6, 14, 30) });
  assert.ok(res.ok);
  const rec = JSON.parse(kv.store.get("raw/2026110614:30").v);
  Object.keys(rec.p).forEach((n) => {
    assert.ok(rec.p[n].fc, "fc přežilo u " + n);
    assert.ok(rec.p[n].err && rec.p[n].err.indexOf("ens") >= 0, "ens označeno jako chyba u " + n);
  });
});

test("cron: bez KV bindingu sběrač graciozně stojí, proxy žije dál", async () => {
  const m = await collector();
  const w = m.createWorker({ fetchImpl: async () => { throw new Error("fetch se nesmi volat"); }, kv: null });
  const res = await w.scheduled({ scheduledTime: Date.UTC(2026, 10, 6, 14, 25) });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /HISTORY/);
});

test("analysis/status: hlásí kv, počet obcí a poslední zápisy", async () => {
  const m = await collector();
  const w1 = m.createWorker({ fetchImpl: async () => { throw new Error("nesmi"); }, now: () => new Date(Date.UTC(2026, 10, 6, 14, 25)) });
  const r1 = await w1.fetch(new Request("https://w.example/analysis/status"));
  const j1 = await r1.json();
  assert.strictEqual(j1.ok, true);
  assert.strictEqual(j1.kv, false);
  assert.strictEqual(j1.places, 100);
  const kv = mockKv();
  const rec = { t: 1, slice: 5, p: { "Praha": { n: "Praha" }, "Brno": { n: "Brno" } } };
  await kv.put("raw/2026110614:20", JSON.stringify(rec));
  const w2 = m.createWorker({ fetchImpl: async () => { throw new Error("nesmi"); }, kv, now: () => new Date(Date.UTC(2026, 10, 6, 14, 26)) });
  const r2 = await w2.fetch(new Request("https://w.example/analysis/status"));
  const j2 = await r2.json();
  assert.strictEqual(j2.kv, true);
  assert.strictEqual(j2.last.key, "raw/2026110614:20");
  assert.strictEqual(j2.last.n, 2);
});

test("analysis/page: slučuje 12 dílků hodiny a vrací meta obcí; špatný h → 400", async () => {
  const m = await collector();
  const kv = mockKv();
  for (let s = 0; s < 12; s++) {
    const rec = { t: 1794000000 + s * 300, slice: s, p: { ["Obec" + s]: { n: "Obec" + s, met: { r: 1 } } } };
    await kv.put("raw/2026110614:" + (s < 2 ? "0" + s * 5 : "" + s * 5), JSON.stringify(rec));
  }
  const w = m.createWorker({ fetchImpl: async () => { throw new Error("nesmi"); }, kv });
  const r = await w.fetch(new Request("https://w.example/analysis/page?h=2026110614"));
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.h, "2026110614");
  assert.strictEqual(j.found.length, 12);
  assert.strictEqual(j.meta.length, 100);
  assert.strictEqual(j.slices.length, 12);
  const bad = await w.fetch(new Request("https://w.example/analysis/page?h=abc"));
  assert.strictEqual(bad.status, 400);
  const noKv = await m.createWorker({ fetchImpl: async () => { throw new Error("nesmi"); }, kv: null })
    .fetch(new Request("https://w.example/analysis/page?h=2026110614"));
  assert.strictEqual(noKv.status, 503);
});

test("analysis dashboard: HTML s ovládacími prvky, healthz hlásí kolektor", async () => {
  const m = await collector();
  const w = m.createWorker({ fetchImpl: async () => { throw new Error("nesmi"); } });
  const r = await w.fetch(new Request("https://w.example/analysis"));
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  const html = await r.text();
  assert.match(html, /Stáhnout JSON/);
  assert.match(html, /analysis\/status/);
  const h = await w.fetch(new Request("https://w.example/healthz"));
  const hj = await h.json();
  assert.strictEqual(hj.collector.places, 100);
  assert.strictEqual(hj.collector.slices, 12);
  assert.ok(hj.analysis.indexOf("/analysis/status") >= 0);
});

test("sběrač: ensemble fallback — po výpadku icon_d2 sebere icon_eu (tryNext jako v appce)", async () => {
  const m = await collector();
  /* dílek 0 obsahuje Prahu; icon_d2 vrátí 400 (mimo doménu), sběrač musí spadnout na icon_eu */
  const impl = async (url) => {
    if (url.indexOf("models=icon_d2") >= 0) return new Response("no data", { status: 400 });
    if (url.indexOf("models=icon_eu") >= 0) return okJson(ensFixture());
    if (url.indexOf("ensemble-api") >= 0) return new Response("no data", { status: 400 });
    if (url.indexOf("api.open-meteo.com") >= 0) return okJson(fcFixture());
    if (url.indexOf("aviationweather.gov") >= 0) {
      return okJson([{ icaoId: "LKPR", obsTime: 1794000300, temp: 2, rawOb: "METAR LKPR 061930Z 07006KT 8000 -RA NSC 01/M00 Q1025 NOSIG" }]);
    }
    return okJson([]);
  };
  const kv = mockKv();
  const w = m.createWorker({ fetchImpl: impl, kv });
  const res = await w.scheduled({ scheduledTime: Date.UTC(2026, 10, 6, 14, 0) });
  assert.ok(res.ok);
  const rec = JSON.parse(kv.store.get(res.key).v);
  const pra = rec.p["Praha"];
  assert.ok(pra.ens, "ensemble musí dojít přes fallback");
  assert.strictEqual(pra.ens.m, "icon_eu");
  assert.ok(!pra.err, "bez chyby: " + JSON.stringify(pra.err));
});
