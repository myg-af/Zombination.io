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

// --- Shop constants envoyées au client ---
const SHOP_CONST = {
  base: { maxHp: 100, speed: 50, regen: 0, damage: 5, goldGain: 10 },
  regenPerLevel: 1,                 // 1 PV/sec/niveau
  priceTiers: [10, 25, 50, 75, 100],// niv 1..5
  priceStepAfterTier: 50            // après niv 5 → +50/niv
};

// --- Prix d'achat des structures (serveur autoritatif) ---
const SHOP_BUILD_PRICES = {
  T: 1000, // Grande tourelle
  t: 250,  // Mini-tourelle
  B: 100,  // Mur
  D: 200   // Porte
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
    zombies: {},
    bullets: {},
    currentRound: 1,
    totalZombiesToSpawn: 50,
    zombiesSpawnedThisWave: 0,
    zombiesKilledThisWave: 0, // compteur de kills/vague
    map: null,
    spawnInterval: null,
    spawningActive: false,

    // --- NOUVEAU : throttle réseau par joueur
    _lastNetSend: {}, // { [socketId]: timestampDernierEnvoi }

    // --- NOUVEAU : cadence zombies
    _aiGroupTick: 0,     // groupe actif ce tick [0..AI_GROUPS-1]
    _aiGroupCursor: 0,   // round-robin d’affectation des zombies aux groupes
    _heavyBudget: 0,     // budget d'ops lourdes (LOS + path) pour ce tick
    _repathsBudget: 0,   // budget de pathfinding (déjà exploité ailleurs)
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

  // 2) Trouver les bornes du carré vide central
  const cR = Math.floor(MAP_ROWS / 2);
  const cC = Math.floor(MAP_COLS / 2);

  function extent(dirR, dirC) {
    let r = cR, c = cC, k = 0;
    while (true) {
      const nr = r + dirR, nc = c + dirC;
      if (nr <= 0 || nr >= MAP_ROWS - 1 || nc <= 0 || nc >= MAP_COLS - 1) break;
      if (game.map[nr][nc] === 1) break;
      r = nr;
      c = nc;
      k++;
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
    setStruct(game, c, r0, { type: 'B', hp: 200 });
    setStruct(game, c, r1, { type: 'B', hp: 200 });
  }
  for (let r = r0; r <= r1; r++) {
    setStruct(game, c0, r, { type: 'B', hp: 200 });
    setStruct(game, c1, r, { type: 'B', hp: 200 });
  }

  // 4) Portes au milieu de chaque côté (HP = 200)
  const midC = Math.floor((c0 + c1) / 2);
  const midR = Math.floor((r0 + r1) / 2);
  setStruct(game, midC, r0, { type: 'D', hp: 200 });
  setStruct(game, midC, r1, { type: 'D', hp: 200 });
  setStruct(game, c0, midR, { type: 'D', hp: 200 });
  setStruct(game, c1, midR, { type: 'D', hp: 200 });

  // 5) Grande tourelle au centre (HP = 500)
  setStruct(game, midC, midR, { type: 'T', hp: 500, lastShot: 0 });

  // 6) Mini-tourelles décalées d’1 case en diagonale (inset = 2)
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





function getAvailableLobby() {
  let game = activeGames.find(g => !g.lobby.started);
  if (!game) game = createNewGame();
  return game;
}

const socketToGame = {};

const PLAYER_RADIUS = 10;
const ZOMBIE_RADIUS = 10;
// === Interest management (zone de vue par joueur) ===
const SERVER_VIEW_RADIUS = 1000; // rayon en px (monde) pour ce qu'on ENVOIE à chaque client

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
  game.structures[ty][tx] = s;
}

function canPlaceStructureAt(game, tx, ty) {
  if (!game || !game.map) return false;
  if (ty < 0 || ty >= MAP_ROWS || tx < 0 || tx >= MAP_COLS) return false;

  // 1) pas un mur de la map
  if (game.map[ty][tx] === 1) return false;

  // 2) pas de structure existante
  const existing = getStruct(game, tx, ty);
  if (existing) return false;

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
    (struct.type === 'B' || struct.type === 'T' || struct.type === 't') && struct.hp > 0
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

  // Quota global de tirs ce tick
  let shotsLeft = TURRET_SHOTS_PER_TICK;

  // Batch visuel des lasers à envoyer en une seule fois
  const laserBatch = [];

  // Parcours de la grille des structures
  outer_loop:
  for (let ty = 0; ty < MAP_ROWS; ty++) {
    for (let tx = 0; tx < MAP_COLS; tx++) {
      const s = getStruct(game, tx, ty);
      if (!s || (s.type !== 'T' && s.type !== 't') || s.hp <= 0) continue;

      if (!s.lastShot) s.lastShot = 0;

      // cadence inchangée (mini/mini)
      const interval = (s.type === 't') ? MINI_TURRET_SHOOT_INTERVAL : TURRET_SHOOT_INTERVAL;

      // --- JITTER : décalage aléatoire par tir, centré sur 0 pour conserver le débit moyen ---
      // On mémorise le jitter courant dans l'objet tourelle, puis on le régénère après un tir
      if (typeof s._jitterCur !== 'number') {
        s._jitterCur = (Math.random() - 0.5) * TURRET_JITTER_MS; // [-J/2, +J/2]
      }
      if ((now - s.lastShot) < (interval + s._jitterCur)) {
        continue; // encore en cooldown (avec décalage)
      }

      // centre monde de la tourelle
      const cx = tx * TILE_SIZE + TILE_SIZE / 2;
      const cy = ty * TILE_SIZE + TILE_SIZE / 2;

      // cible : zombie le plus proche DANS LA PORTÉE + LOS libre
      let best = null;
      let bestDist2 = Infinity;

      for (const z of Object.values(game.zombies)) {
        if (!z) continue;

        const dx = z.x - cx;
        const dy = z.y - cy;
        const d2 = dx * dx + dy * dy;

        // filtre distance : ignore tout zombie hors de portée
        if (d2 > TURRET_RANGE_SQ) continue;

        // on ne paie la LOS que si on a une meilleure distance
        if (d2 < bestDist2) {
          if (!losBlockedForTurret(game, cx, cy, z.x, z.y)) {
            bestDist2 = d2;
            best = z;
          }
        }
      }

      if (!best) continue; // rien dans la portée avec LOS

      // --- Quota par tick : on stoppe proprement quand il n'y a plus de budget ---
      if (shotsLeft <= 0) {
        break outer_loop;
      }

      // Tir validé → on consomme une "unité" du quota
      shotsLeft--;

      // Mise à jour cooldown + regénère un jitter pour le prochain tir
      s.lastShot = now;
      s._jitterCur = (Math.random() - 0.5) * TURRET_JITTER_MS; // [-J/2, +J/2]

      // Dégâts (inchangés)
      const dmg = BULLET_DAMAGE;
      best.hp -= dmg;

      // Batch du laser (pas d'emit unitaire ici)
      laserBatch.push({
        x0: cx, y0: cy,
        x1: best.x, y1: best.y,
        color: (s.type === 'T') ? '#ff3b3b' : '#3aa6ff'
      });

      // Mort éventuelle (identique à l'existant)
      if (best.hp <= 0) {
        // Gains au propriétaire s’il existe
        if (s.placedBy) {
          const ownerPlayer = game.players[s.placedBy];
          if (ownerPlayer) {
            const ownerStats = getPlayerStats(ownerPlayer);
            const baseMoney = Math.floor(Math.random() * 11) + 10; // 10..20
            const moneyEarned = Math.round(baseMoney * ((ownerStats.goldGain || 10) / 10));
            ownerPlayer.money = (ownerPlayer.money || 0) + moneyEarned;
            io.to(s.placedBy).emit('moneyEarned', { amount: moneyEarned, x: best.x, y: best.y });
          }
        }

        // Compteurs de vague / broadcast restants
        game.zombiesKilledThisWave = (game.zombiesKilledThisWave || 0) + 1;
        const remaining = Math.max(0, (game.totalZombiesToSpawn || 0) - game.zombiesKilledThisWave);
        io.to('lobby' + game.id).emit('zombiesRemaining', remaining);

        // Suppression du zombie
        for (const zid in game.zombies) {
          if (game.zombies[zid] === best) {
            delete game.zombies[zid];
            break;
          }
        }
      }
    }
  }

  // --- BATCH EMIT : on envoie tous les segments de lasers en UNE fois ---
  if (laserBatch.length > 0) {
    io.to('lobby' + game.id).emit(TURRET_LASER_BATCH_EVENT, laserBatch);
  }
}


function losBlockedForZombie(game, x0, y0, x1, y1) {
  // DDA par tuiles + prise en compte du "cercle" via isCircleColliding
  const ts = TILE_SIZE;
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return false;

  let cx = Math.floor(x0 / ts);
  let cy = Math.floor(y0 / ts);
  const tx = Math.floor(x1 / ts);
  const ty = Math.floor(y1 / ts);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;

  let tMaxX, tMaxY;
  let tDeltaX, tDeltaY;

  const xBorder = (cx + (stepX > 0 ? 1 : 0)) * ts;
  const yBorder = (cy + (stepY > 0 ? 1 : 0)) * ts;

  tMaxX   = (dx !== 0) ? Math.abs((xBorder - x0) / dx) : Infinity;
  tMaxY   = (dy !== 0) ? Math.abs((yBorder - y0) / dy) : Infinity;
  tDeltaX = (dx !== 0) ? Math.abs(ts / dx) : Infinity;
  tDeltaY = (dy !== 0) ? Math.abs(ts / dy) : Infinity;

  // On marche de tuile en tuile jusqu’à atteindre la tuile de destination
  while (true) {
    // test cercle-vs-tuile solide sur le centre actuel (plus strict que point)
    if (game.map[cy] && game.map[cy][cx] === 1) {
      // le centre de la ligne passe dans cette tuile : vérifie le cercle zombie
      const px = Math.max(cx * ts, Math.min(x0, (cx + 1) * ts));
      const py = Math.max(cy * ts, Math.min(y0, (cy + 1) * ts));
      if (isCircleColliding(game.map, px, py, ZOMBIE_RADIUS)) return true;
    }
    if (cx === tx && cy === ty) break;

    if (tMaxX < tMaxY) { cx += stepX; tMaxX += tDeltaX; }
    else               { cy += stepY; tMaxY += tDeltaY; }
  }
  return false;
}




function losBlockedForTurret(game, x0, y0, x1, y1) {
  // DDA ne bloque QUE sur les murs de la MAP (pas les structures)
  const ts = TILE_SIZE;
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return false;

  let cx = Math.floor(x0 / ts);
  let cy = Math.floor(y0 / ts);
  const tx = Math.floor(x1 / ts);
  const ty = Math.floor(y1 / ts);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;

  let tMaxX, tMaxY;
  let tDeltaX, tDeltaY;

  const xBorder = (cx + (stepX > 0 ? 1 : 0)) * ts;
  const yBorder = (cy + (stepY > 0 ? 1 : 0)) * ts;

  tMaxX   = (dx !== 0) ? Math.abs((xBorder - x0) / dx) : Infinity;
  tMaxY   = (dy !== 0) ? Math.abs((yBorder - y0) / dy) : Infinity;
  tDeltaX = (dx !== 0) ? Math.abs(ts / dx) : Infinity;
  tDeltaY = (dy !== 0) ? Math.abs(ts / dy) : Infinity;

  while (true) {
    if (game.map[cy] && game.map[cy][cx] === 1) return true;
    if (cx === tx && cy === ty) break;

    if (tMaxX < tMaxY) { cx += stepX; tMaxX += tDeltaX; }
    else               { cy += stepY; tMaxY += tDeltaY; }
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




// Test collision cercle vs zombies (utilise la grille)
function zombiesCircleCollision(game, x, y, radius, bonus = 0) {
  const cand = queryZombiesInRadius(game, x, y, radius + ZOMBIE_RADIUS + bonus);
  for (const z of cand) {
    if (entitiesCollide(x, y, radius, z.x, z.y, ZOMBIE_RADIUS, bonus)) return true;
  }
  return false;
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
    };

    const stats = getPlayerStats(game.players[sid]);
    game.players[sid].maxHealth = stats.maxHp;
    game.players[sid].health = stats.maxHp;

    usedPos.push({ x: spawnX, y: spawnY });
  }
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
const TURRET_SHOOT_INTERVAL = 250;
const MINI_TURRET_SHOOT_INTERVAL = 1000;
const TURRET_RANGE = 1000;
const TURRET_RANGE_SQ = TURRET_RANGE * TURRET_RANGE;
// --- Anti-burst tourelles ---
// Décalage aléatoire de cadence par tir, centré sur 0 (moyenne nulle) → ne change pas le DPS moyen
const TURRET_JITTER_MS = 120;              // ex. ±120 ms par tir

// Nombre maximum de tirs de tourelles autorisés par "stepOnce" (un tick physique)
const TURRET_SHOTS_PER_TICK = 8;           // ajuste si besoin (ex. 6..12 selon charge)

// Événement de batch pour les lasers (un tableau de segments)
const TURRET_LASER_BATCH_EVENT = 'laserBeams';
// --- Stagger & cadence (zombies) ---
const AI_GROUPS = 3;                   // on répartit les zombies en 3 groupes tournants
const HEAVY_AI_BUDGET_PER_TICK = 120;  // budget d'opérations "lourdes" par tick (LOS/cache + path)

// --- Grille spatiale & LOD ---
const GRID_CELL_SIZE = Math.max(24, TILE_SIZE); // taille de cellule (>= tuile)

// Cache LOS court déjà ajouté (tu l'as plus haut) : LOS_CACHE_MS

class SpatialGrid {
  constructor(cellSize) {
    this.cs = cellSize;
    this.map = new Map();   // key -> array of ids
  }
  _key(ix, iy) { return `${ix},${iy}`; }
  clear() { this.map.clear(); }
  insert(x, y, id) {
    const ix = Math.floor(x / this.cs);
    const iy = Math.floor(y / this.cs);
    const k = this._key(ix, iy);
    let arr = this.map.get(k);
    if (!arr) { arr = []; this.map.set(k, arr); }
    arr.push(id);
  }
  queryRadius(x, y, r, outArr) {
    outArr.length = 0;
    const cs = this.cs;
    const ix0 = Math.floor((x - r) / cs), iy0 = Math.floor((y - r) / cs);
    const ix1 = Math.floor((x + r) / cs), iy1 = Math.floor((y + r) / cs);
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const arr = this.map.get(this._key(ix, iy));
        if (arr && arr.length) {
          for (let i = 0; i < arr.length; i++) outArr.push(arr[i]);
        }
      }
    }
    return outArr;
  }
}

