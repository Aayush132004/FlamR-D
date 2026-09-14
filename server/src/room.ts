/**
 * room.ts — Room & Presence Management
 *
 * A Room is an in-memory collection of connected WebSocket clients.
 * Responsibilities:
 *   - Track each client's last known cursor position and metadata.
 *   - Fan-out messages to all peers (O(n), never echo to sender).
 *   - Send a full presence snapshot to new joiners.
 *   - Detect dead connections via WS-level ping/pong heartbeat and remove them
 *     within a bounded window (HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS).
 *   - Handle reconnect: same clientId replaces stale socket without duplicating.
 *
 * What the server does NOT do:
 *   - Persist state across restarts.
 *   - Transform or merge cursors — pure relay.
 *   - Echo a message back to its sender.
 */

import { WebSocket } from 'ws';
import type {
  ClientState,
  OutboundMessage,
  PresenceMessage,
  PeerJoinMessage,
  PeerLeaveMessage,
} from './protocol.js';

// ─── Constants ──────────────────────────────────────────────────────────────────

/** How often to send a WS-level ping frame to each client. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How long to wait for a pong after a ping before considering the socket dead.
 * Total worst-case removal latency = HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS = 25s.
 */
const HEARTBEAT_TIMEOUT_MS = 10_000;

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derives a deterministic, visually distinct HSL color from a clientId string.
 * Uses a simple Bernstein hash. Two different IDs very rarely produce the same hue
 * in practice across ≤ 20 clients.
 */
