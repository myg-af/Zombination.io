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
    // ---- Spatial grid for dynamic entities ----
    _egrid: new Map(),           // key "cx,cy" -> { z: Set<zid>, p: Set<pid> }
    _cellSize: Math.max(16, TILE_SIZE | 0),
    _turrets: [],
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
    setStruct(game, c, r0, { type: 'B', hp: 200 });
    setStruct(game, c, r1, { type: 'B', hp: 200 });
  }
  for (let r = r0; r <= r1; r++) {
    setStruct(game, c0, r, { type: 'B', hp: 200 });
    setStruct(game, c1, r, { type: 'B', hp: 200 });
  }

  // 5) Portes au milieu de chaque côté (HP = 200)
  const midC = Math.floor((c0 + c1) / 2);
  const midR = Math.floor((r0 + r1) / 2);
  setStruct(game, midC, r0, { type: 'D', hp: 200 });
  setStruct(game, midC, r1, { type: 'D', hp: 200 });
  setStruct(game, c0, midR, { type: 'D', hp: 200 });
  setStruct(game, c1, midR, { type: 'D', hp: 200 });

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



// ====== Spatial grid helpers (entities) + Int16 conversions ======
const _egBounds16 = new Int16Array(4); // [minCx, maxCx, minCy, maxCy]
function clampInt16(n) {
  n = n | 0;
  if (n > 32767) return 32767;
  if (n < -32768) return -32768;
  return n;
}
function toCellCoord(x, cellSize) {
  // floor then clamp to int16
  return clampInt16((x / cellSize) | 0);
}
function egKey(cx, cy) { return cx + ',' + cy; }

function egEnsure(game) {
  if (!game._egrid) game._egrid = new Map();
  if (!game._cellSize) game._cellSize = Math.max(16, TILE_SIZE | 0);
}

function egAdd(game, type, id, x, y) {
  egEnsure(game);
  const cx = toCellCoord(x, game._cellSize);
  const cy = toCellCoord(y, game._cellSize);
  const key = egKey(cx, cy);
  let bucket = game._egrid.get(key);
  if (!bucket) { bucket = { z: new Set(), p: new Set() }; game._egrid.set(key, bucket); }
  bucket[type].add(id);
  const obj = type === 'z' ? game.zombies[id] : game.players[id];
  if (obj) { obj._egCx16 = cx; obj._egCy16 = cy; } // stocké en int16
}

function egMove(game, type, id, x, y) {
  const obj = type === 'z' ? game.zombies[id] : game.players[id];
  if (!obj) return;
  const oldCx = obj._egCx16, oldCy = obj._egCy16;
  const newCx = toCellCoord(x, game._cellSize);
  const newCy = toCellCoord(y, game._cellSize);
  if (oldCx === newCx && oldCy === newCy) return;
  // remove from old
  if (oldCx !== undefined && oldCy !== undefined) {
    const oldKey = egKey(oldCx, oldCy);
    const bucket = game._egrid.get(oldKey);
    if (bucket) { bucket[type].delete(id); if (bucket.z.size===0 && bucket.p.size===0) game._egrid.delete(oldKey); }
  }
  // add to new
  const key = egKey(newCx, newCy);
  let bucket = game._egrid.get(key);
  if (!bucket) { bucket = { z: new Set(), p: new Set() }; game._egrid.set(key, bucket); }
  bucket[type].add(id);
  obj._egCx16 = newCx; obj._egCy16 = newCy;
}

function egRemove(game, type, id) {
  const obj = type === 'z' ? game.zombies[id] : game.players[id];
  if (!obj) return;
  const cx = obj._egCx16, cy = obj._egCy16;
  if (cx === undefined || cy === undefined) return;
  const key = egKey(cx, cy);
  const bucket = game._egrid.get(key);
  if (bucket) { bucket[type].delete(id); if (bucket.z.size===0 && bucket.p.size===0) game._egrid.delete(key); }
  delete obj._egCx16; delete obj._egCy16;
}

