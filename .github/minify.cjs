/* Kolo 8aa (P6): minifikace index.html pro produkční branch gh-pages.
   KONZERVATIVNÍ režim — jen bílá místa, komentáře a CSS/JS whitespace.
   Žádná komprese výrazů, žádné přejmenování proměnných (mangle),
   žádné slučování tagů: riziko sémantické změny musí zůstat na nule.
   Po minifikaci se celý inline <script> přeparsuje (new Function) —
   syntaktická chyba znamená zastavit deploy, nic nepublikovat. */
const fs = require('fs');
const path = require('path');
const { minify } = require('html-minifier-terser');

const root = path.join(__dirname, '..');
const file = path.join(root, 'index.html');
const src = fs.readFileSync(file, 'utf8');

(async () => {
  const out = await minify(src, {
    collapseWhitespace: true,
    removeComments: true,
    minifyCSS: true,
    minifyJS: { compress: false, mangle: false }
  });
  const m = out.match(/<script>([\s\S]*?)<\/script>/);
  if (!m || !m[1]) throw new Error('inline script not found after minify');
  new Function(m[1]);          /* syntaktická pojistka před publikací */
  fs.writeFileSync(file, out);
  const kb = n => Math.round(n / 102.4) / 10;
  console.log(`minified index.html: ${kb(src.length)} kB -> ${kb(out.length)} kB (-${Math.round(100 * (1 - out.length / src.length))}%)`);
})().catch(e => { console.error('MINIFY FAILED:', e && e.message); process.exit(1); });
