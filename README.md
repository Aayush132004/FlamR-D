# Real-Time Multiplayer Cursor/State Sync

> A from-scratch real-time cursor and reaction sync engine built on raw WebSockets — no Socket.IO, no Yjs, no Liveblocks, no state-sync framework.

---

## Demo

Open multiple tabs to `http://localhost:5173` and move your cursor. Each tab sees every other tab's cursor moving smoothly. Click anywhere to send an emoji burst to all participants.

```
Tab 1 ──── WS ────┐
Tab 2 ──── WS ────┤  Node.js server  ──── fan-out ────► all other tabs
Tab 3 ──── WS ────┘
```

---

## Setup & Running

### Prerequisites
- Node.js ≥ 18
- npm ≥ 9

### 1. Install dependencies

```bash
cd server && npm install
cd ../client && npm install
```

### 2. Start the server

```bash
cd server
npm run dev
# Server listening on ws://localhost:8080
```

### 3. Start the client dev server

```bash
cd client
npm run dev
# Client available at http://localhost:5173
```

### 4. Test with multiple clients

Open **3–5 browser tabs** at `http://localhost:5173`. Each tab gets a random display name (persisted in `sessionStorage`). Move cursors and click to react.

To test with a specific room:
```
http://localhost:5173?room=my-room
```

### Custom WebSocket URL

If deploying to a remote host, set the `VITE_WS_URL` environment variable:
```bash
VITE_WS_URL=wss://your-server.com npm run build
```

---

## Protocol Design

### Transport

