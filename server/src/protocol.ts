/**
 * protocol.ts — Server-Side Message Schema (Zod validation)
 *
 * This is the authoritative definition of the wire protocol.
 * Every inbound message from a client is validated against these schemas.
 *
 * Why Zod on the server?
 *   - `safeParse` returns a typed discriminated union — no runtime `any`.
 *   - Validation errors include field paths and human-readable messages,
 *     which we relay back to the client as structured `error` messages.
 *   - The server is the trust boundary. Clients are untrusted.
 *
 * Why NOT Zod on the client?
 *   - Zod is ~12KB gzipped. The client uses manual type guards instead,
 *     keeping the bundle lean. The client only receives messages from our
 *     own server, so the trust model is different.
 */

import { z } from 'zod';

// ─── Inbound schemas (client → server) ────────────────────────────────────────

export const JoinMessageSchema = z.object({
  type: z.literal('join'),
  clientId: z.string().min(1).max(64).regex(/^[\w-]+$/, 'clientId must be alphanumeric + dashes'),
  roomId: z.string().min(1).max(64).regex(/^[\w-]+$/, 'roomId must be alphanumeric + dashes'),
  displayName: z.string().max(32).optional(),
});

export const CursorMessageSchema = z.object({
  type: z.literal('cursor'),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  seq: z.number().int().nonnegative(),
});

export const ReactionMessageSchema = z.object({
  type: z.literal('reaction'),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  emoji: z.string().min(1).max(8),
  id: z.string().min(1).max(64),
});

export const PingMessageSchema = z.object({
  type: z.literal('ping'),
  clientTs: z.number(),
});

export const InboundMessageSchema = z.discriminatedUnion('type', [
  JoinMessageSchema,
  CursorMessageSchema,
  ReactionMessageSchema,
  PingMessageSchema,
]);

export type JoinMessage     = z.infer<typeof JoinMessageSchema>;
export type CursorMessage   = z.infer<typeof CursorMessageSchema>;
export type ReactionMessage = z.infer<typeof ReactionMessageSchema>;
export type PingMessage     = z.infer<typeof PingMessageSchema>;
export type InboundMessage  = z.infer<typeof InboundMessageSchema>;

// ─── Outbound types (server → client) ─────────────────────────────────────────
// These don't need Zod — we construct them, so they're always valid.

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

export type OutboundMessage =
  | PresenceMessage
  | PeerJoinMessage
  | PeerLeaveMessage
  | RelayedCursorMessage
  | RelayedReactionMessage
  | PongMessage
  | ErrorMessage;