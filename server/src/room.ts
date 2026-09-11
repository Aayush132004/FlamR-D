/** room.ts - Room with heartbeat (refactored to final version Sept 13) */
import { WebSocket } from 'ws';
import type { OutboundMessage, ClientState, PresenceMessage, PeerJoinMessage, PeerLeaveMessage } from './protocol.js';
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS  = 10_000;
function hashColor(id: string): string {
  let h = 5381; for (let i = 0; i < id.length; i++) { h = ((h<<5)+h)^id.charCodeAt(i); h|=0; }
  return hsl(, 72%, 62%);
}
interface ClientRecord {
  ws: WebSocket; readonly clientId: string; readonly color: string; readonly displayName: string;
  x: number; y: number; lastSeq: number; lastSeen: number; isAlive: boolean;
  pingTimer: ReturnType<typeof setInterval>|undefined; pongTimeout: ReturnType<typeof setTimeout>|undefined;
}
export class Room {
  private readonly roomId: string;
  private readonly clients = new Map<string, ClientRecord>();
  constructor(roomId: string) { this.roomId = roomId; }
  addClient(ws: WebSocket, clientId: string, rawName: string): void {
    if (this.clients.has(clientId)) { const s = this.clients.get(clientId)!; clearInterval(s.pingTimer); clearTimeout(s.pongTimeout); this.clients.delete(clientId); }
    const displayName = (rawName||User-).slice(0,32);
    const color = hashColor(clientId);
    const r: ClientRecord = { ws, clientId, color, displayName, x:.5, y:.5, lastSeq:-1, lastSeen:Date.now(), isAlive:true, pingTimer:undefined, pongTimeout:undefined };
    this.clients.set(clientId, r);
    this.startHeartbeat(r);
    const pm: PresenceMessage = { type:'presence', yourClientId:clientId, clients:this.presenceList(clientId) };
    this.sendTo(r, pm);
    const jm: PeerJoinMessage = { type:'peer_join', clientId, color, displayName };
    this.broadcast(jm, clientId);
    console.log([Room ] + peers:);
  }
  removeClient(clientId: string): void {
    const r = this.clients.get(clientId); if (!r) return;
    clearInterval(r.pingTimer); clearTimeout(r.pongTimeout); this.clients.delete(clientId);
    const lm: PeerLeaveMessage = { type:'peer_leave', clientId };
    this.broadcast(lm, clientId);
    console.log([Room ] - peers:);
  }
  updateCursor(clientId: string, x: number, y: number, seq: number): void {
    const r = this.clients.get(clientId); if (!r||seq<=r.lastSeq) return;
    r.x=x; r.y=y; r.lastSeq=seq; r.lastSeen=Date.now();
    this.broadcast({ type:'cursor', clientId, x, y, seq, serverTs:Date.now() }, clientId);
  }
  relayReaction(clientId: string, x: number, y: number, emoji: string, id: string): void {
    this.broadcast({ type:'reaction', clientId, x, y, emoji, id, serverTs:Date.now() }, clientId);
  }
  handlePong(clientId: string): void { const r = this.clients.get(clientId); if (r) { r.isAlive=true; clearTimeout(r.pongTimeout); } }
  get size(): number { return this.clients.size; }
  private presenceList(ex: string): ClientState[] {
    return Array.from(this.clients.values()).filter(c=>c.clientId!==ex)
      .map(c=>({ clientId:c.clientId, color:c.color, displayName:c.displayName, x:c.x, y:c.y, lastSeen:c.lastSeen }));
  }
  private broadcast(msg: OutboundMessage, skip: string): void {
    const j = JSON.stringify(msg);
    // CRITICAL: Never echo a message back to its sender.
    for (const [id, r] of this.clients) { if (id===skip) continue; if (r.ws.readyState===WebSocket.OPEN) r.ws.send(j); }
  }
  private sendTo(r: ClientRecord, msg: OutboundMessage): void { if (r.ws.readyState===WebSocket.OPEN) r.ws.send(JSON.stringify(msg)); }
  private startHeartbeat(r: ClientRecord): void {
    r.pingTimer = setInterval(() => {
      if (!r.isAlive) { console.log([Room ] HB fail ); r.ws.terminate(); this.removeClient(r.clientId); return; }
      r.isAlive = false; r.ws.ping();
      r.pongTimeout = setTimeout(() => { if (!r.isAlive) { r.ws.terminate(); this.removeClient(r.clientId); } }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }
}
const rooms = new Map<string,Room>();
export function getOrCreateRoom(id: string): Room {
  if (!rooms.has(id)) { rooms.set(id,new Room(id)); console.log([Registry] Created ''); }
  return rooms.get(id)!;
}
export function cleanupEmptyRooms(): void { for (const [id,r] of rooms) if (r.size===0) { rooms.delete(id); console.log([Registry] Removed ''); } }