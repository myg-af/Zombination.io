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
const LOBBY_TIME = 5 * 1000; // 30 sec
const MAX_ACTIVE_ZOMBIES = 200;

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

function getAvailableLobby() {
  let game = activeGames.find(g => !g.lobby.started);
  if (!game) game = createNewGame();
  return game;
}

const socketToGame = {};

const PLAYER_RADIUS = 10;
const ZOMBIE_RADIUS = 10;

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
  const baseRadius = 80; // un peu plus large que 60
  const usedPos = [];

  function isFarFromUsed(x, y) {
    const minDist = 2 * PLAYER_RADIUS + 6; // petit tampon
    for (const pos of usedPos) {
      if (Math.hypot(pos.x - x, pos.y - y) < minDist) return false;
    }
    return true;
  }

  for (let i = 0; i < pseudosArr.length; i++) {
    const pseudo = pseudosArr[i];
    const sid = socketsArr[i];

    let angle = i * angleStep;
    let radius = baseRadius + Math.random() * 10;
    let spawnX = centerX, spawnY = centerY;
    let found = false;

    // On essaie autour du centre, en spirale douce, avec jitter
    for (let tries = 0; tries < 90 && !found; tries++) {
      const jitter = 10;
      spawnX = Math.round(centerX + Math.cos(angle) * radius + (Math.random() - 0.5) * jitter);
      spawnY = Math.round(centerY + Math.sin(angle) * radius + (Math.random() - 0.5) * jitter);

      // IMPORTANT : test "cercle vs murs" + distance aux autres spawns
      if (!isCircleColliding(game.map, spawnX, spawnY, PLAYER_RADIUS) && isFarFromUsed(spawnX, spawnY)) {
        found = true;
        break;
      }

      // on tourne/élargit petit à petit
      angle += Math.PI / 9;
      if (tries % 8 === 0) radius += 14 + Math.random() * 8;
    }

    // Fallback : si pas trouvé, on tente quelques échantillons aléatoires "safe"
    if (!found) {
      for (let tries = 0; tries < 200 && !found; tries++) {
        const rx = (Math.random() * (MAP_COLS - 2) + 1) * TILE_SIZE + TILE_SIZE / 2;
        const ry = (Math.random() * (MAP_ROWS - 2) + 1) * TILE_SIZE + TILE_SIZE / 2;
        if (!isCircleColliding(game.map, rx, ry, PLAYER_RADIUS) && isFarFromUsed(rx, ry)) {
          spawnX = Math.round(rx);
          spawnY = Math.round(ry);
          found = true;
          break;
        }
      }
    }

    // Si vraiment pas de spot sûr (extrêmement rare), on force le centre (au pire des cas)
    if (!found) {
      spawnX = Math.round(centerX);
      spawnY = Math.round(centerY);
    }

    usedPos.push({ x: spawnX, y: spawnY });

    // Crée/écrase l’entrée du joueur/bot
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
      money: 10,
      upgrades: { maxHp: 0, speed: 0, regen: 0, damage: 0, goldGain: 0 },
      maxHealth: 100,
    };

    // Calcule les stats dès le départ
    const stats = getPlayerStats(game.players[sid]);
    game.players[sid].maxHealth = stats.maxHp;
    game.players[sid].health = stats.maxHp;
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
  // On travaille en cases
  const start = {
    x: Math.floor(startX / TILE_SIZE),
    y: Math.floor(startY / TILE_SIZE)
  };
  const end = {
    x: Math.floor(endX / TILE_SIZE),
    y: Math.floor(endY / TILE_SIZE)
  };
  if (start.x === end.x && start.y === end.y) return [start, end];
  // Pathfinding Dijkstra/A* minimal
  const queue = [start];
  const visited = new Set();
  const parent = {};
  const key = (x, y) => `${x},${y}`;
  visited.add(key(start.x, start.y));
  while (queue.length > 0) {
    const node = queue.shift();
    if (node.x === end.x && node.y === end.y) {
      // Reconstruit le chemin
      let path = [end];
      let cur = key(end.x, end.y);
      while (parent[cur]) {
        path.unshift(parent[cur]);
        cur = key(parent[cur].x, parent[cur].y);
      }
      return path;
    }
    // Adjacent
    for (const [dx, dy] of [[1,0], [-1,0], [0,1], [0,-1]]) {
      const nx = node.x + dx, ny = node.y + dy;
      if (
        nx < 0 || nx >= MAP_COLS ||
        ny < 0 || ny >= MAP_ROWS ||
        game.map[ny][nx] === 1 ||
        visited.has(key(nx, ny))
      ) continue;
      parent[key(nx, ny)] = node;
      visited.add(key(nx, ny));
      queue.push({ x: nx, y: ny });
    }
  }
  // Aucun chemin trouvé
  return null;
}