function egQueryZombiesInCircle(game, cx, cy, r) {
  egEnsure(game);
  const cs = game._cellSize;
  _egBounds16[0] = toCellCoord(cx - r, cs);
  _egBounds16[1] = toCellCoord(cx + r, cs);
  _egBounds16[2] = toCellCoord(cy - r, cs);
  _egBounds16[3] = toCellCoord(cy + r, cs);
  const minCx = _egBounds16[0], maxCx = _egBounds16[1];
  const minCy = _egBounds16[2], maxCy = _egBounds16[3];
  const r2 = r * r;
  const outIds = [];
  for (let cY = minCy; cY <= maxCy; cY++) {
    for (let cX = minCx; cX <= maxCx; cX++) {
      const bucket = game._egrid.get(egKey(cX, cY));
      if (!bucket) continue;
      for (const zid of bucket.z) {
        const z = game.zombies[zid];
        if (!z) continue;
        const dx = z.x - cx, dy = z.y - cy;
        if (dx*dx + dy*dy <= r2) outIds.push(zid);
      }
    }
  }
  return outIds;
}

function getZombiesFiltered(game, cx, cy, r) {
  if (game && game._egrid) {
    const out = {};
    const ids = egQueryZombiesInCircle(game, cx, cy, r);
    for (const zid of ids) {
      const z = game.zombies[zid];
      if (z) out[zid] = z;
    }
    return out;
  }
  // Fallback
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

  // (fix) do NOT reset entity spatial grid when placing structures

  const prev = game.structures[ty][tx];
  const prevIsTurret = !!(prev && (prev.type === 'T' || prev.type === 't') && prev.hp > 0);
  const nextIsTurret = !!(s && (s.type === 'T' || s.type === 't') && s.hp > 0);

  if (prevIsTurret && !nextIsTurret) game._turretCount = Math.max(0, game._turretCount - 1);
  if (!prevIsTurret && nextIsTurret) game._turretCount++;

  game.structures[ty][tx] = s;
  // Maintain fast list of turret tiles
  if (!game._turrets) game._turrets = [];
  const wasTurret = prevIsTurret;
  const isTurret = nextIsTurret;
  const key = tx + ',' + ty;
  if (wasTurret && !isTurret) {
    // remove from list
    game._turrets = game._turrets.filter(t => !(t.tx===tx && t.ty===ty));
  } else if (!wasTurret && isTurret) {
    game._turrets.push({ tx, ty });
  }

}

function canPlaceStructureAt(game, tx, ty, buyerId) {
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
  {
    const center = worldToTile(x, y);
    const s2 = getStruct(game, center.tx, center.ty);
    if (!isGrace(center.tx, center.ty) && isSolidForPlayer(s2)) return true;
  }
  return false;
}



