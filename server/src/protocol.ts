/** protocol.ts - Server (stub, Zod validation added Sept 13) */
export interface JoinMessage    { type: 'join';     clientId: string; roomId: string; displayName?: string; }
export interface CursorMessage  { type: 'cursor';   x: number; y: number; seq: number; }
export interface ReactionMessage{ type: 'reaction'; x: number; y: number; emoji: string; id: string; }
export interface PingMessage    { type: 'ping';     clientTs: number; }
export type InboundMessage = JoinMessage | CursorMessage | ReactionMessage | PingMessage;

export interface ClientState { clientId: string; color: string; displayName: string; x: number; y: number; lastSeen: number; }
export interface PresenceMessage   { type: 'presence';   clients: ClientState[]; yourClientId: string; }
export interface PeerJoinMessage   { type: 'peer_join';  clientId: string; color: string; displayName: string; }
export interface PeerLeaveMessage  { type: 'peer_leave'; clientId: string; }
export interface RelayedCursorMessage   { type: 'cursor';   clientId: string; x: number; y: number; seq: number; serverTs: number; }
export interface RelayedReactionMessage { type: 'reaction'; clientId: string; x: number; y: number; emoji: string; id: string; serverTs: number; }
export interface PongMessage  { type: 'pong';  clientTs: number; serverTs: number; }
export interface ErrorMessage { type: 'error'; code: string; message: string; }
export type OutboundMessage = PresenceMessage | PeerJoinMessage | PeerLeaveMessage | RelayedCursorMessage | RelayedReactionMessage | PongMessage | ErrorMessage;

export function parseInbound(raw: unknown): InboundMessage | null {
  if (typeof raw !== 'object' || raw === null || !('type' in raw)) return null;
  const m = raw as Record<string, unknown>;
  const t = m['type'];
  if (t === 'join' && typeof m['clientId'] === 'string' && typeof m['roomId'] === 'string') return m as unknown as JoinMessage;
  if (t === 'cursor' && typeof m['x'] === 'number' && typeof m['y'] === 'number') return m as unknown as CursorMessage;
  if (t === 'reaction' && typeof m['emoji'] === 'string' && typeof m['id'] === 'string') return m as unknown as ReactionMessage;
  if (t === 'ping' && typeof m['clientTs'] === 'number') return m as unknown as PingMessage;
  return null;
}