/* Kolo 8ab: index.html se GENERUJE z index.template.html + src/main.js.
   Zdroj pravdy je src/main.js — index.html v repo je build artifact
   (Pages ho servíruje přímo, proto se commituje; CI hlídá, že nezevstal).
   Záměrně žádné závislosti: čtení + substituce, výsledek je pro stejný
   vstup deterministický a byte-identický. Esbuild/print pipeline přijde
   v dalším kole, až CI převezme tisk bundlu; tady je to neprodyšné
   pojistné pásmo — build nesmí změnit ani jeden bajt nasazené appky. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const tplPath = path.join(root, 'index.template.html');
const jsPath = path.join(root, 'src', 'main.js');
const outPath = path.join(root, 'index.html');
const MARKER = '/*__BP_MAIN__*/';

const tpl = fs.readFileSync(tplPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');

if (tpl.split(MARKER).length !== 2) {
  throw new Error('index.template.html musí obsahovat právě jeden marker ' + MARKER);
}
if (js.includes('</script')) {
  throw new Error('src/main.js obsahuje "</script" —.injectně by rozbil HTML');
}
const before = tpl.slice(0, tpl.indexOf(MARKER));
const after = tpl.slice(tpl.indexOf(MARKER) + MARKER.length);
if (after.startsWith('>')) {
  throw new Error('marker nesmí být uvnitř <script> tagu — má nahradit obsah scriptu');
}
const out = before + js + after;

fs.writeFileSync(outPath, out);
process.stdout.write('build: index.html = template(' + tpl.length + ' B) + src/main.js(' + js.length + ' B) -> ' + out.length + ' B\n');
