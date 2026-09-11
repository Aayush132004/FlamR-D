/** connection.ts - Raw WebSocket Transport Layer (final) */
import type { OutboundMessage, InboundMessage } from './protocol';
import { parseInboundMessage } from './protocol';
const RECONNECT_BASE_MS = 500, RECONNECT_MAX_MS = 30_000, RECONNECT_JITTER_MS = 250, OUTBOUND_QUEUE_LIMIT = 50, PING_INTERVAL_MS = 5_000;
export type ConnectionState = 'connecting'|'connected'|'disconnected'|'reconnecting';
export interface Room { sendAction(m:OutboundMessage):void; onRemoteAction(h:(m:InboundMessage)=>void):()=>void; getState():ConnectionState; getRtt():number|null; destroy():void; }
export function createRoom(opts:{serverUrl:string;roomId:string;clientId:string;displayName?:string}): Room {
  const {serverUrl,roomId,clientId,displayName}=opts;
  let ws:WebSocket|null=null,state:ConnectionState='connecting',reconnectAttempt=0,reconnectTimer:ReturnType<typeof setTimeout>|null=null,pingTimer:ReturnType<typeof setInterval>|null=null,destroyed=false,rtt:number|null=null,pendingPingTs:number|null=null;
  const outboundQueue:string[]=[],subscribers=new Set<(m:InboundMessage)=>void>();
  function connect():void {
    if (destroyed) return; ws=new WebSocket(serverUrl); state=reconnectAttempt>0?'reconnecting':'connecting';
    ws.onopen=():void=>{ state='connected'; reconnectAttempt=0; console.log([Connection] Connected); sendRaw({type:'join',clientId,roomId,displayName}); while(outboundQueue.length>0){const r=outboundQueue.shift()!;ws!.send(r);} startPingLoop(); };
    ws.onmessage=(e:MessageEvent<string>):void=>{ let p:unknown; try{p=JSON.parse(e.data);}catch{return;} const m=parseInboundMessage(p); if(!m){console.warn('[Connection] Unknown:',p);return;} if(m.type==='pong'&&pendingPingTs!==null){rtt=Date.now()-pendingPingTs;pendingPingTs=null;} subscribers.forEach(h=>h(m)); };
    ws.onclose=(e:CloseEvent):void=>{ console.log([Connection] Closed code=); stopPingLoop(); if(!destroyed){state='disconnected';scheduleReconnect();} };
    ws.onerror=():void=>{ console.warn('[Connection] Socket error'); };
  }
  function scheduleReconnect():void {
    if (destroyed) return;
    const delay=Math.min(RECONNECT_BASE_MS*2**Math.min(reconnectAttempt,8)+Math.random()*RECONNECT_JITTER_MS,RECONNECT_MAX_MS);
    reconnectAttempt++; state='reconnecting'; console.log([Connection] Reconnecting in ms attempt );
    reconnectTimer=setTimeout(connect,delay);
  }
  function sendRaw(msg:OutboundMessage):void { const j=JSON.stringify(msg); if(ws?.readyState===WebSocket.OPEN){ws.send(j);}else if(outboundQueue.length<OUTBOUND_QUEUE_LIMIT){outboundQueue.push(j);} }
  function startPingLoop():void { stopPingLoop(); pingTimer=setInterval(()=>{ if(ws?.readyState===WebSocket.OPEN){pendingPingTs=Date.now();sendRaw({type:'ping',clientTs:pendingPingTs});}},PING_INTERVAL_MS); }
  function stopPingLoop():void { if(pingTimer!==null){clearInterval(pingTimer);pingTimer=null;} }
  connect();
  return {
    sendAction(msg:OutboundMessage):void{sendRaw(msg);},
    onRemoteAction(handler:(m:InboundMessage)=>void):()=>void{subscribers.add(handler);return():void=>{subscribers.delete(handler);};},
    getState():ConnectionState{return state;},
    getRtt():number|null{return rtt;},
    destroy():void{destroyed=true;if(reconnectTimer)clearTimeout(reconnectTimer);stopPingLoop();outboundQueue.length=0;ws?.close(1000,'destroyed');subscribers.clear();},
  };
}
export function getOrCreateClientId():string{const K='liveroom_client_id';const s=sessionStorage.getItem(K);if(s)return s;const id=${Date.now().toString(36)}-;sessionStorage.setItem(K,id);return id;}
export function getOrCreateDisplayName():string{const K='liveroom_display_name';const s=sessionStorage.getItem(K);if(s)return s;const a=['Swift','Bold','Keen','Bright','Wild','Cool','Sharp','Calm'],n=['Fox','Eagle','Wolf','Bear','Hawk','Lion','Lynx','Panda'];const nm=${a[Math.floor(Math.random()*a.length)]} ;sessionStorage.setItem(K,nm);return nm;}