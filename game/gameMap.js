// Ceci est le fichier gameMap.js :

const MAP_ROWS = 50;
const MAP_COLS = 50;
const OBSTACLE_COUNT = 200; // ← moins d'obstacles pour plus d'espaces ouverts !
const TILE_SIZE = 40;

// Flood fill pour marquer les cases accessibles
function floodFillAccessible(map, startR, startC) {
  const visited = Array.from({ length: MAP_ROWS }, () => Array(MAP_COLS).fill(false));
  const queue = [[startR, startC]];
  visited[startR][startC] = true;
  const dir = [[1,0],[-1,0],[0,1],[0,-1]];

  while (queue.length) {
    const [r, c] = queue.shift();
    for (const [dr, dc] of dir) {
      const nr = r + dr, nc = c + dc;
      if (
        nr >= 0 && nr < MAP_ROWS &&
        nc >= 0 && nc < MAP_COLS &&
        !visited[nr][nc] &&
        map[nr][nc] === 0
      ) {
        visited[nr][nc] = true;
        queue.push([nr, nc]);
      }
    }
  }
  return visited;
}

function isFullyConnected(map, startR, startC) {
  const visited = floodFillAccessible(map, startR, startC);
  for (let r = 1; r < MAP_ROWS-1; r++) {
    for (let c = 1; c < MAP_COLS-1; c++) {
      if (map[r][c] === 0 && !visited[r][c]) return false;
    }
  }
  return true;
}

function createEmptyMap(rows, cols) {
  const map = [];
  for (let r = 0; r < rows; r++) {
    map[r] = [];
    for (let c = 0; c < cols; c++) {
      if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) {
        map[r][c] = 1;
      } else {
        map[r][c] = 0;
      }
    }
  }
  return map;
}

// Obstacles plus petits (max 3x3)
function placeObstaclesConnected(map, count) {
  const centerR = Math.floor(MAP_ROWS / 2);
  const centerC = Math.floor(MAP_COLS / 2);
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < count * 12) {
    attempts++;
    const w = Math.floor(Math.random() * 3) + 1; // ← taille max 3
    const h = Math.floor(Math.random() * 3) + 1;
    const r = Math.floor(Math.random() * (MAP_ROWS - h - 2)) + 1;
    const c = Math.floor(Math.random() * (MAP_COLS - w - 2)) + 1;

    // Ne bouche jamais le centre ni autour
    let centerBlocked = false;
    for (let rr = r; rr < r + h; rr++) {
      for (let cc = c; cc < c + w; cc++) {
        if (
          map[rr][cc] === 1 ||
          (Math.abs(rr - centerR) <= 2 && Math.abs(cc - centerC) <= 2)
        ) {
          centerBlocked = true;
          break;
        }
      }
      if (centerBlocked) break;
    }
    if (centerBlocked) continue;

    // Place temporairement l'obstacle
    const coords = [];
    for (let rr = r; rr < r + h; rr++) {
      for (let cc = c; cc < c + w; cc++) {
        coords.push([rr, cc]);
        map[rr][cc] = 1;
      }
    }

    // Vérifie que la map reste connectée
    if (isFullyConnected(map, centerR, centerC)) {
      placed++;
    } else {
      // Annule
      for (const [rr, cc] of coords) map[rr][cc] = 0;
    }
  }
}

function generateConnectedMap() {
  let map;
  let tries = 0;
  while (true) {
    map = createEmptyMap(MAP_ROWS, MAP_COLS);
    placeObstaclesConnected(map, OBSTACLE_COUNT);
    if (isFullyConnected(map, Math.floor(MAP_ROWS / 2), Math.floor(MAP_COLS / 2))) {
      break;
    }
    tries++;
    if (tries > 10) break;
  }
  return map;
}

function isCollision(map, x, y) {
  const tileX = Math.floor(x / TILE_SIZE);
  const tileY = Math.floor(y / TILE_SIZE);
  if (tileX < 0 || tileX >= MAP_COLS || tileY < 0 || tileY >= MAP_ROWS) return true;
  return map[tileY][tileX] === 1;
}

function isDiagonalBlocked(map, x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  if (dx > 0 && dy > 0) {
    if (
      isCollision(map, x1, y0) ||
      isCollision(map, x0, y1)
    ) {
      return true;
    }
  }
  return false;
}

module.exports = {
  MAP_ROWS,
  MAP_COLS,
  OBSTACLE_COUNT,
  TILE_SIZE,
  createEmptyMap,
  placeObstacles: placeObstaclesConnected,
  isCollision,
  isDiagonalBlocked,
  generateConnectedMap
};