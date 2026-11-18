# Analýza přesnosti předpovědí — sběr 6.–15. 11. 2026 (kolo 9)

Pravidelná analýza přesnosti aplikace „Bude pršet?" z dat sběrného Workeru.
Podklad pro kolo 9 (rotace ensemble, `rv.px`, `met.dz`); čísla ověřena
dvěma nezávislými implementacemi vyhodnocení (pandas i čistý Python),
klíčové kombinované verdikty přepočteny třetím skriptem na jednotné
pozorovací pravdě (METAR ∨ radar).

## 1. Rozsah dat a omezení

| Položka | Hodnota |
| --- | --- |
| Sběrné hodiny | 205 (2026-11-06 20:00 UTC až 2026-11-15 08:00 UTC) |
| Dílky / záznamy | 24 444 dílků, 20 189 záznamů s forecastem |
| Obce | 100 (každá 1× za hodinu, dílek po 5 min) |
| Chybějící zdroje | ens 15 581 (100 % kvóta 429), rv 763, met 131, fc 179 |
| Ground truth | METAR (r/i) ∨ radar medián mm/h ≥ 0,1; párování ±35 min |

Omezení interpretace:

- METAR měří na letišti 10–30 km od obce (horizontální posun pravdy).
- Radar měří odraz ve výšce kužele (700 m až 3 km podle vzdálenosti), ne
  u země: virga a bright band zkreslují obě strany pravdy.
- Ensemble za celé období chybí (HTTP 429 — sběrač vyčerpal kvótu, viz
  kap. 5), nebylo tedy možné vyhodnotit jej ani blend ens/om.
- 8,5 dne dat pokrývá jeden synoptický režim (zeměpisná šířka a terén
  mají malé podíly vzorků); roční chování nutno brát jako nejisté.

## 2. Minutecast (fc.m, 8 kroků po 15 min, horizont +2 h)

Párování kroku k s maximálnějbližšímu pozorování (±35 min), verdikt
„déšť" = mc ≥ 0,1 mm/h; truth = METAR r=1 ∨ rv.mm ≥ 0,1.

| Horizont (min) | n | POD | FAR | CSI | acc | bias |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 5 428 | 0,500 | 0,229 | 0,435 | 0,896 | 0,65 |
| 15 | 10 489 | 0,493 | 0,173 | 0,447 | 0,899 | 0,60 |
| 30 | 15 332 | 0,504 | 0,193 | 0,449 | 0,901 | 0,62 |
| 45 | 20 149 | 0,495 | 0,244 | 0,427 | 0,895 | 0,66 |
| 60 | 20 109 | 0,498 | 0,239 | 0,431 | 0,895 | 0,66 |
| 90 | 20 078 | 0,493 | 0,251 | 0,423 | 0,893 | 0,66 |
| 120 | 14 639 | 0,484 | 0,259 | 0,414 | 0,891 | 0,65 |

Závěry: minutecast je konzervativní (bias ~0,6–0,7, chybí mu ~polovina
událostí) s přijatelným FAR ~0,17–0,26 do 2 h; nejpřesnější je kolem
kroku 15–30 min. Hodnoty jsou kvantizované (0 → 0,1 mm/h), práh 0,05 by
neměl efekt. Plané poplachy okna 120 min (492 v jednotném přepočtu;
555 podle původního párování s radarem v čase vydání) jdou v 91 % případů
na radarově suché výchozí situaci (506 z 555) — nejde tedy o virgu
neexistujícího deště, ale o předzračnou advekci, kterou radar v čase
vydání ještě nevidí. Úniky naopak v 82 % vycházejí z radarově suchého
okamžiku vydání (1 606 z 1 948; déšť se vyvine nebo přadvekuje až po
vydání), v 15 % už radar mokrý a minutecast přesto mlčí (295).

## 3. Pravděpodobnost pp (Open-Meteo, bodová sémantika)

Brier skóre 0,0802 (n = 254 968 hodinových párů); v okně 0–2 h 0,0791
(n = 60 279).

Kalibrace (sloupec „skutečně" = podíl párů s deštěm):

| Koš pp | n | průměrná pp | skutečně |
| --- | ---: | ---: | ---: |
| 0–10 % | 186 351 | 0,006 | 0,035 |
| 10–20 % | 11 852 | 0,136 | 0,202 |
| 20–30 % | 7 693 | 0,238 | 0,275 |
| 30–40 % | 5 976 | 0,342 | 0,339 |
| 40–50 % | 5 493 | 0,441 | 0,406 |
| 50–60 % | 5 074 | 0,543 | 0,484 |
| 60–70 % | 5 157 | 0,643 | 0,507 |
| 70–80 % | 4 596 | 0,742 | 0,607 |
| 80–90 % | 4 758 | 0,843 | 0,649 |
| 90–100 % | 18 018 | 0,978 | 0,829 |

Přeceněná nahoře (90–100 % → ~83 %), podceněná dole (0–10 % → ~3,5 %).
Isotonická regrese (PAV) na těchto koších snižuje Brier
0,0802 → 0,0771 (n = 254 968).

Pozor na sémantiku: oknový verdikt „déšť do 8 h" (maximum pp v okně,
truth = déšť kdykoli v okně, n = 20 189, base rate 35 %) je naopak
PODCENĚNý uprostřed (OM max 30–40 % → ~58 % skutečně, Brier 0,123 →
0,109 po kalibraci). Bodová a oknová kalibrace se nesmí míchat ani
natvrdo zasazovat do verdiktního blendu — aplikace si musí nejprve
nasbírat vlastní vzorky (brierCalib per zdroj ens/om/mix/agree se učí
sama; potřebovala by opravený ensemble, viz kap. 5).