function tickTurrets(game) {
  if (!game?.structures) return;
  game._laserLatestByTurret = game._laserLatestByTurret || new Map();
  const _laserMap = game._laserLatestByTurret;

  const now = Date.now();
  let shotsLeft = TURRET_SHOTS_PER_TICK;
  const zombiesMap = game.zombies || {};

  const turretList = Array.isArray(game._turrets) && game._turrets.length ? game._turrets : null;
  outer_loop:
  if (turretList) {
    for (let i = 0; i < turretList.length; i++) {
      const { tx, ty } = turretList[i];
      const s = getStruct(game, tx, ty);
      if (!s || (s.type !== 'T' && s.type !== 't') || s.hp <= 0) continue;

      if (!s.lastShot) s.lastShot = 0;
      const interval = (s.type === 't') ? MINI_TURRET_SHOOT_INTERVAL : TURRET_SHOOT_INTERVAL;
      if (typeof s._jitterCur !== 'number') s._jitterCur = (Math.random() - 0.5) * TURRET_JITTER_MS;
      if ((now - s.lastShot) < (interval + s._jitterCur)) continue;

      const cx = tx * TILE_SIZE + TILE_SIZE / 2;
      const cy = ty * TILE_SIZE + TILE_SIZE / 2;

      // Keep/validate current target if any
      let target = null, targetId = s._targetId || null;
      if (targetId && zombiesMap[targetId]) {
        const z = zombiesMap[targetId];
        const dx = z.x - cx, dy = z.y - cy;
        const d2 = dx*dx + dy*dy;
        if (d2 <= TURRET_RANGE_SQ && !losBlockedForTurret(game, cx, cy, z.x, z.y) && z.hp > 0) {
          target = z;
        } else {
          targetId = null;
        }
      }

      // Retarget if needed
      if (!target) {
        const lastRet = s._lastRetargetAt || 0;
        if ((now - lastRet) >= TURRET_RETARGET_MS) {
          s._lastRetargetAt = now;
          let best = null, bestId = null, bestDist2 = Infinity;
          for (const zid in zombiesMap) {
            const z = zombiesMap[zid];
            if (!z) continue;
            const dx = z.x - cx, dy = z.y - cy;
            const d2 = dx*dx + dy*dy;
            if (d2 > TURRET_RANGE_SQ) continue;
            if (z.hp <= 0) continue;
            if (losBlockedForTurret(game, cx, cy, z.x, z.y)) continue;
            if (d2 < bestDist2) { bestDist2 = d2; best = z; bestId = zid; if (bestDist2 < 64*64) break; }
          }
          if (best) { target = best; targetId = bestId; s._targetId = bestId; }
        } else {
          continue;
        }
      }

      if (!target) continue;
      if (shotsLeft <= 0) break outer_loop;

      shotsLeft--;
      s.lastShot = now;
      s._jitterCur = (Math.random() - 0.5) * TURRET_JITTER_MS;

      const dmg = (s.type === 'T') ? BULLET_DAMAGE * 2 : BULLET_DAMAGE;
      target.hp -= dmg;

      // FX cache (compact): one per turret
      const __ang = Math.atan2(target.y - cy, target.x - cx);
      const __angDeg = Math.round((__ang * 180/Math.PI)) & 0x1FF;
      _laserMap.set(tx + ',' + ty, { tx, ty, big: (s.type === 'T') ? 1 : 0, x: target.x, y: target.y });

      if (target.hp <= 0) {
        // reward owner
        if (s.placedBy) {
          const ownerPlayer = game.players[s.placedBy];
          if (ownerPlayer) {
            const ownerStats = getPlayerStats(ownerPlayer);
            const baseMoney = Math.floor(Math.random() * 11) + 10;
            const moneyEarned = Math.round(baseMoney * ((ownerStats?.turretBonus || 1)));
            ownerPlayer.money = (ownerPlayer.money || 0) + moneyEarned;
          }
        }
        // delete zombie by id
        if (targetId && zombiesMap[targetId] === target) {
          delete zombiesMap[targetId];
          game._zombieCount = Math.max(0, (game._zombieCount|0) - 1);
          if (s._targetId === targetId) s._targetId = null;
        } else {
          for (const _zid in zombiesMap) {
            if (zombiesMap[_zid] === target) {
              delete zombiesMap[_zid];
              game._zombieCount = Math.max(0, (game._zombieCount|0) - 1);
              if (s._targetId === _zid) s._targetId = null;
              break;
            }
          }
        }
      }
    }
  }

  // ---- Compact FX emission (server-driven, replace mode) ----
  {
    const nowMs = Date.now();
    const EMIT_MS = 150;
    const MAX_TURRETS_PER_EMIT = 12;
    const last = game._lastLaserEmitAt || 0;
    if (_laserMap && _laserMap.size && (nowMs - last) >= EMIT_MS) {
      const payload = Array.from(_laserMap.values());
      if (payload.length > MAX_TURRETS_PER_EMIT) payload.length = MAX_TURRETS_PER_EMIT;
      _laserMap.clear();

      const recips = [];
      for (const pid in game.players) {
        const p = game.players[pid];
        if (!p) continue;
        p._fxNextAt = p._fxNextAt || 0;
        const perPlayerMs = (p.fxLevel === 0) ? 220 : 150;
        if (nowMs < p._fxNextAt) continue;
        const cx = p.x || 0, cy = p.y || 0;
        let visible = false;
        for (let i = 0; i < payload.length; i++) {
          const o = payload[i];
          const ox = o.tx * TILE_SIZE + TILE_SIZE/2;
          const oy = o.ty * TILE_SIZE + TILE_SIZE/2;
          const dx = ox - cx, dy = oy - cy;
          if (dx*dx + dy*dy <= SERVER_VIEW_RADIUS_SQ) { visible = true; break; }
        }
        if (visible) { recips.push(pid); p._fxNextAt = nowMs + perPlayerMs; }
      }

      if (recips.length) {
        game._fxFrame = (game._fxFrame|0) + 1;
        io.to(recips).emit('turretFx', { mode: 'replace', frame: game._fxFrame, list: payload });
      }
      game._lastLaserEmitAt = nowMs;
    }
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

function segmentIntersectsCircle(x1, y1, x2, y2, cx, cy, r) {
  // Compute the projection of C onto segment AB and clamp to [0,1]
  const ABx = x2 - x1, ABy = y2 - y1;
  const ACx = cx - x1, ACy = cy - y1;
  const ab2 = ABx*ABx + ABy*ABy;
  if (ab2 <= 1e-6) {
    // Degenerate segment -> distance point-circle
    const dx = cx - x1, dy = cy - y1;
    return (dx*dx + dy*dy) <= r*r;
  }
  let t = (ACx*ABx + ACy*ABy) / ab2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const px = x1 + ABx * t;
  const py = y1 + ABy * t;
  const dx = cx - px, dy = cy - py;
  return (dx*dx + dy*dy) <= r*r;
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
const TURRET_SHOOT_INTERVAL = 500;
const MINI_TURRET_SHOOT_INTERVAL = 1000;
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


const NET_SEND_HZ = 20;
const NET_INTERVAL_MS = Math.floor(1000 / NET_SEND_HZ);

// --- Modes basse consommation ---
const NET_INTERVAL_IDLE_MS = 250;    // envoi réseau plus rare quand calme
const CALM_TICK_HZ = 10;            // tick serveur si partie(s) calmes (pas d'IA/tourelles/bullets)
const EMPTY_TICK_HZ = 2;            // tick serveur si aucune partie en cours

// Timestamp du dernier tick pour cadence adaptative
let _lastTickAtMs = 0;


const TICK_HZ = 20;
const FIXED_DT = 1 / TICK_HZ;     // 16.666... ms
const MAX_STEPS = 5;              // anti-spirale si gros retard
// Budget courant de pathfinding pour CE tick (réinitialisé dans stepOnce)
let PF_BUDGET_THIS_TICK = 0;

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
    egAdd(game, 'z', id, z.x, z.y);
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
    game.totalZombiesToSpawn = Math.ceil(game.totalZombiesToSpawn * 1.2);

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
  Object.keys(game.players).forEach(id => { egRemove(game,'p', id); delete game.players[id]; });
  Object.keys(game.zombies).forEach(id => { egRemove(game,'z', id); delete game.zombies[id]; });
  Object.keys(game.bullets).forEach(id => delete game.bullets[id]);

  // compteurs O(1)
  game._zombieCount = 0;
  game._bulletCount = 0;
  game._turretCount = 0;

  // (fix) do NOT reset entity spatial grid when placing structures

  game.currentRound = 1;
  game.totalZombiesToSpawn = 50;
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
    const botName = "[Bot]";
    game.players[botId] = {
      x: 0, y: 0, lastShot: 0, alive: true, health: 100, kills: 0,
      pseudo: botName, moveDir: { x: 0, y: 0 }, isBot: true, targetId: null,
      shootCooldown: 0, wanderDir: { x: 0, y: 0 }, wanderChangeTime: 0,
    };
    pseudosArr.push(botName);
    socketsArr.push(botId);
  }

  // (re)construire l’enceinte centrale
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
    egRemove(game, 'p', socket.id);
    delete game.players[socket.id];
	if (game._lastNetSend) delete game._lastNetSend[socket.id];
	delete socketToGame[socket.id];
    io.to('lobby' + game.id).emit('playerDisconnected', socket.id);
    broadcastLobby(game);
    io.to('lobby' + game.id).emit('playersHealthUpdate', getPlayersHealthState(game));
  });

  socket.on('moveDir', (dir) => {
    const player = game.players[socket.id];
    if (!game.lobby.started || !player || !player.alive) return;
    if (typeof dir === 'object') {
      if (typeof dir.seq === 'number') player._lastInputSeq = dir.seq|0;
      player.moveDir = { x: +dir.x || 0, y: +dir.y || 0 };
      // ack to client for reconciliation
      io.to(socket.id).emit('ackInput', { seq: player._lastInputSeq });
    } else {
      player.moveDir = dir;
    }
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
  if (!canPlaceStructureAt(game, tx, ty, socket.id)) {
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
  , prevX: player.x, prevY: player.y };
  game._bulletCount++; // O(1)
});

