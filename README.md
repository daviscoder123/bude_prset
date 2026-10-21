# Bude pršet?

Jednoobrazovková webová aplikace pro rychlou odpověď na jedinou otázku: **bude v příštích 8 hodinách pršet?**

Srovnává hodinové předpovědi srážek ze špičkových globálních modelů (ECMWF, NOAA GFS, DWD ICON, Météo-France, UK Met Office, GEM, JMA) a automaticky přidává **národní/regionální model** podle vybrané země. Na pozadí čte **meteoradar** (globální kompozit RainViewer / OPERA) přímo v místě obce a zpřesňuje minutový odhad začátku deště.

## Funkce
- vyhledávání obcí a adres po celém světě (GeoNames + OpenStreetMap)
- matice model × hodina s intenzitou srážek v mm/h
- řádek shody modelů a celková pravděpodobnost deště
- „Kdy začne pršet" — minutový odhad z radaru a konsenzu modelů
- automatická aktualizace každých 15 minut, **pouze když je aplikace viditelná** (na pozadí nulová aktivita — šetří baterii i mobilní data)
- PWA: lze přidat na plochu telefonu, bez webfontů, s vestavěnou cache

## Nasazení na GitHub Pages
1. Vytvoř nový veřejný repozitář (např. `bude-prset`).
2. Nahraj do něj všechny soubory z této složky (`index.html`, `manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png`, `README.md`).
3. V repozitáři otevři **Settings → Pages**, v sekci *Build and deployment* zvol **Deploy from a branch**, větev `main` a složku `/ (root)`. Ulož.
4. Za chvíli poběží aplikace na `https://TVOJE-JMENO.github.io/bude-prset/`.

## Přidání na plochu telefonu
- **Android (Chrome):** otevři adresu aplikace → menu ⋮ → **Přidat na plochu** (nebo *Instalovat aplikaci*).
- **iPhone (Safari):** otevři adresu → tlačítko sdílení → **Přidat na plochu**.

## Zdroje dat
- předpovědi a geokódování: [open-meteo.com](https://open-meteo.com) (CC BY 4.0)
- záložní geokódování: [Photon](https://photon.komoot.io) a [OpenStreetMap Nominatim](https://nominatim.org)
- radar: [RainViewer](https://www.rainviewer.com/api.html)
- reverzní geokódování polohy: [BigDataCloud](https://www.bigdatacloud.com)

Bez API klíčů, bez sledování, bez reklam.

## Časy a původ aktuálních dat

Hodinové časy se z Open-Meteo načítají jako Unix timestampy a interně zůstávají v UTC. Tabulka, začátek a konec deště používají časové pásmo vybrané lokality včetně změn letního času; údaj „u tebe“ zobrazuje tentýž okamžik v pásmu zařízení.

Open-Meteo `current` a 15minutové řady jsou modelová data, nikoli další nezávislá pozorování. Do potvrzení aktuálního deště ani do intenzity označené jako ověřená se nezapočítávají jako měření; `current.precipitation` se převádí z mm za `current.interval` sekund na mm/h. Chybějící nebo neplatné jednotky či interval znamenají neznámou intenzitu, ne nulu. Viz [dokumentace Open-Meteo](https://open-meteo.com/en/docs).

Při každém načtení lokality se předchozí stav odstraní. Nová předpověď a doplňkové zdroje mohou měnit výsledek jen v aktuální generaci požadavků; načítání nebo výpadek nesmí zobrazit data jiné lokality.

## Vývoj a testy

Aplikace stále běží jako statický HTML soubor, bez sestavení a bez runtime npm závislostí. Node.js 20+ slouží pouze pro testy:

```sh
npm ci
npm test
npx playwright install --with-deps chromium
npm run test:browser
```

Jednotkové testy používají přímo funkce ze zdrojového HTML a ověřují časová pásma, přechody letního času, jednotky srážek, reset stavu a rozdíl mezi modely a pozorováním. Prohlížečové testy spouštějí lokální server, používají řízené API odpovědi a kontrolují hledání, geolokaci, mobilní zobrazení, opožděné odpovědi, selhání i záložní modely; neověřují dlouhodobou meteorologickou přesnost ani dostupnost externích služeb.
