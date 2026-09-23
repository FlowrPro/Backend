import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT) || 3000;
const players = new Map();
const WORLD = { width: 3200, height: 3200, border: 260 };
const PLAYER_RADIUS = 31;
const PETAL_RADIUS = 21;
const BASE_PLAYER_HEALTH = 100;
const BASE_BODY_DAMAGE = 100;
const PLAYER_SPEED = 310;
const MOVEMENT_ACCELERATION = 1700;
const MOVEMENT_DECELERATION = 2100;
const TICK_RATE = 20;
const PETAL_ROTATION_MS = 4200;
const PETAL_HIT_COOLDOWN = 0.35;
const BODY_HIT_COOLDOWN = 0.5;
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
  basic: { id: 'basic', label: 'Basic', baseDamage: 10, baseHealth: 10, baseReload: 1.2 },
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
    radius: PLAYER_RADIUS,
    health: player.health,
    maxHealth: player.maxHealth,
    bodyDamage: player.bodyDamage,
    damage: player.damage,
    reload: player.reload,
    hotbar: player.hotbar,
    petalHealth: player.petalHealth,
    expandHeld: player.expandHeld,
    retractHeld: player.retractHeld,
    orbitRadius: player.orbitRadius,
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
  player.maxHealth = BASE_PLAYER_HEALTH;
  player.bodyDamage = BASE_BODY_DAMAGE;
  player.health = Math.min(player.health, player.maxHealth);
  player.reload = equipped.length
    ? equipped.reduce((total, petal) => total + petal.reload, 0) / equipped.length
    : 0;
}

function getHealthBar(player, barName) {
  return barName === 'secondary-hotbar' ? player.secondaryPetalHealth : player.petalHealth;
}

function setPetalHealth(player, barName, slot, petal) {
  const healthBar = getHealthBar(player, barName);
  const stats = petal ? getPetalStats(petal) : null;
  healthBar[slot] = stats ? stats.health : 0;
}

function equipNextAvailable(player, inventoryIndex) {
  const stack = player.inventory[inventoryIndex];
  if (!stack) return null;
  const targetSlot = player.hotbar.findIndex((petal) => !petal);
  const targetBar = targetSlot >= 0 ? 'hotbar' : 'secondary-hotbar';
  const resolvedSlot = targetSlot >= 0 ? targetSlot : player.secondaryHotbar.findIndex((petal) => !petal);
  if (resolvedSlot < 0) return null;
  const petal = createPetal(stack.petalId, stack.rarityId);
  if (!getPetalStats(petal)) return null;
  stack.count -= 1;
  if (!stack.count) player.inventory.splice(inventoryIndex, 1);
  const target = targetBar === 'hotbar' ? player.hotbar : player.secondaryHotbar;
  target[resolvedSlot] = petal;
  setPetalHealth(player, targetBar, resolvedSlot, petal);
  calculateStats(player);
  return { targetBar, targetSlot: resolvedSlot };
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
    [player.petalHealth[slot], player.secondaryPetalHealth[slot]] = [
      player.secondaryPetalHealth[slot],
      player.petalHealth[slot],
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
    setPetalHealth(player, message.targetBar === 'secondary-hotbar' ? 'secondary-hotbar' : 'hotbar', targetSlot, petal);
  }

  if (message.action === 'store') {
    const sourceBar = validBar(message.sourceBar) ? message.sourceBar : null;
    const source = sourceBar === 'secondary-hotbar' ? player.secondaryHotbar : player.hotbar;
    const sourceSlot = Number(message.sourceSlot);
    if (!source || !Number.isInteger(sourceSlot) || !source[sourceSlot]) return;
    addToInventory(player, source[sourceSlot]);
    source[sourceSlot] = null;
    getHealthBar(player, sourceBar)[sourceSlot] = 0;
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
    const sourceHealth = getHealthBar(player, sourceBar);
    const targetHealth = getHealthBar(player, targetBar);
    [sourceHealth[sourceSlot], targetHealth[targetSlot]] = [targetHealth[targetSlot], sourceHealth[sourceSlot]];
  }

  calculateStats(player);
}

