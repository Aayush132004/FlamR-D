/** room.ts - Basic room management (heartbeat added in next commit) */
import { WebSocket } from 'ws';
import type { OutboundMessage, ClientState } from './protocol.js';
function hashColor(id: string): string {
  let h = 5381; for (let i = 0; i < id.length; i++) { h = ((h<<5)+h)^id.charCodeAt(i); h|=0; }
  return hsl(, 72%, 62%);
}
interface ClientRecord { ws: WebSocket; clientId: string; color: string; displayName: string; x: number; y: number; lastSeq: number; lastSeen: number; }
export class Room {
  private roomId: string;
  private clients = new Map<string, ClientRecord>();
  constructor(roomId: string) { this.roomId = roomId; }
  addClient(ws: WebSocket, clientId: string, displayName: string): void {
    if (this.clients.has(clientId)) this.clients.delete(clientId);
    const color = hashColor(clientId);
    const r: ClientRecord = { ws, clientId, color, displayName: (displayName||User-).slice(0,32), x:.5, y:.5, lastSeq:-1, lastSeen:Date.now() };
    this.clients.set(clientId, r);
    this.sendTo(r, { type:'presence', yourClientId:clientId, clients:this.list(clientId) });
    this.broadcast({ type:'peer_join', clientId, color, displayName:r.displayName }, clientId);
    console.log([Room ] + total:);
  }
  removeClient(clientId: string): void {
    if (!this.clients.has(clientId)) return;
    this.clients.delete(clientId);
    this.broadcast({ type:'peer_leave', clientId }, clientId);
    console.log([Room ] - total:);
  }
  updateCursor(clientId: string, x: number, y: number, seq: number): void {
    const r = this.clients.get(clientId); if (!r||seq<=r.lastSeq) return;
    r.x=x; r.y=y; r.lastSeq=seq; r.lastSeen=Date.now();
    this.broadcast({ type:'cursor', clientId, x, y, seq, serverTs:Date.now() }, clientId);
  }
  relayReaction(clientId: string, x: number, y: number, emoji: string, id: string): void {
    this.broadcast({ type:'reaction', clientId, x, y, emoji, id, serverTs:Date.now() }, clientId);
  }
  handlePong(_clientId: string): void { /* heartbeat added next commit */ }
  get size(): number { return this.clients.size; }
  private list(ex: string): ClientState[] {
    return Array.from(this.clients.values()).filter(c=>c.clientId!==ex)
      .map(c=>({ clientId:c.clientId, color:c.color, displayName:c.displayName, x:c.x, y:c.y, lastSeen:c.lastSeen }));
  }
  private broadcast(msg: OutboundMessage, skip: string): void {
    const j = JSON.stringify(msg);
    for (const [id, r] of this.clients) { if (id===skip) continue; if (r.ws.readyState===WebSocket.OPEN) r.ws.send(j); }
  }
  private sendTo(r: ClientRecord, msg: OutboundMessage): void {
    if (r.ws.readyState===WebSocket.OPEN) r.ws.send(JSON.stringify(msg));
  }
}
const rooms = new Map<string,Room>();
export function getOrCreateRoom(id: string): Room { if (!rooms.has(id)) rooms.set(id,new Room(id)); return rooms.get(id)!; }
export function cleanupEmptyRooms(): void { for (const [id,r] of rooms) if (r.size===0) rooms.delete(id); }