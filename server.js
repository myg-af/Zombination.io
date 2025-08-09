// Ceci est le fichier server.js :
process.on('uncaughtException', function (err) {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', function (err) {
  console.error('Unhandled Rejection:', err);
});
console.log('---- DÉMARRAGE SERVER.JS ----');

const express = require('express');
const http = require('http');
const path = require('path');
const socketIo = require('socket.io');

const gameMapModule = require('./game/gameMap');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  pingInterval: 10000, // laisse 10s
  pingTimeout: 60000   // passe à 60s (au lieu de 30s par défaut)
});

const {
  MAP_ROWS,
  MAP_COLS,
  OBSTACLE_COUNT,
  TILE_SIZE,
  createEmptyMap,
  placeObstacles,
  isCollision,
  isDiagonalBlocked
} = gameMapModule;

app.use(express.static(path.join(__dirname, 'public')));

const MAX_PLAYERS = 10;
const LOBBY_TIME = 5 * 1000;
const MAX_ACTIVE_ZOMBIES = 200;

// --- Shop constants envoyées au client ---
const SHOP_CONST = {
  base: { maxHp: 100, speed: 60, regen: 0, damage: 5, goldGain: 10 },
  regenPerLevel: 1,                 // 1 PV/sec/niveau
  priceTiers: [10, 25, 50, 75, 100],// niv 1..5
  priceStepAfterTier: 50            // après niv 5 → +50/niv
};

function getUpgradePrice(nextLevel) {
  const tiers = SHOP_CONST.priceTiers;
  const step = SHOP_CONST.priceStepAfterTier;
  if (nextLevel <= tiers.length) return tiers[nextLevel - 1];
  return tiers[tiers.length - 1] + (nextLevel - tiers.length) * step;
}

let activeGames = [];
let nextGameId = 1;

function createNewGame() {
  let game = {
	structures: null,
    id: nextGameId++,
    lobby: {
      players: {},
      timeLeft: LOBBY_TIME / 1000,
      started: false,
      timer: null,
    },
    players: {},
	bots: {},
    zombies: {},
    bullets: {},
    currentRound: 1,
    totalZombiesToSpawn: 50,
    zombiesSpawnedThisWave: 0,
    map: null,
    spawnInterval: null,
    spawningActive: false,
  };
  game.map = createEmptyMap(MAP_ROWS, MAP_COLS);
  placeObstacles(game.map, OBSTACLE_COUNT);
  activeGames.push(game);
  return game;
}


function buildCentralEnclosure(game, spacingTiles = 1) {
  // 1) Init grille structures
  game.structures = Array.from({ length: MAP_ROWS }, () =>
    Array.from({ length: MAP_COLS }, () => null)
  );

  // 2) Trouver les bornes du carré vide central (robuste même si la taille change)
  const cR = Math.floor(MAP_ROWS / 2);
  const cC = Math.floor(MAP_COLS / 2);

  function extent(dirR, dirC) {
    let r = cR, c = cC, k = 0;
    while (true) {
      const nr = r + dirR, nc = c + dirC;
      if (nr <= 0 || nr >= MAP_ROWS - 1 || nc <= 0 || nc >= MAP_COLS - 1) break;
      if (game.map[nr][nc] === 1) break;
      r = nr; c = nc; k++;
    }
    return k;
  }
  const up = extent(-1, 0);
  const down = extent(1, 0);
  const left = extent(0, -1);
  const right = extent(0, 1);
  const half = Math.max(1, Math.min(up, down, left, right));

  const r0 = cR - (half - spacingTiles);
  const r1 = cR + (half - spacingTiles);
  const c0 = cC - (half - spacingTiles);
  const c1 = cC + (half - spacingTiles);

  if (r1 - r0 < 2 || c1 - c0 < 2) return;

  // 3) Murs barricades autour du carré
  for (let c = c0; c <= c1; c++) {
    setStruct(game, c, r0, { type: 'B', hp: 100 });
    setStruct(game, c, r1, { type: 'B', hp: 100 });
  }
  for (let r = r0; r <= r1; r++) {
    setStruct(game, c0, r, { type: 'B', hp: 100 });
    setStruct(game, c1, r, { type: 'B', hp: 100 });
  }

  // 4) Portes au milieu de chaque côté
  const midC = Math.floor((c0 + c1) / 2);
  const midR = Math.floor((r0 + r1) / 2);
  setStruct(game, midC, r0, { type: 'D', hp: 100 });
  setStruct(game, midC, r1, { type: 'D', hp: 100 });
  setStruct(game, c0, midR, { type: 'D', hp: 100 });
  setStruct(game, c1, midR, { type: 'D', hp: 100 });

  // 5) ✅ Une seule tourelle au centre de la base des joueurs
  //    (au centre géométrique de l’enceinte)
  setStruct(game, midC, midR, { type: 'T', hp: 100, lastShot: 0 });
}





function getAvailableLobby() {
  let game = activeGames.find(g => !g.lobby.started);
  if (!game) game = createNewGame();
  return game;
}

const socketToGame = {};

const PLAYER_RADIUS = 10;
const ZOMBIE_RADIUS = 10;

// ======= Structures (barricades/portes) helpers =======
function worldToTile(x, y) {
  return { tx: Math.floor(x / TILE_SIZE), ty: Math.floor(y / TILE_SIZE) };
}
function getStruct(game, tx, ty) {
  if (!game.structures) return null;
  if (ty < 0 || ty >= MAP_ROWS || tx < 0 || tx >= MAP_COLS) return null;
  return game.structures[ty][tx];
}
function setStruct(game, tx, ty, s) {
  if (!game.structures) return;
  if (ty < 0 || ty >= MAP_ROWS || tx < 0 || tx >= MAP_COLS) return;
  game.structures[ty][tx] = s;
}
function isSolidForPlayer(struct) {
  // Joueurs traversent les portes, mais PAS barricades ni tourelles
  return struct && ((struct.type === 'B' || struct.type === 'T') && struct.hp > 0);
}

function isSolidForZombie(struct) {
  // Zombies bloqués par portes ET barricades tant que HP > 0
  return struct && struct.hp > 0;
}
function circleBlockedByStructures(game, x, y, radius, solidCheckFn) {
  const points = 8;
  for (let a = 0; a < points; a++) {
    const ang = (2 * Math.PI * a) / points;
    const px = x + Math.cos(ang) * radius;
    const py = y + Math.sin(ang) * radius;
    const { tx, ty } = worldToTile(px, py);
    const s = getStruct(game, tx, ty);
    if (solidCheckFn(s)) return true;
  }
  // aussi le centre
  const { tx, ty } = worldToTile(x, y);
  const s = getStruct(game, tx, ty);
  return solidCheckFn(s);
}