function hashColor(clientId: string): string {
  let hash = 5381;
  for (let i = 0; i < clientId.length; i++) {
    hash = ((hash << 5) + hash) ^ clientId.charCodeAt(i);
    hash |= 0; // coerce to 32-bit int
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 72%, 62%)`;
}

// ─── ClientRecord ──────────────────────────────────────────────────────────────

interface ClientRecord {
  ws: WebSocket;
  readonly clientId: string;
  readonly color: string;
  readonly displayName: string;
  /** Last relayed normalized cursor x [0, 1]. */
  x: number;
  /** Last relayed normalized cursor y [0, 1]. */
  y: number;
  /** Highest sequence number received from this client — for out-of-order discard. */
  lastSeq: number;
  /** Unix ms of last received cursor or reaction message. */
  lastSeen: number;
  /** Whether the most recent ping has received a pong. Reset to false on each ping. */
  isAlive: boolean;
  pingTimer: ReturnType<typeof setInterval> | undefined;
  pongTimeout: ReturnType<typeof setTimeout> | undefined;
}

// ─── Room ──────────────────────────────────────────────────────────────────────

export class Room {
  private readonly roomId: string;
  private readonly clients = new Map<string, ClientRecord>();

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Registers a new (or reconnecting) client.
   *
   * On reconnect: the old record (dead socket) is cleaned up and replaced.
   * The joining client receives a `presence` snapshot of all existing peers.
   * All existing peers receive a `peer_join` notification.
   */
  addClient(ws: WebSocket, clientId: string, rawDisplayName: string): void {
    // Clean up any stale record for the same clientId (reconnect scenario).
    if (this.clients.has(clientId)) {
      const stale = this.clients.get(clientId)!;
      clearInterval(stale.pingTimer);
      clearTimeout(stale.pongTimeout);
      // Don't close the stale socket — it's already dead (that's why they're reconnecting).
      this.clients.delete(clientId);
      console.log(`[Room ${this.roomId}] Replaced stale socket for ${clientId}`);
    }

    const displayName = (rawDisplayName || `User-${clientId.slice(0, 6)}`).slice(0, 32);
    const color = hashColor(clientId);

    const record: ClientRecord = {
      ws,
      clientId,
      color,
      displayName,
      x: 0.5,
      y: 0.5,
      lastSeq: -1,
      lastSeen: Date.now(),
      isAlive: true,
      pingTimer: undefined,
      pongTimeout: undefined,
    };

    this.clients.set(clientId, record);
    this.startHeartbeat(record);

    // Send presence snapshot (all current peers) to the new joiner.
    const presence: PresenceMessage = {
      type: 'presence',
      yourClientId: clientId,
      clients: this.buildPresenceList(clientId),
    };
    this.sendTo(record, presence);

    // Notify all existing peers about the new joiner.
    const joinMsg: PeerJoinMessage = {
      type: 'peer_join',
      clientId,
      color,
      displayName,
    };
    this.broadcast(joinMsg, clientId);

    console.log(`[Room ${this.roomId}] +${clientId} (${displayName}). Peers: ${this.clients.size}`);
  }

  /**
   * Removes a client and notifies remaining peers.
   * Safe to call multiple times — idempotent.
   */
  removeClient(clientId: string): void {
    const record = this.clients.get(clientId);
    if (!record) return;

    clearInterval(record.pingTimer);
    clearTimeout(record.pongTimeout);
    this.clients.delete(clientId);

    const leaveMsg: PeerLeaveMessage = { type: 'peer_leave', clientId };
    this.broadcast(leaveMsg, clientId);

    console.log(`[Room ${this.roomId}] -${clientId}. Peers: ${this.clients.size}`);
  }

  /**
   * Relays a cursor update to all other peers.
   * Out-of-order updates (seq ≤ lastSeq) are silently discarded.
   */
  updateCursor(clientId: string, x: number, y: number, seq: number): void {
    const record = this.clients.get(clientId);
    if (!record) return;

    if (seq <= record.lastSeq) return; // Discard out-of-order

    record.x = x;
    record.y = y;
    record.lastSeq = seq;
    record.lastSeen = Date.now();

    this.broadcast(
      { type: 'cursor', clientId, x, y, seq, serverTs: Date.now() },
      clientId,
    );
  }

  /**
   * Relays an emoji reaction to all other peers.
   */
  relayReaction(clientId: string, x: number, y: number, emoji: string, id: string): void {
    this.broadcast(
      { type: 'reaction', clientId, x, y, emoji, id, serverTs: Date.now() },
      clientId,
    );
  }

  /** Called when a WS-level pong frame arrives from a client. */
  handlePong(clientId: string): void {
    const record = this.clients.get(clientId);
    if (!record) return;
    record.isAlive = true;
    clearTimeout(record.pongTimeout);
  }

  get size(): number {
    return this.clients.size;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private buildPresenceList(excludeClientId: string): ClientState[] {
    return Array.from(this.clients.values())
      .filter(c => c.clientId !== excludeClientId)
      .map(c => ({
        clientId: c.clientId,
        color: c.color,
        displayName: c.displayName,
        x: c.x,
        y: c.y,
        lastSeen: c.lastSeen,
      }));
  }

  private broadcast(msg: OutboundMessage, skipClientId: string): void {
    const json = JSON.stringify(msg);
    for (const [id, record] of this.clients) {
      // CRITICAL: Never echo a message back to its sender.
      if (id === skipClientId) continue;
      if (record.ws.readyState === WebSocket.OPEN) {
        record.ws.send(json);
      }
    }
  }

  private sendTo(record: ClientRecord, msg: OutboundMessage): void {
    if (record.ws.readyState === WebSocket.OPEN) {
      record.ws.send(JSON.stringify(msg));
    }
  }

  private startHeartbeat(record: ClientRecord): void {
    record.pingTimer = setInterval(() => {
      if (!record.isAlive) {
        console.log(`[Room ${this.roomId}] Heartbeat failed for ${record.clientId} — terminating`);
        record.ws.terminate();
        this.removeClient(record.clientId);
        return;
      }

      record.isAlive = false;
      record.ws.ping(); // WS-level ping frame

      record.pongTimeout = setTimeout(() => {
        if (!record.isAlive) {
          console.log(`[Room ${this.roomId}] Pong timeout for ${record.clientId} — terminating`);
          record.ws.terminate();
          this.removeClient(record.clientId);
        }
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }
}

// ─── Room Registry ─────────────────────────────────────────────────────────────

const rooms = new Map<string, Room>();

/** Returns the room for `roomId`, creating it if it doesn't exist. */
export function getOrCreateRoom(roomId: string): Room {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Room(roomId));
    console.log(`[Registry] Created room '${roomId}'`);
  }
  return rooms.get(roomId)!;
}

/** Removes rooms with zero clients. Called periodically and after each disconnect. */
export function cleanupEmptyRooms(): void {
  for (const [id, room] of rooms) {
    if (room.size === 0) {
      rooms.delete(id);
      console.log(`[Registry] Removed empty room '${id}'`);
    }
  }
}