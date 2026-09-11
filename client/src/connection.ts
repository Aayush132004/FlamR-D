/** connection.ts - Raw WebSocket transport (basic; reconnect and RTT added next) */
import type { OutboundMessage, InboundMessage } from './protocol';
import { parseInboundMessage } from './protocol';
export type ConnectionState = 'connecting'|'connected'|'disconnected'|'reconnecting';
export interface Room { sendAction(m: OutboundMessage): void; onRemoteAction(h:(m:InboundMessage)=>void): ()=>void; getState(): ConnectionState; getRtt(): number|null; destroy(): void; }
export function createRoom(opts:{serverUrl:string;roomId:string;clientId:string;displayName?:string}): Room {
  const {serverUrl,roomId,clientId,displayName} = opts;
  let ws: WebSocket|null = null; let state: ConnectionState = 'connecting'; let destroyed = false;
  const subs = new Set<(m:InboundMessage)=>void>();
  function connect(): void {
    if (destroyed) return; ws = new WebSocket(serverUrl);
    ws.onopen = () => { state='connected'; sendRaw({type:'join',clientId,roomId,displayName}); };
    ws.onmessage = (e:MessageEvent<string>) => {
      let p: unknown; try { p=JSON.parse(e.data); } catch { return; }
      const m = parseInboundMessage(p); if (m) subs.forEach(h=>h(m));
    };
    ws.onclose = () => { state='disconnected'; if (!destroyed) setTimeout(connect,1000); };
    ws.onerror = () => {};
  }
  function sendRaw(msg: OutboundMessage): void { if (ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
  connect();
  return { sendAction:sendRaw, onRemoteAction(h){subs.add(h);return()=>subs.delete(h);}, getState:()=>state, getRtt:()=>null, destroy(){ destroyed=true; ws?.close(); subs.clear(); } };
}
export function getOrCreateClientId(): string {
  const K='liveroom_client_id'; const s=sessionStorage.getItem(K); if (s) return s;
  const id=${Date.now().toString(36)}-; sessionStorage.setItem(K,id); return id;
}
export function getOrCreateDisplayName(): string {
  const K='liveroom_display_name'; const s=sessionStorage.getItem(K); if (s) return s;
  const a=['Swift','Bold','Keen','Bright','Wild'],n=['Fox','Eagle','Wolf','Bear','Hawk'];
  const nm=${a[Math.floor(Math.random()*a.length)]} ; sessionStorage.setItem(K,nm); return nm;
}