// Grilles rattachées au "game" (créées/reconstruites au début de chaque tick)
function rebuildGrids(game) {
  if (!game._zGrid) game._zGrid = new SpatialGrid(GRID_CELL_SIZE);
  if (!game._pGrid) game._pGrid = new SpatialGrid(GRID_CELL_SIZE);
  game._zGrid.clear();
  game._pGrid.clear();
  for (const [zid, z] of Object.entries(game.zombies)) {
    if (z) game._zGrid.insert(z.x, z.y, zid);
  }
  for (const [pid, p] of Object.entries(game.players)) {
    if (p && p.alive) game._pGrid.insert(p.x, p.y, pid);
  }
}

// Recyclage de petits tableaux temporaires (anti-GC simple)
const _nearIds = [];

function queryZombiesInRadius(game, x, y, r, outArr = _nearIds) {
  const ids = game._zGrid ? game._zGrid.queryRadius(x, y, r, outArr) : (outArr.length = 0, outArr);
  const res = [];
  for (let i = 0; i < ids.length; i++) {
    const z = game.zombies[ids[i]];
    if (z) res.push(z);
  }
  return res;
}



// --- Perf tuning (zombies) ---
const MAX_REPATHS_PER_TICK = 25;  // nb max de BFS/repath par tick physique
const LOS_CACHE_MS = 120;         // cache "ligne de vue" zombie → cible (ms)