function tickTurrets(game) {
  if (!game.structures) return;
  const now = Date.now();

  for (let ty = 0; ty < MAP_ROWS; ty++) {
    for (let tx = 0; tx < MAP_COLS; tx++) {
      const s = getStruct(game, tx, ty);
      if (!s || s.type !== 'T' || s.hp <= 0) continue;

      if (!s.lastShot) s.lastShot = 0;
      if (now - s.lastShot < TURRET_SHOOT_INTERVAL) continue;

      // centre de la tuile tourelle
      const cx = tx * TILE_SIZE + TILE_SIZE / 2;
      const cy = ty * TILE_SIZE + TILE_SIZE / 2;

      // zombie le plus proche avec LOS libre
      let best = null, bestDist = Infinity, bdx = 0, bdy = 0;
      for (const z of Object.values(game.zombies)) {
        const dx = z.x - cx;
        const dy = z.y - cy;
        const d = Math.hypot(dx, dy);
        if (d < 1) continue;
        if (losBlockedForTurret(game, cx, cy, z.x, z.y)) continue;
        if (d < bestDist) { bestDist = d; best = z; bdx = dx; bdy = dy; }
      }
      if (!best) continue;

      s.lastShot = now;

      // direction normalisée
      const dirx = bdx / bestDist;
      const diry = bdy / bestDist;

      const bulletId = `turret_${tx}_${ty}_${now}_${Math.floor(Math.random()*100000)}`;
      game.bullets[bulletId] = {
        id: bulletId,
        owner: `turret_${tx}_${ty}`,
        x: cx,
        y: cy,
        dx: dirx,
        dy: diry,
        createdAt: now,
        // NEW: infos pour éviter l’auto-destruction au départ
        originTx: tx,
        originTy: ty,
        lifeFrames: 0
      };
    }
  }
}



// Variante ligne de vue qui tient compte des structures solides (pour zombies)
function losBlockedForZombie(game, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return false;
  const steps = Math.ceil(dist / 8);
  for (let s = 1; s < steps; s++) {
    const ix = x0 + (dx * s / steps);
    const iy = y0 + (dy * s / steps);
    if (isCollision(game.map, ix, iy)) return true; // murs map
    const { tx, ty } = worldToTile(ix, iy);
    if (isSolidForZombie(getStruct(game, tx, ty))) return true; // structures
  }
  return false;
}

// LOS des tourelles : bloquée uniquement par les murs de la MAP (pas par barricades/portes)
function losBlockedForTurret(game, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return false;
  const steps = Math.ceil(dist / 8);
  for (let s = 1; s < steps; s++) {
    const ix = x0 + (dx * s / steps);
    const iy = y0 + (dy * s / steps);
    if (isCollision(game.map, ix, iy)) return true; // ❗ ne bloque que sur les murs
  }
  return false;
}


function entitiesCollide(ax, ay, aradius, bx, by, bradius, bonus = 0) {
  const dx = ax - bx;
  const dy = ay - by;
  const dist = Math.hypot(dx, dy);
  // <= au lieu de <
  return dist <= (aradius + bradius + bonus);
}


function isCircleColliding(map, x, y, radius) {
  const points = 8;
  for (let a = 0; a < points; a++) {
    const angle = (2 * Math.PI * a) / points;
    const px = x + Math.cos(angle) * radius;
    const py = y + Math.sin(angle) * radius;
    if (isCollision(map, px, py)) return true;
  }
  if (isCollision(map, x, y)) return true;
  return false;
}

function spawnZombieOnBorder(game, hp = 10, speed = 40) {
  let spawnX, spawnY, border, tries = 0;
  do {
    border = Math.floor(Math.random() * 4);
    if (border === 0) {
      spawnY = TILE_SIZE + TILE_SIZE / 2;
      spawnX = Math.floor(Math.random() * (MAP_COLS - 2)) * TILE_SIZE + TILE_SIZE + TILE_SIZE / 2;
    } else if (border === 1) {
      spawnY = (MAP_ROWS - 2) * TILE_SIZE + TILE_SIZE / 2;
      spawnX = Math.floor(Math.random() * (MAP_COLS - 2)) * TILE_SIZE + TILE_SIZE + TILE_SIZE / 2;
    } else if (border === 2) {
      spawnX = TILE_SIZE + TILE_SIZE / 2;
      spawnY = Math.floor(Math.random() * (MAP_ROWS - 2)) * TILE_SIZE + TILE_SIZE + TILE_SIZE / 2;
    } else {
      spawnX = (MAP_COLS - 2) * TILE_SIZE + TILE_SIZE / 2;
      spawnY = Math.floor(Math.random() * (MAP_ROWS - 2)) * TILE_SIZE + TILE_SIZE + TILE_SIZE / 2;
    }
    tries++;
    if (tries > 50) break;
  } while (isCollision(game.map, spawnX, spawnY));
  return { x: spawnX, y: spawnY, hp: hp, maxHp: hp, lastAttack: 0, speed: speed };
}



function spawnPlayersNearCenter(game, pseudosArr, socketsArr) {
  const centerX = (MAP_COLS / 2) * TILE_SIZE;
  const centerY = (MAP_ROWS / 2) * TILE_SIZE;
  const angleStep = (2 * Math.PI) / Math.max(1, pseudosArr.length);
  const radius = 60 + pseudosArr.length * 8;
  const usedPos = [];

  for (let i = 0; i < pseudosArr.length; i++) {
    let angle = i * angleStep;
    let tries = 0, found = false, spawnX = centerX, spawnY = centerY;

    // 1) Tentatives aléatoires autour du centre (collision cercle + structures)
    while (!found && tries < 30) {
      const candX = Math.floor(centerX + Math.cos(angle) * radius + (Math.random() - 0.5) * 12);
      const candY = Math.floor(centerY + Math.sin(angle) * radius + (Math.random() - 0.5) * 12);

      if (
        !isCircleColliding(game.map, candX, candY, PLAYER_RADIUS) &&
        !circleBlockedByStructures(game, candX, candY, PLAYER_RADIUS, isSolidForPlayer) &&
        !usedPos.some(pos => Math.hypot(pos.x - candX, pos.y - candY) < 2 * PLAYER_RADIUS + 4)
      ) {
        spawnX = candX;
        spawnY = candY;
        found = true;
        break;
      }
      tries++;
      angle += Math.PI / 9;
    }

    // 2) FALLBACK déterministe : anneaux concentriques + 16 directions
    if (!found) {
      const maxRing = Math.min(MAP_COLS, MAP_ROWS) * TILE_SIZE * 0.45;
      outer:
      for (let ring = TILE_SIZE; ring <= maxRing; ring += TILE_SIZE) {
        for (let a = 0; a < 16; a++) {
          const th = (a * 2 * Math.PI) / 16;
          const candX = Math.floor(centerX + Math.cos(th) * ring);
          const candY = Math.floor(centerY + Math.sin(th) * ring);
          if (
            !isCircleColliding(game.map, candX, candY, PLAYER_RADIUS) &&
            !circleBlockedByStructures(game, candX, candY, PLAYER_RADIUS, isSolidForPlayer) &&
            !usedPos.some(pos => Math.hypot(pos.x - candX, pos.y - candY) < 2 * PLAYER_RADIUS + 4)
          ) {
            spawnX = candX;
            spawnY = candY;
            found = true;
            break outer;
          }
        }
      }
    }

    const pseudo = pseudosArr[i];
    const sid = socketsArr[i];
    const isBot = sid.startsWith('bot');

    game.players[sid] = {
      x: spawnX,
      y: spawnY,
      lastShot: 0,
      alive: true,
      health: 100,
      kills: 0,
      pseudo,
      moveDir: { x: 0, y: 0 },
      isBot,
      targetId: null,
      money: 0,
      upgrades: { maxHp: 0, speed: 0, regen: 0, damage: 0, goldGain: 0 },
      maxHealth: 100,
    };

    const stats = getPlayerStats(game.players[sid]);
    game.players[sid].maxHealth = stats.maxHp;
    game.players[sid].health = stats.maxHp;

    usedPos.push({ x: spawnX, y: spawnY });
  }
}