## 4. Kombinovaný verdikt v okně 0–2 h (jednotná truth, n = 20 189)

| Pravidlo | POD | FAR | CSI | acc | bias |
| --- | ---: | ---: | ---: | ---: | ---: |
| jen minutecast ≥ 0,1 | 0,564 | 0,153 | 0,512 | 0,872 | 0,666 |
| jen pp ≥ 50 % | 0,628 | 0,186 | 0,550 | 0,877 | 0,772 |
| pp ≥ 50 % NEBO mc ≥ 0,1 (OR) | 0,707 | 0,216 | 0,592 | 0,884 | 0,902 |
| pp ≥ 50 % A mc ≥ 0,1 (AND) | 0,485 | 0,095 | 0,462 | 0,865 | 0,536 |
| pp ≥ 30 % | 0,727 | 0,241 | 0,591 | 0,880 | 0,958 |

OR pravidlo dává nejlepší CSI (0,592) a vyrovnaný bias (0,90) za cenu
FAR 0,216; alternativní cesta přes pouhé snížení prahu pp na 30 % dává
srovnatelné CSI, ale horší FAR, acc i bias. V appce je záměr OR ale již
z velké části kryt blendem + stanice/radar solo potvrzením (kolo 8v/8x);
zasazovat jej znovu bez vlastních vzorků appky by bylo dvojité počítání.

## 5. Kde selhává: radar vs METAR

| Srovnání | n |
| --- | ---: |
| METAR déšť a radar sucho | 2 306 (82,6 % metarových dešťů!) |
| METAR déšť a radar mokro | 487 |
| METAR sucho a radar mokro | 377 |
| METAR sucho a radar sucho | 15 601 |

Radar (medián z 3×3 pixelů, práh 0,1 mm/h) je ke skutečnému dešti u
stanice téměř nedefenzibilní jako samostatná pravda: nejhůře dopadá
Jihách (Terst 68, Rijeka 66, Portorož 72 případů), což odpovídá
advekční mlze/mrholení pobřeží a radarovým mezerám mimo pokrytí. Tomu
odpovídá i rozpad podle terénu (minutecast okno 60 min):

| Terén | obcí | POD | FAR | Brier pp 0–2 h |
| --- | ---: | ---: | ---: | ---: |
| nížina | 71 | 0,53 | 0,16 | 0,073 |
| pobřeží | 18 | 0,60 | 0,29 | 0,099 |
| hory | 11 | 0,45 | 0,19 | 0,085 |

Podle zeměpisné šířky je minutecast nejpřesnější v pásu 45–50°
(POD 0,58, FAR 0,14); pod 45° (Jihy, 7 obcí) FAR 0,43 — středomořské
přeháňky model 15min nowcastem nevyřeší.

Z toho plyne pořadí spolehlivosti zdrojů v horizontu 0–2 h na tomto
režimu: minutecast (nowcast radaru) > pp (globální model, bodově
přeceněný) >> radar jako samostatný svědek. Ensemble nevyhodnotitelný
(kvóta); jeho obnova je proto prvním předpokladem jakékoli další
kalibrace.

## 6. Proč sběrač spálil kvótu, a co s tím kolo 9 dělá

Jeden ensemble dotaz nese 9 bodů mřížky (3×3) a Open-Meteo ho počítá
jako 9 volání denní kvóty: 9 × 100 obcí × 24 h = 21 600 volání/den nad
limit 10 000 → každý ens požadavek končil 429. Sběrač tak (a) nemá jediný
ens vzorek pro vyhodnocení a (b) přebíral kvótu i appce: uživatelé trvale
viděli „Shodu modelů" místo „Pravděpodobnosti deště" a brierCalib nikdy
nedostal vzorky ens/mix.

Kolo 9 zavádí rotaci `ENS_ROT_HOURS` = 2, 5, 8, 11, 14, 17, 20, 23 UTC:
9 × 100 × 8 = 7 200 volání/den, ~2 800 zůstává appce. Horizont ens 9 h
při rotaci po 3 h pokrytí neprotrhne. Dále sběrač ukládá `rv.px` (9 surových
dBZ, null = bez odrazu; práh 10 dBZ a medián jinak slabá echo zamaskují)
a `met.dz` (příznak mrholení z METAR jevů) — až po 14 dnech nových dat
bude možné vyhodnotit virgu/mrholení proti surovým pixelům a překalibrovat
pp na vlastních datech appky.

## 7. Co z analýzy NEbylo zasazeno do appky, a proč

- OR pravidlo do verdiktu: záměr (PPD + potlačení planých poplachů mixem)
  blend a solo potvrzení již kryjí; bez vlastních verdiktních vzorků
  appky hrozí dvojité počítání a rozvázání blendu kola 8z3.
- Tvrdá kalibrační tabulka pp: dvě neslučitelné sémantiky (bodová vs
  oknová, viz kap. 3); brierCalib se naučí tu správnou sám, až ens
  pojede.
- Práh minutecastu 0,05 mm/h: data nemají hodnoty mezi 0 a 0,1
  (kvantizace zdroje) — změna by byla mrtvá.
- Doporučení již implementovaná v appce dříve: „METAR déšť přepíše
  radarové jasno" (kolo 8v, stanice ≤ 25 km, beamNote) a mrholení v UX.

Čísla v tomto dokumentu odpovídají `results.json` z 15. 11. 2026
(scripts: analysis.py, verify.py, combined_verdict.py, diagnostics.py).
