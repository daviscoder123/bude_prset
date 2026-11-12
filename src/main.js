
"use strict";
/* ===== 7 globálních modelů ===== */
var MODEL_POOL = [
  {id:"ecmwf_ifs025",         n:"ECMWF IFS",  ns:"IFS",    a:"Evropské centrum (EU)",     hl:51.4, hg:-0.9,  fam:"ECMWF",      cc:"EU"},
  /* AIFS — ML model ECMWF na stejné open-date mřížce (0,25°) jako IFS,
     ale vlastní rodina (fam), aby ho deduplikace "jedna agentura = jeden
     řádek" neodstranila jako dvojkartu IFS. Patří do okna modelů jako
     další řádek — je to jiný model, ne jiný výpočet téže analýzy. */
  {id:"ecmwf_aifs025_single", n:"ECMWF AIFS", ns:"AIFS",   a:"ML model ECMWF · 0,25°",    hl:51.4, hg:-0.9,  fam:"AIFS",      cc:"EU"},
  {id:"gfs_seamless",         n:"NOAA GFS",   ns:"GFS",    a:"Národní met. služba USA",   hl:38.9, hg:-77.0,  fam:"NOAA",       cc:"US"},
  {id:"icon_seamless",        n:"DWD ICON",   ns:"ICON",   a:"Německá met. služba",       hl:50.1, hg:8.7,    fam:"DWD",        cc:"DE"},
  /* AICON — AI předpověď DWD na globální mřížce (~13 km). Stejný trik jako
     u AIFS: vlastní rodina (fam), aby ho deduplikace "jedna agentura = jeden
     řádek" nesebrala jako dvojkartu ICONu. AI model má JINÉ chyby než
     fyzikální (umí skvrny lépe položit, ale občas si vymyslí vítr) —
     právě proto je jeho srovnání s ICONem nejcennější, a to jen když zůstane
     samostatný řádek.
     POZOR NA ID: správné id open-meteo je "dwd_aicon_global_native".
     Neexistující id v models= neshodí jen jeden řádek, jak jsem dřív
     čekal — open-meteo vrátí HTTP 400 pro CELÝ dotaz ("Cannot initialize
     MultiDomains from invalid String value") a appka nezobrazí nic.
     Přesně to se stalo 29. 10. 2026 s id "aicon_global": všech 17 modelů
     najednou vrátilo chybu, a protože neplatné id leželo i v nouzovém
     základu MODELS, shodilo i záchranné druhé volání — kompletní výpadek
     dat. Snowfall AICON umí taky (API ho pro něj vrácí), takže sdílený
     dotaz hourly=precipitation,snowfall projde v pořádku. */
  {id:"dwd_aicon_global_native", n:"DWD AICON", ns:"AICON", a:"AI model DWD · ~13 km",    hl:50.1, hg:8.7,    fam:"AICON",      cc:"DE"},
  {id:"meteofrance_seamless", n:"Météo-France", ns:"Météo", a:"ARPEGE / AROME",            hl:43.6, hg:1.4,    fam:"MeteoFrance",cc:"FR"},
  {id:"ukmo_seamless",        n:"UK Met Office", ns:"UKMO",  a:"Britská met. služba",       hl:50.7, hg:-3.5,   fam:"UKMO",       cc:"GB"},
  {id:"knmi_seamless",        n:"KNMI",          ns:"KNMI",  a:"Nizozemská met. služba",    hl:52.1, hg:5.2,    fam:"KNMI",       cc:"NL"},
  {id:"dmi_seamless",         n:"DMI",           ns:"DMI",   a:"Dánská met. služba",        hl:55.7, hg:12.6,   fam:"DMI",        cc:"DK"},
  {id:"metno_lf", special:"metno", n:"MET Norway", ns:"MET", a:"Norský met. institut · celosvětově", hl:59.9, hg:10.7, fam:"METNO", cc:"NO"},
  {id:"gem_seamless",         n:"GEM",           a:"Environment Canada",        hl:45.5, hg:-73.6,  fam:"ECCC",       cc:"CA"},
  {id:"jma_seamless",         n:"JMA",           a:"Japonská met. agentura",    hl:35.7, hg:139.7,  fam:"JMA",        cc:"JP"},
  {id:"kma_seamless",         n:"KMA",           a:"Korejská met. správa",      hl:37.5, hg:127.0,  fam:"KMA",        cc:"KR"},
  {id:"cma_grapes_global",    n:"CMA GRAPES", ns:"CMA",     a:"Čínská met. správa",        hl:39.9, hg:116.4,  fam:"CMA",        cc:"CN"},
  {id:"bom_access_global",    n:"BOM ACCESS", ns:"BOM",     a:"Australský met. úřad",      hl:-37.8,hg:145.0,  fam:"BOM",        cc:"AU"},
  /* Doménové modely, NE "seamless": geosphere_seamless po 2,5 dne přechází na
     ECMWF IFS, takže by mimo Rakousko tiše duplikoval řádek ECMWF a předstíral
     shodu dvou nezávislých agentur. Mimo svou doménu tyto modely prostě
     nevrátí data a aplikace je vyfiltruje. */
  {id:"meteoswiss_icon_ch2",      n:"MeteoSwiss ICON-CH2", ns:"ICON-CH2", a:"Švýcarská met. služba · 2 km", hl:46.9, hg:7.4,  fam:"MeteoSwiss", cc:"CH"},
  {id:"geosphere_arome_austria",  n:"GeoSphere AROME",     ns:"AROME",   a:"Rakouská met. služba · 2,5 km",hl:48.2, hg:16.4, fam:"GeoSphere",  cc:"AT"}
];
var MODELS = MODEL_POOL.slice(0,8); /* nouzový základ */
function pickModels(cc, lat, lon){
  var reg = regionalFor(cc);
  var chosen = [];
  var usedFam = {};
  if(reg){
    chosen.push({id:reg.id, n:reg.n, ns:reg.ns, a:reg.a, national:true, fam:reg.fam, cc:cc});
    usedFam[reg.fam] = true;
  }
  var sorted = MODEL_POOL.slice().sort(function(a,b){
    return distKm(lat,lon,a.hl,a.hg) - distKm(lat,lon,b.hl,b.hg);
  });
  for(var i=0;i<sorted.length;i++){
    var m = sorted[i];
    if(usedFam[m.fam]) continue;      /* jedna agentura = jeden řádek (národní má přednost) */
    usedFam[m.fam] = true;
    chosen.push(m);                    /* kandidátů víc než 8 — rezerva za modely bez dat */
  }
  return chosen;
}
/* Okno pro hledání METAR stanic. Kilometrová šířka jednoho stupně DÉLKY klesá
   s kosinem zeměpisné šířky, takže pevný offset ve stupních pokrývá u pólů
   mnohem menší území než na rovníku (v Reykjavíku ~78 km místo ~178 km).
   Dělíme proto kosinem, aby okno mělo všude zhruba stejný dosah v km. */
function metarBbox(lat, lon, dLat){
  dLat = dLat || 1.0;
  var cosLat = Math.max(0.18, Math.cos(lat*Math.PI/180));   /* strop u ~80° */
  var dLon = Math.min(45, dLat*1.6/cosLat);                 /* strop, ať dotaz nezhltne půl světa */
  return (lat-dLat).toFixed(2)+","+(lon-dLon).toFixed(2)+","
       + (lat+dLat).toFixed(2)+","+(lon+dLon).toFixed(2);
}
function distKm(a1,o1,a2,o2){
  var R=6371, dA=(a2-a1)*Math.PI/180, dO=(o2-o1)*Math.PI/180;
  var s=Math.sin(dA/2)*Math.sin(dA/2)+Math.cos(a1*Math.PI/180)*Math.cos(a2*Math.PI/180)*Math.sin(dO/2)*Math.sin(dO/2);
  return 2*R*Math.asin(Math.sqrt(s));
}

/* ===== národní / regionální modely podle země =====
   ns = krátký název pro mobil: sloupec s názvem modelu je na telefonu
   úzký (70-84 px), dlouhé názvy jako „ICON-D2 · střední Evropa" se
   do něj nikdy nevejdou a useknuté „ICO…" vypadaly jako rozbitý
   layout. Na velkém displeji zůstává plný název (n). */
