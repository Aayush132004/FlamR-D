/** protocol.ts - Server (final with Zod discriminated union validation) */
import { z } from 'zod';
export const JoinMessageSchema    = z.object({type:z.literal('join'),    clientId:z.string().min(1).max(64).regex(/^[\w-]+$/),roomId:z.string().min(1).max(64).regex(/^[\w-]+$/),displayName:z.string().max(32).optional()});
export const CursorMessageSchema  = z.object({type:z.literal('cursor'),  x:z.number().min(0).max(1),y:z.number().min(0).max(1),seq:z.number().int().nonnegative()});
export const ReactionMessageSchema= z.object({type:z.literal('reaction'),x:z.number().min(0).max(1),y:z.number().min(0).max(1),emoji:z.string().min(1).max(8),id:z.string().min(1).max(64)});
export const PingMessageSchema    = z.object({type:z.literal('ping'),    clientTs:z.number()});
export const InboundMessageSchema = z.discriminatedUnion('type',[JoinMessageSchema,CursorMessageSchema,ReactionMessageSchema,PingMessageSchema]);
export type JoinMessage    = z.infer<typeof JoinMessageSchema>;
export type CursorMessage  = z.infer<typeof CursorMessageSchema>;
export type ReactionMessage= z.infer<typeof ReactionMessageSchema>;
export type PingMessage    = z.infer<typeof PingMessageSchema>;
export type InboundMessage = z.infer<typeof InboundMessageSchema>;
export interface ClientState{clientId:string;color:string;displayName:string;x:number;y:number;lastSeen:number;}
export interface PresenceMessage   {type:'presence';  clients:ClientState[];yourClientId:string;}
export interface PeerJoinMessage   {type:'peer_join'; clientId:string;color:string;displayName:string;}
export interface PeerLeaveMessage  {type:'peer_leave';clientId:string;}
export interface RelayedCursorMessage  {type:'cursor';  clientId:string;x:number;y:number;seq:number;serverTs:number;}
export interface RelayedReactionMessage{type:'reaction';clientId:string;x:number;y:number;emoji:string;id:string;serverTs:number;}
export interface PongMessage  {type:'pong'; clientTs:number;serverTs:number;}
export interface ErrorMessage {type:'error';code:string;message:string;}
export type OutboundMessage=PresenceMessage|PeerJoinMessage|PeerLeaveMessage|RelayedCursorMessage|RelayedReactionMessage|PongMessage|ErrorMessage;