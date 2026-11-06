/**
 * „Bude pršet?" — edge proxy na Cloudflare Workers (Pilíř A, kolo 8ac).
 *
 * Transparentní cachující proxy pro Open-Meteo. Klient posílá tentýž
 * dotaz jako dříve, jen s naším hostem; Worker přepojí na upstream,
 * výsledek zcacheuje napříč všemi uživateli a vrátí identické JSON.
 *
 *   GET /om/v1/forecast?<whitelisted params>  → api.open-meteo.com/v1/forecast
 *   GET /om/v1/ensemble?<whitelisted params> → ensemble-api.open-meteo.com/v1/ensemble
 *   GET /healthz                              → {ok:true, ...}
 *
 * Zásady:
 *  - Whitelista parametrů + validace — Worker není otevřená proxy.
 *  - Cache API (caches.default), sdílená mezi uživateli: TTL 10 min pro
 *    forecast, 15 min pro ensemble (zrcadlí TTL v klientovi).
 *  - Chyba upstreamu → 502 s JSON; klient má přímý fallback na Open-Meteo.
 *  - Žádné dekódování PNG, žádná agregace nad odpověďmi — tenký passthrough,
 *    hluboko pod limity free tieru (1 subrequest, ~0 CPU).
 *
 * Testovatelnost: createWorker(deps) umožňuje vstříknout fetchImpl a cache
 * (Node testy v tests/worker.test.cjs). Default export je produkční wiring.
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

export function createWorker(deps) {
  var fetchImpl = deps.fetchImpl;
  var cache = deps.cache || null;

  async function handle(request) {
    var u = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" } });
    if (request.method !== "GET") return json(405, { error: "pouze GET" });

    if (u.pathname === "/healthz") {
      return json(200, { ok: true, service: "bude-prset-proxy", endpoints: Object.keys(UPSTREAMS) });
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

  return {
    fetch: function (request) {
      return handle(request).catch(function (e) {
        return json(500, { error: "worker selhal", detail: String(e && e.message || e) });
      });
    }
  };
}

export default createWorker({
  fetchImpl: fetch,
  cache: (typeof caches !== "undefined" && caches.default) || null
});