var REGIONAL = {
  CZ:{id:"icon_d2", n:"ICON-D2 · střední Evropa", ns:"ICON-D2", a:"2,2 km — ČHMÚ ALADIN nemá veřejné API, toto je nejbližší náhrada", fam:"DWD"},
  SK:{id:"icon_d2", n:"ICON-D2 · střední Evropa", ns:"ICON-D2", a:"2,2 km · pokrývá SK (SHMÚ ALADIN bez API)", fam:"DWD"},
  DE:{id:"icon_d2", n:"DWD ICON-D2", ns:"ICON-D2", a:"národní model Německa · 2,2 km", fam:"DWD"},
  AT:{id:"geosphere_arome_austria", n:"GeoSphere AROME", ns:"AROME", a:"národní model Rakouska · 2,5 km", fam:"GeoSphere"},
  PL:{id:"icon_d2", n:"ICON-D2", ns:"ICON-D2", a:"2,2 km · pokrývá Polsko", fam:"DWD"},
  CH:{id:"meteoswiss_icon_ch1", n:"MeteoSwiss ICON-CH1", ns:"ICON-CH1", a:"národní model Švýcarska · 1 km", fam:"MeteoSwiss"},
  FR:{id:"meteofrance_arome_france", n:"Météo-France AROME", ns:"AROME", a:"národní model Francie · 1,3 km", fam:"MeteoFrance"},
  GB:{id:"ukmo_uk_deterministic_2km", n:"UKMO UKV", ns:"UKV", a:"národní model UK · 2 km", fam:"UKMO"},
  IE:{id:"ukmo_uk_deterministic_2km", n:"UKMO UKV", ns:"UKV", a:"2 km · pokrývá Irsko", fam:"UKMO"},
  NL:{id:"knmi_harmonie_arome_netherlands", n:"KNMI HARMONIE", ns:"HARMONIE", a:"národní model Nizozemska", fam:"KNMI"},
  BE:{id:"knmi_harmonie_arome_netherlands", n:"KNMI HARMONIE", ns:"HARMONIE", a:"pokrývá Belgii", fam:"KNMI"},
  DK:{id:"dmi_harmonie_arome_europe", n:"DMI HARMONIE", ns:"HARMONIE", a:"národní model Dánska", fam:"DMI"},
  NO:{id:"metno_nordic", n:"MET Norway Nordic", ns:"Nordic", a:"národní model Norska · 1 km", fam:"METNO"},
  SE:{id:"metno_nordic", n:"MET Norway Nordic", ns:"Nordic", a:"pokrývá Švédsko", fam:"METNO"},
  FI:{id:"metno_nordic", n:"MET Norway Nordic", ns:"Nordic", a:"pokrývá Finsko", fam:"METNO"},
  IT:{id:"italia_meteo_arpae_icon_2i", n:"ItaliaMeteo ICON-2I", ns:"ICON-2I", a:"národní model Itálie", fam:"ItaliaMeteo"},
  US:{id:"gfs_hrrr", n:"NOAA HRRR", ns:"HRRR", a:"národní model USA · 3 km", fam:"NOAA"},
  CA:{id:"gem_hrdps_continental", n:"GEM HRDPS", ns:"HRDPS", a:"národní model Kanady · 2,5 km", fam:"ECCC"},
  JP:{id:"jma_msm", n:"JMA MSM", ns:"MSM", a:"národní model Japonska · 5 km", fam:"JMA"},
  AU:{id:"bom_access_global", n:"BOM ACCESS", ns:"BOM", a:"národní model Austrálie", fam:"BOM"},
  KR:{id:"kma_seamless", n:"KMA", ns:"KMA", a:"národní model Jižní Koreje", fam:"KMA"},
  CN:{id:"cma_grapes_global", n:"CMA GRAPES", ns:"GRAPES", a:"národní model Číny", fam:"CMA"},
  /* Severní Afrika: ARPEGE Europe kreslí mřížku 11 km i přes Maghreb a Egypt.
     Tyhle země dosud nedostávaly regionální model vůbec — jen globály
     s buňkou 25 km a víc. */
  MA:{id:"meteofrance_arpege_europe", n:"Météo-France ARPEGE", ns:"ARPEGE", a:"regionální model · 11 km · pokrývá Maroko", fam:"MeteoFrance"},
  DZ:{id:"meteofrance_arpege_europe", n:"Météo-France ARPEGE", ns:"ARPEGE", a:"regionální model · 11 km · pokrývá Alžírsko", fam:"MeteoFrance"},
  TN:{id:"meteofrance_arpege_europe", n:"Météo-France ARPEGE", ns:"ARPEGE", a:"regionální model · 11 km · pokrývá Tunisko", fam:"MeteoFrance"},
  LY:{id:"meteofrance_arpege_europe", n:"Météo-France ARPEGE", ns:"ARPEGE", a:"regionální model · 11 km · pokrývá Libyi", fam:"MeteoFrance"},
  EG:{id:"meteofrance_arpege_europe", n:"Météo-France ARPEGE", ns:"ARPEGE", a:"regionální model · 11 km · pokrývá Egypt", fam:"MeteoFrance"},
  TR:{id:"meteofrance_arpege_europe", n:"Météo-France ARPEGE", ns:"ARPEGE", a:"regionální model · 11 km", fam:"MeteoFrance"}
};
var EU_FALLBACK_CC = "ES PT GR HU RO BG HR SI RS BA ME MK AL LT LV EE LU IS UA MD".split(" ");
function regionalFor(cc){
  if(!cc) return null;
  cc = cc.toUpperCase();
  if(REGIONAL[cc]) return REGIONAL[cc];
  if(EU_FALLBACK_CC.indexOf(cc) >= 0) return {id:"dmi_harmonie_arome_europe", n:"DMI HARMONIE Evropa", ns:"HARMONIE", a:"regionální evropský model · 2 km", fam:"DMI"};
  return null;
}

/* ================= PRÁH SRÁŽEK — kalibrovaný proti METAR =================
   Čísla pocházejí z měření v laboratoři přesnosti, ne z odhadu. */

/* Základ zvednut z 0,1 na 0,2 mm/h.
   Nezávislá polovina dat: CSI 0,259 → 0,276, sklon 2,84 → 2,0,
   plané poplachy 72 % → 66 %. */
var THRESH_BASE = 0.2;

/* Tropický déšť je konvektivní, tedy skvrnitý: model spočítá "2 mm přes
   celou buňku 15 km", ale realita je 20 mm na desetině plochy a sucho
   jinde. V mírném pásmu je déšť frontální, buňku vyplní celou a nízký
   práh tam vyhovuje. Křížové ověření: +11 %. */
var THRESH_TROPIC = 1.0;

/* Přechodové pásmo 15°–25°.
   POZOR: tenhle náběh NENÍ naměřený. Je to dopočet, aby verdikt neskákal
   o celý řád na jedné rovnoběžce. Až bude dat víc, nahradit křivkou
   z měření. */
function threshLatFor(lat){
  var a = Math.abs(lat);
  if(a <= 15) return THRESH_TROPIC;
  if(a >= 25) return THRESH_BASE;
  return THRESH_BASE + ((25 - a) / 10) * (THRESH_TROPIC - THRESH_BASE);
}

/* ---- PRÁH ŘÍZENÝ KONVEKCÍ ------------------------------------------
   Zeměpisná šířka byla vždycky jen ZÁSTUPNÝ ukazatel. Skutečný důvod,
   proč se v tropech zvedá práh, je ten, že tamní déšť je konvektivní:
   model rozetře 2 mm přes buňku 15 km, ale realita je 20 mm na desetině
   plochy a sucho jinde. Nad bodem, kde stojíš, tedy nejspíš nezaprší.

   Jenže konvekce není vlastnost rovnoběžky. V Brně v červenci v podvečer
   je atmosféra konvektivní úplně stejně jako v Jakartě — a appka to
   dosud nevěděla, protože se ptala jen na zeměpisnou šířku.

   CAPE (konvektivní dostupná energie) i podíl "showers" v srážkách appka
   UŽ STAHUJE kvůli bouřkové hlášce. Tady se z nich konečně počítá i práh.

   POZOR: náběh není naměřený, je odvozený z fyzikální úvahy a záměrně
   mírný. Strop je THRESH_TROPIC — výš nejde ani při extrémním CAPE. */
var CAPE_CONV_LO = 400;     /* pod tím je atmosféra stabilní, frontální déšť */
var CAPE_CONV_HI = 2000;    /* nad tím plně konvektivní režim */

function convectiveFrac(){
  /* dva nezávislé ukazatele, bere se ten silnější */
  var byCape = null, byMix = null;
  if(stormRisk && typeof stormRisk.cape === "number" && stormRisk.cape > 0){
    byCape = (stormRisk.cape - CAPE_CONV_LO) / (CAPE_CONV_HI - CAPE_CONV_LO);
    byCape = Math.max(0, Math.min(1, byCape));
  }
  /* precipMix.showerFrac = kolik z úhrnu spadne jako přeháňky, ne trvalý déšť */
  if(precipMix && typeof precipMix.showerFrac === "number"){
    byMix = Math.max(0, Math.min(1, (precipMix.showerFrac - 0.35) / 0.45));
  }
  if(byCape == null && byMix == null) return null;
  if(byCape == null) return byMix;
  if(byMix == null) return byCape;
  return Math.max(byCape, byMix);
}

/* Výsledný práh = vyšší ze zeměpisného a konvektivního. Nikdy nad tropický. */
function threshFor(lat){
  var base = threshLatFor(lat);
  var cf = convectiveFrac();
  if(cf == null) return base;
  var conv = THRESH_BASE + cf * (THRESH_TROPIC - THRESH_BASE);
  return Math.min(THRESH_TROPIC, Math.max(base, conv));
}

/* ================= OROGRAFIE =================
   Vzduch, který stoupá po svahu, se ochlazuje a sráží vodu; na závětrné
   straně klesá, otepluje se a srážky mizí. Je to nejsilnější lokální
   efekt v horách a globální modely s buňkou 25 km ho vidí jen rozmazaně:
   Beskydy jsou pro ně mírná vyvýšenina, ne hřeben.

   Appka UŽ MÁ obě potřebné veličiny a dosud je k tomuhle nepoužila:
   vítr v 850 hPa (`atmoState.ws850` / `wd850`) a nadmořskou výšku.
   Chybí jen sklon terénu ve směru proudění — jeden dotaz na Elevation
   API, a protože je terén statický, stačí jednou za lokalitu.

   Fyzika: rychlost výstupu w = U · sin(α) ≈ U · (Δz/Δx). Při větru
   15 m/s a stoupání 300 m na 10 km vychází w ≈ 0,45 m/s, což je pro
   srážky hodně. Faktor je proto úmyslně zastropovaný — cílem je opravit
   směr chyby, ne předstírat přesný přepočet.                          */
var OROG_UPWIND_KM = [6, 12, 22];   /* kde se měří terén proti větru */
var OROG_K = 0.85;                  /* m/s výstupu → násobek srážek */
var OROG_MIN = 0.70, OROG_MAX = 1.55;
var orogState = null;      /* {factor, riseM, wMs, dirDeg, elev} | "off" | "error" */
var orogNote = "";
var orogCache = {};        /* terén se nemění — profil se drží podle lokality */

/* Posun o d km v azimutu brg. */
function movePoint(lat, lon, km, brgDeg){
  var R = 6371, d = km/R, b = brgDeg*Math.PI/180;
  var la = lat*Math.PI/180, lo = lon*Math.PI/180;
  var la2 = Math.asin(Math.sin(la)*Math.cos(d) + Math.cos(la)*Math.sin(d)*Math.cos(b));
  var lo2 = lo + Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(la), Math.cos(d) - Math.sin(la)*Math.sin(la2));
  return {lat: la2*180/Math.PI, lon: ((lo2*180/Math.PI + 540) % 360) - 180};
}

/* Terénní profil PROTI VĚTRU. wd850 je směr, ODKUD vítr fouká,
   takže proti proudu se jde přímo tím azimutem. */
