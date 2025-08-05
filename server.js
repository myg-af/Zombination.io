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
const io = socketIo(server);

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

// PATCH : 8 joueurs max
const MAX_PLAYERS = 8;
const LOBBY_TIME = 30 * 1000; // 30 sec
const MAX_ACTIVE_ZOMBIES = 150;

let activeGames = [];
let nextGameId = 1;

function createNewGame() {
  let game = {
    id: nextGameId++,
    lobby: {
      players: {},
      timeLeft: LOBBY_TIME / 1000,
      started: false,
      timer: null,
    },
    players: {},
    zombies: {},
    bullets: {},
    currentRound: 1,
    totalZombiesToSpawn: 50,
    zombiesSpawnedThisWave: 0,
    map: null,
    spawnInterval: null,
    spawningActive: false,
    bots: {},  // PATCH BOTS
  };
  game.map = createEmptyMap(MAP_ROWS, MAP_COLS);
  placeObstacles(game.map, OBSTACLE_COUNT);
  activeGames.push(game);
  return game;
}

function getAvailableLobby() {
  let game = activeGames.find(g => !g.lobby.started);
  if (!game) game = createNewGame();
  return game;
}

const socketToGame = {};

const PLAYER_RADIUS = 10;
const ZOMBIE_RADIUS = 10;

function entitiesCollide(ax, ay, aradius, bx, by, bradius, bonus=0) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy) < (aradius + bradius + bonus);
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
  return { x: spawnX, y: spawnY, hp: hp, lastAttack: 0, speed: speed };
}

function spawnPlayersNearCenter(game, pseudosArr, socketsArr, botsArr = []) {
  const centerX = (MAP_COLS / 2) * TILE_SIZE;
  const centerY = (MAP_ROWS / 2) * TILE_SIZE;
  const angleStep = (2 * Math.PI) / Math.max(1, pseudosArr.length + botsArr.length);
  const radius = 60 + (pseudosArr.length + botsArr.length) * 8;
  const usedPos = [];

  let allNames = pseudosArr.slice();
  let allIds = socketsArr.slice();
  botsArr.forEach(bot => {
    allNames.push(bot.pseudo);
    allIds.push(bot.id);
  });

  for (let i = 0; i < allNames.length; i++) {
    let angle = i * angleStep;
    let tries = 0, found = false, spawnX, spawnY;
    while (!found && tries < 30) {
      spawnX = Math.floor(centerX + Math.cos(angle) * radius + (Math.random() - 0.5) * 12);
      spawnY = Math.floor(centerY + Math.sin(angle) * radius + (Math.random() - 0.5) * 12);

      if (!isCollision(game.map, spawnX, spawnY) && !usedPos.some(
        pos => Math.hypot(pos.x - spawnX, pos.y - spawnY) < 2 * PLAYER_RADIUS + 4
      )) {
        found = true;
        usedPos.push({ x: spawnX, y: spawnY });
      }
      tries++;
      angle += Math.PI / 9;
    }
    const pseudo = allNames[i];
    const sid = allIds[i];
    game.players[sid] = {
      x: spawnX, y: spawnY,
      lastShot: 0, alive: true, health: 100, kills: 0, pseudo,
      moveDir: {x: 0, y: 0},
      isBot: botsArr.find(b => b.id === sid) ? true : false  // PATCH
    };
    // PATCH : Ajouté au game.bots si BOT
    if (game.players[sid].isBot) game.bots[sid] = game.players[sid];
  }
}

