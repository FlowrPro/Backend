import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT) || 3000;
const players = new Map();
const WORLD = { width: 3200, height: 3200, border: 260 };
const PLAYER_RADIUS = 31;
const PLAYER_SPEED = 310;
const TICK_RATE = 20;
const PETAL_RARITIES = [
  { id: 'common', label: 'Common', color: '#9ea4ad', multiplier: 1 },
  { id: 'unusual', label: 'Unusual', color: '#55c878', multiplier: 3 },
  { id: 'rare', label: 'Rare', color: '#55a9e8', multiplier: 9 },
  { id: 'epic', label: 'Epic', color: '#bd67e8', multiplier: 27 },
  { id: 'legendary', label: 'Legendary', color: '#f2a43c', multiplier: 81 },
  { id: 'mythical', label: 'Mythical', color: '#ed5b75', multiplier: 243 },
  { id: 'ultra', label: 'Ultra', color: '#f5df66', multiplier: 729 },
];
const PETAL_TYPES = {
  basic: { id: 'basic', label: 'Basic', baseDamage: 5, baseHealth: 10, baseReload: 1.2 },
};
const rarityById = new Map(PETAL_RARITIES.map((rarity) => [rarity.id, rarity]));

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
    username: player.username,
    x: player.x,
    y: player.y,
    health: player.health,
    damage: player.damage,
    reload: player.reload,
    hotbar: player.hotbar,
  };
}

function createPetal(petalId, rarityId) {
  return { petalId, rarityId };
}

function getPetalStats(petal) {
  const type = PETAL_TYPES[petal.petalId];
  const rarity = rarityById.get(petal.rarityId);
  if (!type || !rarity) return null;
  return {
    ...type,
    ...rarity,
    damage: type.baseDamage * rarity.multiplier,
    health: type.baseHealth * rarity.multiplier,
    reload: type.baseReload,
  };
}

function addToInventory(player, petal, count = 1) {
  const stack = player.inventory.find((entry) => (
    entry.petalId === petal.petalId && entry.rarityId === petal.rarityId
  ));
  if (stack) stack.count += count;
  else player.inventory.push({ ...petal, count });
}

function calculateStats(player) {
  const equipped = player.hotbar.filter(Boolean).map(getPetalStats).filter(Boolean);
  player.damage = equipped.reduce((total, petal) => total + petal.damage, 0);
  player.health = equipped.reduce((total, petal) => total + petal.health, 0);
  player.reload = equipped.length
    ? equipped.reduce((total, petal) => total + petal.reload, 0) / equipped.length
    : 0;
}

function publicState(player) {
  return {
    player: publicPlayer(player),
    inventory: player.inventory,
    hotbar: player.hotbar,
    secondaryHotbar: player.secondaryHotbar,
    petalRarities: PETAL_RARITIES,
    petalTypes: PETAL_TYPES,
  };
}

function sendState(connection) {
  send(connection.socket, { type: 'state', ...publicState(connection.player) });
}

function validBar(value) {
  return value === 'hotbar' || value === 'secondary-hotbar';
}

