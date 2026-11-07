# Architektura — jak vzniká verdikt „Bude pršet"

Tento dokument popisuje, **jak aplikace počítá**, ne jak vypadá. Pro rychlý přehled
stačí [README](../README.md); zde je kompletní výklad rozhodovací pipeline, prahů,
pravděpodobností, učení z vlastních měření, sběrače dat i měření přesnosti.

Obsah:

1. [Velký obraz](#1-velký-obraz)
2. [Zdroje dat](#2-zdroje-dat)
3. [Práh srážek — kdy se řekne „prší"](#3-práh-srážek--kdy-se-řekne-prší)
4. [Verdikt „Kdy začne pršet" — blend osy](#4-verdikt-kdy-zacne-prset--blend-osy)
5. [Pravděpodobnosti](#5-pravděpodobnosti)
6. [Učení z vlastních měření](#6-učení-z-vlastních-měření)
7. [Sběrač dat (Worker)](#7-sběrač-dat-worker)
8. [Měření přesnosti a grafika](#8-měření-přesnosti-a-grafika)

---

## 1. Velký obraz

Aplikace je jedna obrazovka a jedna otázka: *v příštích 8 hodinách zaprší?*
Odpověď se skládá ze tří vrstev, které se navzájem kontrolují:

```mermaid
flowchart TB
    subgraph POZOROVANI["Pozorování (co se děje teď)"]
        R["Radar RainViewer / OPERA<br>advekce vlastní + nowcast"]
        C["ČHMÚ radar (CZ)<br>PseudoCAPPI 2 km"]
        S["Satelit EUMETSAT<br>IR ochlazování vrcholů"]
        M["METAR stanic<br>letová zpráva = pozorování"]
    end
    subgraph PREDPOVED["Předpověď (co přijde)"]
        G["Globální modely<br>ECMWF, GFS, ICON, ARPEGE,<br>UM, GEM, JMA…"]
        N["Národní model<br>ALADIN ČHMÚ, AICON…"]
        E["Ensemble<br>20–51 běhů, NEP 3×3 body"]
        O["Nowcasty<br>Open-Meteo 15 min, met.no,<br>RADVOR, RainViewer"]
    end
    B["Blend osy<br>vážený medián časů příchodu<br>+ naučené váhy"]
    V["Verdikt<br>„za 23 min · slabý déšť<br>mezi 18. a 31. minutou“"]
    P["Pravděpodobnost<br>ensemble NEP + Brier kalibrace<br>→ 73 %"]
    B --> V
    E --> P
    POZOROVANI --> B
    PREDPOVED --> B
    P -.kontroluje.-> V
```

Zásada, která se táhne celým kódem: **nic se netvrdí z jednoho zdroje**. Radar
potvrdí déšť sám, jen je-li echo vydatné a čerstvé přímo nad obcí; stanice
potvrdí déšť sama do 25 km, jinak až se souhlasem modelu; pravděpodobnosti se
kalibrují proti METAR pozorováním, která si aplikace ověří sama.

## 2. Zdroje dat

| Zdroj | Co dává | K čemu se používá |
| :--- | :--- | :--- |
| Open-Meteo `models` API | hodinové srážky v mm/h ze ~17 globálních modelů | matice model × hodina, konsenzus, blend |
| Národní/regionální model | nejvyšší rozlišení pro dané území (ALADIN ČHMÚ pro CZ) | první řádek tabulky, hlas blendu |
| Open-Meteo ensemble | 20–51 běhů téhož modelu s rozhozeným startem, 3×3 body ~±11 km | pravděpodobnost (NEP), čas příchodu, šance do N minut |
| Open-Meteo `current` + `minutely_15` | aktuální modelové počasí, 15minové srážky | nowcast do 60 min (POZOR: model, ne pozorování) |
| RainViewer / OPERA | globální meteoradar, 10-min snímky | advekce pole, radarový kompas, „prší teď" |
| ČHMÚ radar | PseudoCAPPI 2 km, 1×1 km, snímek každých 5 min | nezávislé potvrzení, hlas do blendu |
| DWD RADVOR, KNMI, met.no | národní radarové nowcasty | nejhustší extrapolace srážek |
| EUMETSAT (IR 10,8 µm) | satelitní infračervený kanál (`msg_fes`/`msg_iodc`) | ochlazování vrcholů mraků = konvekce dřív než radar |
| GPM IMERG (NASA GIBS) | satelitní srážky v mm/h (půlhodinový produkt, ~5–7 h starý) | kompas mimo dosah radarů |
| METAR (aviationweather) | oficiální pozorování stanic | ground truth pro učení i měření přesnosti |
| GeoNames / Photon / Nominatim, BigDataCloud | geokódování, reverzní poloha | vyhledávání obcí |

Veškeré API jsou veřejné a bez klíčů. Hlavní objemy (předpovědi, ensemble) jdou
přes edge proxy na Cloudflare Workers — jeden dotaz na uživatele místo série,
cache sdílená všemi uživateli ([`worker/README.md`](../worker/README.md)).

## 3. Práh srážek — kdy se řekne „prší"

Všechny rozhodnutí pracují s **prahem intenzity**, ne s binárním „ano/ne" z
modelu. Práh není konstanta, ale funkce dvou vlivů (`threshFor`):

- **Zeměpisná šířka:** v tropech (do ~15°) je práh **1,0 mm/h**, v mírném pásu
  (od ~25°) **0,2 mm/h**, mezi nimi lineární interpolace. Důvod: globální modely
  rozmazávají konvekci do velkých ploch slabého deště — bez tropického prahu by
  aplikace v Jakartě hlásila déšť prakticky neustále.
- **Konvekce (CAPE):** mezi 400 a 2000 J/kg se práh zvyšuje od základní hodnoty
  k tropické. Konvektivní déšť je skvrnitý — model, který takový režim hlásí,
  právem vyžaduje silnější signál, aby se hlásil slabý mrholení.
- Výsledný práh je **maximum** obou vlivů, se stropem 1,0 mm/h.

Dva prahy se zásadně netykají: `THRESH_OBS` (0,2 mm/h) — pozorování se nikdy
nepřepne na zvýšený práh, protože METAR a radar nepodléhají modelovému rozmazání;
`THRESH_END` (0,12 mm/h) — konec deště se pozná i při doznívajícím mrholení.

## 4. Verdikt „Kdy začne pršet" — blend osy

Čas příchodu deště nespočítá jeden model — spočítá ho **blend pozorovacích
extrapolací a modelů** (`buildBlendTimeline`). Každý zdroj nabízí svůj odhad
„déšť dorazí za X minut" a vstupuje s váhou, která exponenciálně klesá s
horizontem: pozorování vládnou první hodinu, modely přebírají slovo dál.

| Zdroj blendu | Váha v čase t (minuty dopředu) | Proč zrovna tak |
| :--- | :--- | :--- |
| vlastní advekce z radarových dlaždic | `e^(−t/40)` | čerstvé pole nad obcí je nejpřesnější, ale rychle stárne |
| nowcast RainViewer | `0,85·e^(−t/55)` | cizí optical flow, o krok méně jistý než vlastní čtení |
| národní nowcast (RADVOR, KNMI) | `0,90·e^(−t/85)` | 5min snímky, kalibrace na srážkoměry — drží nejdéle |
| met.no nowcast | `0,80·e^(−t/70)` | radarový, mm/h přímo |
| regionální nowcast | `0,55·e^(−t/90)` | asimiluje radar i stanice, vidí i vznikající buňky |
| Open-Meteo 15 min nowcast | doplněk do 1 | zbytek po pozorovacích zdrojích |
| hodinový konsenzus modelů | `min(0,35; t/60·0,35)` | modelům se věří pomalu rostoucí váhou |
| **ensemble (čas příchodu)** | `0,35·e^(−t/150)` | 20–51 běhů = nejhustší statistika *času*, ne intenzity |

Z odhadů se váhy vynásobí, spočítá **vážený medián** = hlášený čas příchodu.
Rozptyl mezi zdroji dá interval „mezi N. a M. minutou" — nepřesnost se nepřehazuje
pod koberec, zobrazuje se.

**Kontrolní hlasy pozorování:**

- Radar potvrdí déšť sám (čerstvé, vydatné echo přímo nad obcí) — jinak v suchu
  hlásí snížení, i když modely prší.
- ČHMÚ hlasuje svým PseudoCAPPI: souhlasí-li snímek s odhadem (déšť nyní ±5 min,
  nebo první echo ±30 min od predikce), blend se přitáhne k němu.
- Satelit: výrazné ochlazování vrcholů (K/min) je znak konvekce dřív, než ji
  radar uvidí — důvěryhodný satelit dostává hlas v blendu.
- Stanice potvrdí déšť sama do 25 km, jinak až se souhlasem modelu.
- Prší-li, verdikt se přepne z „Déšť od" na „Déšť do" s odhadem konce
  (práhu konce 0,12 mm/h).

**Konvektivní prior:** v režimu přeháněk (konvektivní zlomek > 0,5) extrapolace
radar buňky, které teprve vzniknou, nevidí — dokud učení nemá vlastní vzorky,
váhy pozorovacích zdrojů klesnou (radar ×0,70, nowcasty ×0,80–0,90) a modely se
posílí (×1,5). Jakmile se pro daný zdroj a režim nahromadí vlastní měření, prior
ustupuje a přebírají naučené křivky.

## 5. Pravděpodobnosti

Aplikace nikdy neukáže „50 %" bez rozmyslu — rozlišuje, **čí** procento to je:

- **Hlavní číslo (hero %):** ensemble NEP — podíl členů, které v některém bodě 3×3
  mřížky (~±11 km) vyprší nad prahem. Kalibruje se Brierovou křivkou per zdroj
  (viz §6), výsledek se ořízne do 2–98 %. Bez ensemblu se místo pravděpodobnosti
  zobrazí „shoda modelů" — a jasně to říká: podíl modelů není pravděpodobnost.
- **Pravděpodobnost verdiktu:** `verdictProb` — ensemble je podkladem a
  Open-Meteo ho **nikdy nesníží**; hlásí-li OM více, jde verdikt jen na
  **polovinu cesty** k němu: `max(ens; (ens+om)/2)` (kolo 8z3: na 726 oknových
  párech falešné poplachy 30→11, úspěšnost 91,3→92,6 %, Brier 0,0593→0,0579).
  Bez obou zdrojů zůstane škála podle počtu souhlasících modelů (2 zdroje = 0,7,
  ani ne „skoro jistě").
- **„Šance do N minut":** procento členů ensemblu, jejichž čas začátku spadá do
  hlášeného rozpětí — vztahuje se k tomu, co věta slibuje, ne k celému oknu.
- **„V obci vs. někde do ~11 km":** při konvekci rozdíl desítky procent bodů
  (přeháňka nemusí trefit bod) — při rozdílu ≥ 10 p.b. se ukazují obě čísla.

## 6. Učení z vlastních měření

Aplikace se učí ze skutečných pozorování (METAR, radar) třemi
nezávislými mechanismy, vše v localStorage/IndexedDB uživatele:

1. **Brierova fronta a kalibrace procent.** Každý vyslovený verdikt jde do fronty
   se zdrojem (ensemble / Open-Meteo / shoda); po `BRIER_MIN_BIN` ověřených
   vzorcích v binu se z křivky „hlášené % → reálně %" stává kalibrace, která
   ohýbá zobrazovaná procenta k realitě. Do fronty jde **surový** prediktor —
   kalibrace se nesmí učit na vlastním výstupu.
2. **Naučené váhy blendu.** Pro každou zemi, horizont (30/45/60 min), zdroj a
   režim (frontální × konvektivní) se vede EMA log-poměru „co zdroj tvrdil /
   co METAR změřil". Nadhodnocující zdroj slábne, podhodnocující sílí; při
   málo vzorcích se vliv smrští k nule (`n/(n+15)`) a extrémy drží clamp
   ⟨0,5; 1,5⟩. Řídké používání aplikace tedy nic nepokazí.
3. **Bias modelů per lokalita.** Poslední log-poměry každého modelu pro dané
   místo (max 40 míst) korigují zobrazované intenzity.

## 7. Sběrač dat (Worker)

Bez sběru historie nelze měřit ani učit. Worker na Cloudflare proto sbírá data
pro **100 evropských obcí** každých 5 minut:

```mermaid
flowchart LR
    CRON["cron */5 min"] --> SL["12 dílků / hod<br>round-robin 100 obcí"]
    SL --> F["Open-Meteo<br>fc (pp, 15 min)"]
    SL --> E2["ensemble<br>3×3 body"]
    SL --> MET["METAR bulk<br>(1 dotaz na dílek)"]
    SL --> RV["radar RainViewer<br>PNG dekód ve Workeru"]
    F & E2 & MET & RV --> KV["KV: raw/RRRRMMDDHH:mm<br>TTL 14 dní"]
    KV --> AN["/analysis<br>/analysis/page?h=…<br>/analysis/status"]
    AN --> GFX["Grafy přesnosti<br>(denní workflow)"]
```

- **Klíč** `raw/YYYYMMDDHH:mm`, TTL 14 dní — plné okno pro zpětná testování.
- **METAR:** hromadný dotaz na celý dílek (1 subrequest), zpráva se parsuje
  včetně pravidla z opravy #23 — jevy z trendových skupin TEMPO/BECMG (předpověď
  vývoje, ne pozorování) se do aktuálního počasí nezapočítávají.
- **Radar:** PNG dlaždice se dekóduje přímo ve Workeru (bez canvasu), medián
  mm/h z 3×3 pixelů kolem obce = druhý svědek ground truth tam, kde METAR chybí.
- Endpointy `/analysis` (dashboard), `/analysis/page?h=YYYYMMDDHH` (export
  celé hodiny), `/analysis/status` (aktuálnost).

Podrobnosti nasazení a testy: [`worker/README.md`](../worker/README.md).

## 8. Měření přesnosti a grafika

Skript [`scripts/accuracy_charts.py`](../scripts/accuracy_charts.py) stahuje
sběračem nashromážděná data, skládá **páry** „předpověď × pozorování" a kreslí
grafy do `docs/graphics/`:

- **pár** = pravděpodobnost Open-Meteo pro hodinu H+k z hodiny H proti
  pozorování v hodině H+k, k = 0…12;
- **ground truth** = METAR místa (jevy z hlavního těla zprávy, vždy s pravidlem
  #23 — parser se spouští znovu na raw text, takže starší záznamy z doby před
  opravou se hodnotí korektně), chybí-li METAR, radar > 0,05 mm/h;
- **metriky:** úspěšnost na prahu 50 % a Brierovo skóre, celkem i podle
  horizontu, desetin pravděpodobnosti a dnů.

Workflow **Grafy přesnosti** (`.github/workflows/graphics.yml`) běží denně,
grafy a badge `stats.json` commituje do main — README tedy vždy ukazuje
aktuální naměřenou přesnost, ne marketingový údaj. Worker nedostupný nebo data
prázdná nezakládají issue: grafy zůstávají z posledního úspěšného běhu.

## 9. Zdraví zdrojů a proxy ČHMÚ (kolo 8ba)

Každý datový zdroj v kódu musí skutečně fungovat — proto proběhl živý audit
všech modulů. Stav po kole 8ba:

| Modul | Stav | Co se změnilo |
| :--- | :--- | :--- |
| Blitzortung (blesky) | ✅ živý | WebSocket zrcadla ws1/ws2/ws8 (ws7 neodpovídá) |
| ČHMÚ radar | ✅ živý | přes edge proxy (CORS), předpověď z TAR archivů |
| EUMETSAT IR | ✅ živý | vrstvy `msg_fes`/`msg_iodc` + syntetická šedá škála |
| GPM IMERG | ✅ živý | nová vrstva `IMERG_Precipitation_Rate_30min` + paleta mm/h |
| NASA GIBS (rgb/kelvin) | ⛔ vypnuto | GIBS zrušil colormap XML — dekód nelze poctivě provést |

**ČHMÚ:** Online publikace radarových snímků nemá CORS hlavičky, takže
`canvas` v prohlížeči nemůže snímek přečíst. Kompozit i legenda proto jdou
přes edge proxy (`/chmi/img` s whitelistem `/meteorology/weather/radar/*.png`),
která přidává `Access-Control-Allow-Origin: *` a kešuje (kompozit 120 s,
legenda 24 h). Předpověď +10…+60 min ČHMÚ už nepublikuje jako PNG, ale jako
TAR archiv všech kroků — Worker ho stáhne podle času výpočtu a vybalí jen
potřebný člen (`/chmi/fct`, `tarFindMember`, keš 240 s). Změnila se i legenda
(`scl-dbz-mmh.png`): jde o paletové PNG, ze kterého se škála extrahuje skenem
sloupců (barvy pod 70 RGB a průhledné vynechány), deduplikací a otočením
pořadí na slabé→silné.

**EUMETSAT:** původní vrstvy `meteosat:msg_rss_*` EUMETSAT vyřadil; dnes
běží `msg_fes:ir108` a `msg_iodc:ir108`. Kanál je šedotón, takže se ordinály
(0 = teplo, 1 = studeno) počítají proti škále 16 odstínů. Staré endpointy
legendy už vrací jen ikonu 20×20 px — proto škála padá na syntetickou
rovnoměrnou stupnici, u které fyzikální jednotky stejně nepotřebujeme:
pracuje se s ordinály, ne kelviny.

**GIBS:** satelitní rgb/kelvinové dlaždice NASA publikovala vždy bez hodnot —
barvy se musely dekódovat přes colormap XML, které GIBS zrušil (404 u všech
vrstev GOES/Himawari v cmap v1.0 i v1.3). Bez palety nelze z pixelů poctivě
vydělat kelviny, takže modul není tiše rozbitý, ale vypnutý s vysvětlením
(`satState = "off"`); tělo kódu zůstává pro případ, že NASA palety vrátí.

**IMERG:** NASA přejmenovala datovou vrstvu na `IMERG_Precipitation_Rate_30min`
a její paletu na `GPM_Precipitation_Rate`. Na rozdíl od IR jde o skutečné
milimetry za hodinu (220 položek, 0,1–53,1 mm/h) — validace rozsahu v
`parseImergPalette` nepustí paletu v jiné veličině. Dekódovaná intenzita se
pro kompas převádí na pseudodBZ inverzním Marshallovým–Palmerovým vztahem,
aby korelace pohybu pracovala ve stejné škále jako radar. IMERG nikdy
nehlasuje do blendu ani do verdiktu — je to jen kompas tam, kde radary
nedosáhnou (oceány, pouště), s latencí ~5–7 h.

## 10. Sníh (kolo 8bb)

Aplikace pozná sníh z pěti nezávislých stop a teď o něm i mluví:

1. **radar** — RainViewer nese v pixelu bit 128 „sníh“;
2. **METAR** — jevy se sněhem (SN = sněžení; PL/IC = zmrzlý déšť; kroupy
   GS/GR a bouřka TS se hlásí zvlášť);
3. **modely** — hodina je „sněhová“, když `snowfall` ≥ 50 % celkových srážek
   (`isSnow`), úhrny se převádějí na vodní ekvivalent (1 cm ≈ 0,7 mm);
4. **ensemble** — snow příznak přes 3×3 bodovou mřížku;
5. **sněhová čára** — `freezing_level_height` z hourly dotazu
   (`snowLineAt`), zaokrouhlená podle srozumitelnosti (pod 1000 m po
   50 m, nad ní po 100 m).

**Verdikt** se přepne na sněhový, když ≥ 50 % mokrých modelů v hodině
vrcholu hlásí sníh (`snowShareAtPeak`), nebo když pozorovaný stav (radar,
METAR) sníh potvrzuje. Pak se všechny texty přizpůsobí: „Pravděpodobnost
sněžení do N h“, „Sněžení do / Sníh od“ v liště, pill „sníh se blíží“,
intenzita v **cm/h** místo mm/h a u probíhajícího sněžení souhrn
„napadne ~X cm“ během zbytku okna. Suchý stav o sněhu neumlčí: pokud
modely na sníh souhlasí, výklad mluví o „pravděpodobnosti sněžení během N
hodin“ a uvádí sněhovou čáru. Pozadí k sněhu přidává řídké tlumené vločky
(`soonSnow`), na mobilu s poloviční hustotou; `prefers-reduced-motion`
je respektuje stejně jako déšť.

---

Historii jednotlivých „kol" vylepšení shrnuje [CHANGELOG](CHANGELOG.md).
