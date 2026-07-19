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
- záložní geokódování: [OpenStreetMap Nominatim](https://nominatim.org)
- radar: [RainViewer](https://www.rainviewer.com/api.html)
- reverzní geokódování polohy: [BigDataCloud](https://www.bigdatacloud.com)

Bez API klíčů, bez sledování, bez reklam.