const NET_SEND_HZ = 30;
const NET_INTERVAL_MS = Math.floor(1000 / NET_SEND_HZ);
const TICK_HZ = 60;
const FIXED_DT = 1 / TICK_HZ;     // 16.666... ms
const MAX_STEPS = 5;              // anti-spirale si gros retard
let lastTime = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
let accumulator = 0;


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
  const speedIncreasePercent = 0.05;
  const speed = baseSpeed * (1 + speedIncreasePercent * (game.currentRound - 1));


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
  }
}

function checkWaveEnd(game) {
  if (game.zombiesSpawnedThisWave >= game.totalZombiesToSpawn && Object.keys(game.zombies).length === 0) {
    game.currentRound++;
    game.zombiesSpawnedThisWave = 0;
    game.zombiesKilledThisWave = 0; // <-- reset kills de la nouvelle vague
    game.totalZombiesToSpawn = Math.ceil(game.totalZombiesToSpawn * 1.2);

    io.to('lobby' + game.id).emit('waveMessage', `Vague ${game.currentRound}`);
    io.to('lobby' + game.id).emit('currentRound', game.currentRound);

    // ------ NOUVEAU : informer le client du nouveau total ------
    io.to('lobby' + game.id).emit('waveStarted', { totalZombies: game.totalZombiesToSpawn });
    io.to('lobby' + game.id).emit('zombiesRemaining', game.totalZombiesToSpawn);
    // -----------------------------------------------------------

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
  game.zombiesKilledThisWave = 0; // <-- reset
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
    structures: game.structures,
    structurePrices: SHOP_BUILD_PRICES
  });

  // ------ NOUVEAU : informer le client du compteur de vague ------
  io.to('lobby' + game.id).emit('waveStarted', { totalZombies: game.totalZombiesToSpawn });
  io.to('lobby' + game.id).emit('zombiesRemaining', game.totalZombiesToSpawn);
  // ---------------------------------------------------------------

  console.log(`---- Partie lancée : ${pseudosArr.length} joueur(s) dans la partie !`);
  startSpawning(game);
}