function isNearObstacle(map, cx, cy, radius, tileSize) {
  const margin = Math.ceil(radius / tileSize);
  for (let dx = -margin; dx <= margin; dx++) {
    for (let dy = -margin; dy <= margin; dy++) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map[0].length || ny >= map.length) continue;
      if (map[ny][nx] === 1) return true;
    }
  }
  return false;
}

function findPath(game, startX, startY, endX, endY) {
  // On travaille en cases (grid)
  const start = {
    x: Math.floor(startX / TILE_SIZE),
    y: Math.floor(startY / TILE_SIZE)
  };
  const end = {
    x: Math.floor(endX / TILE_SIZE),
    y: Math.floor(endY / TILE_SIZE)
  };

  if (start.x === end.x && start.y === end.y) return [start, end];

  // BFS (coût uniforme). Diagonales PRIORITAIRES pour favoriser les trajets en diagonale.
  const key = (x, y) => `${x},${y}`;
  const queue = [start];
  const visited = new Set([key(start.x, start.y)]);
  const parent = {};

  // ⚠️ Diagonales d'abord, puis orthogonales
  const DIRS = [
    [ 1,  1], [ 1, -1], [-1,  1], [-1, -1],
    [ 1,  0], [-1,  0], [ 0,  1], [ 0, -1],
  ];

  while (queue.length > 0) {
    const node = queue.shift();

    if (node.x === end.x && node.y === end.y) {
      // Reconstruire le chemin
      const path = [];
      let cur = node;
      while (cur) {
        path.unshift({ x: cur.x, y: cur.y });
        const p = parent[key(cur.x, cur.y)];
        if (!p) break;
        cur = p;
      }
      return path;
    }

    for (const [dx, dy] of DIRS) {
      const nx = node.x + dx;
      const ny = node.y + dy;

      // bornes carte
      if (nx < 0 || nx >= MAP_COLS || ny < 0 || ny >= MAP_ROWS) continue;
      // pas dans un mur
      if (game.map[ny][nx] === 1) continue;

      // si mouvement diagonal, empêcher de traverser un coin (corner cutting)
      if (dx !== 0 && dy !== 0) {
        if (typeof isDiagonalBlocked === 'function') {
          if (isDiagonalBlocked(game.map, node.x, node.y, nx, ny)) continue;
        } else {
          if (game.map[node.y][nx] === 1 || game.map[ny][node.x] === 1) continue;
        }
      }

      const k = key(nx, ny);
      if (visited.has(k)) continue;

      visited.add(k);
      parent[k] = node;
      queue.push({ x: nx, y: ny });
    }
  }

  // Aucun chemin trouvé
  return null;
}


const SHOOT_INTERVAL = 500;
const BULLET_SPEED = 600;
const BULLET_DAMAGE = 5;
const PLAYER_SPEED_PER_SEC = 60;
const TURRET_SHOOT_INTERVAL = 150;

function broadcastLobby(game) {
  io.to('lobby' + game.id).emit('lobbyUpdate', {
    players: game.lobby.players,
    count: Object.keys(game.lobby.players).length,
    max: MAX_PLAYERS,
    timeLeft: game.lobby.timeLeft,
    started: game.lobby.started,
  });
}

function startLobbyTimer(game) {
  if (game.lobby.timer) return;
  game.lobby.timeLeft = LOBBY_TIME / 1000;
  game.lobby.started = false;
  game.lobby.timer = setInterval(() => {
    if (game.lobby.started) return;
    game.lobby.timeLeft--;
    broadcastLobby(game);
    const readyPlayers = Object.entries(game.lobby.players).filter(([sid, p]) => p.ready);
    if ((readyPlayers.length >= MAX_PLAYERS) || game.lobby.timeLeft <= 0) {
      if (readyPlayers.length > 0) {
        game.lobby.started = true;
        clearInterval(game.lobby.timer);
        game.lobby.timer = null;
        launchGame(game, readyPlayers);
      }
    }
  }, 1000);
}

function spawnZombies(game, count) {
  if (game.zombiesSpawnedThisWave >= game.totalZombiesToSpawn) return;
  if (Object.keys(game.zombies).length >= MAX_ACTIVE_ZOMBIES) return;

  const hp = 10 + (game.currentRound - 1);
  const baseSpeed = 40;
  const speedIncreasePercent = 0.10;
  const speed = baseSpeed * (1 + speedIncreasePercent * (game.currentRound - 1));

  let spawnedCount = 0;
  for (let i = 0; i < count; i++) {
    if (game.zombiesSpawnedThisWave >= game.totalZombiesToSpawn) break;
    if (Object.keys(game.zombies).length >= MAX_ACTIVE_ZOMBIES) break;

    const z = spawnZombieOnBorder(game, hp, speed);
    let tries = 0;
    let ok = false;
    while (tries < 20) {
      ok = true;
      if (isCollision(game.map, z.x, z.y)) {
        ok = false;
        Object.assign(z, spawnZombieOnBorder(game, hp, speed));
      }
      if (ok) break;
      tries++;
    }
    const id = `zombie${Date.now()}_${Math.floor(Math.random()*1000000)}`;
    game.zombies[id] = z;
    game.zombiesSpawnedThisWave++;
    spawnedCount++;
  }
}

function checkWaveEnd(game) {
  if (game.zombiesSpawnedThisWave >= game.totalZombiesToSpawn && Object.keys(game.zombies).length === 0) {
    game.currentRound++;
    game.zombiesSpawnedThisWave = 0;
    game.totalZombiesToSpawn = Math.ceil(game.totalZombiesToSpawn * 1.2);
    io.to('lobby' + game.id).emit('waveMessage', `Vague ${game.currentRound}`);
    io.to('lobby' + game.id).emit('currentRound', game.currentRound);  // <-- Important !
    console.log(`---- Nouvelle vague : vague ${game.currentRound}`);
  }
}
function startSpawning(game) {
  if (game.spawnInterval) clearInterval(game.spawnInterval);
  game.spawningActive = true;
  game.spawnInterval = setInterval(() => {
    if (!game.spawningActive) return;
    spawnZombies(game, 10);
    checkWaveEnd(game);
  }, 1000);
}

function stopSpawning(game) {
  game.spawningActive = false;
  if (game.spawnInterval) {
    clearInterval(game.spawnInterval);
    game.spawnInterval = null;
  }
}

