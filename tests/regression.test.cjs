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
    cachedJson:never,loadEnsemble:()=>{},
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
  const c=context(['recomputeWhen'],{
    $:id=>nodes[id],reqId:1,cur:{},radarState:null,stormMotion:null,
    altNowcast:[{t:Date.now()/1000,mmh:0.4}],modelCurrent:{mmh:0.4,code:61},
    native15:true,obsMetar:null,chmiState:null,metnoNow:null,regioNowcast:null,satState:null,
    modelState:{},whenState:null,THRESH_OBS:0.2,setTimeout:()=>{},fitPanels:()=>{},
    /* Kolo 4: recomputeWhen si pájí živé blesky (Blitzortung) a kontroluje
       výšku paprsku radaru vůči METAR stanici. V vm kontextu jsou to stuby —
       testují se rozhodovací větve, ne síťová vrstva. */
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
  const c=context(['recomputeWhen','saneMm','cap'],{
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
  const c=context(['recomputeWhen','saneMm','cap','locKeyOf','verdictProb','verdictProbSrc'],{
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
  assert.equal(ens.verdictProb(2,0),0.8); /* okolí mřížky mluví hlasitěji než bod */
  const grid=context(['verdictProb'],{ensState:null,probSeries:[30,10],HOURS:48});
  assert.equal(grid.verdictProb(2,0),0.3); /* mřížka s 30 % vydává 30 %, ne domněnku */
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
  /* Jiný zdroj zůstává identitou — křivky se NEmíchají. */
  assert.equal(c.brierCalib(0.7,'om'),0.7);
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
  /* OM přebije ensemble, když mluví hlasitěji — stejné pravidlo jako verdictProb. */
  const c5=context(['verdictProbSrc'],{ensState:{prob:65},probSeries:[80,null,50],HOURS:8});
  assert.equal(c5.verdictProbSrc(),'om');
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
