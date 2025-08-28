// Ceci est le fichier gameMap.js :

const MAP_ROWS = 50;
const MAP_COLS = 50;
const OBSTACLE_COUNT = 250; // ← moins d'obstacles pour plus d'espaces ouverts !
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




function placeObstaclesConnected(map, count) {
  const centerR = Math.floor(MAP_ROWS / 2);
  const centerC = Math.floor(MAP_COLS / 2);

  // Rayon (en tuiles) du carré central à laisser VIDE.
  const CENTER_CLEAR_RADIUS_TILES = 6;

  // --- Helpers anti-diagonales (local à cette fonction) ---
  function rectContains(r0, c0, w, h, r, c) {
    return r >= r0 && r < r0 + h && c >= c0 && c < c0 + w;
  }
  // valeur finale (0/1) d'une tuile si on pose le rectangle (r0,c0,w,h)
  function finalTileValue(r0, c0, w, h, r, c) {
    if (r < 0 || c < 0 || r >= MAP_ROWS || c >= MAP_COLS) return 1; // hors carte = mur
    if (rectContains(r0, c0, w, h, r, c)) return 1; // fera partie du nouveau bloc
    return map[r][c];
  }
  // true si la pose du rectangle créerait un contact purement diagonal (sans voisin orthogonal)
  function wouldCreateDiagonalAdjacency(r0, c0, w, h) {
    // on parcourt uniquement le contour du rectangle (optimisation simple)
    for (let rr = r0; rr < r0 + h; rr++) {
      for (let cc = c0; cc < c0 + w; cc++) {
        // quatre diagonales autour de (rr,cc)
        const diag = [[-1,-1],[-1,1],[1,-1],[1,1]];
        for (const [dr, dc] of diag) {
          const r2 = rr + dr, c2 = cc + dc;
          if (r2 < 0 || c2 < 0 || r2 >= MAP_ROWS || c2 >= MAP_COLS) continue;
          // existe-t-il déjà un mur en diagonale ?
          if (map[r2][c2] !== 1) continue;

          // Les deux orthogonaux reliés à cette diagonale doivent être vides après pose
          // orthos: (rr+dr, cc) et (rr, cc+dc)
          const ortho1 = finalTileValue(r0, c0, w, h, rr + dr, cc);
          const ortho2 = finalTileValue(r0, c0, w, h, rr, cc + dc);

          if (ortho1 === 0 && ortho2 === 0) {
            // Cela créerait un coin qui ne touche qu'en diagonale → interdit
            return true;
          }
        }
      }
    }
    return false;
  }

  let placed = 0;
  let attempts = 0;

  while (placed < count && attempts < count * 12) {
    attempts++;

    const w = Math.floor(Math.random() * 3) + 1; // largeur 1..3
    const h = Math.floor(Math.random() * 3) + 1; // hauteur 1..3
    const r = Math.floor(Math.random() * (MAP_ROWS - h - 2)) + 1;
    const c = Math.floor(Math.random() * (MAP_COLS - w - 2)) + 1;

    // --- EXCLUSION stricte du carré central ---
    let touchesCenter = false;
    for (let rr = r; rr < r + h && !touchesCenter; rr++) {
      for (let cc = c; cc < c + w; cc++) {
        if (
          Math.abs(rr - centerR) <= CENTER_CLEAR_RADIUS_TILES &&
          Math.abs(cc - centerC) <= CENTER_CLEAR_RADIUS_TILES
        ) {
          touchesCenter = true;
          break;
        }
      }
    }
    if (touchesCenter) continue;

    // Ne pas écraser des murs existants
    let overlaps = false;
    for (let rr = r; rr < r + h && !overlaps; rr++) {
      for (let cc = c; cc < c + w; cc++) {
        if (map[rr][cc] === 1) { overlaps = true; break; }
      }
    }
    if (overlaps) continue;

    // 🚫 Nouveau : refuse toute pose qui créerait un contact purement diagonal
    if (wouldCreateDiagonalAdjacency(r, c, w, h)) continue;

    // Placement temporaire
    const coords = [];
    for (let rr = r; rr < r + h; rr++) {
      for (let cc = c; cc < c + w; cc++) {
        coords.push([rr, cc]);
        map[rr][cc] = 1;
      }
    }

    // Conserver uniquement si la map reste connectée depuis le centre
    if (isFullyConnected(map, centerR, centerC)) {
      placed++;
    } else {
      // Annuler si ça coupe l’accessibilité
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