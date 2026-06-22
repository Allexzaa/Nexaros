import WebSocket from 'ws';

// Staff channels:  business_id → connected staff sockets
// Client channels: client_id  → connected client sockets
const staffChannels = new Map<string, Set<WebSocket>>();
const clientChannels = new Map<string, Set<WebSocket>>();

function add(map: Map<string, Set<WebSocket>>, key: string, ws: WebSocket): void {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(ws);
}

function remove(map: Map<string, Set<WebSocket>>, key: string, ws: WebSocket): void {
  const ch = map.get(key);
  if (!ch) return;
  ch.delete(ws);
  if (ch.size === 0) map.delete(key);
}

function broadcast(map: Map<string, Set<WebSocket>>, key: string, data: string): void {
  const ch = map.get(key);
  if (!ch) return;
  for (const ws of ch) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

export const registry = {
  addStaff: (businessId: string, ws: WebSocket) => add(staffChannels, businessId, ws),
  addClient: (clientId: string, ws: WebSocket) => add(clientChannels, clientId, ws),
  removeStaff: (businessId: string, ws: WebSocket) => remove(staffChannels, businessId, ws),
  removeClient: (clientId: string, ws: WebSocket) => remove(clientChannels, clientId, ws),
  sendToStaff: (businessId: string, data: string) => broadcast(staffChannels, businessId, data),
  sendToClient: (clientId: string, data: string) => broadcast(clientChannels, clientId, data),
};