function loadOrography(lat, lon, myId){
  var wd = atmoState && atmoState !== "error" ? atmoState.wd850 : null;
  var ws = atmoState && atmoState !== "error" ? atmoState.ws850 : null;
  if(wd == null || ws == null){ orogState = "off"; orogNote = "chybí vítr v 850 hPa"; return; }
  /* Slabé proudění orografii nevybudí — a dělit skoro nulou nemá smysl. */
  if(ws < 8){ orogState = "off"; orogNote = "proudění v 850 hPa je slabé (" + Math.round(ws) + " km/h)"; return; }

  var key = locKeyOf(lat, lon) + "|" + Math.round(wd/30);   /* 12 sektorů stačí */
  if(orogCache[key] !== undefined){
    orogState = orogCache[key];
    orogNote = orogState && orogState.note || "";
    return;
  }
  var lats = [lat.toFixed(4)], lons = [lon.toFixed(4)];
  OROG_UPWIND_KM.forEach(function(km){
    var p = movePoint(lat, lon, km, wd);          /* proti větru */
    lats.push(p.lat.toFixed(4)); lons.push(p.lon.toFixed(4));
  });
  OROG_UPWIND_KM.slice(0,2).forEach(function(km){
    var p = movePoint(lat, lon, km, (wd+180)%360); /* po větru — srážkový stín */
    lats.push(p.lat.toFixed(4)); lons.push(p.lon.toFixed(4));
  });

  cachedJson("https://api.open-meteo.com/v1/elevation?latitude=" + lats.join(",")
    + "&longitude=" + lons.join(","), 86400000)
    .then(function(j){
      if(isStale(myId)) return;
      var e = j && j.elevation;
      if(!e || e.length < 4){ throw new Error("elevation bez dat"); }
      var here = e[0];
      /* Sklon se bere jako medián přes tři vzdálenosti — jedna kóta
         může být náhodný kopec, tři už dělají svah. */
      var slopes = [];
      OROG_UPWIND_KM.forEach(function(km, i){
        var up = e[1+i];
        if(up == null) return;
        slopes.push((here - up) / (km*1000));      /* bezrozměrný sklon */
      });
      if(!slopes.length) throw new Error("elevation neúplná");
      slopes.sort(function(a,b){ return a-b; });
      var slope = slopes[Math.floor(slopes.length/2)];

      var wsMs = ws/3.6;
      var wMs = wsMs * slope;                       /* m/s výstupu (záporně = klesání) */
      var factor = 1 + wMs*OROG_K;
      factor = Math.max(OROG_MIN, Math.min(OROG_MAX, factor));

      var riseM = Math.round(slope * OROG_UPWIND_KM[1] * 1000);
      orogState = {factor: factor, riseM: riseM, wMs: wMs, dirDeg: wd, elev: here,
                   note: ""};
      orogState.note = (factor > 1.06 ? "návětří" : factor < 0.94 ? "závětří" : "terén rovný")
        + " · " + (riseM >= 0 ? "+" : "") + riseM + " m na " + OROG_UPWIND_KM[1] + " km proti větru"
        + " · ×" + factor.toFixed(2);
      orogNote = orogState.note;
      orogCache[key] = orogState;
      /* práh ani hodnoty se nezmění samy — je potřeba překreslit */
      if(lastJ && lastModels) render(lastJ, lastModels);
    })
    .catch(function(e){
      if(isStale(myId)) return;
      orogState = "error"; orogNote = "elevation selhala: " + (e && e.message || e);
      orogCache[key] = "error";
    });
}
function orogFactor(){
  return (orogState && orogState !== "off" && orogState !== "error" && orogState.factor)
    ? orogState.factor : 1;
}

/* ================= JAK SE POČÍTÁ VERDIKT =================

   Dřív platilo: model hlásí déšť, když KTERÁKOLI z osmi hodin překročí
   práh (`vals.some(...)`). To má dvě vady.

   1. Je to maximum přes osm pokusů. Čím delší okno, tím jistější
      "bude pršet" — i když se modely ve skutečnosti neshodnou na ničem.
      Tohle je pravděpodobně část důvodu, proč vyšel v kalibraci sklon 2,84:
      appka strukturálně nadhodnocuje a kalibrace to pak lepí až na konci.

   2. Model, který čeká 0,3 mm v hodině 1, se počítá stejně jako model,
      který je čeká v hodině 8. Přitom předpovědní dovednost s časem klesá.

   Nově se hledá NEJSILNĚJŠÍ SHODA v čase, ne pouhý výskyt kdekoliv.       */

/* Modely, které se liší o hodinu, se neshodují v tom KDY — ale shodují se
   v tom ŽE. Bez tolerance by rozdíl 14:00 vs 15:00 vypadal jako spor. */
var CONSENSUS_TOL_H = 1;
/* 1 cm napadaného sněhu ≈ 0,7 mm vody */
var SNOW_CM_TO_MM = 0.7;
var legacyAnyProb = null;   /* staré chování (.some) — jen pro srovnání v bpDiag */
var stormRisk = null;       /* {cape, lightning, idx} přes celé okno předpovědi */

/* ===== KOLO 8bb: sníh jako občan první třídy =====
   Detekce sněhu už existovala (radarový bit, METAR, snowfall modelů,
   ensemble), ale UX mluvilo o „dešti“ i tam, kde appka slibovala sníh.
   Pomocníci níže jsou čisté funkce — regression testy je vytahují
   přímo ze zdroje. */

/* mm vodního ekvivalentu → cm napadaného sněhu (1 cm ≈ 0,7 mm vody).
   Vstupem je buď úhrn (mm), nebo intenzita (mm/h) — rozměr se nezmění.
   Pod 0,1 cm nic neužitečného neukazujeme; 1–5 cm po půlce, nad 5 celé. */
function snowCmFromMm(mm){
  if(mm == null || !isFinite(mm) || mm <= 0) return null;
  var cm = mm / SNOW_CM_TO_MM;
  if(cm < 0.1) return null;
  if(cm < 1) return Math.round(cm*10)/10;
  if(cm < 5) return Math.round(cm*2)/2;
  return Math.round(cm);
}
/* Číselný údaj cm s českou desetinnou čárkou. */
function fmtCm(cm){
  if(cm == null) return "–";
  return String(cm).replace(".", ",");
}
/* Podíl mokrých modelů hlásících sníh v hodině vrcholu (pkIdx).
   ≥ 0,5 → „tohle je sněžení“. null = modely mlčí nebo nemají data. */
function snowShareAtPeak(){
  if(!modelState || !verdictState || verdictState.pkIdx == null || verdictState.pkIdx < 0) return null;
  if(!modelState.snowFrac) return null;
  var f = modelState.snowFrac[verdictState.pkIdx];
  return (f == null) ? null : f;
}
/* Sněhová čára (m n.m.) v dané hodině okna verdiktu (0 = nejbližší
   hodina). null = hourly pole chybí nebo je prázdné. */
function snowLineAt(hourIdx){
  if(!atmoState || atmoState === "error" || !atmoState.flh || !atmoState.flh.length) return null;
  var base = (atmoState.nowIdx != null) ? atmoState.nowIdx : 0;
  var i = base + (hourIdx == null || hourIdx < 0 ? 0 : hourIdx);
  if(i >= atmoState.flh.length) i = atmoState.flh.length - 1;
  var v = atmoState.flh[i];
  return (v != null && isFinite(v)) ? Math.round(v) : null;
}
/* Sněhová čára se nehlásí na metr přesně: pod 1000 m na 50 m, nad ní
   na stovky. */
function snowLineTxt(m){
  if(m == null || !isFinite(m)) return "–";
  return String(m >= 1000 ? Math.round(m/100)*100 : Math.round(m/50)*50);
}
/* Jde v okně verdiktu o sníh? Pozorování (verdikt „sněžení“) nebo
   shoda modelů ve vrcholu (≥ 50 % mokrých hlásí sníh). */
function isSnowWindow(){
  if(whenState && whenState.type && /sněž|sníh|sněh/i.test(whenState.type.t)) return true;
  var f = snowShareAtPeak();
  return f != null && f >= 0.5;
}

/* Útlum jistoty s délkou předstihu.
   POZOR: NENAMĚŘENO. Je to návrhové rozhodnutí, ne výsledek měření —
   proto je útlum mírný (nejvýš 20 %), aby v nejhorším případě neuškodil.
   Laborka umí tenhle parametr nafitovat, až bude dost dat. */
function leadWeight(h){ return 1 - Math.min(0.20, h*0.025); }

/* Nejsilnější shoda modelů v čase.
   Vrací {prob, idx, count} — pravděpodobnost 0–1, hodina špičky
   a kolik modelů v ní (s tolerancí) hlásí déšť. */
function peakConsensus(active, nHours){
  var N = active.length;
  if(!N) return {prob:0, idx:-1, count:0, perHour:[]};
  var perHour = [], strict = [];
  for(var i=0;i<nHours;i++){
    var lo = Math.max(0, i-CONSENSUS_TOL_H), hi = Math.min(nHours-1, i+CONSENSUS_TOL_H);
    var c = 0, cs = 0;
    for(var m=0;m<N;m++){
      var wet = false;
      for(var k=lo;k<=hi;k++){
        var v = active[m].cvals[k];
        if(v != null && v >= THRESH){ wet = true; break; }
      }
      if(wet) c++;
      var sv = active[m].cvals[i];
      if(sv != null && sv >= THRESH) cs++;
    }
    perHour.push(c); strict.push(cs);
  }
  var best = 0, bestIdx = -1, bestCount = 0;
  for(var i2=0;i2<perHour.length;i2++){
    var s = (perHour[i2]/N) * leadWeight(i2);
    if(s > best){ best = s; bestIdx = i2; bestCount = perHour[i2]; }
  }
  /* Hlášená HODINA se bere ze striktního počtu uvnitř tolerančního okna.
     Bez tohohle kroku by tolerance posunula špičku systematicky dopředu:
     hodina 1 "vidí" i déšť v hodině 2, má stejný vyhlazený počet, ale
     vyšší váhu předstihu — a appka by hlásila čas o hodinu dřív, než
     ho modely skutečně předpovídají. */
  if(bestIdx >= 0){
    var wLo = Math.max(0, bestIdx-CONSENSUS_TOL_H), wHi = Math.min(nHours-1, bestIdx+CONSENSUS_TOL_H);
    var sBest = -1, sIdx = bestIdx;
    for(var k2=wLo;k2<=wHi;k2++){
      if(strict[k2] > sBest){ sBest = strict[k2]; sIdx = k2; }
    }
    if(sBest > 0) bestIdx = sIdx;
  }
  return {prob:best, idx:bestIdx, count:bestCount, perHour:perHour, strict:strict};
}

