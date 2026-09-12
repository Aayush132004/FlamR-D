/** interpolation.ts - 80ms buffered linear interpolation (extrapolation added Sept 13) */
export const BUFFER_DELAY_MS = 80;
const MAX_BUFFER_SIZE = 16, STALE_THRESHOLD_MS = 3_000;
export interface PositionSample { x:number; y:number; t:number; seq:number; }
export interface InterpolatedState { x:number; y:number; isStale:boolean; staleness:number; }
export class RemoteCursorBuffer {
  private readonly buffer: PositionSample[] = [];
  private lastSeq = -1;
  push(s: PositionSample): boolean {
    if (s.seq<=this.lastSeq) return false; this.lastSeq=s.seq; this.buffer.push(s);
    if (this.buffer.length>MAX_BUFFER_SIZE) this.buffer.shift(); return true;
  }
  getInterpolated(now: number): InterpolatedState|null {
    if (!this.buffer.length) return null;
    const rt=now-BUFFER_DELAY_MS, newest=this.buffer[this.buffer.length-1];
    const staleness=Math.min((now-newest.t)/STALE_THRESHOLD_MS,1), isStale=staleness>=1;
    if (this.buffer.length===1||rt<=this.buffer[0].t) return {x:this.buffer[0].x,y:this.buffer[0].y,isStale,staleness};
    if (rt>=newest.t) return {x:newest.x,y:newest.y,isStale,staleness};
    for (let i=1;i<this.buffer.length;i++) {
      const l=this.buffer[i-1],r=this.buffer[i];
      if (rt>=l.t&&rt<=r.t) { const a=(rt-l.t)/(r.t-l.t); return {x:l.x+a*(r.x-l.x),y:l.y+a*(r.y-l.y),isStale,staleness}; }
    }
    return {x:newest.x,y:newest.y,isStale,staleness};
  }
  get isEmpty(): boolean { return !this.buffer.length; }
  get latestTimestamp(): number|null { return this.buffer.length?this.buffer[this.buffer.length-1].t:null; }
}