function findPath(game, startX, startY, endX, endY) {
  // ... inchangé (même code que toi)
  const openSet = [];
  const closedSet = new Set();
  const cameFrom = new Map();

  function nodeKey(x, y) { return `${x},${y}`; }
  function heuristic(x1, y1, x2, y2) { return Math.abs(x1 - x2) + Math.abs(y1 - y2); }

  const startNode = { x: Math.floor(startX / TILE_SIZE), y: Math.floor(startY / TILE_SIZE), g: 0 };
  startNode.f = heuristic(startNode.x, startNode.y, Math.floor(endX / TILE_SIZE), Math.floor(endY / TILE_SIZE));
  openSet.push(startNode);

  const goalX = Math.floor(endX / TILE_SIZE);
  const goalY = Math.floor(endY / TILE_SIZE);

  while (openSet.length > 0) {
    openSet.sort((a, b) => a.f - b.f);
    const current = openSet.shift();
    if (current.x === goalX && current.y === goalY) {
      const path = [];
      let cur = current;
      while (cur) {
        path.unshift({ x: cur.x, y: cur.y });
        cur = cameFrom.get(nodeKey(cur.x, cur.y));
      }
      return path;
    }
    closedSet.add(nodeKey(current.x, current.y));
    const neighbors = [
      { x: current.x + 1, y: current.y },
      { x: current.x - 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x, y: current.y - 1 },
    ];
    for (const n of neighbors) {
      if (
        n.x < 0 || n.x >= MAP_COLS ||
        n.y < 0 || n.y >= MAP_ROWS ||
        game.map[n.y][n.x] === 1 ||
        closedSet.has(nodeKey(n.x, n.y))
      ) {
        continue;
      }
      const tentativeG = current.g + 1;
      const existingNode = openSet.find(node => node.x === n.x && node.y === n.y);
      if (!existingNode || tentativeG < existingNode.g) {
        cameFrom.set(nodeKey(n.x, n.y), current);
        const f = tentativeG + heuristic(n.x, n.y, goalX, goalY);
        if (existingNode) {
          existingNode.g = tentativeG;
          existingNode.f = f;
        } else {
          openSet.push({ x: n.x, y: n.y, g: tentativeG, f });
        }
      }
    }
  }
  return null;
}

// PATCH : pseudo bot
function getBotPseudo(idx) {
  const pseudos = ['Botox', 'BillyBot', 'Robo', 'Terminator', 'ZBot', 'Mr. Bot', 'Botman', 'Botzilla', 'BoTifull', 'B0tster'];
  return pseudos[idx % pseudos.length];
}

const SHOOT_INTERVAL = 500;
const BULLET_SPEED = 600;
const BULLET_DAMAGE = 5;
const PLAYER_SPEED_PER_SEC = 60;

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
  // ... inchangé (comme avant)
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
  // ... inchangé
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
    spawnZombies(game, 1);
    checkWaveEnd(game);
  }, 200);
}

function stopSpawning(game) {
  game.spawningActive = false;
  if (game.spawnInterval) {
    clearInterval(game.spawnInterval);
    game.spawnInterval = null;
  }
}

// PATCH BOTS + 8 joueurs
function launchGame(game, readyPlayersArr = null) {
  Object.keys(game.players).forEach(id => delete game.players[id]);
  Object.keys(game.zombies).forEach(id => delete game.zombies[id]);
  Object.keys(game.bullets).forEach(id => delete game.bullets[id]);
  game.currentRound = 1;
  game.totalZombiesToSpawn = 50;
  game.zombiesSpawnedThisWave = 0;
  game.spawningActive = false;
  game.bots = {};

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
  // Ajout bots si < MAX_PLAYERS
  const botsArr = [];
  for (let i = pseudosArr.length; i < MAX_PLAYERS; i++) {
    let botId = 'bot_' + game.id + '_' + i;
    botsArr.push({ id: botId, pseudo: getBotPseudo(i) });
  }

  spawnPlayersNearCenter(game, pseudosArr, socketsArr, botsArr);

  io.to('lobby' + game.id).emit('gameStarted', { map: game.map, players: game.players, round: game.currentRound });

  // Log nouvelle partie
  console.log(`---- Partie lancée : ${pseudosArr.length} joueurs + ${botsArr.length} bots`);
  startSpawning(game);
}

