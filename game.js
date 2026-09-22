const canvas = document.querySelector('#game-canvas');
const context = canvas.getContext('2d');
const minimapCanvas = document.querySelector('#minimap-canvas');
const minimapContext = minimapCanvas.getContext('2d');
const inventoryPanel = document.querySelector('#inventory-panel');
const inventoryGrid = document.querySelector('#inventory-grid');
const hotbarSlots = document.querySelector('#hotbar-slots');
const secondaryHotbarSlots = document.querySelector('#secondary-hotbar-slots');
const inventoryButton = document.querySelector('[data-action="inventory"]');
const inventoryClose = document.querySelector('#inventory-close');

// World dimensions and spawn coordinates are intentionally easy to edit.
const WORLD = {
  width: 3200,
  height: 3200,
  spawnX: 1600,
  spawnY: 1600,
  border: 260,
};

const player = {
  x: WORLD.spawnX,
  y: WORLD.spawnY,
  radius: 31,
  speed: 310,
};

const SERVER_URL = 'wss://backend-v4ok.onrender.com';
let socket = null;
let localPlayerId = null;
const remotePlayers = new Map();
let networkSendTimer = 0;

const camera = { x: player.x, y: player.y };
const keys = new Set();
const grassTexture = new Image();
const borderTexture = new Image();
let grassPattern = null;
let borderPattern = null;
const grassTextureScale = 0.5;
const borderTextureScale = 1;
const PETAL_ROTATION_MS = 4200;
const HOTBAR_SIZE = 10;
let PETAL_RARITIES = [
  { id: 'common', label: 'Common', color: '#9ea4ad', multiplier: 1 },
  { id: 'unusual', label: 'Unusual', color: '#55c878', multiplier: 3 },
  { id: 'rare', label: 'Rare', color: '#55a9e8', multiplier: 9 },
  { id: 'epic', label: 'Epic', color: '#bd67e8', multiplier: 27 },
  { id: 'legendary', label: 'Legendary', color: '#f2a43c', multiplier: 81 },
  { id: 'mythical', label: 'Mythical', color: '#ed5b75', multiplier: 243 },
  { id: 'ultra', label: 'Ultra', color: '#f5df66', multiplier: 729 },
];
let PETAL_TYPES = {
  basic: { id: 'basic', label: 'Basic', baseDamage: 5, baseHealth: 10, baseReload: 1.2 },
};
let rarityById = new Map(PETAL_RARITIES.map((rarity) => [rarity.id, rarity]));
const inventory = [];
const hotbar = Array(HOTBAR_SIZE).fill(null);
const secondaryHotbar = Array(HOTBAR_SIZE).fill(null);
let draggedPetal = null;
const grainSeed = 93817;
let viewportWidth = window.innerWidth;
let viewportHeight = window.innerHeight;
let lastTime = performance.now();
let frameDelta = 1 / 60;
let orbitRadius = 86;
let expandHeld = false;
let retractHeld = false;

function createPetal(petalId, rarityId) {
  return { petalId, rarityId };
}

function getPetalStats(petal) {
  const type = PETAL_TYPES[petal.petalId];
  const rarity = rarityById.get(petal.rarityId);
  return {
    ...type,
    ...rarity,
    damage: type.baseDamage * rarity.multiplier,
    health: type.baseHealth * rarity.multiplier,
    reload: type.baseReload,
  };
}

function addToInventory(petal, count = 1) {
  const stack = inventory.find((entry) => entry.petalId === petal.petalId && entry.rarityId === petal.rarityId);
  if (stack) stack.count += count;
  else inventory.push({ ...petal, count });
}

function getBar(kind) {
  return kind === 'secondary-hotbar' ? secondaryHotbar : hotbar;
}

PETAL_RARITIES.forEach((rarity, index) => {
  const rarityId = rarity.id;
  hotbar[index] = createPetal('basic', rarityId);
  addToInventory(createPetal('basic', rarityId), 5);
});