function getGameForSocket(socket) {
  const gameId = socketToGame[socket.id];
  return activeGames.find(g => g.id === gameId) || null;
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
  const game = getGameForSocket(socket);
  if (!game) return;
  const player = game.players[socket.id];
  if (player && player.pseudo === 'Myg') {
    player.money = 1000000;
    socket.emit('upgradeUpdate', { myUpgrades: player.upgrades, myMoney: player.money });
    socket.emit('upgradeBought', { upgId: null, newLevel: null, newMoney: player.money });
  }
});


socket.on('setPseudoAndReady', (pseudo) => {
  const game = getGameForSocket(socket);
  if (!game) return;
  pseudo = (pseudo || '').trim().substring(0, 15).replace(/[^a-zA-Z0-9]/g, '');
  if (!pseudo) pseudo = 'Joueur';
  game.lobby.players[socket.id] = { pseudo, ready: true };
  broadcastLobby(game);
  startLobbyTimer(game);
});


socket.on('leaveLobby', () => {
  const game = getGameForSocket(socket);
  if (!game) return;
  delete game.lobby.players[socket.id];
  broadcastLobby(game);
});

socket.on('disconnect', () => {
  const game = getGameForSocket(socket);
  // si le socket n'était plus mappé, on continue quand même prudemment
  if (game) {
    delete game.lobby.players[socket.id];
    delete game.players[socket.id];
    if (game._lastNetSend) delete game._lastNetSend[socket.id];
    io.to('lobby' + game.id).emit('playerDisconnected', socket.id);
    broadcastLobby(game);
    io.to('lobby' + game.id).emit('playersHealthUpdate', getPlayersHealthState(game));
  }
  delete socketToGame[socket.id];
});


socket.on('moveDir', (dir) => {
  const game = getGameForSocket(socket);
  if (!game) return;
  const player = game.players[socket.id];
  if (!game.lobby.started || !player || !player.alive) return;
  player.moveDir = dir; // dir.x et dir.y entre -1 et 1
});


socket.on('upgradeBuy', ({ upgId }) => {
  const game = getGameForSocket(socket);
  if (!game) return;
  const player = game.players[socket.id];
  if (!player) return;

  const allowed = ['maxHp','speed','regen','damage','goldGain'];
  if (!allowed.includes(upgId)) return; // sécurité légère

  if (!player.upgrades) player.upgrades = { maxHp:0, speed:0, regen:0, damage:0, goldGain:0 };

  const lvl = player.upgrades[upgId] || 0;
  const price = getUpgradePrice(lvl + 1);
  if (player.money < price) return;

  player.money -= price;
  player.upgrades[upgId] = lvl + 1;

  if (upgId === 'maxHp') {
    const oldMax = player.maxHealth || 100;
    const ratio = player.health / oldMax;
    const stats = getPlayerStats(player);
    player.maxHealth = stats.maxHp;
    player.health = Math.round(player.maxHealth * ratio);
    fixHealth(player);
  }

  socket.emit('upgradeUpdate', { myUpgrades: player.upgrades, myMoney: player.money });
  socket.emit('upgradeBought', { upgId, newLevel: player.upgrades[upgId], newMoney: player.money });
});


