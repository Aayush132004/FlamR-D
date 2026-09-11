/** server.ts - Bootstrap (sequence check and Zod added later) */
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { parseInbound } from './protocol.js';
import { getOrCreateRoom, cleanupEmptyRooms } from './room.js';
const PORT = parseInt(process.env.PORT ?? '8080', 10);
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('{"status":"ok"}'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: httpServer });
function sendError(ws: WebSocket, code: string, msg: string): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', code, message: msg }));
}
wss.on('connection', (ws: WebSocket) => {
  let clientId: string | null = null;
  let roomId:   string | null = null;
  ws.on('pong', () => { if (clientId && roomId) getOrCreateRoom(roomId).handlePong(clientId); });
  ws.on('message', (raw: Buffer | string) => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString()); } catch { sendError(ws, 'PARSE_ERROR', 'Not valid JSON'); return; }
    const msg = parseInbound(parsed);
    if (!msg) { sendError(ws, 'UNKNOWN_TYPE', 'Unknown message type'); return; }
    switch (msg.type) {
      case 'join':     clientId = msg.clientId; roomId = msg.roomId; getOrCreateRoom(roomId).addClient(ws, clientId, msg.displayName ?? ''); break;
      case 'cursor':   if (clientId && roomId) getOrCreateRoom(roomId).updateCursor(clientId, msg.x, msg.y, msg.seq); break;
      case 'reaction': if (clientId && roomId) getOrCreateRoom(roomId).relayReaction(clientId, msg.x, msg.y, msg.emoji, msg.id); break;
      case 'ping':     if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong', clientTs: msg.clientTs, serverTs: Date.now() })); break;
    }
  });
  ws.on('close', () => { if (clientId && roomId) { getOrCreateRoom(roomId).removeClient(clientId); setImmediate(cleanupEmptyRooms); } });
  ws.on('error', (e: Error) => console.error('[Server]', e.message));
});
httpServer.listen(PORT, () => console.log(ws://localhost:));
setInterval(cleanupEmptyRooms, 5 * 60_000);