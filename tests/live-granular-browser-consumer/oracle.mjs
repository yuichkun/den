import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { renderOffline } from '@unworklet/offline';
import processor from './processor.ts';
const names = ['record','reset','trigger','age','rate','duration','limit','base','burst'];
const reports = [];
for (const sampleRate of [44100,48000,96000]) {
  const short = Math.fround(64 / sampleRate);
  const stages = [
    [1,0,0,4,0,short,32,.25,3], [0,0,1,4,0,short,32,.25,3],
    [0,0,0,4,0,short,32,.25,3], [0,0,1,4,0,2,32,.25,3],
    [1,0,0,0,1,0,128,.25,3], [0,0,1,64,0,2,128,.25,3],
    [0,1,0,4,0,0,16,-.75,3], [1,0,0,4,0,0,16,-.75,3],
    [0,0,1,4,0,0,16,-.75,3], [0,0,0,4,0,2,16,-.75,3],
    [0,0,1,4,0,2,16,-.75,3], [0,0,0,4,0,2,16,-.75,3],
  ];
  const frames = stages.length * 128;
  const params = Object.fromEntries(names.map((name, ch) => [name, Array.from({length:frames}, (_, n) => stages[Math.floor(n/128)][ch])]));
  const expected = Array.from({length:20}, () => new Float32Array(frames));
  let history = [], count = 0, clock = 0, requests = 0, launchAt = 0, grain = null, totals = [0,0,0,0];
  for (let n = 0; n < frames; n++) {
    const c = stages[Math.floor(n/128)], [record,reset,trigger,age,rate,duration,limit,base,burst] = c;
    const now = reset ? 0 : clock;
    if (reset) { history=[]; count=0; grain=null; launchAt=0; totals=[0,0,0,0]; }
    else if (record && count < limit) { history.push({id:count,value:Math.fround(base+count/64)}); count++; if(history.length>64)history.shift(); }
    // Absolute source identity and launch frame define motion independently of
    // the production reader's stored age recurrence or physical ring cursor.
    if (grain) {
      const k=now-grain.born;
      if(k>=grain.duration)grain=null;
      else { const position=grain.position+k*grain.rate; if(!history.length||position<history[0].id||position>history.at(-1).id){grain=null;totals[3]++;} }
    }
    const request=!!trigger && requests<burst && !reset;
    if(request) {
      const valid=age>=0&&age<=63&&age<=history.length-1&&rate>=-16&&rate<=16&&duration>=0&&duration<=2;
      if(!valid)totals[2]++;
      else if(grain)totals[1]++;
      else { grain={born:now,position:history.at(-1).id-age,rate,duration:Math.max(3,Math.floor(duration*sampleRate+.5))};launchAt=now;totals[0]++; }
    }
    requests=reset||!trigger?0:requests+Number(request);
    let output=0;
    if(grain) {
      const k=now-grain.born,position=grain.position+k*grain.rate,lo=Math.floor(position),fraction=position-lo;
      const a=history.find(x=>x.id===lo).value,b=history.find(x=>x.id===Math.min(lo+1,history.at(-1).id)).value;
      const value=Math.fround(a+(b-a)*fraction),window=Math.max(0,1-Math.abs(2*k/(grain.duration-1)-1));output=Math.fround(value*window);
    }
    const anchor=history.length>=5?history.at(-5).value:0;
    const row=[output,Number(!!grain),...totals,now-launchAt,anchor,Number(history.length>=5),history.length,count,...c];
    row.forEach((value,ch)=>expected[ch][n]=value);clock=reset?0:now+1;
  }
  const run=(start,end,restore)=>renderOffline(processor,{sampleRate,duration:(end-start-.25)/sampleRate,params:Object.fromEntries(names.map(name=>[name,params[name].slice(start,end)])),...(restore?{restore}:{})});
  const actual=await run(0,frames);assert.equal(actual.diagnostics.scrubbedSamples,0);
  let error=0;actual.outputs.main.forEach((channel,ch)=>{if(ch===0){channel.forEach((x,n)=>error=Math.max(error,Math.abs(x-expected[ch][n])));}else assert.deepEqual(channel,expected[ch]);});assert(error<2e-6);
  for(const split of [128,256,512,640,768,1024,1408]){const a=await run(0,split),b=await run(split,frames,a.state);assert.deepEqual(b.outputs.main,actual.outputs.main.map(x=>x.slice(split)));assert.deepEqual(b.state,actual.state);assert.equal(b.diagnostics.scrubbedSamples,0);}
  reports.push({sampleRate,frames,channels:20,maxAudioError:error,exactMetadata:true,snapshots:[128,256,512,640,768,1024,1408],scrubbedSamples:0});
}
writeFileSync('native-composition.json',JSON.stringify(reports,null,2));console.log(JSON.stringify(reports));