grassTexture.src = 'assets/grasstexture.webp';
grassTexture.addEventListener('load', () => {
  grassPattern = context.createPattern(grassTexture, 'repeat');
});
borderTexture.addEventListener('load', () => {
  borderPattern = context.createPattern(borderTexture, 'repeat');
});
borderTexture.src = 'assets/bordertexture.svg';

function resize() {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  viewportWidth = window.innerWidth;
  viewportHeight = window.innerHeight;
  canvas.width = Math.floor(viewportWidth * pixelRatio);
  canvas.height = Math.floor(viewportHeight * pixelRatio);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  minimapCanvas.width = 400;
  minimapCanvas.height = 400;
}

function hash(value) {
  const result = Math.sin(value * 12.9898 + grainSeed) * 43758.5453;
  return result - Math.floor(result);
}

function drawGrain(contextToDraw, left, top, right, bottom, density, scale, seedOffset) {
  const width = right - left;
  const height = bottom - top;
  const count = Math.floor(width * height * density / 10000);

  contextToDraw.save();
  for (let index = 0; index < count; index += 1) {
    const randomX = hash(index * 2.17 + seedOffset);
    const randomY = hash(index * 3.71 + seedOffset + 91);
    const randomLength = hash(index * 5.13 + seedOffset + 37);
    const x = left + randomX * width;
    const y = top + randomY * height;
    const length = (1.5 + randomLength * 4) * scale;
    const alpha = 0.12 + hash(index * 7.41 + seedOffset + 12) * 0.16;
    const isLight = index % 3 !== 0;

    contextToDraw.strokeStyle = isLight
      ? `rgba(255, 247, 183, ${alpha})`
      : `rgba(65, 87, 37, ${alpha * 0.7})`;
    contextToDraw.lineWidth = Math.max(0.6, scale * 0.8);
    contextToDraw.beginPath();
    contextToDraw.moveTo(x, y);
    contextToDraw.lineTo(x + length, y - length * (0.25 + randomLength * 0.35));
    contextToDraw.stroke();
  }
  contextToDraw.restore();
}

function drawWorld() {
  context.fillStyle = '#6a4127';
  context.fillRect(0, 0, viewportWidth, viewportHeight);

  const worldLeft = Math.floor(viewportWidth / 2 - camera.x);
  const worldTop = Math.floor(viewportHeight / 2 - camera.y);
  const mapLeft = worldLeft + WORLD.border;
  const mapTop = worldTop + WORLD.border;
  const mapRight = worldLeft + WORLD.width - WORLD.border;
  const mapBottom = worldTop + WORLD.height - WORLD.border;

  if (borderPattern) {
    context.save();
    borderPattern.setTransform(
      new DOMMatrix().translate(worldLeft, worldTop).scale(borderTextureScale),
    );
    context.fillStyle = borderPattern;
    context.fillRect(worldLeft, worldTop, WORLD.width, WORLD.height);
    context.restore();
  }

  const mapWidth = mapRight - mapLeft;
  const mapHeight = mapBottom - mapTop;
  if (grassPattern) {
    context.save();
    grassPattern.setTransform(
      new DOMMatrix().translate(mapLeft, mapTop).scale(grassTextureScale),
    );
    context.fillStyle = grassPattern;
    context.fillRect(mapLeft, mapTop, mapWidth, mapHeight);
    context.restore();
  } else {
    context.fillStyle = '#76a943';
    context.fillRect(mapLeft, mapTop, mapWidth, mapHeight);
  }
  drawGrain(context, mapLeft, mapTop, mapRight, mapBottom, 8.5, 1.15, 180);

  context.strokeStyle = 'rgba(42, 68, 27, 0.58)';
  context.lineWidth = 4;
  context.strokeRect(mapLeft + 1, mapTop + 1, mapRight - mapLeft - 2, mapBottom - mapTop - 2);

  remotePlayers.forEach((remotePlayer) => {
    drawPlayer(worldLeft + remotePlayer.x, worldTop + remotePlayer.y);
  });
  drawOrbitingPetals(worldLeft + player.x, worldTop + player.y);
  drawPlayer(worldLeft + player.x, worldTop + player.y);
}

