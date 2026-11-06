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
