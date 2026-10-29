const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
let browser, server, base;
const root=path.join(__dirname,'..');
const places={
  Praha:{name:'Praha',latitude:50.08,longitude:14.42,country_code:'CZ'},
  Brno:{name:'Brno',latitude:49.20,longitude:16.61,country_code:'CZ'}
};
before(async()=>{
  server=http.createServer(async(req,res)=>{
    try{
      const file=path.join(root,req.url==='/'?'index.html':req.url.split('?')[0]);
      if(!file.startsWith(root+path.sep)) throw Error('path');
      const data=await fs.readFile(file);
      res.setHeader('Content-Type',file.endsWith('.html')?'text/html':'application/octet-stream');
      res.end(data);
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,channel:'chromium'});
});
after(async()=>{await browser?.close();await new Promise(r=>server?.close(r));});
async function fixture(timezone='America/Los_Angeles',width=1280,height=900){
  const ctx=await browser.newContext({timezoneId:timezone,viewport:{width,height},serviceWorkers:'block'});
  const p=await ctx.newPage(), errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  const control={pending:[],holdLat:null,failLat:null,failRegional:false,dropModel:null,modelRequests:[]};
  const epoch=Math.floor(Date.now()/3600000)*3600;
  const times=Array.from({length:25},(_,i)=>epoch+i*3600);
  await p.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.origin===base) return route.continue();
    const json=body=>route.fulfill({json:body});
    if(u.hostname==='geocoding-api.open-meteo.com'){
      const place=places[u.searchParams.get('name')];
      return json({results:place?[place]:[]});
    }
    if(u.hostname==='ensemble-api.open-meteo.com'){
      const hourly={};
      for(let i=0;i<20;i++)hourly[`precipitation_member${i}`]=[0,1,1,0,0,0,0,0,0];
      return json({hourly});
    }
    if(u.hostname==='api.open-meteo.com' && u.searchParams.has('models')){
      control.modelRequests.push(u.toString());
      const lat=Number(u.searchParams.get('latitude'));
      if(lat===control.holdLat) await new Promise(resolve=>control.pending.push(resolve));
      if(lat===control.failLat) return route.fulfill({status:503,json:{error:true}});
      if(control.failRegional && u.searchParams.get('models').includes('icon_d2'))
        return route.fulfill({status:503,json:{error:true}});
      const hourly={time:times};
      for(const model of u.searchParams.get('models').split(',')){
        if(model===control.dropModel) continue;   /* model bez dat = tiše vypadne */
        hourly[`precipitation_${model}`]=times.map((_,i)=>i===1||i===2?0.8:0);
        hourly[`snowfall_${model}`]=times.map(()=>0);
      }
      return json({timezone:'Europe/Prague',utc_offset_seconds:7200,hourly});
    }
    if(u.hostname==='api.open-meteo.com' && u.searchParams.has('current')){
      return json({timezone:'Europe/Prague',utc_offset_seconds:7200,
        current:{time:epoch,interval:900,precipitation:0.1,weather_code:61,snowfall:0},
        current_units:{precipitation:'mm'},
        minutely_15:{time:times.slice(0,8).map((_,i)=>epoch+i*900),
          precipitation:Array(8).fill(0.1)},
        hourly:{pressure_msl:Array(12).fill(1010),cape:Array(12).fill(0),
          wind_speed_850hPa:Array(12).fill(0)}});
    }
    if(u.hostname==='nominatim.openstreetmap.org' && u.pathname.includes('reverse'))
      return json({address:{city:'Praha',country_code:'cz'}});
    return route.fulfill({status:503,json:{error:'Unavailable in deterministic test'}});
  });
  await p.goto(base,{waitUntil:'domcontentloaded'});
  // Geolocation is denied by default: dismiss the existing help dialog.
  await p.locator('#retryGeo').waitFor({state:'visible'});
  await p.locator('#status').click({position:{x:4,y:4}});
  return {ctx,p,errors,control,epoch};
}
async function search(p,name,enter=false){
  await p.locator('#locInput').fill(name);
  if(enter) await p.locator('#locInput').press('Enter');
  else await p.locator('#locBtn').click();
}
async function ready(p,name){
  await p.waitForFunction(name=>window.cur?.name.startsWith(name)&&window.lastJ&&window.modelState,name);
  await p.locator('#body tr').first().waitFor();
}
test('desktop search, model-only rain, mobile resize and geolocation',async()=>{
  const {ctx,p,errors,control}=await fixture();
  try{
    await search(p,'Praha');
    await ready(p,'Praha');
    await p.waitForFunction(()=>window.modelCurrent?.mmh===0.4);
    assert.ok(control.modelRequests.every(u=>new URL(u).searchParams.get('timeformat')==='unixtime'));
    const before=await p.evaluate(()=>({
      ts:modelState.times[0].getTime(),api:lastJ.hourly.time[0],
      h:fmtHr(modelState.times[0]),mode:whenState.mode,indep:whenState.indep
    }));
    assert.equal(before.ts,before.api*1000);
    assert.equal(before.mode,'maybe');
    assert.equal(before.indep,0);
    assert.match(await p.locator('#whenSub').innerText(),/není potvrzen/);
    await p.setViewportSize({width:375,height:812});
    await p.waitForFunction(()=>NARROW.matches);
    assert.equal(await p.locator('#solo').isVisible(),true);
    assert.match(await p.locator('#soloTalk').innerText(),/Modelový odhad není měření/);
    assert.equal(await p.evaluate(()=>modelState.times[0].getTime()),before.ts);
    await fs.mkdir(path.join(root,'test-results'),{recursive:true});
    await p.screenshot({path:path.join(root,'test-results/mobile.png'),fullPage:true});
    await search(p,'Brno',true);
    await ready(p,'Brno');
    await p.setViewportSize({width:1280,height:900});
    await p.waitForFunction(()=>!NARROW.matches);
    await p.screenshot({path:path.join(root,'test-results/desktop.png'),fullPage:true});
    await ctx.grantPermissions(['geolocation']);
    await ctx.setGeolocation({latitude:50.08,longitude:14.42});
    await p.locator('#pinBtn').click();
    await p.waitForFunction(()=>cur?.lat===50.08&&lastJ);
    assert.deepEqual(errors,[]);
  }finally{await ctx.close();}
});
test('changing location clears old model/terrain while faster supplemental responses arrive',async()=>{
  const {ctx,p,errors,control}=await fixture();
  try{
    await search(p,'Praha');await ready(p,'Praha');
    control.holdLat=49.20;
    await search(p,'Brno');
    await p.waitForFunction(()=>cur?.name.startsWith('Brno')&&modelCurrent?.mmh===0.4);
    const state=await p.evaluate(()=>({lastJ,modelState,verdictState,orogState,
      table:document.getElementById('body').textContent,pill:document.getElementById('soloPillTxt').textContent}));
    assert.equal(state.lastJ,null);
    assert.equal(state.modelState,null);
    assert.equal(state.verdictState,null);
    assert.equal(state.table,'');
    assert.equal(state.pill,'Načítám');
    assert.ok(state.orogState===null||state.orogState==='off'); // new place may already have wind
    control.holdLat=null;
    control.pending.splice(0).forEach(r=>r());
    await ready(p,'Brno');
    assert.deepEqual(errors,[]);
  }finally{control.pending.forEach(r=>r());await ctx.close();}
});
test('old main response arriving after a newer place cannot overwrite it',async()=>{
  const {ctx,p,errors,control}=await fixture();
  try{
    control.holdLat=50.08;
    await search(p,'Praha');
    await p.waitForFunction(()=>cur?.name.startsWith('Praha'));
    // The existing loading status is a modal overlay. Dismiss before another search.
    if(await p.locator('#status.show').count()) await p.locator('#status').click({position:{x:4,y:4}});
    await search(p,'Brno');
    await ready(p,'Brno');
    const generation=await p.evaluate(()=>reqId);
    const oldDone=p.waitForResponse(r=>r.url().includes('models=')&&r.url().includes('latitude=50.08'));
    control.holdLat=null;
    control.pending.splice(0).forEach(r=>r());
    await oldDone;
    assert.equal(await p.evaluate(()=>cur.name.startsWith('Brno')&&lastForecastId===reqId),true);
    assert.equal(await p.evaluate(()=>lastForecastId),generation);
    assert.deepEqual(errors,[]);
  }finally{control.pending.forEach(r=>r());await ctx.close();}
});
test('main forecast failure cannot resurrect previous place after supplement/resize',async()=>{
  const {ctx,p,errors,control}=await fixture();
  try{
    await search(p,'Praha');await ready(p,'Praha');
    control.failLat=49.20;
    await search(p,'Brno');
    await p.waitForFunction(()=>cur?.name.startsWith('Brno')&&document.getElementById('status').textContent.includes('nepodařilo'));
    await p.setViewportSize({width:375,height:812});
    const state=await p.evaluate(()=>({lastJ,modelState,verdictState,table:document.getElementById('body').textContent}));
    assert.equal(state.lastJ,null);
    assert.equal(state.modelState,null);
    assert.equal(state.verdictState,null);
    assert.equal(state.table,'');
    assert.deepEqual(errors,[]);
  }finally{await ctx.close();}
});
test('same forecast instants and location labels in Prague and US browsers',async()=>{
  const results=[];
  for(const zone of ['Europe/Prague','America/Los_Angeles']){
    const {ctx,p,errors}=await fixture(zone);
    try{
      await search(p,'Praha');await ready(p,'Praha');
      results.push(await p.evaluate(()=>({time:modelState.times[0].getTime(),label:fmtHr(modelState.times[0])})));
      assert.deepEqual(errors,[]);
    }finally{await ctx.close();}
  }
  assert.deepEqual(results[0],results[1]);
});
test('global-model fallback also receives and renders Unix timestamps',async()=>{
  const {ctx,p,errors,control}=await fixture();
  try{
    control.failRegional=true;
    await search(p,'Praha');await ready(p,'Praha');
    assert.equal(control.modelRequests.length,2);
    assert.ok(control.modelRequests.every(u=>new URL(u).searchParams.get('timeformat')==='unixtime'));
    assert.equal(await p.evaluate(()=>modelState.times[0].getTime()===lastJ.hourly.time[0]*1000),true);
    assert.deepEqual(errors,[]);
  }finally{await ctx.close();}
});
test('mobile compact layout keeps fonts uninflated and fits one screen without scrolling',async()=>{
  /* Regrese z 29. 10. 2026: (a) iOS Safari (17.4+) nafukuje malé fonty
     ("text autosizing"), kdyz stranka nevyjadri text-size-adjust. Na
     mobilu appka pouziva 8-9,5px fonty, takze si je Safari zdvojnasobilo
     - nazvy modelu se orizly na "ICO…" a layout pretecel, takze fitGuard
     zmensil celu stranku zoomem (obsah vlevo, prazdne pruhy vpravo/dole).
     Fix: html{-webkit-text-size-adjust:100%;text-size-adjust:100%} a
     procenta misto vw/dvh na #app v compactu.
     (b) Od kola 8 musi byt mobil JEDNA obrazovka: zadne posouvani stranky.
     fitGuard hlida krom sirky i vysku a kdyz obsah presahne displej,
     zmensi zoomem celou plochu. Zoom tedy nyni smi byt nenulovy, ALE:
     nesmi zbesit (kdezto inflace fontu zmensila na ~0,5) a cela appka
     se musi vejst do viewportu — hlida se spodni hrana listy souhrnu.
     Tenhle test hlida vsechny casti obou fixu v mobilnim viewportu 375x812. */
  const {ctx,p,errors}=await fixture('Europe/Prague',375);
  try{
    await search(p,'Praha');await ready(p,'Praha');
    /* fitGuard nastavuje zoom az v rAF - pockat na dva snimky, az se layout ustali */
    await p.evaluate(()=>new Promise(res=>requestAnimationFrame(()=>requestAnimationFrame(res))));
    const state=await p.evaluate(()=>{
      const n=document.querySelector('#body tr td.name .n');
      const rules=[...document.styleSheets[0].cssRules].map(r=>r.cssText);
      const css=rules.join('\n');
      /* Chromium serializuje -webkit-text-size-adjust bud s prefixem, nebo
         jako unprefixed text-size-align alias — overime obě podoby. */
      const cs=getComputedStyle(document.documentElement);
      return {
        zoom:document.body.style.zoom,
        over:document.documentElement.scrollWidth/window.innerWidth,
        /* Kolo 8: cela appka se musi vejst na jednu obrazovku — spodni
           hrana listy souhrnu (.stats, posledni prvek) nesmi vylezt
           pod displej. Rect se pocita az po zoomu, takze to meri to,
           co uzivatel fakticky vidi. */
        fits:(function(){const s=document.querySelector('.stats');
          return s?s.getBoundingClientRect().bottom<=window.innerHeight+4:null;})(),
        /* Kolo 8b: popisky listy souhrnu se na mobilu zkracuji (data-short),
           aby se "NEJBLIZSI DEST" nezalamoval — useknuty druhy radek
           vypadal na telefonu jako rozsypany text. Popisek musi byt
           kratky A na jednom radku.
           Kolo 8c: velikosti fontu jsou fluidni skala
           clamp(dolni, X*vw, horni) ukotvena k realnym displejum
           (360-430 px) — a nouzove zmenzeni resi promenna --fit,
           ne zoom (zoom by vw fonty nezmensoval). Na beznych
           telefonech se --fit nesmi spustit vubec, jinak by velikost
           textu byla pri kazdem nacteni jina. */
        k2:(function(){const k=document.querySelectorAll('.stat .k')[1];
          return k?k.textContent:null;})(),
        k2h:(function(){const k=document.querySelectorAll('.stat .k')[1];
          return k?k.getBoundingClientRect().height:null;})(),
        px:(el)=>el?parseFloat(getComputedStyle(el).fontSize):null,
        /* Kolo 8e (screenshot 22:37): nazvy modelu se na prvnim otevreni
           usekaly na „ICO…" — dlouhe nazvy („ICON-D2 · střední Evropa",
           „MET Norway"…) se nevejdou do uzkeho mobilniho sloupce.
           Fix: kratke nazvy (ns) na mobilu + sirsi sloupec. Pojistka:
           ZADNY nazev v prvnim sloupci nesmi byt useknuty — text-overflow
           ellipsis znamena, ze scrollWidth presahuje clientWidth. */
        nfit:(function(){const ns=document.querySelectorAll('#body td.name .n');
          for(const n of ns){ if(n.scrollWidth>n.clientWidth+1) return false; }
          return ns.length?true:null;})(),
        kf:(function(){const k=document.querySelectorAll('.stat .k')[1];
          return k?parseFloat(getComputedStyle(k).fontSize):null;})(),
        vf:(function(){const v=document.querySelectorAll('.stat .v')[1];
          return v?parseFloat(getComputedStyle(v).fontSize):null;})(),
        bigf:(function(){const b=document.getElementById('soloBig');
          return b?parseFloat(getComputedStyle(b).fontSize):null;})(),
        fit:document.documentElement.style.getPropertyValue('--fit'),
        adjust:/(-webkit-)?text-size-adjust:\s*100%/.test(css),
        computedAdjust:cs.getPropertyValue('-webkit-text-size-adjust')||cs.getPropertyValue('text-size-adjust'),
        htmlRule:(rules.find(t=>/^html\s*,\s*body\s*\{/.test(t))||'NO RULE'),
        appRule:(css.match(/html\.compact #app\s*\{[^}]*\}/g)||[]).join(' '),
        noFixedAttach:css.indexOf('background-attachment')===-1,
        font:n?parseFloat(getComputedStyle(n).fontSize):null
      };
    });
    /* Regrese z 29. 10. 2026 (barvy): stavový gradient musi zit na body::before
       (position:fixed), ne na background-attachment:fixed — iOS Safari ho pri
       scrollu kompaktniho rezimu nerespektuje a misto gradientu vykresli bilou
       stranku; prusvitne panely pak vypadaji jako rozbity svetly motiv. */
    const bgBefore=await p.evaluate(()=>getComputedStyle(document.body,'::before').backgroundImage);
    assert.ok(/linear-gradient/.test(bgBefore),'stavovy gradient chybi na body::before: '+bgBefore);
    assert.ok(state.noFixedAttach!==false,'background-attachment:fixed nesmi zpet do CSS');
    const diag=JSON.stringify(state);
    console.log('mobile compact state:',diag);
    /* Kolo 8: zoom smi zmensit obsah jen jako pojistku vysky (mobil je
       jedna obrazovka), nesmi ale zbesit — inflace fontu z regrese (a)
       zmensovala plochu na ~0,5. A lista souhrnu musi byt cela nad
       spodnim okrajem displeje. */
    const z=state.zoom===''?1:parseFloat(state.zoom);
    assert.ok(z>=0.7,'zoom zbesil (regrese inflace fontu?): '+diag);
    assert.ok(state.fits===true,'mobil presahuje obrazovku na vysku — lista souhrnu neni cela videt: '+diag);
    assert.equal(state.k2,'Déšť od','lista souhrnu musi mit na mobilu kratke popisky: '+diag);
    assert.ok(state.k2h!==null&&state.k2h<16,'popisek listy se zalomil na dva radky: '+diag);
    assert.ok(state.over<=1.02,'horizontal overflow: '+diag);
    assert.ok(state.adjust===true||state.computedAdjust==='100%','chybi text-size-adjust:100%: '+diag);  /* pojistka proti nafouknuti fontu */
    assert.ok(/max-width:\s*100%/.test(state.appRule)&&/min-height:\s*100%/.test(state.appRule),
      'compact #app musi pouzivat procenta, ne vw/dvh: '+diag);
    /* .n je od kola 8d cíleně 11,5–13 px (harmonizovaná škála); pojistka
       hlídá iOS inflaci (~zdvojnásobení na ~19-26 px), ne přesnou hodnotu. */
    assert.ok(state.font!==null&&state.font<=14,'inflated font: '+diag);
    /* Kolo 8c+8d: fluidni skala + harmonizace. Na beznych
       telefonech (tady 375x900) se --fit vubec nesmi spustit — velikost
       textu zalezi jen na sirce displeje, takze kazde nacteni vypada
       stejne. Pisma po harmonizaci: popisky >=11 px, hodnoty >=13,4 px,
       hlavni cislo 30-40 px (už ne osamoceně obří ~2,7násobek popisků). */
    assert.equal(state.fit,'','--fit se nadmerne spustil na bezkem telefonu: '+diag);
    assert.ok(state.kf>=11&&state.vf>=13.4&&state.bigf>=30,'mala pisma po zmene skaly: '+diag);
    assert.ok(state.nfit===true,'useknute nazvy modelu (kolo 8e): '+diag);
    assert.deepEqual(errors,[],'page errors: '+errors.join(' | '));
  }finally{await ctx.close();}
});
test('mobile type scale is deterministic and fits on real phone sizes (360-430)',async()=>{
  /* Kolo 8c (Dave): „Nastuduj si velikosti nejznamnejsich telefonu
     a uprav to, at se text vejde akorat do oken — a at velikosti
     nejsou ruznorode pri kazdem nacteni." Realne CSS viewporty
     telefonu na vysku (~95 % mobilnich navstev ma sirku 360-430 px):
       360x740  Galaxy S/A, Pixel a (nejbeznejsi sirka Androidu)
       375x667  iPhone SE (nejkratsi bezna vyska displeje)
       393x852  iPhone 14 Pro / 15 / 16
       430x932  iPhone Plus / Pro Max
     Skala fontu je clamp(dolni, X*vw, horni) ukotvena 360 -> 430 px,
     takze velikost textu zalezi JEN na sirce displeje — nic se
     neprepocitava z obsahu, takze stejny telefon vykresli pri kazdem
     nacteni stejnou velikost. Nouzove --fit smi ubrat jen na kratkem
     displeji (typicky SE) a snizi vsechny velikosti naraz, takze
     pomery layoutu zustanou stejne. */
  const phones=[[360,740],[375,667],[393,852],[430,932]];
  const rows=[];
  for(const [w,h] of phones){
    const {ctx,p,errors}=await fixture('Europe/Prague',w,h);
    try{
      await search(p,'Praha');await ready(p,'Praha');
      await p.evaluate(()=>new Promise(res=>requestAnimationFrame(()=>requestAnimationFrame(res))));
      const s=await p.evaluate(()=>{
        const px=el=>el?parseFloat(getComputedStyle(el).fontSize):null;
        const ks=document.querySelectorAll('.stat .k');
        const vs=document.querySelectorAll('.stat .v');
        const stats=document.querySelector('.stats');
        /* Kolo 8e: zadny nazev modelu nesmi byt useknuty (schema nfit viz vyse) */
        let nfit=null;
        const ns=document.querySelectorAll('#body td.name .n');
        if(ns.length){ nfit=true; for(const n of ns){ if(n.scrollWidth>n.clientWidth+1) nfit=false; } }
        return {
          k:px(ks[1]), v:px(vs[1]),
          n:px(document.querySelector('#body tr td.name .n')),
          big:px(document.getElementById('soloBig')),
          nfit,
          fit:document.documentElement.style.getPropertyValue('--fit'),
          over:document.documentElement.scrollWidth/window.innerWidth,
          fits:stats?stats.getBoundingClientRect().bottom<=window.innerHeight+4:null
        };
      });
      s.w=w; s.h=h; s.errors=errors; rows.push(s);
      const f=s.fit===''?1:parseFloat(s.fit);
      assert.ok(s.over<=1.02,'horizontal overflow na '+w+'px: '+JSON.stringify(s));
      assert.ok(s.fits===true,'appka se nevesla na jednu obrazovku '+w+'x'+h+': '+JSON.stringify(s));
      assert.ok(f>=0.8,'--fit zbesil na '+w+'px: '+JSON.stringify(s));
      /* harmonizovana skala (kolo 8d): prahy pocitane po pripadnem --fit,
         at zustava ctitelnost i na nejkratsim displeji; hlavni cislo
         uz neni 4nasobek popisku, ale ~2,5-2,9násobek */
      assert.ok(s.k>=11*f-0.05&&s.v>=13.4*f-0.05&&s.n>=11.4*f-0.05&&s.big>=30*f-0.05,
        'mala pisma na '+w+'px: '+JSON.stringify(s));
      assert.ok(s.nfit===true,'useknute nazvy modelu na '+w+'px: '+JSON.stringify(s));
      assert.deepEqual(errors,[],'page errors '+w+'px: '+errors.join(' | '));
    }finally{await ctx.close();}
  }
  /* deterministicka skala: vyocene zakladni velikosti (bez --fit) s
     rostouci sirkou displeje jen rostou — na zadnem telefonu nesmi
     skala "skacem" klesnout, jinak by appka vypadala pri ruznych
     sirekach nahodne. */
  const base=rows.map(r=>({w:r.w,k:r.k/(r.fit===''?1:parseFloat(r.fit)),
    v:r.v/(r.fit===''?1:parseFloat(r.fit)),
    n:r.n/(r.fit===''?1:parseFloat(r.fit)),
    big:r.big/(r.fit===''?1:parseFloat(r.fit))}));
  for(let i=1;i<base.length;i++){
    for(const key of ['k','v','n','big']){
      assert.ok(base[i][key]>=base[i-1][key]-0.05,
        'skala "'+key+'" klesa s rostouci sirkou: '+JSON.stringify(base));
    }
  }
  console.log('phone scale:',JSON.stringify(rows));
});
test('model without data gets a note under the table (kolo 8f)',async()=>{
  /* Screenshot 29. 10. 22:47: dorazilo jen 6 z 8 modelů a vypadalo to,
     jako by appka modely sama omezila — chybející řádky jsou tiše.
     Když open-meteo některým modelem neodpoví, musí se pod tabulkou
     objevit poznámka s počtem, a tabulka nesmí vypadat rozbitě
     (žádná useknutá jména ani po zmenšení počtu řádků). */
  const {ctx,p,errors,control}=await fixture('Europe/Prague',393,852);
  try{
    await search(p,'Praha');await ready(p,'Praha');
    await p.evaluate(()=>new Promise(res=>requestAnimationFrame(()=>requestAnimationFrame(res))));
    assert.equal(await p.locator('#mnote').innerText(),'',   /* plná osmička → žádná poznámka */
      'mnote nesmi byt videt, kdyz odpovedi vsech modelu: ');
    const rowsFull=await p.locator('#body tr').count();
    /* ECMWF IFS přestane odpovídat — přesně scénář ze 22:47 */
    control.dropModel='ecmwf_ifs025';
    await search(p,'Brno');await ready(p,'Brno');
    await p.evaluate(()=>new Promise(res=>requestAnimationFrame(()=>requestAnimationFrame(res))));
    const note=await p.locator('#mnote').innerText();
    assert.match(note,/1 z 8 nejbližších modelů neodpověděl/,
      'poznámka o chybějícím modelu se nezobrazila: "'+note+'"');
    /* Pool je záměrně hluboký („rezerva za modely bez dat"): když jeden
       model vypadne, jeho místo v osmičce zaujme další dostupný —
       tabulka tedy zůstane plná a poznámka říká, kdo neodpověděl.
       Hlídáme tedy poznámku + jmenovatel shody, ne počet řádků. */
    const rows1=await p.locator('#body tr').count();
    assert.ok(rows1>0,'tabulka nemuze byt prazdna');
    const shoda=await p.locator('#body tr.consensus td.cell').first().innerText();
    assert.ok(shoda.endsWith('/'+(rows1-1)),
      'shoda musi pocitat jen odpovezene modely: '+shoda);
    const nfit=await p.evaluate(()=>{
      for(const n of document.querySelectorAll('#body td.name .n'))
        if(n.scrollWidth>n.clientWidth+1) return false;
      return true;});
    assert.ok(nfit===true,'useknute nazvy po vypadnuti modelu: ');
    assert.deepEqual(errors,[],'page errors: '+errors.join(' | '));
  }finally{await ctx.close();}
});