/* Práh pro MODELY — mění se podle lokality, nastavuje se v load(). */
var THRESH = THRESH_BASE;

/* Práh pro POZOROVÁNÍ (radar, nowcast) — zůstává na základní hodnotě
   VŽDY, i v tropech. Důvod: tropický práh napravuje rozmazání modelové
   buňky o straně 15 km. Radarový pixel má na zoomu 8 kolem 600 m, to je
   prakticky bodové měření a žádné rozmazání tam není. Kdyby se na
   minutecast pustil práh 1,0, aplikace by v Jakartě mlčela, i když ti
   radar ukazuje déšť přímo nad hlavou. */
var THRESH_OBS = THRESH_BASE;

/* Práh pro KONEC deště. Nižší než práh začátku: frontální mrholení
   0,1–0,2 mm/h reálně kape, takže "skončilo v 15:20" by u něj byla lež.
   Konec se hlásí, až intenzita spadne pod 0,12 mm/h — a vydrží tam
   (podívej se na požadovanou délku sucha v estimateRainEnd). */
var THRESH_END = 0.12;

var HOURS = 8;
/* Tabulka i verdikt pracují s 8 hodinami. Odhad KONCE deště ale potřebuje
   vidět dál — jinak u deště, který začne v poslední hodině okna, nemá appka
   z čeho konec spočítat a musí říct "nevím". Přesně to se stalo v Přerově:
   déšť měl začít v 00:00, tedy na samém okraji okna, a appka na to hlásila
   nesmysl o srážkách přes celé okno. Data se tahají na 24 h, zobrazuje se 8. */
var HOURS_END = 24;

/* ================= KALIBRACE PROCENT =================
   Převodní klíč mezi tím, co appka tvrdí (podíl modelů nad prahem),
   a tím, co se podle METAR skutečně stalo.

   ZATÍM VYPNUTO — ZÁMĚRNĚ. Tabulka z minulé zprávy se měřila při prahu
   0,1. Procento v appce je podíl modelů nad prahem, takže po zvednutí
   prahu na 0,2 (a v tropech na 1,0) se rozdělení procent posune a starý
   klíč přestane platit. Nasadit až po přeměření na nových datech,
   jinak si kalibrací zkazíš zlepšení z bodu 1.

   Postup nasazení:
     1. vyplnit CALIB_TABLE dvojicemi [surové %, skutečný podíl %]
     2. přepnout CALIB_ENABLED na true                                  */
var CALIB_ENABLED = false;
var CALIB_TABLE = [[0,0],[100,100]];   /* identita = žádný vliv */

function calibrateProb(raw){
  if(!CALIB_ENABLED) return raw;
  var t = CALIB_TABLE;
  if(!t || t.length < 2) return raw;
  if(raw <= t[0][0]) return t[0][1];
  for(var i=1; i<t.length; i++){
    if(raw <= t[i][0]){
      var f = (raw - t[i-1][0]) / Math.max(1e-9, t[i][0] - t[i-1][0]);
      return t[i-1][1] + f*(t[i][1] - t[i-1][1]);
    }
  }
  return t[t.length-1][1];
}

/* ================= ENSEMBLE — SKUTEČNÁ PRAVDĚPODOBNOST =================

   Tohle je oprava nejhlubší vady celého verdiktu.

   "Shoda modelů" NENÍ pravděpodobnost. Osm modelů není osm nezávislých
   vzorků z rozdělení možných budoucností — je to osm implementací, které
   sdílejí pozorovací síť, asimilační schéma i část fyziky. Když se sedm
   z osmi shodne, neznamená to 88 %. Znamená to, že se shodly modely,
   které se shodovat mají tendenci.

   Ensemble řeší přesně tohle a řeší to správně. Vezme JEDEN model a pustí
   ho čtyřicetkrát až jedenapadesátkrát s mírně rozhozeným počátečním
   stavem — přesně tak rozhozeným, jak nejistá je skutečná analýza. Podíl
   členů, kterým vyjde déšť, JE pravděpodobnost deště. Ne analogie,
   ne náhražka: je to ta veličina.

   Počítá se STEJNOU funkcí `peakConsensus()` jako verdikt z modelů —
   se stejnou tolerancí ±1 h i stejným útlumem předstihu. Kdyby se
   počítala jinak, obě čísla by nešlo srovnat a vedle sebe by mátla.  */

/* Doména se vybírá podle rozlišení: jemnější ensemble = lepší odhad
   lokální skvrnitosti. Když preferovaný model nemá data, zkusí se další
   v pořadí — a teprve když selžou všechny, ensemble se vzdá. */
/* NEP okolí: 3×3 body ~±11 km severojižně a ~±11–13 km východozápadně
   (0,1° lat, 0,15° lon). Centrální bod je první, aby čas vrcholu zůstal
   ukotvený k obci. */
function ensembleGrid(lat, lon){
  var pts = [[+lat.toFixed(4), +lon.toFixed(4)]];
  for(var a=-1;a<=1;a++) for(var b=-1;b<=1;b++){
    if(a===0 && b===0) continue;
    pts.push([+(lat+a*0.1).toFixed(4), +(lon+b*0.15).toFixed(4)]);
  }
  return pts;
}
/* Z odpovědi (pole bodů nebo jediný objekt) vybere členy pro každý bod.
   Centrální bod (první v pořadí dotazu) určuje members pro peakConsensus,
   všechny body dohromady all pro NEP pravděpodobnost. Body bez členů se
   přeskočí; bez centrálního bodu není výsledek. */
function ensembleFromJson(j, nHours){
  var pts = Array.isArray(j) ? j : [j];
  var center = null, all = [];
  pts.forEach(function(p, pi){
    var h = (p && p.hourly) || {};
    var keys = Object.keys(h).filter(function(k){ return k.indexOf("precipitation_member") === 0; });
    if(h.precipitation) keys.unshift("precipitation");  /* deterministický běh = nultý člen */
    if(keys.length < 5) return;
    var members = keys.map(function(k){
      return {cvals: (h[k] || []).slice(0, nHours).map(function(v){ return saneMm(v); })};
    }).filter(function(m){ return m.cvals.some(function(v){ return v != null; }); });
    if(members.length < 5) return;
    if(pi === 0) center = members;
    members.forEach(function(m){ all.push(m); });
  });
  if(!center) return null;
  var perHour = [];
  for(var hh=0; hh<nHours; hh++){
    var c = 0, n = 0;
    all.forEach(function(m){
      if(m.cvals[hh] != null){ n++; if(m.cvals[hh] >= THRESH) c++; }
    });
    perHour.push(n ? c/n : 0);
  }
  return {members: center, all: all, perHour: perHour};
}
function ensembleCandidates(lat, lon){
  var c = [];
  /* ICON-D2 EPS — 20 členů, 2,2 km, střední Evropa (včetně celé ČR) */
  if(lat>=43.2 && lat<=58.1 && lon>=-3.9 && lon<=20.3)
    c.push({id:"icon_d2", n:"ICON-D2 EPS", res:"2,2 km"});
  /* ICON-EU EPS — 40 členů, 7 km */
  if(lat>=29.5 && lat<=70.5 && lon>=-23.5 && lon<=45)
    c.push({id:"icon_eu", n:"ICON-EU EPS", res:"7 km"});
  /* ECMWF IFS ensemble — 51 členů, 25 km, celosvětově */
  c.push({id:"ecmwf_ifs025", n:"ECMWF IFS ENS", res:"25 km"});
  /* GEFS — 31 členů, poslední záchrana */
  c.push({id:"gfs_seamless", n:"NOAA GEFS", res:"25 km"});
  return c;
}

function loadEnsemble(lat, lon, myId){
  ensState = null; ensNote = "";
  var cands = ensembleCandidates(lat, lon);
  (function tryNext(i){
    if(i >= cands.length){
      if(isStale(myId)) return;
      ensState = "error"; ensNote = "žádný ensemble nevrátil data";
      return;
    }
    var M = cands[i];
    var pts = ensembleGrid(lat, lon);
    cachedJson(omUrl("ensemble-api.open-meteo.com", "/v1/ensemble",
      "latitude=" + pts.map(function(p){ return p[0]; }).join(",")
      + "&longitude=" + pts.map(function(p){ return p[1]; }).join(",")
      + "&hourly=precipitation&models=" + M.id
      + "&forecast_hours=" + (HOURS+1) + "&timezone=auto"), 900000)
      .then(function(j){
        if(isStale(myId)) return;
        var parsed = ensembleFromJson(j, HOURS);
        if(!parsed || !parsed.members || parsed.members.length < 5) throw new Error("členy bez dat");

        var pk = peakConsensus(parsed.members, HOURS);
        /* NEP: pravděpodobnost = podíl členů nad prahem přes 3×3 okolí
           (členové × body). Špička (idx) zůstává z centrálního bodu,
           aby čas vrcholu neplaval podle toho, kde zrovna prší. */
        /* Čas začátku deště po JEDNOTLIVÝCH členech (minuty od teď,
           hodinová hrubost: h*60 — člen neumí slíbit minutu, jen hodinu).
           Ensemble dosud mluvil jedním procentem přes celé okno, přitom
           rozptyl začátků 20–51 běhů je nejlepší statistika ČASU
           příchodu, jakou appka má: slouží jako hlas do mediánu
           arrivalů i pro "šance do N minut".
           null = ten člen déšť v okně nehlásí. */
        var onsets = parsed.members.map(function(m){
          for(var h=0; h<HOURS; h++){
            if(m.cvals[h] != null && m.cvals[h] >= THRESH) return h*60;
          }
          return null;
        });
        ensState = {prob: Math.round(100*(parsed.perHour[pk.idx] != null ? parsed.perHour[pk.idx] : pk.prob)),
                    members: parsed.members.length,
                    model: M.n, res: M.res, idx: pk.idx, count: pk.count,
                    perHour: parsed.perHour, allCvals: parsed.all,
                    memberCvals: parsed.members, onsets: onsets};
        ensNote = M.n + " · " + parsed.members.length + " členů · " + M.res + " · 3×3 body";
        if(lastJ && lastModels) render(lastJ, lastModels);
      })
      .catch(function(e){
        if(isStale(myId)) return;
        console.warn("[bp] ensemble " + M.id + " nevyšel: " + (e && e.message || e));
        tryNext(i+1);
      });
  })(0);
}

