import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';
import { Duplex } from 'stream';
import { verifyWsToken } from './auth';
import { registry } from './registry';
import { TokenPayload } from './types';

const wss = new WebSocketServer({ noServer: true });

function reject401(socket: Duplex): void {
  socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
  socket.destroy();
}

function wire(ws: WebSocket, payload: TokenPayload): void {
  if (payload.type === 'staff') {
    const { businessId } = payload;
    registry.addStaff(businessId, ws);
    ws.on('close', () => registry.removeStaff(businessId, ws));
  } else {
    const clientId = payload.sub;
    registry.addClient(clientId, ws);
    ws.on('close', () => registry.removeClient(clientId, ws));
  }

  ws.on('error', (err) => {
    console.error(`WebSocket error [${payload.type}:${payload.sub}]:`, err.message);
  });
}

export function attachWebSocketServer(httpServer: Server): void {
  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const payload = verifyWsToken(req.headers['authorization']);
    if (!payload) {
      reject401(socket);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      wire(ws, payload);
    });
  });

  wss.on('error', (err) => console.error('WebSocket server error:', err));
}

export { wss };