function connectToServer() {
  socket = new WebSocket(SERVER_URL);

  socket.addEventListener('open', () => {
    sendPlayerPosition(true);
    console.info('Connected to Meadow IO server.');
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'welcome') {
      localPlayerId = message.playerId;
      remotePlayers.clear();
      message.players
        .filter((remotePlayer) => remotePlayer.id !== localPlayerId)
        .forEach((remotePlayer) => remotePlayers.set(remotePlayer.id, remotePlayer));
    }
    if (message.type === 'state') {
      PETAL_RARITIES = message.petalRarities;
      PETAL_TYPES = message.petalTypes;
      rarityById = new Map(PETAL_RARITIES.map((rarity) => [rarity.id, rarity]));
      player.x = message.player.x;
      player.y = message.player.y;
      player.health = message.player.health;
      player.damage = message.player.damage;
      player.reload = message.player.reload;
      inventory.splice(0, inventory.length, ...message.inventory);
      hotbar.splice(0, hotbar.length, ...message.hotbar);
      secondaryHotbar.splice(0, secondaryHotbar.length, ...message.secondaryHotbar);
      renderPetalUi();
    }
    if (message.type === 'playerJoined' && message.player.id !== localPlayerId) {
      remotePlayers.set(message.player.id, message.player);
    }
    if (message.type === 'playerUpdated' && message.player.id !== localPlayerId) {
      remotePlayers.set(message.player.id, message.player);
    }
    if (message.type === 'playerUpdated' && message.player.id === localPlayerId) {
      player.x = message.player.x;
      player.y = message.player.y;
      player.health = message.player.health;
      player.damage = message.player.damage;
      player.reload = message.player.reload;
    }
    if (message.type === 'playerLeft') {
      remotePlayers.delete(message.playerId);
    }
  });

  socket.addEventListener('close', () => {
    localPlayerId = null;
    remotePlayers.clear();
    window.setTimeout(connectToServer, 3000);
  }, { once: true });
}

function sendPlayerPosition(force = false) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!force && networkSendTimer < 0.05) return;
  networkSendTimer = 0;
  const input = {
    x: (keys.has('ArrowRight') || keys.has('d') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('a') ? 1 : 0),
    y: (keys.has('ArrowDown') || keys.has('s') ? 1 : 0) - (keys.has('ArrowUp') || keys.has('w') ? 1 : 0),
  };
  socket.send(JSON.stringify({ type: 'input', ...input }));
}

function sendServerAction(action, data = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ type: 'action', action, ...data }));
  return true;
}

function drawOrbitingPetals(screenX, screenY) {
  const equippedPetals = hotbar.filter(Boolean);
  const defaultRadius = 86;
  const expandedRadius = 145;
  const retractedRadius = 46;
  const targetRadius = expandHeld ? expandedRadius : retractHeld ? retractedRadius : defaultRadius;
  orbitRadius += (targetRadius - orbitRadius) * (1 - Math.exp(-10 * frameDelta));
  if (!equippedPetals.length) return;

  const rotation = (performance.now() % PETAL_ROTATION_MS) / PETAL_ROTATION_MS * Math.PI * 2;
  equippedPetals.forEach((petal, index) => {
    const angle = rotation + index / equippedPetals.length * Math.PI * 2;
    drawPetal(
      screenX + Math.cos(angle) * orbitRadius,
      screenY + Math.sin(angle) * orbitRadius,
      getPetalStats(petal),
      angle + Math.PI / 2,
      21,
    );
  });
}

