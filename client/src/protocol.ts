/**
 * protocol.ts — Client-Side Message Types & Parser
 *
 * Provides TypeScript types for the wire protocol and a `parseInboundMessage`
 * function that validates messages received from the server.
 *
 * Design decisions:
 *
 * 1. No Zod on the client.
 *    Zod is ~12KB gzipped. For a browser bundle, manual type guards are cheaper
 *    and fast enough. The client only receives messages from our own trusted server,
 *    so we need field-level presence checks, not full schema validation.
 *
 * 2. Discriminated union on `type`.
 *    TypeScript narrows the type correctly after a `switch (msg.type)` — no casts
 *    needed at the call site.
 *
 * 3. All checks are structural.
 *    We verify that required fields have the right primitive types. We don't
 *    validate ranges (e.g. x ∈ [0,1]) on the client — the renderer clamps anyway.
 */

// ─── Outbound types (client → server) ─────────────────────────────────────────

export interface JoinMessage {
  type: 'join';
  clientId: string;
  roomId: string;
  displayName?: string;
}

export interface CursorMessage {
  type: 'cursor';
  x: number;
  y: number;
  seq: number;
}

export interface ReactionMessage {
  type: 'reaction';
  x: number;
  y: number;
  emoji: string;
  id: string;
}

export interface PingMessage {
  type: 'ping';
  clientTs: number;
}

export type OutboundMessage = JoinMessage | CursorMessage | ReactionMessage | PingMessage;

// ─── Inbound types (server → client) ──────────────────────────────────────────

export interface ClientState {
  clientId: string;
  color: string;
  displayName: string;
  x: number;
  y: number;
  lastSeen: number;
}

export interface PresenceMessage {
  type: 'presence';
  clients: ClientState[];
  yourClientId: string;
}

export interface PeerJoinMessage {
  type: 'peer_join';
  clientId: string;
  color: string;
  displayName: string;
}

export interface PeerLeaveMessage {
  type: 'peer_leave';
  clientId: string;
}

export interface RelayedCursorMessage {
  type: 'cursor';
  clientId: string;
  x: number;
  y: number;
  seq: number;
  serverTs: number;
}

export interface RelayedReactionMessage {
  type: 'reaction';
  clientId: string;
  x: number;
  y: number;
  emoji: string;
  id: string;
  serverTs: number;
}

export interface PongMessage {
  type: 'pong';
  clientTs: number;
  serverTs: number;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type InboundMessage =
  | PresenceMessage
  | PeerJoinMessage
  | PeerLeaveMessage
  | RelayedCursorMessage
  | RelayedReactionMessage
  | PongMessage
  | ErrorMessage;

// ─── Parser ────────────────────────────────────────────────────────────────────

const VALID_TYPES = new Set([
  'presence', 'peer_join', 'peer_leave', 'cursor', 'reaction', 'pong', 'error',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validates and narrows an unknown value to InboundMessage.
 * Returns null if the message is unknown or structurally invalid.
 */
export function parseInboundMessage(raw: unknown): InboundMessage | null {
  if (!isRecord(raw)) return null;
  const t = raw['type'];
  if (typeof t !== 'string' || !VALID_TYPES.has(t)) return null;

  switch (t) {
    case 'presence':
      if (!Array.isArray(raw['clients']) || typeof raw['yourClientId'] !== 'string') return null;
      return raw as unknown as PresenceMessage;

    case 'peer_join':
      if (
        typeof raw['clientId'] !== 'string' ||
        typeof raw['color'] !== 'string' ||
        typeof raw['displayName'] !== 'string'
      ) return null;
      return raw as unknown as PeerJoinMessage;

    case 'peer_leave':
      if (typeof raw['clientId'] !== 'string') return null;
      return raw as unknown as PeerLeaveMessage;

    case 'cursor':
      if (
        typeof raw['clientId'] !== 'string' ||
        typeof raw['x'] !== 'number' ||
        typeof raw['y'] !== 'number' ||
        typeof raw['seq'] !== 'number' ||
        typeof raw['serverTs'] !== 'number'
      ) return null;
      return raw as unknown as RelayedCursorMessage;

    case 'reaction':
      if (
        typeof raw['clientId'] !== 'string' ||
        typeof raw['x'] !== 'number' ||
        typeof raw['y'] !== 'number' ||
        typeof raw['emoji'] !== 'string' ||
        typeof raw['id'] !== 'string'
      ) return null;
      return raw as unknown as RelayedReactionMessage;

    case 'pong':
      if (typeof raw['clientTs'] !== 'number' || typeof raw['serverTs'] !== 'number') return null;
      return raw as unknown as PongMessage;

    case 'error':
      if (typeof raw['code'] !== 'string' || typeof raw['message'] !== 'string') return null;
      return raw as unknown as ErrorMessage;

    default:
      return null;
  }
}