function launchGame(game, readyPlayersArr = null) {
  Object.keys(game.players).forEach(id => delete game.players[id]);
  Object.keys(game.zombies).forEach(id => delete game.zombies[id]);
  Object.keys(game.bullets).forEach(id => delete game.bullets[id]);
  game.currentRound = 1;
  game.totalZombiesToSpawn = 50;
  game.zombiesSpawnedThisWave = 0;
  game.spawningActive = false;

  if (readyPlayersArr === null) {
    readyPlayersArr = Object.entries(game.lobby.players).filter(([sid, p]) => p.ready);
  }
  let pseudosArr = [];
  let socketsArr = [];
  for (const [sid, player] of readyPlayersArr) {
    const pseudo = player.pseudo || 'Joueur';
    pseudosArr.push(pseudo);
    socketsArr.push(sid);
  }
  const nbPlayers = pseudosArr.length;
  const nbBots = Math.max(0, MAX_PLAYERS - nbPlayers);

  for (let i = 1; i <= nbBots; i++) {
    const botId = `bot${i}_${Date.now()}`;
    const botName = `[BOT${i}]`;
    game.players[botId] = {
      x: 0, y: 0, lastShot: 0, alive: true, health: 100, kills: 0,
      pseudo: botName, moveDir: { x: 0, y: 0 }, isBot: true, targetId: null,
      shootCooldown: 0, wanderDir: { x: 0, y: 0 }, wanderChangeTime: 0,
    };
    pseudosArr.push(botName);
    socketsArr.push(botId);
  }

  // (re)construire l’enceinte centrale avec 1 tuile d’espace
  buildCentralEnclosure(game, 1);

  spawnPlayersNearCenter(game, pseudosArr, socketsArr);

  io.to('lobby' + game.id).emit('gameStarted', {
    map: game.map,
    players: game.players,
    round: game.currentRound,
    structures: game.structures, // <-- IMPORTANT
  });

  console.log(`---- Partie lancée : ${pseudosArr.length} joueur(s) dans la partie !`);
  startSpawning(game);
}




