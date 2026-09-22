import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT) || 3000;
const players = new Map();

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, players: players.size }));
    return;
  }

  response.writeHead(200, { 'Content-Type': 'text/plain' });
  response.end('Meadow IO server is running.');
});

const webSocketServer = new WebSocketServer({ server });

function send(socket, message) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(message, excludedSocket = null) {
  webSocketServer.clients.forEach((client) => {
    if (client !== excludedSocket && client.readyState === client.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

function publicPlayer(player) {
  return {
    id: player.id,
    x: player.x,
    y: player.y,
    health: player.health,
    damage: player.damage,
    reload: player.reload,
  };
}

webSocketServer.on('connection', (socket) => {
  const player = {
    id: randomUUID(),
    x: 1600,
    y: 1600,
    health: 10,
    damage: 5,
    reload: 1.2,
  };
  players.set(player.id, { player, socket });

  send(socket, {
    type: 'welcome',
    playerId: player.id,
    players: [...players.values()].map(({ player: currentPlayer }) => publicPlayer(currentPlayer)),
  });
  broadcast({ type: 'playerJoined', player: publicPlayer(player) }, socket);

  socket.on('message', (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      send(socket, { type: 'error', message: 'Messages must be valid JSON.' });
      return;
    }

    const current = players.get(player.id);
    if (!current || !message || typeof message.type !== 'string') return;

    if (message.type === 'input') {
      const nextX = Number(message.x);
      const nextY = Number(message.y);
      if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) return;

      player.x = Math.max(291, Math.min(2909, nextX));
      player.y = Math.max(291, Math.min(2909, nextY));
      broadcast({ type: 'playerUpdated', player: publicPlayer(player) });
    }
  });

  socket.on('close', () => {
    players.delete(player.id);
    broadcast({ type: 'playerLeft', playerId: player.id });
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Meadow IO server listening on port ${port}`);
});
