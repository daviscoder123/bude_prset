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
  - **(kolo 8ba):** audit a oprava datových zdrojů — všechny závěry přeměřeny
    naživo (žádost vznikla z recenze, která však mířila vedle: REST
    `api.blitzortung.org` ani LIDAR ČHMÚ se v kódu nikdy nepoužívaly).
    - **Blitzortung (blesky):** spojení jede přes WebSocket zrcadla; ws7
      neodpovídá → hosté ws1/ws2/ws8 (3 údery za 20 s ověřeny živě).
    - **ČHMÚ radar:** přímé čtení z prohlížeče blokuje chybějící CORS →
      kompozit i legenda jdou přes edge proxy (`/chmi/img`, whitelist
      `/meteorology/weather/radar/*.png`, CORS `*`, cache 120 s);
      legenda přejmenována `scl-dbzmmh` → `scl-dbz-mmh` (nový extraktor
      škály z paletového PNG, slabé→silné); předpověď +10…+60 min už
      není PNG, ale TAR archiv — Worker ho stáhne a vybalí člena
      (`/chmi/fct`, `tarFindMember`, cache 240 s).
    - **EUMETSAT (IR):** staré vrstvy `meteosat:msg_rss_*` mrtvé →
      `msg_fes:ir108` / `msg_iodc:ir108` (šedotón ověřen na 40 000
      pixelech); `GetLegendGraphic` dnes vrací jen ikonu 20×20 →
      syntetická 16stupňová šedá škála. Živý test 4 snímků: ordinály
      0,40–0,67 nad Alpami, trend spočítán správně.
    - **NASA GIBS (satelitní rgb/kelvinové vrstvy):** GIBS zrušil
      colormap XML → kelvinové dekódování nelze poctivě provést, modul
      vypnut se sériovým vysvětlením (`satState = "off"`).
    - **GPM IMERG:** vrstva přejmenována na `IMERG_Precipitation_Rate_30min`
      (+ hodinová), datová paleta na `GPM_Precipitation_Rate` — mm/h,
      220 platných položek, rozsah 0,1–53,1; dekód živě ověřen 1:1 s
      barvami skutečných dlaždic (ITCZ Pacifik: max 15,4 mm/h →
      pseudodBZ 42; Evropa: suchá).
  - **(kolo 8bb):** sníh jako občan první třídy. Detekce sněhu existovala
    dříve (radarový bit &128, METAR SN/SG/PL/IC, snowfall modelů,
    ensemble), ale UX mluvilo o „dešti“ i tam, kde appka slibovala sníh.
    Verdikt, lišta i výklad nyní mluví sněhem („Sněžení do / Sníh od“),
    intenzita se ukazuje v cm/h a úhrn „napadne ~X cm“ (1 cm ≈ 0,7 mm
    vodního ekvivalentu), sněhová čára z `freezing_level_height`
    (pod 1000 m po 50 m, nad ní po 100 m), pill „sníh se blíží“,
    suchý stav ví o „pravděpodobnosti sněžení“, pokud modely hlásí sníh;
    pozadí padají řídké tlumené vločky (`soonSnow`), na mobilu jich je
    méně. Testů 78/78 zelených.
  - **(kolo 9):** pravidelná analýza přesnosti na 8,5 dne sběru (205 hodin,
    20 189 záznamů, 100 obcí; sběr běží od 6. 11.) a její závěry nasazené
    ve sběrači — viz `docs/analyza-presnosti-2026-11.md` pro měřená čísla.
    - **Rotace ensemble (největší přínos):** sběrač páral celou denní
      kvótu Open-Meteo (9 bodů mřížky × 100 obcí × 24 h = 21 600 volání/den
      nad limit 10 000 → 100 % ens429), a hladověl tak i appku: ta bere
      ensemble přes proxy `/om/v1/ensemble`, tudíž uživatelé místo
      „Pravděpodobnosti deště" trvale viděli „Shodu modelů" a autokalibrace
      ens/mix neměla jediný vzorek. Ensemble se odteď sbírá jen v rotacních
      hodinách `ENS_ROT_HOURS` = 2, 5, 8, 11, 14, 17, 20, 23 UTC (7 200
      volání/den, ~2 800 zůstává appce; horizont ens 9 h, rotace po 3 h
      pokrytí neprotrhne). Mimo rotaci `cd="ensrot"`, err „ens" se
      nehlásí; `/analysis/status` počítá chyby ens jen přes rotací dílky
      (`counts.rot`, `counts.rotPlaces`), takže degraded alerting
      nevyhlásí kvótní selhání tam, kde sběr záměrně neprobíhá.
    - **Surové pixely radaru (`rv.px`):** 9 surových dBZ hodnot 3×3 výřezu
      (row-major, null = pixel bez odrazu). Medián a práh 10 dBZ v
      dbzToMm jinak zamaskují slabá echo — radar v datech nedetekoval
      82,6 % metarových dešťů (2 306 z 2 793); px umožní příštím kolům
      rozlišit „radar opravdu nic" od „mrholení/virga pod prahem".
    - **Příznak mrholení (`met.dz`):** METAR DZ se ukládá zvlášť.
      Minutecast mrholení neměří (jeho kvantizace jde 0 → 0,1 mm/h) a
      právě −DZ je častý případ „mokro u stanice, sucho na radaru".
    - **Proč se verdikt appky slepě nezasahoval:** měřená kalibrace
      Open-Meteo se zásadně liší podle sémantiky otázky (bodová per
      hodina ±35 min: 90–100 % → reálně ~83 %, 0–10 % → ~3,5 %; oknová
      „déšť do 8 h" s jednotnou truth: naopak podceněná uprostřed,
      30–40 % → ~58 % skutečně). Appka má vlastní autokalibraci
      (brierCalib per zdroj, učí se z reálných verdiktů) a blend kola
      8z3; natvrdo zasazená tabulka by obě sémantiky spletla a mohla
      rozvázat vyladěný blend. Naměřená čísla (včetně OR pravidla
      pp ≥ 50 % ∨ mc ≥ 0,1 mm/h: POD 0,71, FAR 0,22, CSI 0,59 v okně
      120 min, n = 20 189) dokumentuje analytický doc pro příští kola,
      až budou k dispozici vlastní vzorky appky.
    - Doporučení z analýzy, která už v appce jsou: mrholení v UX
      („Mrholení nad obcí ≥ 0,1 mm/h má přednost") a „METAR hlásí déšť →
      radarové jasno se přepíše" (kolo 8v, stanice ≤ 25 km, beamNote).
      Snížení prahu minutecastu na 0,05 mm/h nemá oporu v datech —
      mezi 0 a 0,1 žádné hodnoty nejsou (kvantizace zdroje).
    - Schéma záznamů zůstává zpětně kompatibilní (px a dz jsou aditivní
      pole). Testů 88/88 zelených (6 nových: rotace hodin, ens mimo
      rotaci, px, dz, status rot/degraded, 429 v rotaci).
  - **(kolo 9b):** tři závěry analýzy přesnosti aplikované na appku.
    - **Oprava řádku „Shoda modelů“:** buňky tabulky ukazují SUROVÉ
      hodnoty modelů, ale řádek Shoda počítal korigované (bias ÷1,3,
      orografie) — hodnota přesně na prahu 0,2 mm/h (nejčastější kvant
      Open-Meteo „slabý déšť“) tak po korekci spadla pod práh a tabulka
      ukazovala dva mokré modely, zatímco Shoda hlásila 0/N. Shoda teď
      počítá surové `vals`, aby seděla na to, co uživatel vidí; korekce
      zůstávají v `peakConsensus` a verdiktu, kde jsou záměrem.
    - **Studený start kalibrace Open-Meteo (zdroj „om“):** zobrazené
      procento řádku ensemblu jde přes `brierCalib(…, "om")` — buď vlastní
      naučenou křivku, nebo (dokud vzorků om není) statickou fallback
      křivku přeměřenou na přesně této sémantice (max pp přes okno 8 h
      proti dešti kdykoli v okně, n = 20 189): hlášené 10–20 % →
      reálně 39,4 %, 30–40 % → 59,8 %, 50–60 % → 72,4 %. Po opravě kvóty
      (kolo 9) ensemble zřídka selhává, takže vzorky om by kalibraci
      jinak napořád nenaplnily; vlastní učení má vždy přednost a jiné
      zdroje (ens/mix/agree) fallback nedostávají.
    - **beamNote rozlišuje mrholení:** když stanice hlásí −DZ a radar
      sucho, poznámka řekne konkrétní příčinu („stanice hlásí právě
      mrholení, které paprsek nad ní…“) místo obecného principu.
      Testů 92/92 zelených (4 nové: fallback křivka om a přednost
      učení, Shoda surové vals, OM zobrazení přes kalibraci, beamNote DZ);
      aktualizován 1 stávající test (om už není identita bez dat).
  - **(kolo 9c):** UX náprava ze screenshotu Josefov (Praha), kde tři
    panely vpravo vyprávěly tři různé předpovědi.
    - **Panel „Kdy začne pršet“ je zase minutacast:** modelová větev
      stačila k afirmativnímu „do hodiny“ jednomu osamocenému modelu
      z osmi (IFS 0,2 mm/h), ačkoliv verdiktem hlásil „12 %, Déšť
      čeká menšina“ a radar „Tě mine“. Když teď 60minutové zdroje
      (radar, minutecast) mlčí, panel řekne právě to — „Nic do
      hodiny“ — a modelová procenta nechá verdiktu (na mobilu oba
      příběhy spojuje solo panel). Vzorek do Brierovy kalibrace
      (zdroj agree) se ukládá dál; výjimečný pád bez radaru i
      minutecastu zůstává s vyznačeným „radar nedostupný · jen
      modely“.
    - **„Zítra 12:59“ je pryč:** větu „Konec zatím není v dohledu —
      déšť má trvat i po zítra 12:59, dál appka nevidí“ nahradilo
      „Konec zatím není v dohledu — v datech až po zítra kolem
      13:00 žádná souvislá přestávka“; vzdálený okraj dat (nad 6 h)
      se novou funkcí approxClock zaokrouhluje na hodiny s „kolem“,
      takže zítřejší déšť je jen okrajová zmínka bez falešné
      minutové přesnosti.
    - **Rozchod odhadů bez ensemblu:** když se kalibrované Open-Meteo
      a shoda modelů liší o 30 % a víc (screenshot: 12 % × 49 %),
      řádek ensemblu přidá „odhady se rozcházejí — ber to jako
      nejisté“, dosud to hlídal jen stav s ensembly. Testů 96/96.
  - **(kolo 9d):** Daveova formulace konce za okrajem dat: „Konec zatím
    není v dohledu — v datech až po zítra kolem 13:00 žádná souvislá
    přestávka“ se zjednodušila na „Pršet má i zítra po 13. hodině.“ —
    prostě, po celé hodině a bez odborné zmínky o datech. Nová funkce
    rainBeyondPhrase zaokrouhlí okraj nad 6 h na celou hodinu se dnem
    („zítra po 13. hodině“, „pozítří po 9. hodině“, ráno bez nuly
    „po 8. hodině“); blízký okraj zůstává přesný po minutách.
    Nahradila approxClock z kola 9c. Testů 96/96 (náhrada 1:1,
    dvě testovací sady upraveny).
  - **(kolo 10) Rodinný hlas a pevný volební sbor agentur.** Dave k výběru
    osmi modelů: „Určitě tam musí být lokální, ale co zbytek? Jaká je
    definice verdiktu?“ Odpověď měření: dřív verdikt počítal ŘÁDKY, takže
    DWD hlasoval dvakrát (ICON-D2 + AICON) a ECMWF taky (IFS + AIFS) —
    8 hlasů, ale jen 6 nezávislých agentur. Nová pravidla:
    - **Jedna agentura, jeden hlas.** fam „AIFS“ hlasuje jako ECMWF,
      „AICON“ jako DWD (v tabulce zůstávají oddělené řádky, jen hlas
      se deduplikuje). Nová funkce agencyOf, peakConsensus dostává
      režim byAgency a vrací nAg (počet hlasujících agentur).
    - **Pevný sbor, ne osmička z obrazovky.** Hlasuje všech 9 dostupných
      agentur pro Česko (DWD, DMI, KNMI, ECMWF, MET Norway, Météo-France,
      UKMO, NOAA, ECCC) — UKMO, GFS a GEM dřív jako 9.–11. kandidáti
      hlas nikdy nedostali, i když odpovídali daty. Kdo neodpoví,
      zdrží se, nikdo se za něj nedosadí: % už neuschne kvůli 503
      jednomu modelu. Zámořské globály (JMA/KMA/CMA/BOM) nehlasují
      bez vlastního měření skillu (řidší aktualizace, hrubost nad
      Evropou by shodu ředila); NÁRODNÍ model se zakázaným id výjimkou
      NENÍ — bom_access_global je pro Austrálii národní a hlasuje.
      Tabulka zobrazuje dál osm nejbližších modelů; rozdíl se
      pojmenuje v řádku ensemblu („verdikt: N hlasujících agentur ·
      tabulka ukazuje osm nejbližších modelů“).
    - **UI mluví agenturami.** „Shoda agentur na dešti do 8 h“ (label,
      šablona, stat), expl „Srážky ≥ 0,2 mm/h kolem 14:00 hlásí 6 z 9
      agentur (67 %)“, výklad i slovní hodnocení („Agentury se
      shodují“, „Většina agentur čeká déšť“). Řádek „Shoda modelů“
      v tabulce zůstává PO MODELECH (srovává s buňkami).
    - **Brierova kalibrace (agree) učí na správném prediktoru:** vzorek
      teď říká totéž co UI — shoda agentur na špičce (ms.peak.prob
      s předstihovou váhou) a cíl hodina špičky; starý modelový podíl
      maxC/N zůstává jen pádem, když žádná agentura nepromokne.
      Staré uložené vzorky mají o něco jinou sémantiku (krátkodobé
      smíchání; naučená křivka je postupně přepíše).
    - CALIB_TABLE je identita a vypnutá, statickou kalibrací tedy
      změna nehrozí; brierCalib se učí per zařízení jako dřív.
  - **(kolo 11) Radar se nesmí ztratit beze slova.** Dave (18. 11. 16:47,
    mobil): kompas i radarová větev blendu na prvotním načtení tiše
    zmizely. Backend přitom byl zdravý (změřeno: metadata, maska pokrytí
    i dlaždice RainViewer odpovídaly HTTP 200, snímek 4 min stár).
    Dvě příčiny v kódu:
    - **Visící dlaždice bez časovače:** `<img>` na radarové PNG nemá
      vlastní timeout; jeden zaseknutý požadavek na CDN znamenal
      Promise, který nikdy neresolvoval — celý řetězec (osm snímků,
      pohyb, intenzita, kompas) se zastavil a nikdo to nevěděl.
      Nově `RV_TILE_TIMEOUT_MS` (12 s) dlaždici vzdá, počítá ji
      za chybějící a řetězec jede dál (maska pokrytí stejně).
    - **Chyba = ticho až do příštího ručního načtení:** jednorázová
      výjimka (síť, CORS, CDN edge) nastavila `radarState = "error"`
      a kompas prostě zmizel; zpráva „radar nedostupný · jen modely“
      existovala jen ve výjimečném modelovém pádu. Nově se selhání
      říká nahlas: na místě kompasu stojí „Radar se nepodařilo
      načíst. … Zkusím to znovu sám.“ a u zdrojů se objeví
      „radar nedostupný (zkusím znovu)“.
    - **Automatický dotah:** každá chybová cesta (catch, chybějící
      intenzitní dlaždice) naplánuje dotah +20 s a +60 s
      (scheduleRadarRetry, strop dvou, přerušeno při úspěchu
      nebo změně lokality). Přechodné selhání se tedy spraví
      samo do minuty, bez zásahu uživatele.
