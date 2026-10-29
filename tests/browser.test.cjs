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
async function fixture(timezone='America/Los_Angeles',width=1280){
  const ctx=await browser.newContext({timezoneId:timezone,viewport:{width,height:900},serviceWorkers:'block'});
  const p=await ctx.newPage(), errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  const control={pending:[],holdLat:null,failLat:null,failRegional:false,modelRequests:[]};
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
    assert.ok(state.over<=1.02,'horizontal overflow: '+diag);
    assert.ok(state.adjust===true||state.computedAdjust==='100%','chybi text-size-adjust:100%: '+diag);  /* pojistka proti nafouknuti fontu */
    assert.ok(/max-width:\s*100%/.test(state.appRule)&&/min-height:\s*100%/.test(state.appRule),
      'compact #app musi pouzivat procenta, ne vw/dvh: '+diag);
    /* .n je od 29. 10. 2026 cíleně 10,5 px (čitelnost na mobilu); pojistka
       hlídá iOS inflaci (~zdvojnásobení na ~19-21 px), ne přesnou hodnotu. */
    assert.ok(state.font!==null&&state.font<=12,'inflated font: '+diag);
    assert.deepEqual(errors,[],'page errors: '+errors.join(' | '));
  }finally{await ctx.close();}
});