io.on('connection', socket => {
  const game = getAvailableLobby();
  socketToGame[socket.id] = game.id;
  socket.join('lobby' + game.id);

  socket.emit('lobbyUpdate', {
    players: game.lobby.players,
    count: Object.keys(game.lobby.players).length,
    max: MAX_PLAYERS,
    timeLeft: game.lobby.timeLeft,
    started: game.lobby.started,
  });

  socket.on('setPseudoAndReady', (pseudo) => {
    pseudo = (pseudo || '').trim().substring(0, 15);
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
    delete game.lobby.players[socket.id];
    delete game.players[socket.id];
    io.to('lobby' + game.id).emit('playerDisconnected', socket.id);
    broadcastLobby(game);
    io.to('lobby' + game.id).emit('playersHealthUpdate', getPlayersHealthState(game));
  });

  socket.on('moveDir', (dir) => {
    const player = game.players[socket.id];
    if (!game.lobby.started || !player || !player.alive) return;
    player.moveDir = dir;
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

  socket.on('killAllZombies', () => {
    const player = game.players[socket.id];
    if (!player || player.pseudo !== 'Myg') return;
    game.zombies = {};
    io.to('lobby' + game.id).emit('zombiesUpdate', game.zombies);
  });
});

function getPlayersHealthState(game) {
  const obj = {};
  for (const id in game.players) {
    const p = game.players[id];
    obj[id] = { health: p.health, alive: p.alive, x: p.x, y: p.y, pseudo: p.pseudo };
  }
  return obj;
}

const zombieAttackCooldown = 350;
const lastZombieAttackPerGame = {};

function movePlayers(game, deltaTime) {
  for (const pid in game.players) {
    const p = game.players[pid];
    if (!p.alive) continue;
    if (!p.moveDir) p.moveDir = {x:0, y:0};
    // PATCH: BOT MOVE
    if (p.isBot) {
      // IA simple : aller vers le zombie le plus proche, sinon errer
      let closestZombie = null, minDist = Infinity;
      for (const zid in game.zombies) {
        const z = game.zombies[zid];
        const dx = z.x - p.x;
        const dy = z.y - p.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < minDist) {
          minDist = dist;
          closestZombie = z;
        }
      }
      // S'il y a un zombie, avancer vers lui et tirer
      if (closestZombie) {
        const dx = closestZombie.x - p.x;
        const dy = closestZombie.y - p.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist > 28) {
          p.moveDir = {x: dx/dist, y: dy/dist};
        } else {
          p.moveDir = {x: 0, y: 0};
        }
        // BOT TIRE
        if (!p.lastShot || Date.now() - p.lastShot > SHOOT_INTERVAL) {
          const bulletId = `bot_${pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
          game.bullets[bulletId] = {
            id: bulletId,
            owner: pid,
            x: p.x,
            y: p.y,
            dx: dx/dist,
            dy: dy/dist,
            createdAt: Date.now()
          };
          p.lastShot = Date.now();
        }
      } else {
        // Aucun zombie, déplacement aléatoire (errance)
        if (!p._wander || Date.now() - p._wander.t > 1500) {
          const angle = Math.random() * Math.PI * 2;
          p._wander = { x: Math.cos(angle), y: Math.sin(angle), t: Date.now() };
        }
        p.moveDir = {x: p._wander.x, y: p._wander.y};
      }
    }
    let len = Math.sqrt(p.moveDir.x*p.moveDir.x + p.moveDir.y*p.moveDir.y);
    if (len > 0) {
      let move = PLAYER_SPEED_PER_SEC * deltaTime;
      let dx = p.moveDir.x / len * move;
      let dy = p.moveDir.y / len * move;
      let nx = p.x + dx, ny = p.y + dy;
      if (!isCollision(game.map, nx, ny)) {
        p.x = nx;
        p.y = ny;
      }
    }
  }
}

function moveZombies(game, deltaTime) {
  // ... inchangé
  const now = Date.now();
  const zombieList = Object.entries(game.zombies);
  const nextPos = {};
  for (const [id, z] of zombieList) {
    let closestPlayer = null, closestDist = Infinity, closestPid = null;
    for (const pid in game.players) {
      const p = game.players[pid];
      if (!p.alive) continue;
      const dx = p.x - z.x;
      const dy = p.y - z.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) {
        closestDist = dist;
        closestPlayer = p;
        closestPid = pid;
      }
    }
    if (!closestPlayer) { nextPos[id] = { x: z.x, y: z.y }; continue; }
    if (entitiesCollide(z.x, z.y, ZOMBIE_RADIUS, closestPlayer.x, closestPlayer.y, PLAYER_RADIUS, 3)) {
      const key = id + ':' + closestPid + ':' + game.id;
      if (!lastZombieAttackPerGame[key] || now - lastZombieAttackPerGame[key] > zombieAttackCooldown) {
        closestPlayer.health -= 10;
        lastZombieAttackPerGame[key] = now;
        if (closestPlayer.health <= 0) {
          closestPlayer.health = 0;
          closestPlayer.alive = false;
          io.to(closestPid).emit('youDied', {
            kills: closestPlayer.kills,
            round: game.currentRound
          });
          io.to('lobby' + game.id).emit('playersHealthUpdate', getPlayersHealthState(game));
        }
        io.to(closestPid).emit('healthUpdate', closestPlayer.health);
        io.to('lobby' + game.id).emit('playersHealthUpdate', getPlayersHealthState(game));
      }
      nextPos[id] = { x: z.x, y: z.y };
      continue;
    }
    let canGoDirect = true;
    let steps = Math.ceil(closestDist / 6);
    for (let s = 1; s < steps; s++) {
      let tx = z.x + (closestPlayer.x - z.x) * (s / steps);
      let ty = z.y + (closestPlayer.y - z.y) * (s / steps);
      if (isCollision(game.map, tx, ty)) {
        canGoDirect = false;
        break;
      }
    }
    const speed = z.speed || 40;
    let nx = z.x, ny = z.y;
    if (canGoDirect) {
      const dx = closestPlayer.x - z.x;
      const dy = closestPlayer.y - z.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 1) {
        nx += (dx / dist) * speed * deltaTime;
        ny += (dy / dist) * speed * deltaTime;
      }
    } else {
      const path = findPath(game, z.x, z.y, closestPlayer.x, closestPlayer.y);
      if (path && path.length > 1) {
        const nextNode = path[1];
        const targetX = nextNode.x * TILE_SIZE + TILE_SIZE / 2;
        const targetY = nextNode.y * TILE_SIZE + TILE_SIZE / 2;
        const dx = targetX - z.x;
        const dy = targetY - z.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 1) {
          nx += (dx / dist) * speed * deltaTime;
          ny += (dy / dist) * speed * deltaTime;
        }
      }
    }
    nextPos[id] = { x: nx, y: ny };
  }
  for (const [id, pos] of Object.entries(nextPos)) {
    let collide = false;
    if (isCollision(game.map, pos.x, pos.y)) continue;
    if (!collide) {
      game.zombies[id].x = pos.x;
      game.zombies[id].y = pos.y;
    }
  }
}

function moveBullets(game, deltaTime) {
  for (const id in game.bullets) {
    const bullet = game.bullets[id];
    bullet.x += bullet.dx * BULLET_SPEED * deltaTime;
    bullet.y += bullet.dy * BULLET_SPEED * deltaTime;
    if (
      bullet.x < 0 || bullet.x > MAP_COLS * TILE_SIZE ||
      bullet.y < 0 || bullet.y > MAP_ROWS * TILE_SIZE ||
      isCollision(game.map, bullet.x, bullet.y)
    ) {
      delete game.bullets[id];
      continue;
    }
    for (const zid in game.zombies) {
      const z = game.zombies[zid];
      if (entitiesCollide(z.x, z.y, ZOMBIE_RADIUS, bullet.x, bullet.y, 4)) {
        z.hp -= BULLET_DAMAGE;
        if (z.hp <= 0) {
          if (game.players[bullet.owner]) {
            game.players[bullet.owner].kills = (game.players[bullet.owner].kills || 0) + 1;
            io.to(bullet.owner).emit('killsUpdate', game.players[bullet.owner].kills);
          }
          delete game.zombies[zid];
        }
        delete game.bullets[id];
        break;
      }
    }
  }
}

function checkGameEnd(game) {
  const allDead = Object.values(game.players).filter(p=>p.alive).length === 0;
  if (allDead && game.lobby.started) {
    console.log(`---- Partie terminée, vague atteinte : ${game.currentRound}`);
    game.lobby.started = false;
    stopSpawning(game);
    setTimeout(() => {
      game.lobby.players = {};
      broadcastLobby(game);
    }, 3000);
  }
}

function gameLoop() {
  for (const game of activeGames) {
    if (!game.lobby.started) continue;
    const deltaTime = 1 / 30;
    movePlayers(game, deltaTime);
    moveZombies(game, deltaTime);
    moveBullets(game, deltaTime);
    io.to('lobby' + game.id).emit('zombiesUpdate', game.zombies);
    io.to('lobby' + game.id).emit('bulletsUpdate', game.bullets);
    io.to('lobby' + game.id).emit('currentRound', game.currentRound);
    io.to('lobby' + game.id).emit('playersHealthUpdate', getPlayersHealthState(game));
    checkGameEnd(game);
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
