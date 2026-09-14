/**
 * server.ts — Entry Point
 *
 * Creates an HTTP server (for health checks) and upgrades WebSocket connections
 * using the `ws` package — the RFC 6455 protocol adapter for Node.js.
 *
 * Note on `ws`: This package only handles WebSocket frame parsing and handshake
 * (the raw bytes of the protocol). It provides no rooms, no pub/sub, no event
 * broadcasting, no state sync. It is to WebSocket what Node's `http` is to HTTP —
 * a minimal protocol adapter. All sync logic is our own.
 *
 * Message types handled: join, cursor, reaction, ping
 * Unknown types: rejected with error message
 *
 * Message lifecycle:
 *   1. Raw bytes arrive → JSON.parse
 *   2. Zod safeParse → reject malformed with `error` message
 *   3. Route to Room method (addClient / updateCursor / relayReaction / handlePong)
 *   4. Room fans out to peers, never echoing back to the sender
 *   5. WS close/error → Room.removeClient → peer_leave broadcast
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { InboundMessageSchema } from './protocol.js';
import { getOrCreateRoom, cleanupEmptyRooms } from './room.js';

const PORT = parseInt(process.env.PORT ?? '8080', 10);

// ─── HTTP Server ───────────────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  // Allow cross-origin requests (for health checks from monitoring tools).
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
    return;
  }

  // All other HTTP routes: 404. The app is WS-only.
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found. Connect via WebSocket.');
});

// ─── WebSocket Server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws: WebSocket, req) => {
  const remoteIp = req.socket.remoteAddress ?? 'unknown';
  console.log(`[Server] New connection from ${remoteIp}`);

  // Per-connection state — only set after a valid 'join' message is received.
  let clientId: string | null = null;
  let roomId: string | null = null;

  // ── WS-level pong (heartbeat response from client to server ping frame) ──────
  ws.on('pong', () => {
    if (clientId && roomId) {
      getOrCreateRoom(roomId).handlePong(clientId);
    }
  });

  // ── Incoming messages ────────────────────────────────────────────────────────
  ws.on('message', (rawData: Buffer | string) => {
    // Step 1: Parse JSON — reject non-JSON immediately.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData.toString());
    } catch {
      sendError(ws, 'PARSE_ERROR', 'Message is not valid JSON');
      return;
    }

    // Step 2: Validate shape — reject unknown/malformed message types.
    const result = InboundMessageSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      sendError(ws, 'VALIDATION_ERROR', `Invalid message: ${issues}`);
      console.warn(`[Server] Rejected message from ${clientId ?? remoteIp}:`, issues);
      return;
    }

    // Step 3: Route to the appropriate handler.
    const msg = result.data;

    switch (msg.type) {
      case 'join': {
        if (clientId !== null) {
          // Prevent a client from joining twice on the same socket.
          sendError(ws, 'ALREADY_JOINED', 'Already joined. Open a new connection to change rooms.');
          return;
        }
        clientId = msg.clientId;
        roomId = msg.roomId;
        getOrCreateRoom(roomId).addClient(ws, clientId, msg.displayName ?? '');
        break;
      }

      case 'cursor': {
        if (!clientId || !roomId) {
          sendError(ws, 'NOT_JOINED', 'Send a join message before sending cursor updates');
          return;
        }
        getOrCreateRoom(roomId).updateCursor(clientId, msg.x, msg.y, msg.seq);
        break;
      }

      case 'reaction': {
        if (!clientId || !roomId) {
          sendError(ws, 'NOT_JOINED', 'Send a join message before sending reactions');
          return;
        }
        getOrCreateRoom(roomId).relayReaction(clientId, msg.x, msg.y, msg.emoji, msg.id);
        break;
      }

      case 'ping': {
        // Application-level ping for RTT measurement (distinct from WS-level ping frames).
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong', clientTs: msg.clientTs, serverTs: Date.now() }));
        }
        break;
      }
    }
  });

  // ── Connection lifecycle ─────────────────────────────────────────────────────

  ws.on('close', (code, reason) => {
    const reasonStr = reason.toString() || '(no reason)';
    console.log(`[Server] Connection closed: client=${clientId ?? 'unjoined'} code=${code} reason=${reasonStr}`);
    cleanup();
  });

  ws.on('error', (err) => {
    // `error` is always followed by `close`, so cleanup is handled there.
    console.error(`[Server] Socket error for client=${clientId ?? 'unjoined'}:`, err.message);
  });

  function cleanup(): void {
    if (clientId && roomId) {
      getOrCreateRoom(roomId).removeClient(clientId);
      // Defer empty-room cleanup so the removeClient broadcast can complete.
      setImmediate(cleanupEmptyRooms);
    }
  }
});

// ─── Error handling ────────────────────────────────────────────────────────────

wss.on('error', (err) => {
  console.error('[WSServer] Server-level error:', err.message);
});

function sendError(ws: WebSocket, code: string, message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'error', code, message }));
  }
}

// ─── Start ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[Server] HTTP:  http://localhost:${PORT}/health`);
  console.log(`[Server] WS:    ws://localhost:${PORT}`);
  console.log('[Server] Ready — waiting for clients');
});

// Periodic empty-room GC — rooms with zero clients are cleaned up every 5 minutes.
setInterval(cleanupEmptyRooms, 5 * 60 * 1_000);

// Graceful shutdown on SIGINT/SIGTERM (e.g. Ctrl-C in dev, or container stop).
const shutdown = (): void => {
  console.log('[Server] Shutting down…');
  wss.close(() => httpServer.close(() => process.exit(0)));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);