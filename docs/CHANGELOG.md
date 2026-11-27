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
  - **(kolo 12) Pozemní pravda se nesmí ztratit, ani zůstat bez hlasu.**
    Dave (19. 11. 11:56, mobil): „Právě prší. Proč to radar nevidí?"
    Měřeno: METAR LKPR 191030Z hlásí -RA (slabý déšť nad Prahou),
    národní radar ČHMÚ PseudoCAPPI 2 km má nad Prahou zelené echo
    v celém výřezu (1 km na pixel, snímek 5 min starý), globální
    kompozit RainViewer nad Prahou sucho (všech 49 px výřezu bez
    echa, nejsilnější pole jinde 60–250 km) — a kompas řekl
    „Tě mine", panel Kdy hlásil „nezávislé potvrzení: 0".
    Tři příčiny, tři léky:
    - **Kompas znal jen kompozit:** verdikt „Tě mine"/„V dosahu nic"
      se odvozoval čistě z geometrie globálního kompozitu, který
      slabý déšť pod svým prahem nevidí. Nově: když kompozit nad
      obcí mlčí (miss/standing/empty, nad obcí 0) a pozemní
      pozorování hlásí srážky (stanice dle pravidel kola 8v
      ve stanicePotvrzujeSelf, nebo ČHMÚ v chmiNowWet ≤ 45 min),
      kompas říká „Právě nad tebou prší." a rozpor vyslovuje:
      „Kompozit RainViewer nad tebou nevidí nic — ... Ale stanice
      LKPR (12 km) hlásí srážky (kód -RA) a národní radar ČHMÚ
      (1 km na pixel) má nad tebou echo." Geometrie kompozitu
      zůstává jako vedlejší věta, rozpor se neumlčí.
    - **Pravidla potvrzení stanicí teď žijí jednou** (funkce
      stanicePotvrzujeSelf) — panel Kdy i kompas čtou tentýž
      kód, takže o jednom dešti nikdy neřeknou dvě různé věci.
    - **Výpadek umlčel pozemní zdroje navždy:** METAR i ČHMÚ se
      načítaly jednorázově (METAR přímo v loadRadar) a jediná
      výpadková odpověď je zhasla až do ručního obnovení — dnes
      se k tomu přidalo i „2 z 8 modelů neodpověděly", tedy
      kolísavá mobilní síť. Nově METAR běží ve vlastní
      loadMetar() s dotahem +20 s/+60 s (scheduleMetarRetry,
      strop dvou, přerušeno při úspěchu) a ČHMÚ po chybě
      dotahuje samo (scheduleChmiRetry stejným vzorem jako
      radar v kole 11).
  - **(kolo 12b) ČHMÚ modul v produkci mlčel — a nikdo to neviděl.**
    Dave (19. 11. 12:21, mobil): i po deployi kola 12 „bez změny":
    „nezávislá potvrzení: 0", žádný řádek ČHMÚ v tabulce. Měřeno
    12:22: Worker ČHMÚ proxy je zdravý, ale žádá CELU cestu
    (CHMI_PATH_RE:^/meteorology/weather/radar/…, viz worker.mjs),
    zatímco aplikace posílala „/composite/…" bez prefixu — Worker
    odpověděl 400 („cesta musí být .png pod /meteorology/weather/
    radar/") na každý snímek i legendu, loadChmi tak vždy skončila
    chmiState „error". Národní radar tedy do verdiktu, kompasu ani
    tabulky nepromluvil, právě když jej situace potřebovala (nad
    Prahou PseudoCAPPI echo zesilalo zeleně → modře u -RA).
    Léky:
    - **chmiProxyImg nese celou cestu** včetně /meteorology/weather/
      radar — ověřeno proti produkčnímu Workeru: now PNG 25 464 B,
      legenda 985 B, fct PNG 25 650 B, vše 200 s CORS.
    - **Suché/echo ověřeno na snímku 11:10 UTC**: bez echa =
      průhledné pixely (a=0), Praha modré echo (0,108,192) —
      chmiReadPatch a chmiNowWet nad tím dávají smysluplné
      „teď ECHO".
    - **Výpadek stanice i ČHMÚ se pojmenuje u zdrojů** („stanice
      nedostupná (zkusím znovu)", „český radar nedostupný
      (zkusím znovu)") — mlčící svědek už nepřipadá za „neprší".
      Kompas tím získává druhého nezávislého svědka pro verdikt
      „Právě nad tebou prší." i když METAR na mobilu nedo-jede.
  - **(kolo 12c) Výpadek kompozitu nezastaví výpověď pozorování.** Dave
    (19. 11. 12:33, mobil): „Teď ČHMÚ nejede vůbec" — Kompozit
    RainViewer na výpadkovém mobilním připojení nesedl (zdroj
    přitom změřeno 11:34 UTC zdravý: mapa 200/818 B, dlaždice
    200/39 693 B za 0,09 s), ČHMÚ už mezitím po opravě 12b hlasoval
    („nezávislá potvrzení: 1 · zdroj ČHMÚ"), ale kompas ukázal jen
    „Radar se nepodařilo načíst." a verdikt zůstal „nepotvrzeno".
    Tři léky:
    - **Chybová větev kompasu mluví pravdou:** radarState „error" +
      svědek na zemi (stanice kola 8v, nebo ČHMÚ ≤ 45 min, nově
      společní funkcí groundTruthWitnesses) → verdikt „Právě nad
      tebou prší." s vysvětlením, že kompozit se nepodařilo načíst
      a že se zkusí znovu sám. Chyba jednoho zdroje není mlčení
      o dešti.
    - **ČHMÚ potvrzuje „prší právě teď" samo:** čerstvé ECHO
      PseudoCAPPI nad obcí (≤ 45 min) stačí jako samostatné
      potvrzení, stejně jako stanice (kolo 8v) a kompozit
      (kolo 8x). Při příležitosti opraven i skrytý pád: větev
      verdiktu dřív četla radarState.ageMin bez kontroly nuly —
      s ČHMÚ jako samostatným potvrzením mohla recomputeWhen
      spadnout úplně.
    - **Mobilní verdikt rozlišuje potvrzovatele** (stanice /
      radar / český radar / počet nezávislích) i
      v whenState.chmiSolo.
  - **(kolo 13) Radar má druhou nohu přes Worker; řádek ČHMÚ v
    seznamu modelů rušen.** Dave (19. 11. 12:52, mobil): „Radar
    nejede a taky nechápu, proč má ČHMÚ radar kolonku v seznamu
    modelů." Měření: api.rainviewer.com i dlaždice z tohoto stroje
    zdravé (200/818 B za 0,09 s; kompozit 200), ČHMÚ opendata a
    Worker také (now PNG 200/27 986 B, legenda 200/985 B), LKPR
    191130Z -RA BKN043, ČHMÚ nad Prahou zelené echo (0,160,0),
    kompozit nad Prahou průhledný — radar na Daveově mobilu ale
    celý den „Radar se nepodařilo načíst." (radarState „error").
    Vyšlo najevo, že přímé dotazy na cizí domény z jeho mobilní
    sítě opakovaně padají (dnes i aviationweather.gov), zatímco
    všechno přes Worker na Cloudflare jede. Dvě změny:
    - **Pojistka radaru přes Worker:** po selhání přímé maps.json
      se zkouší `/rv/maps`, po selhání přímé dlaždice `/rv/img`
      (nové endpointy workeru, passthrough s CORS `*`, úzký
      whitelist tvaru dlaždice; appka se ptá nejdřív přímo —
      CDN zůstává primární nohou). Maps fallback posouvá offline
      zálohu na poslední místo (nový parametr cachedJson
      `noOffline`), aby týdny starý seznam snímků nepřebil živý
      dotaz. Maska pokrytí zůstává přímá (její selhání verdikt
      nechytá). Bez nasazeného workeru se nic nemění: `/rv/*`
      vrátí 404 a appka zůstává u starého chování, verdikt drží
      pozemní pravda z kola 12c.
    - **Řádek ČHMÚ v tabulce modelů odstraněn** (Dave: radar
      není model, sloupec mezi předpověďmi matlaje). Národní
      radar dál hlasuje: chmiPotvrzuje v „prší právě teď",
      chmiSolo v kompasu, svědek v groundTruthWitnesses; jen už
      není vidět jako kolonka v tabulce.
    - Testy: 124/124 (nové: dvě nohy maps.json včetně pořadí
      dotazů a offline zálohy na posledním místě; proxy URL jen
      pro rainviewer dlaždice; strukturální pojistky zrušené
      renderChmiRow i zachovalého hlasování ČHMÚ; worker:
      passthrough maps i tiles, whitelist 400, šíření 404).
  - **(kolo 14) Přepínač kompozit / ČHMÚ v panelu radar.** Dave
    (19. 11. 13:14): „minimalistické tlačítko vpravo v rohu v panelu
    radar na přepnutí na radar ČHMÚ a při opětovném kliknutí
    přepnutí zpět. Pouze při lokaci česká republika. Stejný design.
    Jiná data. Nic jiného nepředělávej." Vpravo nahoře v panelu
    radar se pro lokality v pokrytí ČHMÚ a se zdravým modulem ČHMÚ
    objeví tlačítko ČHMÚ; klik přepne cifernák na data národního
    radaru, další klik vrací kompozit. Strnulost hlediska: pohled
    ČHMÚ kreslí tentýž design (kruh, prstence 25/50 km, verdikt,
    vysvětlení, zdroj) a tentýž cifernák, ale obsahem je aktuální
    snímek PseudoCAPPI (1 km/px, dnes citlivější na mrholení než
    kompozit: zelené echo nad Prahou, kde kompozit neviděl nic)
    plus kroky COTREC; trajektorii a ETA ČHMÚ nezná, takže je
    nekreslí ani nekecá (src říká „bez trajektorie"). Tlačítko
    je i v chybové větvi kompozitu: když kompozit na mobilní síti
    padne, národní radar se přepnutím zobrazí dál. Nová lokalita
    vždy začíná na kompozitu. Mimo pokrytí ČHMÚ se tlačítko
    nekreslí vůbec.
    - Testy: 127/127 (nové kolo 14: tlačítko jen v pokrytí a se
      zdravými daty včetně Berlína a výpadku ČHMÚ; obsah pohledu
      ČHMÚ — verdikt hit/miss, elipsa echa, COTREC „první echo
      za ~30 min", absence trajektorie; strukturálně: pohled ČHMÚ
      se kreslí před kompozitovými větvemi, reset při změně
      lokality, delegovaný klik na Neměnném rodiči).
  - **(kolo 15) Verdikt nepředjímá běžící měření; radar kreslí
    reálné pole; start aplikace nečeká na GPS.** Dave (19. 11.
    13:27, mobil, dvě obrazovky z jedné minuty): „Proč to na mobilu
    ukazuje něco jiného — verdikt." a „Radar není hezky vykreslený
    a na první načtení je načítání velmi problematické." Měřená
    příčina: ČHMÚ viděl slabé echo přímo nad Josefovem (neprůhledné
    pixely na snímcích 12:25 i 12:30 UTC, ~1 100 pixelů echa do
    20 km), ale na výpadkovém mobilním připojení došel pozorovací
    zdroj později než modelové signály — a recomputeWhen mezitím
    vykreslil definitivní „Možná kape · nepotvrzeno · 0 potvrzení",
    aby se o chvíli později překlopil na „Slabý déšť právě teď ·
    potvrzuje radar ČHMÚ". Tři léky:
    - **Registr „měřím ještě" (gtPending).** Každý pozorovací
      loader (kompozit, stanice METAR, ČHMÚ, met.no, regionální
      nowcast, DWD RADVOR/KNMI, GIBS, Meteosat) se při startu
      zaregistruje a po dořešení odregistruje; while registru
      není prázdný a hlasy jsou jen modelové, VERDIKT zobrazí
      stav „Ověřuji pozorováním" s výčtem zdrojů, na které se
      čeká — místo předčasného „nepotvrzeno". Pojistná lhůta
      90 s: zapomenuté odregistrování (kdyby) nikdy nezamrzne
      verdikt navždy. Říkání pravdy: „nepotvrzeno" se zobrazí,
      až když o něčem skutečně nikdo nedodá svědectví.
    - **Reálné pole srážek v kompasu.** Pohled ČHMÚ čte now-výřez
      ±48 km ze stejného PNG (bez jediného požadavku navíc) a
      kreslí bloky 3×3 km dle ordinálu škály; sucho v okruhu
      48 km se pak říká nahlas. Kompozitový ciferník dostal
      jemné (alfa 0,08–0,38) pozadí ze skutečného posledního
      snímku pod elipsu a trajektorii buňky. Elipsa ČHMÚ zůstává
      jako fallback, když se pole nepodaří vyčíst.
    - **Rychlý a čestný start.** Naposledy použitá lokalita se
      ukládá do localStorage a aplikace s ní startuje okamžitě,
      zatímco geolokace běží na pozadí (a při zamítnutí nebo
      selhání GPS zůstává funkční předpověď pro poslední místo).
      Panel radaru při načítání kompozitu nezmizí tiše, ale
      zobrazí cifernák se stavem „Měřím radar…" — spolu se
      stavem „ověřuji" to dělá první sekundy na mobilu čitelné,
      nikoli rozbité. (Opraven též cizí znak v komentáři
      loadSatellite.)
    - Testy: 132/132 (nové kolo 15: registr start/settle/štítky/
      pojistka; modelové hlasy + běžící měření → mode "checking"
      a žádné „nepotvrzeno"; chmiFieldFromPatch — severní blok
      k severu, sucho = prázdné pole, chmiReadNow ignoruje echo
      6 km od středu; radarFieldFromPatch + compassFieldSvg — práh,
      dosah, poloha; strukturálně: „Měřím radar…" v panelu, pole
      v obou pohledech, „Verdikt · ověřuji" v mobilním panelu,
      cache lokality v load/init).

## Kolo 15b — „Ověřuji“ končí známou chybou, ne až za 20 s (19. 11.)

  CI kola 15 odhalil vadu samotného registru: když pozorovací zdroj
  odpověděl chybou (síť výpadek), registr „měřím“ zůstal otevřený
  až do vyčerpání obou dotahů (+20 s, +60 s — celkem ~80 s). Na
  pomalém mobilu i v testech tedy verdikt osmdesát sekund tvrdil
  „Ověřuji“, přestože síť už dávno odpověděla; mobilní layout
  v stavu checking je navíc o řádek vyšší, takže fitGuard škáloval
  fonty pod přípustnou mez (0,78 na 393 px). Lék: registr drží jen
  první pokus měření — známá chyba ho zavře hned (se spočtením
  verdiktu a překreslením kompasu; skeleton „Měřím radar…“ ustoupí
  stavu chyby), další dotahy (kolo 11/12) běží potichu a nesmí
  verdikt na „ověřuji“ vracet znovu a znovu. Uspěje-li pozdější
  dotah, recomputeWhen při úspěchu verdikt sám překreslí — měřeno
  19. 11.: totéž URL odpovídá o chvíli později 200.

  - scheduleRadarRetry/scheduleMetarRetry/scheduleChmiRetry: settle
    na vstupu při známé chybě (gtPendingHas → gtSettle → recompute,
    radar/ČHMÚ navíc renderCompass), strop dvou dotahů beze změny.
  - loadRadar/loadMetar/loadChmi: gtStart jen při prvním pokusu
    (attempt 0), retry nikdy registr neotevře (žádné blikání
    maybe ⇄ checking).
  - Browser testy: tři omezené settle-waity (15 s) čekají, až verdikt
    opustí přechodné „ověřuji“, než se zmerí výsledný stav a layout —
    assertion dál tvrdí totéž (maybe + nepotvrzeno, --fit ≥ 0,8),
    jen už nesoutěží s dokončením měření. Měřeno v CI po fixu: test 8
    zelený, 393×665 fit 0,78 → 0,85; stav testu 1 potvrdí další běh CI.
  - Testy beze změny požadavků: 132/132 regression+worker, build
    index.html 491 484 znaků. Oba selhané CI browser testy padly na
    přechodném stavu „checking“: test 8, protože registr držel
    „měřím“ přes čekání na dotahy (layout 393 px zbytněl o řádek);
    test 1, protože assertion četl verdikt dřív, než pozorovací
    řetězce dozněly. Obě příčiny jsou opraveny v aplikaci, tvrzení
    testů zůstala beze změny.

## Kolo 16 — svižný start: žádná GPS clona, žádné zbytečné přenačtení (19. 11.)

  Dave (19. 11. 14:05, mobil, IMG_5092/IMG_5093): „Nenačítají se věci
  a seka se to. Chci svižnou appku." Měřený rozbor snímků: v 14:04
  aplikace zobrazila plný stav, v 14:05 však samotnou clonu
  „Zjišťuji tvou polohu…". Tři příčiny:
  (1) Šablona spouštěla fixní celoplošnou clonu (z-index 50,
  backdrop-blur) na každém otevření — obsah se pod ní mezitím
  načetl, ale nebyl vidět, dokud GPS neodpověděla (timeout 12 s
  na studeném fixu i déle). Rychlý start z kola 15 byl tedy
  neviditelný.
  (2) Hrubá fáze GPS přenačítala CELÉ appku při každém otevření
  i návratu do popředí, i když se poloha vůbec nezměnila — panely
  problikly, všechno se stahovalo znovu (sekvence IMG_5092 →
  IMG_5093 přesně ukazuje přenačtení za clonou).
  (3) recomputeWhen volá fitPanels na každé dotečení dat; při
  startu jich přijde i deset za pár sekund a každé měření layoutu
  stojí na mobilu jednotky až desítky ms — vlny cukání.

  Léky:
  - Template: #status začíná skrytý. Při startu žádná blokující
    clona; vzdělávací dialog (iPhone povolení) jen po výslovném
    klepnutí na špendlík, jinak nenápadný placeholder a poznámka
    v panelu. Špendlík ukazuje nápovědu u vyhledávání (showMsg),
    panely zůstávají živé.
  - acquirePosition: fix do 1 km od načtené lokality nespouští
    přenačtení; přesná fáze (upresni) dál hlídá skutečný pohyb.
  - load() zavírá nápovědu špendlíku (closeSugg).
  - fitPanels: měření layoutu maximálně jednou za 150 ms
    (FIT_COALESCE_MS) se závěrečným dojezdem — burst dotečených
    dat už cukání způsobit nemůže.
  - Testy: 135/135 (tři nové: skrytý status v template, 1 km práh
    GPS bez přenačtení, slévání fitPanels s dojezdem); browser
    fixture čeká na vyhledávání místo zavírání GPS dialogu.
    Build index.html 494 504 znaků.

## Kolo 17 — geolokace doopravdy dojede; startovní clona zpátky (19. 11.)

  Dave (19. 11.): „Ono to nezjišťuje polohu. V tom je celý problém.
  Nejede zjišťování polohy. Tu clonu při startu, když nejsou načteny
  data, tam nech. Oprav načítání polohy. Nefunguje.“

  Rozbor: jednorázový getCurrentPosition má časovač 12 s; na studeném
  startu GPS (slabý signál, uzavřené prostranství, úsporný režim)
  v tomto čase neodpoví, aplikace to vzdala a uživatel viděl buď
  visící clonu, nebo tiché nic. Přitom telefon by fix doručil
  o chvíli později — jen se ho nikdo neptal déle.

  Léky:
  - watchPosition fallback: po vypršení (code 3) nebo nedostupnosti
    (code 2) se aplikace nevzdává, ale otevře pozorovatel s přesným
    GPS na až 75 s; první platný fix se použije okamžitě a pozorovatel
    se zavře (geoWatchStop). Hrubá fáze dostala 15 s místo 12 s.
  - Po 10 s čekání clona říká, co se děje („rychlá metoda
    neodpověděla — přecházím na přesné GPS, může to trvat i minutu“)
    a že klepnutím jde psát obec ručně.
  - Zamítnutí (code 1) vždy ukáže vzdělávací dialog s cestou do
    nastavení iPhone — iOS po zamítnutí svůj dotaz už nikdy
    nezopakuje, dialog je jediná cesta k povolení.
  - Startovní clona „Zjišťuji tvou polohu…“ je v template zpátky
    (Dave výslovně žádal); skryje se prvním renderem dat.
  - Špendlík dál neblokuje (nápověda u vyhledávání, kolo 16);
    ruční volba obce zastaví čekajícího GPS pozorovatele.
  - Změny kola 16 zůstávají: práh 1 km bez přenačtení, slévání
    měření layoutu (FIT_COALESCE_MS), ukládání poslední lokality.

  - Testy: 136/136 (dva přepsané kolo 16/17, jeden nový kolo 17:
    watchPosition fallback, 15 s/75 s, hint po 10 s, vzdělávací
    dialog, geoWatchStop v pouzij i v pick); browser fixture zase
    zavírá startovní dialog. Build index.html 497 525 znaků.

## Kolo 17b — behaviorální důkaz geolokačního fallbacku (19. 11.)
Dva nové regresní testy vykonávají kód kola 17 v izolovaném kontextu, nikoli
pouze kontrolují zdrojový text. Test 1 simuluje studený start: telefon vrátí
code 3 (timeout hrubé fáze), aplikace nesmí zavolat noGeo, musí otevřít
pozorovatele watchPosition (timeout 75 000 ms, enableHighAccuracy), po
doručení fixu (accuracy 25 m) musí použít lokalitu (load s názvem z geokodéru)
a pozorovatele zavřít (clearWatch). Test 2 simuluje zamítnutí přístupu
(code 1): volání jde do noGeo a watchPosition se neotevírá. Celkem 138/138
testů, build beze změny (main.js a index.html nedotčeny).

## Kolo 18 — visící geolokace nikdy nenechá clonu němou (20. 11.)
Dave 20. 11. 11:44 (IMG_5099): clona „Zjišťuji tvou polohu…“ visela bez odezvy
i po minutách a systémový dotaz na povolení polohy se nikdy nezobrazil.
WebKit v samostatné PWA umí dotaz na povolení přehlédnout; žádost pak visí
bez fixu, bez chyby, a neozve se ani časovač. Druhá slepá ulička: iOS po
návratu ze spánku volá acquirePosition(true), které dřív smazalo čekající
hlášku, ale samo nehlásilo nic. Opravy:
- report = !silent || (!cur && !lastJ): uživatel bez načtených dat dostává
  hlášky vždy, i při tichém volání z visibilitychange,
- pojistka hrubé fáze 17 s: neozve-li se callback vůbec, pozorovatel
  watchPosition se otevře stejně,
- pojistný časovač 100 s: čekání vždy skončí hláškou „Polohu se nepodařilo
  zjistit…“ s pokynem na Nastavení → Polohové služby a možností psát obec
  ručně — žádná němá clona,
- pokyn „Nezobrazil se dotaz na povolení polohy?“ v hláškách po 10 s i v
  závěrečné hlášce (ikona z plochy má oprávnění vlastní, nezávislé
  na Safaru),
- rychlý start z localStorage prodloužen z 8 h na 24 h: první ranní start
  po noci už nevisí na studeném GPS (data se stahují vždy čerstvá),
- ruční volba obce (pick) vypíná i nové pojistné časovače.
Testy: 3 nové (1 strukturní, 2 behaviorální, vykonávají acquirePosition
v izolovaném kontextu), celkem 141/141. Build 500 678 B.

## Kolo 19 — konec ping-pongu lokalit: nula přenačtení na stejném místě (20. 11.)
Dave 20. 11. odpoledne: „První načtení to načte správně a při druhém se
ta poloha opět načítá. To bude nějaký hlubší problém.“ Změřeno na
skutečném kódu v izolovaném kontextu: uložená přesná GPS lokalita P,
hrubý Wi-Fi fix W vzdálený 2,9 km (v budově běžné) — tehdejší logika
přenačetla na W vše (viditelné „Stahuji předpovědi modelů…“), přesná
fáze vzápětí přehodila lokalitu zpět na P (d(P,P') = 13 m, přesto DVĚ
přenačtení) a uložená lokalita se přehazela sem a tam při KAŽDÉM
dalším otevření. Opravy:
- pouzij: HRUBÝ fix nikdy sám nepřenačítá, ať je od načtené lokality
  kdekoli — jen požádá přesnou fázi (upresni), která rozhodne
  spravedlivě; PŘESNÝ fix (accuracy do 150 m) přenačte jen při pohybu
  nad 1 km od načtené lokality,
- upresni: přesný fix srovnává s NAČTENOU lokalitou (cur), ne s hrubou
  kotvou — zmizelo i druhé, dřív zbytečné tiché přenačtení,
- skutečné přesunutí o kilometry se proježí právě jedním přenačtením
  (testovaný scénář 3,4 km).
Měření po opravě: stejný scénář druhého otevření nyní vyvolá 0
přenačtení. Testy: 3 nové (1 strukturní, 2 behaviorální), celkem
144/144. Build 501 780 B.

## Kolo 20 — Wi-Fi hledání lokace odstraněno, verze viditelná v rozhraní (20. 11.)
Dave 20. 11. 12:20 (IMG_5100): „Je nutné tam mít to Wi-Fi hledání lokace?“
Není. Wi-Fi poloha byla rychlá, ale nepřesná (Daveův telefon ji měl až
2,9 km vedle) a pro radar s pixelem ~1,2 km nepoužitelná; rychlost
každodenních startů kryje od kola 18 rychlý start z uložené lokality.
Změny:
- první (a jediný jednorázový) geolokační dotaz žádá rovnou přesné
  GPS: timeout 20 s, maximumAge 0, enableHighAccuracy true;
  fallback na pozorovatel watchPosition (kolo 17) i všechny pojistky
  kola 18 zůstávají beze změny,
- hlášky aktualizovány („Čekám na přesné GPS z družic…“), pokyny na
  Nastavení → Polohové služby zůstávají,
- v pravém dolním rohu je viditelné označení verze (v20): na mobilu
  jde na první pohled ověřit, které kolo běží (iOS drží pozastavenou
  PWA v paměti se starým kódem, dřív nebylo možné poznat, jestli
  oprava vůbec dorazila).
Testy: 2 nové (1 strukturní, 1 behaviorální; kolo 17 test aktualizován
na přesné-GPS-first), celkem 146/146. Build 502 315 B.

## Kolo 21 — geolokace konečně jede na iOS: žádost z dotyku, ne automaticky (20. 11.)
Dave 20. 11. odpoledne: „Nežádá mě to o polohu. Nejde to ani v samotném
Safari. Pořád jen načítání polohy na té cloně. Vyřeš tu polohu.“
Příčina: WebKit (Safari i PWA na něm) umí systémový dotaz na povolení
polohy přehlédnout, když žádost letí automaticky při startu stránky.
Žádost pak visí bez fixu, bez chyby i bez časovače (kolo 18 to
naměřilo v PWA, kolo 21 prokázalo, že to platí i v běžném Safari).
Jediná spolehlivá cesta na iOS je vyvolat geolocation z dotyku prstu.
Změny:
- start aplikace nejprve projde stav oprávnění přes
  navigator.permissions (Safari 16+, Chrome, Android):
  granted → žádá hned automaticky (systémový dotaz nepadá);
  denied → okamžitě ukáže návod k Nastavení (nic nevisí, dřív
  se čekalo na pojistku 100 s);
  prompt (nerozhodnuto) → automatická žádost NELETÍ — clona
  nabídne tlačítko „Povolit polohu“, jehož klepnutí spustí žádost
  z gesty a iOS pak systémový dotaz spolehlivě zobrazí,
- clona studeného startu: nově „Kde právě jsi?“ s tlačítky
  „Povolit polohu“ a „Napiš obec ručně“ (nouzová cesta vždy),
- prohlížeče bez permissions API (iOS < 16) zůstávají u
  automatické žádosti s pojistkami (kolo 17/18), tlačítko je
  dostupné i v nápovědě po 10 s i ve zprávě pozorovatele,
- první úspěšný fix se zapamatuje (bpGeoOk) — další starty jsou
  automatické; zamítnutí paměť vymaže,
- rychlý start z uložené lokality se stavem „prompt“ nikdy
  nevyrušuje tlačítkovou clonou (data jedou dál),
- service worker bump v6 → v7: aktualizace SW se vynutí hned při
  startu, controllerchange reloadne stránku s novým kódem,
- verze v rohu: v21 (ověření, které kolo telefon skutečně běží).
Testy: 5 nových v regresích (1 strukturní, 4 behaviorální) +
aktualizace kola 17/18 (init používá geoStart) + browser test
nové tlačítkové cesty. Celkem 151/151. Build 507 389 B.

## Kolo 22 — rozklikávací radar ČHMÚ pryč: panel jako v době, kdy appka fungovala (21. 11.)
Dave 20. 11. večer: „Co kdybys vrátil kód do doby, kdy to fungovalo.
Tedy kdy nebyl radar ČHMÚ rozklikávací.“
Rozbor historie ukázal dvě věci:
1. Přepínač kompozit/ČHMÚ (kolo 14, přidáno 19. 11. na Daveův tehdejší
   požadavek) je čistě vizuální zásah — u geolokace ani startu nic
   nemění. Kolo 22 ho celý ruší: panel radar se vrací do podoby
   z doby před ním (jediný pohled: kompozit RainViewer, mimo dosah
   satelit), žádné tlačítko, žádný přepínatelný pohled ČHMÚ.
   Hlasování ČHMÚ ve verdiktu (kolo 12) zůstává — jde o datovou
   nohu na pozadí, ne o rozklikávací panel.
2. Plné vrácení na stav kola 13 by oživilo chyby, které Dave sám
   hlásil dál (kolo 16: „nenačítají se věci“, kolo 17: „nejede
   zjišťování polohy“, kolo 18: „clona visí bez odezvy“). Geolokační
   opravy kol 15–21 proto zůstávají — právě kolo 21 mění způsob,
   jak iOS povolení k poloze vyžaduje (žádost z dotyku prstu).
   Verze v rohu: v22; service worker v7 → v8 (vynucená aktualizace
   i u nainstalované PWA).
Testy: 1 nový strukturní (kolo 22), 3 testy kola 14 odstraněny
(funkce přepínače už neexistují), kolo 15 strukturní test upraven.
Celkem 149/149. Build 500 799 B.

## Kolo 36 — radar na prvním spuštění: rychlé přímé nohy, pamět blokující sítě, strop ramene (27. 11.)

Dave 27. 11. (mobil, opakovaně): „Proč se na první spuštění nezapne
radar. Chci, aby první spuštění bylo bezproblémové." Kolikrát se po
vylepšení něco rozbilo. Analýza řetězce proti měření kola 13 (síť
mobilního operátora nechává přímé dotazy na cizí domény viset,
přes Worker vše jede):

1. **Proč radar „neexistoval" prvých ~15 s.** Přímý pokus o maps.json
   čekal 10 s (fetchT) a KAŽDÁ dlaždice 12 s (RV_TILE_TIMEOUT_MS),
   než se vůbec spustil fallback na Worker. Na blokující síti tedy
   první spuštění reálně zaplatilo 12 s na každé noze paralelně a
   kompas mezitím neměl co kreslit.
2. **Přímá noha 4 s (RV_DIRECT_TIMEOUT_MS).** Na zdravé síti dlaždice
   odpovídá za desetiny sekund, takže se nic nemění; na blokující
   síti dorazí fallback za sekundy. Noha přes Worker si drží plných
   12 s.
3. **Pamět blokující sítě (sessionStorage bpRvBlock).** Když přímá
   noha selže a Worker dodá, appka si to zapamatuje do konce relace
   prohlížeče; další spuštění (i opětovné načtení stránky) jede na
   Worker rovnou, přímá cesta zůstává jako jeho záloha. Nová relace
   na zdravé síti začíná čistě; úspěšný přímý pokus nápovědu smaže.
   Platí pro maps.json, dlaždice i masku pokrytí.
4. **Maska pokrytí přes Worker.** readCoverage dřív visela na přímé
   cestě záměrně bez fallbacku; na Daveově síti proto radarCoverage
   vždy skončila „error" a kompas se o „radar sem nedosahuje"
   nedozvěděl. Nově se po selhání přímé nohy zkusí /rv/img; Worker
   (kolo 36) přijímá kromě dlaždic radaru i přesný tvar masky
   /v2/coverage/0/256/<z>/<x>/<y>/0/0_0.png. Whitelist zůstává
   úzký, žádná otevřená proxy.
5. **Strop celého radarového ramene (RV_ARM_DEADLINE_MS = 20 s).**
   Po vzoru chmiDeadlineFire (kolo 35b): když radarState po 20 s
   neexistuje ani jako data ani jako chyba, rameno se prohlásí za
   spadlé, strážka „radar" se uvolní, kompas přizná výpadek a
   standardní dotahy (kolo 11, +20 s a +60 s) se rozjedou. Verdikt
   na radar nikdy nečeká déle než 20 s.
6. **Nowcast RainVieweru „off".** Měřeno 27. 11.: maps.json nese
   radar.nowcast prázdný (produkt vypnutý na straně zdroje, dotaz
   200). Stav se nově hlásí jako „off" (vypnuto na straně zdroje),
   ne jako selhání; blend hlas nepočítá jako u error, diagnostika
   nelže o výpadku.

Testy: 180/180 (nové 8: struktura 4s/12s timeoutů a nápovědy;
rvMapsJson s nápovědou Worker-první a se zapamatováním selhání;
readTilePatch tři scénáře pořadí nohou; readCoverage dvě nohy a
propustnost výsledku; radarDeadlineFire tři stavy; vyzbrojení
stropu v loadRadar; „off" nowcastu; Worker přijme masku a odmítne
cizí cesty). Aktualizovány strukturní testy kol 11 a 13 na novou 
podobu timeoutů. Verze v36, service worker v22.

## Kolo 35b — oprava pojistné sítě „ověřuji“ a stropu čekání na ČHMÚ (27. 11.)

Dave 27. 11. 17:00, mobil, Líšeň: verdikt visel ve stavu „Ověřuji /
čekám na: radar ČHMÚ“ i po mnoha minutách, přestože všechna data
dorazila (radarový kompozit hlásil srážky nad obcí, celý řetěz ČHMÚ
přes Worker odpovídal 200). Dvoufázová analýza:

1. **Pojistná síť gtNetArm (kolo 30) byla mrtvá.** Časovač po
   92 s volal gtPrune() PŘED podmínkou „pokud něco stále visí“, takže
   expirované strážky smazal dřív, než se zeptal, podmínka byla vždy
   prázdná a překreslení nikdy neproběhlo. Náprava: registr se nově
   ptá napřímo (bez gtPrune — pozor, gtPendingLabels() interně prune
   volá také, takže nestačilo jen prohodit řádky), potom se
   expirované smažou a recomputeWhen proběhne vždy, když něco viselo.
   Verdikt se tak dopíše nejpozději ~92 s od startu, i kdyby se
   žádné pozorování nedotáhlo.
2. **Strop čekání na ČHMÚ (45 s).** Obrázky ČHMÚ (legenda, snímky,
   TAR členové) se načítají jako <img>; na utuhlém mobilním
   připojení se stane, že nespustí onload ani onerror a modul visí.
   Nová pojistka chmiDeadlineFire po 45 s označí zavěšené ČHMÚ
   chybou, uvolní strážku a spustí standardní dotahy (+20 s, +60 s).
   Dořešené stavy (data i chyba) a zastaralá načítání nedotčená.

Testy: 172/172 (nové 3: pořadí prune/podmínka včetně expirované
strážky a klidu bez visících strážek; chmiDeadlineFire všechny tři
stavy; source kontrola vyzbrojení stropu). Chyba byla latentní od
kola 30, kolo 35 ji nezpůsobilo ani neztížilo.

Souběžně diagnostikováno (beze změny kódu): Open-Meteo ensemble
vrací pro IP Workera 429 trvale od 26. 11. 17:00 UTC (bezplatná
kvóta 10 000 volání/den se počítá per IP, Cloudflare Worker sdílí
výstupní IP s cizím provozem). Ensemble není strážka, verdikt to
neblokuje; aplikace ensemble kaskádovitě postrádá bez dopadu na
zbývající zdroje. Sběrač ens chyby eviduje (err „ens“), sběrná
řada fc/met/rv pokračuje.

## Kolo 35 — měřená implementace 14denní analýzy přesnosti: hory, ocas za oknem, D2 polygon, rotace měst (26. 11.)

První kolo postavené přímo na datech: 12.–26. 11. 2026 sběrač nasbíral
31 191 záznamů (336 hodinových JSONů, 12 dílků po 5 min, 100 obcí).
Vše bylo spárováno s tolerancí ±35 min (geometrická zkratka: předpověď
z hodiny H pro cíl T se páruje s pozorováním, jehož met.t/rv.t je
nejblíž T) a spočítáno dvakrát nezávisle (dvakrát měř, jednou řeš):

- **minutecast × pozorování: 214 010 párů.** Prahy 0,025–0,1 mm/15 min
  jsou identické kvůli kvantizaci Open-Meteo na 0,1 mm (POD 0,52–0,53,
  bias 0,70, přesnost 0,86); práh ≥0,15 sráží POD na 0,31. Stávající
  THRESH_OBS 0,2 mm/h je optimum, beze změny (zdokumentováno v kódu).
- **Brier pravděpodobností:** Open-Meteo pp 0,1238, ensemble 0,1243;
  **pp je plochý až do 13. h (0,124–0,128), ensemble do 9. h
  (0,122–0,128)** → ocas za 8h oknem je opodstatněný: když modely
  uvnitř okna mlčí, panel „Kdy začne pršet" připojí větu o dešti
  za hranicí (handover: ensemble 9. hodina, Open-Meteo 10.–13.,
  práh zobrazení 30 %). Řada pp se stahuje do HOURS_TAIL=12, ens
  o hodinu navíc. Platí pro mobilní verdikt i PC panel (tentýž prvek).
- **modely ensemble:** icon_d2 Brier 0,1210 vs icon_eu 0,1311 — d2
  je lepší, ale jeho doména na Open-Meteo NENÍ box 43,2–58,1°N ×
  −3,9–20,3°E, nýbrž rotovaný čtyřúhelník s KŘIVKOU jižní hrany
  (bisekce živými sondami, 429 odlišen od „No data", každý bod 2×):
  43,53°N při 5°E, vrchol 43,67°N při 10°E, 43,58°N při 13°E,
  43,45°N při 16,3°E; východ ~18,74°E při 50,5°N až ~19,43°E při
  54°N. Starý box posílal 28/100 obcí do zákonitého neúspěchu
  (Krakov, Budapešť, Pécs, Žilina, Bělehrad…; Nice a Split selhávají
  JIŽNÍM ROHEM mřížky 3×3 −0,1° pod hranu). Nový polygon (ensD2Ok,
  zrcadlený ve workeru a v testech) drží všech 72 d2-funkčních obcí
  uvnitř včetně rohů a všech 28 selhání ven.
- **hory (elev ≥ 700 m, 9 669 párů):** ensemble ztrácí 2× dovednost
  (Brier rozdíl ens−pp: hory +0,018 vs nížina +0,010), minutecast má
  naopak nejnižší FAR právě v horách (0,21; pobřeží 0,31). Nově:
  verdictProb v horách používá SYMETRICKÝ průměr (ens+om)/2 (OM smí
  ensemble skorigovat dolů; jinde zůstává kolo 8z3 max(ens,(ens+om)/2)),
  blendWeights v horách ens ×0,85 a radarová rodina ×1,1. Výška bodu
  teče z geokódu (placeElev z j.elevation).
- **radar jako svědek: 30 915 párů radar×METAR — radar vynechá ~80 %
  srážek, které stanice hlásí** (PL/IE/UK/LV/BG navíc pokrytí „none").
  Aplikační pravidla (kompas nekreslí z kompozitu při „none", stanice
  potvrzuje sama ≤25 km, rozpor mokrá stanice × suchý radar se říká
  slovy, kolo 12) měřením potvrzena, beze změny chování — zdokumentováno.
- **sběrač (doporučení 7):** rotace ensemble šla z 8 pevných UTC hodin
  pro všechna města (2/3 denního cyklu bez ensemblu) na rotaci PER
  MĚSTO: (townHash(jméno)+UTC hodina)%3===0 → každé město 8 z 24 h
  vždy po 3 h, fáze podle jména; rozpočet beze změny 7 200 bodů/den
  < 10 000, na probuzení 2–3 ens obce (dříve 8–9), záznam nese ensT
  (1/0) a /analysis/status ví, kterým obcím ens mohl chybět nadřízeně.
  ENS_ROT_HOURS zůstává exportem pro zpětné vyhodnocení starých záznamů.

Testy: 169/169 (5 upravených kontextů kvůli isMountain, 4 nové regresní
— hory verdikt/blend, ocas za oknem, zrcadlo polygonu; 6 přepsaných
worker testů rotace na sémantiku per město + ensT). Build 540 456 B.
Omezení měření: METAR je na letištích 10–30 km od obce, radar měří
ve výšce (virga, bright band), okno 14 dní.

## Kolo 34 — sucho v pohledu ČHMÚ: přepínač se hlásí i bez buněk (24. 11.)

Dave (mobil, 24. 11. 13:19): „Nejede prepinani na ČHMÚ radar. Nic to
neprepne.“ Vyšetřeno na dnešním snímku: ČHMÚ publikuje sucho, pole
1×1 km je prázdné a stará podmínka `chmiCells` vypnula celý přepis
popisku, takže pohled ČHMÚ vypadal i mluvil stejně jako kompozit.
Přepínač tak dal vidět jen podsvícený segment. Měření: dnešní PNG
(12:10 UTC, 680×460) je z ~97 % průhledné; včerejší (23. 11. 12:10)
nesl ~6 000 barevných pixelů srážek. Zároveň ČHMÚ nově kreslí do
datového PNG dekorace: černý rám po okrajích, texty vlevo nahoře a
šedý panel vpravo (5 984 černých a 1 521 šedých pixelů; 23. 11.
totožných 5 986/1 521, tedy trvalá dekorace, ne data).

Opravy:

- Prázdné pole je taky verdikt: `chmiNarrative` umí pracovat bez
  buněk a pohled ČHMÚ mluví daty národního radaru vždy: sucho
  v okruhu 48 km („Sucho okolo tebe.“), příchod srážek do hodiny
  z COTREC osy („Přiletí k tobě.“), mrholení potvrzené stanicí. Cifernák
  zůstává kompozitní, pokud nemá co kreslit, a src řádek to říká
  na rovinu („sucho do 48 km, cifra z kompozitu“).
- Filtr dekorací (`chmiEchoColor`): pixel se počítá jako srážka jen
  tehdy, když se jeho barva podobá barvě ověřené legendy dBZ; černý
  rám, texty i šedý panel tak nemohou založit falešné buňky (dnes
  by hrozily hlavně na severu Čech a Moravy). Bez legendy se chová
  jako dřív, aby modul neoslepnul.
- Krátké varianty všech nových vět pro úzký layout (kolo 33).

Verze v rohu: v34; service worker v20. Testy: 165/165 (regrese 111,
worker 54); nový test kola 34 asertuje suchý verdikt, filtr dekorací
i strukturu přepínače.

## Kolo 33 — úzký layout: stručné odpovědi pro tytéž situace (20. 11.)

Dave (PC): „Když zmenším rozložení okna, tak ten text je schovaný
u popisku minimálně zčásti. Vytvoř stručnější odpovědi, když je
méně místa pro stejné meteo situace.“ Panel Radar v úzkém okně
má na méně znaků a dlouhá vysvětlující věta se do něj nezvedla.

Řešení, tři části:
- Úzký layout se netuší odhadem, ale čte se ze stejného signálu
  jako lišta souhrnů (NARROW / html.compact z applyLayoutMode):
  zúžené okno na PC pod 900 px i mobil dostanou krátké věty.
- krátké varianty pokrývají tytéž meteo situace v obou pohledech:
  kompozit (prázdný dosah, nad tebou, přiletí, mine, stojí,
  pozemní pravda „právě nad tebou prší“) i ČHMÚ (padá nad tebou,
  mrholí jen stanice, déšť dorazí, do hodiny nic). Verdikt se
  nekrátí — krátký je sám; krátí se jen vysvětlující věta a klíčové
  údaje (vzdálenost, směr, čas) zůstávají. Příklad: „Nejbližší
  slabé srážky 9 km V od tebe; podle předpovědi radaru dorazí
  k tobě asi za 25 min.“ → „Déšť 9 km V dorazí asi za 25 min.“
- Přepnutí široký/úzký (zmenšení a roztažení okna na PC) musí
  kompas překreslit, jinak by v něm po přepnutí zůstala viset
  dlouhá věta z předchozího režimu; resize a orientationchange
  nyní volají renderCompass().

Verze v rohu: v33; service worker v19. Testy: 164/164 (regrese 110:
+1 test kola 33, stejné situace ve dvou délkách se zachovalým
verdiktem, vzdáleností, směrem a časem, signál NARROW, překreslení
kompasu při přepnutí režimu; worker 54).

## Kolo 32 — popisek ČHMÚ v lidské řeči, ne v žargonu (20. 11.)

Dave: „Chci změnu popisku radaru při změně radaru na ČHMÚ. Ať
popíše, co vidí na radaru — uživatelsky přívětivě.“ Kolo 31
přepnulo popisek na data zobrazeného radaru, ale věta pod verdiktem
zněla jako technická zpráva: „Nejbližší slabé echo 9 km V od tebe;
COTREC národního radaru čeká srážky u tebe za ~25 min.“

Změna je jen ve znění, logika zůstává z kola 31:
- „Nejbližší slabé echo“ → „Nejbližší slabé srážky 9 km V od tebe“;
  slovo echo zmizelo z uživatelských vět úplně.
- „COTREC čeká srážky u tebe za ~25 min“ → „podle předpovědi
  radaru dorazí k tobě asi za 25 min“; zkratka COTREC uživatel
  nevidí, zůstává jen v src řádku a komentářích.
- Konec srážek nad tebou: „přestanou asi za 10 min“ místo
  „COTREC čeká jeho konec za ~10 min“.
- Poslední věta bez extrapolace: „Srážky v dohledu.“ místo
  „Echo v dosahu.“.
- Src řádek zkrácen na „popisek z tohoto radaru“ (technická
  závorka s polem a COTREC pryč), verdikty zůstaly úsporné
  (max 20 znaků) — panel je primárně mobilní.

Verze v rohu: v32; service worker v18. Testy: 163/163 (regrese 109:
+1 test kola 32, přívětivé znění bez žargonu, délky verdiktů,
strukturní úprava src; worker 54).

## Kolo 31 — pohled ČHMÚ mluví daty národního radaru (20. 11.)

Dave: „Když přepínám radar, tak chci jiný popisek podle dat daného
radaru.“ Od kola 26 měl pohled ČHMÚ jiné POZADÍ (1×1 km pole) a jiný
src řádek, ale verdikt a věta pod ním pořád pocházely z kompozitní
geometrie: kompas kreslil národní a slova citovala cizí mozaiku
(„Tě mine. Prolétne 39 km V od tebe…“).

Nová funkce chmiNarrative() počítá popisek z dat zobrazeného
radaru:
- Nejbližší echo z reálných buněk 1×1 km pole (vzdálenost od kraje
  echa, směr z compass rose), intenzita jen s ověřenou legendou
  (kolo 8ba: bez škály se čísla nevyhánějí).
- Čas z COTREC osy provozovatele sítě: první mokrý krok →
  „Přiletí k tobě.“ za ~N min; echo nad tebou → „Právě nad tebou.“
  a konec z prvního suchého kroku; celá hodina suchá → poctivé
  „Nic do hodiny.“, žádný slib z cizí extrapolace.
- Pozemní pravda (kolo 12) platí i v tomhle pohledu: stanice měří
  srážky pod prahem echa → „Nad tebou mrholí.“, ne falešné „nic
  u tebe“.
- Elipsa a trajektorie zůstávají vizuálním doplňkem z kompozitu
  (pohyb buňky se počítá z kompozitní osy), src řádek přiznává
  „popisek z tohoto radaru (pole 1×1 km + COTREC)“.
- Přepis se děje jen s čerstvým snímkem (do 45 min), v dosahu
  národního radaru a s buňkami; jinak zůstává kompozitní text
  i kompozitní podklad, aby slova nelhala o tom, co je vidět.

Verze v rohu: v31; service worker v17. Testy: 162/162 (regrese 108:
+2 testy kola 31, výpočet popisku a struktura přepisu; worker 54).
Build 524 994 B.

## Kolo 30 — verdikt čeká jen na pozorování, nowcast DWD/KNMI ho neblokuje (20. 11.)

Dave (mobil, Líšeň, 15:26): „Co se děje s tím verdiktem panelem?“
Snímek ukazoval rozpor: radarový panel byl dávno hotový („Tě mine.
Prolétne 39 km V od tebe · snímek 7 min“), modely dávno dořekly
(„DÉŠŤ OD 21:00“, shoda 2/10), ale verdikt visel ve stavu
„Ověřuji · Verdikt ještě není hotový“ a psal, že „Radar, stanice
i ČHMÚ ještě měří — přesný verdikt se doplní sám“.

Diagnóza, dvě chyby v jedné:
- Verdikt blokoval jediný rozpracovaný zdroj: nowcast DWD RADVOR/KNMI
  (radarová extrapolace provozovatele sítě). Registr běžících měření
  z kola 15 počítal pending všechny zdroje najednou, takže model
  držel celý verdikt v „ověřuji“ — a s ním zmizel i panel Kdy.
- Věta o čekání lhala: vypsala „pozemní pozorování“, i když žádné
  ne běželo. Nowcast není pozemní měření, ale výpočet.

Oprava, tři části:
- Registr se rozdělil na dvě množiny: pozorování (radarový kompozit,
  stanice, radar ČHMÚ) a nowcasty (met.no, regionální, DWD RADVOR/
  KNMI, družice). Verdikt „ověřuji“ čeká pouze na pozorování;
  nowcast se stáhne, až ho dá, a recomputeWhen() ho sám doladí.
- Texty už vypisují skutečné zdroje, na které se čeká; pending
  nowcasty mají vlastní štítek s dovětkem „verdikt na něj nečeká“.
  Pevná fráze o měření všech tří nohou najednou je pryč.
- Pojistná překreslovačka: gtPrune probíhal líně, až při dalším
  recomputeWhen, takže zapomenutý settle mohl UI nechat viset
  navždy. Nový časovač (jeden na celek) po 90 s + 2 s sám překreslí,
  pokud něco stále visí.

Verze v rohu: v30; service worker v16. Testy: 160/160 (regrese 106:
+3 testy kola 30 — registr dvou množin, nowcast neblokuje verdikt,
struktura; worker 54). Build 521 038 B.

## Kolo 29 — nepřesné informace: široké rozpětí jako časy, ne nemožné minuty (21. 11.)

Dave (mobil, Líšeň, panel Kdy hlásil „za 115–254 min“): „Nejsem
spokojen s tím, že mi apka říká tak nepřesné informace. Najdi cesty,
jak to zlepšit. Rozsah deště 100 minut je nemožný.“ Dva problémy
v jedné hlášce: (a) minutová přesnost u odhadu tři hodiny dopředu
neexistuje — okno 139 min vypadalo jako hádání, ne jako odhad;
(b) dvojsmysl — „za 115–254 min“ se dalo číst jako déšť od 115. do
254. minuty („rozsah deště“), což přesně Dave vytýká.

Řešení, tři pravidla čtení odhadu:
- Okno širší než 45 min nebo sahající za 90. minutu se hlásí jako
  časy dne: „mezi 18:55 a 21:35“. V Daveově případě by panel tedy
  řekl „mezi 18:55 a 21:35“ místo „za 115–254 min“.
- Jediný odhad dál než 90 min bez rozptylu se hlásí jako „kolem
  19:15“, s upřímným dodatkem „přibližně 2 h 55 min ode teď“.
- Minuty zůstávají jen tam, kde mají význam: odhady do 90 min
  („za 23 min“, „za 15–35 min“).

Příčina rozpětí se taky přestala zahálčet: rozpočet nejistoty
(variance budget, kolo 8z3) nese vrchní složku a panel ji vyjmenuje.
Při neshodě zdrojů (Daveův případ: 15min model ~115 min, ensemble
~254 min) text řekne „zdroje se na čase rozcházejí (115–254 min)“,
místo staré generické věty o nepravidelném postupu pole. Ta přijde,
jen když ji počítá příčinou: pohyb pole (rozptyl rychlosti),
neshoda snímků radarové řady, nebo přeháňky.

Mobilní solo panel mluví tentýmž jazykem (časy u širokých oken,
„kolem 19:15“ u vzdálených odhadů), dodatek „mezi X. a Y. minutou“
se u časového okna neduplikuje a šance do konce okna se u dávného
horizontu taky hlásí časem („šance 44 % do 21:35“). Zdrojová řádka
u dávného odhadu už neslibuje „horizont 60 min“; říká „čas z pohybu
srážkového pole“.

Rozptyl samotný zůstal poctivý: dřívější rozpočet v kvadrátech
(kolo 8z3) se nezměnil, jen se k němu přidala knihovna složek,
která rozhoduje o textu. Jedna složka se do rozpočtu započítává
jednou jako c4 (přeháňkové σ 0,35), žádná se nesčítá hromadně.

Verze v rohu: v29; service worker v15. Testy: 157/157 (regrese 103:
+1 strukturní test kola 29; worker 54). Build 518 418 B.

## Kolo 28 — přepínač radaru se ukáže hned, když dorazí ČHMÚ (21. 11.)

Dave (mobil): „Na mobilu se po prvním otevření nezobrazí možnost
přepnout radar. Až po vyhledání lokality jiné.“ Příčina: rychlý start
z uložené lokality má radarové dlaždice v cache service workeru, takže
kompas se vykreslí téměř hned; ČHMÚ jede vlastním workerem a data
doručí později. Když dorazila, kód zavolal jen přepočet verdiktu
(recomputeWhen), ale nikoli překreslení kompasu — přepínač Kompozit/
ČHMÚ se tedy objevil až při nejbližším překreslení z jiné příležitosti
(hledání jiné lokality přeložilo celý řetězec). loadChmi nyní po
dosazení chmiState překreslí kompas okamžitě, stejně jako to už dělala
chybová větv (scheduleChmiRetry).

Ještě jedna poctivostní oprava ve stejném panelu: zdrojový řádek
tvrdí „radar ČHMÚ · PseudoCAPPI 2 km…“ jen tehdy, když kompas
opravdu kreslí pole ČHMÚ (chmiCells). S prázdným polem (sucho) nebo
s polem pod práhem kreslení klesá na kompozit a řádka přiznává
kompozit — dřív mohla lhát o tom, co uživatel vidí.

Verze v rohu: v28; service worker v14. Testy: 156/156 (regrese 102:
+1 strukturní test kola 28; worker 54). Build 515 531 B.

## Kolo 27 — panel Radar vede do sloupce, cifernák vždy vycentrovaný (21. 11.)

Dave (snímek PC verze, Líšeň): „Všimni si, jak je to rozpadlé. Nesedí
ty věci do těch polí. Tohle je zásadní problém. Když je málo místa,
tak se musí text zkrátit. A radar vždy vycentrovat, případně zmenšit.
Vyřešit. Apka musí vypadat dobře.“ Snímek zachytil desktopový flex s
wrapem: cifernák a vysvětlení vedle sebe, ale panel Radar má jen
210–310 px, takže textu zbylo ~60–90 px a věty se lámaly slovo od
slova („Tě / mine. / Proletne / 21 km JV / od tebe, / nejbližší / …“).

Panel Radar nyní vede do sloupce jako na mobilu (kolo 8w fix4):
label s přepínačem Kompozit/ČHMÚ v jedné řádce nahoře (segment je
uvnitř labelu, přitisknutý k pravému okraji margin-left:auto — dřív
zabíral vlastní řádek), cifernák centrovaný margin auto a zmenšený
(86–120 px → 78–102 px, 10 vh, ať textu níž zbyde místo), verdikt,
vysvětlení a zdroj přes celou šířku panelu pod ním. Zalamování
bezpečné (overflow-wrap:anywhere + hyphens:auto), nic nepřeteče.

Málo místa = kratší text: vysvětlení radaru se zkrátila („Z tohohle
echa u tebe déšť nečekám“ → „Odsud déšť nečekej“, „Intenzitu takhle
daleko dopředu už neumím odhadnout“ → „Intenzitu dopředu
neodhadnu“, „se prakticky nepohybuje“ → „skoro stojí“, „nejbližší
průlet za“ → „nejbližší za“, „u tebe to odezní“ → „odezní“,
„neumím odhadnout“ zkráceno, rekonciliace „nejspíš se staví nová
buňka nad tebou“ → „nejspíš nová buňka nad tebou“). Informace
zůstávají, jen se věty vešly do šířky panelu.

Verze v rohu: v27; service worker v13. Testy: 155/155 (regrese 101:
+1 strukturní test kola 27; worker 54 nezměněn). Build 514 649 B.

## Kolo 26 — panel Kdy říká čas od modelů, přepínač Kompozit/ČHMÚ (21. 11.)

Dave (snímek PC verze, Jihlava): „Tohle mě vytáčí. Je tam 89 procent,
že zaprší, tak chci vědět kdy. Informace, že nic do hodiny je slabá.
Chci tedy říct, kdy to odhaduješ. Proč tam není to přepínání na ČHMÚ
radar. Podotykám, že se teď dívám na PC verzi.“ Snímek ukazoval
právě ten rozpor: verdikt nahoře 89 % („Téměř jistě zaprší“), shoda
8/10 agentur, modelové srážky ≥ 0,2 mm/h kolem 19:00 — a panel Kdy
odpovídal jen „Nic do hodiny. Radar v příští hodině nic nevidí.“

Panel Kdy: když pozorovací zdroje hodinového horizontu (radar,
minutecast) mlčí, ale modely mají SILNÝ signál za hranicí hodiny,
panel nyní řekne odhadovaný čas začátku: „od 19:00“ s podtitulem
„za ~5 h 25 min — shoda 8/10 (68 %), ~0,3 mm/h“. Prioritu má špička
agentur (ms.peak s předstihovou váhou, pravděpodobnost ≥ 50 %),
jinak tabulkový konsensus se stejným prahem 50 %. Práh 50 % drží
kolo 9c: osamocený model nesmí slibovat déšť. Mobilní
solo panel nese tentýž čas („déšť se blíží“ s „od 19:00“), takže
mobil i PC říkají totéž. Nový stav „later“ ve whenState.

Přepínač radaru Kompozit/ČHMÚ: vrací se jako segment v panelu Radar
(na PC i mobilu), bez rozkliknutí a bez skoku — přepnutí překreslí
jeden panel (v souladu s plynulostí kola 25), volba se
pamatuje v localStorage (bpRadarView). Stará jména z kola 14
zůstávají pohřbena (test kol 22 to hlídá); nová implementace používá
radView/radViewSeg/wireRadSeg/radseg. Pohled ČHMÚ kreslí
národní 1×1 km pole výrazně (PseudoCAPPI 2 km, forChmi=true), kompozit
zůstává jemný; elipsa buňky a trajektorie zůstávají v obou pohledech.
Přepínač se ukazuje jen s čerstvým snímkem ČHMÚ (≤ 45 min, stejné
pravidlo jako hlasování ve verdiktu) a v dosahu českého radaru;
jinak panel zůstává u kompozitu.

Verze v rohu: v26; service worker v12. Testy: 154/154 (99 + 1 nový
strukturní test kola 26 + 1 upravený test kola 25 + 1 rozšířené
okno testu kola 12 + upravený test kola 22 komentářem o nových
jménech; worker 54 nezměněn). Build 513 954 B.

## Kolo 25 — radar ČHMÚ v pohledu a plynulost všude (20. 11., Dave po zeleném startu)

Dave: „Tak a teď tam zase doděj ten ČHMÚ radar, jak jsme to měli
předtím naplánované. Zároveň chci, aby všechny pohyby v appce byly
plynulé a ne aby to skákalo. I úvodní načítání. Moderní app."

Radar ČHMÚ: plán z kola 15 konečně dopadl. Aplikace si od kola 15
čte národní snímek ČHMÚ (PseudoCAPPI 2 km, 1 km na pixel, výřez
±48 km) a počítá z něj pole — ale nakreslené nikdy nebylo, protože
kolo 22 na Daveův požadavek sundalo rozklikávací tlačítko a s ním
i kreslení. Kolo 25 kreslí čerstvé pole ČHMÚ do JEDINÉHO pohledu
výrazně přes jemný kompozit RainViewer (výraznější alfa, modř
podle pozice v oficiální škále); kompozit zůstává jemným pozadím,
takže obraz nezmizí za hranicí českého radaru. Zdrojový řádek
přiznává „pole radaru ČHMÚ 1×1 km, snímek X min". Rozklikávací
tlačítko se nevrací: přepínání pohledů bylo samo o sobě skokem.

Plynulost (bez skoků):
1. Clona: přechod opacity/visibility 0,35 s místo display:none/grid.
   Statické HTML startuje s viditelnou clonou — úvodní snímek je
   na obrazovce od prvního rámu, zavření i otevření se rozplývá.
2. Panely kompas, „za hodinu"/„do konce dne" i offline lišta
   vplouvají jemnou animací riseIn (0,35–0,45 s, respektuje
   prefers-reduced-motion).
3. Překreslení: kompas se překresluje po každém měření, ale stejný
   obsah se už nezapisuje (htmlIfChanged) — žádné probliknutí textu
   ani SVG, když se nic nezměnilo.
4. Nová verze aplikace (service worker): dřív okamžitý reload
   způsobil skok „starý web → nový web" uprostřed čtení. Reload
   nyní čeká, až aplikace půjde do pozadí; po návratu běží nová
   verze a nikdy pod rukama neskočila.

Badge v25; service worker v11 (bump vynutí aktualizaci i u
nainstalované PWA). 153/153 node testů (regresní 99, worker 54),
+ 1 nový browser test plynulosti v CI. Build 508 301 B.

## Kolo 24 — pravá příčina nalezena: rychlý start zabíjel celý skript (21. 11.)

Dave 21. 11. 13:28, snímek obrazovky (v23): „Start se nepovedl —
chyba: undefined is not an object (evaluating 'input.value =
place.name')“. Detektor havárie z kola 23 poprvé ukázal přesnou
příčinu a celý měsíc „beze změny“ je vysvětlený najednou.

Co se skutečně dělo: skript volal init() v půlce souboru (od kola
15). init() našel uloženou lokalitu (rychlý start, okno 24 h od
kola 18) a synchronně zavolal load(); ta zapsala název obce do
`input.value`, ale `var input = $("locInput")` je deklarované až
o stovky řádků níž a v tu chvíli ještě undefined. TypeError zabil
CELÝ skript od místa volání: žádná geolokace (proto „nežádá mě to
o polohu“), žádní posluchači, žádná data. Geolokace přitom celou
dobu fungovala; mrtvý skript se k ní jen nikdy nedostal. Proč to
nikdo nechytil: node testy load() nikdy nespouštěly, browser
fixture startovala bez uložené lokality — rychlá cesta do testů
vůbec nedorazila. Náhoda chtěla, že aplikace na desktopu startuje vždy ručně, takže se to projevovalo jen na Daveově iPhonu.

Oprava: init() se spouští jako syntakticky poslední příkaz
souboru (až za všemi deklaracemi), load() si dohledá pole obce
přímo s null pojistkou a browser test dostává volitelnou uloženou
lokalitu (fixture savedPlace), takže Daveův start je odteď v CI
trvale pokrytý. Pojistka havárie z kola 23 zůstává. Badge v24,
service worker v10 (vynutí aktualizaci i pozastavené PWA).
152/152 node testů; browser testy v CI.

## Kolo 23 — pojistka proti visícímu dotazu na oprávnění (klíč k mobilu) (21. 11.)
Dave 21. 11.: na mobilu běží v22 (badge potvrzen), Nastavení hlásí
„Při používání“, ale clona za 2 minuty nezměnila ani slovo; na
desktopu a v CI vše zelené. Jediné vysvětlení sedící na všechna
pozorování: WebKit na iOS nedořeší slib
navigator.permissions.query({name:"geolocation"}) — geoStart visí
před acquirePosition, žádný časovač kol 17/18 se nenasadí a clona
zůstane statická navěky.
Změny:
- geoPermQuery: dotaz na stav oprávnění dostává pojistku 3 s.
  Nedořeší-li se (nebo vyhodí-li výjimku), appka jede dál starou
  cestou: automatická žádost + hint po 10 s + pozorovatel po 17 s +
  hláška po 100 s. Start už nikdy nezamrzne na čekání na WebKit.
- havárie init() se nenechá mlčet: výjimka se vypíše na clonu
  („Start se nepovedl — chyba: …“), aby další hlášení z mobilu
  řeklo přesnou příčinu, ne jen „beze změny“,
- nápovědy clony (10 s, pozorovatel) nesou stav oprávnění
  ([kolo 23 · stav oprávnění: povoleno/zamítnuto/…]) — z mobilu tak
  vidíme, co systém skutečně hlásí,
- verze v rohu v23; service worker v8 → v9.
Testy: 2 nové (1 strukturní, 1 behaviorální — WebKit nechá dotaz
viset, pojistka spustí žádost), 4 testy kola 21 upraveny na novou
strukturu (geoPermQuery + timerové stuby), 3 kontexty kol 17b/18
dostaly geoPermTxt stub. Celkem 151/151. Build 503 691 B.