socket.on('requestZombies', () => {
  const p = game.players[socket.id];
  if (!p) return;
  const zSnap = getZombiesFiltered(game, p.x || 0, p.y || 0, SERVER_VIEW_RADIUS);
  io.to(socket.id).emit('zombiesUpdate', zSnap);
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
  game._zombieCount = 0; // O(1)
  io.to('lobby' + game.id).emit('zombiesUpdate', game.zombies);
});



});

function getPlayerStats(player) {
  const u = player?.upgrades || {};
  const base = { maxHp: 100, speed: 50, regen: 0, damage: 5, goldGain: 10 }; // regen à 0 pour éviter la confusion
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

  // (fix) do NOT reset entity spatial grid when placing structures

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
    // update spatial grid position
    egMove(game, 'p', pid, p.x, p.y);

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
    prevX: bot.x,
    prevY: bot.y,
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

// Test si un cercle (zombie) touche une tuile (structure)}

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
          if (s && (s.type === 'T' || s.type === 't') && s.hp > 0) {
            const DAMAGE = ZOMBIE_DAMAGE_BASE * (1 + 0.05 * (game.currentRound - 1));
            s.hp = Math.max(0, s.hp - DAMAGE);
            if (s.hp <= 0) {
              setStruct(game, t.tx, t.ty, null);
              structuresChanged = true;
            }
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
    // update spatial grid position
    egMove(game, 'z', zid, z.x, z.y);

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
    const _nx = bullet.x + bullet.dx * BULLET_SPEED * deltaTime;
    const _ny = bullet.y + bullet.dy * BULLET_SPEED * deltaTime;
    bullet.prevX = bullet.x; bullet.prevY = bullet.y;
    bullet.x = _nx; bullet.y = _ny;
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
      if (segmentIntersectsCircle(bullet.prevX ?? bullet.x, bullet.prevY ?? bullet.y, bullet.x, bullet.y, z.x, z.y, ZOMBIE_RADIUS + 4)) {
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
          egRemove(game, 'z', zid);
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

        const cx = p.x || 0;
        const cy = p.y || 0;

        const zSnap  = getZombiesFiltered(game, cx, cy, SERVER_VIEW_RADIUS);
        const bSnap  = getBulletsFiltered(game, cx, cy, SERVER_VIEW_RADIUS);
        const phSnap = getPlayersHealthStateFiltered(game, cx, cy, SERVER_VIEW_RADIUS);

        const last = game._lastNetSend[sid] || 0;
        if (now - last >= sendInterval) {
          // Compose a compact binary packet (version 1)
          const buf = buildBinaryStatePacket(zSnap, bSnap, phSnap, game.currentRound);
          io.to(sid).volatile.emit('stateBin', buf);
          // Also keep JSON for backward-compat
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

// ---- Binary state packet (very compact) ----
// Format (little endian):
// u8 version(1), u16 nz, u16 nb, u16 nph, u16 round
// Repeated blocks:
//  - ZOMBIE: u8 'z', u16 idLen, id UTF-8, f32 x, f32 y, u16 hp, u16 maxHp
//  - BULLET: u8 'b', u16 idLen, id UTF-8, f32 x, f32 y, f32 dx, f32 dy, u16 ownerLen, owner UTF-8
//  - PHEALTH: u8 'p', u16 idLen, id UTF-8, f32 x, f32 y, u16 hp, u16 maxHp}

function buildBinaryStatePacket(zSnap, bSnap, phSnap, round) {
  function strlenUtf8(str){ return new TextEncoder().encode(str).length; }
  function writeStr(view, offset, str){
    const bytes = new TextEncoder().encode(str);
    for (let i=0;i<bytes.length;i++) view.setUint8(offset+i, bytes[i]);
    return bytes.length;
  }
  const zEntries = Object.entries(zSnap || {});
  const bEntries = Object.entries(bSnap || {});
  const pEntries = Object.entries(phSnap || {});
  // estimate size
  let size = 1 + 2 + 2 + 2 + 2;
  for (const [id,z] of zEntries) size += 1 + 2 + strlenUtf8(id) + 4 + 4 + 2 + 2;
  for (const [id,b] of bEntries) size += 1 + 2 + strlenUtf8(id) + 4 + 4 + 4 + 4 + 2 + strlenUtf8(String(b.owner||''));
  for (const [id,p] of pEntries) size += 1 + 2 + strlenUtf8(id) + 4 + 4 + 2 + 2;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  let off = 0;
  view.setUint8(off++, 1);
  view.setUint16(off, zEntries.length, true); off+=2;
  view.setUint16(off, bEntries.length, true); off+=2;
  view.setUint16(off, pEntries.length, true); off+=2;
  view.setUint16(off, round & 0xffff, true); off+=2;

  for (const [id,z] of zEntries) {
    view.setUint8(off++, 122); // 'z'
    view.setUint16(off, strlenUtf8(id), true); off+=2;
    off += writeStr(view, off, id);
    view.setFloat32(off, z.x||0, true); off+=4;
    view.setFloat32(off, z.y||0, true); off+=4;
    view.setUint16(off, Math.max(0, Math.min(65535, z.hp|0)), true); off+=2;
    view.setUint16(off, Math.max(0, Math.min(65535, (z.maxHp|0) || (z.maxHealth|0) || 0)), true); off+=2;
  }
  for (const [id,b] of bEntries) {
    view.setUint8(off++, 98); // 'b'
    view.setUint16(off, strlenUtf8(id), true); off+=2;
    off += writeStr(view, off, id);
    view.setFloat32(off, b.x||0, true); off+=4;
    view.setFloat32(off, b.y||0, true); off+=4;
    view.setFloat32(off, b.dx||0, true); off+=4;
    view.setFloat32(off, b.dy||0, true); off+=4;
    const ownerStr = String(b.owner||'');
    view.setUint16(off, strlenUtf8(ownerStr), true); off+=2;
    off += writeStr(view, off, ownerStr);
  }
  for (const [id,p] of pEntries) {
    view.setUint8(off++, 112); // 'p'
    view.setUint16(off, strlenUtf8(id), true); off+=2;
    off += writeStr(view, off, id);
    view.setFloat32(off, p.x||0, true); off+=4;
    view.setFloat32(off, p.y||0, true); off+=4;
    view.setUint16(off, Math.max(0, Math.min(65535, p.health|0)), true); off+=2;
    view.setUint16(off, Math.max(0, Math.min(65535, p.maxHealth|0)), true); off+=2;
  }
  return buf;
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
// Démarrage de la boucle de jeu (appel in-scope)
try { gameLoop(); } catch (e) { console.error('gameLoop indisponible:', e); }








const PORT = process.env.PORT || 3000;
console.log('Avant listen');
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
console.log('Après listen');