function distanceBetween(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function applyDamage(target, amount) {
  if (target.health <= 0) return;
  target.health = Math.max(0, target.health - amount);
}

function restorePetalHealth(player) {
  player.hotbar.forEach((petal, index) => {
    player.petalHealth[index] = petal ? getPetalStats(petal).health : 0;
  });
  player.secondaryHotbar.forEach((petal, index) => {
    player.secondaryPetalHealth[index] = petal ? getPetalStats(petal).health : 0;
  });
}

function respawnPlayer(player) {
  player.x = WORLD.width / 2;
  player.y = WORLD.height / 2;
  player.velocityX = 0;
  player.velocityY = 0;
  player.health = player.maxHealth;
  player.petalHitCooldowns.clear();
  player.bodyHitCooldowns.clear();
  restorePetalHealth(player);
}

function getPetalPosition(player, slot, petalCount, now) {
  const rotation = (now % PETAL_ROTATION_MS) / PETAL_ROTATION_MS * Math.PI * 2;
  const phase = player.id.length * 0.17 + slot / petalCount * Math.PI * 2;
  return {
    x: player.x + Math.cos(rotation + phase) * player.orbitRadius,
    y: player.y + Math.sin(rotation + phase) * player.orbitRadius,
  };
}

function reduceCooldowns(cooldowns, deltaTime) {
  cooldowns.forEach((remaining, key) => {
    if (remaining <= deltaTime) cooldowns.delete(key);
    else cooldowns.set(key, remaining - deltaTime);
  });
}

function resolveCombat(activePlayers, deltaTime) {
  const now = Date.now();
  activePlayers.forEach((player) => {
    reduceCooldowns(player.petalHitCooldowns, deltaTime);
    reduceCooldowns(player.bodyHitCooldowns, deltaTime);
    const targetRadius = player.expandHeld ? 145 : player.retractHeld ? 46 : 86;
    player.orbitRadius += (targetRadius - player.orbitRadius) * (1 - Math.exp(-10 * deltaTime));
  });

  for (let firstIndex = 0; firstIndex < activePlayers.length; firstIndex += 1) {
    const first = activePlayers[firstIndex];
    for (let secondIndex = firstIndex + 1; secondIndex < activePlayers.length; secondIndex += 1) {
      const second = activePlayers[secondIndex];
      if (distanceBetween(first, second) > PLAYER_RADIUS * 2) continue;
      if (!first.bodyHitCooldowns.has(second.id)) {
        applyDamage(first, second.bodyDamage);
        applyDamage(second, first.bodyDamage);
        first.bodyHitCooldowns.set(second.id, BODY_HIT_COOLDOWN);
        second.bodyHitCooldowns.set(first.id, BODY_HIT_COOLDOWN);
      }
    }
  }

  activePlayers.forEach((attacker) => {
    const equipped = attacker.hotbar.filter((petal, slot) => petal && attacker.petalHealth[slot] > 0);
    if (!equipped.length || attacker.health <= 0) return;
    attacker.hotbar.forEach((petal, slot) => {
      const petalStats = petal ? getPetalStats(petal) : null;
      if (!petalStats || attacker.petalHealth[slot] <= 0) return;
      const petalIndex = equipped.indexOf(petal);
      const petalPosition = getPetalPosition(attacker, petalIndex, equipped.length, now);
      activePlayers.forEach((target) => {
        if (target === attacker || target.health <= 0) return;
        if (distanceBetween(petalPosition, target) > PETAL_RADIUS + PLAYER_RADIUS) return;
        const cooldownKey = `${target.id}:${slot}`;
        if (attacker.petalHitCooldowns.has(cooldownKey)) return;
        applyDamage(target, petalStats.damage);
        attacker.petalHealth[slot] = Math.max(0, attacker.petalHealth[slot] - target.bodyDamage);
        attacker.petalHitCooldowns.set(cooldownKey, PETAL_HIT_COOLDOWN);
      });
    });
  });
}

webSocketServer.on('connection', (socket) => {
  const player = {
    id: randomUUID(),
    username: 'Guest',
    x: 1600,
    y: 1600,
    health: BASE_PLAYER_HEALTH,
    maxHealth: BASE_PLAYER_HEALTH,
    bodyDamage: BASE_BODY_DAMAGE,
    damage: 0,
    reload: 1.2,
    input: { x: 0, y: 0 },
    velocityX: 0,
    velocityY: 0,
    inventory: [],
    hotbar: Array(10).fill(null),
    secondaryHotbar: Array(10).fill(null),
    petalHealth: Array(10).fill(0),
    secondaryPetalHealth: Array(10).fill(0),
    petalHitCooldowns: new Map(),
    bodyHitCooldowns: new Map(),
    expandHeld: false,
    retractHeld: false,
    orbitRadius: 86,
    started: false,
  };
  PETAL_RARITIES.forEach((rarity, index) => {
    const petal = createPetal('basic', rarity.id);
    player.hotbar[index] = petal;
    player.petalHealth[index] = getPetalStats(petal).health;
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

    if (message.type === 'petalControl') {
      player.expandHeld = message.expandHeld === true;
      player.retractHeld = message.retractHeld === true;
    }

    if (message.type === 'action') {
      if (message.action === 'respawn') {
        if (player.health <= 0) {
          respawnPlayer(player);
          sendState(current);
        }
        return;
      }
      if (message.action === 'equipNext') {
        const result = equipNextAvailable(player, Number(message.inventoryIndex));
        if (result) send(socket, { type: 'petalEquipped', ...result });
        sendState(current);
        return;
      }
      applyAction(player, message);
      sendState(current);
    }

    if (message.type === 'chat') {
      if (typeof message.text !== 'string') return;
      const text = message.text.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
      if (!text) return;
      broadcast({ type: 'chat', username: player.username, text });
    }
  });

  socket.on('close', () => {
    players.delete(player.id);
    broadcast({ type: 'playerLeft', playerId: player.id });
  });
});

setInterval(() => {
  const deltaTime = 1 / TICK_RATE;
  const activePlayers = [];
  players.forEach(({ player }) => {
    if (!player.started) return;
    if (player.health <= 0) return;
    const targetVelocityX = player.input.x * PLAYER_SPEED;
    const targetVelocityY = player.input.y * PLAYER_SPEED;
    const velocityStep = (player.input.x || player.input.y ? MOVEMENT_ACCELERATION : MOVEMENT_DECELERATION) * deltaTime;
    player.velocityX += Math.max(-velocityStep, Math.min(velocityStep, targetVelocityX - player.velocityX));
    player.velocityY += Math.max(-velocityStep, Math.min(velocityStep, targetVelocityY - player.velocityY));
    player.x += player.velocityX * deltaTime;
    player.y += player.velocityY * deltaTime;
    player.x = Math.max(WORLD.border + PLAYER_RADIUS, Math.min(WORLD.width - WORLD.border - PLAYER_RADIUS, player.x));
    player.y = Math.max(WORLD.border + PLAYER_RADIUS, Math.min(WORLD.height - WORLD.border - PLAYER_RADIUS, player.y));
    activePlayers.push(player);
  });
  resolveCombat(activePlayers, deltaTime);
  players.forEach(({ player }) => {
    if (player.started) broadcast({ type: 'playerUpdated', player: publicPlayer(player) });
  });
}, 1000 / TICK_RATE);

server.listen(port, '0.0.0.0', () => {
  console.log(`Meadow IO server listening on port ${port}`);
});
