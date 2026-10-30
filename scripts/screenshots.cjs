/* Bude pršet? — generátor screenshotů pro README
   Spouští se v CI (Playwright + chromium): aplikace se načte z lokálního
   serveru, API odpovědi jsou plně řízené (deterministické scénáře "déšť"
   a "sucho") a snímky se ukládají do docs/screenshots/.
   Popis: viz README.md, sekce "Generování screenshotů". */

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots');

const places = {
  Praha: { name: 'Praha', latitude: 50.08, longitude: 14.42, country_code: 'CZ' },
};

async function runScenario(browser, base, label, wet) {
  const ctx = await browser.newContext({
    timezoneId: 'Europe/Prague',
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
    deviceScaleFactor: 2,
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));

  const epoch = Math.floor(Date.now() / 3600000) * 3600;
  const times = Array.from({ length: 25 }, (_, i) => epoch + i * 3600);
  /* profil srážek po hodinách (mm/h) — déšť dorazí hned / brzy a skončí */
  const rain = wet ? [0.8, 1.4, 0.9, 0.6, 0.2, 0, 0, 0] : Array(8).fill(0);
  const members = Array.from({ length: 9 }, (_, i) => ((rain[i] || 0) > 0 ? 1 : 0));

  await p.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.origin === base) return route.continue();
    const json = body => route.fulfill({ json: body });
    if (u.hostname === 'geocoding-api.open-meteo.com') {
      const place = places[u.searchParams.get('name')];
      return json({ results: place ? [place] : [] });
    }
    if (u.hostname === 'ensemble-api.open-meteo.com') {
      const hourly = {};
      for (let i = 0; i < 20; i++) hourly['precipitation_member' + i] = members.slice();
      return json({ hourly });
    }
    if (u.hostname === 'api.open-meteo.com' && u.searchParams.has('models')) {
      const hourly = { time: times };
      for (const model of u.searchParams.get('models').split(',')) {
        hourly['precipitation_' + model] = times.map((_, i) => (i < rain.length ? rain[i] : 0));
        hourly['snowfall_' + model] = times.map(() => 0);
      }
      return json({ timezone: 'Europe/Prague', utc_offset_seconds: 7200, hourly });
    }
    if (u.hostname === 'api.open-meteo.com' && u.searchParams.has('current')) {
      return json({
        timezone: 'Europe/Prague', utc_offset_seconds: 7200,
        current: { time: epoch, interval: 900, precipitation: wet ? 0.1 : 0, weather_code: wet ? 61 : 0, snowfall: 0 },
        current_units: { precipitation: 'mm' },
        minutely_15: {
          time: Array.from({ length: 8 }, (_, i) => epoch + i * 900),
          precipitation: Array(8).fill(wet ? 0.1 : 0),
        },
        hourly: {
          pressure_msl: Array(12).fill(1010),
          cape: Array(12).fill(0),
          wind_speed_850hPa: Array(12).fill(wet ? 4 : 2),
        },
      });
    }
    if (u.hostname === 'nominatim.openstreetmap.org' && u.pathname.includes('reverse'))
      return json({ address: { city: 'Praha', country_code: 'cz' } });
    return route.fulfill({ status: 503, json: { error: 'Unavailable in deterministic screenshot run' } });
  });

  const made = [];
  await p.goto(base, { waitUntil: 'domcontentloaded' });
  /* Geolokace je v kontextu zamítnutá: zavřít úvodní nápovědu. */
  await p.locator('#retryGeo').waitFor({ state: 'visible' });
  await p.locator('#status').click({ position: { x: 4, y: 4 } });

  await p.locator('#locInput').fill('Praha');
  await p.locator('#locBtn').click();
  await p.waitForFunction(() => window.cur?.name.startsWith('Praha') && window.lastJ && window.modelState);
  await p.locator('#body tr').first().waitFor();
  await p.waitForTimeout(1500); /* ustálení animací a doplňkových požadavků */

  /* Desktop */
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.waitForFunction(() => !NARROW.matches);
  await p.waitForTimeout(500);
  const desktop = 'desktop-' + label + '.png';
  await p.screenshot({ path: path.join(outDir, desktop), fullPage: true });
  made.push(desktop);

  /* Mobil - kolo 8l: i scenar sucho (mobilni verdikt se hodnoti v obou stavech) */
  {
    await p.setViewportSize({ width: 375, height: 812 });
    await p.waitForFunction(() => NARROW.matches);
    await p.waitForTimeout(800);
    const mobile = 'mobile-' + label + '.png';
    await p.screenshot({ path: path.join(outDir, mobile), fullPage: true });
    made.push(mobile);
  }

  if (errors.length) throw new Error(label + ': chyby stránky: ' + errors.join(' | '));
  await ctx.close();
  return made;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const server = http.createServer(async (req, res) => {
    try {
      const file = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
      if (!file.startsWith(root + path.sep)) throw Error('path');
      const data = await fs.readFile(file);
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const made = [];
    made.push(...await runScenario(browser, base, 'dest', true));
    made.push(...await runScenario(browser, base, 'sucho', false));
    console.log('SCREENSHOTS OK: ' + made.join(', '));
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
  }
}

main().catch(e => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
