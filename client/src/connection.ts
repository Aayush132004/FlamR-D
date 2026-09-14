/**
 * connection.ts — Raw WebSocket Transport Layer
 *
 * Implements the `createRoom` function — the API surface consumed by the React UI.
 * This module handles everything below the protocol level:
 *
 *   - Native browser `WebSocket` construction (no libraries)
 *   - Automatic reconnect with exponential back-off + jitter
 *   - Outbound message queue: messages sent while disconnected are held (capped at 50)
 *     and flushed on reconnect
 *   - clientId persistence via sessionStorage (survives page refresh, not tab close)
 *     sessionStorage scope: same tab + page refreshes. Tab close = new ID on reopen.
 *   - Application-level RTT measurement via ping/pong
 *   - Typed message dispatch via `parseInboundMessage`
 *
 * Protocol boundary: this module only calls JSON.parse/stringify and dispatches
 * typed messages. It does not interpret message semantics — that is the UI's job.
 *
 * What this module does NOT do:
 *   - Throttle cursor events (done in App.tsx via requestAnimationFrame-aligned timer)
 *   - Buffer positions for interpolation (done in interpolation.ts)
 *   - Render anything (done in render.ts)
 */

import type { OutboundMessage, InboundMessage } from './protocol';
import { parseInboundMessage } from './protocol';

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Initial delay before first reconnect attempt. */
const RECONNECT_BASE_MS = 500;
/** Maximum delay between reconnect attempts (exponential back-off cap). */
const RECONNECT_MAX_MS = 30_000;
/** Random jitter added to each reconnect delay to avoid thundering-herd. */
const RECONNECT_JITTER_MS = 250;
/** Maximum number of messages to queue while disconnected. */
const OUTBOUND_QUEUE_LIMIT = 50;
/** Interval for application-level RTT pings. */
const PING_INTERVAL_MS = 5_000;

// ─── Types ──────────────────────────────────────────────────────────────────────

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

/**
 * The public API returned by `createRoom`.
 * Matches the assignment's expected interface:
 *   `room.sendAction(action)` and `room.onRemoteAction(handler)`
 */
export interface Room {
  /** Send a typed message to the server. Queued automatically if not yet connected. */
  sendAction(msg: OutboundMessage): void;
  /**
   * Subscribe to all inbound messages from the server.
   * Returns an unsubscribe function.
   */
  onRemoteAction(handler: (msg: InboundMessage) => void): () => void;
  /** Current connection state — poll at low frequency (e.g. every 300ms) for UI. */
  getState(): ConnectionState;
  /** Last measured round-trip time in ms, or null if not yet measured. */
  getRtt(): number | null;
  /** Tear down the connection and cancel all timers. */
  destroy(): void;
}

// ─── createRoom ─────────────────────────────────────────────────────────────────

