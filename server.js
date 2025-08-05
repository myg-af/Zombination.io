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

// PATCH : max joueurs = 8
const MAX_PLAYERS = 8;
const LOBBY_TIME = 30 * 1000; // 30 sec
const MAX_ACTIVE_ZOMBIES = 150;

// Système de parties multiples
let activeGames = [];
let nextGameId = 1;

// Pour générer des pseudos BOT
function getBotPseudo(i) {
  return `[BOT${i}]`;
}

// Pour savoir si un id est un bot (côté serveur)
function isBotId(id) {
  return typeof id === "string" && id.startsWith("BOT-");
}

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
    bots: [], // liste d'ids bots (pour gestion)
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

// Spawner joueur ou bot autour du centre
function spawnPlayersNearCenter(game, pseudosArr, socketsArr) {
  const centerX = (MAP_COLS / 2) * TILE_SIZE;
  const centerY = (MAP_ROWS / 2) * TILE_SIZE;
  const angleStep = (2 * Math.PI) / Math.max(1, pseudosArr.length);
  const radius = 60 + pseudosArr.length * 8;
  const usedPos = [];

  for (let i = 0; i < pseudosArr.length; i++) {
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
    const pseudo = pseudosArr[i];
    const sid = socketsArr[i];
    game.players[sid] = {
      x: spawnX, y: spawnY,
      lastShot: 0, alive: true, health: 100, kills: 0, pseudo,
      isBot: isBotId(sid), // PATCH: identifie si c'est un bot
      botBrain: isBotId(sid) ? {
        aimTarget: null, movingBack: false, moveDir: {x:0,y:0}
      } : null
    };
  }
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

// Pour le pathfinding bots (zombie ou cible)
function findPath(game, startX, startY, endX, endY) {
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
const SHOOT_INTERVAL = 500;
const BULLET_SPEED = 600;
const BULLET_DAMAGE = 5;

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

// PATCH : Pseudo uniquement lettres/chiffres (front + back)
function isValidPseudo(str) {
  return typeof str === "string" && /^[A-Za-z0-9]{1,15}$/.test(str);
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
    // PATCH : bloque pseudo interdit
    if (!isValidPseudo(pseudo)) {
      socket.emit('pseudoInvalid');
      return;
    }
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

  socket.on('playerMovement', position => {
    if (!game.lobby.started) return;
    const player = game.players[socket.id];
    if (player && player.alive) {
      const oldX = player.x, oldY = player.y;
      if (isCollision(game.map, position.x, position.y)) return;
      if (isDiagonalBlocked(game.map, oldX, oldY, position.x, position.y)) return;
      // PATCH : plus de collision entre joueurs
      // (on garde collision avec zombies !)
      for (const zid in game.zombies) {
        const z = game.zombies[zid];
        if (entitiesCollide(position.x, position.y, PLAYER_RADIUS, z.x, z.y, ZOMBIE_RADIUS)) return;
      }
      player.x = position.x;
      player.y = position.y;
      io.to('lobby' + game.id).emit('playerMoved', { id: socket.id, x: position.x, y: position.y });
      io.to('lobby' + game.id).emit('playersHealthUpdate', getPlayersHealthState(game));
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

  // Commande temporaire : tuer tous les zombies (uniquement si pseudo = 'Myg')
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

// PATCH : Ajout des bots au lancement de partie, avec IA qui cible uniquement les zombies !
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
  // PATCH: Ajout de bots pour compléter à MAX_PLAYERS
  const botsNeeded = Math.max(0, MAX_PLAYERS - pseudosArr.length);
  game.bots = []; // stocker les ids bots pour les faire jouer en IA
  for (let i = 0; i < botsNeeded; i++) {
    const botId = "BOT-" + (i+1);
    game.bots.push(botId);
    pseudosArr.push(getBotPseudo(i+1));
    socketsArr.push(botId);
  }
  // Spawn TOUS les joueurs (réels + bots) sur la map
  spawnPlayersNearCenter(game, pseudosArr, socketsArr);

  io.to('lobby' + game.id).emit('gameStarted', { map: game.map, players: game.players, round: game.currentRound });

  startSpawning(game);

  // LOG : début partie + nombre joueurs
  console.log(`==== Partie lancée (#${game.id}) | ${pseudosArr.length} joueurs/bots ====`);
}

// PATCH: Fin de partie (partie terminée = tous morts)
function endGame(game) {
  // Cherche la vague atteinte
  const waveReached = game.currentRound;
  // LOG
  console.log(`---- Partie #${game.id} terminée | vague atteinte : ${waveReached} ----`);
}

// PATCH : IA bots côté serveur, appelée dans gameLoop
function botsThink(game, deltaTime) {
  for (const botId of (game.bots || [])) {
    const bot = game.players[botId];
    if (!bot || !bot.alive) continue;

    // Trouver le zombie le plus proche
    let closestZombie = null, closestDist = Infinity, zid = null;
    for (const id in game.zombies) {
      const z = game.zombies[id];
      const dx = z.x - bot.x;
      const dy = z.y - bot.y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist < closestDist) {
        closestDist = dist;
        closestZombie = z;
        zid = id;
      }
    }
    if (!closestZombie) continue; // rien à faire si pas de zombies

    // Comportement : s'approche ou fuit si trop proche
    let moveX = bot.x, moveY = bot.y;
    let angle = Math.atan2(closestZombie.y - bot.y, closestZombie.x - bot.x);
    const speed = 60; // Vitesse bot joueur

    // Si trop près du zombie (<60px), recule
    if (closestDist < 60) {
      moveX -= Math.cos(angle) * speed * deltaTime;
      moveY -= Math.sin(angle) * speed * deltaTime;
    } else {
      // Sinon avance vers le zombie
      moveX += Math.cos(angle) * speed * deltaTime;
      moveY += Math.sin(angle) * speed * deltaTime;
    }
    // Collision map
    if (!isCollision(game.map, moveX, moveY)) {
      bot.x = moveX;
      bot.y = moveY;
    }

    // Tirer SEULEMENT si zombie dans la ligne de vue (pas de mur entre bot et zombie)
    let canShoot = true;
    const steps = Math.ceil(closestDist / 8);
    for (let s = 1; s < steps; s++) {
      let tx = bot.x + (closestZombie.x - bot.x) * (s / steps);
      let ty = bot.y + (closestZombie.y - bot.y) * (s / steps);
      if (isCollision(game.map, tx, ty)) {
        canShoot = false;
        break;
      }
    }
    // Vérifie cooldown
    const now = Date.now();
    if (canShoot && now - bot.lastShot >= SHOOT_INTERVAL) {
      bot.lastShot = now;
      // Le bot "tire" sur le zombie
      const dx = closestZombie.x - bot.x;
      const dy = closestZombie.y - bot.y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist > 1) {
        const bulletId = `${botId}_${now}_${Math.floor(Math.random() * 100000)}`;
        game.bullets[bulletId] = {
          id: bulletId,
          owner: botId,
          x: bot.x,
          y: bot.y,
          dx: dx / dist,
          dy: dy / dist,
          createdAt: now
        };
      }
    }
  }
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
  // PATCH : plus de log de spawn de zombies
}

function checkWaveEnd(game) {
  // Fin de partie si tous les joueurs ET bots sont morts !
  const allDead = Object.values(game.players).every(p => !p.alive);
  if (allDead) {
    endGame(game);
    // On reset la partie dans le lobby
    game.lobby.started = false;
    return;
  }
  if (game.zombiesSpawnedThisWave >= game.totalZombiesToSpawn && Object.keys(game.zombies).length === 0) {
    game.currentRound++;
    game.zombiesSpawnedThisWave = 0;
    game.totalZombiesToSpawn = Math.ceil(game.totalZombiesToSpawn * 1.2);
    io.to('lobby' + game.id).emit('waveMessage', `Vague ${game.currentRound}`);
    io.to('lobby' + game.id).emit('currentRound', game.currentRound);  // <-- Important !
    console.log(`Starting wave ${game.currentRound}, total zombies to spawn: ${game.totalZombiesToSpawn}`);
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

function moveZombies(game, deltaTime) {
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
    // PATCH : plus de collision avec les autres joueurs (déjà retiré)
    for (const pid in game.players) {
      const p = game.players[pid];
      if (p.alive && entitiesCollide(pos.x, pos.y, ZOMBIE_RADIUS, p.x, p.y, PLAYER_RADIUS)) {
        collide = true;
        break;
      }
    }
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

function gameLoop() {
  for (const game of activeGames) {
    if (!game.lobby.started) continue;
    const deltaTime = 1 / 30;
    // PATCH : IA bots à chaque frame
    botsThink(game, deltaTime);
    moveZombies(game, deltaTime);
    moveBullets(game, deltaTime);
    io.to('lobby' + game.id).emit('zombiesUpdate', game.zombies);
    io.to('lobby' + game.id).emit('bulletsUpdate', game.bullets);
    io.to('lobby' + game.id).emit('currentRound', game.currentRound);
    io.to('lobby' + game.id).emit('playersHealthUpdate', getPlayersHealthState(game));
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

