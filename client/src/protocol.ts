/** protocol.ts - Client (final with comprehensive type guards) */
export interface JoinMessage    {type:'join';    clientId:string;roomId:string;displayName?:string;}
export interface CursorMessage  {type:'cursor';  x:number;y:number;seq:number;}
export interface ReactionMessage{type:'reaction';x:number;y:number;emoji:string;id:string;}
export interface PingMessage    {type:'ping';    clientTs:number;}
export type OutboundMessage=JoinMessage|CursorMessage|ReactionMessage|PingMessage;
export interface ClientState{clientId:string;color:string;displayName:string;x:number;y:number;lastSeen:number;}
export interface PresenceMessage   {type:'presence';  clients:ClientState[];yourClientId:string;}
export interface PeerJoinMessage   {type:'peer_join'; clientId:string;color:string;displayName:string;}
export interface PeerLeaveMessage  {type:'peer_leave';clientId:string;}
export interface RelayedCursorMessage  {type:'cursor';  clientId:string;x:number;y:number;seq:number;serverTs:number;}
export interface RelayedReactionMessage{type:'reaction';clientId:string;x:number;y:number;emoji:string;id:string;serverTs:number;}
export interface PongMessage  {type:'pong'; clientTs:number;serverTs:number;}
export interface ErrorMessage {type:'error';code:string;message:string;}
export type InboundMessage=PresenceMessage|PeerJoinMessage|PeerLeaveMessage|RelayedCursorMessage|RelayedReactionMessage|PongMessage|ErrorMessage;
const VALID=new Set(['presence','peer_join','peer_leave','cursor','reaction','pong','error']);
function isRecord(v:unknown):v is Record<string,unknown>{return typeof v==='object'&&v!==null&&!Array.isArray(v);}
export function parseInboundMessage(raw:unknown):InboundMessage|null{
  if(!isRecord(raw))return null;const t=raw['type'];if(typeof t!=='string'||!VALID.has(t))return null;
  switch(t){
    case 'presence':    if(!Array.isArray(raw['clients'])||typeof raw['yourClientId']!=='string')return null;return raw as unknown as PresenceMessage;
    case 'peer_join':   if(typeof raw['clientId']!=='string'||typeof raw['color']!=='string'||typeof raw['displayName']!=='string')return null;return raw as unknown as PeerJoinMessage;
    case 'peer_leave':  if(typeof raw['clientId']!=='string')return null;return raw as unknown as PeerLeaveMessage;
    case 'cursor':      if(typeof raw['clientId']!=='string'||typeof raw['x']!=='number'||typeof raw['y']!=='number'||typeof raw['seq']!=='number'||typeof raw['serverTs']!=='number')return null;return raw as unknown as RelayedCursorMessage;
    case 'reaction':    if(typeof raw['clientId']!=='string'||typeof raw['x']!=='number'||typeof raw['emoji']!=='string'||typeof raw['id']!=='string')return null;return raw as unknown as RelayedReactionMessage;
    case 'pong':        if(typeof raw['clientTs']!=='number'||typeof raw['serverTs']!=='number')return null;return raw as unknown as PongMessage;
    case 'error':       if(typeof raw['code']!=='string'||typeof raw['message']!=='string')return null;return raw as unknown as ErrorMessage;
    default:return null;
  }
}