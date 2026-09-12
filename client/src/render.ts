/** render.ts - Canvas renderer for remote cursors (reactions added next) */
import { RemoteCursorBuffer } from './interpolation';
import type { PositionSample } from './interpolation';
interface RemoteCursor{clientId:string;color:string;displayName:string;buffer:RemoteCursorBuffer;}
function roundRect(ctx:CanvasRenderingContext2D,x:number,y:number,w:number,h:number,r:number):void{
  if(typeof ctx.roundRect==='function'){ctx.roundRect(x,y,w,h,r);return;}
  ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();
}
export class CanvasRenderer {
  private readonly canvas:HTMLCanvasElement; private readonly ctx:CanvasRenderingContext2D;
  private readonly cursors=new Map<string,RemoteCursor>(); private rafId:number|null=null;
  constructor(canvas:HTMLCanvasElement){this.canvas=canvas;const c=canvas.getContext('2d');if(!c)throw new Error('Canvas 2D unavailable');this.ctx=c;this.resize();}
  resize():void{const d=window.devicePixelRatio||1;this.canvas.width=this.canvas.offsetWidth*d;this.canvas.height=this.canvas.offsetHeight*d;this.ctx.setTransform(d,0,0,d,0,0);}
  addOrUpdateCursor(o:{clientId:string;color:string;displayName:string}):void{
    if(this.cursors.has(o.clientId)){const e=this.cursors.get(o.clientId)!;e.color=o.color;e.displayName=o.displayName;}
    else this.cursors.set(o.clientId,{...o,buffer:new RemoteCursorBuffer()});
  }
  removeCursor(id:string):void{this.cursors.delete(id);}
  pushPosition(id:string,x:number,y:number,seq:number,_ts:number):void{const c=this.cursors.get(id);if(c)c.buffer.push({x,y,t:Date.now(),seq} as PositionSample);}
  addReaction(_id:string,_px:number,_py:number,_emoji:string,_color:string):void{/* reactions next commit */}
  start():void{const loop=():void=>{this.render();this.rafId=requestAnimationFrame(loop);};this.rafId=requestAnimationFrame(loop);}
  stop():void{if(this.rafId!==null){cancelAnimationFrame(this.rafId);this.rafId=null;}}
  private render():void{
    const {ctx,canvas}=this,W=canvas.offsetWidth,H=canvas.offsetHeight,now=Date.now();
    ctx.clearRect(0,0,W,H);
    for(const c of this.cursors.values()){const s=c.buffer.getInterpolated(now);if(!s)continue;const a=Math.max(0,1-s.staleness*2);if(a<=0.02)continue;ctx.globalAlpha=a;this.drawCursor(s.x*W,s.y*H,c.color,c.displayName);}
    ctx.globalAlpha=1;
  }
  private drawCursor(x:number,y:number,color:string,label:string):void{
    const {ctx}=this;ctx.save();ctx.translate(x,y);
    ctx.shadowColor='rgba(0,0,0,0.45)';ctx.shadowBlur=7;ctx.shadowOffsetX=1;ctx.shadowOffsetY=2;
    ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(0,17);ctx.lineTo(4.5,14);ctx.lineTo(7,19.5);ctx.lineTo(9,18.5);ctx.lineTo(6.5,13);ctx.lineTo(11,13);ctx.closePath();
    ctx.fillStyle=color;ctx.fill();ctx.shadowColor='transparent';ctx.strokeStyle='rgba(255,255,255,0.88)';ctx.lineWidth=1.5;ctx.stroke();
    ctx.font='500 12px Inter,system-ui,sans-serif';ctx.textBaseline='middle';const tw=ctx.measureText(label).width;
    ctx.fillStyle=color;ctx.beginPath();roundRect(ctx,14-3,6-10,tw+6,20,5);ctx.fill();ctx.fillStyle='rgba(255,255,255,0.95)';ctx.fillText(label,14,6);
    ctx.restore();
  }
}