/* Práh (THRESH) se zpřesní CAPE korekcí až po modelech — ensemble mezitím
   spočítal hlasy členů se starým prahem. Členy si proto schováme a
   pravděpodobnost přepočítáme, až platí práh, které soudí i modely. */
function refreshEnsembleProb(){
  if(!ensState) return;
  var ms = (ensState.allCvals && ensState.allCvals.length) ? ensState.allCvals : ensState.memberCvals;
  if(!ms || !ms.length) return;
  var n = ms.length;
  for(var hh=0; hh<HOURS && hh<ensState.perHour.length; hh++){
    var c = 0;
    ms.forEach(function(m){ if(m.cvals[hh] != null && m.cvals[hh] >= THRESH) c++; });
    ensState.perHour[hh] = c/n;
  }
  var ci = 0;
  ms.forEach(function(m){ if(m.cvals[ensState.idx] != null && m.cvals[ensState.idx] >= THRESH) ci++; });
  ensState.prob = Math.round(100*ci/n);
}

/* "0,2" → "0,2" ; "0,6000000000000001" → "0,6" (desetinná čárka, max 1 místo) */
function fmtThresh(v){ return (Math.round(v*10)/10).toFixed(1).replace(".", ","); }
function flagEmoji(cc){
  if(!cc || cc.length !== 2) return "";
  cc = cc.toUpperCase();
  return String.fromCodePoint(0x1F1E6 + cc.charCodeAt(0) - 65, 0x1F1E6 + cc.charCodeAt(1) - 65);
}
/* Kolo 8ae (Dave: „vlajky modelů chybí" na Windows): emoji vlaječky kreslí
   operační systém a Windows je ve svých fontech nemá — na Chrome/Edge se
   zobrazí prázdné místo. Aplikace proto nese vlastní vektorové vlajky
   (SVG data URI, žádná síť, žádná závislost) a vypadá stejně na všech
   zařízeních. Neznámý kód země o PADNE na emoji (kde funguje).
   Sadu tvoří přesně cc hodnoty z MODEL_POOL a REGIONAL — nic navíc. */
var FLAG_SVG = {
  AT:'<path fill="#ED2939" d="M0 0h60v40H0z"/><path fill="#fff" d="M0 13h60v14H0z"/>',
  AU:'<path fill="#012169" d="M0 0h60v40H0z"/><path stroke="#fff" stroke-width="3" d="M0 0l25 15M25 0L0 15"/><path stroke="#C8102E" stroke-width="1.5" d="M0 0l25 15M25 0L0 15"/><path fill="#fff" d="M9 0h7v15H0v7h25v-7H9z"/><path fill="#C8102E" d="M10.5 0h4v15H0v4h25v-4H10.5z"/><circle fill="#fff" cx="33" cy="10" r="2"/><circle fill="#fff" cx="40" cy="5" r="1.4"/><circle fill="#fff" cx="47" cy="9" r="1.6"/><circle fill="#fff" cx="52" cy="17" r="1.6"/><circle fill="#fff" cx="44" cy="25" r="1.8"/><circle fill="#fff" cx="35" cy="31" r="1.6"/><circle fill="#fff" cx="8" cy="33" r="2.2"/>',
  BE:'<path fill="#000" d="M0 0h20v40H0z"/><path fill="#FAE042" d="M20 0h20v40H20z"/><path fill="#ED2939" d="M40 0h20v40H40z"/>',
  CA:'<path fill="#fff" d="M0 0h60v40H0z"/><path fill="#D80621" d="M0 0h15v40H0z"/><path fill="#D80621" d="M45 0h15v40H45z"/><path fill="#D80621" d="M30 8l2.4 4 3.6-1.6-.9 4 4.1.9-3.3 3.3 1.7 3.6-4.3-.8-.8 4.3-2.5-2.5-2.5 2.5-.8-4.3-4.3.8 1.7-3.6-3.3-3.3 4.1-.9-.9-4 3.6 1.6z"/>',
  CH:'<path fill="#DA291C" d="M0 0h60v40H0z"/><path fill="#fff" d="M26 6h8v28h-8z"/><path fill="#fff" d="M14 16h32v8H14z"/>',
  CN:'<path fill="#DE2910" d="M0 0h60v40H0z"/><path fill="#FFDE00" d="M13 4l1.6 5 5.3.3-4.2 3.4 1.6 5-4.3-3.1-4.3 3.1 1.6-5-4.2-3.4 5.3-.3z"/><circle fill="#FFDE00" cx="25" cy="7" r="1.6"/><circle fill="#FFDE00" cx="28.5" cy="11.5" r="1.6"/><circle fill="#FFDE00" cx="28.5" cy="16.5" r="1.6"/><circle fill="#FFDE00" cx="25" cy="20.5" r="1.6"/>',
  CZ:'<path fill="#fff" d="M0 0h60v20H0z"/><path fill="#D7141A" d="M0 20h60v20H0z"/><path fill="#11457E" d="M0 0l30 20L0 40z"/>',
  DE:'<path fill="#000" d="M0 0h60v13.3H0z"/><path fill="#D00" d="M0 13.3h60v13.4H0z"/><path fill="#FFCE00" d="M0 26.7h60v13.3H0z"/>',
  DK:'<path fill="#C8102E" d="M0 0h60v40H0z"/><path fill="#fff" d="M17 0h7v40h-7z"/><path fill="#fff" d="M0 17h60v7H0z"/>',
  DZ:'<path fill="#006233" d="M0 0h30v40H0z"/><path fill="#fff" d="M30 0h30v40H30z"/><path fill="#D21034" d="M27 12a8 8 0 1 0 0 16 6.6 6.6 0 1 1 0-16z"/><circle fill="#D21034" cx="38" cy="20" r="2.2"/>',
  EG:'<path fill="#CE1126" d="M0 0h60v13.3H0z"/><path fill="#fff" d="M0 13.3h60v13.4H0z"/><path fill="#000" d="M0 26.7h60v13.3H0z"/><path fill="#C09329" d="M30 15.5h4v3l-2 6-2-6z"/>',
  EU:'<path fill="#003399" d="M0 0h60v40H0z"/><circle fill="#FFCC00" cx="41" cy="20" r="1.7"/><circle fill="#FFCC00" cx="39.5" cy="25.5" r="1.7"/><circle fill="#FFCC00" cx="35.5" cy="29.5" r="1.7"/><circle fill="#FFCC00" cx="30" cy="31" r="1.7"/><circle fill="#FFCC00" cx="24.5" cy="29.5" r="1.7"/><circle fill="#FFCC00" cx="20.5" cy="25.5" r="1.7"/><circle fill="#FFCC00" cx="19" cy="20" r="1.7"/><circle fill="#FFCC00" cx="20.5" cy="14.5" r="1.7"/><circle fill="#FFCC00" cx="24.5" cy="10.5" r="1.7"/><circle fill="#FFCC00" cx="30" cy="9" r="1.7"/><circle fill="#FFCC00" cx="35.5" cy="10.5" r="1.7"/><circle fill="#FFCC00" cx="39.5" cy="14.5" r="1.7"/>',
  FI:'<path fill="#fff" d="M0 0h60v40H0z"/><path fill="#002F6C" d="M26 0h8v40h-8z"/><path fill="#002F6C" d="M0 16h60v8H0z"/>',
  FR:'<path fill="#0055A4" d="M0 0h20v40H0z"/><path fill="#fff" d="M20 0h20v40H20z"/><path fill="#EF4135" d="M40 0h20v40H40z"/>',
  GB:'<path fill="#012169" d="M0 0h60v40H0z"/><path stroke="#fff" stroke-width="7" d="M0 0l60 40M60 0L0 40"/><path stroke="#C8102E" stroke-width="4" d="M0 0l60 40M60 0L0 40"/><path fill="#fff" d="M24 0h12v40H24z"/><path fill="#fff" d="M0 14h60v12H0z"/><path fill="#C8102E" d="M26 0h8v40h-8z"/><path fill="#C8102E" d="M0 16h60v8H0z"/>',
  IE:'<path fill="#169B62" d="M0 0h20v40H0z"/><path fill="#fff" d="M20 0h20v40H20z"/><path fill="#FF883E" d="M40 0h20v40H40z"/>',
  IT:'<path fill="#009246" d="M0 0h20v40H0z"/><path fill="#fff" d="M20 0h20v40H20z"/><path fill="#CE2B37" d="M40 0h20v40H40z"/>',
  JP:'<path fill="#fff" d="M0 0h60v40H0z"/><circle fill="#BC002D" cx="30" cy="20" r="11"/>',
  KR:'<path fill="#fff" d="M0 0h60v40H0z"/><path fill="#CD2E3A" d="M30 20a10 10 0 0 1 10-10 8.5 8.5 0 0 0-10 10z"/><path fill="#0047A0" d="M30 20a10 10 0 0 1-10 10 8.5 8.5 0 0 0 10-10z"/><path fill="#CD2E3A" d="M30 20a5 5 0 0 1 5-5v2a3 3 0 0 0-3 3z"/><path fill="#0047A0" d="M30 20a5 5 0 0 1-5 5v-2a3 3 0 0 0 3-3z"/><path fill="#000" d="M10 6h9v2H10zM10 9.5h9v2H10zM10 13h9v2H10zM41 6h9v2h-9zM41 9.5h9v2h-9zM41 13h9v2h-9zM10 24h9v2H10zM10 27.5h9v2H10zM10 31h9v2H10zM41 24h9v2h-9zM41 27.5h9v2h-9zM41 31h9v2h-9z"/>',
  LY:'<path fill="#E70013" d="M0 0h60v13.3H0z"/><path fill="#000" d="M0 13.3h60v13.4H0z"/><path fill="#239E46" d="M0 26.7h60v13.3H0z"/><path fill="#fff" d="M30 14l2 5 5-.5-3.8 3.3 1.6 4.8L30 24l-4.8 2.6 1.6-4.8L23 18.5l5 .5z"/>',
  MA:'<path fill="#C1272D" d="M0 0h60v40H0z"/><path fill="none" stroke="#006233" stroke-width="1.6" d="M30 11l2.9 8.9h9.3l-7.5 5.5 2.9 8.9-7.6-5.5-7.6 5.5 2.9-8.9-7.5-5.5h9.3z"/>',
  NL:'<path fill="#AE1C28" d="M0 0h60v13.3H0z"/><path fill="#fff" d="M0 13.3h60v13.4H0z"/><path fill="#21468B" d="M0 26.7h60v13.3H0z"/>',
  NO:'<path fill="#BA0C2F" d="M0 0h60v40H0z"/><path fill="#fff" d="M13 0h12v40H13z"/><path fill="#fff" d="M0 14h60v12H0z"/><path fill="#00205B" d="M16 0h6v40h-6z"/><path fill="#00205B" d="M0 17h60v6H0z"/>',
  PL:'<path fill="#fff" d="M0 0h60v20H0z"/><path fill="#DC143C" d="M0 20h60v20H0z"/>',
  SE:'<path fill="#006AA7" d="M0 0h60v40H0z"/><path fill="#FECC02" d="M15 0h9v40h-9z"/><path fill="#FECC02" d="M0 16h60v8H0z"/>',
  SK:'<path fill="#fff" d="M0 0h60v13.3H0z"/><path fill="#0B4EA2" d="M0 13.3h60v13.4H0z"/><path fill="#EE1C25" d="M0 26.7h60v13.3H0z"/><path fill="#fff" d="M14 8h14v13c0 4.5-3.5 7.5-7 8.8-3.5-1.3-7-4.3-7-8.8z"/><path fill="#EE1C25" d="M21 12.5c1.5 2.5 1 5-.6 7 1.4-.3 2.6-1 3.1-2.2.5 2.5-.5 5-2.5 6.7 3.6-.8 6-4 6-7.5h-6z"/>',
  TN:'<path fill="#E70013" d="M0 0h60v40H0z"/><circle fill="#fff" cx="30" cy="20" r="10"/><path fill="#E70013" d="M26.5 13.7a7 7 0 1 0 0 12.6 5.6 5.6 0 1 1 0-12.6z"/><circle fill="#E70013" cx="32" cy="20" r="2"/>',
  TR:'<path fill="#E30A17" d="M0 0h60v40H0z"/><circle fill="#fff" cx="25" cy="20" r="9"/><circle fill="#E30A17" cx="28" cy="20" r="7.4"/><path fill="#fff" d="M36.5 20l3.4 1.1-2.1-2.9v3.6l2.1-2.9z"/>',
  US:'<path fill="#fff" d="M0 0h60v40H0z"/><path fill="#B22234" d="M0 0h60v3.08H0zM0 6.15h60v3.08H0zM0 12.31h60v3.08H0zM0 18.46h60v3.08H0zM0 24.62h60v3.08H0zM0 30.77h60v3.08H0zM0 36.92h60v3.08H0z"/><path fill="#3C3B6E" d="M0 0h24v21.5H0z"/><circle fill="#fff" cx="4.5" cy="4" r="1"/><circle fill="#fff" cx="11" cy="4" r="1"/><circle fill="#fff" cx="17.5" cy="4" r="1"/><circle fill="#fff" cx="7.8" cy="9.5" r="1"/><circle fill="#fff" cx="14.3" cy="9.5" r="1"/><circle fill="#fff" cx="4.5" cy="15" r="1"/><circle fill="#fff" cx="11" cy="15" r="1"/><circle fill="#fff" cx="17.5" cy="15" r="1"/>'
};
function flagData(cc){
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40">' + FLAG_SVG[cc] + "</svg>");
}
/* Plná značka vlajky: SVG všude (konec závislosti na emoji fontu systému),
   emoji jen jako nouzovka pro kódy zemí, které v mapě nejsou. */