function applyAction(player, message) {
  if (message.action === 'swapBars') {
    const slot = Number(message.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > 9) return;
    [player.hotbar[slot], player.secondaryHotbar[slot]] = [
      player.secondaryHotbar[slot],
      player.hotbar[slot],
    ];
  }

  if (message.action === 'equip') {
    const inventoryIndex = Number(message.inventoryIndex);
    const targetSlot = Number(message.targetSlot);
    const targetBar = message.targetBar === 'secondary-hotbar' ? player.secondaryHotbar : player.hotbar;
    const stack = player.inventory[inventoryIndex];
    if (!stack || targetBar[targetSlot] || targetSlot < 0 || targetSlot > 9) return;
    const petal = createPetal(stack.petalId, stack.rarityId);
    if (!getPetalStats(petal)) return;
    stack.count -= 1;
    if (!stack.count) player.inventory.splice(inventoryIndex, 1);
    targetBar[targetSlot] = petal;
  }

  if (message.action === 'store') {
    const sourceBar = validBar(message.sourceBar) ? message.sourceBar : null;
    const source = sourceBar === 'secondary-hotbar' ? player.secondaryHotbar : player.hotbar;
    const sourceSlot = Number(message.sourceSlot);
    if (!source || !Number.isInteger(sourceSlot) || !source[sourceSlot]) return;
    addToInventory(player, source[sourceSlot]);
    source[sourceSlot] = null;
  }

  if (message.action === 'swapSlots') {
    const sourceBar = validBar(message.sourceBar) ? message.sourceBar : null;
    const targetBar = validBar(message.targetBar) ? message.targetBar : null;
    const sourceSlot = Number(message.sourceSlot);
    const targetSlot = Number(message.targetSlot);
    if (!sourceBar || !targetBar || ![sourceSlot, targetSlot].every((slot) => Number.isInteger(slot) && slot >= 0 && slot <= 9)) return;
    const source = sourceBar === 'secondary-hotbar' ? player.secondaryHotbar : player.hotbar;
    const target = targetBar === 'secondary-hotbar' ? player.secondaryHotbar : player.hotbar;
    [source[sourceSlot], target[targetSlot]] = [target[targetSlot], source[sourceSlot]];
  }

  calculateStats(player);
}

webSocketServer.on('connection', (socket) => {
  const player = {
    id: randomUUID(),
    username: 'Guest',
    x: 1600,
    y: 1600,
    health: 0,
    damage: 0,
    reload: 1.2,
    input: { x: 0, y: 0 },
    inventory: [],
    hotbar: Array(10).fill(null),
    secondaryHotbar: Array(10).fill(null),
    started: false,
  };
  PETAL_RARITIES.forEach((rarity, index) => {
    const petal = createPetal('basic', rarity.id);
    player.hotbar[index] = petal;
    addToInventory(player, petal, 5);
  });
  calculateStats(player);
  players.set(player.id, { player, socket });

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

    if (message.type === 'start') {
      const requestedName = typeof message.username === 'string' ? message.username.trim() : '';
      player.username = requestedName.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 16) || 'Guest';
      player.started = true;
      send(socket, {
        type: 'welcome',
        playerId: player.id,
        players: [...players.values()]
          .filter(({ player: currentPlayer }) => currentPlayer.started)
          .map(({ player: currentPlayer }) => publicPlayer(currentPlayer)),
      });
      sendState(current);
      broadcast({ type: 'playerJoined', player: publicPlayer(player) }, socket);
      return;
    }

    if (!player.started) return;

    if (message.type === 'input') {
      const inputX = Number(message.x);
      const inputY = Number(message.y);
      if (!Number.isFinite(inputX) || !Number.isFinite(inputY)) return;
      const length = Math.hypot(inputX, inputY) || 1;
      player.input.x = Math.max(-1, Math.min(1, inputX / length));
      player.input.y = Math.max(-1, Math.min(1, inputY / length));
    }

    if (message.type === 'action') {
      applyAction(player, message);
      sendState(current);
    }
  });

  socket.on('close', () => {
    players.delete(player.id);
    broadcast({ type: 'playerLeft', playerId: player.id });
  });
});

setInterval(() => {
  const deltaTime = 1 / TICK_RATE;
  players.forEach(({ player }) => {
    if (!player.started) return;
    player.x += player.input.x * PLAYER_SPEED * deltaTime;
    player.y += player.input.y * PLAYER_SPEED * deltaTime;
    player.x = Math.max(WORLD.border + PLAYER_RADIUS, Math.min(WORLD.width - WORLD.border - PLAYER_RADIUS, player.x));
    player.y = Math.max(WORLD.border + PLAYER_RADIUS, Math.min(WORLD.height - WORLD.border - PLAYER_RADIUS, player.y));
    broadcast({ type: 'playerUpdated', player: publicPlayer(player) });
  });
}, 1000 / TICK_RATE);

server.listen(port, '0.0.0.0', () => {
  console.log(`Meadow IO server listening on port ${port}`);
});
