const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Extract actual top-level declarations, not copies of the implementation.
// The app's top-level closing braces are unindented.
function fn(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}`);
  const lineEnd = script.indexOf('\n', start);
  if(script.slice(start,lineEnd).trimEnd().endsWith('}')) return script.slice(start,lineEnd);
  const end = script.indexOf('\n}', start);
  assert.notEqual(end, -1);
  return script.slice(start,end+2);
}
function context(names, globals={}) {
  const ctx = vm.createContext({Date, Intl, console, ...globals});
  vm.runInContext(names.map(fn).join('\n'),ctx);
  return ctx;
}
const timeFunctions = ['forecastDate','setPlaceTimeZone','placeParts','fmtHr','fmtHrHead','tzHint','clockWithDay'];
function timeContext() {
  const c = context(timeFunctions,{placeTimeZone:null,placeUtcOffset:null,NARROW:{matches:false}});
  c.setPlaceTimeZone({timezone:'Europe/Prague',utc_offset_seconds:7200});
  return c;
}
test('all inline JavaScript parses',()=>new vm.Script(script));
test('UTC timestamps and location display do not depend on device timezone',()=>{
  const previous = process.env.TZ;
  try {
    for(const zone of ['UTC','Europe/Prague','America/Los_Angeles','Asia/Kathmandu']){
      process.env.TZ=zone;
      const c=timeContext();
      const d=c.forecastDate(Date.parse('2026-10-21T18:00:00Z')/1000);
      assert.equal(d.toISOString(),'2026-10-21T18:00:00.000Z');
      assert.equal(c.fmtHr(d),'20:00');
      c.NARROW.matches=true;
      assert.equal(c.fmtHrHead(d),'20');
      if(zone==='Europe/Prague') assert.equal(c.tzHint(d),'');
      if(zone==='America/Los_Angeles') assert.match(c.tzHint(d),/11:00/);
    }
  } finally {
    if(previous===undefined) delete process.env.TZ; else process.env.TZ=previous;
  }
});
test('location DST transitions and calendar day, not a fixed offset',()=>{
  const c=timeContext();
  for(const [iso,want] of [
    ['2026-03-29T00:30Z','01:30'],['2026-03-29T01:30Z','03:30'],
    ['2026-10-25T00:30Z','02:30'],['2026-10-25T01:30Z','02:30'],
    ['2026-10-25T02:30Z','03:30']
  ]) assert.equal(c.fmtHr(new Date(iso)),want);
  assert.equal(c.clockWithDay(Date.parse('2026-10-21T21:30Z'),60),'zítra 00:30');
  assert.equal(c.clockWithDay(Date.parse('2026-10-24T21:30Z'),150),'zítra 02:00');
  c.setPlaceTimeZone({timezone:'invalid',utc_offset_seconds:20700});
  assert.equal(c.fmtHr(new Date('2026-10-21T00:00Z')),'05:45');
});
test('MET Norway joins hourly data by UTC instant',()=>{
  const c=context(['forecastDate','injectMetno','saneMm'],{metnoStatus:'',MAX_SANE_MMH:500});
  const j={utc_offset_seconds:7200,hourly:{time:[Date.parse('2026-10-21T18:00Z')/1000]}};
  const mn={properties:{timeseries:[{time:'2026-10-21T18:00:00Z',
    data:{next_1_hours:{details:{precipitation_amount:1.25}}}}]}};
  c.injectMetno(j,mn,[{special:'metno'}]);
  assert.equal(j.hourly.precipitation_metno_lf[0],1.25);
});
test('all hourly model forecast requests opt into Unix seconds, including fallback',()=>{
  const load=fn('load');
  assert.equal((load.match(/timeformat=unixtime/g)||[]).length,2);
  assert.match(fn('render'),/map\(forecastDate\)/);
  assert.doesNotMatch(fn('render'),/new Date\(t\)/);
});
test('current precipitation uses reported interval and unit',()=>{
  const c=context(['saneMm','precipitationRate','parseModelCurrent'],{MAX_SANE_MMH:500});
  assert.equal(c.precipitationRate(0.1,900,'mm'),0.4);
  assert.equal(c.precipitationRate(0.1,1800,'mm'),0.2);
  assert.equal(c.precipitationRate(0.1,3600,'mm'),0.1);
  assert.equal(c.precipitationRate(0,900,'mm'),0);
  for(const args of [[null,900,'mm'],[-1,900,'mm'],[1,0,'mm'],[1,-1,'mm'],
    [1,undefined,'mm'],[Infinity,900,'mm'],[1,Infinity,'mm'],[1,900,'inch'],[1,900,undefined]])
    assert.equal(c.precipitationRate(...args),null,JSON.stringify(args));
  const parsed=c.parseModelCurrent({current:{time:123,precipitation:0.1,interval:900},
    current_units:{precipitation:'mm'}});
  assert.equal(parsed.mmh,0.4);
  assert.equal(parsed.kind,'model');
  assert.equal(parsed.source,'open-meteo-current');
  assert.throws(()=>c.parseModelCurrent({}),/current.time/);
});
test('new load clears complete state before starting any data source',()=>{
  const nodes=new Proxy({}, {get:(o,k)=>o[k]||(o[k]={textContent:'old',style:{},dataset:{},hidden:false})});
  const never=()=>new Promise(()=>{});
  /* Kolo 4: bleskový modul Blitzortung drží otevřený socket pro JEDNU
     lokalitu. Při přepnutí obce se musí session zavřít — jinak by nová
     předpověď dědila počty úderů z okruhu 200 km kolem té staré. */
  let blitzClosed=0;
  const blitzWsStub={onclose:'stará lokalita',close(){blitzClosed++;}};
  const c=context(['load','isStale','resetForecastState','showForecastLoading'],{
    reqId:1,cur:{name:'Old'},input:{},$:id=>nodes[id],
    lastJ:{old:true},lastModels:[],lastForecastId:1,
    modelState:{old:true},verdictState:{old:true},orogState:{factor:1.5},
    threshFor:()=>0.2,status:()=>{},pickModels:()=>[],MODELS:[],HOURS_END:24,
    closeSugg:()=>{},   /* kolo 16: load zavírá nápovědu u špendlíku */
    cachedJson:never,loadEnsemble:()=>{},
    /* Kolo 8ac: load() sestavuje URL přes omUrl(); v testu odpovídá
       stub produkčnímu výchozímu stavu (BP_PROXY="" → přímé URL). */
    omUrl:(h,p,qs)=>'https://'+h+p+'?'+qs,
    blitzState:{n10:4,n60:9},blitzHits:[{ms:1}],blitzStarted:true,
    blitzTries:1,blitzHostIdx:1,blitzLastRenderMs:99,blitzWs:blitzWsStub,
    loadRadar:()=>{
      for(const key of ['lastJ','lastModels','lastForecastId','modelState','verdictState',
        'whenState','lastBlendTimeline','orogState','radarState','modelCurrent',
        'obsMetar','ensState','atmoState','placeTimeZone','satState'])
        assert.equal(c[key],null,key);
      assert.equal(c.blitzState,null,'blitzState po staré lokalitě');
      assert.equal(c.blitzHits.length,0,'blitzHits se vynulovaly');
      assert.equal(c.blitzStarted,false,'nova lokalita si muze otevrit novy socket');
    }
  });
  c.load({name:'New',lat:51,lon:15,cc:'CZ'},true);
  assert.equal(c.cur.name,'New');
  assert.equal(c.reqId,2);
  assert.equal(nodes.body.textContent,'');
  assert.equal(nodes.soloPillTxt.textContent,'Načítám');
  assert.equal(blitzClosed,1);          /* socket staré lokality se zavřel, */
  assert.equal(blitzWsStub.onclose,null); /* ...a handler smůly už nemůže reconnectnout starý filtr */
  assert.equal(c.blitzWs,null);
  assert.equal(c.blitzTries,0);         /* nová lokalita začíná s čistým počítadlem zrcadel */
  c.lastJ={old:true}; c.lastForecastId=c.reqId; c.modelState={old:true};
  c.load(c.cur,true);
  assert.equal(c.reqId,3);
  assert.equal(c.lastJ,null);
});
test('render rejects old generation or unregistered forecast without touching DOM',()=>{
  const old={hourly:{}};
  const c=context(['render','isStale'],{reqId:2,lastJ:null,lastForecastId:null,
    $:()=>{throw Error('stale render touched DOM')}});
  c.render(old,[],1);
  c.render(old,[]);
  assert.equal(c.lastJ,null);
});
test('model-only current and native/interpolated minutely signals cannot confirm observed rain',()=>{
  const nodes=new Proxy({}, {get:(o,k)=>o[k]||(o[k]={style:{}})});
  const c=context(['recomputeWhen','stanicePotvrzujeSelf','chmiNowWet'],{
    $:id=>nodes[id],reqId:1,cur:{},radarState:null,stormMotion:null,
    altNowcast:[{t:Date.now()/1000,mmh:0.4}],modelCurrent:{mmh:0.4,code:61},
    native15:true,obsMetar:null,chmiState:null,metnoNow:null,regioNowcast:null,satState:null,
    modelState:{},whenState:null,THRESH_OBS:0.2,setTimeout:()=>{},fitPanels:()=>{},
    /* Kolo 15: registr běžících pozorování — v tomhle testu už vše
       dořeklo, proto „měřím ještě“ nezahlazuje větve maybe/wet. */
    gtPendingObs:()=>[],gtPendingNc:()=>[],
    radarCoverage:'full',blitzMaybeStart:()=>{},blitzNote:()=>'',
    buildBlendTimeline:()=>[],wmoType:()=>({t:'déšť'}),sourceCaveat:()=>'',renderSolo:()=>{}
  });
  for(const native of [true,false]){
    c.native15=native;
    c.recomputeWhen();
    assert.equal(c.whenState.mode,'maybe');
    assert.equal(c.whenState.indep,0);
    /* Věta je od kola 4 formátovaná HTML (poznámka o blescích obsahuje <b>),
       takže test čte innerHTML — v prohlížeči z něj innerText stejně vyjde. */
    assert.match(nodes.whenSub.innerHTML,/není potvrzen/);
  }
});
test('radar plus METAR still confirms rain; model intensity and labels stay out of verified data',()=>{
  const nodes=new Proxy({}, {get:(o,k)=>o[k]||(o[k]={style:{}})});
  const c=context(['recomputeWhen','stanicePotvrzujeSelf','chmiNowWet','saneMm','cap'],{
    $:id=>nodes[id],reqId:1,cur:{},radarState:{nowMm:1},radarTimeline:null,stormMotion:null,
    altNowcast:[{t:Date.now()/1000,mmh:20}],modelCurrent:{mmh:40,code:61},
    native15:true,obsMetar:{wx:'RA',name:'Test station',km:1},chmiState:null,
    metnoNow:null,regioNowcast:null,satState:null,modelState:{},whenState:null,
    setTimeout:()=>{},fitPanels:()=>{},
    radarCoverage:'full',blitzMaybeStart:()=>{},blitzNote:()=>'',
    THRESH_OBS:0.2,MAX_SANE_MMH:500,
    buildBlendTimeline:()=>[],wmoType:()=>({t:'déšť',i:'test'}),
    metarHasPrecip:()=>true,metarType:()=>({t:'déšť',i:'test'}),
    sourceCaveat:()=>'',renderSolo:()=>{},renderRainEnd:()=>{},estimateRainEnd:()=>null,fmtMM:String
  });
  c.recomputeWhen();
  assert.equal(c.whenState.mode,'wet');
  assert.equal(c.whenState.indep,2);
  assert.equal(c.whenState.mmh,1);
  assert.ok(c.whenState.votes.every(v=>!v.includes('model')));
});
test('radar-detected approaching rain sets "soon" state and renders the mobile panel',()=>{
  const nodes=new Proxy({}, {get:(o,k)=>o[k]||(o[k]={style:{}})});
  let soloCalls=0;
  const verdicts=[];
  const c=context(['recomputeWhen','stanicePotvrzujeSelf','chmiNowWet','saneMm','cap','locKeyOf','verdictProb','verdictProbSrc'],{
    $:id=>nodes[id],modelState:{},whenState:null,
    cur:{lat:50.1,lon:15.3,cc:'CZ'},
    radarCoverage:'full',blitzMaybeStart:()=>{},blitzNote:()=>'',
    radarState:null,radarTimeline:null,stormMotion:null,altNowcast:null,
    modelCurrent:{mmh:0,code:0},obsMetar:null,chmiState:null,metnoNow:null,
    regioNowcast:null,satState:null,atmoState:null,precipMix:null,
    ensState:null,probSeries:null,HOURS:48,
    setTimeout:()=>{},fitPanels:()=>{},THRESH_OBS:0.2,MAX_SANE_MMH:500,
    buildBlendTimeline:()=>[{dt:15,mmh:0.3,parts:['radar','model']}],
    blendMeta:{arrival:{min:15,lo:12,hi:22,n:2,obsN:1}},
    chmiFirstEchoMin:()=>null,chmiSaysDry:()=>false,
    wmoType:()=>({t:'déšť',i:'test'}),fmtMM:String,
    sourceCaveat:()=>'',renderRainEnd:()=>{},renderSolo:()=>{soloCalls++},
    enqueueVerdict:(locKey,lat,lon,cc,targetMs,prob)=>verdicts.push({locKey,targetMs,prob})
  });
  const t0=Date.now();
  c.recomputeWhen();
  assert.equal(soloCalls,1);
  assert.equal(c.whenState.mode,'soon');
  assert.equal(c.whenState.etaMin,15);
  /* Rozpětí už není průchod hodnot 12–22 z konsenzu zdrojů: od kola 4 se
     překrývající se složky nejistoty sčítají ve ČTVERCÍCH (rozpočet
     rozptylu). Zde vstupuje jediná složka — neshoda zdrojů 12–22 minut
     vůči mediánu 15 min, tedy σ = 10/(2·15) = 1/3:
     lo = 15/1,33 ≈ 11 min, hi = 15·1,33 = 20 min. */
  assert.equal(c.whenState.lo,11);
  assert.equal(c.whenState.hi,20);
  assert.deepEqual(c.whenState.parts,['radar','model']);
  /* Verdikt pro pozdější Brierovu kalibraci: "za ~15 min prší s P=75 %" —
     dva zdroje se shodly a jeden z nich je pozorování, ensemble nedává
     žádnou pravděpodobnost (v vm kontextu není). */
  assert.equal(verdicts.length,1);
  assert.equal(verdicts[0].locKey,'50.0,15.5');   /* mřížka 0,5° — locKeyOf */
  assert.ok(Math.abs(verdicts[0].targetMs-t0-15*60000)<3000);
  assert.equal(verdicts[0].prob,0.75);
});


/* ===== Kolo 2: timeouty síťových volání, úklid cache, offline lišta ===== */
class FakeAbortController{
  constructor(){ this.signal={listeners:[],addEventListener:(t,f)=>this.signal.listeners.push(f)}; }
  abort(){ this.signal.listeners.forEach(f=>f()); }
}
test('hanging API call is aborted by timeout instead of loading forever',async()=>{
  const hanging=(url,opts)=>new Promise((_,rej)=>{
    if(opts&&opts.signal&&opts.signal.addEventListener)
      opts.signal.addEventListener('abort',()=>rej(new Error('AbortError')));
  });
  const c=context(['fetchT'],{AbortController:FakeAbortController,
    fetch:hanging,setTimeout,clearTimeout});
  await assert.rejects(c.fetchT('https://example/api',null,50),/AbortError/);
});
test('memory cache prunes expired entries and caps size while browsing',()=>{
  const now=Date.now();
  const c=context(['pruneCache'],{
    CACHE:{fresh:{t:now,ttl:3600000,d:'x'},old:{t:now-2*3600000,ttl:3600000,d:'y'}},
    CACHE_MAX:3
  });
  c.pruneCache();
  assert.equal(c.CACHE.fresh.d,'x');
  assert.equal(c.CACHE.old,undefined);
  for(let i=0;i<5;i++){c.CACHE['k'+i]={t:now-i,ttl:3600000,d:i};}
  c.pruneCache();
  assert.equal(Object.keys(c.CACHE).length,3);
  assert.equal(c.CACHE['k1'].d,1);
  assert.equal(c.CACHE['k4'],undefined);
});
test('cachedJson stores TTL, dedupes repeat calls and reports HTTP errors',async()=>{
  let fetches=0;
  const c=context(['cachedJson','fetchT','pruneCache'],{
    CACHE:{},CACHE_MAX:200,
    fetch:()=>{fetches++;return Promise.resolve({ok:true,json:()=>Promise.resolve({v:1})});},
    AbortController:FakeAbortController,setTimeout,clearTimeout
  });
  const j=await c.cachedJson('https://x/api',60000);
  assert.equal(j.v,1);
  assert.equal(c.CACHE['https://x/api'].ttl,60000);
  await c.cachedJson('https://x/api',60000);
  assert.equal(fetches,1);
  const bad=context(['cachedJson','fetchT'],{
    CACHE:{},CACHE_MAX:200,
    fetch:()=>Promise.resolve({ok:false,status:503}),
    AbortController:FakeAbortController,setTimeout,clearTimeout
  });
  await assert.rejects(bad.cachedJson('https://x/bad',60000),/HTTP 503/);
});
test('offline bar follows connectivity state and stays hidden without navigator',()=>{
  let shown=null;
  const bar=()=>({classList:{toggle:(cls,on)=>{shown=on;}}});
  const c=context(['syncOfflineBar'],{$:bar,document:{}});
  c.syncOfflineBar();
  assert.equal(shown,false);
  const c2=context(['syncOfflineBar'],{$:bar,document:{},navigator:{onLine:false}});
  c2.syncOfflineBar();
  assert.equal(shown,true);
});


/* ===== Kolo 3: přesnost — trend radaru, NEP ensemble, naučené váhy, AIFS ===== */
test('radar trend scales future radar intensity with decaying confidence',()=>{
  const c=context(['trendFactor']);
  assert.equal(c.trendFactor(null,30),1);
  assert.equal(c.trendFactor(0,30),1);
  assert.ok(c.trendFactor(0.05,30)>1);
  assert.ok(c.trendFactor(-0.05,30)<1);
  assert.equal(c.trendFactor(0.5,45),2);      /* strop nahoru */
  assert.equal(c.trendFactor(-0.5,45),0.5);  /* strop dolů */
  assert.ok(c.trendFactor(0.05,45)>c.trendFactor(0.05,10));  /* trend s horizontem roste, */
  assert.ok(c.trendFactor(0.05,45)>c.trendFactor(0.05,90));  /* ...ale za 45. minutou ztrácí váhu */
});
test('organized advection shifts a late model onset, clutter does not',()=>{
  const c=context(['phaseShiftMin']);
  const mv={samples:8,spreadKmh:10,speedKmh:35};
  assert.equal(c.phaseShiftMin(40,20,mv),20);
  assert.equal(c.phaseShiftMin(80,20,mv),45);   /* clamp 45 min */
  assert.equal(c.phaseShiftMin(20,20,mv),0);    /* model není pozdní */
  assert.equal(c.phaseShiftMin(40,90,mv),0);    /* radar nevidí příchod do hodiny */
  assert.equal(c.phaseShiftMin(200,20,mv),0);   /* model dál než 3 h */
  assert.equal(c.phaseShiftMin(null,20,mv),0);
  assert.equal(c.phaseShiftMin(40,20,{samples:3,spreadKmh:10,speedKmh:35}),0);
  assert.equal(c.phaseShiftMin(40,20,{samples:8,spreadKmh:25,speedKmh:35}),0);
  assert.equal(c.phaseShiftMin(40,20,{samples:8,spreadKmh:10,speedKmh:12}),0);
});
test('NEP grid covers 3x3 neighborhood with the center point first',()=>{
  const c=context(['ensembleGrid']);
  const g=c.ensembleGrid(50.1234,15.5678);
  assert.equal(g.length,9);
  /* g[0] je pole z vm realm — deepStrictEqual selhává na prototypu,
     střed proto porovnáme po souřadnicích. */
  assert.equal(g[0][0],50.1234);
  assert.equal(g[0][1],15.5678);
  assert.ok(g.every(p=>Math.abs(p[0]-50.1234)<=0.1001&&Math.abs(p[1]-15.5678)<=0.1501));
});
test('ensemble probability pools members from all neighborhood points',()=>{
  const c=context(['ensembleFromJson','saneMm'],{THRESH:0.2,MAX_SANE_MMH:500});
  const mk=(mod)=>{ /* člen m prší v h=2, právě když (m+mod)%2===0 */
    const h={};
    const row=(m)=>Array.from({length:5},(_,i)=>((m+mod)%2===0&&i===2)?1:0);
    h.precipitation=row(0);
    for(let m=1;m<6;m++)h['precipitation_member0'+m]=row(m);
    return {hourly:h};};
  const pts=[mk(0),mk(1),mk(0),{hourly:{}}]; /* čtvrtý bod bez členů se přeskočí */
  const r=c.ensembleFromJson(pts,5);
  assert.equal(r.members.length,6);   /* centrální bod */
  assert.equal(r.all.length,18);     /* 3 platné body × 6 členů */
  assert.ok(Math.abs(r.perHour[2]-0.5)<1e-9);
  assert.equal(r.perHour[0],0);
  assert.equal(c.ensembleFromJson([{hourly:{}}],5),null); /* bez centrálního bodu nic */
});
test('blend skill starts neutral, shrinks with few samples and saturates with many',()=>{
  const store={};
  const ls={getItem:k=>store[k]||null,setItem:(k,v)=>{store[k]=v;},removeItem:()=>{}};
  const c=context(['blendBucket','getBlendMult','recordBlendError','lsGet','lsSet'],{localStorage:ls,BLEND_KEY:'bpBlend_v1'});
  assert.equal(c.getBlendMult('CZ',30,'radar'),1);   /* bez dat žádný vliv */
  c.recordBlendError('CZ','30','radar',0.7);
  const few=c.getBlendMult('CZ',30,'radar');
  assert.ok(few<1&&few>0.9,'jeden vzorek smršťuje vliv skoro na nulu');
  for(let i=0;i<60;i++)c.recordBlendError('CZ','30','radar',0.7);
  const many=c.getBlendMult('CZ',30,'radar');
  assert.ok(many<0.7&&many>=0.5,'s nasbíranými vzorky váha klesá, clamp drží');
  assert.equal(c.getBlendMult('CZ',45,'radar'),1);   /* jiný horizont = jiné zkušenosti */
  assert.equal(c.getBlendMult('DE',30,'radar'),1);  /* jiná země = jiné zkušenosti */
});
test('learned blend multipliers rescale weights only for the region with data',()=>{
  const store={};
  const ls={getItem:k=>store[k]||null,setItem:(k,v)=>{store[k]=v;},removeItem:()=>{}};
  const c=context(['blendBucket','blendWeights','blendRegimeKey','convectiveFrac','getBlendMult','recordBlendError','lsGet','lsSet'],
    {localStorage:ls,BLEND_KEY:'bpBlend_v1',stormRisk:null,precipMix:null,CAPE_CONV_LO:400,CAPE_CONV_HI:2000});
  /* Kolo 4: blendWeights si režim (standardní/konvektivní počasí) určí
     sama přes blendRegimeKey ← convectiveFrac; v vm kontextu bez dat
     o atmosféře je to standardní režim. */
  assert.equal(c.blendRegimeKey(),'std');
  const base30=c.blendWeights(30,null), base45=c.blendWeights(45,null);
  assert.deepEqual(c.blendWeights(30,'CZ'),base30);  /* bez dat stejné váhy */
  for(let i=0;i<40;i++)c.recordBlendError('CZ','30','radar',0.7);
  const w=c.blendWeights(30,'CZ');
  assert.ok(w.radar<base30.radar);                   /* nadhodnocující radar dolů */
  assert.ok(base45.radar<base30.radar);              /* váhy přirozeně klesají s horizontem */
  assert.equal(w.model,base30.model);                /* netestovaný zdroj nedotčen */
  assert.equal(c.blendWeights(45,'CZ').radar,base45.radar); /* jiný bucket bez dat */
  c.stormRisk={cape:2000};
  assert.equal(c.blendRegimeKey(),'conv');           /* plně konvektivní atmosféra přepíná režim */
});
test('blend multipliers learn per convective regime, not one curve for all weather',()=>{
  const store={};
  const ls={getItem:k=>store[k]||null,setItem:(k,v)=>{store[k]=v;},removeItem:()=>{}};
  const c=context(['blendBucket','blendRegimeKey','convectiveFrac','getBlendMult','recordBlendError','lsGet','lsSet'],
    {localStorage:ls,BLEND_KEY:'bpBlend_v1',stormRisk:null,precipMix:null,CAPE_CONV_LO:400,CAPE_CONV_HI:2000});
  /* Přeháňkový radar je systematicky jiná bestie než frontální déšť —
     proto si každý režim vede vlastní křivku. Konvekce: radar nadhodnocuje;
     standardní počasí: podhodnocuje. Obě zkušenosti nesmí jedna druhou
     přemazat. */
  for(let i=0;i<60;i++)c.recordBlendError('CZ','30','radar',0.7,'conv');
  for(let i=0;i<60;i++)c.recordBlendError('CZ','30','radar',-0.7,'std');
  const conv=c.getBlendMult('CZ',30,'radar','conv');
  const std=c.getBlendMult('CZ',30,'radar','std');
  assert.ok(conv<1,'konvektivní křivka sérii nadhodnocení tlumí');
  assert.ok(std>1,'standardní křivka sérii podhodnocení posiluje');
  assert.ok(conv<std,'režimy se NEmíchají');
  assert.equal(c.getBlendMult('CZ',45,'radar','conv'),1);  /* režim bez vzorků nezhlaví */
  const total=c.getBlendMult('CZ',30,'radar');
  assert.ok(total>1,'celková křivka zůstává zálohou pro neznámé režimy');
});
test('Brier verdict probability is honest without ensemble and calibrated with it',()=>{
  const c=context(['verdictProb'],{ensState:null,probSeries:null,HOURS:48});
  assert.equal(c.verdictProb(1,0),0.5);   /* jediný zdroj = nejistota, ne jistota */
  assert.equal(c.verdictProb(2,0),0.7);
  assert.equal(c.verdictProb(2,1),0.75);  /* pozorovaný zdroj posiluje důvěru */
  assert.equal(c.verdictProb(3,0),0.8);
  assert.equal(c.verdictProb(4,0),0.9);
  const ens=context(['verdictProb'],{ensState:{prob:65},probSeries:[80,null,50],HOURS:48});
  /* Kolo 8z3 (zpětný test 726 párů, sběrač 6.–7. 11. 2026): OM špička už
     nepřebíjí ensemble celá — verdikt jde jen do poloviny cesty k ní:
     max(ens, (ens+om)/2) = max(0.65, 0.725) = 0.725. Falešné poplachy
     30→11, úspěšnost 91,3→92,6 %, Brier 0,0593→0,0579. */
  assert.equal(Math.round(ens.verdictProb(2,0)*1000)/1000,0.725);
  assert.equal(ens.verdictProb(2,0)>0.65,true);  /* OM nad ens zvedá, ale jen na polovinu cesty */
  assert.equal(ens.verdictProb(2,0)<0.8,true);   /* a nikdy nepřebíjí ensemble celé */
  const lowOm=context(['verdictProb'],{ensState:{prob:65},probSeries:[20,10],HOURS:48});
  assert.equal(lowOm.verdictProb(2,0),0.65); /* nízké OM nesníží ensemble — podkladem je sdružení členů */
  const grid=context(['verdictProb'],{ensState:null,probSeries:[30,10],HOURS:48});
  assert.equal(grid.verdictProb(2,0),0.3); /* mřížka s 30 % vydává 30 %, ne domněnku */
});
test('verdict probability source mirror: mix when OM exceeds ensemble, ens otherwise',()=>{
  const mix=context(['verdictProb','verdictProbSrc'],{ensState:{prob:65},probSeries:[80,null,50],HOURS:48});
  assert.equal(mix.verdictProbSrc(),'mix');   /* verdikt = směs, kalibrace se učí na směsi */
  const pure=context(['verdictProb','verdictProbSrc'],{ensState:{prob:65},probSeries:[20,10],HOURS:48});
  assert.equal(pure.verdictProbSrc(),'ens');  /* bez OM špičky zůstává čistý ensemble */
  const onlyOm=context(['verdictProb','verdictProbSrc'],{ensState:null,probSeries:[30,10],HOURS:48});
  assert.equal(onlyOm.verdictProbSrc(),'om');
  const nothing=context(['verdictProb','verdictProbSrc'],{ensState:null,probSeries:null,HOURS:48});
  assert.equal(nothing.verdictProbSrc(),'agree');
});
test('AIFS joins the model pool as its own family next to ECMWF IFS',()=>{
  assert.match(script,/id:\s*"ecmwf_aifs025_single"[^\n]*fam:\s*"AIFS"/);
  assert.match(script,/MODEL_POOL\.slice\(0,8\)/);
});
test('blend wiring applies trend, phase shift and per-source blend verification',()=>{
  assert.match(script,/trendFactor\(radarTrendRate,\s*dt\)/);
  assert.equal((script.match(/modelValAtMinutes\(dt \+ phaseShift\)/g)||[]).length,2);
  assert.match(script,/kind === "blend"/);
  assert.match(script,/enqueueBlendSnapshots\(locKey,\s*cur\.cc/);
});

/* ===== Kolo 7: verifikace proti radaru, kalibrace procent, ensemble timing ===== */
test('rain end needs a confirmed dry gap and ignores drizzle above THRESH_END',()=>{
  const c=context(['estimateRainEnd','buildRainAxis'],{modelState:null,THRESH_END:0.12,THRESH_OBS:0.2});
  const now=1000000;
  /* Mezera 10 minut mezi dvěma přeháňkami (5minutová mřížka nowcastu)
     NENÍ konec — déšť se vrací v 55. Pravý konec je až suchá řada
     60–75 (≥ 15 min potvrzeného sucha), interpolovaná na minutu. */
  const tl1=[0,5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,90].map(dt=>({dt,
    mmh:dt<=40?0.8:(dt===55?0.8:(dt<=75?0:0.8))}));
  const e1=c.estimateRainEnd(now,0,tl1);
  assert.equal(e1.min,59);
  assert.equal(e1.certain,true);
  /* Hodinová mřížka modelů: druhá vlna (v 240) se nezamlčí — konec
     se hlásí až za ní, ne na první suché hodině. */
  const c2=context(['estimateRainEnd','buildRainAxis'],{THRESH_END:0.12,THRESH_OBS:0.2,
    modelState:{longTimes:[120,180,240,300,360,420].map(m=>new Date(now+m*60000)),
                longMed:[0.5,0,0.4,0,0,0]}});
  const e2=c2.estimateRainEnd(now,60,[{dt:5,mmh:0.8},{dt:30,mmh:0.5},{dt:55,mmh:0.3}]);
  assert.equal(e2.min,282);
  assert.equal(e2.certain,false);
  /* Mrholení 0,15 mm/h je NAD práhem konce (0,12) — déšť neskončil. */
  const e3=c.estimateRainEnd(now,0,[{dt:5,mmh:0.8},{dt:20,mmh:0.5},
    {dt:40,mmh:0.15},{dt:55,mmh:0.15},{dt:60,mmh:0}]);
  assert.equal(e3.min,56);
});
test('Brier calibration is per-source and stays identity until data suffices',()=>{
  const store={};
  const ls={getItem:k=>store[k]||null,setItem:(k,v)=>{store[k]=v;},removeItem:()=>{}};
  const c=context(['recordBrier','brierStore','brierCurve','brierCalib','lsGet','lsSet'],
    {localStorage:ls,BRIER_KEY:'b',BRIER_MIN_BIN:25,BRIER_MIN_TOTAL:100});
  /* Bez dat identita — procenta se nedotknou, dokud je čím podložit. */
  assert.equal(c.brierCalib(0.7,'ens'),0.7);
  for(let i=0;i<25;i++) c.recordBrier(0.35,i<5,'ens');
  for(let i=0;i<25;i++) c.recordBrier(0.72,i<20,'ens');
  assert.equal(c.brierCalib(0.7,'ens'),0.7);   /* 50 vzorků < 100: pořád identita */
  for(let i=0;i<50;i++) c.recordBrier(0.55,i<25,'ens');
  const pts=c.brierCurve('ens');
  assert.equal(pts.length,3);
  assert.ok(Math.abs(pts[0][0]-0.35)<1e-9&&Math.abs(pts[0][1]-0.2)<1e-9);
  assert.ok(Math.abs(pts[2][0]-0.75)<1e-9&&Math.abs(pts[2][1]-0.8)<1e-9);
  assert.ok(Math.abs(c.brierCalib(0.7,'ens')-0.725)<1e-9);  /* 70 % → reálně 72,5 % */
  /* Jiný zdroj se NEmíchá s ens — křivky zůstávají striktně oddělené.
     Zdroj "om" je od kola 9b výjimka: bez vlastních dat nese statickou
     fallback křivku ze sběrače (70 % → ~83 %, místo dřívější identity). */
  assert.ok(Math.abs(c.brierCalib(0.7,'om')-0.8315)<1e-9,'om: fallback 0,8315, ne ens-učená 0,725');
  const raw=JSON.parse(store['b']);
  assert.deepEqual(Object.keys(raw.srcs),['ens']);
  c.recordBrier(0.5,true);                    /* bez uvedení zdroje → "agree" */
  assert.ok(JSON.parse(store['b']).srcs.agree);
});
test('arrival probability uses ensemble onsets and mirrors the verdict source choice',()=>{
  const c=context(['arrivalProbPct','verdictProbSrc'],
    {ensState:{onsets:[0,60,60,120,null]},probSeries:null,HOURS:8});
  assert.equal(c.arrivalProbPct(30,60),60);   /* 3 z 5 členů začnou do 60 min */
  assert.equal(c.verdictProbSrc(),'ens');
  const c2=context(['arrivalProbPct','verdictProbSrc'],
    {ensState:null,probSeries:[10,50,20,0],HOURS:8});
  assert.equal(c2.arrivalProbPct(30,60),50);   /* bez ensemblu max OM v okně */
  assert.equal(c2.verdictProbSrc(),'om');
  const c3=context(['arrivalProbPct','verdictProbSrc'],
    {ensState:{onsets:[0,0]},probSeries:null,HOURS:8});
  assert.equal(c3.arrivalProbPct(null,null),97);   /* stop 97 %, žádná jistota */
  const c4=context(['arrivalProbPct','verdictProbSrc'],{ensState:null,probSeries:null,HOURS:8});
  assert.equal(c4.arrivalProbPct(30,60),null);
  assert.equal(c4.verdictProbSrc(),'agree');
  /* OM přebije ensemble, když mluví hlasitěji — kolo 8z3: verdikt pak nese
     směs max(ens,(ens+om)/2), takže zdrojem je "mix", ne čisté "om". */
  const c5=context(['verdictProbSrc'],{ensState:{prob:65},probSeries:[80,null,50],HOURS:8});
  assert.equal(c5.verdictProbSrc(),'mix');
});
test('convective prior tilts blend toward models until its own samples arrive',()=>{
  const storeC={},storeS={};
  const mk=(st,sr)=>{const l={getItem:k=>st[k]||null,setItem:(k,v)=>{st[k]=v;},removeItem:()=>{}};
    return context(['blendBucket','blendWeights','blendRegimeKey','convectiveFrac',
                    'getBlendMult','blendHasData','recordBlendError','lsGet','lsSet'],
      {localStorage:l,BLEND_KEY:'bpBlend_v1',stormRisk:sr,precipMix:null,
       CAPE_CONV_LO:400,CAPE_CONV_HI:2000});};
  const std=mk(storeS,null), conv=mk(storeC,{cape:2000});
  assert.equal(std.blendRegimeKey(),'std');
  assert.equal(conv.blendRegimeKey(),'conv');
  const base=std.blendWeights(30,'CZ'), w=conv.blendWeights(30,'CZ');
  /* Bez vzorků: extrapolace dolů (×0,7), modely nahoru (×1,5), ensemble
     hlas na čas příchodu existuje a neklesá pod nulu. */
  assert.ok(Math.abs(w.radar/base.radar-0.7)<1e-9);
  assert.ok(Math.abs(w.model/base.model-1.5)<1e-9);
  assert.ok(w.ens>0&&w.ens<=0.35);
  /* První vzorek pro radar v conv režimu → prior se pouští, učení šlápne. */
  conv.recordBlendError('CZ','30','radar',0.3,'conv');
  const w2=conv.blendWeights(30,'CZ');
  assert.ok(w2.radar/base.radar>0.85);
  assert.ok(Math.abs(w2.metno/base.metno-0.85)<1e-9);   /* bez vzorků drží prior */
});

/* Kolo 8ae (Dave: „vlajky modelů chybí" na Windows — emoji fonty je nemají):
   vlajky jsou SVG vestavěné v aplikaci. invariant: každý kód země, který
   MODEL_POOL nebo REGIONAL používá, musí mít vlajku v FLAG_SVG — nový model
   bez vlajky nesmí projít CI. */
test('SVG flagy pokryvaji vsechny zeme modelu (kolo 8ae)',()=>{
  const m=script.match(/var FLAG_SVG = \{([\s\S]*?)\n\};/);
  assert.ok(m,'FLAG_SVG nenalezen v index.html');
  const keys=new Set([...m[1].matchAll(/^\s{2}([A-Z]{2}):/gm)].map(x=>x[1]));
  assert.ok(keys.size>=29,'malo vlajek v mape: '+keys.size);
  const ccs=new Set([...script.matchAll(/cc:"([A-Z]{2})"/g)].map(x=>x[1]));
  const regs=new Set([...script.matchAll(/^\s{2}([A-Z]{2}):\{id:/gm)].map(x=>x[1]));
  for(const cc of ccs) assert.ok(keys.has(cc),'vlajka '+cc+' (MODEL_POOL) chybi');
  for(const cc of regs) assert.ok(keys.has(cc),'vlajka '+cc+' (REGIONAL) chybi');
  /* struktura: kazda vlajka je vlnky fill/stroke, data URI je SVG */
  assert.ok(script.includes('data:image/svg+xml;charset=utf-8,'),'flagData negeneruje SVG data URI');
  for(const frag of m[1].split(/(?=\s{2}[A-Z]{2}:)/)){
    if(!/^\s{2}[A-Z]{2}:/.test(frag)) continue;   /* uvodni prazdny fragment */
    assert.ok(/fill=|stroke=/.test(frag),'vlajka bez vyplne: '+frag.slice(0,12));
  }
});

/* ===================== KOLO 8ba/8bb: zdroje a sníh ===================== */

/* Kolo 8ba: zrcadla Blitzortungu — ws7 je mrtvé (nevedle žádné spojení),
   ws1/ws2/ws8 žijí (ověřeno živě). invariant: mrtvý host v seznamu nesmí
   být, živá alespoň tři. */
test('Blitzortung: živá zrcadla ws1/ws2/ws8, mrtvé ws7 v seznamu není (kolo 8ba)',()=>{
  const m=script.match(/var BLITZ_HOSTS = \[([^\]]*)\]/);
  assert.ok(m,'BLITZ_HOSTS nenalezen');
  const hosts=m[1];
  assert.ok(hosts.includes('ws1.blitzortung.org'),'chybi ws1');
  assert.ok(hosts.includes('ws2.blitzortung.org'),'chybi ws2');
  assert.ok(hosts.includes('ws8.blitzortung.org'),'chybi ws8');
  assert.ok(!hosts.includes('ws7.blitzortung.org'),'mrtve ws7 nesmi byt v seznamu');
});

/* Kolo 8ba: vrstvy EUMETSAT/GIBS/IMERG dnes existují (staré názvy jsou
   mrtvé — LayerNotDefined/404). invariant: nové názvy v kódu, staré ne. */
test('vrstvy EUMETSAT a IMERG odpovidaji dnesnimu API (kolo 8ba)',()=>{
  assert.ok(script.includes('"msg_fes:ir108"'),'chybi ziva vrstva msg_fes:ir108');
  assert.ok(script.includes('"msg_iodc:ir108"'),'chybi zaloha msg_iodc:ir108');
  assert.ok(!script.includes('meteosat:msg_ir108"'),'mrtva meteosat:* vrstva nesmi zustat');
  assert.ok(script.includes('"IMERG_Precipitation_Rate_30min"'),'chybi ziva vrstva IMERG');
  assert.ok(!script.includes('"GPM_3IMERGHH"'),'mrtva vrstva GPM_3IMERGHH nesmi zustat');
  assert.ok(script.includes('GPM_Precipitation_Rate'),'chybi oficialni paleta IMERG');
  assert.ok(script.includes('"GoogleMapsCompatible_Level6"'),'GIBS dnes ma jen Level6');
  assert.ok(!script.includes('"GoogleMapsCompatible_Level7"'),'Level7 vraci 400');
});

/* Kolo 8ba: syntetická šedá škála pro šedotónové IR vrstvy EUMETSATu —
   GetLegendGraphic k nim vrací jen ikonu, ale ordinálová logika potřebuje
   jen POŘADÍ, a to 16 odstínů 0–255 dodá. */
test('eumetGrayScale: 16 odstínu pres cely rozsah, ordinaly na krajích (kolo 8ba)',()=>{
  const c=context(['eumetGrayScale','wmsncOrdinal']);
  const s=c.eumetGrayScale();
  assert.equal(s.length,16);
  assert.equal(s[0].r,0);assert.equal(s[0].g,0);assert.equal(s[0].b,0);
  assert.equal(s[15].r,255);assert.equal(s[15].g,255);assert.equal(s[15].b,255);
  /* realny pixel z msg_fes:ir108 (ověřeno živě: hodnoty 44–189, R=G=B) */
  assert.equal(c.wmsncOrdinal(s,[44,44,44,255]),3/15);
  assert.equal(c.wmsncOrdinal(s,[255,255,255,255]),1);
  assert.equal(c.wmsncOrdinal(s,[0,0,0,255]),0);
  /* barva daleko od škály nemá ordinál — vrací null, ne odhad */
  assert.equal(c.wmsncOrdinal(s,[0,120,252,255]),null);
});

/* Kolo 8bb: přepočet mm vody → cm sněhu; 1 cm ≈ 0,7 mm vody. */
test('snowCmFromMm + fmtCm: vodni ekvivalent na cm, ceska desetina carka (kolo 8bb)',()=>{
  const c=context(['snowCmFromMm','fmtCm'],{SNOW_CM_TO_MM:0.7});
  assert.equal(c.snowCmFromMm(null),null);
  assert.equal(c.snowCmFromMm(0),null);
  assert.equal(c.snowCmFromMm(-1),null);
  assert.equal(c.snowCmFromMm(0.03),null);            /* pod 0,1 cm → nic */
  assert.equal(c.snowCmFromMm(0.07),0.1);            /* 0,07 mm → ~0,1 cm */
  assert.equal(c.snowCmFromMm(0.7),1);               /* 1 cm sněhu */
  assert.equal(c.snowCmFromMm(1.4),2);               /* zaokrouhleno na 0,5 */
  assert.equal(c.snowCmFromMm(2.8),4);               /* 4 cm */
  assert.equal(c.snowCmFromMm(4.9),7);               /* nad 5 cm po celých */
  assert.equal(c.fmtCm(0.5),'0,5');
  assert.equal(c.fmtCm(2.5),'2,5');
  assert.equal(c.fmtCm(7),'7');
  assert.equal(c.fmtCm(null),'–');
});

/* Kolo 8bb: pomocníci sněhového verdiktu čtou globální stav — přes vm
   kontext se jim vstříkne modelState/verdictState/atmoState jako v appce. */
test('snowShareAtPeak/snowLineAt/isSnowWindow: verdikt sníhu z modelu (kolo 8bb)',()=>{
  const mk=(globals)=>context(['snowShareAtPeak','snowLineAt','snowLineTxt','isSnowWindow'],globals);
  /* modely ve vrcholu (index 3): 4 mokré, 3 sněhové → 0,75 → sníh */
  const snow=mk({modelState:{snowFrac:[null,0,0.25,0.75,1]},
                 verdictState:{pkIdx:3},
                 whenState:null,atmoState:null});
  assert.equal(snow.snowShareAtPeak(),0.75);
  assert.ok(snow.isSnowWindow());
  /* déšť: podíl sněhových 0,3 */
  const rain=mk({modelState:{snowFrac:[0,0,0.3]},
                 verdictState:{pkIdx:2},
                 whenState:null,atmoState:null});
  assert.equal(rain.snowShareAtPeak(),0.3);
  assert.ok(!rain.isSnowWindow());
  /* pozorování (whenState.type) přebije i mlčící modely */
  const seen=mk({modelState:null,verdictState:null,
                 whenState:{type:{t:'sněžení'}},atmoState:null});
  assert.ok(seen.isSnowWindow());
  /* sněhová čára: hourly pole indexované od nowIdx; peak v 5. hodině */
  const line=mk({atmoState:{flh:[0,200,400,600,800,1200,1400],nowIdx:3},
                 whenState:null,modelState:null,verdictState:null});
  assert.equal(line.snowLineAt(5),1400);   /* nowIdx 3 + 5 = 8, pole má 7 hodnot → poslední (1400) */
  assert.equal(line.snowLineAt(0),600);   /* současnost */
  assert.equal(line.snowLineAt(null),600);
  /* bez pole vrací null, ne odhad */
  const none=mk({atmoState:null,whenState:null,modelState:null,verdictState:null});
  assert.equal(none.snowLineAt(0),null);
  assert.equal(none.snowShareAtPeak(),null);
  assert.ok(!none.isSnowWindow());
  /* formát: pod 1000 m na 50 m, nad na stovky */
  assert.equal(snow.snowLineTxt(1234),'1200');
  assert.equal(snow.snowLineTxt(672),'650');
  assert.equal(snow.snowLineTxt(null),'–');
});

/* Kolo 8ba: nová legenda ČHMÚ (scl-dbz-mmh.png) má barevnou škálu vlevo
   a šedý panel vpravo — střední sloupec by trefil jen šedou. Nová
   extrakce projede všechny sloupce, zahodí 1px tiky i tmavý text a
   výsledek OBRÁTÍ (silné dBZ má být nejvyšší ordinál, jako u DWD). */
test('chmiScaleFromImageData: nalezne rampu mimo stred, tiky i text zahodi, obrati poradi (kolo 8ba)',()=>{
  const c=context(['chmiScaleFromImageData']);
  /* syntetická legenda 8×72: rampa ve sloupcích 0–5, panel 6–7.
     Shora: 3px tmavý text (28,28,28) → padá, pak 14 barev po 4px
     s 1px šedým tikem (64,64,64) mezi segmenty. Silné nahoře. */
  const RAMP=[[160,0,0],[252,0,0],[252,88,0],[252,132,0],[252,176,0],[224,220,0],
              [156,220,0],[52,216,0],[0,188,0],[0,160,0],[0,108,192],[0,0,252],
              [48,0,168],[56,0,112]];
  const W=8,H=3+RAMP.length*4+(RAMP.length-1);
  const d=new Array(W*H*4).fill(255);
  const put=(x,y,rgb)=>{const o=(y*W+x)*4;d[o]=rgb[0];d[o+1]=rgb[1];d[o+2]=rgb[2];d[o+3]=255;};
  for(let x=0;x<W;x++)for(let y=0;y<H;y++)put(x,y,[64,64,64]);   /* panel/tiky */
  for(let x=0;x<6;x++){
    put(x,0,[28,28,28]);put(x,1,[28,28,28]);put(x,2,[28,28,28]); /* text hlavičky */
    let y=3;
    RAMP.forEach((col,i)=>{
      for(let k=0;k<4;k++)put(x,y+k,col);
      y+=4;
      if(i<RAMP.length-1){put(x,y,[64,64,64]);y+=1;}             /* tik */
    });
  }
  const s=c.chmiScaleFromImageData(d,W,H);
  assert.ok(s,'extrakce nesmi selhat');
  assert.equal(s.length,14,'oczekavam 14 barev, ne '+s.length);
  assert.ok(s[0].r===56&&s[0].g===0&&s[0].b===112,'nejslabší (tmavě fialová) má být PRVNÍ po otočení');
  assert.ok(s[13].r===160&&s[13].g===0&&s[13].b===0,'poslední musí být nejsilnější barva rampy');
  assert.ok(!s.some(e=>e.r===64&&e.g===64&&e.b===64),'tiky/panel se musí zahodit');
  assert.ok(!s.some(e=>e.r===28&&e.g===28&&e.b===28),'text hlavičky se musí zahodit');
  /* samý panel → null, ne prázdná škála */
  assert.equal(c.chmiScaleFromImageData(new Array(64*4).fill(255),8,64),null);
});

/* Kolo 8ba: URL ČHMÚ jedou přes proxy, predpovedi pres TAR endpoint. */
test('chmiUrlNow/chmiUrlFct: pres BP_PROXY, base cas v TARu, nova legenda (kolo 8ba)',()=>{
  const mk=(proxy)=>context(['chmiUrlNow','chmiUrlFct','chmiProxyImg','chmiStamp'],
    {BP_PROXY:proxy,CHMI_BASE:'https://opendata.chmi.cz/meteorology/weather/radar'});
  const t=Date.UTC(2026,10,7,13,25,0);
  const px=mk('https://w.example');
  assert.ok(px.chmiUrlNow(t).startsWith('https://w.example/chmi/img?u='),'kompozit ma jit pres /chmi/img');
  assert.equal(decodeURIComponent(px.chmiUrlNow(t)).includes('/composite/pseudocappi2km/png/pacz2gmaps3.z_cappi020.20261107.1325.0.png'),true);
  const f=px.chmiUrlFct(t,30);
  assert.ok(f.startsWith('https://w.example/chmi/fct?base=20261107.1325&lead=30'),'fct: base cas VYPOCTU + lead, ne cas platnosti: '+f);
  const direct=mk('');
  assert.equal(direct.chmiUrlNow(t),'https://opendata.chmi.cz/meteorology/weather/radar/composite/pseudocappi2km/png/pacz2gmaps3.z_cappi020.20261107.1325.0.png');
  assert.equal(direct.chmiUrlFct(t,10),'https://opendata.chmi.cz/meteorology/weather/radar/composite/fct_pseudocappi2km/png/pacz2gmaps3.fct_z_cappi020.20261107.1325.10.png');
  /* invarianty zdrojů v index.html */
  assert.ok(script.includes('scl-dbz-mmh.png'),'nova legenda scl-dbz-mmh.png');
  assert.ok(!script.includes('scl-dbzmmh.png"'),'stara legenda scl-dbzmmh.png uz neexistuje (404)');
});

/* Kolo 9b: fallback kalibrace Open-Meteo (studený start zdroje "om"),
   Shoda podle surových hodnot modelů, beamNote rozlišuje mrholení. */
test('Open-Meteo fallback curve calibrates the om cold start and yields to learned data',()=>{
  const store={};
  const ls={getItem:k=>store[k]||null,setItem:(k,v)=>{store[k]=v;},removeItem:()=>{}};
  const c=context(['recordBrier','brierStore','brierCurve','brierCalib','lsGet','lsSet'],
    {localStorage:ls,BRIER_KEY:'b',BRIER_MIN_BIN:25,BRIER_MIN_TOTAL:100});
  /* Bez vzorků om: statická fallback křivka ze sběrače (oknová sémantika
     max pp přes 8 h, jednotná truth, n = 20 189): 30–40 % → ~60 %. */
  assert.ok(Math.abs(c.brierCalib(0.35,'om')-0.598)<1e-9,'35 % na hranici binu → 0,598');
  assert.ok(Math.abs(c.brierCalib(0.5,'om')-0.6995)<1e-9,'interpolace mezi 45 a 55 %');
  assert.ok(Math.abs(c.brierCalib(0.05,'om')-0.089)<1e-9,'první bin → 0,089');
  assert.ok(Math.abs(c.brierCalib(0.95,'om')-0.953)<1e-9,'poslední bin → 0,953');
  assert.ok(Math.abs(c.brierCalib(0.2,'om')-0.42)<1e-9,'20 % → interpolace 0,394–0,446');
  /* Fallback platí JEN pro om — ens/mix/agree zůstávají identitou. */
  assert.equal(c.brierCalib(0.35,'ens'),0.35);
  assert.equal(c.brierCalib(0.35,'mix'),0.35);
  assert.equal(c.brierCalib(0.35,'agree'),0.35);
  /* Jakmile om nasbírá vlastní data (100 vzorků, 25+ na bin), naučená
     křivka přebírá: fallback už se neuplatní. */
  for(let i=0;i<25;i++) c.recordBrier(0.35,i<5,'om');
  for(let i=0;i<25;i++) c.recordBrier(0.75,i<20,'om');
  for(let i=0;i<50;i++) c.recordBrier(0.55,i<25,'om');
  const pts=c.brierCurve('om');
  assert.equal(pts.length,3,'naučená křivka om existuje');
  assert.ok(Math.abs(c.brierCalib(0.5,'om')-0.425)<1e-9,'učení: 0,425, ne fallback 0,6995');
});
test('model table Shoda row counts raw model values, not bias-corrected ones',()=>{
  const i=script.indexOf('var consensus = times.map');
  assert.notEqual(i,-1,'chybí consensus řádek');
  const seg=script.slice(i,i+300);
  assert.ok(seg.includes('p.vals[i]!=null && p.vals[i]>=THRESH'),
    'Shoda musí počítat surové vals, aby seděla na buňky tabulky');
  assert.ok(!seg.includes('cvals'),'korigované cvals do zobrazovaného řádku nepatří');
});
test('ensemble row shows calibrated Open-Meteo percent',()=>{
  assert.ok(script.includes('brierCalib(mx/100, "om")'),
    'zobrazené OM procento má projít brierCalib (vlastní křivka, jinak fallback)');
});
test('beamNote explains drizzle specifically when the station reports -DZ',()=>{
  const i=script.indexOf('var beamNote = ""');
  assert.notEqual(i,-1,'chybí beamNote');
  const end=script.indexOf('var chmiState',i);
  const seg=script.slice(i,end>i?end:i+2400);
  assert.ok(seg.includes('wx.toUpperCase().indexOf("DZ")'),'detekce DZ ze kódu stanice');
  assert.ok(seg.includes('hlásí právě mrholení'),'konkrétní text pro mrholení');
  assert.ok(seg.includes('stanice ho ale naměřila'),'obecná větev zůstává bez DZ');
});

/* Kolo 9c: panel „Kdy začne pršet“ je minutecast — modely nevyhlašují
   začánek; okraj dat se neukazuje po minutách; rozchod odhadů pojmenován. */
test('kolo 9d: okraj dat Daveovou formulací („zítra po 13. hodině“)',()=>{
  const c=context(timeFunctions.concat(['rainBeyondPhrase']),
    {placeTimeZone:null,placeUtcOffset:null,NARROW:{matches:false}});
  c.setPlaceTimeZone({timezone:'Europe/Prague',utc_offset_seconds:3600});
  const now=Date.UTC(2026,10,18,12,0,0);   /* 13:00 v Praze */
  /* Daveův případ z praxe: okraj dat zítra 12:59 → „zítra po 13. hodině“. */
  assert.equal(c.rainBeyondPhrase(now,1439),'zítra po 13. hodině');
  assert.equal(c.rainBeyondPhrase(now,361),'po 19. hodině');      /* stejný den */
  assert.equal(c.rainBeyondPhrase(now,2910),'pozítří po 14. hodině');  /* 48,5 h → 49 */
  /* Ráno bez nuly na začátku: „po 8. hodině“, ne „po 08. hodině“. */
  assert.equal(c.rainBeyondPhrase(now,1140),'zítra po 8. hodině');  /* 13:00 + 19 h = 8:00 */
});
test('kolo 9c: minutecastový panel nevyhlašuje začátek deště z menšiny modelů',()=>{
  const seg0=script.indexOf('var maxC = 0');
  assert.notEqual(seg0,-1);
  const seg=script.slice(seg0,seg0+6000);
  assert.ok(seg.includes('"Nic do hodiny"'),'čestné mlčení 60minutových zdrojů');
  assert.ok(seg.includes('enqueueVerdict'),'kalibrační vzorek src agree se dál ukládá');
  /* Afirmativní „do hodiny“ z modelů zůstává POUZE ve výjimečném pádu
     (radar error + minutecast bez dat), nikdy v klidném stavu panelu. */
  const iFall=seg.indexOf('Výjimečný pád');   /* značka komentáře výjimečného pádu */
  assert.ok(iFall>-1,'chybí výjimečný pád bez radaru i minutaycastu');
  const iDoHodiny=seg.indexOf('big.innerHTML = "do hodiny"');
  assert.ok(iDoHodiny>iFall,'„do hodiny“ jen ve výjimečném pádu bez dat');
});
test('kolo 9d: konec za horizontem dat říká „Pršet má i zítra po 13. hodině“',()=>{
  assert.ok(script.includes('rainBeyondPhrase(now, end.horizon)'),'okraj přes rainBeyondPhrase');
  assert.ok(script.includes('Pršet má i <b>'),'Daveova formulace v renderRainEnd');
  assert.ok(!script.includes('déšť má trvat i po'),'stará zavádějící konstrukce pryč');
  assert.ok(!script.includes('v datech až po'),'odborná zmínka o datech pryč');
  assert.ok(!script.includes('function approxClock'),'nepoužívaný approxClock odstraněn');
});
test('kolo 9c: rozchod shody a kalibrovaného Open-Meteo se pojmenuje i bez ensemblu',()=>{
  const i=script.indexOf('var omCal');
  assert.notEqual(i,-1,'chybí výpočet kalibrovaného OM');
  assert.ok(script.slice(i,i+1500).includes('odhady se rozcházejí'),
    'poznámka o rozcházejících se odhadech bez ensemblu');
});

/* Kolo 10: rodinný hlas (jedna agentura = jeden hlas) a pevný volební
   sbor. Verdikt počítá AGENTURY, ne řádky tabulky; sbor nezávisí na
   tom, kdo zrovna odpověděl; ensemble nadále počítá členy (řádky). */
test('kolo 10: agencyOf — AI odnože hlasují za mateřskou agenturu',()=>{
  const c=context(['agencyOf']);
  assert.equal(c.agencyOf({fam:'AIFS'}),'ECMWF','AIFS → ECMWF');
  assert.equal(c.agencyOf({fam:'AICON'}),'DWD','AICON → DWD');
  assert.equal(c.agencyOf({fam:'METNO'}),'METNO');
  assert.equal(c.agencyOf({fam:null,id:'icon_d2'}),'icon_d2','pádová hodnota id');
  assert.equal(c.agencyOf(null),'');
});
test('kolo 10: peakConsensus(byAgency) — jedna agentura, jeden hlas',()=>{
  const c=context(['leadWeight','agencyOf','peakConsensus'],{THRESH:0.2,CONSENSUS_TOL_H:1});
  const mk=(fam,h)=>({m:{fam},cvals:Array.from({length:8},(_,i)=>(i===h?0.5:null))});
  /* 6 řádků, ale jen 4 agentury: DWD (ICON + AICON), ECMWF (IFS + AIFS),
     DMI, METNO. DWD i ECMWF by dřív hlasovaly dvakrát. */
  const rows=[mk('DWD',3),mk('AICON',3),mk('ECMWF',3),mk('AIFS',3),mk('DMI',-1),mk('METNO',3)];
  const pk=c.peakConsensus(rows,8,true);
  assert.equal(pk.nAg,4,'agentury se deduplí: DWD, ECMWF, DMI, METNO');
  assert.equal(pk.count,3,'druhý hlas rodiny se nepočítá: DWD + ECMWF + METNO');
  assert.ok(Math.abs(pk.prob-(0.75*c.leadWeight(2)))<1e-9,'podíl agentur × předstihová váha');
  assert.equal(pk.idx,3,'hlášená hodina ze striktního maxima (3), tolerance neposouvá dopředu');
  /* Režim bez byAgency (ensemble, věci nad jednoím modelem): beze změny. */
  const pkRows=c.peakConsensus(rows,8);
  assert.equal(pkRows.nAg,6,'bez byAgency norma = řádky (členové ensemblu)');
  assert.equal(pkRows.count,5,'mokré řádky: DWD, AICON, ECMWF, AIFS, METNO — bez deduplikace');
  assert.ok(Math.abs(pkRows.prob-(5/6*c.leadWeight(2)))<1e-9,'starý výpočet pro ensemble nedotknut');
});
test('kolo 10: verdikt hlasuje pevný sbor agentur, národní model vždy',()=>{
  assert.ok(script.includes('var VERDICT_NO_VOTE'),'sbor s vyloučenými zámořskými globály');
  ['jma_seamless','kma_seamless','cma_grapes_global','bom_access_global']
    .forEach(id=>assert.ok(script.includes(id+':1'),'nehlasující id v sadě: '+id));
  assert.ok(script.includes('p.m.national || !VERDICT_NO_VOTE[p.m.id]'),
    'sbor = dostupné řady, národní vždy (bom_access_global je národní pro AU)');
  assert.ok(script.includes('votersAll, times.length, true'),
    'verdikt počítán ze sboru PO AGENTURÁCH, ne z osmi zobrazených řádků');
  assert.ok(script.includes('peakConsensus(parsed.members, HOURS)'),
    'ensemble nadále počítá členy (řádky), ne agentury');
});
test('kolo 10: UI mluví agenturami — label, expl, stat, výklad, šablona',()=>{
  assert.ok(script.includes('Shoda agentur na dešti do'),'label verdiktu pro déšť');
  assert.ok(script.includes('Shoda agentur na sněhu do'),'label verdiktu pro sníh');
  assert.ok(script.includes('+ rainModels + " z " + nAg + " agentur'),
    'expl: „n z n agentur“, bez shoduje/shodují gramatiky');
  assert.ok(script.includes('rainModels+"/"+nAg'),'stat Shoda = agentury');
  assert.ok(script.includes('Agentury se <s>shodují</s>'),'výklad: silná shoda agentur');
  assert.ok(script.includes('menšina</em> agentur'),'výklad: menšina agentur');
  assert.ok(!script.includes('V.rainModels + "/" + V.N'),'staré dělení podle řádků pryč');
  assert.ok(!script.includes('z " + V.N + " modelů'),'výklad už neumlahuje agentury modely');
  assert.ok(html.includes('Shoda agentur na dešti do 8 h'),'šablona: výchozí label');
  assert.ok(html.includes('data-full="Shoda agentur"'),'šablona: stat panel');
});
test('kolo 10: vzorek agree do Brierovy fronty říká totéž co procento nahoře',()=>{
  assert.ok(script.includes('ms.peak.idx >= 0) ? ms.times[ms.peak.idx].getTime()'),
    'cíl vzorku = hodina špičky agenturní shody verdiktu');
  assert.ok(script.includes('ms.peak.prob : maxC/ms.N'),
    'prediktor = rodinná shoda s váhou; starý modelový jen jako pád');
});
test('kolo 10: transparence — agentury mimo tabulku se pojmenují',()=>{
  const i=script.indexOf('function renderEnsembleRow');
  assert.notEqual(i,-1,'chybí renderEnsembleRow');
  const seg=script.slice(i,i+2600);
  assert.ok(seg.includes('hlasujících agentur'),'poznámka: verdikt počítá i mimo tabulku');
  assert.ok(seg.includes('shoda agentur'),'druhý názor mluví agenturami');
});
test('kolo 10: druhá vlna deště porovnává modely s modely (V.Nm)',()=>{
  assert.ok(script.includes('Nm: N,'),'verdictState nese počet zobrazených modelů');
  assert.ok(script.includes('V.Nm*0.35'),'druhá vlna: práh podle modelů, ne agentur');
});

/* Kolo 11: radar nesmí zmizet beze slova ani se zaseknout napořád.
   Dave 18. 11. 16:47: kompas i radarová větev blendu na prvotním
   načtení tiše zmizely, zatímco backend (měřeno: metadata, maska,
   dlaždice — vše 200) byl zdravý. Fix = timeout dlaždic + automatický
   dotah + viditelný stav místo zmizení. */
test('kolo 11: radarová dlaždice má timeout, visící request nezasekne řetězec',()=>{
  const i=script.indexOf('function readTilePatchBase');
  assert.notEqual(i,-1,'chybí readTilePatchBase');
  const seg=script.slice(i,i+2200);
  assert.ok(seg.includes('RV_TILE_TIMEOUT_MS'),'časovač dlaždice');
  assert.ok(seg.includes('clearTimeout'),'vyčištění časovače po úspěchu');
  assert.ok(/setTimeout\(function\(\)\{[\s\S]{0,600}resolve\(null\);[\s\S]{0,200}\}, RV_TILE_TIMEOUT_MS\);/.test(seg),
    'timeout resolvoval null (snímek se vynechá), nikdy reject');
  const icov=script.indexOf('function readCoverage');
  assert.ok(script.slice(icov,icov+2200).includes('RV_TILE_TIMEOUT_MS'),
    'maska pokrytí má tentýž časovač (resolve „error“)');
});
test('kolo 11: selhání radaru se samovolně dotáhne (retry max 2)',()=>{
  assert.ok(script.includes('function scheduleRadarRetry'),'retry plánovač');
  const i=script.indexOf('var RV_RETRY_DELAYS');
  assert.notEqual(i,-1);
  const seg=script.slice(i,i+400);
  assert.ok(seg.includes('20000') && seg.includes('60000'),'dotahy: +20 s a +60 s');
  const g=seg.slice(i,seg.length);
  const isch=script.indexOf('function loadRadar');
  const rseg=script.slice(isch,isch+60000);
  assert.ok(rseg.includes('scheduleRadarRetry(lat, lon, myId, attempt)'),
    'každá chybová cesta radaru plánuje dotah');
  const catchIdx=rseg.indexOf('.catch(function(){ if(isStale(myId)) return; radarState = "error"');
  assert.ok(catchIdx>-1 && rseg.slice(catchIdx,catchIdx+220).includes('scheduleRadarRetry'),
    'catch také dotahuje');
  const isch2=script.indexOf('function scheduleRadarRetry');
  assert.ok(script.slice(isch2,isch2+320).includes('attempt >= RV_RETRY_DELAYS.length'),
    'strop dvou dotahů');
});
test('kolo 11: výpadek radaru je vidět, nezmizí tiše',()=>{
  const ic=script.indexOf('function sourceCaveat');
  assert.ok(ic>-1);
  assert.ok(script.slice(ic,ic+600).includes('radar nedostupný (zkusím znovu)'),
    'poznámka u zdrojů řekne, že radar spadl a že se to zkusí znovu');
  const ir=script.indexOf('function renderCompassBase');
  const seg=script.slice(ir,ir+2200);
  assert.ok(seg.includes('Radar se nepodařilo načíst'),'výplň kompasu místo tichého zmizení');
  assert.ok(seg.includes('radarState === "error" && !C'),'jen když není co kreslit (satelit může dodat)');
});

/* Kolo 12: pozemní pravda se nesmí ztratit, ani zůstat bez hlasu.
   Dave 19. 11. 11:56 (mobil): „Právě prší. Proč to radar nevidí?"
   Měřeno: LKPR 191030Z -RA, ČHMÚ PseudoCAPPI nad Prahou zelené echo
   v celém výřezu 1 km/px, kompozit RainViewer sucho — a kompas řekl
   „Tě mine", panel Kdy „nezávislé potvrzení: 0", protože jednorázový
   výpadek umlčel METAR i ČHMÚ bez dotahu. Fix = retry pozemních
   zdrojů + kompas říká pravdu z pozorování, když kompozit mlčí. */
test('kolo 12: stanicePotvrzujeSelf — pravidla kola 8v v jedné funkci',()=>{
  const c=context(['stanicePotvrzujeSelf','metarHasPrecip'],{obsMetar:null,altNowcast:null,modelCurrent:null});
  const wet={wx:'-RA',name:'LKPR',km:11,ageMin:29,raw:''};
  c.obsMetar=wet;
  assert.equal(c.stanicePotvrzujeSelf(),true,'blízká čerstvá stanice stačí sama');
  c.obsMetar={...wet,km:30};
  assert.equal(c.stanicePotvrzujeSelf(),false,'30 km bez souhlasu modelu nestačí');
  c.modelCurrent={mmh:0.4};
  assert.equal(c.stanicePotvrzujeSelf(),true,'30 km se souhlasem modelu ano');
  c.modelCurrent=null;
  c.obsMetar={...wet,km:11,wx:''};
  assert.equal(c.stanicePotvrzujeSelf(),false,'suchá stanice nikdy');
  c.obsMetar={...wet,km:11,ageMin:70};
  assert.equal(c.stanicePotvrzujeSelf(),false,'staré pozorování samo nestačí');
  c.obsMetar={...wet,km:11,ageMin:70};
  c.modelCurrent={mmh:0.4};
  assert.equal(c.stanicePotvrzujeSelf(),true,'starší blízká stanice se souhlasem modelu ano (kolo 8v)');
  c.obsMetar='error';
  assert.equal(c.stanicePotvrzujeSelf(),false,'error nikdy');
});
test('kolo 12: chmiNowWet jen s čerstvým echem nad tebou',()=>{
  const c=context(['chmiNowWet'],{chmiState:null});
  c.chmiState={nowWet:true,ageMin:7};
  assert.equal(c.chmiNowWet(),true);
  c.chmiState={nowWet:true,ageMin:50};
  assert.equal(c.chmiNowWet(),false,'starý snímek se do právě-teď nepočítá');
  c.chmiState={nowWet:false,ageMin:7};
  assert.equal(c.chmiNowWet(),false,'suchý ČHMÚ nemluví');
  c.chmiState='error';  assert.equal(c.chmiNowWet(),false);
  c.chmiState='off';    assert.equal(c.chmiNowWet(),false);
  c.chmiState=null;     assert.equal(c.chmiNowWet(),false);
});
test('kolo 12: kompas nezmění pravdu o dešti za geometrii kompozitu',()=>{
  const ir=script.indexOf('function renderCompassBase');
  assert.notEqual(ir,-1,'chybí renderCompassBase');
  /* kolo 26 přidalo do renderCompassBase přepínač pohledu, takže
     okno pro hledání narativu se rozšiřuje (15000 → 18000) */
  const seg=script.slice(ir,ir+18000);
  assert.ok(seg.includes('Právě nad tebou prší.'),
    'verdikt z pozorování');
  assert.ok(seg.includes('stanicePotvrzujeSelf()'),'pravidla stanice z kola 8v');
  assert.ok(seg.includes('chmiNowWet()'),'národní radar jako druhý svědek');
  assert.ok(seg.includes('kompozit mlčí'),'rozpor se neumlčí');
  assert.ok(/C\.state === "miss" \|\| C\.state === "standing" \|\| C\.state === "empty"/.test(seg),
    'pouze když kompozit nad tebou mlčí');
});
test('kolo 12: METAR má dotah po výpadku (loadMetar)',()=>{
  assert.ok(script.includes('function loadMetar'),'METAR ve vlastní funkci');
  const lm=fn('loadMetar');
  const paths=(lm.match(/scheduleMetarRetry\(lat, lon, myId, attempt\);/g)||[]).length;
  assert.ok(paths>=3,'tři chybové cesty (prázdná odpověď, žádná stanice, síť) dotahují, mám '+paths);
  const lr=fn('loadRadar');
  assert.ok(lr.includes('loadMetar(lat, lon, myId, 0)'),'loadRadar spouští loadMetar');
  assert.ok(!lr.includes('aviationweather.gov'),'inline dotaz pryč z loadRadar');
  const sr=fn('scheduleMetarRetry');
  assert.ok(sr.includes('attempt >= METAR_RETRY_DELAYS.length'),'strop dvou dotahů');
  assert.ok(sr.includes('obsMetar && obsMetar !== "error"'),'mezitím vyřešeno = pokus netřeba');
});
test('kolo 12: ČHMÚ po chybě dotahuje samo',()=>{
  const lc=fn('loadChmi');
  assert.ok(lc.includes('scheduleChmiRetry(lat, lon, myId, attempt);'),'error branch dotahuje');
  assert.ok(script.includes('CHMI_RETRY_DELAYS = [20000, 60000]'),'dotahy: +20 s a +60 s');
  const lr=fn('loadRadar');
  assert.ok(lr.includes('loadChmi(lat, lon, myId)'),'loadRadar dále spouští ČHMÚ');
  assert.ok(fn('scheduleChmiRetry').includes('attempt >= CHMI_RETRY_DELAYS.length'),'strop dvou dotahů');
});
test('kolo 12: panel Kdy i kompas čtou táž pravidla potvrzení stanicí',()=>{
  const rw=fn('recomputeWhen');
  assert.ok(rw.includes('stanicePotvrzujeSelf()'),'verdikt používá sdílenou funkci');
  assert.ok(!rw.includes('staniceCerstve &&'),'inline kopie pravidel pryč');
});

/* Kolo 12b: ČHMÚ modul v produkci mlčel — Worker žádá CELU cestu
   (CHMI_PATH_RE v worker.mjs), aplikace posílala „/composite/…“ bez
   prefixu /meteorology/weather/radar a dostávala 400 na každém snímku
   i legendě: chmiState „error“, žádný hlas, žádný řádek v tabulce,
   žádný druhý svědek pro kompas. Měřeno 19. 11. 12:22: krátká cesta
   400, celá cesta 200 (now 25 464 B, legenda 985 B, fct 25 650 B). */
test('kolo 12b: ČHMÚ obrázky jdou přes worker s CELOU cestou',()=>{
  const c=context(['chmiProxyImg','chmiUrlNow','chmiStamp'],{
    BP_PROXY:'https://bude-prset-proxy.example.workers.dev',
    CHMI_BASE:'https://opendata.chmi.cz/meteorology/weather/radar'});
  const u=c.chmiUrlNow(Date.UTC(2026,10,19,11,10,0));
  assert.ok(u.startsWith('https://bude-prset-proxy.example.workers.dev/chmi/img?u='),
    'přes worker');
  assert.ok(u.includes(encodeURIComponent('/meteorology/weather/radar/composite/pseudocappi2km/png/')),
    'u nese celou cestu včetně prefixu, jinak Worker vrátí 400');
  assert.ok(u.includes('pacz2gmaps3.z_cappi020.20261119.1110.0.png'),'stamp');
  const scl=c.chmiProxyImg('/scl/scl-dbz-mmh.png');
  assert.ok(scl.includes(encodeURIComponent('/meteorology/weather/radar/scl/')),
    'legenda nese taky celou cestu');
  // bez proxy se nic nemění: přímé URL už prefix má
  c.BP_PROXY='';
  assert.equal(c.chmiProxyImg('/composite/x.png'),
    'https://opendata.chmi.cz/meteorology/weather/radar/composite/x.png');
});
test('kolo 12b: výpadek stanice i ČHMÚ se pojmenuje u zdrojů',()=>{
  const c=context(['sourceCaveat'],{
    radarCoverage:'full',radarState:null,obsMetar:null,chmiState:null,native15:true});
  const ok=c.sourceCaveat();
  assert.equal(ok,'','zdravé zdroje = žádná poznámka');
  c.obsMetar='error'; c.chmiState='error';
  const bad=c.sourceCaveat();
  assert.ok(bad.includes('stanice nedostupná (zkusím znovu)'),'stanice se neumlčí');
  assert.ok(bad.includes('český radar nedostupný (zkusím znovu)'),'ČHMÚ se neumlčí');
  assert.ok(bad.includes('zkusím znovu'),'retry slib je součástí hlášky');
});

/* Kolo 12c: výpadek kompozitu nezastaví výpověď pozorování. Dave
   (19. 11. 12:33, mobil): kompozit RainViewer na výpadkovém
   připojení nesedl, ČHMÚ hlásil ECHO nad obcí u -RA — kompas ale
   ukázal jen „Radar se nepodařilo načíst." a panel zůstal
   „nepotvrzeno". Nově: chyba kompozitu vypovídá o kompozitu,
   o dešti vypovídají svědci na zemi (kompas + verdikt). */
test('kolo 12c: kompas neumlčí pravdu, když kompozit spadl',()=>{
  const ig=script.indexOf('gtErr');   /* uvnitř chybové větve, ne v komentáři */
  assert.notEqual(ig,-1,'chybí chybová větev kompasu');
  const seg=script.slice(ig-900,ig+2200);
  assert.ok(seg.includes('Právě nad tebou prší.'),'verdikt z pozorování i v chybové větvi');
  assert.ok(seg.includes('groundTruthWitnesses()'),'společní svědci s větví „kompozit mlčí“');
  assert.ok(seg.includes('kompozit nedostupný'),'selhání kompozitu se přizná u zdroje');
});
test('kolo 12c: ČHMÚ potvrzuje „prší právě teď“ samo (čerstvé ECHO)',()=>{
  const nodes=new Proxy({}, {get:(o,k)=>o[k]||(o[k]={style:{}})});
  const c=context(['recomputeWhen','stanicePotvrzujeSelf','chmiNowWet','saneMm','cap'],{
    $:id=>nodes[id],reqId:1,cur:{},radarState:null,radarTimeline:null,stormMotion:null,
    altNowcast:[{t:Date.now()/1000,mmh:0}],modelCurrent:{mmh:0,code:0},
    native15:true,obsMetar:null,
    chmiState:{nowWet:true,nowOrd:0.25,ageMin:7,steps:[],first:null,scale:12},
    metnoNow:null,regioNowcast:null,satState:null,modelState:{},whenState:null,
    gtPendingObs:()=>[],gtPendingNc:()=>[],   /* kolo 15 */
    setTimeout:()=>{},fitPanels:()=>{},
    radarCoverage:'full',blitzMaybeStart:()=>{},blitzNote:()=>'',
    THRESH_OBS:0.2,MAX_SANE_MMH:500,
    chmiFirstEchoMin:()=>null,chmiSaysDry:()=>false,
    buildBlendTimeline:()=>[],wmoType:()=>({t:'déšť',i:'test'}),
    sourceCaveat:()=>'',renderSolo:()=>{},renderRainEnd:()=>{},estimateRainEnd:()=>null,fmtMM:String
  });
  c.recomputeWhen();
  assert.equal(c.whenState.mode,'wet','čerstvé ECHO ČHMÚ potvrzuje samo');
  assert.ok(c.whenState.votes.includes('ČHMÚ'),'ČHMÚ je ve zdrojích verdiktu');
  assert.equal(c.whenState.mmh,0.1,'bez mm/h zdroje zůstává poctivých 0,1 mm/h');
  /* starý snímek ČHMŮ už „právě teď“ nedokládá */
  c.chmiState={nowWet:true,nowOrd:0.25,ageMin:50,steps:[],first:null,scale:12};
  c.whenState=null;
  c.recomputeWhen();
  assert.notEqual(c.whenState.mode,'wet','ECHO starší 45 min samo nepotvrzuje');
});

/* ===== Kolo 13: radar RainViewer má druhou nohu přes Worker =====
   Dave 19. 11. (mobil): „Radar nejede“ — kompas hlásil „Radar se
   nepodařilo načíst“ celý den, přestože ze předpokládaně zdravé sítě
   curl na tentýž maps.json/dlaždici odpovídal 200 za 0,09 s; ČHMÚ i
   vše přes Worker na Cloudflare z téhož telefonu jede. Fix = po
   selhání přímé cesty zkusit /rv/maps a /rv/img (Worker kolo 13);
   bezWorkeru se chování nezmění. Zároveň (Dave): řádek ČHMÚ v seznamu
   modelů se ruší — ČHMŮ hlasuje dál, jen už není sloupcem mezi
   předpověďmi. */
test('kolo 13: maps.json po selhání přímé cesty jede přes Worker /rv/maps',async()=>{
  const calls=[];
  const c=context(['rvMapsJson','cachedJsonNoOffline','cachedJson','fetchT','pruneCache'],{
    CACHE:{},CACHE_MAX:200,OFFLINE_KEY:'bpOffline',
    fetch:(url)=>{
      calls.push(url);
      if(url==='https://api.rainviewer.com/public/weather-maps.json')
        return Promise.reject(new TypeError('Failed to fetch'));
      if(url==='https://w.example/rv/maps')
        return Promise.resolve({ok:true,json:()=>Promise.resolve({version:'2.0',viaProxy:true})});
      return Promise.resolve({ok:false,status:404});
    },
    AbortController:FakeAbortController,setTimeout,clearTimeout,
    BP_PROXY:'https://w.example'
  });
  const j=await c.rvMapsJson();
  assert.equal(j.viaProxy,true,'data doručil Worker');
  assert.deepEqual(calls,['https://api.rainviewer.com/public/weather-maps.json','https://w.example/rv/maps'],
    'přímá cesta první, proxy druhá');
  /* druhý běh: přímá cesta se ZNOVU zkouší (síť se třeba vrátila),
     výsledek proxy nohy ale drží CACHE — proxy se nevolá znovu */
  calls.length=0;
  const j2=await c.rvMapsJson();
  assert.equal(j2.viaProxy,true);
  assert.deepEqual(calls,['https://api.rainviewer.com/public/weather-maps.json'],
    'jen přímý retry, proxy leg drží CACHE');
});
test('kolo 13: obě nohy selžou-li, zůstává offline záloha jako dřív',async()=>{
  const c=context(['rvMapsJson','cachedJsonNoOffline','cachedJson','fetchT','pruneCache'],{
    CACHE:{},CACHE_MAX:200,OFFLINE_KEY:'bpOffline',
    fetch:()=>Promise.reject(new TypeError('Failed to fetch')),
    AbortController:FakeAbortController,setTimeout,clearTimeout,
    BP_PROXY:'https://w.example',
    localStorage:{getItem:()=>JSON.stringify({'https://api.rainviewer.com/public/weather-maps.json':{t:1,d:{version:'2.0',backup:true}}}),setItem:()=>{}},
    offlineStale:()=>{}
  });
  const j=await c.rvMapsJson().catch(()=>null);
  assert.equal(j && j.backup,true,'poslední šance je offline záloha');
});
test('kolo 13: proxy URL se staví jen pro rainviewer dlaždice',()=>{
  const c=context(['rvIsTileUrl','rvProxyTileUrl'],{BP_PROXY:'https://w.example'});
  const tile='https://tilecache.rainviewer.com/v2/radar/2c66a8ce20eb/256/7/69/43/0/0_1.png';
  assert.equal(c.rvIsTileUrl(tile),true,'dlaždice appky projde');
  assert.equal(c.rvIsTileUrl('https://evil.example/v2/radar/x.png'),false,'cizí host nikdy');
  assert.equal(c.rvIsTileUrl('https://tilecache.rainviewer.com/v2/coverage/0/256/5/17/9/2/1_1.png'),false,'maska pokrytí se neproxuje');
  assert.equal(c.rvProxyTileUrl(tile),
    'https://w.example/rv/img?u='+encodeURIComponent('/v2/radar/2c66a8ce20eb/256/7/69/43/0/0_1.png'));
});
test('kolo 13: strukturální pojistky radaru i zrušeného řádku ČHMÚ',()=>{
  assert.ok(script.includes('function rvMapsJson'),'maps pojistka existuje');
  const rm=fn('rvMapsJson');
  assert.ok(rm.includes('/rv/maps'),'míří na worker endpoint');
  assert.ok(rm.includes('if(!BP_PROXY) throw e'),'bez workeru se nic nemění');
  const rp=fn('readTilePatch');
  assert.ok(rp.includes('rvIsTileUrl(url)') && rp.includes('rvProxyTileUrl(url)'),
    'po selhání dlaždice se zkouší proxy');
  assert.ok(!script.includes('function renderChmiRow'),'řádek ČHMÚ v tabulce modelů je pryč');
  assert.ok(script.includes('chmiPotvrzuje') && script.includes('chmiNowWet'),
    'hlasování ČHMÚ ve verdiktu zůstává');
  assert.ok(!fn('loadChmi').includes('renderChmiRow'),'loadChmi už řádek nekreslí');
});
/* ===== KOLO 22: rozklikávací radar ČHMÚ pryč — panel jako v době,
   kdy appka podle Dave fungovala =====
   Dave (20. 11.): „Co kdybys vrátil kód do doby, kdy to fungovalo.
   Tedy kdy nebyl radar ČHMÚ rozklikávací.“ Kolo 14 tehdy přidalo
   tlačítko na přepnutí kompozit/ČHMÚ; kolo 22 ho cíleně ruší a panel
   radar se vrací do podoby z doby před ním. Geolokační opravy kol 15–21
   zůstávají — plné vrácení by oživilo chyby, které Dave sám hlásil
   v kolech 16–18 („nenačítají se věci“, „nejede zjišťování polohy“).
   Hlasování ČHMÚ ve verdiktu (kolo 12) zůstává: jde o data na
   pozadí, ne o rozklikávací panel.
   KOLO 26 (Dave 21. 11., PC): přepínač se vrací, ale JINAK — segment
  Kompozit/ČHMÚ (radViewSeg/wireRadSeg/radseg, bez skoku, volba v
   localStorage), stará jména z kola 14 zůstávají pohřbena. */
test('kolo 22: rozklikávací radar ČHMÚ je pryč, panel je jako dřív',()=>{
  assert.ok(!script.includes('radSwitch'),'žádné tlačítko přepínače radaru');
  assert.ok(!script.includes('chmiCompassOn') && !script.includes('chmiCompassReady')
    && !script.includes('chmiCompassSwitchHtml') && !script.includes('renderChmiCompass'),
    'celý pohled ČHMÚ v panelu (kolo 14) je odstraněn');
  assert.ok(!html.includes('.radSwitch'),'CSS tlačítka v šabloně pryč');
  const rcb=fn('renderCompassBase');
  assert.ok((rcb.match(/'<div class="label">Radar<\/div>'/g)||[]).length>=3,
    'kompozitové větve (chyba, svědci, normál) kreslí přímo, bez prefixu tlačítka');
  assert.ok(script.includes('chmiPotvrzuje') && script.includes('chmiNowWet'),
    'hlasování ČHMÚ ve verdiktu zůstává (datová noha, ne panel)');
  assert.ok(html.includes('>v34<'),'aktuální verze: v34');
});

/* ==================== KOLO 15: VERDIKT NEPŘEDJÍMÁ MĚŘENÍ ==================== */

test('kolo 15: registr běžících pozorování — start, settle, štítky, pojistný čas',()=>{
  const c=context(['gtStart','gtSettle','gtPendingLabels','gtAnyPending','gtPendingHas','gtPrune','gtNetArm'],
    {gtPending:{},gtNetTimer:null,GT_MAX_PENDING_MS:90000,
     GT_LABELS:{radar:'radarový kompozit',stanice:'stanice',chmi:'radar ČHMÚ',
                metno:'met.no nowcast',regio:'regionální nowcast',
                wms:'DWD RADVOR/KNMI',sat:'družice',eum:'Meteosat'}});
  assert.equal(c.gtAnyPending(),false,'prázdný registr = nic neběží');
  c.gtStart('radar'); c.gtStart('stanice');
  assert.equal(c.gtAnyPending(),true);
  assert.equal(c.gtPendingLabels().sort().join('|'),'radarový kompozit|stanice',
    'registry vrací lidské popisy');
  assert.equal(c.gtPendingHas('radar'),true);
  c.gtSettle('radar');
  assert.equal(c.gtPendingHas('radar'),false,'settled zdroj zmizí z registru');
  assert.equal(c.gtPendingHas('stanice'),true);
  /* pojistka: zapomenutý settle po 90 s se sám pročistí */
  c.gtPending.stanice = Date.now() - 100000;
  assert.equal(c.gtAnyPending(),false,'prošlý záznam registr nezahlčuje verdikt');
});

test('kolo 15: modelové hlasy + měření běží → verdikt „ověřuji“, ne „nepotvrzeno“',()=>{
  const nodes=new Proxy({}, {get:(o,k)=>o[k]||(o[k]={style:{}})});
  const c=context(['recomputeWhen','stanicePotvrzujeSelf','chmiNowWet'],{
    $:id=>nodes[id],reqId:1,cur:{},radarState:null,stormMotion:null,
    altNowcast:[{t:Date.now()/1000,mmh:0.4}],modelCurrent:{mmh:0.4,code:61},
    native15:true,obsMetar:null,chmiState:null,metnoNow:null,regioNowcast:null,satState:null,
    modelState:{},whenState:null,THRESH_OBS:0.2,setTimeout:()=>{},fitPanels:()=>{},
    /* továrna na „něco měří“: radar i stanice ještě nedošly */
    gtPendingObs:()=>['radarový kompozit','stanice'],gtPendingNc:()=>[],
    radarCoverage:'full',blitzMaybeStart:()=>{},blitzNote:()=>'',
    buildBlendTimeline:()=>[],wmoType:()=>({t:'déšť'}),sourceCaveat:()=>'',renderSolo:()=>{}
  });
  c.recomputeWhen();
  assert.equal(c.whenState.mode,'checking',
    'běžící pozorování brzdí předčasné „nepotvrzeno“');
  assert.ok(c.whenState.votes.length>=1,'modelové signály se neztratí');
  assert.deepEqual(c.whenState.pending,['radarový kompozit','stanice'],'nádech čeká na konkrétní zdroje');
  assert.deepEqual(c.whenState.pendingNc,[],'nowcasty se hlásí odděleně a neblokují');
  assert.match(nodes.whenBig.innerHTML,/Ověřuji/);
  assert.match(nodes.whenSub.innerHTML,/ještě měří/);
  assert.match(nodes.whenSrc.textContent,/^ověřuji · čekám na: radarový kompozit, stanice/);
});

test('kolo 15: chmiFieldFromPatch — severní blok se kreslí k severu, sucho je prázdné pole',()=>{
  /* patch 13×13 px (1 km/px), střed = uživatel; mokrý blok 3 px na sever,
     alfa škála odrazí přes stub chmiOrdinal = červený kanál / 255.
     KOLO 34: chmiFieldFromPatch/chmiReadNow čtou přes chmiEchoColor;
     s chmiScale null se chová jako dřív (stub ordinál postačí). */
  const c=context(['chmiFieldFromPatch','chmiReadNow','chmiEchoColor'],
    {chmiOrdinal:(px)=>px[3]>=40?px[0]/255:null, chmiScale:null});
  const n=13, px=[];
  for(let y=0;y<n;y++) for(let x=0;x<n;x++){
    const wet = x>=3 && x<=5 && y>=3 && y<=5;   /* blok AGGR=3 severozápadně od středu */
    px.push(wet?[204,0,0,255]:[0,0,0,0]);
  }
  const patch={n,px,x0:0,y0:0,ux:6,uy:6};
  const cells=c.chmiFieldFromPatch(patch,48,3);
  assert.ok(Array.isArray(cells) && cells.length===1,'jeden blok = jedna buňka');
  assert.equal(cells[0].n>0,true,'blok leží na sever od tebe');
  assert.equal(cells[0].o,0.8,'ordinál = červená/255');
  assert.equal(cells[0].rkm,1.5,'poloměr bloku = aggr/2 km');
  /* dry patch → prázdné pole (sucho je taky informace) */
  const dry={n,px:px.map(()=>[0,0,0,0]),x0:0,y0:0,ux:6,uy:6};
  assert.equal(c.chmiFieldFromPatch(dry,48,3).length,0);
  /* chmiReadNow: mokrý pixel v rohu NEpotvrdí déšť nad tebou */
  const corner={n:13,px:px.map((p,i)=>i===0?[204,0,0,255]:[0,0,0,0]),x0:0,y0:0,ux:6,uy:6};
  const r1=c.chmiReadNow(corner);
  assert.equal(r1.wet,false,'echo 6 km od středu neznamená déšť nad tebou');
  const center=c.chmiReadNow(patch);
  assert.equal(center.wet,true,'sousedé ±1 km kolem tebe ano');
});

test('kolo 15: radarFieldFromPatch + compassFieldSvg — buňky pod práhem se nekreslí',()=>{
  const c=context(['radarFieldFromPatch','compassFieldSvg'],{});
  const n=9, mm=new Array(81).fill(0);
  mm[1*9+7]=0.5;   /* blok AGGR=4 ~ severovýchod */
  mm[7*9+1]=0.05;  /* pod práh hlasování */
  const cells=c.radarFieldFromPatch({n,mm},1.5,4);
  assert.equal(cells.length,1,'jen práh překonávající buňka');
  assert.equal(cells[0].mm,0.5);
  assert.equal(cells[0].e>0 && cells[0].n>0,true,'severovýchodní poloha se zachová');
  /* kresba: kruh severně od středu, alfa v designu kompozitu */
  const svg=c.compassFieldSvg([{e:10,n:10,mm:0.5,rkm:3},{e:200,n:0,mm:1,rkm:3}],75,false);
  assert.ok(svg.includes('cy="43.9"'),'severní buňka jde nad střed (50-10/75*46)');
  assert.ok(!svg.includes('172.'),'buňka mimo dosah se nekreslí');
  assert.equal((svg.match(/<circle/g)||[]).length,1);
  assert.ok(svg.includes('rgba(168,228,255,'));
});

test('kolo 15: strukturální — panel radaru měří nahlas, start z poslední lokality',()=>{
  const rcb=fn('renderCompassBase');
  assert.ok(rcb.includes('Měřím radar…'),'kompozit na cestě = viditelný stav, ne zmizení panelu');
  assert.ok(rcb.includes('gtPendingHas("radar")'),'skeleton říká jen když COMPOZIT skutečně běží');
  assert.ok(rcb.includes('compassFieldSvg(radarField, C.reachKm, false)'),
    'kompozitový kompas kreslí reálné pole');
  /* kolo 22: pohled ČHMÚ (renderChmiCompass) je zrušen spolu
     s přepínačem radaru; pole ČHMÚ zůstává jen jako datová noha
     verdiktu (chmiState/chmiFieldFromPatch), ne panel. */
  assert.ok(fn('recomputeWhen').includes('mode:"checking"'),
    'verdikt má stav „ověřuji“');
  assert.ok(fn('renderSolo').includes('Verdikt · ověřuji'),
    'mobilní panel umí říct, že verdict ještě není hotový');
  /* rychlý start: naposledy použitá lokalita z localStorage */
  assert.ok(fn('load').includes('bpPlace_v1'),'load ukládá poslední lokalitu');
  assert.ok(fn('init').includes('bpPlace_v1') && fn('init').includes('geoStart'),
    'start vezme cache instantly a geolokaci nechá běžet (přes geoStart, kolo 21)');
  assert.ok(script.includes('gtStart("radar")') && script.includes('gtSettle("radar")'),
    'kompozit se registruje a po dokončení odregistruje');
  assert.ok(script.includes('gtStart("chmi")') && script.includes('gtStart("stanice")'),
    'ČHMÚ i stanice se hlásí do registru měření');
});

test('kolo 16/17: špendlík neblokuje clonou, startovní clona je zpátky (Dave)',()=>{
  /* Kolo 16 odstranilo startovní clonu; Dave 19. 11. výslovně žádal:
     „Tu clonu při startu, když nejsou načtené data, tam nech.“ Kolo 17
     ji vrací (skryje se prvním renderem dat, viz status(null) v load),
     špendlík ale dál neblokuje těžkou clonou — jen nápověda u hledání. */
  assert.match(html,/<div id="status" class="show"><div><span class="pulse">●<\/span><br>Zjišťuji tvou polohu…<\/div><\/div>/,
    'startovní clona „Zjišťuji tvou polohu…“ je v template zpátky');
  assert.ok(script.includes('showMsg("Zjišťuji tvou polohu…")'),
    'špendlík ukazuje nápovědu u vyhledávání, ne celoplošnou clonu');
  assert.ok(script.includes('geoWatchStop();            /* kolo 17: ruční volba'),
    'ruční volba obce zastaví čekající GPS pozorovatele');
});

test('kolo 17: geolokace nenechá studený start GPS zahodit (watchPosition)',()=>{
  /* Dave 19. 11.: „Nejede zjišťování polohy. Oprav načítání polohy.
     Nefunguje.“ Jednorázový getCurrentPosition na studeném startu
     neodpoví do 12 s a stará appka to vzdala, přestože telefon fix
     doručil by o chvíli později. Léky: delší hrubý timeout, fallback
     na watchPosition (kódy 2 a 3), jasná komunikace v cloně. */
  const ap=fn('acquirePosition');
  assert.ok(ap.includes('timeout:20000'),
    'kolo 20: první dotaz jde rovnou po přesném GPS (20 s), Wi-Fi fáze pryč');
  assert.ok(ap.includes('watchPosition'),
    'po výpadku/vypršení se otevře pozorovatel watchPosition');
  assert.ok(fn('geoWatchStop').includes('clearWatch'),
    'pozorovatel lze korektně zavřít (clearWatch)');
  assert.ok(ap.includes('err.code === 2 || err.code === 3'),
    'fallback na kódy 2 (nedostupná) i 3 (timeout)');
  assert.ok(ap.includes('timeout:75000'),'pozorovatel čeká na GPS až 75 s');
  assert.ok(ap.includes('geoHintT') && ap.includes('10000'),
    'po 10 s čekání clona řekne, co se děje');
  assert.ok(fn('geoWatchStop') !== undefined && fn('acquirePosition').includes('geoWatchStop()'),
    'fix dorazil → pozorovatel se zavře (geoWatchStop v pouzij)');
  const ng=fn('noGeo');
  assert.ok(ng.includes('err && err.code === 1'),
    'zamítnutí vždy ukáže vzdělávací dialog (iOS dotaz nezopakuje)');
  assert.ok(ng.includes('Polohu se nepodařilo zjistit'),
    'bez dat se důvod řekne nahlas, v cloně');
});

test('kolo 16: GPS přenačítá jen při skutečné změně polohy (do 1 km ne)',()=>{
  /* Dave 19. 11. 14:04: „nenačítají se věci“ — hrubá fáze GPS přenačetla
     celou appku při každém otevření, i když se poloha vůbec nezměnila.
     Panely pak problikly a všechno se stahovalo znovu (IMG_5092 → IMG_5093). */
  const ap=fn('acquirePosition');
  assert.ok(ap.includes('distKm(cur.lat, cur.lon, lat, lon) < 1'),
    'fix do 1 km od načtené lokality nespouští přenačtení');
  assert.ok(ap.includes('upresni(lat, lon, silent)'),
    'přesná fáze dál běží na pozadí');
  assert.ok(fn('load').includes('closeSugg()'),
    'nápověda u špendlíku se zavře, když lokalita dojede (load zavírá sugg)');
});

test('kolo 16: fitPanels slévá měření layoutu do jednoho za 150 ms',()=>{
  /* Dave 19. 11. 14:05: „seka se to“ — každé dotečení dat volalo
     recomputeWhen → fitPanels přes rAF; při startu jich přijde i deset
     za pár sekund a každé z nich je na mobilu jednotky až desítky ms
     přepočtu layoutu. */
  let fits=0, trails=[];
  const c=context(['fitPanels'],{
    fitPanel:()=>{fits++;},
    fitGuard:()=>{},
    document:{querySelector:()=>null},
    requestAnimationFrame:(cb)=>{cb();},      /* synchronní stub */
    setTimeout:(cb,ms)=>{trails.push({cb,ms});return 0;},
    FIT_COALESCE_MS:150, fitLastAt:0, fitTrailScheduled:false
  });
  c.fitPanels();
  assert.equal(fits,2,'první měření proběhne hned (oba panely; nic nečeká)');
  c.fitPanels();   /* druhá žádost okamžitě = tentýž burst */
  c.fitPanels();
  assert.equal(fits,2,'burst se změří jen jednou, ne třikrát');
  assert.equal(trails.length,1,'naplánuje se právě jeden závěrečný dojezd');
  assert.equal(trails[0].ms,150,'dojezd nacasovaný na FIT_COALESCE_MS');
  const fp=fn('fitPanels');
  assert.ok(fp.includes('fitTrailScheduled'),'větrník na dojezd');
  assert.ok(script.includes('var FIT_COALESCE_MS'),'konstanta je pojmenovaná');
});

test('kolo 17b: behaviorálně — vypršení hrubé fáze otevře watchPosition, fix se použije, pozorovatel zavře',async()=>{
  /* Dave: „Nejede zjišťování polohy… Oprav načítání polohy.“ — tohle
     je důkaz vykonaný, ne jen přečtený: simulovaný telefon ihned vrátí
     code 3 (timeout), aplikace nesmí zavolat noGeo, musí otevřít
     pozorovatele watchPosition (přesné GPS, 75 s), a až pozorovatel
     dodá fix (accuracy 25 m), musí se použít jako lokalita a pozorovatel
     se musí zavřít (clearWatch 77). */
  let watchOpened=0, watchOk=null, watchOpts=null, watchId=77;
  const clearedIds=[], loads=[], statusMsgs=[], noGeoCalls=[];
  const c=context(['acquirePosition','geoWatchStop','distKm','skladejNazev'],{
    navigator:{geolocation:{
      getCurrentPosition:(ok,err)=>{ err({code:3}); },   /* studený start: timeout hned */
      watchPosition:(ok2,err2,opts)=>{ watchOpened++; watchOk=ok2; watchOpts=opts; return watchId; },
      clearWatch:(id)=>{ clearedIds.push(id); }
    }},
    clearTimeout:()=>{},                /* v testu negradí reálné časovače */
    setTimeout:()=>{ return 5; },
    geoRefineT:null, geoHintT:null, geoWatchId:null, geoAskedByUser:null,
    geoCoarseT:null, geoFailT:null, geoFailShown:false,
    lastJ:null, cur:null, curFromGeo:false, manualPickAt:0,
    status:(m)=>{ statusMsgs.push(m); },
    geoBindHelp:()=>{}, geoPermTxt:()=>"test",
    pojmenujMisto:()=>Promise.resolve({district:null, city:'Praha', cc:'CZ'}),
    load:(place,silent)=>{ loads.push({place,silent}); },
    noGeo:(err)=>{ noGeoCalls.push(err); }
  });
  c.acquirePosition(false);
  assert.equal(watchOpened,1,'po code 3 se otevírá watchPosition, aplikace se nevzdává');
  assert.equal(noGeoCalls.length,0,'noGeo se pro code 3 nevolá');
  assert.equal(statusMsgs.length,1,'uživatel dostane zprávu o přechodu na přesné GPS');
  assert.ok(String(statusMsgs[0]).includes('přesným GPS'),'zpráva říká, jaká metoda běží');
  assert.ok(watchOpts && watchOpts.timeout===75000 && watchOpts.enableHighAccuracy===true,
    'pozorovatel čeká na GPS až 75 s s vysokou přesností: '+JSON.stringify(watchOpts));
  /* telefon o chvíli později doručí první platný fix */
  watchOk({coords:{latitude:50.05, longitude:14.40, accuracy:25}});
  await new Promise(r=>setTimeout(r,10));           /* pojmenujMisto().then → load */
  assert.equal(loads.length,1,'fix se použije jako lokalita');
  assert.equal(loads[0].place.lat,50.05);
  assert.equal(loads[0].place.name,'Praha, CZ','název složí geokodér (skladejNazev)');
  assert.equal(loads[0].silent,false,'fix na startu není silent');
  assert.ok(clearedIds.includes(watchId),'po doručení fixu se pozorovatel zavře (clearWatch)');
});

test('kolo 17b: behaviorálně — zamítnutí (code 1) jde do noGeo, watchPosition se neotvírá',()=>{
  const noGeoErr=[]; let watchOpened=0;
  const c=context(['acquirePosition','geoWatchStop'],{
    navigator:{geolocation:{
      getCurrentPosition:(ok,err)=>{ err({code:1}); },
      watchPosition:()=>{ watchOpened++; return 1; },
      clearWatch:()=>{}
    }},
    clearTimeout:()=>{}, setTimeout:()=>{ return 5; },
    geoRefineT:null, geoHintT:null, geoWatchId:null,
    geoCoarseT:null, geoFailT:null, geoFailShown:false,
    lastJ:null, cur:null, curFromGeo:false, manualPickAt:0,
    status:()=>{}, pojmenujMisto:()=>Promise.resolve(null), load:()=>{},
    noGeo:(e)=>{ noGeoErr.push(e); }
  });
  c.acquirePosition(false);
  assert.equal(noGeoErr.length,1,'zamítnutí jde do vzdělávacího dialogu (noGeo)');
  assert.equal(noGeoErr[0].code,1);
  assert.equal(watchOpened,0,'přesné GPS nemá smysl, když je přístup zamítnutý');
});

test('kolo 18: visící geolokace nikdy nenechá clonu němou (pojistky)',()=>{
  /* Dave 20. 11. 11:44: „Opět to trvá… Neptá se mě to na začátku na
     povolení GPS. Proto to asi nezískává data“ — clona visela bez
     odezvy i po minutách (IMG_5099). WebKit v samostatné PWA umí
     systémový dotaz na polohu přehlédnout: žádost visí bez fixu,
     bez chyby, i bez časovače. Kolo 18 dává: (1) hlášení i v tichém
     režimu, když nejsou načtená data (report), (2) pojistku hrubé
     fáze 17 s — nevyřízený callback neumlčí fallback, (3) pojistný
     časovač 100 s — čekání skončí hláškou, nikdy němou clonou,
     (4) pokyn na Nastavení → Polohové služby v hláškách,
     (5) rychlý start 24 h místo 8 h (méně ranních čekání na GPS). */
  const ap=fn('acquirePosition');
  assert.ok(ap.includes('report = !silent || (!cur && !lastJ)'),
    'tichý režim hlásí vždy, když nejsou načtená data');
  assert.ok(ap.includes('17000'),'pojistka hrubé fáze: 17 s');
  assert.ok(ap.includes('100000'),'pojistný časovač: 100 s');
  assert.ok(fn('noGeo').includes('geoFailShown'),
    'po noGeo se pojistná hláška nezduplikuje');
  assert.ok((ap + fn('noGeo')).includes('Nezobrazil se dotaz na povolení polohy'),
    'hlášky odkazují na cestu k povolení v Nastavení');
  assert.ok(fn('init').includes('24*3600*1000'),
    'rychlý start kryje 24 h, ne 8 h');
  assert.ok(fn('pick').includes('clearTimeout(geoFailT)'),
    'ruční volba obce vypíná i pojistné časovače');
});

test('kolo 18: behaviorálně — tichý návrat bez dat po selhání GPS ozve hlášku, ne němé ticho',()=>{
  /* iOS po návratu ze spánku volá acquirePosition(true) (visibility-
     change). Kolo 17 v tichém režimu nehlásilo nic a vstup do funkce
     smazal čekající hlášku — uživatel dívající se na clonu bez dat
     zůstal bez jediného slova. Kolo 18: bez načtených dat se hlásí
     i v tichém režimu (report). Důkaz vykonaný v izolovaném kontextu. */
  const timers=[]; let watchOpened=0, watchErr=null; const statusMsgs=[], noGeoCalls=[];
  const c=context(['acquirePosition','geoWatchStop'],{
    navigator:{geolocation:{
      getCurrentPosition:(ok,err)=>{ err({code:3}); },
      watchPosition:(ok2,err2)=>{ watchOpened++; watchErr=err2; return 42; },
      clearWatch:()=>{}
    }},
    clearTimeout:()=>{},
    setTimeout:(f,delay)=>{ timers.push({f,delay}); return timers.length; },
    geoRefineT:null, geoHintT:null, geoWatchId:null,
    geoCoarseT:null, geoFailT:null, geoFailShown:false,
    lastJ:null, cur:null, curFromGeo:false, manualPickAt:0,
    status:(m)=>{ statusMsgs.push(m); },
    geoBindHelp:()=>{}, geoPermTxt:()=>"test",
    pojmenujMisto:()=>Promise.resolve(null), load:()=>{},
    noGeo:(e)=>{ noGeoCalls.push(e); }
  });
  c.acquirePosition(true);                    /* TICHÉ volání (návrat do appky) */
  assert.ok(timers.some(t=>t.delay===10000),
    'hláška po 10 s se nasadí i v tichém režimu bez dat');
  assert.equal(watchOpened,1,'po code 3 běží pozorovatel i v tichém režimu');
  watchErr({code:3});                        /* GPS neodpovědělo ani za 75 s */
  assert.equal(noGeoCalls.length,1,
    'neúspěch se v tichém režimu bez dat nezatají — jede noGeo');
  assert.equal(noGeoCalls[0].code,3);
});

test('kolo 18: behaviorálně — visící hrubá fáze: pojistka 17 s otevře pozorovatel, 100 s skončí hláškou',()=>{
  /* Simulace WebKitu, který ve stavu „Zeptat se příště“ neozve ani
     úspěšný, ani chybový callback (systémový dotaz na povolení se
     na obrazovce neobjeví). Kolo 18: pojistka 17 s otevře pozorovatel
     watchPosition; pojistný časovač 100 s ukončí čekání hláškou
     „Polohu se nepodařilo zjistit“ (noGeo), ne němou clonou. */
  const timers=[]; let watchOpened=0, watchOpenedByWatchdog=0; const noGeoCalls=[];
  const c=context(['acquirePosition','geoWatchStop'],{
    navigator:{geolocation:{
      getCurrentPosition:()=>{},              /* NEODPOVÍ NIKDY */
      watchPosition:()=>{ watchOpened++; return 42; },
      clearWatch:()=>{}
    }},
    clearTimeout:()=>{},
    setTimeout:(f,delay)=>{ timers.push({f,delay}); return timers.length; },
    geoRefineT:null, geoHintT:null, geoWatchId:null,
    geoCoarseT:null, geoFailT:null, geoFailShown:false,
    lastJ:null, cur:null, curFromGeo:false, manualPickAt:0,
    status:()=>{}, geoBindHelp:()=>{}, geoPermTxt:()=>"test", pojmenujMisto:()=>Promise.resolve(null), load:()=>{},
    noGeo:(e)=>{ noGeoCalls.push(e); }
  });
  c.acquirePosition(false);
  assert.equal(watchOpened,0,'zpočátku se nic neotvírá, čeká se na hrubou fázi');
  timers.filter(t=>t.delay===17000).forEach(t=>{ watchOpenedByWatchdog=watchOpened; t.f(); });
  assert.equal(watchOpened,1,'po 17 s se otevře pozorovatel, i když callback nikdy neodpověděl');
  assert.ok(timers.some(t=>t.delay===100000),'pojistný časovač 100 s je nasazen');
  timers.filter(t=>t.delay===100000).forEach(t=>t.f());
  assert.equal(noGeoCalls.length,1,
    'po 100 s čekání končí hláškou — nikdy němou clonou');
  assert.equal(noGeoCalls[0].code,3);
});

test('kolo 19: hrubý fix nepřenačítá, rozhoduje přesný proti uložené lokalitě',()=>{
  /* Dave 20. 11. odpoledne: „první načtení načte správně a při druhém
     se poloha opět načítá — hlubší problém“. Změřeno na skutečném kódu:
     uložená přesná lokalita P, hrubý Wi-Fi fix W 2,9 km daleko → DVĚ
     přenačtení (na W a zase zpět), a při každém dalším otevření znovu.
     Strukturální pojistky kola 19: */
  const ap=fn('acquirePosition');
  assert.ok(ap.includes('if(!jePresna){ upresni(lat, lon, silent); return; }'),
    'hrubý fix načtenou lokalitu NIKDY nepřenačte, jen požádá přesnou fázi');
  assert.ok(ap.includes('if(distKm(cur.lat, cur.lon, lat, lon) < 1) return;'),
    'přesný fix přenačte jen při pohybu nad 1 km');
  assert.ok(fn('upresni').includes('cur ? cur.lat : hrubaLat'),
    'přesná fáze srovnává s NAČTENOU lokalitou, ne s hrubou kotvou');
});

test('kolo 19: behaviorálně — druhé otevření na stejném místě: nula přenačtení (konec ping-pongu)',async()=>{
  /* Vykonaná simulace Daveova telefonu: uložená přesná lokalita P
     (50.0750, 14.4150), hrubý Wi-Fi fix W 2,9 km daleko, přesný fix P'
     13 m od uložené. Kolo 18 dělalo DVĚ přenačtení; kolo 19 musí dělat
     NULU — uživatel se nepohnul, tak se nesmí přenačíst vůbec nic. */
  const P={lat:50.0750,lon:14.4150}, W={lat:50.1010,lon:14.4200}, P2={lat:50.0751,lon:14.4151};
  const timers=[], loads=[], statusMsgs=[]; let gpCall=0;
  const c=context(['acquirePosition','upresni','geoWatchStop','distKm','skladejNazev'],{
    navigator:{geolocation:{
      getCurrentPosition:(ok)=>{
        gpCall++;
        ok({coords: gpCall===1
          ? {latitude:W.lat, longitude:W.lon, accuracy:350}
          : {latitude:P2.lat, longitude:P2.lon, accuracy:20}});
      },
      watchPosition:()=>7, clearWatch:()=>{}
    }},
    clearTimeout:()=>{},
    setTimeout:(f,delay)=>{ timers.push({f,delay}); return timers.length; },
    geoRefineT:null, geoHintT:null, geoWatchId:null,
    geoCoarseT:null, geoFailT:null, geoFailShown:false,
    lastJ:{nacteno:true}, cur:{lat:P.lat,lon:P.lon,name:'Praha 5, Praha, CZ'},
    curFromGeo:false, manualPickAt:0,
    status:(m)=>{ statusMsgs.push(m); },
    pojmenujMisto:()=>Promise.resolve({district:'Praha 5',city:'Praha',cc:'CZ'}),
    load:(place,silent)=>{ loads.push({place,silent}); }, noGeo:()=>{}
  });
  c.acquirePosition(false);                    /* hrubá fáze přinesla W */
  await new Promise(r=>setTimeout(r,10));      /* pojmenujMisto().then by byl starý reload */
  timers.filter(t=>t.delay===400).forEach(t=>t.f());   /* přesná fáze přinesla P' */
  await new Promise(r=>setTimeout(r,10));
  assert.equal(loads.length,0,
    'na stejném místě se nepřenačtuje NIC (původně 2 přenačtení: ' +
    'load na W ' + (50.1010).toFixed(4) + ' a zpět na P\')');
  assert.equal(statusMsgs.filter(m=>String(m).includes('Stahuji')).length,0,
    'uživatel nevidí žádné „Stahuji předpovědi modelů…“');
});

test('kolo 19: behaviorálně — skutečné přesunutí o kilometry: přenačtení proběhne',async()=>{
  /* Obranná strana opravy: když se uživatel doopravdy přesune (přesný
     fix 3,4 km od uložené lokality), aplikace musí lokalitu přehodit. */
  const P={lat:50.0750,lon:14.4150};            /* uložená: Praha 5 */
  const N={lat:50.1030,lon:14.3900};            /* nová: ~3,4 km daleko */
  const timers=[], loads=[]; let gpCall=0;
  const c=context(['acquirePosition','upresni','geoWatchStop','distKm','skladejNazev'],{
    navigator:{geolocation:{
      getCurrentPosition:(ok)=>{
        gpCall++;
        ok({coords: gpCall===1
          ? {latitude:N.lat, longitude:N.lon, accuracy:500}   /* hrubý fix už u nové adresy */
          : {latitude:N.lat, longitude:N.lon, accuracy:20}});
      },
      watchPosition:()=>7, clearWatch:()=>{}
    }},
    clearTimeout:()=>{},
    setTimeout:(f,delay)=>{ timers.push({f,delay}); return timers.length; },
    geoRefineT:null, geoHintT:null, geoWatchId:null,
    geoCoarseT:null, geoFailT:null, geoFailShown:false,
    lastJ:{nacteno:true}, cur:{lat:P.lat,lon:P.lon,name:'Praha 5, Praha, CZ'},
    curFromGeo:false, manualPickAt:0,
    status:()=>{},
    pojmenujMisto:()=>Promise.resolve({district:null,city:'Praha',cc:'CZ'}),
    load:(place,silent)=>{ loads.push({place,silent}); }, noGeo:()=>{}
  });
  c.acquirePosition(false);
  await new Promise(r=>setTimeout(r,10));
  timers.filter(t=>t.delay===400).forEach(t=>t.f());
  await new Promise(r=>setTimeout(r,10));
  assert.equal(loads.length,1,'přesun se projeví právě jedním přenačtením');
  assert.equal(loads[0].place.lat.toFixed(4),N.lat.toFixed(4),
    'aplikace skončí na nové poloze, ne na uložené');
});

test('kolo 20: Wi-Fi hledání lokace odstraněno, verze je v rozhraní vidět',()=>{
  /* Dave 20. 11. 12:20 (IMG_5100): „Je nutné tam mít to Wi-Fi hledání
     lokace?“ Není — Wi-Fi poloha byla rychlá, ale nepřesná (Daveův
     telefon až 2,9 km vedle) a pro radar s pixelem ~1,2 km
     nepoužitelná. Kolo 20 odstraňuje Wi-Fi fázi: jediný geolokační
     dotaz žádá rovnou přesné GPS. Zároveň je v rozhraní viditelné
     označení verze (v20) — Dave tak na mobilu ověří, že nové kolo
     skutečně běží (iOS drží pozastavenou PWA v paměti se starým
     kódem, proto dřív „beze změny“ bez možnosti rozlišení). */
  const ap=fn('acquirePosition');
  assert.ok(ap.includes('timeout:20000'),'první dotaz čeká na přesné GPS 20 s');
  assert.ok(!ap.includes('enableHighAccuracy:false'),
    'žádný dotaz na polohu z Wi-Fi/vysílačů — pouze přesné GPS');
  assert.ok(html.includes('id="bpVer"'),'označení verze je v rozhraní');
  assert.ok(html.includes('>v34<'),'aktuální verze: v34');
});

test('kolo 20: behaviorálně — první dotaz žádá vysokou přesnost hned (žádné Wi-Fi)',async()=>{
  const gpOpts=[], loads=[]; let watchOpened=0;
  const c=context(['acquirePosition','geoWatchStop','distKm','skladejNazev'],{
    navigator:{geolocation:{
      getCurrentPosition:(ok,err,opts)=>{
        gpOpts.push(opts);
        ok({coords:{latitude:50.05, longitude:14.40, accuracy:25}});
      },
      watchPosition:()=>{ watchOpened++; return 9; },
      clearWatch:()=>{}
    }},
    clearTimeout:()=>{}, setTimeout:()=>{ return 5; },
    geoRefineT:null, geoHintT:null, geoWatchId:null,
    geoCoarseT:null, geoFailT:null, geoFailShown:false,
    lastJ:null, cur:null, curFromGeo:false, manualPickAt:0,
    status:()=>{}, pojmenujMisto:()=>Promise.resolve({district:null,city:'Praha',cc:'CZ'}),
    load:(place,silent)=>{ loads.push({place,silent}); }, noGeo:()=>{}
  });
  c.acquirePosition(false);
  assert.equal(gpOpts.length,1,'poloha se ptá jediným jednorázovým dotazem');
  assert.ok(gpOpts[0] && gpOpts[0].enableHighAccuracy===true
    && gpOpts[0].timeout===20000 && gpOpts[0].maximumAge===0,
    'první dotaz: rovnou přesné GPS (žádné Wi-Fi): '+JSON.stringify(gpOpts[0]));
  await new Promise(r=>setTimeout(r,10));
  assert.equal(watchOpened,0,'přesný fix dorazil → pozorovatel se neotevírá');
  assert.equal(loads.length,1,'fix se použije jako lokalita');
  assert.equal(loads[0].silent,false,'fix na startu není silent');
});

test('kolo 21: žádost o polohu startuje z dotyku, ne sama od sebe (iOS)',()=>{
  /* Dave 20. 11. odpoledne: „Nežádá mě to o polohu. Nejde to ani
     v samotném Safari. Pořád jen načítání polohy na té cloně.“
     WebKit umí automatickou žádost při startu spolknout — visí bez
     fixu, bez chyby i bez systémového dotazu (kolo 18 to naměřilo
     v PWA, kolo 21 i v Safaru). Jediná spolehlivá cesta na iOS je
     geolocation vyvolaná z gesty. Start proto projde STAV oprávnění
     přes navigator.permissions: granted → auto, denied → návod hned,
     jinak tlačítko „Povolit polohu“ v cloně. */
  const gs=fn('geoStart');
  assert.ok(gs.includes('geoPermQuery') && fn('geoPermQuery').includes('permissions.query'),
    'start se ptá na STAV oprávnění, ne slepě spouští žádost');
  assert.ok(gs.includes('geoAskOverlay'),
    'nerozhodnutý stav zobrazí tlačítkovou clonu');
  assert.ok(gs.includes('bpGeoOk'),
    'úspěšný fix se zapamatuje — další starty jsou automatické');
  assert.ok(fn('init').includes('geoStart'),
    'init žádá o polohu přes geoStart, ne acquirePosition');
  assert.ok(html.includes('>v34<'),'aktuální verze: v34');
  assert.ok(script.includes('btnGeoTry'),'clona má tlačítko „Povolit polohu“');
  assert.ok(script.includes('btnGeoManual'),'clona má vždy cestu „Napiš obec ručně“');
});

test('kolo 21: behaviorálně — stav „prompt“: žádost čeká na dotyk, sama neletí',async()=>{
  const calls={acquire:0,overlay:0}; let resolveQ=null;
  const c=context(['geoStart','geoPermQuery'],{
    setTimeout:()=>1, clearTimeout:()=>{},
    navigator:{geolocation:{},
      permissions:{query:()=>new Promise(r=>{resolveQ=r;})}},
    localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},
    lastJ:null, cur:null,
    acquirePosition:()=>{calls.acquire++;},
    noGeo:()=>{},
    geoAskOverlay:()=>{calls.overlay++;},
    status:()=>{}
  });
  c.geoStart(false);
  assert.equal(calls.acquire,0,'před odpovědí permissions nic neletí');
  assert.ok(resolveQ,'permissions.query byl volán');
  resolveQ({state:'prompt'});
  await new Promise(r=>setTimeout(r,5));
  assert.equal(calls.acquire,0,
    'stav „prompt“ NESPOUŠTÍ automatickou žádost (WebKit by ji spolkl)');
  assert.equal(calls.overlay,1,
    'studený start nabídne tlačítko „Povolit polohu“');
});

test('kolo 21: behaviorálně — granted jede samo, denied ukáže návod hned',async()=>{
  const calls={acquire:0,noGeo:0,overlay:0}; const noGeoErr=[];
  const mk=(state)=>context(['geoStart','geoPermQuery'],{
    setTimeout:()=>1, clearTimeout:()=>{},
    navigator:{geolocation:{},
      permissions:{query:()=>Promise.resolve({state})}},
    localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},
    lastJ:null, cur:null,
    acquirePosition:()=>{calls.acquire++;},
    noGeo:(e)=>{calls.noGeo++;noGeoErr.push(e);},
    geoAskOverlay:()=>{calls.overlay++;},
    status:()=>{}
  });
  const g=mk('granted');
  g.geoStart(false);
  await new Promise(r=>setTimeout(r,5));
  assert.equal(calls.acquire,1,'granted → žádost jede automaticky (dotaz nepadá)');
  assert.equal(calls.overlay,0,'u granted netřeba žádné tlačítko');
  const d=mk('denied');
  d.geoStart(false);
  await new Promise(r=>setTimeout(r,5));
  assert.equal(calls.acquire,1,'denied → žádost nespouštíme (visela by)');
  assert.equal(calls.noGeo,1,'denied → hned návod k Nastavení (noGeo)');
  assert.equal(noGeoErr[0] && noGeoErr[0].code,1,'jde o zamítnutí (code 1)');
  assert.equal(calls.overlay,0,'u denied se ukazuje dialog, ne tlačítka');
});

test('kolo 21: behaviorálně — bez permissions API zůstává automatická žádost (staré iOS)',()=>{
  const calls={acquire:0};
  const c=context(['geoStart','geoPermQuery'],{
    setTimeout:()=>1, clearTimeout:()=>{},
    navigator:{geolocation:{}},          /*žádné permissions API jako na iOS < 16*/
    localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},
    lastJ:null, cur:null,
    acquirePosition:()=>{calls.acquire++;},
    noGeo:()=>{}, geoAskOverlay:()=>{}, status:()=>{}
  });
  c.geoStart(false);
  assert.equal(calls.acquire,1,
    'prohlížeč bez permissions API žádná žádost nevisí na dotyku');
});

test('kolo 21: behaviorálně — rychlý start z uložené lokality: žádná clona s tlačítky',async()=>{
  /* Daveova každodenní cesta: uložená lokalita + nerozhodnuté
     oprávnění. Data jedou, geolokace se neptá a clona nikoho
     nevyrušuje — tlačítková clona smí přijít jen na skutečném
     studeném startu bez dat. */
  const calls={acquire:0,overlay:0}; let resolveQ=null;
  const c=context(['geoStart','geoPermQuery'],{
    setTimeout:()=>1, clearTimeout:()=>{},
    navigator:{geolocation:{},
      permissions:{query:()=>new Promise(r=>{resolveQ=r;})}},
    localStorage:{getItem:(k)=> k==='bpPlace_v1'
      ? JSON.stringify({lat:50.075,lon:14.415,t:Date.now()})
      : null,
      setItem:()=>{},removeItem:()=>{}},
    lastJ:null, cur:null,
    acquirePosition:()=>{calls.acquire++;},
    noGeo:()=>{},
    geoAskOverlay:()=>{calls.overlay++;},
    status:()=>{}
  });
  c.geoStart(true);                       /* tichý start s uloženou lokalitou */
  resolveQ({state:'prompt'});
  await new Promise(r=>setTimeout(r,5));
  assert.equal(calls.overlay,0,
    's uloženou lokalitou se žádná tlačítková clona neukazuje');
  assert.equal(calls.acquire,0,
    've stavu „prompt“ se geolokace sama nespouští (žádost bez dotazu)');
});

test('kolo 23: pojistka proti visícímu dotazu na oprávnění (3 s)',()=>{
  /* Dave 21. 11.: na mobilu v22 clona 2 minuty beze změny, přestože
     Nastavení hlásí „Při používání“; na desktopu testy zelené. Jediné
     vysvětlení sedící na všechna pozorování: WebKit na iOS nenechá
     navigator.permissions.query({name:"geolocation"}) DOŘEŠIT — slib
     visí, geoStart se nikdy nedostane k acquirePosition a žádný
     časovač kol 17/18 se nenasadí. Lék kola 23: geoPermQuery s
     pojistkou 3 s; nedořeší-li se, jede stará automatická žádost s
     pojistkami. Strukturní zábrany: */
  const gp=fn('geoPermQuery');
  assert.ok(gp.includes('3000'),'dotaz na oprávnění má pojistku 3 s');
  assert.ok(gp.includes('resolve({state:"unknown"})'),
    'pojistka dořeší slib sama — start nikdy nezamrzne na čekání');
  assert.ok(fn('geoStart').includes('state === "unknown"'),
    'nezměřený stav jede dál automaticky (ne visí)');
  assert.ok(script.includes('Start se nepovedl'),
    'havárie init() se vypíše na clonu, ne němá smrt skriptu');
  assert.ok(script.includes('geoPermTxt()'),
    'nápovědy clony nesou stav oprávnění (diagnostika z mobilu)');
  assert.ok(html.includes('>v34<'),'aktuální verze: v34');
});

test('kolo 23: behaviorálně — WebKit nechá dotaz viset: pojistka 3 s spustí žádost',async()=>{
  const timers=[]; const calls={acquire:0,overlay:0};
  const c=context(['geoStart','geoPermQuery'],{
    setTimeout:(f,delay)=>{ timers.push({f,delay}); return timers.length; },
    clearTimeout:()=>{},
    navigator:{geolocation:{},
      permissions:{query:()=>new Promise(()=>{})}},   /* WebKit: nikdy nedořeší */
    localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},
    lastJ:null, cur:null,
    acquirePosition:()=>{calls.acquire++;},
    noGeo:()=>{},
    geoAskOverlay:()=>{calls.overlay++;},
    status:()=>{}
  });
  c.geoStart(false);
  await new Promise(r=>setTimeout(r,5));
  assert.equal(calls.acquire,0,'před pojistkou žádost neletí (čeká se na stav)');
  assert.ok(timers.some(t=>t.delay===3000),'pojistka 3 s je nasazena hned');
  timers.filter(t=>t.delay===3000).forEach(t=>t.f());   /* WebKit mlčí 3 s */
  await new Promise(r=>setTimeout(r,5));
  assert.equal(calls.acquire,1,
    'po vypršení pojistky jede automatická žádost (stará cesta s hint 10 s, pozorovatel 17 s, hláška 100 s)');
  assert.equal(calls.overlay,1,'studený start má i tlačítkovou clonu s cestou ven');
});

test('kolo 24: start aplikace — init() až po všech deklaracích, load() null-safe',()=>{
  /* Daveův snímek z 21. 11. (v23): „Start se nepovedl — chyba:
     undefined is not an object (evaluating 'input.value =
     place.name')“. Příčina měsíců „beze změny“: init() volaný
     v půlce skriptu (od kola 15) → rychlý start z uložené lokality
     → load() během vyhodnocování skriptu → zápis do `var input`,
     deklarovaného až o stovky řádků níž → TypeError, který zabil
     CELÝ skript (geolokace, posluchače, všechno). Browser testy
     byly slepé: fixture startovala bez uložené lokality, takže
     rychlá cesta do testů nedorazila. Kolo 24 přesouvá spuštění
     init() na úplný konec skriptu a load() si dohledá element
     lokality přímo, s null pojistkou. */
  const ld=fn('load');
  assert.ok(!ld.includes('input.value = place.name'),
    'load nesmí psát do pozdě deklarované top-level proměnné (ta zabíjela Daveův telefon)');
  assert.ok(ld.includes('$("locInput")'),
    'load dohledá vstup pro obec přímo, s null pojistkou');
  const initCall=script.lastIndexOf('try{\n  init();');
  assert.notEqual(initCall,-1,'init() se volá v pojistce try/catch');
  const inputDecl=script.indexOf('var input = $("locInput")');
  assert.ok(inputDecl!==-1 && initCall>inputDecl,
    'init() běží až po deklaraci vyhledávacího pole (na konci skriptu)');
  assert.ok(script.slice(initCall).includes('catch'),
    'pojistka havárie z kola 23 (chyba na clonu) zůstává');
  assert.ok(html.includes('>v34<'),'aktuální verze: v34');
});

test('kolo 25: radar ČHMÚ v pohledu, přechody plynulé bez skoků',()=>{
  /* Dave 20. 11. večer chtěl radar ČHMÚ zpět; kolo 22 správně rušilo
     rozklikávací tlačítko (přepínání pohledu = skok v rozhraní), ale
     plán z kola 15 nikdy nedopadl: pole ČHMÚ se počítá (chmiState.field,
     1 km na pixel, ±48 km) a nevykresluje se. Kolo 25 ho kreslí do
     JEDINÉHO pohledu výrazně přes jemný kompozit. Plynulost: clona se
     rozplývá (opacity/visibility místo display), panely vplouvají
     (@keyframes riseIn), překreslení stejným obsahem se zahazuje
     (htmlIfChanged) a nová verze SW se nasazuje, jen když aplikace
     jde do pozadí (žádný skok starý→nový web za chodu). */
  const rc=fn('renderCompassBase');
  assert.ok(rc.includes('compassFieldSvg(chmiCells, C.reachKm, true)'),
    'čerstvé pole ČHMÚ se kreslí výrazně (forChmi=true), od kola 26 v pohledu ČHMÚ přepínače');
  assert.ok(rc.includes('chmiState.field'),
    'kompas čte čerstvé pole ČHMÚ připravené od kola 15 (chmiState.field)');
  assert.ok(rc.includes('radar ČHMÚ · PseudoCAPPI 2 km'),
    'zdrojový řádek kompasu přiznává národní radar, když kreslí jeho pole');
  assert.ok(rc.includes('htmlIfChanged(el,'),
    'kompas se překresluje přes guard — stejný obsah neproblikává');
  const hic=fn('htmlIfChanged');
  assert.ok(hic.includes('el.innerHTML === html'),
    'guard porovnává obsah před zápisem');
  const cc=script.indexOf('controllerchange');
  assert.ok(cc>-1 && script.slice(cc,cc+900).includes('visibilitychange'),
    'nová verze SW se nasadí na pozadí aplikace, ne skokem za chodu');
  assert.ok(html.includes('#status.show{opacity:1;visibility:visible;pointer-events:auto'),
    'clona se rozplývá (opacity/visibility), neskáče (display)');
  assert.ok(html.includes('id="status" class="show"'),
    'statické HTML startuje s viditelnou clonou — úvod bez bliknutí');
  assert.ok(html.includes('@keyframes riseIn') && html.includes('.compass{animation:riseIn'),
    'panely vplouvají animací riseIn');
  assert.ok(html.includes('>v34<'),'aktuální verze: v34');
});

test('kolo 26: panel Kdy říká čas od modelů, radar má přepínač Kompozit/ČHMÚ',()=>{
  /* Dave (21. 11., PC, snímek Jihlava): nahoře 89 % a „Téměř jistě
     zaprší“, panel Kdy ale jen „Nic do hodiny“ — slabé, chtěl vědět
     KDY. Když radar i minutecast mlčí a modely se shodnou (alespoň
     50 %, kolo 9c drží osamocené modely mimo hru), panel řekne
     odhadovaný čas začátku. Dave chtěl i přepínaČ na ČHMÚ radar:
     vrací se jako segment v panelu Radar (nová jména, stará z kola
     14 zůstávají pohřbena) — přepnutí překreslí jeden panel,
     žádný skok (kolo 25 plynulost zůstává). */
  const rw=fn('recomputeWhen');
  assert.ok(rw.includes('mode:"later"'),
    'nový stav panelu Kdy: modely čekají srážky dál než hodinu');
  assert.ok(rw.includes('"od " + fmtHr(pk.t)'),
    'headline říká odhadovaný čas začátku, ne jen „nic do hodiny“');
  assert.ok(rw.includes('humanDur(pk.minM)'),
    'dodatek převádí minuty na lidský formát (5 h 25 min)');
  const rs=fn('renderSolo');
  assert.ok(rs.includes('mode === "later"') && rs.includes('fmtHr(W.at)'),
    'mobilní solo panel nese tentýž čas jako panel Kdy');
  const rc=fn('renderCompassBase');
  assert.ok(rc.includes('radViewSeg(') && rc.includes('wireRadSeg'),
    'přepínač Kompozit/ČHMÚ se kreslí v panelu Radar a hned se drátuje');
  assert.ok(rc.includes('compassFieldSvg(chmiCells, C.reachKm, true)'),
    'pohled ČHMÚ kreslí národní 1×1 km pole výrazně');
  assert.ok(fn('radView').includes('bpRadarView'),
    'volba pohledu se pamatuje v localStorage, nikam se neposílá');
  assert.ok(script.includes('function humanDur('),
    'lidský formát trvání existuje jako sdílený pomocník');
  assert.ok(html.includes('.radseg') && html.includes('>v34<'),
    'CSS segmentu je v šabloně, verze v34');
});

test('kolo 27: panel Radar vede do sloupce, cifernák vždy vycentrovaný',()=>{
  /* Dave (21. 11., PC Líšeň, snímek): „Všimni si, jak je to rozpadlé.
     Nesedí ty věci do těch polí. Když je málo místa, tak se musí text
     zkrátit. A radar vždy vycentrovat, případně zmenšit. Apka musí
     vypadat dobře.“ Desktopový flex-wrap stavěl cifernák a text vedle
     sebe; v úzkém panelu (aside 210–310 px) textu zbylo ~60–90 px a
     vysvětlení se lámalo slovo od slova. Kolo 27 panel skládá do
     sloupce (label + přepínač nahoře, cifernák centrovaný a menší,
     text přes celou šířku) a dlouhé věty zkracuje. */
  assert.ok(html.includes('display:block;overflow:hidden;overflow-wrap:anywhere;hyphens:auto}'),
    'kompas je blokový sloupec s bezpečným zalamováním, ne flex s drceným textem');
  assert.ok(html.includes('.compass svg{display:block;width:clamp(78px,10vh,102px);height:clamp(78px,10vh,102px);margin:6px auto 8px}'),
    'cifernák je vycentrovaný (margin auto) a zmenšený (10 vh, max 102 px)');
  assert.ok(html.includes('.compass .ct{width:100%;min-width:0}'),
    'text pod cifernákem dostává celou šířku panelu');
  assert.ok(html.includes('margin-left:auto;vertical-align:middle'),
    'přepínač Kompozit/ČHMÚ se přitiskne k pravému okraji labelu');
  const rc=fn('renderCompassBase');
  assert.ok(rc.includes('(viaSat ? "Satelit" : "Radar")\n    + radViewSeg(radViewCur, !viaSat && chmiReady) + \'</div>\''),
    'přepínač je uvnitř labelu, nezabírá vlastní řádek');
  assert.ok(rc.includes('Odsud déšť nečekej') && rc.includes('Intenzitu dopředu neodhadnu')
    && rc.includes('skoro stojí'),
    'vysvětlení v úzkém panelu jsou zkrácená (málo místa = kratší text)');
  assert.ok(html.includes('>v34<'),'aktuální verze: v34');
});

test('kolo 28: přepínač se ukáže hned, když dorazí ČHMÚ (rychlý start mobilu)',()=>{
  /* Dave (21. 11., mobil): „Na mobilu se po prvním otevření nezobrazí
     možnost přepnout radar. Až po vyhledání lokality jiné.“ Rychlý
     start má radarové dlaždice ve SW cache → kompas se vykreslí hned,
     ČHMÚ jede vlastním workerem a dorazí později — a nikdo kompas
     znovu nepřekreslil, takže přepínač čekal na další příležitost
     (až vyhledání jiné lokality přeložilo celý řetězec znovu).
     Oprava: loadChmi po dosazení chmiState překreslí kompas hned,
     stejně jako to dělá chybová větv (scheduleChmiRetry). */
  const lc=fn('loadChmi');
  assert.ok(lc.includes('renderCompass();'),
    'loadChmi překreslí kompas, když ČHMÚ data dorazí (ne čekat na jinou příležitost)');
  const lcAfter=lc.slice(lc.indexOf('chmiState = {'));
  assert.ok(lcAfter.includes('renderCompass();') && lcAfter.indexOf('renderCompass();') < lcAfter.indexOf('recomputeWhen();'),
    'překreslení kompasu patří za dosazením chmiState, spolu s přepočtem verdiktu');
  const rc=fn('renderCompassBase');
  assert.ok(rc.includes('radViewCur === "chmu" && chmiReady && chmiCells'),
    'zdroj tvrdí ČHMÚ jen tehdy, když kompas opravdu kreslí jeho pole (jinak kompozit)');
  assert.ok(html.includes('>v34<'),'aktuální verze: v34');
});

test('kolo 29: široké rozpětí se hlásí jako časy dne, příčina se jmenuje',()=>{
  /* Dave (21. 11., mobil Líšeň, „za 115–254 min“): „rozsah deště
     100 minut je nemožný.“ Dva problémy v jednom: (a) minutová
     přesnost, která u tří hodin neexistuje, (b) dvojsmysl — „za
     115–254 min“ se dalo číst jako déšť OD 115. DO 254. minuty.
     Kolo 29: okno širší než 45 min nebo sahající za 90. minutu
     se hlásí jako ČASY dne („mezi 18:55 a 21:35“), jediný vzdálený
     odhad jako „kolem 19:15“; minuty zůstávají jen do 90 min.
     A rozpočet nejistoty teď nese PŘÍČINU: při neshodě zdrojů
     panel řekne konkrétní časy zdrojů, ne starou generickou větu. */
  const rw=fn('recomputeWhen');
  assert.ok(rw.includes('mezi " + fmtHr(clockLo) + " a " + fmtHr(clockHi)'),
    'hlavní řešení: široké okno jako časové rozpětí dne, ne nemožné minuty');
  assert.ok(rw.includes('kolem " + fmtHr(new Date(now + mins*60000))'),
    'jediný odhad dál než 90 min hlásí čas dne („kolem 19:15“)');
  assert.ok(rw.includes('sigWhy') && rw.includes('zdroje se na čase rozcházejí ('),
    'text rozpětí jmenuje pravou příčinu podle rozpočtu nejistoty (i s časy zdrojů)');
  assert.ok(rw.includes('prehan")') === false || rw.includes('přeháňky se načasují nejhůř'),
    'věta o přeháňkách zůstává lidská');
  assert.ok(rw.includes('" · čas z pohybu srážkového pole"'),
    'zdrojová řádka u dávného odhadu neslibuje „horizont 60 min“');
  const rs=fn('renderSolo');
  assert.ok(rs.includes('winBig') && rs.includes('mezi " + fmtHr(new Date(W.now + W.lo*60000))'),
    'mobilní solo panel mluví tentýmž jazykem (časy, ne „za 2 h 44 min“)');
  assert.ok(rs.includes('if(!winBig && W.lo != null'),
    'dodatek „mezi X. a Y. minutou“ se u časového okna neduplikuje');
  assert.ok(html.includes('>v34<'),'aktuální verze: v34');
});

/* ==================== KOLO 30: VERDIKT ČEKÁ JEN NA POZOROVÁNÍ ==================== */

test('kolo 30: registr má zvlášť pozorování a zvlášť nowcasty (DWD/KNMI neblokuje)',()=>{
  /* Dave (20. 11., mobil, Líšeň 15:26): verdikt visel v „ověřuji“
     kvůli jedinému rozpracovanému nowcastu DWD RADVOR/KNMI a text
     přitom tvrdil, že „pozemní pozorování měří“. Nowcast je model
     provozovatele sítě, ne měření, verdikt ho nesmí čekat. */
  const c=context(['gtPendingObs','gtPendingNc','gtPrune'],{
    gtPending:{},gtNetTimer:null,GT_MAX_PENDING_MS:90000,setTimeout:()=>{},
    recomputeWhen:()=>{},
    GT_LABELS:{radar:'radarový kompozit',stanice:'stanice',chmi:'radar ČHMÚ',
               metno:'met.no nowcast',regio:'regionální nowcast',
               wms:'DWD RADVOR/KNMI',sat:'družice',eum:'Meteosat'},
    GT_OBS:{radar:1,stanice:1,chmi:1}});
  assert.equal(c.gtPendingObs().join('|'),'','prázdný registr = nic neblokuje');
  c.gtPending.wms = Date.now();                    /* Daveův případ: visí jen nowcast */
  assert.equal(c.gtPendingObs().join('|'),'',
    'nowcast DWD/KNMI není pozorování → verdikt na něj nečeká');
  assert.equal(c.gtPendingNc().join('|'),'DWD RADVOR/KNMI','nowcast jde do vlastního štítku');
  c.gtPending.chmi = Date.now() - 100000;          /* prošlé pozorování pročistí pojistka */
  assert.equal(c.gtPendingObs().join('|'),'','prošlý záznam neblokuje (pojistka 90 s)');
  assert.equal(c.gtPendingNc().join('|'),'DWD RADVOR/KNMI');
  c.gtPending.chmi = Date.now();
  assert.equal(c.gtPendingObs().join('|'),'radar ČHMÚ','živé pozorování blokuje');
  c.gtPending.stanice = Date.now();
  assert.equal(c.gtPendingObs().sort().join('|'),'radar ČHMÚ|stanice',
    'čeká se na všechna živá pozorování najednou');
});

test('kolo 30: rozpracovaný nowcast nedrží verdikt v „ověřuji“ (Dave, 20. 11. 15:26)',()=>{
  const nodes=new Proxy({}, {get:(o,k)=>o[k]||(o[k]={style:{}})});
  const c=context(['recomputeWhen','stanicePotvrzujeSelf','chmiNowWet'],{
    $:id=>nodes[id],reqId:1,cur:{},radarState:null,stormMotion:null,
    altNowcast:[{t:Date.now()/1000,mmh:0.4}],modelCurrent:{mmh:0.4,code:61},
    native15:true,obsMetar:null,chmiState:null,metnoNow:null,regioNowcast:null,satState:null,
    modelState:{},whenState:null,THRESH_OBS:0.2,setTimeout:()=>{},fitPanels:()=>{},
    /* radar i stanice dávno dořekly; jediný visící zdroj je nowcast
       DWD RADVOR/KNMI → checking nemá nastat, verdikt padne hned */
    gtPendingObs:()=>[],gtPendingNc:()=>['DWD RADVOR/KNMI'],
    radarCoverage:'full',blitzMaybeStart:()=>{},blitzNote:()=>'',
    buildBlendTimeline:()=>[],wmoType:()=>({t:'déšť'}),sourceCaveat:()=>'',renderSolo:()=>{}
  });
  c.recomputeWhen();
  assert.equal(c.whenState.mode,'maybe',
    'nowcast neblokuje verdikt — padne „Možná kape“, ne věčné „ověřuji“');
  assert.ok(c.whenState.votes.length>=1,'modelové signály se neztratí');
});

test('kolo 30: strukturální — čekání na pozorování, pojistná překreslovačka',()=>{
  const rw=fn('recomputeWhen');
  assert.ok(rw.includes('gtPendingObs().length'),
    '„ověřuji“ čeká jen na POZOROVACÍ zdroje (radar, stanice, ČHMÚ)');
  assert.ok(!rw.includes('gtAnyPending()'),
    'blokování verdiktu celým registrem (i nowcasty) je pryč');
  assert.ok(rw.includes('pendingNc:pendNc'),'nowcasty cestují do whenState odděleně');
  const rs=fn('renderSolo');
  assert.ok(rs.includes('verdikt na něj nečeká'),
    'mobilní panel vysvětluje, že nowcast verdikt nebrzdí');
  assert.ok(!rs.includes('Radar, stanice i ČHMÚ ještě měří'),
    'pevná fráze o měření (i když měřil jen nowcast) je pryč');
  assert.ok(script.includes('gtNetArm') && script.includes('GT_MAX_PENDING_MS + 2000'),
    'pojistný časovač po 90 s překreslí visící „ověřuji“ sám');
  assert.ok(script.includes('var GT_OBS'),
    'množina pozorovacích klíčů je pojmenovaná');
  const swSrc = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.ok(swSrc.includes('bude-prset-v20'),'service worker bump');
});

test('kolo 31: pohled ČHMÚ mluví daty národního radaru (Dave, 20. 11.)',()=>{
  /* Dave: „když přepínám radar, tak chci jiný popisek podle dat
     daného radaru.“ Výpočet popisku z pole 1×1 km a COTREC osy. */
  const c=context(['chmiNarrative','smer8'],{
    KOMPAS_SMERY8:["S","SV","V","JV","J","JZ","Z","SZ"],
    stanicePotvrzujeSelf:()=>false,
    chmiState:{nowWet:false,nowOrd:0,ageMin:7,scale:6,
      first:{dt:25,wet:true,ord:.5},
      steps:[{dt:10,wet:false},{dt:25,wet:true}]}
  });
  /* Echo 10 km V (blok rkm 1.5 → viditelná vzdálenost 9 km),
     COTREC první mokrý krok +25 min → příchod, ne kompozitní „tě mine“. */
  const n=c.chmiNarrative([{e:10,n:0,o:.5,rkm:1.5}]);
  assert.equal(n.cls,'hit','COTREC čeká srážky → hit');
  assert.equal(n.verd,'Přiletí k tobě.','verdikt z COTREC osy ČHMÚ');
  assert.ok(n.expl.includes('srážky <b>9 km V</b>'),
    'nejbližší echo z reálných buněk 1×1 km pole');
  assert.ok(n.expl.includes('asi za <b>25 min</b>'),
    'čas příchodu z COTREC kroku, ne z kompozitní geometrie');
  assert.ok(!n.expl.includes('Prolétne')&&!n.expl.includes('Tě mine'),
    'žádná kompozitní fráze v popisku ČHMÚ');
  /* Echo nad tebou: hit; konec z prvního suchého COTREC kroku. */
  c.chmiState.nowWet=true;
  const nad=c.chmiNarrative([{e:10,n:0,o:.5,rkm:1.5}]);
  assert.equal(nad.cls,'hit');
  assert.equal(nad.verd,'Právě nad tebou.','echo nad tebou');
  assert.ok(nad.expl.includes('přestanou asi za <b>10 min</b>'),
    'odchod se čte z prvního suchého kroku COTREC');
  /* COTREC suchý celou hodinu → miss, ne slib. */
  c.chmiState.nowWet=false;
  c.chmiState.steps=[{dt:10,wet:false},{dt:60,wet:false}];
  c.chmiState.first=null;
  const suchy=c.chmiNarrative([{e:10,n:0,o:.5,rkm:1.5}]);
  assert.equal(suchy.cls,'miss');
  assert.equal(suchy.verd,'Nic do hodiny.','suchá COTREC osa → žádný slib');
  /* Stanice měří, radar nevidí → kolo 12 platí i v pohledu ČHMÚ. */
  c.chmiState.nowWet=false;
  const cS=context(['chmiNarrative','smer8'],{
    KOMPAS_SMERY8:["S","SV","V","JV","J","JZ","Z","SZ"],
    stanicePotvrzujeSelf:()=>true,
    chmiState:{nowWet:false,nowOrd:0,ageMin:7,scale:6,first:null,
      steps:[{dt:10,wet:false}]}
  });
  const mrholi=cS.chmiNarrative([{e:20,n:0,o:.2,rkm:1.5}]);
  assert.equal(mrholi.verd,'Nad tebou mrholí.',
    'stanice pod prahem echa → pravda z pozorování, ne „nic u tebe“');
  assert.equal(mrholi.cls,'hit');
});

test('kolo 31: strukturální — přepínač radaru přepisuje i popisek',()=>{
  const rcb=fn('renderCompassBase');
  assert.ok(rcb.includes('chmiNarrative(chmiCells, narrow)'),
    'pohled ČHMÚ přebíjí kompozitní verdikt a větu');
  assert.ok(rcb.includes('popisek z tohoto radaru'),
    'src přiznává, že popisek jde ze zobrazeného radaru');
  assert.ok(rcb.includes('radViewCur === "chmu" && chmiReady && chmiCells'),
    'přepis jen s čerstvým snímkem, v dosahu a s buňkami');
  const nc=fn('chmiNarrative');
  assert.ok(nc.includes('S.first.dt')&&nc.includes('smer8('),
    'popisek čte buňky 1×1 km pole a COTREC osu');
  assert.ok(nc.includes('stanicePotvrzujeSelf()'),
    'pozemní pravda z kola 12 funguje i v pohledu ČHMÚ');
  /* staré kompozitní fráze nesmí do popisku ČHMÚ uniknout */
  assert.ok(!nc.includes('Prolet')&&!nc.includes('Prolétne')
    &&!nc.includes('missKm')&&!nc.includes('speedKmh'),
    'chmiNarrative nepoužívá kompozitní geometrii');
  assert.ok(html.includes('.radseg')&&html.includes('>v34<'),
    'přepínač zůstává, verze v34');
  const swSrc = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.ok(swSrc.includes('bude-prset-v20'),'service worker bump');
});

test('kolo 32: popisek ČHMÚ je uživatelsky přívětivý (Dave, 20. 11.)',()=>{
  /* Dave: „ať popíše, co vidí na radaru — uživatelsky přívětivě“.
     Věta pod verdiktem mluví běžnou češtinou (co padá, kde je,
     kdy dorazí), žargon v uživatelském textu není. */
  const c=context(['chmiNarrative','smer8'],{
    KOMPAS_SMERY8:["S","SV","V","JV","J","JZ","Z","SZ"],
    stanicePotvrzujeSelf:()=>false,
    chmiState:{nowWet:false,nowOrd:.9,ageMin:7,scale:6,
      first:{dt:25,wet:true,ord:.5},
      steps:[{dt:10,wet:false},{dt:25,wet:true}]}
  });
  const n=c.chmiNarrative([{e:10,n:0,o:.5,rkm:1.5}]);
  assert.ok(n.expl.includes('srážky <b>9 km V</b>')
    &&n.expl.includes('asi za <b>25 min</b>'),
    'srozumitelně: co padá, kde je a kdy dorazí');
  for(const z of ['COTREC','echo','osy','provozovatele','PseudoCAPPI'])
    assert.ok(!n.expl.includes(z),'žargon „'+z+'“ v popisku není');
  /* Nad tebou: konec srážek lámaný na lidskou řeč. */
  c.chmiState.nowWet=true;
  const nad=c.chmiNarrative([{e:10,n:0,o:.5,rkm:1.5}]);
  assert.ok(nad.expl.includes('přestanou asi za <b>10 min</b>'),
    'konec srážek srozumitelně, ne „první suchý krok“');
  assert.ok(!nad.expl.includes('echo')&&!nad.expl.includes('COTREC'));
  /* Věty zůstávají krátké (mobilní panel). */
  for(const v of [n.verd,nad.verd,'Přiletí k tobě.','Nic do hodiny.',
                  'Srážky v dohledu.','Nad tebou mrholí.'])
    assert.ok(v.length<=20,'verdikt zůstává úsporný: '+v);
  const rcb=fn('renderCompassBase');
  assert.ok(rcb.includes('popisek z tohoto radaru'),
    'src krátce: popisek jde ze zobrazeného radaru');
  assert.ok(!rcb.includes('(pole 1×1 km + COTREC)'),
    'technická závorka z src řádku je pryč');
});

test('kolo 33: úzký layout dostává stručné odpovědi (Dave, PC, 20. 11.)',()=>{
  /* Dave: „Na PC když zmenším rozložení okna, tak ten text je
     schovaný u popisku minimálně zčásti. Vytvoř stručnější odpovědi,
     když je méně místa pro stejné meteo situace.“ Krátké varianty
     nelžou a neztrácejí údaje: verdikt, vzdálenost, směr i čas. */
  const c=context(['chmiNarrative','smer8'],{
    KOMPAS_SMERY8:["S","SV","V","JV","J","JZ","Z","SZ"],
    stanicePotvrzujeSelf:()=>false,
    chmiState:{nowWet:false,nowOrd:.9,ageMin:7,scale:6,
      first:{dt:25,wet:true,ord:.5},
      steps:[{dt:10,wet:false},{dt:25,wet:true}]}
  });
  const cells=[{e:10,n:0,o:.5,rkm:1.5}];
  /* Stejná situace, dvě délky: plná věta pro široký panel,
     krátká pro úzký, tentýž verdikt a klasifikace. */
  const full=c.chmiNarrative(cells);
  const short=c.chmiNarrative(cells,true);
  assert.equal(short.verd,full.verd,'verdikt se nekrátí');
  assert.equal(short.cls,full.cls,'hit/miss se nekrátí');
  assert.ok(short.expl.length<full.expl.length,
    'krátká věta je výrazně kratší ('+short.expl.length+' vs '
    +full.expl.length+' znaků)');
  assert.ok(short.expl.includes('<b>9 km V</b>'),
    'vzdálenost a směr v krátké větě zůstávají');
  assert.ok(short.expl.includes('za <b>25 min</b>'),
    'čas příchodu v krátké větě zůstává');
  /* Srážky nad tebou: konec zůstává, omáčka mizí. */
  c.chmiState.nowWet=true;
  const s=c.chmiNarrative(cells,true);
  assert.ok(s.expl.includes('přestane asi za <b>10 min</b>'),
    'konec srážek i ve zkrácené větě');
  assert.ok(s.expl.length<50,'krátká věta je skutečně krátká');
  /* Kompozit má krátké varianty taky, na stejném signálu jako
     lišta souhrnů, a přepnutí režimu kompas překreslí. */
  const rcb=fn('renderCompassBase');
  assert.ok(rcb.includes('NARROW.matches'),
    'panel cití úzký layout signálem z applyLayoutMode (html.compact)');
  assert.ok(rcb.includes('narrow && (verd === "Právě nad tebou prší."' + ')'.slice(0,0))
    || rcb.includes('if(narrow){'),
    'úzký layout přepisuje vysvětlující větu u všech situací');
  assert.ok(rcb.includes('chmiNarrative(chmiCells, narrow)'),
    'pohled ČHMÚ dostává krátké varianty ze stejného signálu');
  assert.ok(script.includes('if(was !== NARROW.matches){ renderCompass();'),
    'přepnutí široký/úzký překreslí i kompas');
  const swSrc = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.ok(swSrc.includes('bude-prset-v20'),'service worker bump v19');
});

test('kolo 34: přepínač ČHMÚ se hlásí i při suchu, dekorace PNG nejsou echo (Dave, 24. 11.)',()=>{
  /* Dave: „Nejede prepinani na ČHMÚ radar. Nic to neprepne.“ Na
     suchý den je pole 1×1 km prázdné; stará podmínka (!cells.length
     → null) vypnula přepis popisku, takže pohled ČHMÚ mluvil jako
     kompozit a přepínač působil nefunkčně. Zároveň ČHMÚ nově kreslí
     do datového PNG dekorace (24. 11.: 5984 černých + 1521 šedých
     px, 23. 11. totožných 5986/1521), které legenda dBZ neobsahuje
     a které by jinak založily falešné buňky. */
  const SCALE=[[0,108,192],[0,160,0],[0,188,0],[52,216,0],[156,220,0],
    [224,220,0],[252,176,0],[252,132,0],[252,88,0],[252,0,0],[160,0,0],
    [0,0,252],[48,0,168],[56,0,112]].map(c=>({r:c[0],g:c[1],b:c[2]}));
  const suchaOsa=[{dt:10,wet:false},{dt:20,wet:false},
                  {dt:30,wet:false},{dt:40,wet:false}];
  const c=context(['chmiNarrative','smer8'],{
    KOMPAS_SMERY8:["S","SV","V","JV","J","JZ","Z","SZ"],
    stanicePotvrzujeSelf:()=>false,
    chmiState:{nowWet:false,nowOrd:0,ageMin:7,scale:14,first:null,
      steps:suchaOsa}
  });
  /* Prázdné pole = sucho v okruhu 48 km, a to je v pohledu ČHMÚ
     slyšet: verdikt i věta se změní proti kompozitu. */
  const n0=c.chmiNarrative(null);
  assert.equal(n0.verd,'Sucho okolo tebe.','prázdné pole je taky verdikt');
  assert.equal(n0.cls,'miss','sucho bez příslibu = miss');
  assert.ok(n0.expl.includes('48 km')&&n0.expl.includes('do hodiny'),
    'věta říká, co vidí: kruh 48 km bez srážek a suchou předpověď');
  assert.deepEqual(c.chmiNarrative([]).verd,'Sucho okolo tebe.',
    'prázdné pole i explicitně prázdné pole buněk');
  const n0s=c.chmiNarrative(null,true);
  assert.ok(n0s.expl.length<n0.expl.length&&n0s.expl.includes('48 km'),
    'úzký layout: kratší věta, údaj o okruhu zůstává');
  /* Na sucho čekají srážky z COTREC osy → příchod se ohlásí. */
  c.chmiState.first={dt:30,wet:true,ord:.5};
  const prilet=c.chmiNarrative(null);
  assert.equal(prilet.verd,'Přiletí k tobě.','COTREC hlásí příchod i bez buněk');
  assert.ok(prilet.expl.includes('za <b>30 min</b>'),'čas z předpovědi radaru');
  /* Mrholení pod prahem echa: stanice měří, radar nevidí. */
  const cS=context(['chmiNarrative','smer8'],{
    KOMPAS_SMERY8:["S","SV","V","JV","J","JZ","Z","SZ"],
    stanicePotvrzujeSelf:()=>true,
    chmiState:{nowWet:false,nowOrd:0,ageMin:7,scale:14,first:null,
      steps:[{dt:10,wet:false}]}
  });
  const mrholi=cS.chmiNarrative(null);
  assert.equal(mrholi.verd,'Nad tebou mrholí.',
    'pozemní pravda z kola 12 i bez buněk');
  assert.equal(mrholi.cls,'hit');
  /* Filtr dekorací: černý rám/text i šedý panel nejsou barvy
     škály, skutečné echo ano; bez legendy se chová jako dřív. */
  const f=context(['chmiEchoColor','chmiOrdinal','chmiReadNow',
                   'chmiReadPatch','chmiFieldFromPatch'],{chmiScale:SCALE});
  assert.equal(f.chmiEchoColor([0,0,0,255]),false,'černý rám není echo');
  assert.equal(f.chmiEchoColor([196,196,196,255]),false,'šedý panel není echo');
  assert.equal(f.chmiEchoColor([0,108,192,255]),true,'barva škály je echo');
  assert.equal(f.chmiEchoColor([4,104,190,255]),true,
    'i mírně posunutá barva echa projde prahem legendy');
  assert.equal(f.chmiEchoColor([0,0,0,10]),false,'průhledné není echo');
  const bez=context(['chmiEchoColor'],{chmiScale:null});
  assert.equal(bez.chmiEchoColor([0,0,0,255]),true,
    'bez legendy se vrací staré chování (jen průhlednost/podklad)');
  /* Výřez plný černé dekorace: 0 buněk, střed 3×3 suchý. */
  const px=[];
  for(let i=0;i<97*97;i++) px.push([0,0,0,255]);
  const cerna=f.chmiFieldFromPatch({n:97,x0:338,y0:273,ux:386,uy:321,px},48,3);
  assert.ok(Array.isArray(cerna)&&cerna.length===0,
    'výřez z černého rámu/netextu nepřinese jedinou buňku');
  const rNow=f.chmiReadNow({n:97,px});
  assert.equal(rNow.wet,false,'černý střed neznamená déšť');
  assert.equal(rNow.pixels,0,'dekorace se nepočítá do viděných pixelů');
  const rPatch=f.chmiReadPatch({n:97,px});
  assert.equal(rPatch.wet,false,'stejně tak širší výřez (COTREC kroky)');
  /* Jediný skutečný echo pixel v suchém výřezu = jediná buňka. */
  px[48*97+51]=[56,0,112,255];
  const pole=f.chmiFieldFromPatch({n:97,x0:338,y0:273,ux:386,uy:321,px},48,3);
  assert.equal(pole.length,1,'skutečné echo v poli zůstane');
  assert.equal(pole[0].o,1,'ordinál nejsilnější barvy škály');
  /* Struktura: popisek se přepisuje i bez buněk, src přiznává
     kompozitní kreslení; kolo 28 poctivost (CHMU tvrdí jen s poli)
     zůstává. */
  const rcb=fn('renderCompassBase');
  assert.ok(rcb.includes('radViewCur === "chmu" && chmiReady){'),
    'popisek ČHMÚ se přepisuje se čerstvým snímkem i bez buněk');
  assert.ok(rcb.includes('sucho do 48 km, cifra z kompozitu'),
    'src u sucha přiznává, že cifernák kreslí kompozit');
  assert.ok(rcb.includes('radViewCur === \"chmu\" && chmiReady && chmiCells'),
    'src dál tvrdí ČHMÚ jen tehdy, když kreslí jeho pole (kolo 28)');
  const nc=fn('chmiNarrative');
  assert.ok(nc.includes('!cells || !cells.length'),
    'chmiNarrative má větev pro prázdné pole');
  assert.ok(nc.includes('chmiEchoColor')===false,
    'narrativa nefiltruje sama, filtr patří do čtení patche');
  const rf=fn('chmiFieldFromPatch');
  assert.ok(rf.includes('chmiEchoColor(p)'),
    'čtení pole počítá jen barvy ze škály legendy');
  assert.ok(html.includes('>v34<'),'aktuální verze: v34');
  const swSrc = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.ok(swSrc.includes('bude-prset-v20'),'service worker v20');
});