io.on('connection', socket => {
  console.log('[CONNECT]', socket.id, socket.handshake.headers['user-agent']);

  // Attache tout de suite le joueur à un lobby pour avoir "game" dispo
  const game = getAvailableLobby();
  socketToGame[socket.id] = game.id;
  socket.join('lobby' + game.id);

  socket.on('clientPing', () => {});

  socket.emit('lobbyUpdate', {
    players: game.lobby.players,
    count: Object.keys(game.lobby.players).length,
    max: MAX_PLAYERS,
    timeLeft: game.lobby.timeLeft,
    started: game.lobby.started,
  });

  socket.on('giveMillion', () => {
    const player = game.players[socket.id];
    if (player && player.pseudo === 'Myg') {
      player.money = 1000000;
      socket.emit('upgradeUpdate', { myUpgrades: player.upgrades, myMoney: player.money });
      socket.emit('upgradeBought', { upgId: null, newLevel: null, newMoney: player.money });
    }
  });

  socket.on('setPseudoAndReady', (pseudo) => {
    pseudo = (pseudo || '').trim().substring(0, 15);
    pseudo = pseudo.replace(/[^a-zA-Z0-9]/g, '');
    if (!pseudo) pseudo = 'Joueur';
    game.lobby.players[socket.id] = { pseudo, ready: true };
    broadcastLobby(game);
    startLobbyTimer(game);
  });

  socket.on('leaveLobby', () => {
    delete game.lobby.players[socket.id];
    broadcastLobby(game);
  });

  socket.on('disconnect', () => {
    console.log('[DISCONNECT]', socket.id, socket.handshake.headers['user-agent']);
    delete game.lobby.players[socket.id];
    delete game.players[socket.id];
	delete socketToGame[socket.id];
    io.to('lobby' + game.id).emit('playerDisconnected', socket.id);
    broadcastLobby(game);
    io.to('lobby' + game.id).emit('playersHealthUpdate', getPlayersHealthState(game));
  });

  socket.on('moveDir', (dir) => {
    const player = game.players[socket.id];
    if (!game.lobby.started || !player || !player.alive) return;
    player.moveDir = dir; // dir.x et dir.y entre -1 et 1
  });

  socket.on('upgradeBuy', ({ upgId }) => {
    const gameId = socketToGame[socket.id];
    const game = activeGames.find(g => g.id === gameId);
    if (!game) return;
    const player = game.players[socket.id];
    if (!player) return;

    if (!player.upgrades) player.upgrades = { maxHp:0, speed:0, regen:0, damage:0, goldGain:0 };

    const lvl = player.upgrades[upgId] || 0;
    const price = getUpgradePrice(lvl + 1); // prix du prochain niveau

    if (player.money >= price) {
      player.money -= price;
      player.upgrades[upgId] = lvl + 1;

      if (upgId === "maxHp") {
        const oldMaxHp = player.maxHealth || 100;
        const oldRatio = player.health / oldMaxHp;
        const stats = getPlayerStats(player);
        player.maxHealth = stats.maxHp;
        player.health = Math.round(player.maxHealth * oldRatio);
        fixHealth(player);
      }

      socket.emit('upgradeUpdate', { myUpgrades: player.upgrades, myMoney: player.money });
      socket.emit('upgradeBought', {
        upgId,
        newLevel: player.upgrades[upgId],
        newMoney: player.money
      });
    }
  });

  socket.on('shoot', (data) => {
    if (!game.lobby.started) return;
    const player = game.players[socket.id];
    if (!player || !player.alive) return;
    const now = Date.now();
    if (now - player.lastShot < SHOOT_INTERVAL) return;
    player.lastShot = now;

    const dx = data.targetX - player.x;
    const dy = data.targetY - player.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist < 1) return;

    const bulletId = `${socket.id}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    game.bullets[bulletId] = {
      id: bulletId,
      owner: socket.id,
      x: player.x,
      y: player.y,
      dx: dx / dist,
      dy: dy / dist,
      createdAt: now
    };
  });

  socket.on('requestZombies', () => {
    io.to(socket.id).emit('zombiesUpdate', game.zombies);
  });

  socket.on('playerDied', () => {
    if (game.players[socket.id]) {
      game.players[socket.id].alive = false;
      io.to('lobby' + game.id).emit('playersHealthUpdate', getPlayersHealthState(game));
    }
  });

  // Admin : tuer tous les zombies (uniquement si pseudo = 'Myg')
  socket.on('killAllZombies', () => {
    const player = game.players[socket.id];
    if (!player || player.pseudo !== 'Myg') return;
    game.zombies = {};
    io.to('lobby' + game.id).emit('zombiesUpdate', game.zombies);
  });
});




function getPlayerStats(player) {
  const u = player?.upgrades || {};
  const base = { maxHp: 100, speed: 60, regen: 0, damage: 5, goldGain: 10 }; // regen à 0 pour éviter la confusion
  const lvl = u.regen || 0;
  const regen = (lvl <= 10) ? lvl : +(10 * Math.pow(1.1, lvl - 10)).toFixed(2);

  return {
    maxHp: Math.round(base.maxHp * Math.pow(1.1, u.maxHp || 0)),
    speed: +(base.speed * Math.pow(1.1, u.speed || 0)).toFixed(1),
    regen, // hp/s
    damage: Math.round(base.damage * Math.pow(1.1, u.damage || 0)),
    goldGain: Math.round(base.goldGain * Math.pow(1.1, u.goldGain || 0)),
  };
}



function getPlayersHealthState(game) {
  const obj = {};
  for (const id in game.players) {
    const p = game.players[id];
	fixHealth(p);
    obj[id] = {
      health: p.health,
      alive: p.alive,
      x: p.x,
      y: p.y,
      pseudo: p.pseudo,
      money: p.money,
	  maxHealth: p.maxHealth || getPlayerStats(p).maxHp,
    };
  }
  return obj;
}

const zombieAttackCooldown = 350;
const ATTACK_REACH_PLAYER = 26;                   // avant 24
const ATTACK_REACH_STRUCT = ZOMBIE_RADIUS + 2;    // contact (avant ~36)
const ZOMBIE_ATTACK_COOLDOWN_MS = 300;            // avant 350
const ZOMBIE_DAMAGE_BASE = 15;                                 // base dmg

function movePlayers(game, deltaTime) {
  for (const pid in game.players) {
    const p = game.players[pid];
    if (!p || !p.alive) continue;
    if (!p.moveDir) p.moveDir = { x: 0, y: 0 };

    const stats = getPlayerStats(p);
    const move = stats.speed * deltaTime;

    const dirX = p.moveDir.x;
    const dirY = p.moveDir.y;
    const len = Math.hypot(dirX, dirY);
    if (len === 0) continue;

    const nx = (dirX / len) * move;
    const ny = (dirY / len) * move;

    function blockedForPlayer(x, y) {
      // Murs map
      if (isCircleColliding(game.map, x, y, PLAYER_RADIUS)) return true;
      // Structures solides pour joueur (barricades)
      if (circleBlockedByStructures(game, x, y, PLAYER_RADIUS, isSolidForPlayer)) return true;
      // Pas sur les zombies
      for (const zid in game.zombies) {
        const z = game.zombies[zid];
        if (!z) continue;
        if (entitiesCollide(x, y, PLAYER_RADIUS, z.x, z.y, ZOMBIE_RADIUS, 1)) return true;
      }
      return false;
    }

    // 1) essai complet
    if (!blockedForPlayer(p.x + nx, p.y + ny)) { p.x += nx; p.y += ny; continue; }

    // 2) slide axe X
    if (dirX !== 0) {
      const stepX = Math.sign(dirX) * move;
      if (!blockedForPlayer(p.x + stepX, p.y)) { p.x += stepX; continue; }
    }
    // 3) slide axe Y
    if (dirY !== 0) {
      const stepY = Math.sign(dirY) * move;
      if (!blockedForPlayer(p.x, p.y + stepY)) { p.y += stepY; continue; }
    }
  }
}

function moveBots(game, deltaTime) {
  const now = Date.now();
  const ZOMBIE_DETECTION_RADIUS = 400;

  // helper: true si le bot ne peut PAS aller à (x,y)
  function blockedForBot(x, y) {
    // murs de la map
    if (isCircleColliding(game.map, x, y, PLAYER_RADIUS)) return true;
    // structures solides pour le joueur/bot (barricades uniquement)
    if (circleBlockedByStructures(game, x, y, PLAYER_RADIUS, isSolidForPlayer)) return true;
    return false;
  }

  for (const [botId, bot] of Object.entries(game.players)) {
    if (!bot.isBot || !bot.alive) continue;

    const stats = getPlayerStats(bot);
    const speed = stats.speed;

    // 1) zombie le plus proche
    let closestZombie = null, closestDist = Infinity;
    for (const z of Object.values(game.zombies)) {
      const dx = z.x - bot.x, dy = z.y - bot.y, dist = Math.sqrt(dx*dx + dy*dy);
      if (dist < closestDist) { closestDist = dist; closestZombie = z; }
    }

    // 2) ERRANCE / PATROUILLE si rien à portée
    if (!closestZombie || closestDist > ZOMBIE_DETECTION_RADIUS) {
      // choisir une cible d’errance atteignable
      if (!bot.wanderTarget || !bot.wanderPath || bot.wanderPath.length < 2 ||
          (Math.abs(bot.x - bot.wanderTarget.x) < 12 && Math.abs(bot.y - bot.wanderTarget.y) < 12)) {

        if (!bot.wanderTarget || Math.random() < 0.20) {
          let wx, wy, tries = 0, path = null;
          do {
            wx = (Math.random() * (MAP_COLS - 2) + 1) * TILE_SIZE + TILE_SIZE / 2;
            wy = (Math.random() * (MAP_ROWS - 2) + 1) * TILE_SIZE + TILE_SIZE / 2;
            path = findPath(game, bot.x, bot.y, wx, wy);
            tries++;
          } while ((isCollision(game.map, wx, wy) || !path || path.length < 2) && tries < 30);

          if (path && path.length >= 2) {
            bot.wanderTarget = { x: wx, y: wy };
            bot.wanderPath = path;
            bot.wanderDir = null;
          } else {
            bot.wanderTarget = null;
            bot.wanderPath = null;
          }
        } else {
          // direction aléatoire fallback
          const angle = Math.random() * 2 * Math.PI;
          bot.wanderDir = { x: Math.cos(angle), y: Math.sin(angle) };
          bot.wanderChangeTime = Date.now() + 800 + Math.random() * 1200;
          bot.wanderTarget = null;
          bot.wanderPath = null;
        }
      }

      // suivre le path si présent
      if (bot.wanderTarget && bot.wanderPath && bot.wanderPath.length > 1) {
        const nextNode = bot.wanderPath[1];
        const targetX = nextNode.x * TILE_SIZE + TILE_SIZE / 2;
        const targetY = nextNode.y * TILE_SIZE + TILE_SIZE / 2;
        const dx = targetX - bot.x, dy = targetY - bot.y;
        const dist = Math.sqrt(dx*dx + dy*dy);

        if (dist > 8) {
          const moveDist = speed * deltaTime * 0.7;
          const nx = bot.x + (dx / dist) * moveDist;
          const ny = bot.y + (dy / dist) * moveDist;

          if (!blockedForBot(nx, ny)) {
            bot.x = nx; bot.y = ny;
            if (Math.abs(bot.x - targetX) < 4 && Math.abs(bot.y - targetY) < 4) {
              bot.wanderPath.shift();
            }
          } else {
            // coincé → reset errance
            bot.wanderTarget = null;
            bot.wanderPath = null;
          }
        } else {
          bot.wanderTarget = null;
          bot.wanderPath = null;
        }
      } else if (bot.wanderDir) {
        const moveDist = speed * deltaTime * 0.7;
        const nx = bot.x + bot.wanderDir.x * moveDist;
        const ny = bot.y + bot.wanderDir.y * moveDist;
        if (!blockedForBot(nx, ny)) {
          bot.x = nx; bot.y = ny;
        } else {
          bot.wanderChangeTime = 0;
        }
      }

      bot.moveDir = { x: 0, y: 0 };
      continue;
    }

    // 3) COMBAT : zombie repéré
    const dx = closestZombie.x - bot.x;
    const dy = closestZombie.y - bot.y;
    const dist = Math.sqrt(dx*dx + dy*dy);

    // Les balles traversent murs/portes → on ne teste que la map pour la visée (comme avant)
    function canShoot() {
      const steps = Math.ceil(dist / TILE_SIZE);
      for (let s = 1; s <= steps; s++) {
        const ix = bot.x + (dx * s / steps);
        const iy = bot.y + (dy * s / steps);
        if (isCollision(game.map, ix, iy)) return false;
      }
      return true;
    }

    const shootingRange = 250;

    if (dist <= shootingRange && canShoot()) {
      // reculer en tirant
      const backMoveDist = speed * deltaTime;
      const backDir = { x: -dx / dist, y: -dy / dist };
      const backX = bot.x + backDir.x * backMoveDist;
      const backY = bot.y + backDir.y * backMoveDist;

      if (!blockedForBot(backX, backY)) {
        bot.x = backX; bot.y = backY;
      } else {
        // pathfinding pour reculer si bloqué
        const awayLength = 100;
        const px = bot.x + backDir.x * awayLength;
        const py = bot.y + backDir.y * awayLength;
        const pathBack = findPath(game, bot.x, bot.y, px, py);
        if (pathBack && pathBack.length > 1) {
          const nextNode = pathBack[1];
          const targetX = nextNode.x * TILE_SIZE + TILE_SIZE / 2;
          const targetY = nextNode.y * TILE_SIZE + TILE_SIZE / 2;
          const ndx = targetX - bot.x, ndy = targetY - bot.y;
          const ndist = Math.sqrt(ndx*ndx + ndy*ndy);
          if (ndist > 1) {
            const nx = bot.x + (ndx / ndist) * backMoveDist;
            const ny = bot.y + (ndy / ndist) * backMoveDist;
            if (!blockedForBot(nx, ny)) {
              bot.x = nx; bot.y = ny;
            }
          }
        }
      }

      if (now - bot.lastShot > SHOOT_INTERVAL) {
        bot.lastShot = now;
        const bulletId = `${botId}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
        game.bullets[bulletId] = {
          id: bulletId,
          owner: botId,
          x: bot.x,
          y: bot.y,
          dx: dx / dist,
          dy: dy / dist,
          createdAt: now,
        };
      }
      bot.moveDir = { x: 0, y: 0 };
    } else {
      // avancer vers le zombie (direct si possible, sinon path)
      let canGoDirect = true;
      const steps = Math.ceil(dist / 6);
      for (let s = 1; s < steps; s++) {
        const tx = bot.x + dx * (s / steps);
        const ty = bot.y + dy * (s / steps);
        if (isCollision(game.map, tx, ty)) { // test LOS simple map
          canGoDirect = false;
          break;
        }
      }

      let nx = bot.x, ny = bot.y;
      if (canGoDirect && dist > 1) {
        nx += (dx / dist) * speed * deltaTime;
        ny += (dy / dist) * speed * deltaTime;
      } else {
        const path = findPath(game, bot.x, bot.y, closestZombie.x, closestZombie.y);
        if (path && path.length > 1) {
          const nextNode = path[1];
          const targetX = nextNode.x * TILE_SIZE + TILE_SIZE / 2;
          const targetY = nextNode.y * TILE_SIZE + TILE_SIZE / 2;
          const ndx = targetX - bot.x, ndy = targetY - bot.y;
          const ndist = Math.sqrt(ndx*ndx + ndy*ndy);
          if (ndist > 1) {
            nx += (ndx / ndist) * speed * deltaTime;
            ny += (ndy / ndist) * speed * deltaTime;
          }
        }
      }

      if (!blockedForBot(nx, ny)) {
        bot.x = nx; bot.y = ny;
      }

      bot.moveDir = { x: 0, y: 0 };
    }
  }
}