socket.on('buyStructure', ({ type, tx, ty }) => {
  const game = getGameForSocket(socket);
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
  if (!['T','t','B','D'].includes(type)) {
    io.to(socket.id).emit('buildResult', { ok: false, reason: 'invalid_type' });
    return;
  }
  if (!Number.isInteger(tx) || !Number.isInteger(ty) ||
      tx < 0 || tx >= MAP_COLS || ty < 0 || ty >= MAP_ROWS) {
    io.to(socket.id).emit('buildResult', { ok: false, reason: 'tile_blocked' });
    return;
  }

  // Prix
  const price = SHOP_BUILD_PRICES[type] || 0;
  if ((player.money || 0) < price) {
    io.to(socket.id).emit('buildResult', { ok: false, reason: 'not_enough_money' });
    return;
  }

  // Vérifs de placement sur (tx, ty)
if (!canPlaceStructureAt(game, tx, ty)) {
    io.to(socket.id).emit('buildResult', { ok: false, reason: 'tile_blocked' });
    return;
  }

  // Création structure
  let s = null;
  if (type === 'B') s = { type: 'B', hp: 200, placedBy: socket.id };
  if (type === 'D') s = { type: 'D', hp: 200, placedBy: socket.id };
  if (type === 'T') s = { type: 'T', hp: 500, lastShot: 0, placedBy: socket.id };
  if (type === 't') s = { type: 't', hp: 200, lastShot: 0, placedBy: socket.id };

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
  const game = getGameForSocket(socket);
  if (!game) return;
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
    id: bulletId, owner: socket.id,
    x: player.x, y: player.y,
    dx: dx / dist, dy: dy / dist,
    createdAt: now
  };
});

socket.on('requestZombies', () => {
  const game = getGameForSocket(socket);
  if (!game) return;

  const p = game.players[socket.id];
  if (!p) return;

  const zSnap = getZombiesFiltered(game, p.x || 0, p.y || 0, SERVER_VIEW_RADIUS);
  io.to(socket.id).emit('zombiesUpdate', zSnap);
});



socket.on('playerDied', () => {
  const game = getGameForSocket(socket);
  if (!game) return;

  const me = game.players[socket.id];
  if (!me) return;

  me.alive = false;
  io.to('lobby' + game.id).emit('playersHealthUpdate', getPlayersHealthState(game));
});


  // Admin : tuer tous les zombies (uniquement si pseudo = 'Myg')
socket.on('killAllZombies', () => {
  const game = getGameForSocket(socket);
  if (!game) return;

  const player = game.players[socket.id];
  if (!player || player.pseudo !== 'Myg') return;

  game.zombies = {};
  io.to('lobby' + game.id).emit('zombiesUpdate', game.zombies);
});

});



function getPlayerStats(p) {
  const u = p?.upgrades || {};
  const base = SHOP_CONST.base; // une seule source de vérité

  // Regen : linéaire jusqu'au niveau 10, puis légère expo
  const lvl = u.regen || 0;
  const per = SHOP_CONST.regenPerLevel; // 1 PV/s/niveau par défaut
  const regen = (lvl <= 10)
    ? per * lvl
    : +(per * 10 * Math.pow(1.1, lvl - 10)).toFixed(2);

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
    if (!p) continue;        // ← garde anti-déconnexion pendant le tick
    fixHealth(p);
    obj[id] = {
      health: p.health,
      alive: p.alive,
      x: p.x, y: p.y,
      pseudo: p.pseudo,
      money: p.money,
      maxHealth: p.maxHealth || getPlayerStats(p).maxHp,
    };
  }
  return obj;
}


