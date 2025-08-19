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
const compression = require('compression');

const gameMapModule = require('./game/gameMap');

const app = express();
app.use(compression());
const server = http.createServer(app);
const io = socketIo(server, {
  pingInterval: 10000,
  pingTimeout: 60000,
  perMessageDeflate: { threshold: 1024 }, // compresse les gros payloads
  transports: ['websocket'],
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

const MAX_PLAYERS = 6;
const LOBBY_TIME = 5 * 1000;
const MAX_ACTIVE_ZOMBIES = 200;
const MAX_ZOMBIES_PER_WAVE = 500;

// --- Shop constants envoyées au client ---
const SHOP_CONST = {
  base: { maxHp: 100, speed: 40, regen: 0, damage: 10, goldGain: 10 },
  regenPerLevel: 1,                 // 1 PV/sec/niveau
  priceTiers: [10, 25, 50, 75, 100],// niv 1..5
  priceStepAfterTier: 75            // après niv 5 → +50/niv
};

// --- Prix d'achat des structures (serveur autoritatif) ---
const SHOP_BUILD_PRICES = {
  T: 1000, // Tourelle
  t: 250,  // Mini-tourelle
  G: 5000, // Big-tourelle
  B: 100,  // Mur
  D: 200   // Porte
};


function getUpgradePrice(nextLevel) {
  const tiers = SHOP_CONST.priceTiers;
  const step = SHOP_CONST.priceStepAfterTier;
  if (nextLevel <= tiers.length) return tiers[nextLevel - 1];
  if (nextLevel <= 7) return tiers[tiers.length - 1] + (nextLevel - tiers.length) * step;
  const priceAt7 = tiers[tiers.length - 1] + (7 - tiers.length) * step;
  const k = nextLevel - 7;
  return Math.round(priceAt7 * Math.pow(1.2, k));
}

let activeGames = [];
let nextGameId = 1;

function createNewGame() {
  let game = {
    structures: null,
    id: nextGameId++,
    lobby: { players: {}, timeLeft: LOBBY_TIME / 1000, started: false, timer: null, manual: false, hostId: null },
    players: {},
    bots: {},
    zombies: {},
    bullets: {},
    currentRound: 1,
    totalZombiesToSpawn: MAX_ZOMBIES_PER_WAVE,
    zombiesSpawnedThisWave: 0,
    zombiesKilledThisWave: 0,
    map: null,
    spawnInterval: null,
    spawningActive: false,

    // Throttle réseau par joueur
    _lastNetSend: {},

    // ---- Compteurs O(1) ----
    _zombieCount: 0,
    _bulletCount: 0,
    _turretCount: 0
  };
  game.map = createEmptyMap(MAP_ROWS, MAP_COLS);
  placeObstacles(game.map, OBSTACLE_COUNT);
  activeGames.push(game);
  return game;
}



function buildCentralEnclosure(game, spacingTiles = 1) {
  // Taille fixe 11x11 (bords inclus)
  const HALF = 5; // car 2*5 + 1 = 11

  // 1) Init grille des structures si besoin
  game.structures = Array.from({ length: MAP_ROWS }, () =>
    Array.from({ length: MAP_COLS }, () => null)
  );

  // 2) Centre de la carte en indices de tuile
  const cR = Math.floor(MAP_ROWS / 2);
  const cC = Math.floor(MAP_COLS / 2);

  // 3) Bornes du carré 11x11, clamp pour rester dans la map
  let r0 = Math.max(1, cR - HALF);
  let r1 = Math.min(MAP_ROWS - 2, cR + HALF);
  let c0 = Math.max(1, cC - HALF);
  let c1 = Math.min(MAP_COLS - 2, cC + HALF);

  // Sécurité : si la carte est trop petite on sort
  if (r1 - r0 !== 10 || c1 - c0 !== 10) return;

  // 4) Murs barricades autour du carré (épaisseur 1 case)
  for (let c = c0; c <= c1; c++) {
    setStruct(game, c, r0, { type: 'B', hp: 500 });
    setStruct(game, c, r1, { type: 'B', hp: 500 });
  }
  for (let r = r0; r <= r1; r++) {
    setStruct(game, c0, r, { type: 'B', hp: 500 });
    setStruct(game, c1, r, { type: 'B', hp: 500 });
  }

  // 5) Portes au milieu de chaque côté (HP = 200)
  const midC = Math.floor((c0 + c1) / 2);
  const midR = Math.floor((r0 + r1) / 2);
  setStruct(game, midC, r0, { type: 'D', hp: 500 });
  setStruct(game, midC, r1, { type: 'D', hp: 500 });
  setStruct(game, c0, midR, { type: 'D', hp: 500 });
  setStruct(game, c1, midR, { type: 'D', hp: 500 });

  // 6) Grande tourelle au centre (HP = 500)
  setStruct(game, midC, midR, { type: 'T', hp: 500, lastShot: 0 });

  // 7) Mini-tourelles : décalage fixe de 2 cases depuis les coins internes
  const inset = 2;
  const miniPositions = [
    { tx: c0 + inset, ty: r0 + inset }, // haut-gauche
    { tx: c1 - inset, ty: r0 + inset }, // haut-droit
    { tx: c0 + inset, ty: r1 - inset }, // bas-gauche
    { tx: c1 - inset, ty: r1 - inset }, // bas-droit
  ];
  for (const pos of miniPositions) {
    setStruct(game, pos.tx, pos.ty, { type: 't', hp: 200, lastShot: 0 });
  }
}




function cleanupEmptyManualLobbies() {
  // Remove manual lobbies with no players and not started
  activeGames = activeGames.filter(g => {
    const count = g && g.lobby && g.lobby.players ? Object.keys(g.lobby.players).length : 0;
    return !(g.lobby && g.lobby.manual && !g.lobby.started && count === 0);
  });
}

function getAvailableLobby() {
  let game = activeGames.find(g => !g.lobby.started);
  if (!game) game = createNewGame();
  return game;
}



function getAvailableAutoLobby() {
  // Returns a NON-manual, NOT-started lobby; creates a fresh one if needed.
  let g = activeGames.find(g => g && g.lobby && !g.lobby.manual && !g.lobby.started && Object.keys(g.lobby.players||{}).length < MAX_PLAYERS);
  if (!g) g = createNewGame();
  return g;
}

const socketToGame = {};

const PLAYER_RADIUS = 10;
const ZOMBIE_RADIUS = 10;
// === Interest management (zone de vue par joueur) ===
const SERVER_VIEW_RADIUS = 1000; // rayon en px (monde) pour ce qu'on ENVOIE à chaque client
const BUILD_VIEW_RADIUS = 420; // rayon de halo autorisant le placement
const SERVER_VIEW_RADIUS_SQ = SERVER_VIEW_RADIUS * SERVER_VIEW_RADIUS;

function getPlayersHealthStateFiltered(game, cx, cy, r) {
  const r2 = r * r;
  const out = {};
  for (const id in game.players) {
    const p = game.players[id];
    if (!p) continue;
    const dx = (p.x || 0) - cx;
    const dy = (p.y || 0) - cy;
    if (dx*dx + dy*dy <= r2) {
      fixHealth(p);
      out[id] = {
        health: p.health,
        alive: p.alive,
        x: p.x,
        y: p.y,
        pseudo: p.pseudo,
        money: p.money,
        maxHealth: p.maxHealth || getPlayerStats(p).maxHp,
      };
    }
  }
  return out;
}

function getZombiesFiltered(game, cx, cy, r) {
  const r2 = r * r;
  const out = {};
  for (const zid in game.zombies) {
    const z = game.zombies[zid];
    if (!z) continue;
    const dx = z.x - cx, dy = z.y - cy;
    if (dx*dx + dy*dy <= r2) out[zid] = z;
  }
  return out;
}

function getBulletsFiltered(game, cx, cy, r) {
  const r2 = r * r;
  const out = {};
  for (const bid in game.bullets) {
    const b = game.bullets[bid];
    if (!b) continue;
    const dx = b.x - cx, dy = b.y - cy;
    if (dx*dx + dy*dy <= r2) out[bid] = b;
  }
  return out;
}



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

  // Compteur de tourelles en cache (évite de scanner la grille à chaque tick)
  if (typeof game._turretCount !== 'number') game._turretCount = 0;

  const prev = game.structures[ty][tx];
  const prevIsTurret = !!(prev && (prev.type === 'T' || prev.type === 't' || prev.type === 'G') && prev.hp > 0);
  const nextIsTurret = !!(s && (s.type === 'T' || s.type === 't' || s.type === 'G') && s.hp > 0);

  if (prevIsTurret && !nextIsTurret) game._turretCount = Math.max(0, game._turretCount - 1);
  if (!prevIsTurret && nextIsTurret) game._turretCount++;

  
  /* COOLDOWN_ON_DESTROY */
  if (prev && (!s || (s && s.hp<=0)) && (prev.type==='t' || prev.type==='T' || prev.type==='G')) {
    const ownerId = prev.placedBy;
    if (ownerId && game.players[ownerId]) {
      const p = game.players[ownerId];
      p.turretDestroyedAt = p.turretDestroyedAt || {};
      p.turretDestroyedAt[prev.type] = Date.now();
      try { io.to(ownerId).emit('turretCooldown', { type: prev.type, until: p.turretDestroyedAt[prev.type] + 60000 }); } catch(e){}
    }
  }
game.structures[ty][tx] = s;
}


function canPlaceStructureAt(game, tx, ty, buyerId) {
  if (!game || !game.map) return false;
  if (ty < 0 || ty >= MAP_ROWS || tx < 0 || tx >= MAP_COLS) return false;

  // 1) pas un mur de la map
  if (game.map[ty][tx] === 1) return false;

  // 2) pas de structure existante
  const existing = getStruct(game, tx, ty);
  if (existing) return false;

  
  // 2bis) doit être dans le halo de visibilité de l'acheteur
  if (buyerId && game.players && game.players[buyerId]) {
    const p = game.players[buyerId];
    const px = (tx + 0.5) * TILE_SIZE;
    const py = (ty + 0.5) * TILE_SIZE;
    const dx = p.x - px, dy = p.y - py;
    const r2 = BUILD_VIEW_RADIUS * BUILD_VIEW_RADIUS;
    if ((dx*dx + dy*dy) > r2) return false;
  } else if (buyerId) {
    return false; // si acheteur inconnu, refuse par sécurité
  }
// 3) aucun joueur/BOT dont le CERCLE touche la tuile (y compris l'acheteur)
  //    (avant on ne testait que la tuile du centre du joueur → pouvait coincer)
  for (const [pid, p] of Object.entries(game.players)) {
    if (!p || !p.alive) continue;
    // Empêche la pose si le disque du joueur chevauche le rectangle [tx,ty]
    if (circleIntersectsTile(p.x, p.y, PLAYER_RADIUS, tx, ty)) return false;
  }

  // 4) aucun zombie dont le CERCLE touche la tuile
  for (const z of Object.values(game.zombies)) {
    if (!z) continue;
    if (circleIntersectsTile(z.x, z.y, ZOMBIE_RADIUS, tx, ty)) return false;
  }

  return true;
}



function isSolidForPlayer(struct) {
  // Joueurs traversent les portes, mais PAS barricades ni tourelles (grandes ou mini)
  return struct && (
    (struct.type === 'B' || struct.type === 'T' || struct.type === 't' || struct.type === 'G') && struct.hp > 0
  );
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

// Variante pour un joueur précis : ignore la tuile de grâce (p.graceTile) si définie
function circleBlockedByStructuresForPlayer(game, x, y, radius, player) {
  const points = 8;

  // Helper: teste si (tx,ty) est la tuile de grâce du joueur
  function isGrace(tx, ty) {
    return !!(player && player.graceTile && player.graceTile.tx === tx && player.graceTile.ty === ty);
  }

  // échantillonnage du cercle
  for (let a = 0; a < points; a++) {
    const ang = (2 * Math.PI * a) / points;
    const px = x + Math.cos(ang) * radius;
    const py = y + Math.sin(ang) * radius;
    const { tx, ty } = worldToTile(px, py);
    const s = getStruct(game, tx, ty);
    if (!isGrace(tx, ty) && isSolidForPlayer(s)) return true;
  }
  // centre
  const { tx, ty } = worldToTile(x, y);
  const s = getStruct(game, tx, ty);
  if (!isGrace(tx, ty) && isSolidForPlayer(s)) return true;

  return false;
}

function tickTurrets(game) {
  if (!game?.structures) return;
  const now = Date.now();

  let shotsLeft = TURRET_SHOTS_PER_TICK;
  const laserBatch = [];
  const zombiesMap = game.zombies;

  outer_loop:
  for (let ty = 0; ty < MAP_ROWS; ty++) {
    for (let tx = 0; tx < MAP_COLS; tx++) {
      const s = getStruct(game, tx, ty);
      if (!s || (s.type !== 'T' && s.type !== 't' && s.type !== 'G') || s.hp <= 0) continue;

      if (!s.lastShot) s.lastShot = 0;
      const interval = (s.type === 't') ? MINI_TURRET_SHOOT_INTERVAL : (s.type === 'G' ? BIG_TURRET_SHOOT_INTERVAL : TURRET_SHOOT_INTERVAL);

      if (typeof s._jitterCur !== 'number') s._jitterCur = (Math.random() - 0.5) * TURRET_JITTER_MS;
      if ((now - s.lastShot) < (interval + s._jitterCur)) continue;

      const cx = tx * TILE_SIZE + TILE_SIZE / 2;
      const cy = ty * TILE_SIZE + TILE_SIZE / 2;

      // Cache cible
      let target = null;
      if (s._targetId) {
        const z = zombiesMap[s._targetId];
        if (z) {
          const dx = z.x - cx, dy = z.y - cy;
          const d2 = dx*dx + dy*dy;
          if (d2 <= TURRET_RANGE_SQ && !losBlockedForTurret(game, cx, cy, z.x, z.y) && z.hp > 0) {
            target = z;
          }
        }
      }

      if (!target) {
        if (!s._nextRetargetAt || now >= s._nextRetargetAt) {
          s._nextRetargetAt = now + TURRET_RETARGET_MS;
          let best = null, bestDist2 = Infinity;
          for (const zid in zombiesMap) {
            const z = zombiesMap[zid];
            if (!z) continue;
            const dx = z.x - cx, dy = z.y - cy;
            const d2 = dx*dx + dy*dy;
            if (d2 > TURRET_RANGE_SQ) continue;
            if (d2 < bestDist2 && !losBlockedForTurret(game, cx, cy, z.x, z.y)) {
              bestDist2 = d2; best = z;
              if (bestDist2 < 64*64) break;
            }
          }
          if (best) {
            target = best;
            s._targetId = Object.keys(zombiesMap).find(id => zombiesMap[id] === best) || null;
          } else {
            s._targetId = null;
          }
        } else {
          continue;
        }
      }

      if (!target) continue;
      if (shotsLeft <= 0) break outer_loop;

      shotsLeft--;
      s.lastShot = now;
      s._jitterCur = (Math.random() - 0.5) * TURRET_JITTER_MS;

      let baseDmg = (s.type === 't') ? 10 : (s.type === 'T' ? 20 : (s.type === 'G' ? 50 : 5));
      // Upgrades bonus per owner: sum of geometric series (+10% per level on the added amount)
      let bonus = 0;
      if (s.placedBy && game.players[s.placedBy]) {
        const up = game.players[s.placedBy].turretUpgrades || {};
        const lvl = (s.type === 't') ? (up['t']||0) : (s.type === 'T' ? (up['T']||0) : (up['G']||0));
        if (lvl > 0) {
          const baseAdd = (s.type === 't') ? 10 : (s.type === 'T' ? 20 : 50);
          // sum_{i=0..lvl-1} baseAdd * 1.1^i
          bonus = baseAdd * (Math.pow(1.1, lvl) - 1) / 0.1;
        }
      }
      const dmg = Math.round(baseDmg + bonus);
      target.hp -= dmg;

      laserBatch.push({ x0: cx, y0: cy, x1: target.x, y1: target.y, color: (s.type === 'G') ? '#c9a9ff' : ((s.type === 'T') ? '#ff3b3b' : '#3aa6ff') });

      if (target.hp <= 0) {
        // gains propriétaire inchangés...
        if (s.placedBy) {
          const ownerPlayer = game.players[s.placedBy];
          if (ownerPlayer) {
            const ownerStats = getPlayerStats(ownerPlayer);
            const baseMoney = Math.floor(Math.random() * 11) + 10;
            const moneyEarned = Math.round(baseMoney * ((ownerStats.goldGain || 10) / 10));
            ownerPlayer.money = (ownerPlayer.money || 0) + moneyEarned;
            io.to(s.placedBy).emit('moneyEarned', { amount: moneyEarned, x: target.x, y: target.y });
            ownerPlayer.kills = (ownerPlayer.kills || 0) + 1;
            io.to(s.placedBy).emit('killsUpdate', ownerPlayer.kills);
          }
        }

        game.zombiesKilledThisWave = (game.zombiesKilledThisWave || 0) + 1;
        const remaining = Math.max(0, (game.totalZombiesToSpawn || 0) - game.zombiesKilledThisWave);
        io.to('lobby' + game.id).emit('zombiesRemaining', remaining);

        // suppression zombie + décrément O(1)
        for (const zid in zombiesMap) {
          if (zombiesMap[zid] === target) {
            delete zombiesMap[zid];
            game._zombieCount = Math.max(0, game._zombieCount - 1);
            if (s._targetId === zid) s._targetId = null;
            break;
          }
        }
      }
    }
  }

  if (laserBatch.length > 0) {
    io.to('lobby' + game.id).emit(TURRET_LASER_BATCH_EVENT, laserBatch);
  }
}


function losBlockedForZombie(game, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return false;

  // Pas d'échantillonnage plus fin et surtout test "cercle" (rayon zombie)
  // pour empêcher les tentatives de passage en diagonale entre 2 blocs.
  const stepLen = Math.max(4, Math.min(8, TILE_SIZE / 3)); // ~4..8 px
  const steps = Math.ceil(dist / stepLen);

  for (let s = 1; s < steps; s++) {
    const ix = x0 + (dx * s / steps);
    const iy = y0 + (dy * s / steps);

    // Mur de la MAP (avec rayon)
    if (isCircleColliding(game.map, ix, iy, ZOMBIE_RADIUS)) return true;

    // Structures solides pour zombies (barricades, portes, tourelles) avec rayon
    if (circleBlockedByStructures(game, ix, iy, ZOMBIE_RADIUS, isSolidForZombie)) return true;
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


// Remplace TOUT le corps de isCircleColliding par ceci (dans server.js)
function isCircleColliding(map, x, y, radius) {
  // Balayage intelligent : on ne teste que les tuiles qui peuvent toucher le cercle
  const minTx = Math.max(0, Math.floor((x - radius) / TILE_SIZE));
  const maxTx = Math.min(MAP_COLS - 1, Math.floor((x + radius) / TILE_SIZE));
  const minTy = Math.max(0, Math.floor((y - radius) / TILE_SIZE));
  const maxTy = Math.min(MAP_ROWS - 1, Math.floor((y + radius) / TILE_SIZE));

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (map[ty][tx] === 1) {
        // Test précis cercle-vs-tuile (empêche de “couper les coins”)
        if (circleIntersectsTile(x, y, radius, tx, ty)) return true;
      }
    }
  }
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
    
      spectator: false,
      viewX: null,
      viewY: null,
      _lastSpectateMoveAt: 0,
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
const TURRET_SHOOT_INTERVAL = 1000;
const MINI_TURRET_SHOOT_INTERVAL = 2000;
const BIG_TURRET_SHOOT_INTERVAL = 500;
const TURRET_RANGE = 500;
const TURRET_RANGE_SQ = TURRET_RANGE * TURRET_RANGE;
// --- Anti-burst tourelles ---
// Décalage aléatoire de cadence par tir, centré sur 0 (moyenne nulle) → ne change pas le DPS moyen
const TURRET_JITTER_MS = 120;              // ex. ±120 ms par tir

// Nombre maximum de tirs de tourelles autorisés par "stepOnce" (un tick physique)
const TURRET_SHOTS_PER_TICK = 8;           // ajuste si besoin (ex. 6..12 selon charge)

// Événement de batch pour les lasers (un tableau de segments)
const TURRET_LASER_BATCH_EVENT = 'laserBeams';
const PATHFIND_BUDGET_PER_TICK = 12;     // nb max de findPath autorisés / tick (ajuste 8..20)
const TURRET_RETARGET_MS = 120;          // une tourelle ne re-choisit pas une cible + souvent que ça

// ---- PATHFINDING ADAPTATIF PAR TICK ----
// Retourne le nombre d'appels findPath autorisés ce tick pour UNE partie.
function computePathfindBudget(game) {
  if (!game.lobby.started) return 0;
  const z = game._zombieCount || 0;
  const t = game._turretCount || 0;
  const b = game._bulletCount || 0;

  // Base plus généreuse quand peu d'ennemis, plus stricte quand ça charge
  // 0 → 50 zombies : 12
  // 51 → 150 zombies : 8
  // >150 zombies : 6
  let base = 12;
  if (z > 150) base = 6;
  else if (z > 50) base = 8;

  // Petite correction si vraiment calme (pas de bullets, pas de spawn)
  const calmish = (z === 0 && b === 0 && !game.spawningActive && t === 0);
  if (calmish) return 0;

  return base;
}


const NET_SEND_HZ = 30;
const NET_INTERVAL_MS = Math.floor(1000 / NET_SEND_HZ);

// --- Modes basse consommation ---
const NET_INTERVAL_IDLE_MS = 250;    // envoi réseau plus rare quand calme
const CALM_TICK_HZ = 10;            // tick serveur si partie(s) calmes (pas d'IA/tourelles/bullets)
const EMPTY_TICK_HZ = 2;            // tick serveur si aucune partie en cours

// Timestamp du dernier tick pour cadence adaptative
let _lastTickAtMs = 0;


const TICK_HZ = 60;
const FIXED_DT = 1 / TICK_HZ;     // 16.666... ms
const MAX_STEPS = 5;              // anti-spirale si gros retard
// Budget courant de pathfinding pour CE tick (réinitialisé dans stepOnce)
let PF_BUDGET_THIS_TICK = 0;

let lastTime = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
let accumulator = 0;


function broadcastLobby(game) {
  io.to('lobby' + game.id).emit('lobbyUpdate', {
    id: game.id,
    players: game.lobby.players,
    count: Object.keys(game.lobby.players).length,
    max: MAX_PLAYERS,
    timeLeft: game.lobby.timeLeft,
    started: game.lobby.started,
    manual: !!(game.lobby && game.lobby.manual),
    hostId: (game.lobby && game.lobby.hostId) || null,
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
  if (game.totalZombiesToSpawn > MAX_ZOMBIES_PER_WAVE) game.totalZombiesToSpawn = MAX_ZOMBIES_PER_WAVE;

  if (game.zombiesSpawnedThisWave >= game.totalZombiesToSpawn) return;
  if (game._zombieCount >= MAX_ACTIVE_ZOMBIES) return;

	const hp = Math.round(10 * Math.pow(1.15, game.currentRound - 1));
  const baseSpeed = 40;
  const speedIncreasePercent = 0.05;
  const speed = baseSpeed * (1 + speedIncreasePercent * (game.currentRound - 1));

  let spawnedCount = 0;
  for (let i = 0; i < count; i++) {
    if (game.zombiesSpawnedThisWave >= game.totalZombiesToSpawn) break;
    if (game._zombieCount >= MAX_ACTIVE_ZOMBIES) break;

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
    game._zombieCount++;                 // O(1)
    game.zombiesSpawnedThisWave++;
    spawnedCount++;
  }
}

function checkWaveEnd(game) {
  if (game.zombiesSpawnedThisWave >= game.totalZombiesToSpawn && game._zombieCount === 0) {
    game.currentRound++;
    game.zombiesSpawnedThisWave = 0;
    game.zombiesKilledThisWave = 0;
    const _nextTotal = Math.ceil(Math.min(game.totalZombiesToSpawn, MAX_ZOMBIES_PER_WAVE) * 1.2);
    game.totalZombiesToSpawn = Math.min(_nextTotal, MAX_ZOMBIES_PER_WAVE);
    io.to('lobby' + game.id).emit('waveMessage', `Vague ${game.currentRound}`);
    io.to('lobby' + game.id).emit('currentRound', game.currentRound);
    io.to('lobby' + game.id).emit('waveStarted', { totalZombies: game.totalZombiesToSpawn });
    io.to('lobby' + game.id).emit('zombiesRemaining', game.totalZombiesToSpawn);

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

  // compteurs O(1)
  game._zombieCount = 0;
  game._bulletCount = 0;
  game._turretCount = 0;

  game.currentRound = 1;
  game.totalZombiesToSpawn = Math.min(50, MAX_ZOMBIES_PER_WAVE);
  game.zombiesSpawnedThisWave = 0;
  game.zombiesKilledThisWave = 0;
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

  // (re)construire l’enceinte centrale
  
  // --- Ensure only ready sockets stay in the room before starting ---
  try {
    const room = io.sockets.adapter.rooms.get('lobby' + game.id);
    const keepSet = new Set(socketsArr.filter(id => io.sockets.sockets.has(id)));
    const members = room ? Array.from(room) : [];
    for (const sid of members) {
      if (keepSet.has(sid)) continue;
      const sock = io.sockets.sockets.get(sid);
      if (!sock) continue;
      try { if (game.lobby && game.lobby.players) delete game.lobby.players[sid]; } catch(_){}
      try { sock.leave('lobby' + game.id); } catch(_) {}
      let target = activeGames.find(g => g && g.lobby && !g.lobby.manual && !g.lobby.started && g.id !== game.id && Object.keys(g.lobby.players||{}).length < MAX_PLAYERS);
      if (!target) target = createNewGame();
      socketToGame[sid] = target.id;
      sock.join('lobby' + target.id);
      broadcastLobby(target);
    }
    broadcastLobby(game);
  } catch(e) { console.error('[launchGame] evac non-ready error', e); }

  buildCentralEnclosure(game, 1);

  spawnPlayersNearCenter(game, pseudosArr, socketsArr);

  io.to('lobby' + game.id).emit('gameStarted', {
    map: game.map,
    players: game.players,
    round: game.currentRound,
    structures: game.structures,
    structurePrices: SHOP_BUILD_PRICES
  });

  io.to('lobby' + game.id).emit('waveStarted', { totalZombies: game.totalZombiesToSpawn });
  io.to('lobby' + game.id).emit('zombiesRemaining', game.totalZombiesToSpawn);

  console.log(`---- Partie lancée : ${pseudosArr.length} joueur(s) dans la partie !`);
  startSpawning(game);
 // --- Reset du temps pour éviter l'accélération initiale après le lobby ---
lastTime = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
accumulator = 0;
_lastTickAtMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
}




io.on('connection', socket => {

  // Ultra-aggressive: host cleanup BEFORE disconnect completes
  socket.on('disconnecting', () => {
    try {
      const mappedId = socketToGame[socket.id];
      let game = activeGames.find(g => g && g.id === mappedId) || null;
      if (!game) {
        game = activeGames.find(g => g && g.lobby && g.lobby.manual && !g.lobby.started && g.lobby.hostId === socket.id) || null;
      }
      if (game && game.lobby && game.lobby.manual && !game.lobby.started && game.lobby.hostId === socket.id) {
        // Notify all clients in the lobby and force them out
        try { io.to('lobby' + game.id).emit('lobbyClosed'); io.to('lobby' + game.id).emit('forceReload'); } catch (_) {}
        const room = io.sockets.adapter.rooms.get('lobby' + game.id);
        const ids = room ? Array.from(room) : [];
        for (const cid of ids) {
          try {
            if (cid !== socket.id) {
              const s = io.sockets.sockets.get(cid);
              if (s) { try { s.leave('lobby' + game.id); } catch(_){} }
              if (game.lobby && game.lobby.players) delete game.lobby.players[cid];
              if (game.players && game.players[cid]) delete game.players[cid];
              if (game._lastNetSend) delete game._lastNetSend[cid];
              try { delete socketToGame[cid]; } catch (_) {}
            }
          } catch (_){}
        }
        try { if (game.lobby && game.lobby.timer) { clearInterval(game.lobby.timer); game.lobby.timer = null; } } catch (_){}
        try { activeGames = activeGames.filter(g => g && g.id !== game.id); } catch (_){}
      }
    } catch (e) {
      console.error('[disconnecting host cleanup] error', e);
    }
  });

  console.log('[CONNECT]', socket.id, socket.handshake.headers['user-agent']);

  // Attache tout de suite le joueur à un lobby pour avoir "game" dispo
  const game = getAvailableLobby();
  socketToGame[socket.id] = game.id;
  socket.join('lobby' + game.id);

  socket.on('clientPing', () => {});

  socket.emit('lobbyUpdate', {
    id: game.id,
    players: game.lobby.players,
    count: Object.keys(game.lobby.players).length,
    max: MAX_PLAYERS,
    timeLeft: game.lobby.timeLeft,
    started: game.lobby.started,
  });

  // ====== Manual lobby system (create/join/start) ======
  socket.on('createLobby', (pseudo, cb) => {
    // Sanitize pseudo and create a fresh manual lobby with this socket as host
    pseudo = (pseudo || '').trim().substring(0, 15).replace(/[^a-zA-Z0-9]/g, '');
    if (!pseudo) { if (cb) cb({ ok:false, reason:'invalid_pseudo' }); return; }
    const oldGameId = socketToGame[socket.id];
    const oldGame = activeGames.find(g => g.id === oldGameId);

    const newGame = createNewGame();
    newGame.lobby.manual = true;
    newGame.lobby.hostId = socket.id;
    newGame.lobby.players[socket.id] = { pseudo, ready: true };

    // Move socket room + mapping
    if (oldGame) { try { socket.leave('lobby' + oldGame.id); } catch(_){} }
    socketToGame[socket.id] = newGame.id;
    socket.join('lobby' + newGame.id);

    broadcastLobby(newGame);
    if (cb) cb({ ok:true, gameId:newGame.id });
  });

  socket.on('requestLobbies', () => {
    cleanupEmptyManualLobbies();
    const list = activeGames
      .filter(g => g.lobby && g.lobby.manual && !g.lobby.started && Object.keys(g.lobby.players||{}).length > 0)
      .map(g => ({
        id: g.id,
        hostId: g.lobby.hostId || null,
        players: Object.values(g.lobby.players || {}).map(p => p.pseudo).slice(0, MAX_PLAYERS),
        count: Object.keys(g.lobby.players || {}).length,
        max: MAX_PLAYERS
      }));
    io.to(socket.id).emit('lobbiesList', list);
  });

  socket.on('joinLobbyById', (data, cb) => {
    const targetId = data && data.gameId;
    let pseudo = (data && data.pseudo) || '';
    pseudo = (pseudo || '').trim().substring(0, 15).replace(/[^a-zA-Z0-9]/g, '');
    if (!pseudo) { if (cb) cb({ ok:false, reason:'invalid_pseudo' }); return; }
    const target = activeGames.find(g => g.id === targetId);
    if (!target || !target.lobby.manual || target.lobby.started) { if (cb) cb({ ok:false, reason:'not_joinable' }); return; }
    const count = Object.keys(target.lobby.players||{}).length;
    if (count >= MAX_PLAYERS) { if (cb) cb({ ok:false, reason:'full' }); return; }

    const currentId = socketToGame[socket.id];
    const current = activeGames.find(g => g.id === currentId);
    if (current) {
      // Remove from previous lobby if present
      delete current.lobby.players[socket.id];
      try { socket.leave('lobby' + current.id); } catch(_) {}
      broadcastLobby(current);
    }

    socketToGame[socket.id] = target.id;
    socket.join('lobby' + target.id);
    target.lobby.players[socket.id] = { pseudo, ready: true };
    broadcastLobby(target);
    if (cb) cb({ ok:true, gameId: target.id });
  });

  
socket.on('startManualLobby', (cb) => {
    const gid = socketToGame[socket.id];
    const game = activeGames.find(g => g.id === gid);
    if (!game || !game.lobby || !game.lobby.manual) { if (cb) cb({ ok:false }); return; }
    if (game.lobby.hostId !== socket.id) { if (cb) cb({ ok:false, reason:'not_host' }); return; }
    if (game.lobby.started) { if (cb) cb({ ok:false, reason:'already_started' }); return; }
    const readyPlayers = Object.entries(game.lobby.players || {});
    if (readyPlayers.length === 0) { if (cb) cb({ ok:false, reason:'no_players' }); return; }
    game.lobby.started = true;
    if (game.lobby.timer) { clearInterval(game.lobby.timer); game.lobby.timer = null; }
    launchGame(game, readyPlayers);
    if (cb) cb({ ok:true });
});


socket.on('hostBackManual', (cb) => {
    const gid = socketToGame[socket.id];
    const game = activeGames.find(g => g.id === gid);
    if (!game || !game.lobby || !game.lobby.manual || game.lobby.started) { if (cb) cb({ ok:false }); return; }
    if (game.lobby.hostId !== socket.id) { if (cb) cb({ ok:false, reason:'not_host' }); return; }

    // Notify room that lobby is closed and force everyone out
    try { io.to('lobby' + game.id).emit('lobbyClosed'); io.to('lobby' + game.id).emit('forceReload'); } catch(_){}

    const room = io.sockets.adapter.rooms.get('lobby' + game.id);
    const cids = room ? Array.from(room) : [];
    for (const cid of cids) {
      try {
        const sock = io.sockets.sockets.get(cid);
        if (sock) { try { sock.leave('lobby' + game.id); } catch(_){} }
        if (game.lobby && game.lobby.players) delete game.lobby.players[cid];
        if (game.players && game.players[cid]) delete game.players[cid];
        if (game._lastNetSend) delete game._lastNetSend[cid];
        try { delete socketToGame[cid]; } catch (_){}
      } catch(_){}
    }
    try { if (game.lobby && game.lobby.timer) { clearInterval(game.lobby.timer); game.lobby.timer = null; } } catch (_){}
    // Remove game entirely
    activeGames = activeGames.filter(g => g !== game);
    if (cb) cb({ ok:true });
});

// --- Turret upgrades (t/T/G) ---
socket.on('upgradeTurret', ({ type }) => {
  try {
    console.log('[upgradeTurret] recv', { sid: socket.id, type });
    const gameId = socketToGame[socket.id];
    const game = activeGames.find(g => g.id === gameId);
    if (!game) { console.log('[upgradeTurret] no game'); return; }
    if (!['t','T','G'].includes(type)) { console.log('[upgradeTurret] invalid type', type); return; }
    const player = game.players[socket.id];
    if (!player) { console.log('[upgradeTurret] no player'); return; }
    player.turretUpgrades = player.turretUpgrades || {};
    const current = player.turretUpgrades[type] || 0;
    const basePrice = (type === 't') ? 500 : (type === 'T' ? 2000 : 5000);
    const growth = (type === 'G') ? 1.20 : 1.30; // G 20%, others 30%
    const price = Math.round(basePrice * Math.pow(growth, current));
    if ((player.money||0) < price) {
      console.log('[upgradeTurret] not enough money', { have: player.money, need: price });
      socket.emit('upgradeTurretResult', { ok:false, reason:'not_enough_money' });
      return;
    }
    player.money -= price;
    player.turretUpgrades[type] = current + 1;
    console.log('[upgradeTurret] OK', { type, newLevel: player.turretUpgrades[type], newMoney: player.money });
    socket.emit('upgradeTurretResult', { ok:true, type, level: player.turretUpgrades[type], newMoney: player.money });
  } catch(e) {
    console.error('[upgradeTurret] error', e);
    socket.emit('upgradeTurretResult', { ok:false, reason:'server_error' });
  }
});



  socket.on('giveMillion', () => {
  const gid = socketToGame[socket.id];
  const game = activeGames.find(g => g.id === gid);
  if (!game) return;
  const player = game.players[socket.id];
  if (player && player.pseudo === 'Myg') {
    player.money = 1000000;
    socket.emit('upgradeUpdate', { myUpgrades: player.upgrades, myMoney: player.money });
  }
});


socket.on('skipRound', () => {
  const gameId = socketToGame[socket.id];
  const game = activeGames.find(g => g.id === gameId);
  if (!game) return;
  const player = game.players[socket.id];
  if (!player || player.pseudo !== 'Myg') return;
  game.zombies = {};
  game._zombieCount = 0;
  game.zombiesSpawnedThisWave = game.totalZombiesToSpawn;
  io.to('lobby' + game.id).emit('zombiesUpdate', game.zombies);
  checkWaveEnd(game);
});

  socket.on('setPseudoAndReady', (pseudo) => {
  const gameId = socketToGame[socket.id];
  const game = activeGames.find(g => g.id === gameId);
  if (!game) return;
  pseudo = (pseudo || '').trim().substring(0, 15);
  pseudo = pseudo.replace(/[^a-zA-Z0-9]/g, '');
  if (!pseudo) pseudo = 'Joueur';
  game.lobby.players[socket.id] = { pseudo, ready: true };
  broadcastLobby(game);
  if (!game.lobby.manual) {
  try {
    game.lobby.started = true;
    if (game.lobby.timer) { clearInterval(game.lobby.timer); game.lobby.timer = null; }
    // Launch immediately as SOLO: only the current player is ready
    const readyPlayers = [[socket.id, game.lobby.players[socket.id]]];
    launchGame(game, readyPlayers);
  } catch (e) {
    console.error('[setPseudoAndReady] solo start error', e);
  }
  return;
}
});

  

  socket.on('leaveLobby', () => {
    const gameId = socketToGame[socket.id];
    const game = activeGames.find(g => g.id === gameId);
    if (!game) return;
    // Remove from current lobby's players
    delete game.lobby.players[socket.id];
    broadcastLobby(game);

    // Leave the old room
    try { socket.leave('lobby' + game.id); } catch(_) {}

    // Move the socket back to an auto lobby (non-manual), so UI stays consistent
    let target = activeGames.find(g => g && g.lobby && !g.lobby.manual && !g.lobby.started && Object.keys(g.lobby.players||{}).length < MAX_PLAYERS);
    if (!target) target = getAvailableLobby();
    socketToGame[socket.id] = target.id;
    socket.join('lobby' + target.id);
    // Do not auto-mark ready; just broadcast target state
    broadcastLobby(target);

    // Cleanup manual lobbies that might have become empty
    cleanupEmptyManualLobbies();
  });


  socket.on('disconnect', () => {
  console.log('[DISCONNECT]', socket.id, socket.handshake.headers['user-agent']);

  // Try to resolve the game from mapping
  const mappedId = socketToGame[socket.id];
  let game = activeGames.find(g => g && g.id === mappedId) || null;

  // Fallback: direct lookup by hostId (covers cases where mapping was lost)
  if (!game) {
    game = activeGames.find(g => g && g.lobby && g.lobby.manual && !g.lobby.started && g.lobby.hostId === socket.id) || null;
  }

  // If the disconnecting socket is the HOST of a MANUAL lobby (not started) -> close & delete the lobby
  if (game && game.lobby && game.lobby.manual && !game.lobby.started && game.lobby.hostId === socket.id) {
    try { io.to('lobby' + game.id).emit('lobbyClosed'); } catch (_) {}

    const room = io.sockets.adapter.rooms.get('lobby' + game.id);
    const cids = room ? Array.from(room) : [];

    for (const cid of cids) {
      const sock = io.sockets.sockets.get(cid);
      if (!sock) continue;

      try {
        if (game.lobby && game.lobby.players) delete game.lobby.players[cid];
        if (game.players && game.players[cid]) delete game.players[cid];
        if (game._lastNetSend) delete game._lastNetSend[cid];
      } catch (_) {}

      try { sock.leave('lobby' + game.id); } catch (_) {}
      try { delete socketToGame[cid]; } catch (_) {}
    }

    try { if (game.lobby && game.lobby.timer) { clearInterval(game.lobby.timer); game.lobby.timer = null; } } catch (_) {}
    try { activeGames = activeGames.filter(g => g && g.id !== game.id); } catch (_) {}
    return; // done
  }

  // Default path: remove only this player from its current game/lobby if any
  if (mappedId) {
    const g = activeGames.find(x => x && x.id === mappedId);
    if (g) {
      delete g.lobby.players[socket.id];
      delete g.players[socket.id];
      if (g._lastNetSend) delete g._lastNetSend[socket.id];
      io.to('lobby' + g.id).emit('playerDisconnected', socket.id);
      broadcastLobby(g);
      io.to('lobby' + g.id).emit('playersHealthUpdate', getPlayersHealthState(g));
    }
    delete socketToGame[socket.id];
  }
});
  socket.on('moveDir', (dir) => {
  const gid = socketToGame[socket.id];
  const game = activeGames.find(g => g.id === gid);
  if (!game || !game.lobby.started) return;
  const player = game.players[socket.id];
  if (!player || !player.alive) return;
  player.moveDir = dir;
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


socket.on('buyStructure', ({ type, tx, ty }) => {
  const gameId = socketToGame[socket.id];
  const game = activeGames.find(g => g.id === gameId);
  if (!game || !game.lobby.started) {
    io.to(socket.id).emit('buildResult', { ok: false, reason: 'game_not_running' });
    return;
  }
  const player = game.players[socket.id];
  if (!player || !player.alive) {
    io.to(socket.id).emit('buildResult', { ok: false, reason: 'player_invalid' });
    return;
  }

  // Validation entrée
  if (!['T','t','G','B','D'].includes(type)) {
    io.to(socket.id).emit('buildResult', { ok: false, reason: 'invalid_type' });
    return;
  }
  if (!Number.isInteger(tx) || !Number.isInteger(ty) ||
      tx < 0 || tx >= MAP_COLS || ty < 0 || ty >= MAP_ROWS) {
    io.to(socket.id).emit('buildResult', { ok: false, reason: 'tile_blocked' });
    return;
  }

  
  // Limits and cooldowns per player
  const TURRET_LIMITS = { 't': 2, 'T': 2, 'G': 1 };
  if (!player.turretDestroyedAt) player.turretDestroyedAt = {};
  // Count turrets placed by this player
  function countTurretsByType(type) {
    let c = 0;
    for (let y=0; y<MAP_ROWS; y++) for (let x=0; x<MAP_COLS; x++) {
      const ss = getStruct(game, x, y);
      if (ss && ss.type === type && ss.placedBy === socket.id && ss.hp > 0) c++;
    }
    return c;
  }
  // Enforce cooldown after destruction
  if (type === 't' || type === 'T' || type === 'G') {
    const lim = TURRET_LIMITS[type];
    const cur = countTurretsByType(type);
    // cooldown check only if currently under limit but flagged
    const lastD = player.turretDestroyedAt[type] || 0;
    const remaining = 60000 - (Date.now() - lastD);
    if (remaining > 0 && cur < lim) {
      io.to(socket.id).emit('buildResult', { ok: false, reason: 'cooldown', ms: remaining });
      return;
    }
    if (cur >= lim) {
      io.to(socket.id).emit('buildResult', { ok: false, reason: 'limit_reached' });
      return;
    }
  }
// Prix
  const price = SHOP_BUILD_PRICES[type] || 0;
  if ((player.money || 0) < price) {
    io.to(socket.id).emit('buildResult', { ok: false, reason: 'not_enough_money' });
    return;
  }

  // Vérifs de placement sur (tx, ty)
  if (!canPlaceStructureAt(game, tx, ty, socket.id)) {
    io.to(socket.id).emit('buildResult', { ok: false, reason: 'tile_blocked' });
    return;
  }

  // Création structure
  let s = null;
  if (type === 'B') s = { type: 'B', hp: 500, placedBy: socket.id };
  if (type === 'D') s = { type: 'D', hp: 500, placedBy: socket.id };
  if (type === 'T') s = { type: 'T', hp: 500, lastShot: 0, placedBy: socket.id };
  if (type === 't') s = { type: 't', hp: 200, lastShot: 0, placedBy: socket.id };
  if (type === 'G') s = { type: 'G', hp: 2500, lastShot: 0, placedBy: socket.id };

  // Débit argent
  player.money = (player.money || 0) - price;

  // Pose
  setStruct(game, tx, ty, s);

  // Grâce de collision seulement si le joueur a posé sous lui
  const cur = worldToTile(player.x, player.y);
  if (cur.tx === tx && cur.ty === ty) {
    player.graceTile = { tx, ty };
  }

  // Broadcast
  io.to('lobby' + game.id).emit('structuresUpdate', game.structures);
  io.to(socket.id).emit('buildResult', { ok: true, type, tx, ty, newMoney: player.money });
});





socket.on('shoot', (data) => {
  const gid = socketToGame[socket.id];
  const game = activeGames.find(g => g.id === gid);
  if (!game || !game.lobby.started) return;
  const player = game.players[socket.id];
  if (!player || !player.alive) return;
  const now = Date.now();
  if (now - (player.lastShot||0) < SHOOT_INTERVAL) return;
  player.lastShot = now;
  const dx = data.targetX - player.x;
  const dy = data.targetY - player.y;
  const dist = Math.sqrt(dx*dx + dy*dy);
  if (dist < 1) return;
  const bulletId = `${socket.id}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  game.bullets[bulletId] = { id: bulletId, owner: socket.id, x: player.x, y: player.y, dx: dx / dist, dy: dy / dist, createdAt: now };
  game._bulletCount = (game._bulletCount||0) + 1;
});

socket.on('requestZombies', () => {
  const gid = socketToGame[socket.id];
  const game = activeGames.find(g => g.id === gid);
  if (!game) return;
  const p = game.players[socket.id];
  if (!p) return;
  const cx_req = (p.spectator && p.viewX != null) ? p.viewX : (p.x || 0);
  const cy_req = (p.spectator && p.viewY != null) ? p.viewY : (p.y || 0);
  const zSnap = getZombiesFiltered(game, cx_req, cy_req, SERVER_VIEW_RADIUS);
  io.to(socket.id).emit('zombiesUpdate', zSnap);
});

socket.on('playerDied', () => {
  const gid = socketToGame[socket.id];
  const game = activeGames.find(g => g.id === gid);
  if (!game) return;
  if (game.players[socket.id]) {
    game.players[socket.id].alive = false;
    io.to('lobby' + game.id).emit('playersHealthUpdate', getPlayersHealthState(game));
  }
});
  // Enter spectator mode (keeps socket alive and continues receiving updates)
  socket.on('enterSpectator', () => {
    const gameId = socketToGame[socket.id];
    const game = activeGames.find(g => g.id === gameId);
    if (!game) return;
    const p = game.players[socket.id];
    if (!p) return;
    // Only possible if game still running and player exists
    if (!game.lobby.started) return;
    p.spectator = true;
    p.viewX = (p.x || 0);
    p.viewY = (p.y || 0);
    p._lastSpectateMoveAt = Date.now();
  });

  // Spectator movement: WASD/Arrows at 500 px/s, clamped to map bounds
  socket.on('spectatorMove', (dir) => {
    const gameId = socketToGame[socket.id];
    const game = activeGames.find(g => g.id === gameId);
    if (!game) return;
    const p = game.players[socket.id];
    if (!p || !p.spectator) return;
    const now = Date.now();
    const dt = Math.min(0.25, Math.max(0, (now - (p._lastSpectateMoveAt || now)) / 1000));
    p._lastSpectateMoveAt = now;
    const speed = 500; // px/sec
    let dx = (dir && typeof dir.x === 'number') ? dir.x : 0;
    let dy = (dir && typeof dir.y === 'number') ? dir.y : 0;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) { dx /= len; dy /= len; }
    p.viewX = (p.viewX == null ? (p.x || 0) : p.viewX) + dx * speed * dt;
    p.viewY = (p.viewY == null ? (p.y || 0) : p.viewY) + dy * speed * dt;
    // Clamp to world bounds
    const worldW = MAP_COLS * TILE_SIZE;
    const worldH = MAP_ROWS * TILE_SIZE;
    if (p.viewX < 0) p.viewX = 0;
    if (p.viewY < 0) p.viewY = 0;
    if (p.viewX > worldW) p.viewX = worldW;
    if (p.viewY > worldH) p.viewY = worldH;
  });



  // Admin : tuer tous les zombies (uniquement si pseudo = 'Myg')
socket.on('killAllZombies', () => {
  const gid = socketToGame[socket.id];
  const game = activeGames.find(g => g.id === gid);
  if (!game) return;
  const player = game.players[socket.id];
  if (!player || player.pseudo !== 'Myg') return;
  game.zombies = {};
  game._zombieCount = 0;
  io.to('lobby' + game.id).emit('zombiesUpdate', game.zombies);
});

// Fallback manual-lobby host cleanup on disconnect (robustness)
socket.on('disconnect', () => {
  try {
    const ownedManuals = (activeGames || []).filter(g => g && g.lobby && g.lobby.manual && !g.lobby.started && g.lobby.hostId === socket.id);
    for (const game of ownedManuals) {
      try { io.to('lobby' + game.id).emit('lobbyClosed'); } catch (_){}
    }
  } catch (e) {
    console.error('[disconnect fallback] error', e);
  }
});
});
function getPlayerStats(player) {
  const u = player?.upgrades || {};
  const base = { maxHp: 100, speed: 40, regen: 0, damage: 10, goldGain: 10 }; // regen à 0 pour éviter la confusion
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

// ---- FIN DE PARTIE FORCÉE QUAND AUCUN JOUEUR CONNECTÉ ----
function endGame(game, reason = 'no_players') {
  if (!game.lobby.started) return;

  console.log(`---- Fin de partie (game ${game.id}) : ${reason}`);
  game.lobby.started = false;

  // arrêter le spawn
  stopSpawning(game);

  // vider entités + remettre compteurs O(1)
  game.zombies = {};
  game.bullets = {};
  game.players = {};

  game._zombieCount = 0;
  game._bulletCount = 0;
  game._turretCount = 0;

  io.to('lobby' + game.id).emit('gameEnded', { reason });
  // on nettoie le lobby un peu après (conservé)
  setTimeout(() => {
    game.lobby.players = {};
    broadcastLobby(game);
  }, 500);
}



const ATTACK_REACH_PLAYER = 26;                   // avant 24
const ATTACK_REACH_STRUCT = ZOMBIE_RADIUS + 2;    // contact (avant ~36)
const ZOMBIE_ATTACK_COOLDOWN_MS = 300;            // avant 350
const ZOMBIE_DAMAGE_BASE = 15;                                 // base dmg


function separateFromZombies(entity, game, radiusSelf = PLAYER_RADIUS) {
  // pousse doucement l’entity hors des zombies si chevauchement (spawn/lag)
  for (const z of Object.values(game.zombies)) {
    const dx = entity.x - z.x;
    const dy = entity.y - z.y;
    const d  = Math.hypot(dx, dy);
    const minD = radiusSelf + ZOMBIE_RADIUS - 0.5; // petite marge anti-jitter
    if (d > 0 && d < minD) {
      const push = (minD - d) * 0.5;               // poussée douce
      entity.x += (dx / d) * push;
      entity.y += (dy / d) * push;
    }
  }
}


function movePlayers(game, deltaTime) {
  const MAX_STEP = 6;   // px par micro-pas
  const NUDGE    = 1.6; // petit décalage anti-coin

  for (const pid in game.players) {
    const p = game.players[pid];
    if (!p || !p.alive) continue;

    const stats = getPlayerStats(p);
    const distToTravel = stats.speed * deltaTime;

    let dirX = (p.moveDir?.x || 0);
    let dirY = (p.moveDir?.y || 0);
    const len = Math.hypot(dirX, dirY);
    if (len < 1e-6) {
      // Même si le joueur ne bouge pas, on vérifie s’il a quitté la tuile de grâce.
      if (p.graceTile) {
        const { tx, ty } = worldToTile(p.x, p.y);
        if (tx !== p.graceTile.tx || ty !== p.graceTile.ty) {
          p.graceTile = null;
        }
      }
      continue;
    }
    dirX /= len; dirY /= len;

    const blockedForPlayer = (x, y) =>
      isCircleColliding(game.map, x, y, PLAYER_RADIUS) ||
      // ⚠️ tient compte d’une éventuelle tuile “grâce” pour CE joueur
      circleBlockedByStructuresForPlayer(game, x, y, PLAYER_RADIUS, p) ||
      // ne traverse PAS les zombies
      Object.values(game.zombies).some(z =>
        entitiesCollide(x, y, PLAYER_RADIUS, z.x, z.y, ZOMBIE_RADIUS, 1)
      );

    let remaining = distToTravel;
    while (remaining > 0.0001) {
      const step = Math.min(remaining, MAX_STEP);
      remaining -= step;

      let nx = p.x + dirX * step;
      let ny = p.y + dirY * step;

      if (!blockedForPlayer(nx, ny)) {
        p.x = nx; p.y = ny;
        continue;
      }

      // slide X
      nx = p.x + Math.sign(dirX) * step;
      if (!blockedForPlayer(nx, p.y)) { p.x = nx; continue; }

      // slide Y
      ny = p.y + Math.sign(dirY) * step;
      if (!blockedForPlayer(p.x, ny)) { p.y = ny; continue; }

      // anti-coin léger
      if (!blockedForPlayer(p.x + Math.sign(dirX) * NUDGE, p.y)) {
        p.x += Math.sign(dirX) * NUDGE;
      } else if (!blockedForPlayer(p.x, p.y + Math.sign(dirY) * NUDGE)) {
        p.y += Math.sign(dirY) * NUDGE;
      }
      break;
    }

    // ✅ Si le joueur a quitté la tuile de grâce, on réactive la collision définitivement
    if (p.graceTile) {
      const { tx, ty } = worldToTile(p.x, p.y);
      if (tx !== p.graceTile.tx || ty !== p.graceTile.ty) {
        p.graceTile = null;
      }
    }
  }
}



function moveBots(game, deltaTime) {
  const MAX_STEP = 6;
  const NUDGE    = 1.6;
  const now = Date.now();
  const ZOMBIE_DETECTION_RADIUS = 400;
  const shootingRange = 250;

  // ❗ Les BOTS ne traversent plus les portes : on utilise isSolidForZombie (tout struct hp>0 est solide)
  const blockedForBot = (x, y) =>
    isCircleColliding(game.map, x, y, PLAYER_RADIUS) ||
    circleBlockedByStructures(game, x, y, PLAYER_RADIUS, isSolidForZombie) ||
    Object.values(game.zombies).some(z =>
      entitiesCollide(x, y, PLAYER_RADIUS, z.x, z.y, ZOMBIE_RADIUS, 1)
    );

  const canShoot = (fromX, fromY, tx, ty) => {
    const dx = tx - fromX, dy = ty - fromY;
    const dist = Math.hypot(dx, dy);
    const steps = Math.ceil(dist / TILE_SIZE);
    for (let s = 1; s <= steps; s++) {
      const ix = fromX + dx * (s/steps);
      const iy = fromY + dy * (s/steps);
      if (isCollision(game.map, ix, iy)) return false;
    }
    return true;
  };

  for (const [botId, bot] of Object.entries(game.players)) {
    if (!bot.isBot || !bot.alive) continue;

    const stats = getPlayerStats(bot);
    const speed = stats.speed;

    // zombie le plus proche
    let closestZombie = null, closestDist = Infinity;
    for (const z of Object.values(game.zombies)) {
      const d = Math.hypot(z.x - bot.x, z.y - bot.y);
      if (d < closestDist) { closestDist = d; closestZombie = z; }
    }

    if (closestZombie && closestDist <= ZOMBIE_DETECTION_RADIUS) {
      const dx = closestZombie.x - bot.x;
      const dy = closestZombie.y - bot.y;
      const dist = Math.hypot(dx, dy);

      // kite + tir si LOS
      if (dist > 1e-6 && dist <= shootingRange && canShoot(bot.x, bot.y, closestZombie.x, closestZombie.y)) {
        let dirx = -dx / dist, diry = -dy / dist;
        let remaining = speed * deltaTime;

        while (remaining > 0.0001) {
          const step = Math.min(remaining, MAX_STEP);
          remaining -= step;

          let nx = bot.x + dirx * step, ny = bot.y + diry * step;
          if (!blockedForBot(nx, ny)) { bot.x = nx; bot.y = ny; }
          else {
            nx = bot.x + Math.sign(dirx) * step;
            if (!blockedForBot(nx, bot.y)) { bot.x = nx; continue; }

            ny = bot.y + Math.sign(diry) * step;
            if (!blockedForBot(bot.x, ny)) { bot.y = ny; continue; }

            if (!blockedForBot(bot.x + Math.sign(dirx)*NUDGE, bot.y))
              bot.x += Math.sign(dirx)*NUDGE;
            else if (!blockedForBot(bot.x, bot.y + Math.sign(diry)*NUDGE))
              bot.y += Math.sign(diry)*NUDGE;

            break;
          }
        }

if (now - (bot.lastShot || 0) > SHOOT_INTERVAL) {
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
  game._bulletCount++; // O(1)
}

        continue;
      }

      // sinon : avancer (path si besoin)
      let tx = closestZombie.x, ty = closestZombie.y;
      const forwardBlocked = isCollision(game.map, bot.x + (dx/dist), bot.y + (dy/dist));
      if (forwardBlocked) {
        const path = findPath(game, bot.x, bot.y, tx, ty);
        if (path && path.length > 1) {
          const n = path[1];
          tx = n.x * TILE_SIZE + TILE_SIZE / 2;
          ty = n.y * TILE_SIZE + TILE_SIZE / 2;
        }
      }

      let mvx = tx - bot.x, mvy = ty - bot.y;
      const md = Math.hypot(mvx, mvy);
      if (md > 1e-6) { mvx /= md; mvy /= md; }

      let remaining = speed * deltaTime;
      while (remaining > 0.0001) {
        const step = Math.min(remaining, MAX_STEP);
        remaining -= step;

        let nx = bot.x + mvx * step, ny = bot.y + mvy * step;
        if (!blockedForBot(nx, ny)) { bot.x = nx; bot.y = ny; continue; }

        nx = bot.x + Math.sign(mvx) * step;
        if (!blockedForBot(nx, bot.y)) { bot.x = nx; continue; }

        ny = bot.y + Math.sign(mvy) * step;
        if (!blockedForBot(bot.x, ny)) { bot.y = ny; continue; }

        if (!blockedForBot(bot.x + Math.sign(mvx)*NUDGE, bot.y))
          bot.x += Math.sign(mvx)*NUDGE;
        else if (!blockedForBot(bot.x, bot.y + Math.sign(mvy)*NUDGE))
          bot.y += Math.sign(mvy)*NUDGE;

        break;
      }
      continue;
    }

    // errance
    if (!bot.wanderDir || now > bot.wanderChangeTime) {
      const a = Math.random() * Math.PI * 2;
      bot.wanderDir = { x: Math.cos(a), y: Math.sin(a) };
      bot.wanderChangeTime = now + 800 + Math.random() * 1200;
    }

    let tx = bot.x + bot.wanderDir.x * 100;
    let ty = bot.y + bot.wanderDir.y * 100;

    let dx = tx - bot.x, dy = ty - bot.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1e-6) { dx /= dist; dy /= dist; }

    let remaining = speed * deltaTime;
    while (remaining > 0.0001) {
      const step = Math.min(remaining, MAX_STEP);
      remaining -= step;

      let nx = bot.x + dx * step, ny = bot.y + dy * step;
      if (!blockedForBot(nx, ny)) { bot.x = nx; bot.y = ny; continue; }

      nx = bot.x + Math.sign(dx) * step;
      if (!blockedForBot(nx, bot.y)) { bot.x = nx; continue; }

      ny = bot.y + Math.sign(dy) * step;
      if (!blockedForBot(bot.x, ny)) { bot.y = ny; continue; }

      if (!blockedForBot(bot.x + Math.sign(dx)*NUDGE, bot.y))
        bot.x += Math.sign(dx)*NUDGE;
      else if (!blockedForBot(bot.x, bot.y + Math.sign(dy)*NUDGE))
        bot.y += Math.sign(dy)*NUDGE;

      break;
    }
  }
}


function moveZombies(game, deltaTime) {
  const MAX_STEP = 6;
  const BASE_NUDGE = 1.6;
  const now = Date.now();

  const turretTargets = [];
  if (game.structures) {
    for (let ty = 0; ty < MAP_ROWS; ty++) {
      for (let tx = 0; tx < MAP_COLS; tx++) {
        const s = getStruct(game, tx, ty);
        if (s && (s.type === 'T' || s.type === 't' || s.type === 'G') && s.hp > 0) {
          turretTargets.push({
            x: tx * TILE_SIZE + TILE_SIZE / 2,
            y: ty * TILE_SIZE + TILE_SIZE / 2,
            tx, ty
          });
        }
      }
    }
  }

  const collidesPlayerAtR = (x, y, r) =>
    Object.values(game.players).some(p =>
      p && p.alive && entitiesCollide(x, y, r, p.x, p.y, PLAYER_RADIUS, 0)
    );

  const blockedAt = (x, y, r) =>
    isCircleColliding(game.map, x, y, r) ||
    circleBlockedByStructures(game, x, y, r, isSolidForZombie) ||
    collidesPlayerAtR(x, y, r);

  const rotated = (vx, vy, rad) => {
    const c = Math.cos(rad), s = Math.sin(rad);
    return { x: vx * c - vy * s, y: vx * s + vy * c };
  };

  for (const [id, z] of Object.entries(game.zombies)) {
    if (!z) continue;

    if (z._lastTrackAt == null) {
      z._lastTrackAt = now;
      z._lastTrackX = z.x;
      z._lastTrackY = z.y;
      z._stuckAccum = 0;
      z._unstuckUntil = 0;
      z._wallSide = (Math.random() < 0.5 ? -1 : 1);
      z._localBlockStrikes = 0;
    }

    if (z.attackFreezeUntil && now < z.attackFreezeUntil) {
      if (now - z._lastTrackAt >= 450) {
        z._lastTrackAt = now;
        z._lastTrackX = z.x;
        z._lastTrackY = z.y;
        z._stuckAccum = 0;
        z._localBlockStrikes = 0;
      }
      continue;
    }

    let target = null, bestDist = Infinity;
    for (const p of Object.values(game.players)) {
      if (!p || !p.alive) continue;
      const d = Math.hypot(p.x - z.x, p.y - z.y);
      if (d < bestDist) { bestDist = d; target = { x: p.x, y: p.y }; }
    }
    for (const t of turretTargets) {
      const d = Math.hypot(t.x - z.x, t.y - z.y);
      if (d < bestDist) { bestDist = d; target = { x: t.x, y: t.y }; }
    }
    if (!target) continue;

    const speed = z.speed || 40;

    let tx, ty, usingPath = false;

    if (!losBlockedForZombie(game, z.x, z.y, target.x, target.y)) {
      tx = target.x; ty = target.y;
      z.path = null; z.pathStep = 1; z.pathTarget = null;
      if (!z.nextRepathAt) {
        z.nextRepathAt = now + 1500 + Math.floor(Math.random() * 600);
      }
    } else {
      const dueForPeriodicRepath = now >= (z.nextRepathAt || 0);

      const needNewPath =
        dueForPeriodicRepath ||
        !z.path || !z.pathTarget ||
        Math.abs(z.pathTarget.x - target.x) > 12 ||
        Math.abs(z.pathTarget.y - target.y) > 12 ||
        z.path.length < 2 ||
        z.pathStep == null ||
        z.pathStep >= z.path.length;

      if (needNewPath) {
        // ---- BUDGET de pathfinding ----
        if (PF_BUDGET_THIS_TICK > 0) {
          PF_BUDGET_THIS_TICK--;
          z.path = findPath(game, z.x, z.y, target.x, target.y);
          z.pathStep = 1;
          z.pathTarget = { x: target.x, y: target.y };
          z.nextRepathAt = now + 1500 + Math.floor(Math.random() * 600);
        } else {
          // budget épuisé : on re-essaiera très bientôt, petit délai
          z.nextRepathAt = now + 120 + Math.floor(Math.random() * 120);
        }
      }

      if (z.path && z.path.length > z.pathStep) {
        const n = z.path[z.pathStep];
        tx = n.x * TILE_SIZE + TILE_SIZE / 2;
        ty = n.y * TILE_SIZE + TILE_SIZE / 2;
        usingPath = true;
      } else {
        const a = Math.random() * Math.PI * 2;
        tx = z.x + Math.cos(a) * 14;
        ty = z.y + Math.sin(a) * 14;
      }
    }

    let dx = tx - z.x, dy = ty - z.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) continue;
    dx /= dist; dy /= dist;

    if (now - z._lastTrackAt >= 450) {
      const moved = Math.hypot(z.x - z._lastTrackX, z.y - z._lastTrackY);
      const nearlyStill = moved < 6;
      const losBlocked = losBlockedForZombie(game, z.x, z.y, target.x, target.y);
      if (nearlyStill && losBlocked) {
        z._stuckAccum = Math.min(2500, z._stuckAccum + (now - z._lastTrackAt));
      } else {
        z._stuckAccum = Math.max(0, z._stuckAccum - 200);
      }
      z._lastTrackAt = now;
      z._lastTrackX = z.x;
      z._lastTrackY = z.y;

      if (z._stuckAccum >= 2000 && now >= z._unstuckUntil) {
        z._unstuckUntil = now + 600;
        z._wallSide = -z._wallSide;
        z._stuckAccum = 900;
      }
    }

    if (now < z._unstuckUntil) {
      const side = z._wallSide || 1;
      const px = side * (-dy);
      const py = side * ( dx);
      const mixX = dx * 0.4 + px * 0.6;
      const mixY = dy * 0.4 + py * 0.6;
      const n = Math.hypot(mixX, mixY);
      if (n > 0.0001) { dx = mixX / n; dy = mixY / n; }
    }

    let remaining = speed * deltaTime * (usingPath ? 0.8 : 1.0);
    const NUDGE = (now < z._unstuckUntil) ? (BASE_NUDGE + 0.5) : BASE_NUDGE;
    const radiusNow = (now < z._unstuckUntil) ? Math.max(1, ZOMBIE_RADIUS - 1) : ZOMBIE_RADIUS;

    z._localBlockStrikes = 0;

    while (remaining > 0.0001) {
      const step = Math.min(remaining, MAX_STEP);
      remaining -= step;

      let advanced = false;

      let nx = z.x + dx * step;
      let ny = z.y + dy * step;

      if (!blockedAt(nx, ny, radiusNow)) {
        z.x = nx; z.y = ny;
        advanced = true;
      } else {
        nx = z.x + Math.sign(dx) * step;
        if (!blockedAt(nx, z.y, radiusNow)) {
          z.x = nx;
          advanced = true;
        } else {
          ny = z.y + Math.sign(dy) * step;
          if (!blockedAt(z.x, ny, radiusNow)) {
            z.y = ny;
            advanced = true;
          } else {
            if (!blockedAt(z.x + Math.sign(dx) * NUDGE, z.y, radiusNow)) {
              z.x += Math.sign(dx) * NUDGE;
              advanced = true;
            } else if (!blockedAt(z.x, z.y + Math.sign(dy) * NUDGE, radiusNow)) {
              z.y += Math.sign(dy) * NUDGE;
              advanced = true;
            } else {
              const turn = (Math.PI / 9) * (z._wallSide || 1);
              let r1 = rotated(dx, dy, turn);
              nx = z.x + r1.x * step; ny = z.y + r1.y * step;
              if (!blockedAt(nx, ny, radiusNow)) {
                z.x = nx; z.y = ny;
                advanced = true;
              } else {
                let r2 = rotated(dx, dy, -turn);
                nx = z.x + r2.x * step; ny = z.y + r2.y * step;
                if (!blockedAt(nx, ny, radiusNow)) {
                  z.x = nx; z.y = ny;
                  advanced = true;
                } else {
                  const turnStrong = (Math.PI / 4) * (z._wallSide || 1);
                  const stepStrong = step * 0.8;
                  let r3 = rotated(dx, dy, turnStrong);
                  nx = z.x + r3.x * stepStrong; ny = z.y + r3.y * stepStrong;
                  if (!blockedAt(nx, ny, radiusNow)) {
                    z.x = nx; z.y = ny;
                    advanced = true;
                  } else {
                    let r4 = rotated(dx, dy, -turnStrong);
                    nx = z.x + r4.x * stepStrong; ny = z.y + r4.y * stepStrong;
                    if (!blockedAt(nx, ny, radiusNow)) {
                      z.x = nx; z.y = ny;
                      advanced = true;
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (advanced) {
        z._localBlockStrikes = 0;
        continue;
      }

      // Micro-repath : seulement si on a du budget ce tick
      z._localBlockStrikes++;
      if (z._localBlockStrikes >= 2) {
        if (PF_BUDGET_THIS_TICK > 0) {
          PF_BUDGET_THIS_TICK--;
          const tgtX = target.x, tgtY = target.y;
          const newPath = findPath(game, z.x, z.y, tgtX, tgtY);
          if (newPath && newPath.length > 1) {
            z.path = newPath;
            z.pathStep = 1;
            z.pathTarget = { x: tgtX, y: tgtY };
            z.nextRepathAt = now + 1500 + Math.floor(Math.random() * 600);

            const n = newPath[1];
            const nwx = n.x * TILE_SIZE + TILE_SIZE / 2;
            const nwy = n.y * TILE_SIZE + TILE_SIZE / 2;

            let rdx = nwx - z.x, rdy = nwy - z.y;
            const rd = Math.hypot(rdx, rdy);
            if (rd > 1e-6) { rdx /= rd; rdy /= rd; }

            const step2 = Math.min(MAX_STEP, remaining + step);
            let nx2 = z.x + rdx * step2;
            let ny2 = z.y + rdy * step2;

            if (!blockedAt(nx2, ny2, radiusNow)) {
              z.x = nx2; z.y = ny2;
              z._localBlockStrikes = 0;
              continue;
            }
          }
        } else {
          // pas de budget : retente bientôt
          z.nextRepathAt = now + 120 + Math.floor(Math.random() * 120);
        }

        break; // stop pour ce tick
      }

      break;
    }

    if (z.path && z.path.length > z.pathStep) {
      const n = z.path[z.pathStep];
      const nodeX = n.x * TILE_SIZE + TILE_SIZE / 2;
      const nodeY = n.y * TILE_SIZE + TILE_SIZE / 2;
      if (Math.abs(z.x - nodeX) < 4 && Math.abs(z.y - nodeY) < 4) {
        z.pathStep++;
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

  // Cibles tourelles vivantes (coords et cases)
  const turretTargets = [];
  if (game.structures) {
    for (let ty = 0; ty < MAP_ROWS; ty++) {
      for (let tx = 0; tx < MAP_COLS; tx++) {
        const s = getStruct(game, tx, ty);
        if (s && (s.type === 'T' || s.type === 't' || s.type === 'G') && s.hp > 0) {
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

    // 1) Attaques sur joueurs au contact
    for (const pid in game.players) {
      const p = game.players[pid];
      if (!p || !p.alive) continue;

      const dist = Math.hypot(z.x - p.x, z.y - p.y);
      if (dist <= ATTACK_REACH_PLAYER) {
        if (!z.lastAttackTimes[pid]) z.lastAttackTimes[pid] = 0;
        if (now - z.lastAttackTimes[pid] >= ZOMBIE_ATTACK_COOLDOWN_MS) {
          z.lastAttackTimes[pid] = now;

          fixHealth(p);
          const DAMAGE = ZOMBIE_DAMAGE_BASE * (1 + 0.05 * (game.currentRound - 1));
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

          // <-- gèle le zombie qui vient de frapper
          z.attackFreezeUntil = now + ZOMBIE_ATTACK_COOLDOWN_MS;
          hasAttackedAny = true;
        }
      }
    }

    // 1bis) Attaques sur tourelles au contact
    for (const t of turretTargets) {
      const dist = Math.hypot(z.x - t.x, z.y - t.y);
      if (dist <= ATTACK_REACH_PLAYER) {
        const key = `turret_${t.tx}_${t.ty}`;
        if (!z.lastAttackTimes[key]) z.lastAttackTimes[key] = 0;
        if (now - z.lastAttackTimes[key] >= ZOMBIE_ATTACK_COOLDOWN_MS) {
          z.lastAttackTimes[key] = now;
          const s = getStruct(game, t.tx, t.ty);
          if (s && (s.type === 'T' || s.type === 't' || s.type === 'G') && s.hp > 0) {
            const DAMAGE = ZOMBIE_DAMAGE_BASE * (1 + 0.05 * (game.currentRound - 1));
            s.hp = Math.max(0, s.hp - DAMAGE);
            if (s.hp <= 0) {
              setStruct(game, t.tx, t.ty, null);
              structuresChanged = true;
            }
          
            // NEW: push live HP update for turret under attack
            io.to('lobby' + game.id).volatile.emit('structureHP', { tx: t.tx, ty: t.ty, hp: s.hp });
}
          // <-- gèle le zombie qui vient de frapper
          z.attackFreezeUntil = now + ZOMBIE_ATTACK_COOLDOWN_MS;
          hasAttackedAny = true;
        }
      }
    }

    // 2) Attaques sur structures en contact (3x3 autour)
    const { tx: ztx, ty: zty } = worldToTile(z.x, z.y);
    const DAMAGE = ZOMBIE_DAMAGE_BASE * (1 + 0.05 * (game.currentRound - 1));

    const candidates = [];
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const ntx = ztx + ox, nty = zty + oy;
        const s = getStruct(game, ntx, nty);
        if (!s || s.hp <= 0) continue;
        if (circleIntersectsTile(z.x, z.y, ATTACK_REACH_STRUCT, ntx, nty)) {
          candidates.push({ tx: ntx, ty: nty, s });
        }
      }
    }

    if (candidates.length > 0) {
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
        
            
            // NEW: push live HP update for structure under attack
            io.to('lobby' + game.id).volatile.emit('structureHP', { tx: tgt.tx, ty: tgt.ty, hp: tgt.s.hp });
// NEW: push live HP update for structure under attack
            io.to('lobby' + game.id).volatile.emit('structureHP', { tx: tgt.tx, ty: tgt.ty, hp: tgt.s.hp });
// <-- gèle le zombie qui vient de frapper
        z.attackFreezeUntil = now + ZOMBIE_ATTACK_COOLDOWN_MS;
        hasAttackedAny = true;
      }
    } else {
      // 3) Fallback : si LOS vers meilleure cible est bloquée, taper une structure proche
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
          const key2 = `struct_${tgt.tx}_${tgt.ty}`;
          if (!z.lastAttackTimes[key2]) z.lastAttackTimes[key2] = 0;

          if (now - z.lastAttackTimes[key2] >= ZOMBIE_ATTACK_COOLDOWN_MS) {
            z.lastAttackTimes[key2] = now;
            tgt.s.hp = Math.max(0, tgt.s.hp - DAMAGE);
            if (tgt.s.hp <= 0) {
              setStruct(game, tgt.tx, tgt.ty, null);
              structuresChanged = true;
            }
            
            
            // NEW: push live HP update for structure under attack
            io.to('lobby' + game.id).volatile.emit('structureHP', { tx: tgt.tx, ty: tgt.ty, hp: tgt.s.hp });
// NEW: push live HP update for structure under attack
            io.to('lobby' + game.id).volatile.emit('structureHP', { tx: tgt.tx, ty: tgt.ty, hp: tgt.s.hp });
// <-- gèle le zombie qui vient de frapper
            z.attackFreezeUntil = now + ZOMBIE_ATTACK_COOLDOWN_MS;
            hasAttackedAny = true;
          }
        }
      }
    }

    // nettoyage optionnel de vieux cooldowns d’attaque
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
      game._bulletCount = Math.max(0, game._bulletCount - 1);
      continue;
    }

    // collisions avec les murs de la MAP
    if (isCollision(game.map, bullet.x, bullet.y)) {
      delete game.bullets[id];
      game._bulletCount = Math.max(0, game._bulletCount - 1);
      continue;
    }

    // collision avec zombies
    for (const zid in game.zombies) {
      const z = game.zombies[zid];
      if (entitiesCollide(z.x, z.y, ZOMBIE_RADIUS, bullet.x, bullet.y, 4)) {
        const shooterIsPlayer = !!game.players[bullet.owner];
        const statsShooter = shooterIsPlayer ? getPlayerStats(game.players[bullet.owner]) : {};
        const bulletDamage = shooterIsPlayer ? (statsShooter.damage || BULLET_DAMAGE) : BULLET_DAMAGE;

        z.hp -= bulletDamage;

        const killed = z.hp <= 0;
        if (killed) {
          if (shooterIsPlayer) {
            game.players[bullet.owner].kills = (game.players[bullet.owner].kills || 0) + 1;
            io.to(bullet.owner).emit('killsUpdate', game.players[bullet.owner].kills);

            const baseMoney = Math.floor(Math.random() * 11) + 10; // 10..20
            const moneyEarned = Math.round(baseMoney * ((statsShooter.goldGain || 10) / 10));
            game.players[bullet.owner].money = (game.players[bullet.owner].money || 0) + moneyEarned;
            io.to(bullet.owner).emit('moneyEarned', { amount: moneyEarned, x: z.x, y: z.y });
          }

          // décrément O(1) + remaining
          delete game.zombies[zid];
          game._zombieCount = Math.max(0, game._zombieCount - 1);

          game.zombiesKilledThisWave = (game.zombiesKilledThisWave || 0) + 1;
          const remaining = Math.max(0, (game.totalZombiesToSpawn || 0) - game.zombiesKilledThisWave);
          io.to('lobby' + game.id).emit('zombiesRemaining', remaining);
        }

        // La balle s'arrête sur impact
        delete game.bullets[id];
        game._bulletCount = Math.max(0, game._bulletCount - 1);
        break;
      }
    }
  }
}

// PATCH: log de fin de partie
function checkGameEnd(game) {
  const allDead = Object.values(game.players).filter(p => p.alive).length === 0;
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

function stepOnce(dt) {
  for (const game of activeGames) {
    if (!game.lobby.started) continue;

    // --- Si plus aucun joueur dans la room, on termine la partie immédiatement
    const room = io.sockets.adapter.rooms.get('lobby' + game.id);
    if (!room || room.size === 0) {
      endGame(game, 'no_players');
      continue;
    }

    // Budget PF adaptatif
    PF_BUDGET_THIS_TICK = computePathfindBudget(game);

    // Détection "calme"
    const hasZombies = (game._zombieCount || 0) > 0;
    const hasBullets = (game._bulletCount || 0) > 0;
    const hasTurrets = (game._turretCount || 0) > 0;
    const calm = !hasZombies && !hasBullets && !hasTurrets && !game.spawningActive;

    // Simulation
    movePlayers(game, dt);
    moveBots(game, dt);

    if (!calm) {
      moveZombies(game, dt);
      tickTurrets(game);
      moveBullets(game, dt);
      handleZombieAttacks(game);
    }

    // PUSH réseau (intervalle différent si calme)
    if (room) {
      const now = Date.now();
      const sendInterval = calm ? NET_INTERVAL_IDLE_MS : NET_INTERVAL_MS;

      for (const sid of room) {
        const p = game.players[sid];
        if (!p) continue;

        const cx = (p.spectator && p.viewX != null) ? p.viewX : (p.x || 0);
          const cy = (p.spectator && p.viewY != null) ? p.viewY : (p.y || 0);

        const zSnap  = getZombiesFiltered(game, cx, cy, SERVER_VIEW_RADIUS);
        const bSnap  = getBulletsFiltered(game, cx, cy, SERVER_VIEW_RADIUS);
        const phSnap = getPlayersHealthStateFiltered(game, cx, cy, SERVER_VIEW_RADIUS);

        const last = game._lastNetSend[sid] || 0;
        if (now - last >= sendInterval) {
          io.to(sid).volatile.emit('stateUpdate', {
            zombies: zSnap,
            bullets: bSnap,
            playersHealth: phSnap,
            round: game.currentRound
          });
          game._lastNetSend[sid] = now;
        }
      }
    }

    // Régénération
    for (const pid in game.players) {
      const p = game.players[pid];
      if (!p || !p.alive) continue;
      const stats = getPlayerStats(p);
      if (stats.regen > 0 && p.health < p.maxHealth) {
        p.health += stats.regen * dt;
        fixHealth(p);
        io.to(pid).emit('healthUpdate', p.health);
      }
    }

    checkWaveEnd(game);
    checkGameEnd(game);
  }
}


function gameLoop() {
  try {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    let frameTime = now - lastTime;
    lastTime = now;

    if (frameTime > 0.25) frameTime = 0.25;
    accumulator += frameTime;

    // Modes global
    let anyStarted = false;
    let anyBusy = false;

    for (const game of activeGames) {
      if (!game.lobby.started) continue;
      anyStarted = true;
      const hasZombies = (game._zombieCount || 0) > 0;
      const hasBullets = (game._bulletCount || 0) > 0;
      const hasTurrets = (game._turretCount || 0) > 0;
      const busy = hasZombies || hasBullets || hasTurrets || game.spawningActive;
      if (busy) { anyBusy = true; break; }
    }

    const targetHz =
      !anyStarted ? EMPTY_TICK_HZ :
      anyBusy     ? TICK_HZ       :
                    CALM_TICK_HZ;

    const targetIntervalMs = 1000 / targetHz;
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    if (_lastTickAtMs && (nowMs - _lastTickAtMs) < targetIntervalMs) {
      setTimeout(gameLoop, Math.max(1, targetIntervalMs - (nowMs - _lastTickAtMs)));
      return;
    }
    _lastTickAtMs = nowMs;

    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
      stepOnce(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
  } catch (err) {
    console.error("Erreur dans gameLoop :", err);
  }
  setTimeout(gameLoop, 1);
}






gameLoop();

const PORT = process.env.PORT || 3000;
console.log('Avant listen');
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
console.log('Après listen');