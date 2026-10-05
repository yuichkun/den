// Independent numeric PCM references; no production DSL/helper calls.
export const f = Math.fround;
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isNaN(v) ? 0 : v));
const modulo = (x: number, n: number) => ((x % n) + n) % n;
export function readPcm(pcm: Float32Array, position: number, start: number, end: number, loop: boolean) {
  if (end <= start) return 0;
  const p = loop ? start + modulo(position - start, end - start) : clamp(position, start, end - 1);
  const index = Math.floor(p), fraction = p - index;
  const next = index + 1 < end ? index + 1 : loop ? start : end - 1;
  const a = Number.isFinite(pcm[index]) ? pcm[index] : 0, b = Number.isFinite(pcm[next]) ? pcm[next] : 0;
  return f(a * (1 - fraction) + b * fraction);
}
export type PlayerRow = { gate: boolean; trigger: boolean; reset: boolean; rate: number };
export function playerReference(pcm: Float32Array, hostRate: number, sourceRate: number, rows: PlayerRow[], options: { start?: number; end?: number; loop?: boolean; release?: number } = {}) {
  const {start=0,end=pcm.length,loop=false,release=0}=options;
  let phase=start, active=false, previousGate=false, gain=0, remaining=0;
  const output:number[]=[], positions:number[]=[], playing:boolean[]=[];
  for (const c of rows) {
    const speed=clamp(c.rate,-16,16)*sourceRate/hostRate;
    const trigger=(c.trigger || c.gate && !previousGate) && c.gate && !c.reset && end>start;
    if(trigger){active=true;phase=speed<0?end-1:start;gain=1;remaining=release;}
    else if(!c.gate){remaining=Math.max(0,remaining-1);gain=release>0?remaining/release:0;}
    if(c.reset || end<=start)active=false;
    const on: boolean=active && gain>0;
    output.push(on?f(readPcm(pcm,phase,start,end,loop)*gain):0);positions.push(f(phase));playing.push(on);
    const advanced=phase+speed;
    phase=c.reset?start:loop?start+modulo(advanced-start,Math.max(1,end-start)):clamp(advanced,start-1,end);
    active=on && (loop || advanced>=start && advanced<end);
    if(!on)gain=0;
    previousGate=c.gate&&!c.reset;
  }
  return {output,positions,playing};
}
export type GrainRow={gate:boolean;reset:boolean;position:number;jitter:number;rate:number;duration:number;density:number};
export function grainReference(pcm:Float32Array, hostRate:number, sourceRate:number, maxGrains:number, seed:number, rows:GrainRow[],loop=true){
  let random=seed,clock=0,lastGate=false;
  const grains=Array.from({length:maxGrains},()=>({position:0,age:0,duration:3,speed:0,active:false}));
  const output:number[]=[],onsets:number[]=[],counts:number[]=[],dropped:number[]=[];
  for(const c of rows){
    const rising=c.gate&&!lastGate;if(c.reset||rising)clock=0;
    const onset=c.gate&&!c.reset&&pcm.length>0&&(rising||clock>=1);
    if(c.reset)random=seed;
    if(onset)random=random*48271%2147483647;
    const center=clamp(clamp(c.position,0,pcm.length-1)+(random/2147483647*2-1)*clamp(c.jitter,0,pcm.length-1),0,pcm.length-1);
    let allocated=false,sum=0,count=0;
    for(const g of grains){
      if(c.reset||g.age>=g.duration)g.active=false;
      if(onset&&!allocated&&!g.active){allocated=true;Object.assign(g,{position:center,age:0,duration:clamp(Math.floor(clamp(c.duration,0,2)*hostRate+0.5),3,hostRate*2),speed:clamp(c.rate,-16,16)*sourceRate/hostRate,active:true});}
      if(g.active){
        const window=Math.max(0,1-Math.abs(2*g.age/(g.duration-1)-1));
        if(loop||g.position>=0&&g.position<pcm.length)sum+=readPcm(pcm,g.position,0,pcm.length,loop)*window;
        count++;g.age++;if(g.age>=g.duration)g.active=false;
      }else g.age=0;
      g.position=loop?modulo(g.position+g.speed,Math.max(1,pcm.length)):clamp(g.position+g.speed,-pcm.length*48,pcm.length*48);
    }
    output.push(f(sum/maxGrains));onsets.push(+onset);counts.push(count);dropped.push(+(onset&&!allocated));
    clock=c.gate&&!c.reset?clock-Math.floor(clock)+clamp(c.density,0,2000)/hostRate:0;lastGate=c.gate&&!c.reset;
  }
  return {output,onsets,counts,dropped};
}