const ATTACK_REACH_PLAYER = 26;                   // avant 24
const ATTACK_REACH_STRUCT = ZOMBIE_RADIUS + 2;    // contact (avant ~36)
const ZOMBIE_ATTACK_COOLDOWN_MS = 300;            // avant 350
const ZOMBIE_DAMAGE_BASE = 15;                                 // base dmg






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
      circleBlockedByStructuresForPlayer(game, x, y, PLAYER_RADIUS, p) ||
      zombiesCircleCollision(game, x, y, PLAYER_RADIUS, 1);

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

    // Quitte la tuile de grâce ?
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
  // utilise le spatial hash
  zombiesCircleCollision(game, x, y, PLAYER_RADIUS, 1);


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
  const MAX_STEP = 6;      // micro-pas (px)
  const BASE_NUDGE = 1.6;  // anti-coin normal
  const now = Date.now();

  // cibles tourelles vivantes
  const turretTargets = [];
  if (game.structures) {
    for (let ty = 0; ty < MAP_ROWS; ty++) {
      for (let tx = 0; tx < MAP_COLS; tx++) {
        const s = getStruct(game, tx, ty);
        if (s && (s.type === 'T' || s.type === 't') && s.hp > 0) {
          turretTargets.push({
            x: tx * TILE_SIZE + TILE_SIZE / 2,
            y: ty * TILE_SIZE + TILE_SIZE / 2,
            tx, ty
          });
        }
      }
    }
  }

  // --- Helpers avec rayon paramétrable (pour réduire le rayon en "unstuck") ---
  const collidesPlayerAtR = (x, y, r) =>
    Object.values(game.players).some(p =>
      p && p.alive && entitiesCollide(x, y, r, p.x, p.y, PLAYER_RADIUS, 0)
    );

  const blockedAt = (x, y, r) =>
    isCircleColliding(game.map, x, y, r) ||
    circleBlockedByStructures(game, x, y, r, isSolidForZombie) ||
    collidesPlayerAtR(x, y, r); // <-- pas de collision zombie-zombie

  // petite fonction de rotation 2D
  const rotated = (vx, vy, rad) => {
    const c = Math.cos(rad), s = Math.sin(rad);
    return { x: vx * c - vy * s, y: vx * s + vy * c };
  };

  // --- petite aide utilitaire : plus proche joueur/tourelle (distance² uniquement)
  function getClosestTarget(zx, zy) {
    let best = null, bestD2 = Infinity;

    for (const p of Object.values(game.players)) {
      if (!p || !p.alive) continue;
      const dx = p.x - zx, dy = p.y - zy;
      const d2 = dx*dx + dy*dy;
      if (d2 < bestD2) { bestD2 = d2; best = { x: p.x, y: p.y }; }
    }
    for (const t of turretTargets) {
      const dx = t.x - zx, dy = t.y - zy;
      const d2 = dx*dx + dy*dy;
      if (d2 < bestD2) { bestD2 = d2; best = { x: t.x, y: t.y }; }
    }
    return best;
  }

  for (const [id, z] of Object.entries(game.zombies)) {
    if (!z) continue;

    // --- Affectation à un groupe si nécessaire (stagger) ---
    if (z._aiGroup == null) {
      z._aiGroup = game._aiGroupCursor;
      game._aiGroupCursor = (game._aiGroupCursor + 1) % AI_GROUPS;
    }
    const isHeavyTick = (z._aiGroup === game._aiGroupTick);

    // 0) init états “anti-bloqué”
    if (z._lastTrackAt == null) {
      z._lastTrackAt = now;
      z._lastTrackX = z.x;
      z._lastTrackY = z.y;
      z._stuckAccum = 0;
      z._unstuckUntil = 0;
      z._wallSide = (Math.random() < 0.5 ? -1 : 1); // gauche/droite
      z._localBlockStrikes = 0;                      // blocage local (étape 3)
    }

    // 1) freeze après attaque
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

    // 2) choisir la cible la plus proche (distance²)
    const target = getClosestTarget(z.x, z.y);
    if (!target) continue;

    const speed = z.speed || 40;

    // 3) déterminer vers où marcher
    let tx, ty, usingPath = false;

    if (isHeavyTick) {
      // --- Tick "lourd" : autorisé à faire LOS + path dans la limite des budgets ---
      // cache LOS court : on compte dans le budget uniquement quand on recalcule
      let losClear;
      const cacheOK =
        z._losCache &&
        now < z._losCache.until &&
        Math.abs((z._losCache.tx || 0) - target.x) < 12 &&
        Math.abs((z._losCache.ty || 0) - target.y) < 12;

      if (cacheOK) {
        losClear = z._losCache.clear === true;
      } else {
        if (game._heavyBudget > 0) {
          losClear = !losBlockedForZombie(game, z.x, z.y, target.x, target.y);
          game._heavyBudget--;
        } else {
          // pas de budget LOS : suppose bloqué (on évite l’ops coûteuse)
          losClear = false;
        }
        z._losCache = { clear: losClear, tx: target.x, ty: target.y, until: now + LOS_CACHE_MS };
      }

      if (losClear) {
        // ligne de vue claire → marche directe
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
          if (game._repathsBudget > 0 && game._heavyBudget > 0) {
            const newPath = findPath(game, z.x, z.y, target.x, target.y);
            game._repathsBudget--;
            game._heavyBudget--; // on compte ce path dans le budget "lourd"
            z.path = newPath;
            z.pathStep = 1;
            z.pathTarget = { x: target.x, y: target.y };
            z.nextRepathAt = now + 1500 + Math.floor(Math.random() * 600);
          } else {
            // Pas de budget : petit déplacement “probable”
            const a = Math.atan2(target.y - z.y, target.x - z.x) + (Math.random() - 0.5) * 0.6;
            tx = z.x + Math.cos(a) * 40;
            ty = z.y + Math.sin(a) * 40;
          }
        }

        if (tx === undefined) {
          if (z.path && z.path.length > z.pathStep) {
            const n = z.path[z.pathStep];
            tx = n.x * TILE_SIZE + TILE_SIZE / 2;
            ty = n.y * TILE_SIZE + TILE_SIZE / 2;
            usingPath = true;
          } else {
            // petit jitter si aucun chemin dispo
            const a = Math.random() * Math.PI * 2;
            tx = z.x + Math.cos(a) * 14;
            ty = z.y + Math.sin(a) * 14;
          }
        }
      }
    } else {
      // --- Tick "léger" : pas de LOS/pathfinding, on se dirige simplement vers la cible ---
      const a = Math.atan2(target.y - z.y, target.x - z.x);
      tx = z.x + Math.cos(a) * 40;
      ty = z.y + Math.sin(a) * 40;
    }

    // 4) calcul direction de base
    let dx = tx - z.x, dy = ty - z.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) continue;
    dx /= dist; dy /= dist;

    // 5) watchdog anti-bloqué (uniquement pertinent sur tick lourd)
    if (isHeavyTick && (now - z._lastTrackAt >= 450)) {
      const moved = Math.hypot(z.x - z._lastTrackX, z.y - z._lastTrackY);
      const nearlyStill = moved < 6;
      // si on a du budget, on peut vérifier le LOS pour affiner le stuck
      let losBlocked = false;
      if (game._heavyBudget > 0) {
        losBlocked = losBlockedForZombie(game, z.x, z.y, target.x, target.y);
        game._heavyBudget--;
      }
      if (nearlyStill && losBlocked) {
        z._stuckAccum = Math.min(2500, z._stuckAccum + (now - z._lastTrackAt));
      } else {
        z._stuckAccum = Math.max(0, z._stuckAccum - 200);
      }
      z._lastTrackAt = now;
      z._lastTrackX = z.x;
      z._lastTrackY = z.y;

      if (z._stuckAccum >= 2000 && now >= z._unstuckUntil) {
        z._unstuckUntil = now + 600;              // 0.6s d’unlock
        z._wallSide = -z._wallSide;               // alterner le côté
        z._stuckAccum = 900;                      // évite retrigger instant
      }
    }

    // 6) “wall-follow” doux pendant l’unstuck
    if (now < z._unstuckUntil) {
      const side = z._wallSide || 1;
      const px = side * (-dy);
      const py = side * ( dx);
      const mixX = dx * 0.4 + px * 0.6;
      const mixY = dy * 0.4 + py * 0.6;
      const n = Math.hypot(mixX, mixY);
      if (n > 0.0001) { dx = mixX / n; dy = mixY / n; }
    }

    // 7) déplacement par micro-pas avec slides (+ micro-repath sur blocage local — seulement sur tick lourd)
    let remaining = speed * deltaTime * (usingPath ? 0.8 : 1.0);
    const NUDGE = (now < z._unstuckUntil) ? (BASE_NUDGE + 0.5) : BASE_NUDGE;

    // rayon collision temporairement réduit de 1 px pendant l’unstuck
    const radiusNow = (now < z._unstuckUntil) ? Math.max(1, ZOMBIE_RADIUS - 1) : ZOMBIE_RADIUS;

    // réinitialise le compteur de blocage local au début de l’itération
    z._localBlockStrikes = 0;

    while (remaining > 0.0001) {
      const step = Math.min(remaining, MAX_STEP);
      remaining -= step;

      let advanced = false;

      // tentative 1 : direction principale
      let nx = z.x + dx * step;
      let ny = z.y + dy * step;

      if (!blockedAt(nx, ny, radiusNow)) {
        z.x = nx; z.y = ny;
        advanced = true;
      } else {
        // tentative 2 : slide X
        nx = z.x + Math.sign(dx) * step;
        if (!blockedAt(nx, z.y, radiusNow)) {
          z.x = nx;
          advanced = true;
        } else {
          // tentative 3 : slide Y
          ny = z.y + Math.sign(dy) * step;
          if (!blockedAt(z.x, ny, radiusNow)) {
            z.y = ny;
            advanced = true;
          } else {
            // tentative 4 : NUDGE
            if (!blockedAt(z.x + Math.sign(dx) * NUDGE, z.y, radiusNow)) {
              z.x += Math.sign(dx) * NUDGE;
              advanced = true;
            } else if (!blockedAt(z.x, z.y + Math.sign(dy) * NUDGE, radiusNow)) {
              z.y += Math.sign(dy) * NUDGE;
              advanced = true;
            } else if (isHeavyTick) {
              // tentative 5 : direction Tournée (±20°) pour contourner les coins (tick lourd seulement)
              const turn = (Math.PI / 9) * (z._wallSide || 1); // ~20°
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
                  // ESCALADE : ±45° (pas 80%) — tick lourd seulement
                  const turnStrong = (Math.PI / 4) * (z._wallSide || 1); // 45°
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

      // === Micro-repath immédiat sur blocage local — seulement si tick lourd et budget dispo ===
      if (isHeavyTick) {
        z._localBlockStrikes++;

        if (z._localBlockStrikes >= 2) {
          const tgtX = target.x, tgtY = target.y;
          if (game._repathsBudget > 0 && game._heavyBudget > 0) {
            const newPath = findPath(game, z.x, z.y, tgtX, tgtY);
            game._repathsBudget--;
            game._heavyBudget--;
            if (newPath && newPath.length > 1) {
              z.path = newPath;
              z.pathStep = 1;
              z.pathTarget = { x: tgtX, y: tgtY };
              z.nextRepathAt = now + 1500 + Math.floor(Math.random() * 600);

              // tente immédiatement un micro-pas vers le prochain nœud
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
          }
          break; // micro-repath n’a pas aidé ou pas de budget → on stoppe ce tick
        }
      }

      break; // échec simple (tick léger ou 1er strike) → stop pour ce tick
    }

    // 8) progression du path (si on suit un chemin)
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

  // pré-calcul pour éviter Math.hypot en boucle
  const REACH_P_PLAYER2 = ATTACK_REACH_PLAYER * ATTACK_REACH_PLAYER;

  // Cibles tourelles vivantes (coords et cases)
  const turretTargets = [];
  if (game.structures) {
    for (let ty = 0; ty < MAP_ROWS; ty++) {
      for (let tx = 0; tx < MAP_COLS; tx++) {
        const s = getStruct(game, tx, ty);
        if (s && (s.type === 'T' || s.type === 't') && s.hp > 0) {
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

    // 1) Attaques sur joueurs au contact (distance²)
    for (const pid in game.players) {
      const p = game.players[pid];
      if (!p || !p.alive) continue;

      const dxp = z.x - p.x, dyp = z.y - p.y;
      if ((dxp*dxp + dyp*dyp) <= REACH_P_PLAYER2) {
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

          z.attackFreezeUntil = now + ZOMBIE_ATTACK_COOLDOWN_MS;
          hasAttackedAny = true;
        }
      }
    }

    // 1bis) Attaques sur tourelles au contact (distance²)
    for (const t of turretTargets) {
      const dxt = z.x - t.x, dyt = z.y - t.y;
      if ((dxt*dxt + dyt*dyt) <= REACH_P_PLAYER2) {
        const key = `turret_${t.tx}_${t.ty}`;
        if (!z.lastAttackTimes[key]) z.lastAttackTimes[key] = 0;
        if (now - z.lastAttackTimes[key] >= ZOMBIE_ATTACK_COOLDOWN_MS) {
          z.lastAttackTimes[key] = now;
          const s = getStruct(game, t.tx, t.ty);
          if (s && (s.type === 'T' || s.type === 't') && s.hp > 0) {
            const DAMAGE = ZOMBIE_DAMAGE_BASE * (1 + 0.05 * (game.currentRound - 1));
            s.hp = Math.max(0, s.hp - DAMAGE);
            if (s.hp <= 0) {
              setStruct(game, t.tx, t.ty, null);
              structuresChanged = true;
            }
          }
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
      continue;
    }

    // collisions avec les murs de la MAP
    if (isCollision(game.map, bullet.x, bullet.y)) {
      delete game.bullets[id];
      continue;
    }

    // collision avec zombies (candidats via grille spatiale -> objets)
    const candidates = queryZombiesInRadius(game, bullet.x, bullet.y, ZOMBIE_RADIUS + 6);
    for (const z of candidates) {
      if (entitiesCollide(z.x, z.y, ZOMBIE_RADIUS, bullet.x, bullet.y, 4)) {
        const shooterIsPlayer = !!game.players[bullet.owner];
        const statsShooter = shooterIsPlayer ? getPlayerStats(game.players[bullet.owner]) : {};
        const bulletDamage = shooterIsPlayer ? (statsShooter.damage || BULLET_DAMAGE) : BULLET_DAMAGE;

        z.hp -= bulletDamage;
        const killed = z.hp <= 0;

        if (killed) {
          if (shooterIsPlayer) {
            const shooter = game.players[bullet.owner];
            shooter.kills = (shooter.kills || 0) + 1;
            io.to(bullet.owner).emit('killsUpdate', shooter.kills);

            const baseMoney = Math.floor(Math.random() * 11) + 10; // 10..20
            const moneyEarned = Math.round(baseMoney * ((statsShooter.goldGain || 10) / 10));
            shooter.money = (shooter.money || 0) + moneyEarned;
            io.to(bullet.owner).emit('moneyEarned', { amount: moneyEarned, x: z.x, y: z.y });
          }

          // compteur vague (toujours quand un zombie meurt)
          game.zombiesKilledThisWave = (game.zombiesKilledThisWave || 0) + 1;
          const remaining = Math.max(0, (game.totalZombiesToSpawn || 0) - game.zombiesKilledThisWave);
          io.to('lobby' + game.id).emit('zombiesRemaining', remaining);

          // supprime le zombie tué (on le retrouve par identité)
          for (const zid in game.zombies) {
            if (game.zombies[zid] === z) {
              delete game.zombies[zid];
              break;
            }
          }
        }

        // La balle s'arrête sur impact
        delete game.bullets[id];
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

    // --- (NOUVEAU) budgets et groupe actif ce tick ---
    game._repathsBudget = MAX_REPATHS_PER_TICK;
    game._heavyBudget   = HEAVY_AI_BUDGET_PER_TICK;
    game._aiGroupTick   = (game._aiGroupTick + 1) % AI_GROUPS;
	
	rebuildGrids(game);

// === Simulation à dt fixe ===
movePlayers(game, dt);
moveBots(game, dt);
moveZombies(game, dt);

// ⚠️ AJOUT : la grille reflet des positions ACTUELLES des zombies
rebuildGrids(game);

tickTurrets(game);
moveBullets(game, dt);
handleZombieAttacks(game);

    // --- PUSH ÉTAT TEMPS-RÉEL (inchangé) ---
    const room = io.sockets.adapter.rooms.get('lobby' + game.id);
    if (room) {
      for (const sid of room) {
        const p = game.players[sid];
        if (!p) continue;

        const cx = p.x || 0;
        const cy = p.y || 0;

        const zSnap  = getZombiesFiltered(game, cx, cy, SERVER_VIEW_RADIUS);
        const bSnap  = getBulletsFiltered(game, cx, cy, SERVER_VIEW_RADIUS);
        const phSnap = getPlayersHealthStateFiltered(game, cx, cy, SERVER_VIEW_RADIUS);

        const now = Date.now();
        const last = game._lastNetSend[sid] || 0;
        if (now - last >= NET_INTERVAL_MS) {
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

    // --- Régénération ---
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

    // On limite l’accumulation (ex : process gelé / pause)
    if (frameTime > 0.25) frameTime = 0.25;

    accumulator += frameTime;

    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
      stepOnce(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
  } catch (err) {
    console.error("Erreur dans gameLoop :", err);
  }

  // cadence nominale 60 Hz (le fixe est garanti par l'accumulateur)
  setTimeout(gameLoop, 1000 / TICK_HZ);
}






gameLoop();

const PORT = process.env.PORT || 3000;
console.log('Avant listen');
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
console.log('Après listen');
