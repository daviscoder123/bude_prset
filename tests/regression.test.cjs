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
