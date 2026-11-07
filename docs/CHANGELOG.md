# CHANGELOG — historie vývoje

Rekonstruováno z git historie repozitáře. Trvalou snahou je, aby každé „kolo"
něco skutečně zlepšilo a nic nepokazilo: každá změna kódu projde jednotkovými
a prohlížečovými testy (66+ testů), build artifact se hlídá CI bránou a
přesnost se doložila zpětným testem na sběrači dat, kde to šlo.

## Červenec 2026 — počátky

- Experimentální fáze: aplikace jako jeden ručně upravovaný `index.html`
  (do repository nahrávána po částech). Bez build systému, bez testů.

## Říjen 2026 — základy

- **21. 10. (#1):** oprava časových pásem, stavu lokalit a původu modelového
  `current`; aktuální release GitHub Actions.
- **28. 10. (kola 2–3):** opravy z code review (mrtvý kód, rozptyl verdiktu,
  duplicitní predikce, SW cache, XSS); timeouty API, úklid cache, offline
  lišta; kolo 3 — trend radaru v blendu, NEP ensemble přes 3×3 body, naučené
  váhy zdrojů blendu, ECMWF AIFS v okně modelů, fázová korekce advekce.
- **29. 10.:** 18 zpřesnění z rešerše (radar × předpověď), radarový kompas s
  přesnou geometrií trajektorie (75 km), sklo redesign (průsvitné panely nad
  živým gradientem), rozšířená dokumentace + automatické screenshoty z CI,
  dlouhá série oprav mobilního layoutu (iOS autosizing, fitGuard, škála
  ukotvená k reálným displejům).
- **30.–31. 10. (kola 8j–8x):** mobilní redesign „návrh 02" (mono kapitálky,
  obří zúžený čas, legenda bunek), service worker v5/v6 s vynuceným update
  po nasazení, animované pozadí podle počasí, „Déšť od" → „Déšť do" s odhadem
  konce, stanice potvrzuje déšť sama (≤25 km), radar potvrzuje déšť sám
  (čerstvé vydatné echo nad obcí), mobilní radarový kompas vedle verdiktu.
  Kolo 8y (legenda) bylo vzápětí revertováno dle rozhodnutí autora.

## Listopad 2026 — přesnost a infrastruktura

- **1. 11. (kola 8z + 7 zlepšení):** horizont 60 min v panelu „Kdy začne
  pršet" s poctivým labelem pro odhady z pohybu pole; 7 bezplatných zlepšení
  přesnosti + Enhanced Nowcast (PR #22 uzavřen; část designu revertována,
  pravděpodobnostní pravidlo později nahrazeno kolem 8z3).
- **2. 11. (kolo 8aa):** keš radarových výřezů, offline záloha JSON, měřič
  dat; minify workflow pro nasazení na gh-pages.
- **6. 11. (kola 8ab–8ag):**
  - **8ab:** build pipeline — zdrojem pravdy `src/main.js` +
    `index.template.html`, `index.html` je generovaný artifact s CI freshness
    bránou (plus operační fixy CI: pin runneru, retry a cache Chromium).
  - **8ac/8ad:** edge proxy na Cloudflare Workers s 13 testy, aktivace
    `BP_PROXY`, fix rozbalování URL proxy v browser testech, systémový Chrome
    v CI, `.nojekyll`.
  - **8ae:** vlajky modelů jako vestavěné SVG (29 zemí) — nezávislé na fontu
    systému, nový model bez vlajky neprojde CI.
  - **8af/8ag:** sběrač historie — 100 obcí, cron každých 5 min, KV záznamy
    s TTL 14 dní, export `/analysis` + dashboard; radar RainViewer ve sběrači
    (PNG dekód ve Workeru bez canvasu, medián mm/h z 3×3 pixelů jako druhý
    svědek ground truth).
- **7. 11.:**
  - **(#23):** oprava METAR parseru — trendové skupiny TEMPO/BECMG (předpověď
    vývoje, nikoli pozorování) se nesmí počítat jako aktuální déšť. Na datech
    sběrače 6.–7. 11.: 13 falešných pozorování (Basilej 11×), po opravě
    celková úspěšnost 91,4 → 92,1 %, Brier 0,058 → 0,051. Worker nasazen,
    starší záznamy v KV se hodnotí korektně při přepočtu z raw textu.
  - **(#24, kolo 8z3):** verdikt drží ensemble — špičky Open-Meteo jen na
    polovinu cesty: `max(ens; (ens+om)/2)`. Zpětný test na 726 oknových
    párech: falešné poplachy 30 → 11, úspěšnost 91,3 → 92,6 %,
    Brier 0,0593 → 0,0579.
  - **Dokumentace v2 + grafika:** `docs/architektura.md` (výklad pipeline),
    tento CHANGELOG, `scripts/accuracy_charts.py` — živé grafy přesnosti z
    dat sběrače (SVG, bez závislostí) a denní workflow **Grafy přesnosti**
    s badge aktuální naměřené úspěšnosti v README.