export function createRoom(opts: {
  serverUrl: string;
  roomId: string;
  clientId: string;
  displayName?: string;
}): Room {
  const { serverUrl, roomId, clientId, displayName } = opts;

  let ws: WebSocket | null = null;
  let state: ConnectionState = 'connecting';
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;
  let rtt: number | null = null;
  let pendingPingTs: number | null = null;

  /** Messages queued while the socket is not open. */
  const outboundQueue: string[] = [];
  /** Active message subscribers. */
  const subscribers = new Set<(msg: InboundMessage) => void>();

  // ── Core connect / reconnect loop ─────────────────────────────────────────────

  function connect(): void {
    if (destroyed) return;

    ws = new WebSocket(serverUrl);
    state = reconnectAttempt > 0 ? 'reconnecting' : 'connecting';

    ws.onopen = (): void => {
      state = 'connected';
      reconnectAttempt = 0;
      console.log(`[Connection] Connected to ${serverUrl}`);

      // Always send join first — the server expects it before any other message.
      // On reconnect this re-registers the same clientId, replacing the stale record.
      sendRaw({ type: 'join', clientId, roomId, displayName });

      // Flush any queued messages (cursor/reaction events sent while offline).
      while (outboundQueue.length > 0) {
        const raw = outboundQueue.shift()!;
        ws!.send(raw);
      }

      startPingLoop();
    };

    ws.onmessage = (event: MessageEvent<string>): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        console.warn('[Connection] Received non-JSON frame — ignoring');
        return;
      }

      const msg = parseInboundMessage(parsed);
      if (!msg) {
        console.warn('[Connection] Unknown or malformed message — ignoring:', parsed);
        return;
      }

      // Measure RTT from application-level pong.
      if (msg.type === 'pong' && pendingPingTs !== null) {
        rtt = Date.now() - pendingPingTs;
        pendingPingTs = null;
      }

      // Dispatch to all subscribers.
      subscribers.forEach(handler => handler(msg));
    };

    ws.onclose = (event: CloseEvent): void => {
      console.log(`[Connection] Closed: code=${event.code} wasClean=${event.wasClean}`);
      stopPingLoop();
      if (!destroyed) {
        state = 'disconnected';
        scheduleReconnect();
      }
    };

    ws.onerror = (): void => {
      // The `close` event always follows `error`, so cleanup is handled there.
      console.warn(`[Connection] Socket error (reconnect will follow)`);
    };
  }

  function scheduleReconnect(): void {
    if (destroyed) return;
    // Exponential back-off: delay = min(base * 2^attempt + jitter, max)
    const backoff = RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempt, 8);
    const jitter = Math.random() * RECONNECT_JITTER_MS;
    const delay = Math.min(backoff + jitter, RECONNECT_MAX_MS);
    reconnectAttempt++;
    state = 'reconnecting';
    console.log(`[Connection] Reconnecting in ${delay.toFixed(0)}ms (attempt ${reconnectAttempt})`);
    reconnectTimer = setTimeout(connect, delay);
  }

  // ── Send helpers ──────────────────────────────────────────────────────────────

  function sendRaw(msg: OutboundMessage): void {
    const json = JSON.stringify(msg);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(json);
    } else {
      // Queue for delivery on reconnect, but cap to prevent unbounded memory growth.
      if (outboundQueue.length < OUTBOUND_QUEUE_LIMIT) {
        outboundQueue.push(json);
      }
    }
  }

  // ── Ping / RTT ────────────────────────────────────────────────────────────────

  function startPingLoop(): void {
    stopPingLoop();
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        pendingPingTs = Date.now();
        sendRaw({ type: 'ping', clientTs: pendingPingTs });
      }
    }, PING_INTERVAL_MS);
  }

  function stopPingLoop(): void {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  // ── Kick off initial connection ────────────────────────────────────────────────
  connect();

  // ─── Public Room interface ─────────────────────────────────────────────────────

  return {
    sendAction(msg: OutboundMessage): void {
      sendRaw(msg);
    },

    onRemoteAction(handler: (msg: InboundMessage) => void): () => void {
      subscribers.add(handler);
      return (): void => { subscribers.delete(handler); };
    },

    getState(): ConnectionState {
      return state;
    },

    getRtt(): number | null {
      return rtt;
    },

    destroy(): void {
      destroyed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      stopPingLoop();
      outboundQueue.length = 0;
      ws?.close(1000, 'Client destroyed');
      subscribers.clear();
    },
  };
}

// ─── clientId persistence helper ───────────────────────────────────────────────

/**
 * Generates (or retrieves from sessionStorage) a stable client ID.
 *
 * sessionStorage scope: same tab + page refreshes. Closing the tab → new ID on reopen.
 * This lets a user refresh without duplicating their cursor, while a new tab
 * gets a fresh identity (intentional — different viewport = different participant).
 */
export function getOrCreateClientId(): string {
  const KEY = 'liveroom_client_id';
  const stored = sessionStorage.getItem(KEY);
  if (stored) return stored;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  sessionStorage.setItem(KEY, id);
  return id;
}

/** Generates (or retrieves) a random display name persisted in sessionStorage. */
export function getOrCreateDisplayName(): string {
  const KEY = 'liveroom_display_name';
  const stored = sessionStorage.getItem(KEY);
  if (stored) return stored;
  const adj = ['Swift', 'Bold', 'Keen', 'Bright', 'Wild', 'Cool', 'Sharp', 'Calm'];
  const noun = ['Fox', 'Eagle', 'Wolf', 'Bear', 'Hawk', 'Lion', 'Lynx', 'Panda'];
  const name = `${adj[Math.floor(Math.random() * adj.length)]} ${noun[Math.floor(Math.random() * noun.length)]}`;
  sessionStorage.setItem(KEY, name);
  return name;
}