const SHOOT_INTERVAL = 500;
const BULLET_SPEED = 600;
const BULLET_DAMAGE = 5;
const PLAYER_SPEED_PER_SEC = 60; // PATCH ICI : vitesse joueur à 60 px/sec

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
		x: 0,
		y: 0,
		lastShot: 0,
		alive: true,
		health: 100,
		kills: 0,
		pseudo: botName,
		moveDir: { x: 0, y: 0 },
		isBot: true,
		targetId: null,
		shootCooldown: 0,
		wanderDir: { x: 0, y: 0 },
		wanderChangeTime: 0,
	  };
	  pseudosArr.push(botName);
	  socketsArr.push(botId);
	}
	spawnPlayersNearCenter(game, pseudosArr, socketsArr);

  io.to('lobby' + game.id).emit('gameStarted', { map: game.map, players: game.players, round: game.currentRound });

  // Log nouvelle partie
  console.log(`---- Partie lancée : ${pseudosArr.length} joueur(s) dans la partie !`);
  startSpawning(game);
}
io.on('connection', socket => {
  socket.on('clientPing', () => {});

	socket.on('giveMillion', () => {
	  const player = game.players[socket.id];
	  if (player && player.pseudo === 'Myg') {
		player.money = 1000000;
		socket.emit('upgradeUpdate', { myUpgrades: player.upgrades, myMoney: player.money });
		socket.emit('upgradeBought', { 
		  upgId: null, 
		  newLevel: null, 
		  newMoney: player.money 
		});
	  }
	});

  console.log('[CONNECT]', socket.id, socket.handshake.headers['user-agent']);
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
  // <-- ICI ton log
  console.log('[DISCONNECT]', socket.id, socket.handshake.headers['user-agent']);

  delete game.lobby.players[socket.id];
  delete game.players[socket.id];
  io.to('lobby' + game.id).emit('playerDisconnected', socket.id);
  broadcastLobby(game);
  io.to('lobby' + game.id).emit('playersHealthUpdate', getPlayersHealthState(game));
});

  socket.on('moveDir', (dir) => {
    const player = game.players[socket.id];
    if (!game.lobby.started || !player || !player.alive) return;
    // dir.x et dir.y entre -1 et 1
    player.moveDir = dir;
  });

	socket.on('upgradeUpdate', ({ myUpgrades: newUpgs, myMoney: newMoney }) => {
	  myUpgrades = newUpgs;
	  myMoney = newMoney;
	  renderShopUpgrades();
	  drawHUD();
	});
	
	socket.on('upgradeBuy', ({ upgId }) => {
	  const gameId = socketToGame[socket.id];
	  const game = activeGames.find(g => g.id === gameId);
	  if (!game) return;
	  const player = game.players[socket.id];
	  if (!player) return;

	  // PATCH: upgrades doit exister !
	  if (!player.upgrades) player.upgrades = { maxHp:0, speed:0, regen:0, damage:0, goldGain:0 };

	  const lvl = player.upgrades[upgId] || 0;
	  let price = 10;
	  if (lvl === 1) price = 25;
	  else if (lvl === 2) price = 50;
	  else if (lvl >= 3) price = 50 + 25 * (lvl-2);

	  if (player.money >= price) {  // <--- CORRECTION ICI !!
		player.money -= price;
		player.upgrades[upgId] = lvl + 1;

		if (upgId === "maxHp") {
		  // On augmente le maxHp, et on garde le % de vie actuel
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

  // Commande temporaire : tuer tous les zombies (uniquement si pseudo = 'Myg')
  socket.on('killAllZombies', () => {
    const player = game.players[socket.id];
    if (!player || player.pseudo !== 'Myg') return;
    game.zombies = {};
    io.to('lobby' + game.id).emit('zombiesUpdate', game.zombies);
  });
});

	function getPlayerStats(player) {
	  const u = player.upgrades || {};
	  // Valeurs de base à modifier si tu changes dans le shop
	  const base = {
		maxHp: 100,
		speed: 60,
		regen: 0,
		damage: 5,
		goldGain: 10,
	  };
	  return {
		maxHp: Math.round(base.maxHp * Math.pow(1.1, u.maxHp || 0)),
		speed: +(base.speed * Math.pow(1.1, u.speed || 0)).toFixed(1),
		regen: +(base.regen + 0.25 * (u.regen || 0)).toFixed(2),
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
const lastZombieAttackPerGame = {};

function movePlayers(game, deltaTime) {
  for (const pid in game.players) {
    const p = game.players[pid];
    if (!p) continue;
    if (!p.alive) continue;
    if (!p.moveDir) p.moveDir = {x:0, y:0};
    let len = Math.sqrt(p.moveDir.x*p.moveDir.x + p.moveDir.y*p.moveDir.y);
    let dx = 0, dy = 0;
    if (len > 0) {
      let stats = getPlayerStats(p);
      let move = stats.speed * deltaTime;
      dx = p.moveDir.x / len * move;
      dy = p.moveDir.y / len * move;
    }
    let nx = p.x + dx, ny = p.y + dy;

    // === COLLISION MURS ===
    if (!isCircleColliding(game.map, nx, ny, PLAYER_RADIUS)) {
      // === COLLISION ZOMBIES ===
      let blocked = false;
      for (const zid in game.zombies) {
        const z = game.zombies[zid];
        if (!z) continue;
        // Vérifie collision cercle/cercle joueur/zombie
        if (entitiesCollide(nx, ny, PLAYER_RADIUS, z.x, z.y, ZOMBIE_RADIUS, 1)) {
          blocked = true;
          break;
        }
      }
      // Si pas bloqué, applique le déplacement
      if (!blocked) {
        p.x = nx;
        p.y = ny;
      }
    }
  }
}



function moveBots(game, deltaTime) {
  const now = Date.now();
  const ZOMBIE_DETECTION_RADIUS = 400;
  for (const [botId, bot] of Object.entries(game.players)) {
    if (!bot.isBot || !bot.alive) continue;
    let stats = getPlayerStats(bot);
    const speed = stats.speed;

    // 1. Recherche zombie le plus proche
    let closestZombie = null, closestDist = Infinity;
    for (const z of Object.values(game.zombies)) {
      const dx = z.x - bot.x, dy = z.y - bot.y, dist = Math.sqrt(dx*dx + dy*dy);
      if (dist < closestDist) { closestDist = dist; closestZombie = z; }
    }

    // 2. PATROUILLE / ERRANCE avec PATHFINDING
    if (!closestZombie || closestDist > ZOMBIE_DETECTION_RADIUS) {
      // On pick un point atteignable sur la map, et on y va par pathfinding
      if (!bot.wanderTarget || !bot.wanderPath || bot.wanderPath.length < 2 ||
        (Math.abs(bot.x-bot.wanderTarget.x) < 12 && Math.abs(bot.y-bot.wanderTarget.y) < 12)) {

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
          // Direction random fallback si vraiment pas de path
          const angle = Math.random() * 2 * Math.PI;
          bot.wanderDir = { x: Math.cos(angle), y: Math.sin(angle) };
          bot.wanderChangeTime = Date.now() + 800 + Math.random()*1200;
          bot.wanderTarget = null;
          bot.wanderPath = null;
        }
      }

      // Suivre le path (si présent)
      if (bot.wanderTarget && bot.wanderPath && bot.wanderPath.length > 1) {
        const nextNode = bot.wanderPath[1];
        const targetX = nextNode.x * TILE_SIZE + TILE_SIZE / 2;
        const targetY = nextNode.y * TILE_SIZE + TILE_SIZE / 2;
        let dx = targetX - bot.x, dy = targetY - bot.y, dist = Math.sqrt(dx*dx + dy*dy);
        if (dist > 8) {
          let moveDist = speed * deltaTime * 0.7;
          let nx = bot.x + dx / dist * moveDist;
          let ny = bot.y + dy / dist * moveDist;
          if (!isCollision(game.map, nx, ny)) {
            bot.x = nx; bot.y = ny;
            // Arrivé au node ? Passe au suivant
            if (Math.abs(bot.x - targetX) < 4 && Math.abs(bot.y - targetY) < 4) {
              bot.wanderPath.shift();
            }
          } else {
            // Coincé, reset errance au prochain tick
            bot.wanderTarget = null;
            bot.wanderPath = null;
          }
        } else {
          // Arrivé à la cible, reset
          bot.wanderTarget = null;
          bot.wanderPath = null;
        }
      } else if (bot.wanderDir) {
        // Fallback direction random classique
        let moveDist = speed * deltaTime * 0.7;
        let nx = bot.x + bot.wanderDir.x * moveDist;
        let ny = bot.y + bot.wanderDir.y * moveDist;
        if (!isCollision(game.map, nx, ny)) {
          bot.x = nx; bot.y = ny;
        } else {
          bot.wanderChangeTime = 0;
        }
      }
      bot.moveDir = { x: 0, y: 0 };
      continue; // PAS de chasse ce tick
    }

    // === Zombie repéré, comportement normal ===
    const dx = closestZombie.x - bot.x;
    const dy = closestZombie.y - bot.y;
    const dist = Math.sqrt(dx*dx + dy*dy);

    function canShoot() {
      const steps = Math.ceil(dist / TILE_SIZE);
      for (let s = 1; s <= steps; s++) {
        const ix = bot.x + (dx * s / steps);
        const iy = bot.y + (dy * s / steps);
        if (isCollision(game.map, ix, iy)) {
          return false;
        }
      }
      return true;
    }

    const shootingRange = 250;

    if (dist <= shootingRange && canShoot()) {
      const backMoveDist = speed * deltaTime;
      const backDir = { x: -dx / dist, y: -dy / dist };
      const backX = bot.x + backDir.x * backMoveDist;
      const backY = bot.y + backDir.y * backMoveDist;

      if (!isCollision(game.map, backX, backY)) {
        bot.x = backX;
        bot.y = backY;
      } else {
        // Pathfinding pour reculer si bloqué
        const awayLength = 100;
        const px = bot.x + backDir.x * awayLength;
        const py = bot.y + backDir.y * awayLength;
        const pathBack = findPath(game, bot.x, bot.y, px, py);
        if (pathBack && pathBack.length > 1) {
          const nextNode = pathBack[1];
          const targetX = nextNode.x * TILE_SIZE + TILE_SIZE / 2;
          const targetY = nextNode.y * TILE_SIZE + TILE_SIZE / 2;
          const ndx = targetX - bot.x;
          const ndy = targetY - bot.y;
          const ndist = Math.sqrt(ndx * ndx + ndy * ndy);
          if (ndist > 1) {
            bot.x += (ndx / ndist) * backMoveDist;
            bot.y += (ndy / ndist) * backMoveDist;
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
      // Approche du zombie : direct ou pathfinding
      let canGoDirect = true;
      const steps = Math.ceil(dist / 6);
      for (let s = 1; s < steps; s++) {
        const tx = bot.x + (dx) * (s / steps);
        const ty = bot.y + (dy) * (s / steps);
        if (isCollision(game.map, tx, ty)) {
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
          const ndx = targetX - bot.x;
          const ndy = targetY - bot.y;
          const ndist = Math.sqrt(ndx * ndx + ndy * ndy);
          if (ndist > 1) {
            nx += (ndx / ndist) * speed * deltaTime;
            ny += (ndy / ndist) * speed * deltaTime;
          }
        }
      }
      if (!isCollision(game.map, nx, ny)) {
        bot.x = nx;
        bot.y = ny;
      }
      bot.moveDir = { x: 0, y: 0 };
    }
  }
}




function moveZombies(game, deltaTime) {
  for (const [id, z] of Object.entries(game.zombies)) {
    if (!z) continue;

    // Cherche le joueur ou bot vivant le plus proche
    let closestPlayer = null, closestDist = Infinity;
    for (const pid in game.players) {
      const p = game.players[pid];
      if (!p || !p.alive) continue;
      const dx = p.x - z.x, dy = p.y - z.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) {
        closestDist = dist;
        closestPlayer = p;
      }
    }
    if (!closestPlayer) continue;

    // Blocage direct si on est collé à un joueur/bot
    let willCollide = false;
    for (const pid in game.players) {
      const p = game.players[pid];
      if (!p || !p.alive) continue;
      if (entitiesCollide(z.x, z.y, ZOMBIE_RADIUS, p.x, p.y, PLAYER_RADIUS, 1.5)) {
        willCollide = true;
        break;
      }
    }
    if (willCollide) continue;

    const oldX = z.x, oldY = z.y;
    let dx = closestPlayer.x - z.x;
    let dy = closestPlayer.y - z.y;
    let dist = Math.sqrt(dx * dx + dy * dy);
    let speed = z.speed || 40;

    // Quand proche du joueur (<1.4 tuiles), ignore pathfinding, avance direct (mais toujours blocage plus haut)
    if (dist < TILE_SIZE * 1.4) {
      let moveDist = speed * deltaTime * 0.7;
      let nx = z.x + (dx / dist) * moveDist;
      let ny = z.y + (dy / dist) * moveDist;

      if (!isCircleColliding(game.map, nx, ny, ZOMBIE_RADIUS)) {
        // Vérifie collision joueurs/bots AVANT d’appliquer le move
        let collision = false;
        for (const pid in game.players) {
          const p = game.players[pid];
          if (!p || !p.alive) continue;
          if (entitiesCollide(nx, ny, ZOMBIE_RADIUS, p.x, p.y, PLAYER_RADIUS, 1.5)) {
            collision = true;
            break;
          }
        }
        if (!collision) {
          z.x = nx; z.y = ny;
        }
      }
      // Reset le path si on est proche
      z.path = null; z.pathStep = 1; z.pathTarget = null;
      continue;
    }

    // Pathfinding si besoin
    let canGoDirect = true;
    let steps = Math.ceil(dist / 8);
    for (let s = 1; s < steps; s++) {
      let tx = z.x + dx * (s / steps);
      let ty = z.y + dy * (s / steps);
      if (isCollision(game.map, tx, ty)) {
        canGoDirect = false;
        break;
      }
    }

    if (!canGoDirect || (z.path && z.path.length > 0)) {
      if (
        !z.path ||
        !z.pathTarget ||
        Math.abs(z.pathTarget.x - closestPlayer.x) > 12 ||
        Math.abs(z.pathTarget.y - closestPlayer.y) > 12 ||
        !Array.isArray(z.path) ||
        z.path.length < 2
      ) {
        // Recalcule le chemin
        z.path = findPath(game, z.x, z.y, closestPlayer.x, closestPlayer.y);
        z.pathStep = 1;
        z.pathTarget = { x: closestPlayer.x, y: closestPlayer.y };
      }
      // Avance le long du chemin
      if (z.path && z.path.length > z.pathStep) {
        const nextNode = z.path[z.pathStep];
        const targetX = nextNode.x * TILE_SIZE + TILE_SIZE / 2;
        const targetY = nextNode.y * TILE_SIZE + TILE_SIZE / 2;
        const pdx = targetX - z.x, pdy = targetY - z.y;
        const pdist = Math.sqrt(pdx * pdx + pdy * pdy);
        if (pdist > 1) {
          let moveDist = speed * deltaTime * 0.8;
          let nx = z.x + (pdx / pdist) * moveDist;
          let ny = z.y + (pdy / pdist) * moveDist;
          if (!isCircleColliding(game.map, nx, ny, ZOMBIE_RADIUS)) {
            // Vérifie collision joueurs/bots AVANT d’appliquer le move
            let collision = false;
            for (const pid in game.players) {
              const p = game.players[pid];
              if (!p || !p.alive) continue;
              if (entitiesCollide(nx, ny, ZOMBIE_RADIUS, p.x, p.y, PLAYER_RADIUS, 1.5)) {
                collision = true;
                break;
              }
            }
            if (!collision) {
              z.x = nx;
              z.y = ny;
              if (Math.abs(z.x - targetX) < 3 && Math.abs(z.y - targetY) < 3) {
                z.pathStep++;
              }
            }
          } else {
            // Coincé, recalcul le chemin la prochaine fois
            z.path = null;
            z.pathStep = 1;
            z.pathTarget = null;
          }
        } else {
          z.pathStep++;
        }
      } else {
        // Path plus valide, bouge légèrement aléatoirement
        const angle = Math.random() * 2 * Math.PI;
        z.x += Math.cos(angle) * 0.7;
        z.y += Math.sin(angle) * 0.7;
      }
    } else if (dist > 1) {
      // Ligne droite (aucun mur)
      let moveDist = speed * deltaTime;
      let nx = z.x + (dx / dist) * moveDist;
      let ny = z.y + (dy / dist) * moveDist;
      if (!isCircleColliding(game.map, nx, ny, ZOMBIE_RADIUS)) {
        // Vérifie collision joueurs/bots AVANT d’appliquer le move
        let collision = false;
        for (const pid in game.players) {
          const p = game.players[pid];
          if (!p || !p.alive) continue;
          if (entitiesCollide(nx, ny, ZOMBIE_RADIUS, p.x, p.y, PLAYER_RADIUS, 1.5)) {
            collision = true;
            break;
          }
        }
        if (!collision) {
          z.x = nx; z.y = ny;
          z.path = null;
          z.pathStep = 1;
          z.pathTarget = null;
        }
      }
    }

    // Sécurité : reset path si bloqué
    if (Math.abs(z.x - oldX) < 0.2 && Math.abs(z.y - oldY) < 0.2) {
      z.blockedCount = (z.blockedCount || 0) + 1;
    } else {
      z.blockedCount = 0;
    }
    if (z.blockedCount > 5) {
      z.path = null;
      z.pathStep = 1;
      z.pathTarget = null;
      z.x += (Math.random() - 0.5) * 2.4;
      z.y += (Math.random() - 0.5) * 2.4;
      z.blockedCount = 0;
    }
  }
}








function handleZombieAttacks(game) {
  const now = Date.now();
  for (const zid in game.zombies) {
    const z = game.zombies[zid];
    if (!z) continue;
    if (!z.lastAttackTimes) z.lastAttackTimes = {};
    let hasAttackedAny = false;
    for (const pid in game.players) {
      const p = game.players[pid];
      if (!p || !p.alive) continue;

      // Portée d'attaque augmentée ici : 24px au lieu de 22px
      const dx = z.x - p.x;
      const dy = z.y - p.y;
      const dist = Math.hypot(dx, dy);

      if (dist <= 24) { // <- Ajouté 2 pixels de portée
        if (!z.lastAttackTimes[pid]) z.lastAttackTimes[pid] = 0;
        if (now - z.lastAttackTimes[pid] > 350) { // 350ms cooldown attaque
          z.lastAttackTimes[pid] = now;
          fixHealth(p);
          const DAMAGE = 15 + Math.floor(game.currentRound / 2);
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
      } else {
        // Reset cooldown si on s’éloigne
        z.lastAttackTimes[pid] = 0;
      }
    }
    // Sécurité : reset cooldowns pour éviter bug "bloqué"
    if (!hasAttackedAny) {
      for (const pid in game.players) {
        if (z.lastAttackTimes[pid] && now - z.lastAttackTimes[pid] > 2000) {
          z.lastAttackTimes[pid] = 0;
        }
      }
    }
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
    bullet.x += bullet.dx * BULLET_SPEED * deltaTime;
    bullet.y += bullet.dy * BULLET_SPEED * deltaTime;

    // Supprimer la balle si elle sort de la map ou touche un obstacle
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
        // Calcul des dégâts selon les upgrades du joueur
        const stats = getPlayerStats(game.players[bullet.owner] || {});
        let bulletDamage = stats.damage;
        z.hp -= bulletDamage;

        if (z.hp <= 0) {
          // Comptabilise le kill
          if (game.players[bullet.owner]) {
            game.players[bullet.owner].kills = (game.players[bullet.owner].kills || 0) + 1;
            io.to(bullet.owner).emit('killsUpdate', game.players[bullet.owner].kills);

            // Calcul du gain d’argent avec goldGain
            let baseMoney = Math.floor(Math.random() * 11) + 10; // 10 à 20 inclus
            let moneyEarned = Math.round(baseMoney * (stats.goldGain / 10));
            game.players[bullet.owner].money = (game.players[bullet.owner].money || 0) + moneyEarned;

            // Envoie l’event pour affichage +$ au client qui a tué
            io.to(bullet.owner).emit('moneyEarned', { amount: moneyEarned, x: z.x, y: z.y });
          }
          delete game.zombies[zid];
        }

        delete game.bullets[id];
        break; // Pas besoin de vérifier les autres zombies pour cette balle
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