/** server.ts - Entry Point (final, with Zod, SIGTERM, structured logging) */
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { InboundMessageSchema } from './protocol.js';
import { getOrCreateRoom, cleanupEmptyRooms } from './room.js';
const PORT = parseInt(process.env.PORT ?? '8080', 10);
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url==='/health'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',timestamp:Date.now()}));return;}
  res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not Found. Connect via WebSocket.');
});
const wss = new WebSocketServer({ server: httpServer });
function sendError(ws:WebSocket,code:string,message:string):void{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'error',code,message}));}
wss.on('connection',(ws:WebSocket,req)=>{
  const remoteIp=req.socket.remoteAddress??'unknown';
  console.log([Server] New connection from );
  let clientId:string|null=null,roomId:string|null=null;
  ws.on('pong',()=>{if(clientId&&roomId)getOrCreateRoom(roomId).handlePong(clientId);});
  ws.on('message',(rawData:Buffer|string)=>{
    let parsed:unknown;
    try{parsed=JSON.parse(rawData.toString());}catch{sendError(ws,'PARSE_ERROR','Message is not valid JSON');return;}
    const result=InboundMessageSchema.safeParse(parsed);
    if(!result.success){const issues=result.error.issues.map(i=>${i.path.join('.')}: ).join('; ');sendError(ws,'VALIDATION_ERROR',Invalid message: );console.warn([Server] Rejected from :,issues);return;}
    const msg=result.data;
    switch(msg.type){
      case 'join': if(clientId!==null){sendError(ws,'ALREADY_JOINED','Already joined');return;} clientId=msg.clientId;roomId=msg.roomId;getOrCreateRoom(roomId).addClient(ws,clientId,msg.displayName??'');break;
      case 'cursor': if(!clientId||!roomId){sendError(ws,'NOT_JOINED','Join first');return;}getOrCreateRoom(roomId).updateCursor(clientId,msg.x,msg.y,msg.seq);break;
      case 'reaction': if(!clientId||!roomId){sendError(ws,'NOT_JOINED','Join first');return;}getOrCreateRoom(roomId).relayReaction(clientId,msg.x,msg.y,msg.emoji,msg.id);break;
      case 'ping': if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'pong',clientTs:msg.clientTs,serverTs:Date.now()}));break;
    }
  });
  ws.on('close',(code,reason)=>{console.log([Server] Closed client= code= reason=);if(clientId&&roomId){getOrCreateRoom(roomId).removeClient(clientId);setImmediate(cleanupEmptyRooms);}});
  ws.on('error',(e)=>console.error([Server] Error client=:,e.message));
});
wss.on('error',(e)=>console.error('[WSServer]',e.message));
httpServer.listen(PORT,()=>{console.log([Server] HTTP:  http://localhost:/health);console.log([Server] WS:    ws://localhost:);console.log('[Server] Ready');});
setInterval(cleanupEmptyRooms,5*60*1_000);
const shutdown=():void=>{console.log('[Server] Shutting down...');wss.close(()=>httpServer.close(()=>process.exit(0)));};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);