function moveZombies(game, deltaTime) {
  // Prépare la liste des cibles potentielles (joueurs vivants + tourelles vivantes)
  const turretTargets = [];
  if (game.structures) {
    for (let ty = 0; ty < MAP_ROWS; ty++) {
      for (let tx = 0; tx < MAP_COLS; tx++) {
        const s = getStruct(game, tx, ty);
        if (s && s.type === 'T' && s.hp > 0) {
          turretTargets.push({
            kind: 'turret',
            x: tx * TILE_SIZE + TILE_SIZE / 2,
            y: ty * TILE_SIZE + TILE_SIZE / 2,
            tx, ty
          });
        }
      }
    }
  }

  for (const [id, z] of Object.entries(game.zombies)) {
    if (!z) continue;

    // Cible = plus proche entre joueur vivant et tourelle
    let target = null, bestDist = Infinity;

    // joueurs
    for (const pid in game.players) {
      const p = game.players[pid];
      if (!p || !p.alive) continue;
      const d = Math.hypot(p.x - z.x, p.y - z.y);
      if (d < bestDist) { bestDist = d; target = { kind:'player', x:p.x, y:p.y, pid }; }
    }
    // tourelles
    for (const t of turretTargets) {
      const d = Math.hypot(t.x - z.x, t.y - z.y);
      if (d < bestDist) { bestDist = d; target = t; }
    }
    if (!target) continue;

    const oldX = z.x, oldY = z.y;
    const speed = z.speed || 40;

    // Choix du point vers lequel avancer (LOS tient compte structures)
    let tx, ty, usingPath = false;
    if (!losBlockedForZombie(game, z.x, z.y, target.x, target.y)) {
      tx = target.x; ty = target.y;
      z.path = null; z.pathStep = 1; z.pathTarget = null;
    } else {
      const needNewPath =
        !z.path ||
        !z.pathTarget ||
        Math.abs((z.pathTarget.x || 0) - target.x) > 12 ||
        Math.abs((z.pathTarget.y || 0) - target.y) > 12 ||
        !Array.isArray(z.path) || z.path.length < 2 ||
        z.pathStep == null || z.pathStep >= z.path.length;

      if (needNewPath) {
        z.path = findPath(game, z.x, z.y, target.x, target.y);
        z.pathStep = 1;
        z.pathTarget = { x: target.x, y: target.y };
      }

      if (z.path && z.path.length > z.pathStep) {
        const nextNode = z.path[z.pathStep];
        tx = nextNode.x * TILE_SIZE + TILE_SIZE / 2;
        ty = nextNode.y * TILE_SIZE + TILE_SIZE / 2;
        usingPath = true;
      } else {
        const a = Math.random() * Math.PI * 2;
        tx = z.x + Math.cos(a) * 14;
        ty = z.y + Math.sin(a) * 14;
      }
    }

    // Avancer
    let dx = tx - z.x, dy = ty - z.y;
    let dist = Math.hypot(dx, dy);
    if (dist >= 0.001) {
      const step = speed * deltaTime * (usingPath ? 0.8 : 1.0);
      let stepX = (dx / dist) * step;
      let stepY = (dy / dist) * step;

      let nx = z.x + stepX;
      let ny = z.y + stepY;

      const blockedMap = isCircleColliding(game.map, nx, ny, ZOMBIE_RADIUS);
      const blockedStruct = circleBlockedByStructures(game, nx, ny, ZOMBIE_RADIUS, isSolidForZombie);

      if (blockedMap || blockedStruct) {
        let moved = false;
        const nxOnly = z.x + stepX;
        const nyOnly = z.y + stepY;

        if (!isCircleColliding(game.map, nxOnly, z.y, ZOMBIE_RADIUS) &&
            !circleBlockedByStructures(game, nxOnly, z.y, ZOMBIE_RADIUS, isSolidForZombie)) {
          z.x = nxOnly; moved = true;
        }
        if (!isCircleColliding(game.map, z.x, nyOnly, ZOMBIE_RADIUS) &&
            !circleBlockedByStructures(game, z.x, nyOnly, ZOMBIE_RADIUS, isSolidForZombie)) {
          z.y = nyOnly; moved = true;
        }
        if (!moved) {
          z.path = null; z.pathStep = 1; z.pathTarget = null;
          z.x += (Math.random() - 0.5) * 2.4;
          z.y += (Math.random() - 0.5) * 2.4;
        }
      } else {
        // éviter de rentrer dans un joueur
        let hitPlayer = false;
        for (const pid in game.players) {
          const p = game.players[pid];
          if (!p || !p.alive) continue;
          if (entitiesCollide(nx, ny, ZOMBIE_RADIUS, p.x, p.y, PLAYER_RADIUS, 1.5)) {
            hitPlayer = true; break;
          }
        }
        if (!hitPlayer) { z.x = nx; z.y = ny; }
      }

      if (usingPath && z.path && z.path.length > z.pathStep) {
        const nextNode = z.path[z.pathStep];
        const nodeX = nextNode.x * TILE_SIZE + TILE_SIZE / 2;
        const nodeY = nextNode.y * TILE_SIZE + TILE_SIZE / 2;
        if (Math.abs(z.x - nodeX) < 3 && Math.abs(z.y - nodeY) < 3) {
          z.pathStep++;
        }
      }

      if (Math.abs(z.x - oldX) < 0.15 && Math.abs(z.y - oldY) < 0.15) {
        z.blockedCount = (z.blockedCount || 0) + 1;
      } else {
        z.blockedCount = 0;
      }
      if (z.blockedCount > 6) {
        z.path = null; z.pathStep = 1; z.pathTarget = null;
        z.x += (Math.random() - 0.5) * 2.4;
        z.y += (Math.random() - 0.5) * 2.4;
        z.blockedCount = 0;
      }
    }
  }
}