function flagMarkup(cc){
  cc = (cc || "").toUpperCase();
  if(FLAG_SVG[cc]) return '<img class="flag" alt="" src="' + flagData(cc) + '"/>';
  var e = flagEmoji(cc);
  return e ? '<i class="flag">' + e + "</i>" : "";
}
var lastJ = null, lastModels = null, lastForecastId = null;
var predictionsQueued = false;   /* render() běží 2–4× za jednu generaci: predikce do fronty jen jednou */
var metnoStatus = "nedotazováno";
var placeUtcOffset = null;
var placeTimeZone = null;
/* Časy API jsou Unix sekundy (UTC). Pásmo lokality patří jen do zobrazení. */
function forecastDate(t){
  return new Date(typeof t === "number" && isFinite(t) ? t*1000 : NaN);
}
function setPlaceTimeZone(j){
  placeUtcOffset = typeof j.utc_offset_seconds === "number" ? j.utc_offset_seconds : null;
  placeTimeZone = null;
  if(j.timezone){
    try{
      new Intl.DateTimeFormat("cs-CZ", {timeZone:j.timezone}).format(0);
      placeTimeZone = j.timezone;
    }catch(e){ /* offset je nouzová cesta, nikdy pásmo zařízení */ }
  }
}
function placeParts(d){
  var zone = placeTimeZone || "UTC";
  var date = !placeTimeZone && placeUtcOffset != null
    ? new Date(d.getTime() + placeUtcOffset*1000) : d;
  var parts = new Intl.DateTimeFormat("en-GB", {timeZone:zone,
    year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", hourCycle:"h23"}).formatToParts(date);
  var out = {};
  parts.forEach(function(p){ if(p.type !== "literal") out[p.type] = p.value; });
  return out;
}
/* Když je lokalita v jiném pásmu než zařízení, ukázat čas i u tebe. */
function tzHint(d){
  if(!placeTimeZone && placeUtcOffset == null) return "";
  var p = placeParts(d);
  if(+p.year === d.getFullYear() && +p.month === d.getMonth()+1 &&
     +p.day === d.getDate() && +p.hour === d.getHours() && +p.minute === d.getMinutes()) return "";
  var local = d.toLocaleTimeString("cs-CZ",{hour:"2-digit",minute:"2-digit"});
  return "<span class=\"tzhint\">u tebe " + local + "</span>";
}
var CACHE = {}, CACHE_MAX = 200;
/* Úklid cache: každé nové místo dělá nové klíče (souřadnice v URL),
   takže bez úklidu by CACHE rostla donekonečna. Při každém zápisu
   vyhazujeme prošlé záznamy a nad strop i nejstarší. */
function pruneCache(){
  var now = Date.now(), k = Object.keys(CACHE), i;
  for(i=0;i<k.length;i++){
    var e = CACHE[k[i]];
    if(!e || (e.ttl != null && now - e.t >= e.ttl)) delete CACHE[k[i]];
  }
  k = Object.keys(CACHE);
  if(k.length > CACHE_MAX){
    k.sort(function(a,b){ return CACHE[a].t - CACHE[b].t; });
    for(i=0;i<k.length-CACHE_MAX;i++) delete CACHE[k[i]];
  }
}
/* Časový limit pro všechna síťová volání. Zavěšené API jinak nechá
   panel viset v "Načítám" donekonečna — prohlížeč sám vzdává spojení
   až po minutách. Kde AbortController chybí, fallback bez limitu. */
/* ===== Kolo 8aa: měřič přenesených dat (P9) + offline zásoba (P3) =====
   Měřič je čistá diagnostika: bajty se sčítají jen v paměti, ukazatel
   v patičce je defaultně skrytý a odhalí ho třída debugData
   (localStorage bpDebug="1"). Offline zásoba ukládá poslední JSON
   odpovědi do localStorage; při výpadku SÍTĚ (ne při HTTP chybě
   serveru) je cachedJson vrátí a lišta dole přizná jejich stáří. */
var meterData = {total:0, est:0, byHost:{}};
function fmtBytes(n){
  return n >= 1048576 ? (n/1048576).toFixed(1) + " MB"
       : n >= 1024 ? Math.round(n/1024) + " kB" : n + " B";
}
function meterAdd(url, bytes, est){
  if(!(bytes > 0)) return;
  try{
    var host = new URL(url).host;
    meterData.total += bytes;
    if(est) meterData.est += bytes;
    else meterData.byHost[host] = (meterData.byHost[host]||0) + bytes;
    var el = (typeof document !== "undefined") ? $("dataMeter") : null;
    if(el) el.textContent = "přeneseno " + fmtBytes(meterData.total) +
      (meterData.est ? " · dlaždice (odhad) " + fmtBytes(meterData.est) : "") +
      Object.keys(meterData.byHost).map(function(h){
        return " · " + h + " " + fmtBytes(meterData.byHost[h]);
      }).join("");
  }catch(e){}                    /* testovací kontexty bez URL/DOM: nevadí */
}
function fetchT(url, opts, timeoutMs){
  if(typeof AbortController === "undefined") return fetch(url, opts);
  var ac = new AbortController();
  var t = setTimeout(function(){ ac.abort(); }, timeoutMs || 10000);
  var p = fetch(url, Object.assign({}, opts || {}, {signal: ac.signal}));
  function done(){ clearTimeout(t); }
  p.then(done, done);
  return p.then(function(r){
    try{ meterAdd(url, Number(r.headers && r.headers.get("content-length"))); }catch(e){}
    return r;
  });
}
var OFFLINE_KEY = "bpOffline_v1", OFFLINE_MAX = 24, OFFLINE_MAX_JSON = 250000;
function offlineStore(url, t, j){
  try{
    var raw = JSON.stringify(j);
    if(raw.length > OFFLINE_MAX_JSON) return;   /* kvótou localStorage nepálit */
    var o = {};
    try{ o = JSON.parse(localStorage.getItem(OFFLINE_KEY) || "{}"); }catch(e){}
    o[url] = {t:t, d:j};
    var ks = Object.keys(o).sort(function(a,b){ return o[a].t - o[b].t; });
    for(var i=0; i<ks.length-OFFLINE_MAX; i++) delete o[ks[i]];
    localStorage.setItem(OFFLINE_KEY, JSON.stringify(o));
  }catch(e){}                    /* plná kvóta / bez localStorage: nechat být */
}
function offlineStale(t){
  var b = (typeof document !== "undefined") ? $("offlineBar") : null;
  if(!b) return;
  var dt = new Date(t);
  var hh = ("0"+dt.getHours()).slice(-2), mm = ("0"+dt.getMinutes()).slice(-2);
  b.textContent = "Offline · zobrazená data z " + hh + ":" + mm;
  b.classList.add("show");
}
/* Pilíř A (kolo 8ac): volitelná edge proxy na Cloudflare Workers.
   Dokud je BP_PROXY prázdný řetězec, omUrl() vrací přímé URL na
   Open-Meteo — chování aplikace je pak identické s předchozí verzí.
   Po nasazení Workera se sem vloží jeho URL (např.
   "https://bude-prset.vase-subdomena.workers.dev") a proxy se tím
   aktivuje: 1 dotaz na uživatele, cache sdílená napříč všemi
   uživateli, retry a 503 logika na jednom místě.
   Nouzové cesty (retry uvnitř load()) zůstávají vždy přímé — když
   proxy nedopadne, fallback nezávisle trefí samotné Open-Meteo. */
var BP_PROXY = "https://bude-prset-proxy.kopaci-podstavec1q.workers.dev";
function omUrl(host, path, qs){
  return BP_PROXY ? BP_PROXY + "/om" + path + "?" + qs
                  : "https://" + host + path + "?" + qs;
}
function cachedJson(url, ttlMs){
  var c = CACHE[url];
  if(c && (Date.now()-c.t) < ttlMs) return Promise.resolve(c.d);
  return fetchT(url).then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
    .then(function(j){
      CACHE[url] = {t:Date.now(), ttl:ttlMs, d:j}; pruneCache();
      /* offlineStore v izolovaných testovacích kontextech (vm) neexistuje —
         ukládání zálohy je doplněk, nesmí shodit samotné čtení dat. */
      try{ offlineStore(url, CACHE[url].t, j); }catch(e){}
      return j;
    })
    .catch(function(e){
      /* Výpadek sítě ≠ chybná odpověď serveru. HTTP 5xx se šíří dál —
         server přece odpověděl; jen opravdu mrtvou síť zachrání záloha. */
      if(typeof localStorage === "undefined" || !e || /^HTTP /.test(e.message)) throw e;
      var o = null;
      try{ o = JSON.parse(localStorage.getItem(OFFLINE_KEY) || "{}")[url]; }catch(ignored){}
      if(!o) throw e;
      try{ offlineStale(o.t); }catch(e2){}
      return o.d;
    });
}
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
  return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;";
}); }
var cur = null, debounceT = null, selIdx = -1, suggData = [], lastQuery = "";
/* ===== OFFLINE STAV =====
   Panely hlásí chyby každý zvlášť, ale uživatel potřebuje vědět jednu
   věc: přišel o připojení jako celek. Jedna lišta, jeden stav. */
