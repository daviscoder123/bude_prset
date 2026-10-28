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
  const c=context(['load','isStale','resetForecastState','showForecastLoading'],{
    reqId:1,cur:{name:'Old'},input:{},$:id=>nodes[id],
    lastJ:{old:true},lastModels:[],lastForecastId:1,
    modelState:{old:true},verdictState:{old:true},orogState:{factor:1.5},
    threshFor:()=>0.2,status:()=>{},pickModels:()=>[],MODELS:[],HOURS_END:24,
    cachedJson:never,loadEnsemble:()=>{},
    loadRadar:()=>{
      for(const key of ['lastJ','lastModels','lastForecastId','modelState','verdictState',
        'whenState','lastBlendTimeline','orogState','radarState','modelCurrent',
        'obsMetar','ensState','atmoState','placeTimeZone','satState'])
        assert.equal(c[key],null,key);
    }
  });
  c.load({name:'New',lat:51,lon:15,cc:'CZ'},true);
  assert.equal(c.cur.name,'New');
  assert.equal(c.reqId,2);
  assert.equal(nodes.body.textContent,'');
  assert.equal(nodes.soloPillTxt.textContent,'Načítám');
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
    buildBlendTimeline:()=>[],wmoType:()=>({t:'déšť'}),sourceCaveat:()=>'',renderSolo:()=>{}
  });
  for(const native of [true,false]){
    c.native15=native;
    c.recomputeWhen();
    assert.equal(c.whenState.mode,'maybe');
    assert.equal(c.whenState.indep,0);
    assert.match(nodes.whenSub.textContent,/není potvrzen/);
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
  const c=context(['recomputeWhen','saneMm','cap'],{
    $:id=>nodes[id],modelState:{},whenState:null,
    radarState:null,radarTimeline:null,stormMotion:null,altNowcast:null,
    modelCurrent:{mmh:0,code:0},obsMetar:null,chmiState:null,metnoNow:null,
    regioNowcast:null,satState:null,atmoState:null,precipMix:null,
    setTimeout:()=>{},fitPanels:()=>{},THRESH_OBS:0.2,MAX_SANE_MMH:500,
    buildBlendTimeline:()=>[{dt:15,mmh:0.3,parts:['radar','model']}],
    blendMeta:{arrival:{min:15,lo:12,hi:22,n:2,obsN:1}},
    chmiFirstEchoMin:()=>null,chmiSaysDry:()=>false,
    wmoType:()=>({t:'déšť',i:'test'}),fmtMM:String,
    sourceCaveat:()=>'',renderRainEnd:()=>{},renderSolo:()=>{soloCalls++}
  });
  c.recomputeWhen();
  assert.equal(soloCalls,1);
  assert.equal(c.whenState.mode,'soon');
  assert.equal(c.whenState.etaMin,15);
  assert.equal(c.whenState.lo,12);
  assert.equal(c.whenState.hi,22);
  assert.deepEqual(c.whenState.parts,['radar','model']);
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
  assert.deepEqual(g[0],[50.1234,15.5678]);
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
  const c=context(['blendBucket','blendWeights','getBlendMult','recordBlendError','lsGet','lsSet'],{localStorage:ls,BLEND_KEY:'bpBlend_v1'});
  const base30=c.blendWeights(30,null), base45=c.blendWeights(45,null);
  assert.deepEqual(c.blendWeights(30,'CZ'),base30);  /* bez dat stejné váhy */
  for(let i=0;i<40;i++)c.recordBlendError('CZ','30','radar',0.7);
  const w=c.blendWeights(30,'CZ');
  assert.ok(w.radar<base30.radar);                   /* nadhodnocující radar dolů */
  assert.ok(base45.radar<base30.radar);              /* váhy přirozeně klesají s horizontem */
  assert.equal(w.model,base30.model);                /* netestovaný zdroj nedotčen */
  assert.equal(c.blendWeights(45,'CZ').radar,base45.radar); /* jiný bucket bez dat */
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