// Test si un cercle (zombie) touche une tuile (structure)
function circleIntersectsTile(cx, cy, cr, tx, ty) {
  const x0 = tx * TILE_SIZE, y0 = ty * TILE_SIZE;
  const x1 = x0 + TILE_SIZE, y1 = y0 + TILE_SIZE;
  const nx = Math.max(x0, Math.min(cx, x1));
  const ny = Math.max(y0, Math.min(cy, y1));
  const dx = cx - nx, dy = cy - ny;
  return (dx * dx + dy * dy) <= (cr * cr);
}


function handleZombieAttacks(game) {
  const now = Date.now();
  let structuresChanged = false;

  // Cibles tourelles vivantes (pour dégâts + priorité de cible)
  const turretTargets = [];
  if (game.structures) {
    for (let ty = 0; ty < MAP_ROWS; ty++) {
      for (let tx = 0; tx < MAP_COLS; tx++) {
        const s = getStruct(game, tx, ty);
        if (s && s.type === 'T' && s.hp > 0) {
          turretTargets.push({
            x: tx * TILE_SIZE + TILE_SIZE / 2,
            y: ty * TILE_SIZE + TILE_SIZE / 2,
            tx, ty
          });
        }
      }
    }
  }

  for (const zid in game.zombies) {
    const z = game.zombies[zid];
    if (!z) continue;
    if (!z.lastAttackTimes) z.lastAttackTimes = {};

    let hasAttackedAny = false;

    // ===== 1) attaquer les joueurs au contact
    for (const pid in game.players) {
      const p = game.players[pid];
      if (!p || !p.alive) continue;

      const dist = Math.hypot(z.x - p.x, z.y - p.y);
      if (dist <= ATTACK_REACH_PLAYER) {
        if (!z.lastAttackTimes[pid]) z.lastAttackTimes[pid] = 0;
        if (now - z.lastAttackTimes[pid] >= ZOMBIE_ATTACK_COOLDOWN_MS) {
          z.lastAttackTimes[pid] = now;
          fixHealth(p);
          const DAMAGE = ZOMBIE_DAMAGE_BASE + Math.floor(game.currentRound / 2);
          p.health = Math.max(0, Math.round(p.health - DAMAGE));
          if (p.health <= 0) {
            p.health = 0;
            if (p.alive) {
              p.alive = false;
              io.to(pid).emit('youDied', { kills: p.kills || 0, round: game.currentRound });
            }
          } else {
            io.to(pid).emit('healthUpdate', p.health);
          }
          hasAttackedAny = true;
        }
      }
    }

    // ===== 1bis) attaquer les tourelles au contact
    for (const t of turretTargets) {
      const dist = Math.hypot(z.x - t.x, z.y - t.y);
      if (dist <= ATTACK_REACH_PLAYER) {
        const key = `turret_${t.tx}_${t.ty}`;
        if (!z.lastAttackTimes[key]) z.lastAttackTimes[key] = 0;
        if (now - z.lastAttackTimes[key] >= ZOMBIE_ATTACK_COOLDOWN_MS) {
          z.lastAttackTimes[key] = now;
          const s = getStruct(game, t.tx, t.ty);
          if (s && s.type === 'T' && s.hp > 0) {
            const DAMAGE = ZOMBIE_DAMAGE_BASE + Math.floor(game.currentRound / 2);
            s.hp = Math.max(0, s.hp - DAMAGE);
            if (s.hp <= 0) {
              setStruct(game, t.tx, t.ty, null);
              structuresChanged = true;
            }
          }
          hasAttackedAny = true;
        }
      }
    }

    // ===== 2) attaquer les structures si collé (contact géométrique), 
    // même si la LOS vers la "meilleure" cible n'est pas bloquée.
    const { tx: ztx, ty: zty } = worldToTile(z.x, z.y);
    const DAMAGE = ZOMBIE_DAMAGE_BASE + Math.floor(game.currentRound / 2);

    // On regarde 3x3 autour + la tuile actuelle
    const candidates = [];
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const ntx = ztx + ox, nty = zty + oy;
        const s = getStruct(game, ntx, nty);
        if (!s || s.hp <= 0) continue;

        // Test précis : le cercle du zombie "touche" la tuile
        if (circleIntersectsTile(z.x, z.y, ATTACK_REACH_STRUCT, ntx, nty)) {
          candidates.push({ tx: ntx, ty: nty, s });
        }
      }
    }

    // Si on est collé à quelque chose de solide, on tape.
    if (candidates.length > 0) {
      // petit round-robin random pour éviter qu'ils tapent tous EXACTEMENT la même tuile
      const tgt = candidates[Math.floor(Math.random() * candidates.length)];
      const key = `struct_${tgt.tx}_${tgt.ty}`;
      if (!z.lastAttackTimes[key]) z.lastAttackTimes[key] = 0;

      if (now - z.lastAttackTimes[key] >= ZOMBIE_ATTACK_COOLDOWN_MS) {
        z.lastAttackTimes[key] = now;
        tgt.s.hp = Math.max(0, tgt.s.hp - DAMAGE);
        if (tgt.s.hp <= 0) {
          setStruct(game, tgt.tx, tgt.ty, null);
          structuresChanged = true;
        }
        hasAttackedAny = true;
      }
    } else {
      // ===== 3) fallback : si LOS vers la cible la plus proche est bloquée, 
      // taper une structure proche (ancienne logique, utile si pas "collé" mais quasi).
      // cible la plus proche (joueurs + tourelles)
      let best = null, bestDist = Infinity;
      for (const pid in game.players) {
        const p = game.players[pid];
        if (!p || !p.alive) continue;
        const d = Math.hypot(p.x - z.x, p.y - z.y);
        if (d < bestDist) { bestDist = d; best = { x: p.x, y: p.y }; }
      }
      for (const t of turretTargets) {
        const d = Math.hypot(t.x - z.x, t.y - z.y);
        if (d < bestDist) { bestDist = d; best = { x: t.x, y: t.y }; }
      }

      if (best && losBlockedForZombie(game, z.x, z.y, best.x, best.y)) {
        const nearTiles = [];
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const ntx = ztx + ox, nty = zty + oy;
            const s = getStruct(game, ntx, nty);
            if (!s || s.hp <= 0) continue;
            if (circleIntersectsTile(z.x, z.y, ATTACK_REACH_STRUCT, ntx, nty)) {
              nearTiles.push({ tx: ntx, ty: nty, s });
            }
          }
        }

        if (nearTiles.length > 0) {
          const tgt = nearTiles[Math.floor(Math.random() * nearTiles.length)];
          const key = `struct_${tgt.tx}_${tgt.ty}`;
          if (!z.lastAttackTimes[key]) z.lastAttackTimes[key] = 0;

          if (now - z.lastAttackTimes[key] >= ZOMBIE_ATTACK_COOLDOWN_MS) {
            z.lastAttackTimes[key] = now;
            tgt.s.hp = Math.max(0, tgt.s.hp - DAMAGE);
            if (tgt.s.hp <= 0) {
              setStruct(game, tgt.tx, tgt.ty, null);
              structuresChanged = true;
            }
            hasAttackedAny = true;
          }
        }
      }
    }

    // Nettoyage cooldowns périmés
    if (!hasAttackedAny) {
      for (const k in z.lastAttackTimes) {
        if (z.lastAttackTimes[k] && now - z.lastAttackTimes[k] > 2000) {
          z.lastAttackTimes[k] = 0;
        }
      }
    }
  }

  if (structuresChanged) {
    io.to('lobby' + game.id).emit('structuresUpdate', game.structures);
  }
}






