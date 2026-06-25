const connections = new Set<WebSocket>();
const subscriptions = new Map<WebSocket, Set<string>>();

export function handleWebSocket(socket: WebSocket) {
  connections.add(socket);
  subscriptions.set(socket, new Set<string>());

  socket.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.action === "subscribe" && data.entity) {
        const entityName = data.entity.toLowerCase();
        subscriptions.get(socket)?.add(entityName);
      }
    } catch (err) {
      console.error("[WebSocket] Failed to parse message:", err);
    }
  };

  socket.onclose = () => {
    connections.delete(socket);
    subscriptions.delete(socket);
  };
  
  socket.onerror = (e) => {
    console.error("[WebSocket] Error:", e);
  };
}

export function broadcastEntityChange(entityName: string, eventType: string, record: any) {
  const name = entityName.toLowerCase();
  const payload = JSON.stringify({ entity: name, type: eventType, record });
  
  for (const socket of connections) {
    if (socket.readyState === 1) { // 1 = OPEN
      const subs = subscriptions.get(socket);
      if (subs && subs.has(name)) {
        try {
          socket.send(payload);
        } catch (e) {
          console.error("[WebSocket] Failed to send to socket:", e);
        }
      }
    }
  }
}