function drawPetal(screenX, screenY, rarity, rotation, size) {
  context.save();
  context.translate(screenX, screenY);
  context.rotate(rotation);
  context.shadowColor = 'rgba(30, 19, 12, 0.4)';
  context.shadowBlur = 7;
  context.shadowOffsetY = 3;
  context.fillStyle = '#fff';
  context.strokeStyle = 'rgba(60, 36, 21, 0.7)';
  context.lineWidth = 2;
  context.beginPath();
  context.arc(0, 0, size * 0.72, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
}

function drawPlayer(screenX, screenY) {
  const pulse = Math.sin(performance.now() / 240) * 0.8;
  const radius = player.radius + pulse;

  context.save();
  context.translate(screenX, screenY);
  context.shadowColor = 'rgba(21, 42, 13, 0.35)';
  context.shadowBlur = 8;
  context.shadowOffsetY = 4;

  context.fillStyle = '#f1bd32';
  context.beginPath();
  context.arc(0, 0, radius, 0, Math.PI * 2);
  context.fill();
  context.shadowColor = 'transparent';
  context.strokeStyle = '#b4771d';
  context.lineWidth = 3;
  context.stroke();

  context.fillStyle = '#fffaf0';
  context.beginPath();
  context.arc(-11, -8, 8.4, 0, Math.PI * 2);
  context.arc(11, -8, 8.4, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#382a20';
  context.beginPath();
  context.arc(-10, -7, 3.6, 0, Math.PI * 2);
  context.arc(10, -7, 3.6, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = '#382a20';
  context.lineWidth = 3;
  context.lineCap = 'round';
  context.beginPath();
  context.arc(0, 2, 12, 0.25, Math.PI - 0.25);
  context.stroke();
  context.restore();
}

function drawMinimap() {
  const size = minimapCanvas.width;
  const scale = size / WORLD.width;
  minimapContext.clearRect(0, 0, size, size);
  minimapContext.fillStyle = '#694027';
  minimapContext.fillRect(0, 0, size, size);

  const mapStart = WORLD.border * scale;
  const mapSize = (WORLD.width - WORLD.border * 2) * scale;
  minimapContext.fillStyle = '#cbd0c6';
  minimapContext.fillRect(mapStart, mapStart, mapSize, mapSize);

  minimapContext.strokeStyle = 'rgba(79, 48, 28, 0.75)';
  minimapContext.lineWidth = 3;
  minimapContext.strokeRect(mapStart, mapStart, mapSize, mapSize);

  minimapContext.fillStyle = '#4bba62';
  minimapContext.beginPath();
  minimapContext.arc(player.x * scale, player.y * scale, 6, 0, Math.PI * 2);
  minimapContext.fill();
  minimapContext.strokeStyle = '#205c32';
  minimapContext.lineWidth = 2;
  minimapContext.stroke();
}

function showPetalTooltip(slot, petal) {
  const stats = getPetalStats(petal);
  const tooltip = document.createElement('div');
  tooltip.className = 'petal-tooltip';
  tooltip.style.setProperty('--tooltip-color', stats.color);
  tooltip.innerHTML = `<strong>${stats.label} ${stats.label === 'Basic' ? 'Petal' : ''}</strong>Damage: ${stats.damage}<br>Health: ${stats.health}<br>Reload: ${stats.reload}s`;
  document.body.append(tooltip);
  const bounds = slot.getBoundingClientRect();
  tooltip.style.left = `${bounds.left + bounds.width / 2}px`;
  tooltip.style.top = `${bounds.top}px`;
  slot._tooltip = tooltip;
}

function hidePetalTooltip(slot) {
  if (slot._tooltip) {
    slot._tooltip.remove();
    slot._tooltip = null;
  }
}

function createPetalDragPreview(petal) {
  const stats = getPetalStats(petal);
  const preview = document.createElement('canvas');
  const previewContext = preview.getContext('2d');
  preview.width = 64;
  preview.height = 64;
  previewContext.fillStyle = stats.color;
  previewContext.fillRect(2, 2, 60, 60);
  previewContext.fillStyle = '#fff';
  previewContext.strokeStyle = 'rgba(65, 65, 65, 0.45)';
  previewContext.lineWidth = 2;
  previewContext.beginPath();
  previewContext.arc(32, 32, 16, 0, Math.PI * 2);
  previewContext.fill();
  previewContext.stroke();
  return preview;
}

function createPetalSlot(kind, index, petal) {
  const slot = document.createElement('button');
  const stats = petal ? getPetalStats(petal) : null;
  const rarity = stats;
  slot.type = 'button';
  slot.className = `petal-slot${rarity ? ` rarity-${rarity.id}` : ' empty'}`;
  slot.dataset.kind = kind;
  slot.dataset.index = index;
  slot.dataset.slotNumber = index === 9 ? '0' : String(index + 1);
  slot.title = rarity
    ? `${stats.label} petal | ${rarity.label} | Damage ${stats.damage} | Health ${stats.health} | Reload ${stats.reload}s`
    : 'Empty petal slot';

  if (rarity) {
    slot.draggable = true;
    slot.innerHTML = '<span class="petal-icon basic"></span>';
    if (kind === 'inventory') {
      slot.innerHTML += `<span class="petal-count">x${inventory[index].count}</span>`;
    }
    slot.addEventListener('dragstart', (event) => {
      draggedPetal = { kind, index, petal };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', JSON.stringify(draggedPetal));
      event.dataTransfer.setDragImage(createPetalDragPreview(petal), 32, 32);
    });
    slot.addEventListener('dragend', () => {
      draggedPetal = null;
    });
    slot.addEventListener('mouseenter', () => showPetalTooltip(slot, petal));
    slot.addEventListener('mouseleave', () => hidePetalTooltip(slot));
  }
  slot.innerHTML += `<span class="slot-number">${slot.dataset.slotNumber}</span>`;

  slot.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });
  slot.addEventListener('drop', (event) => {
    event.preventDefault();
    handlePetalDrop(kind, index);
  });
  slot.addEventListener('contextmenu', (event) => {
    const bar = getBar(kind);
    if (!bar[index]) return;
    event.preventDefault();
    sendServerAction('store', { sourceBar: kind, sourceSlot: index });
  });
  return slot;
}

function handlePetalDrop(targetKind, targetIndex) {
  if (!draggedPetal) return;
  const sourcePetal = draggedPetal.petal;

  if (targetKind === 'inventory') {
    if (draggedPetal.kind === 'hotbar' || draggedPetal.kind === 'secondary-hotbar') {
      sendServerAction('store', {
        sourceBar: draggedPetal.kind,
        sourceSlot: draggedPetal.index,
      });
    }
    return;
  }

  const targetBar = getBar(targetKind);
  if (targetBar[targetIndex]) return;
  if (draggedPetal.kind === 'inventory') {
    sendServerAction('equip', {
      inventoryIndex: draggedPetal.index,
      targetBar: targetKind,
      targetSlot: targetIndex,
    });
  } else if (draggedPetal.kind === 'hotbar' || draggedPetal.kind === 'secondary-hotbar') {
    sendServerAction('swapSlots', {
      sourceBar: draggedPetal.kind,
      sourceSlot: draggedPetal.index,
      targetBar: targetKind,
      targetSlot: targetIndex,
    });
  }
}

function renderPetalUi() {
  inventoryGrid.replaceChildren();
  [...PETAL_RARITIES].reverse().forEach((rarity) => {
    const stacks = inventory.filter((entry) => entry.rarityId === rarity.id);
    if (!stacks.length) return;
    const label = document.createElement('div');
    label.className = 'inventory-rarity-label';
    label.textContent = rarity.label;
    inventoryGrid.append(label);
    stacks.forEach((petal, index) => inventoryGrid.append(createPetalSlot('inventory', inventory.indexOf(petal), petal)));
  });

  hotbarSlots.replaceChildren();
  hotbar.forEach((petal, index) => {
    hotbarSlots.append(createPetalSlot('hotbar', index, petal));
  });
  secondaryHotbarSlots.replaceChildren();
  secondaryHotbar.forEach((petal, index) => {
    secondaryHotbarSlots.append(createPetalSlot('secondary-hotbar', index, petal));
  });
}

function toggleInventory(isOpen = inventoryPanel.hidden) {
  inventoryPanel.hidden = !isOpen;
  inventoryButton.setAttribute('aria-expanded', String(isOpen));
}

inventoryGrid.addEventListener('dragover', (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
});
inventoryGrid.addEventListener('drop', (event) => {
  event.preventDefault();
  if (!draggedPetal || !['hotbar', 'secondary-hotbar'].includes(draggedPetal.kind)) return;
  sendServerAction('store', {
    sourceBar: draggedPetal.kind,
    sourceSlot: draggedPetal.index,
  });
  draggedPetal = null;
});

function swapHotbarSlot(slotIndex) {
  sendServerAction('swapBars', { slot: slotIndex });
}

function movePlayer(deltaTime) {
  networkSendTimer += deltaTime;
  if (socket && socket.readyState === WebSocket.OPEN) {
    sendPlayerPosition();
    camera.x = player.x;
    camera.y = player.y;
    return;
  }
  let horizontal = 0;
  let vertical = 0;
  if (keys.has('ArrowLeft') || keys.has('a')) horizontal -= 1;
  if (keys.has('ArrowRight') || keys.has('d')) horizontal += 1;
  if (keys.has('ArrowUp') || keys.has('w')) vertical -= 1;
  if (keys.has('ArrowDown') || keys.has('s')) vertical += 1;

  if (horizontal || vertical) {
    const length = Math.hypot(horizontal, vertical);
    const movement = player.speed * deltaTime / length;
    player.x += horizontal * movement;
    player.y += vertical * movement;
  }

  const minPosition = WORLD.border + player.radius;
  const maxPosition = WORLD.width - WORLD.border - player.radius;
  player.x = Math.max(minPosition, Math.min(maxPosition, player.x));
  player.y = Math.max(minPosition, Math.min(maxPosition, player.y));

  camera.x = player.x;
  camera.y = player.y;
  sendPlayerPosition();
}

function gameLoop(currentTime) {
  const deltaTime = Math.min((currentTime - lastTime) / 1000, 0.05);
  lastTime = currentTime;
  frameDelta = deltaTime;
  movePlayer(deltaTime);
  drawWorld();
  drawMinimap();
  requestAnimationFrame(gameLoop);
}

window.addEventListener('resize', resize);
window.addEventListener('keydown', (event) => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) {
    event.preventDefault();
  }
  if (event.key === ' ') expandHeld = true;
  if (event.key === 'Shift') retractHeld = true;
  if (/^[0-9]$/.test(event.key)) {
    const slotIndex = event.key === '0' ? 9 : Number(event.key) - 1;
    swapHotbarSlot(slotIndex);
    event.preventDefault();
  }
  keys.add(key);
});
window.addEventListener('keyup', (event) => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (event.key === ' ') expandHeld = false;
  if (event.key === 'Shift') retractHeld = false;
  keys.delete(key);
});

canvas.addEventListener('mousedown', (event) => {
  if (event.button === 0) expandHeld = true;
  if (event.button === 2) retractHeld = true;
});
window.addEventListener('mouseup', (event) => {
  if (event.button === 0) expandHeld = false;
  if (event.button === 2) retractHeld = false;
});
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
window.addEventListener('blur', () => {
  expandHeld = false;
  retractHeld = false;
});

inventoryButton.addEventListener('click', () => toggleInventory());
inventoryClose.addEventListener('click', () => toggleInventory(false));
renderPetalUi();
connectToServer();

resize();
requestAnimationFrame(gameLoop);