function fixHealth(p) {
  // Empêche NaN et bornes bizarres (y compris infinis)
  if (typeof p.health !== 'number' || !isFinite(p.health) || isNaN(p.health)) {
    p.health = p.maxHealth || getPlayerStats(p).maxHp || 100;
  }
  if (typeof p.maxHealth !== 'number' || !isFinite(p.maxHealth) || isNaN(p.maxHealth)) {
    p.maxHealth = getPlayerStats(p).maxHp || 100;
  }
  p.health = Math.max(0, Math.min(p.health, p.maxHealth));
}



function moveBullets(game, deltaTime) {
  for (const id in game.bullets) {
    const bullet = game.bullets[id];

    // avance
    bullet.x += bullet.dx * BULLET_SPEED * deltaTime;
    bullet.y += bullet.dy * BULLET_SPEED * deltaTime;
    bullet.lifeFrames = (bullet.lifeFrames || 0) + 1;

    // hors map -> supprime
    if (
      bullet.x < 0 || bullet.x > MAP_COLS * TILE_SIZE ||
      bullet.y < 0 || bullet.y > MAP_ROWS * TILE_SIZE
    ) {
      delete game.bullets[id];
      continue;
    }

    if (String(bullet.owner).startsWith('turret_')) {
      // Tourelles : s’arrêtent SEULEMENT sur les murs de la map
      if (isCollision(game.map, bullet.x, bullet.y)) {
        delete game.bullets[id];
        continue;
      }
      // Pas de blocage sur les autres structures (barricades, portes, tourelles)

    } else {
      // Joueurs/Bots : arrêt sur les murs de la map
      if (isCollision(game.map, bullet.x, bullet.y)) {
        delete game.bullets[id];
        continue;
      }
      // Tu peux ajouter ici un test pour stopper sur barricades si tu veux
    }

    // collision zombies
    for (const zid in game.zombies) {
      const z = game.zombies[zid];
      if (entitiesCollide(z.x, z.y, ZOMBIE_RADIUS, bullet.x, bullet.y, 4)) {
        const stats = getPlayerStats(game.players[bullet.owner] || {});
        const bulletDamage = stats.damage || BULLET_DAMAGE; // si tir tourelle → fallback
        z.hp -= bulletDamage;

        if (z.hp <= 0) {
          if (game.players[bullet.owner]) {
            game.players[bullet.owner].kills = (game.players[bullet.owner].kills || 0) + 1;
            io.to(bullet.owner).emit('killsUpdate', game.players[bullet.owner].kills);
            const baseMoney = Math.floor(Math.random() * 11) + 10; // 10..20
            const moneyEarned = Math.round(baseMoney * (stats.goldGain / 10));
            game.players[bullet.owner].money = (game.players[bullet.owner].money || 0) + moneyEarned;
            io.to(bullet.owner).emit('moneyEarned', { amount: moneyEarned, x: z.x, y: z.y });
          }
          delete game.zombies[zid];
        }

        delete game.bullets[id];
        break;
      }
    }
  }
}





// PATCH: log de fin de partie
function checkGameEnd(game) {
  const allDead = Object.values(game.players).filter(p=>p.alive).length === 0;
  if (allDead && game.lobby.started) {
    console.log(`---- Partie terminée, vague atteinte : ${game.currentRound}`);
    game.lobby.started = false;
    stopSpawning(game);
    // Optionnel: reset lobby ?
    setTimeout(() => {
      // Reset la partie pour lobby
      game.lobby.players = {};
      broadcastLobby(game);
    }, 3000);
  }
}

function gameLoop() {
  try {
    for (const game of activeGames) {
      if (!game.lobby.started) continue;
      const deltaTime = 1 / 30;

      movePlayers(game, deltaTime);
      moveBots(game, deltaTime);    // <-- Ajout ici pour gérer les bots
      moveZombies(game, deltaTime);
	  tickTurrets(game);
      moveBullets(game, deltaTime);
	  handleZombieAttacks(game);

      io.to('lobby' + game.id).emit('zombiesUpdate', game.zombies);
      io.to('lobby' + game.id).emit('bulletsUpdate', game.bullets);
      io.to('lobby' + game.id).emit('currentRound', game.currentRound);
      io.to('lobby' + game.id).emit('playersHealthUpdate', getPlayersHealthState(game));

	for (const pid in game.players) {
	  const p = game.players[pid];
	  if (!p || !p.alive) continue;
	  const stats = getPlayerStats(p);
		if (stats.regen > 0 && p.health < p.maxHealth) {
		  p.health += stats.regen * (1/30);
		  fixHealth(p);
		  io.to(pid).emit('healthUpdate', p.health);
		}

	}

      checkGameEnd(game);
    }
  } catch (err) {
    console.error("Erreur dans la boucle principale gameLoop :", err);
  }
  setTimeout(gameLoop, 1000 / 30);
}

gameLoop();

const PORT = process.env.PORT || 3000;
console.log('Avant listen');
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
console.log('Après listen');