Raw browser `WebSocket` (client) and Node.js `http` + the [`ws`](https://github.com/websockets/ws) package (server). `ws` handles only RFC 6455 framing — it provides zero sync, rooms, or pub/sub logic. All sync semantics are implemented from scratch.

### Wire Format

Newline-delimited JSON over WebSocket text frames. Every message has a `type` discriminant (TypeScript discriminated union).

### Full Message Type Reference

#### Client → Server

| `type`     | Fields                                    | Description |
|------------|-------------------------------------------|-------------|
| `join`     | `clientId`, `roomId`, `displayName?`      | Enters a room. Must be the first message. On reconnect, replaces the stale record. |
| `cursor`   | `x`, `y` (normalized 0–1), `seq`         | Throttled cursor position. `seq` is monotonically increasing per client. |
| `reaction` | `x`, `y`, `emoji`, `id`                  | One-shot emoji burst. `id` is client-generated for deduplication. |
| `ping`     | `clientTs`                               | Application-level RTT ping. Server echoes `clientTs` back in a `pong`. |

#### Server → Client

| `type`       | Fields                                             | Description |
|--------------|----------------------------------------------------|-------------|
| `presence`   | `clients[]`, `yourClientId`                        | Full state snapshot sent to a new joiner. |
| `peer_join`  | `clientId`, `color`, `displayName`                 | Broadcast when a new peer joins. |
| `peer_leave` | `clientId`                                         | Broadcast when a peer disconnects. |
| `cursor`     | `clientId`, `x`, `y`, `seq`, `serverTs`            | Relayed cursor update. `serverTs` added for jitter analysis. |
| `reaction`   | `clientId`, `x`, `y`, `emoji`, `id`, `serverTs`    | Relayed emoji burst. |
| `pong`       | `clientTs`, `serverTs`                             | RTT response. |
| `error`      | `code`, `message`                                  | Malformed/unknown message rejection. |

### Throttling / Batching High-Frequency Events

Raw `mousemove` fires at 60–300Hz depending on hardware. Sending every event naively would saturate the connection.

**Strategy: time-gate at 30Hz (33ms)**

```typescript
// App.tsx — handleMouseMove
const now = Date.now();
if (now - lastSentRef.current < 33) return;  // drop this frame
lastSentRef.current = now;
```

This is event-driven — no `setInterval` — so it aligns naturally with the browser's event loop. At 30Hz, a cursor stream uses roughly:

```
~100 bytes/msg × 30 msg/s = ~3 KB/s per client
With 10 clients in a room: ~30 KB/s total server fan-out
```

This is easily within WebSocket budget for a LAN or cloud host. Raw 300Hz would be 10× that without any UX benefit (because interpolation smooths anyway).

---

## Interpolation Strategy

### Problem

Even with 30Hz sends, arrival times are irregular due to:
- Network jitter (±20–80ms typical)
- OS scheduler variance
- Occasional packet reordering

Naively rendering at each received position causes visible cursor teleporting.

### Solution: 80ms Playback Delay Buffer

Each remote client maintains a ring buffer of up to 16 timestamped `(x, y, t)` samples. The render loop reads at `renderTime = Date.now() − 80ms`:

```
Buffer:  [t=100, t=133, t=167, t=200, t=233] ← most recent
                     ↑
         renderTime = now − 80 = 153
         → interpolate between t=133 and t=167
         → alpha = (153 − 133) / (167 − 133) = 0.59
         → x = x133 + 0.59 × (x167 − x133)
```

This guarantees two samples to interpolate between as long as network jitter < 80ms (true for most connections).

### Dead-Reckoning Extrapolation

When `renderTime` overshoots the newest sample (cursor paused or slow network), we extrapolate using the last observed velocity vector:

```typescript
const vx = (newest.x − prev.x) / (newest.t − prev.t); // px per ms
const elapsed = Math.min(renderTime − newest.t, 200);   // cap at 200ms
x = newest.x + vx × elapsed;
```

Capped at 200ms to prevent phantom movement when the cursor genuinely stopped.

After 3s with no new position, the cursor fades out (alpha → 0) and is effectively hidden.

### Tradeoffs

| Property | Value | Notes |
|----------|-------|-------|
| Added latency | **+80ms** | Imperceptible for "watching others" |
| Jitter tolerance | **< 80ms** | Covers typical LAN + most cloud paths |
| Memory per cursor | **≤ 16 samples** | Ring buffer, no unbounded growth |
| Smoothness under throttle | High | Tested with Chrome DevTools "Slow 3G" |

For interactive direct manipulation (e.g. collaborative drawing), the buffer would be tuned to 30–40ms at the cost of visible stuttering on high-jitter links. For this use case (watching peers' cursors), 80ms is the right tradeoff.

---

## Failure Handling

### Disconnect Detection

The server sends a WS-level `ping` frame every 15 seconds. If no `pong` arrives within 10 seconds, the socket is terminated and `room.removeClient()` is called:

```
Worst-case removal latency = 15s (interval) + 10s (timeout) = 25s
```

The `ws.on('close')` and `ws.on('error')` events also trigger immediate cleanup for clean disconnects (tab close, `ws.close()`).

### Reconnect

The client uses exponential back-off reconnect with jitter:

```
delay = min(500ms × 2^attempt + random(0, 250ms), 30s)
```

On reconnect, the same `clientId` (persisted in `sessionStorage`) is reused. The server replaces the stale socket record without duplicating the peer. Queued outbound messages (cursor events sent while offline) are flushed on reconnect.

### Out-of-Order Delivery

Each cursor message carries a per-client `seq` number. The server discards updates where `seq ≤ lastSeq`. The client does the same in `RemoteCursorBuffer.push()`. This handles TCP reordering and reconnect replay without extra infrastructure.

### Malformed Messages

Server-side: every inbound message is validated with a Zod discriminated union schema. Validation failures → `error` response + `console.warn` log. The server never crashes on bad input.

Client-side: `parseInboundMessage()` checks each field manually. Unknown or structurally invalid messages are discarded with `console.warn`. The render loop and React state are never exposed to untyped data.

---

## Known Limitations

| Limitation | Notes |
|------------|-------|
| **No persistence** | All room state is lost on server restart. Clients reconnect but get an empty presence snapshot. |
| **No horizontal scaling** | A single server instance. Multi-server would require a shared pub/sub layer (e.g. Redis Pub/Sub). See ARCHITECTURE.md for discussion. |
| **No authentication** | Room IDs are public. Any client can join any room by URL param. |
| **Presence snapshot staleness** | `presence` on join shows the last-known cursor position of each peer, which may be several seconds old if they haven't moved recently. |
| **No message persistence / replay** | New joiners only see current participants' *cursor positions*, not historical reactions. |
| **80ms minimum cursor lag** | The interpolation buffer adds a fixed 80ms of perceived lag to remote cursors. This is a deliberate design choice for smoothness. |
| **Tab close detection latency** | Up to ~25s before a dead cursor is removed (heartbeat window). |

---

## Time Spent

| Phase | Hours |
|-------|-------|
| Protocol design + server (room, heartbeat, broadcast) | ~4h |
| Client WebSocket transport + reconnect logic | ~2h |
| Interpolation engine + buffer design | ~2.5h |
| Canvas renderer (cursors + reaction particles) | ~2.5h |
| React UI + CSS design system | ~3h |
| Documentation (README + ARCHITECTURE) | ~2h |
| **Total** | **~16h** |

---

## AI Tool Disclosure

**Claude (Anthropic)** was used as a pair-programming assistant for this assignment. Specifically:
- Reviewing protocol schema structure and naming
- Suggesting the `RemoteCursorBuffer` ring buffer design
- CSS design token naming conventions

All architectural decisions, implementation code, algorithm choices (interpolation strategy, heartbeat design, reconnect back-off), and documentation were written by the author with AI as a reviewer/suggester. The author can explain every line of code.