function syncOfflineBar(){
  var b = (typeof document !== "undefined") ? $("offlineBar") : null;
  if(!b) return;
  var off = (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean")
            ? !navigator.onLine : false;
  b.classList.toggle("show", off);
  if(!off) b.textContent = "Jsi offline — zobrazená data můžou být stará";
}
window.addEventListener("online", function(){
  syncOfflineBar();
  /* Po návratu spojení obnovit zastaralá data hned — bez toho by uživatel
     koukal na předpověď z doby, kdy byl offline, až do dalšího cyklu. */
  if(cur && Date.now() - lastFetch >= REFRESH_MS) load(cur, true);
});
window.addEventListener("offline", function(){ syncOfflineBar(); });
syncOfflineBar();
/* Kolo 8aa (P9): měřič přenesených dat se zapíná localStorage bpDebug="1"
   (jinak zůstává skrytý — pro běžného uživatele nula vizuálního šumu). */
try{ if(localStorage.getItem("bpDebug") === "1") document.documentElement.classList.add("debugData"); }catch(e){}

function status(msg){
  var s = $("status");
  if(!msg){ s.classList.remove("show"); return; }
  s.firstElementChild.innerHTML = '<span class="pulse">●</span><br>' + msg;
  s.classList.add("show");
}
function fmtMM(v){
  /* Vždy s nulou před desetinnou tečkou: "0.9", ne ".9" nebo "0.90".
     Hodně desetinných míst zbytečně zabírá místo v buňce tabulky. */
  if(v>=10) return v.toFixed(0);
  if(v>=1) return v.toFixed(1);
  var s = v.toFixed(2);
  return s === "0.00" ? "0" : s.replace(/0$/,"");
}
/* Fyzikální kontrolor: světové extrémy krátkodobé intenzity jsou ~120–300 mm/h.
   Cokoliv nad 150 mm/h nebo záporného/nečíselného je chyba dat → zahodit. */
var MAX_SANE_MMH = 150;
/* ===== DLAŽDICE RAINVIEWERU =====
   Dokumentace uvádí jako nejvyšší dostupný zoom 7. Appka dřív četla na
   zoomu 8, tedy mimo rozsah — dostávala jen dopočítaná data bez jediné
   informace navíc, zato ve čtvrtinovém dosahu. */
var Z_INTENSITY = 7;   /* detail intenzity — nativní maximum */
var Z_MOTION    = 6;   /* odhad pohybu — na naší šířce dosah 75 km, strop 132 km/h */
var Z_NEAR      = 7;   /* zpřesnění pohybu pro blízké buňky — ~0,8 km/px, dosah ~38 km */

/* poslední znak: snow=1 zapne sněhový příznak v datech (viz readTilePatch) */
var RV_OPTS = "/0/0_1.png";

function tileCoords(lat, lon, z){
  var n = Math.pow(2, z);
  var latR = lat*Math.PI/180;
  var xf = (lon+180)/360*n;
  var yf = (1 - Math.log(Math.tan(latR)+1/Math.cos(latR))/Math.PI)/2*n;
  var tx = Math.floor(xf), ty = Math.floor(yf);
  return {z:z, n:n, tx:tx, ty:ty,
          px: Math.floor((xf-tx)*256), py: Math.floor((yf-ty)*256),
          kmPerPx: 40075*Math.cos(latR)/(n*256)};
}
function rvTile(host, path, tc){
  return host + path + "/256/" + tc.z + "/" + tc.tx + "/" + tc.ty + RV_OPTS;
}

/* Dosahuje sem radar? RainViewer na to má vlastní produkt — masku pokrytí.

   POZOR NA OBRÁCENOU LOGIKU: v masce jsou průhledné plochy ty, kde
   radar pokrytí MÁ, a černé ty, kde nedosahuje. Naivní čtení "je tam
   něco nakresleno, takže pokrytí je" dá přesně opačný výsledek.

   Tím padá dřívější odhad "když v okruhu 1000 km není ani jeden odraz,
   radar tam nejspíš není", který na skutečně jasné noci nad velkým
   regionem lhal. Maska se mění zřídka — cache na 24 hodin. */
function readCoverage(host, lat, lon){
  var tc = tileCoords(lat, lon, 5);
  var url = host + "/v2/coverage/0/256/" + tc.z + "/" + tc.tx + "/" + tc.ty + "/0/0_0.png";
  return new Promise(function(resolve){
    var img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function(){
      try{
        var c = document.createElement("canvas");
        c.width = 256; c.height = 256;
        var ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        /* okno ~±3 px kolem obce, ať jeden vadný pixel nerozhodne */
        var x0 = Math.max(0, Math.min(249, tc.px-3)), y0 = Math.max(0, Math.min(249, tc.py-3));
        var d = ctx.getImageData(x0, y0, 7, 7).data;
        var opaque = 0, total = 0;
        for(var i=3; i<d.length; i+=4){ total++; if(d[i] > 128) opaque++; }
        /* většina okna černá (neprůhledná) → radar sem nedosahuje */
        resolve(opaque > total/2 ? "none" : "ok");
      }catch(e){ resolve("error"); }
    };
    img.onerror = function(){ resolve("error"); };
    img.src = url;
  });
}

/* Má tato lokalita SKUTEČNÁ 15minutová data z modelu, nebo jen interpolaci
   z hodinových? Open-Meteo dodává nativní 15min jen z ICON-D2 (střední Evropa),
   AROME (Francie) a HRRR (Severní Amerika). Jinde je "nowcast" jen jinak
   navzorkovaný tentýž hodinový model. Ani nativní řada není nezávislé
   pozorování; příznak slouží jen pro rozlišení dat a jejich váhu. */
function hasNative15min(lat, lon){
  if(lat >= 43.0 && lat <= 58.5 && lon >= -4.0  && lon <= 20.5)  return true;  /* DWD ICON-D2 */
  if(lat >= 37.5 && lat <= 55.5 && lon >= -12.0 && lon <= 16.0)  return true;  /* Météo-France AROME */
  if(lat >= 21.0 && lat <= 53.0 && lon >= -134.0&& lon <= -60.0) return true;  /* NOAA HRRR */
  return false;
}

/* Krátká, poctivá poznámka o tom, čím je předpověď v TÉTO lokalitě omezená.
   Uživatel by neměl dostat stejně sebejistou formulaci tam, kde radar
   nedosahuje a 15min data jsou jen dopočítaná, jako ve střední Evropě. */
function sourceCaveat(){
  var notes = [];
  if(radarCoverage === "none") notes.push("radar sem nedosahuje");
  if(!native15) notes.push("15min data dopočítaná z hodinových");
  return notes.length ? " · " + notes.join(", ") : "";
}

function saneMm(v){
  if(v == null || typeof v !== "number" || isNaN(v) || !isFinite(v)) return null;
  if(v < 0) return 0;
  if(v > MAX_SANE_MMH) return null;
  return v;
}
function fmtHr(d){ var p = placeParts(d); return p.hour + ":" + p.minute; }
/* Úhrn za interval není intenzita. Bez metadat neodhadujeme nulu ani mm/h. */
function precipitationRate(amount, interval, unit){
  if(unit !== "mm" || typeof amount !== "number" || !isFinite(amount) || amount < 0 ||
     typeof interval !== "number" || !isFinite(interval) || interval <= 0) return null;
  return saneMm(amount * 3600 / interval);
}
function parseModelCurrent(j){
  var c = j.current || {}, units = j.current_units || {};
  if(typeof c.time !== "number" || !isFinite(c.time)) throw new Error("bez current.time");
  return {mmh:precipitationRate(c.precipitation, c.interval, units.precipitation),
          code:c.weather_code, snow:saneMm(c.snowfall), t:c.time,
          interval:c.interval, kind:"model", source:"open-meteo-current"};
}
function cap(s){ return s ? s.charAt(0).toUpperCase()+s.slice(1) : s; }
function at(arr, i){ return (arr && arr[i] != null) ? arr[i] : null; }

/* ================= BLÍZKOST VELKÉ VODNÍ PLOCHY (moře / jezero) =================
   U pobřeží a velkých jezer vzniká vlastní místní cirkulace (brízy), která
   často rozhoduje o tom, kde a kdy se spustí odpolední přeháňky — víc, než
   samo velkoprostorové proudění. Detekce běží čistě na pozadí. */
function bearingDeg(lat1, lon1, lat2, lon2){
  var f1=lat1*Math.PI/180, f2=lat2*Math.PI/180, dl=(lon2-lon1)*Math.PI/180;
  var y = Math.sin(dl)*Math.cos(f2);
  var x = Math.cos(f1)*Math.sin(f2) - Math.sin(f1)*Math.cos(f2)*Math.cos(dl);
  return (Math.atan2(y,x)*180/Math.PI + 360) % 360;
}
/* Cca 40 největších jezer/vnitřních moří světa (poloha, hrubý poloměr v km) —
   pokrývá případy, které oceánský vlnový model (níže) nezachytí. */
var LAKES = [
  {n:"Kaspické moře", lat:41.5, lon:50.7, r:230}, {n:"Aralské jezero", lat:45.0, lon:60.0, r:40},
  {n:"Lake Superior", lat:47.7, lon:-87.5, r:80}, {n:"Lake Michigan", lat:44.0, lon:-87.0, r:60},
  {n:"Lake Huron", lat:44.8, lon:-82.4, r:65}, {n:"Lake Erie", lat:42.2, lon:-81.2, r:45},
  {n:"Lake Ontario", lat:43.7, lon:-77.9, r:35}, {n:"Great Bear Lake", lat:65.8, lon:-120.6, r:60},
  {n:"Great Slave Lake", lat:61.5, lon:-114.0, r:55}, {n:"Lake Winnipeg", lat:52.1, lon:-97.9, r:45},
  {n:"Lake Victoria", lat:-1.0, lon:33.0, r:110}, {n:"Lake Tanganyika", lat:-6.0, lon:29.5, r:45},
  {n:"Lake Malawi", lat:-12.0, lon:34.5, r:35}, {n:"Lake Baikal", lat:53.5, lon:108.0, r:40},
  {n:"Lake Balkhash", lat:46.0, lon:74.5, r:45}, {n:"Lake Ladoga", lat:60.9, lon:31.5, r:60},
  {n:"Lake Onega", lat:61.7, lon:35.5, r:45}, {n:"Lake Titicaca", lat:-15.9, lon:-69.3, r:45},
  {n:"Lake Nicaragua", lat:11.6, lon:-85.3, r:45}, {n:"Lake Athabasca", lat:59.1, lon:-110.5, r:45},
  {n:"Issyk-Kul", lat:42.4, lon:77.2, r:35}, {n:"Vänern", lat:58.9, lon:13.5, r:30},
  {n:"Vättern", lat:58.4, lon:14.6, r:25}, {n:"Balaton", lat:46.8, lon:17.7, r:20},
  {n:"Lake Geneva", lat:46.4, lon:6.6, r:20}, {n:"Bodensee", lat:47.6, lon:9.4, r:15},
  {n:"Lake Garda", lat:45.6, lon:10.7, r:12}, {n:"Lake Como", lat:45.9, lon:9.3, r:10},
  {n:"Lake Maggiore", lat:45.9, lon:8.6, r:12}, {n:"Lake Neuchâtel", lat:46.9, lon:6.9, r:12},
  {n:"Great Salt Lake", lat:41.1, lon:-112.5, r:35}, {n:"Lake Tahoe", lat:39.1, lon:-120.0, r:15},
  {n:"Lake Okeechobee", lat:26.9, lon:-80.8, r:20}, {n:"Lake Champlain", lat:44.6, lon:-73.3, r:15},
  {n:"Dead Sea", lat:31.5, lon:35.5, r:15}, {n:"Lake Vostok", lat:77.5, lon:106.8, r:80}
];
function nearestLake(lat, lon){
  var best = null, bestD = 1e9;
  LAKES.forEach(function(L){
    var d = distKm(lat, lon, L.lat, L.lon);
    if(d <= L.r + 20 && d < bestD){ bestD = d; best = {name:L.n, distKm:d, bearingToWaterDeg: bearingDeg(lat,lon,L.lat,L.lon)}; }
  });
  return best;
}
/* Moře/oceán: vzorkujeme oceánský vlnový model ~22 km od obce ve 4 světových
   stranách. Kde model vrátí platnou výšku vlny, tam je otevřená voda. */
function detectSea(lat, lon){
  var dLat = 22/111, dLon = 22/(111*Math.max(0.15, Math.cos(lat*Math.PI/180)));
  var dirs = [{n:"N",lat:lat+dLat,lon:lon,brg:0}, {n:"E",lat:lat,lon:lon+dLon,brg:90},
              {n:"S",lat:lat-dLat,lon:lon,brg:180}, {n:"W",lat:lat,lon:lon-dLon,brg:270}];
  var lats = dirs.map(function(d){ return d.lat.toFixed(3); }).join(",");
  var lons = dirs.map(function(d){ return d.lon.toFixed(3); }).join(",");
  return cachedJson("https://marine-api.open-meteo.com/v1/marine?latitude="+lats+"&longitude="+lons
    + "&hourly=wave_height&forecast_days=1&timeformat=unixtime", 2592000000)   /* pobřeží se nehýbe — cache 30 dní */
    .then(function(res){
      var arr = Array.isArray(res) ? res : [res];
      for(var i=0;i<arr.length;i++){
        var wh = arr[i] && arr[i].hourly && arr[i].hourly.wave_height;
        if(wh && wh.some(function(v){ return v != null; })){
          return {kind:"sea", bearingToWaterDeg: dirs[i].brg, distanceKm: 22};
        }
      }
      return null;
    })
    .catch(function(){ return null; });
}
/* Kombinace: jezero je hned k dispozici (žádný dotaz), moře vyžaduje síťový dotaz. */
function detectNearWater(lat, lon){
  var lake = nearestLake(lat, lon);
  return detectSea(lat, lon).then(function(sea){
    if(lake && sea) return (lake.distKm <= sea.distanceKm) ? {kind:"lake", name:lake.name, bearingToWaterDeg:lake.bearingToWaterDeg} : sea;
    if(lake) return {kind:"lake", name:lake.name, bearingToWaterDeg:lake.bearingToWaterDeg};
    return sea;
  });
}

/* ================= LOKÁLNÍ UČENÍ PŘESNOSTI MODELŮ =================
   Appka si na telefonu (localStorage — nikam se nic neposílá) pamatuje,
   co který model předpověděl, a s odstupem to porovná s realitou přes
   METAR. Nasbírané odchylky pak tiše korigují SOUHRNNÉ výpočty
   (pravděpodobnost, shodu, minutový odhad) — ne čísla v tabulce, ta
   dál ukazují přesně to, co model řekl. Korekce se použije až po
   nasbírání dostatečného vzorku a je omezená na ±30 %. */
/* Verze klíče se zvedla z v1 na v2 ZÁMĚRNĚ.

   Do téhle opravy se appka učila i z tichých bójí, které déšť nehlásí
   nikdy. Každý takový vzorek vypadal jako "model čekal 1 mm, spadlo 0"
   a po patnácti vzorcích faktor dojel na strop 1,3 — předpověď 2,0 mm/h
   se pak uživateli ukázala jako 1,54. Appka déšť potlačovala o 23 %
   a nikde to nebylo vidět.

   Ta nasbíraná čísla se nedají zachránit, protože nejde zpětně poznat,
   který vzorek pocházel z bóje. Proto se začíná načisto: starý klíč se
   přestane číst a zůstane ležet, dokud ho prohlížeč sám neuklidí. */
var BIAS_KEY = "bpBias_v2", PENDING_KEY = "bpPending_v2";
try{ localStorage.removeItem("bpBias_v1"); localStorage.removeItem("bpPending_v1"); }catch(e){}
var BIAS_MIN_SAMPLES = 15, BIAS_MAX_SAMPLES = 40, BIAS_CLAMP = [0.7, 1.3];
var biasVerifiedThisSession = false;

function lsGet(key, fallback){
  try{ var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch(e){ return fallback; }
}
function lsSet(key, val){
  try{ localStorage.setItem(key, JSON.stringify(val)); }
  catch(e){ /* soukromý režim prohlížeče / plné úložiště — tiše ignorovat */ }
}
/* ==== INDEXEDDB — když localStorage nestačí ====
   Fronta predikcí (bpPending) se dá LinkedIn jen stovkami vzorků:
   localStorage má v řádech jednotek MB a každý zápis znamená serializaci
   CELÉ fronty. Ověřování potřebuje tisíce vzorků (každá hodina každé
   lokality = jeden), ať má učení z čeho růst — proto se fronta stěhuje
   do IndexedDB, kde záznamy leží samostatně a limit je v řádech desítek
   MB. Schválně se ale nezavádí "asynchronní lsGet všude": IDB se použije
   JEN pro klíče, které deklarují, že do ní patří (pending fronta);
   malé ručně psané věci (bias faktor, váhy blendu) v localStorage
   zůstávají, protože tam je synchronní čtení jednodušší a rozsah malý.
   Fallback: když IDB není (starý prohlížeč, soukromé okno), jede se
   dál přes localStorage — jen se drží menší limit. */
