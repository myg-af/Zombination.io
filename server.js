/*__LOG_TIMESTAMP_FILTER__*/
(function(){
  try {
    var __orig = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug
    };
    function pad(n){ n = n|0; return (n<10?'0':'') + n; }
    function ts(){
      var d = new Date();
      return '[' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ']';
    }
    function shouldSuppress(args){
      try {
        if (!args || !args.length) return false;
        var first = args[0];
        var s = (typeof first === 'string') ? first : String(first || '');
        // Suppress noisy or redundant logs
        if (s.indexOf('[EMIT gameStarted]') !== -1) return true;
        if (/^\[STATS\]\s+total connected:/.test(s)) return true;
        return false;
      } catch(_){ return false; }
    }
    function wrap(name){
      var fn = __orig[name] || console[name];
      if (typeof fn !== 'function') return;
      console[name] = function(){
        try {
          var args = Array.prototype.slice.call(arguments);
          if (shouldSuppress(args)) return;
          if (args.length && typeof args[0] === 'string') {
            if (!/^\[\d{2}:\d{2}:\d{2}\]/.test(args[0])) {
              args[0] = ts() + ' ' + args[0];
            }
          } else {
            args.unshift(ts());
          }
          return fn.apply(console, args);
        } catch(e){
          try { return fn.apply(console, arguments); } catch(_){}
        }
      };
    }
    wrap('log'); wrap('info'); wrap('warn'); wrap('error'); wrap('debug');
  } catch(_){}
})();
/*__/LOG_TIMESTAMP_FILTER__*/

// --- Minimal identity helpers (PostgreSQL-only; no JSON fallback) ---
function normalizeKey(s) {
  try { return String(s||'').trim().toLowerCase().replace(/[^a-z0-9]/g,''); } catch(_){ return ''; }
}
function sanitizeUsername(u) {
  try { return String(u||'').trim().substring(0, 10).replace(/[^a-zA-Z0-9]/g, ''); } catch(_){ return 'Player'; }
}
function isRegisteredUsername(name) {
  try {
    if (!__pgReady || !__registeredUsernames) return false;
    const k = normalizeKey(name);
    return __registeredUsernames.has(k);
  } catch(_){ return false; }
}
// Returns the logged-in username for a given socket.id, or null for guests.
// (Sessions not yet implemented => always null; when auth is added, wire it here.)
// Variant: for WORLD chat only — allow reclaiming a guest pseudo when the only conflict
// is another *connected* socket from the same IP and not a logged-in account.
// This avoids the "Nickname already in use" trap after a quick page refresh.
function isPseudoTakenForWorldChat(name, currentSocketId) {
  try {
    const target = String(name || '').trim().toLowerCase();
    if (!target) return false;
    const socketsMap = (io && io.sockets && io.sockets.sockets) ? io.sockets.sockets : null;
    const curSock = socketsMap ? socketsMap.get(currentSocketId) : null;
    const curIp = curSock ? getClientIP(curSock) : '';
    const curUser = getSessionUsernameBySocketId(currentSocketId) || null;
    // If the candidate is a registered username (reserved) and not owned by this session, treat as taken.
    if (isRegisteredUsername(name) && (!curUser || normalizeKey(curUser) !== normalizeKey(name))) {
      return true;
    }
    for (const g of activeGames) {
      if (!g) continue;
      // Check lobby roster
      try {
        const lp = (g.lobby && g.lobby.players) ? g.lobby.players : {};
        for (const sid in lp) {
          if (sid === currentSocketId) continue;
          const ps = lp[sid] && lp[sid].pseudo;
          if (!ps || String(ps).trim().toLowerCase() !== target) continue;
          if (socketsMap && !socketsMap.get(sid)) continue; // skip stale
          // If the other socket is the same account, allow
          const otherUser = getSessionUsernameBySocketId(sid) || null;
          if (otherUser && curUser && normalizeKey(otherUser) === normalizeKey(curUser)) continue;
          // If both are guests from the same IP, allow (refresh case)
          const otherSock = socketsMap ? socketsMap.get(sid) : null;
          const otherIp = otherSock ? getClientIP(otherSock) : '';
          if (curIp && otherIp && curIp === otherIp && !otherUser && !curUser) continue;
          return true;
        }
      } catch(_) {}
      // Check in-game players (ignore bots)
      try {
        const pl = g.players || {};
        for (const sid in pl) {
          if (sid === currentSocketId) continue;
          const p = pl[sid];
          if (!p || p.isBot) continue;
          if (typeof p.pseudo !== 'string' || p.pseudo.trim().toLowerCase() !== target) continue;
          if (socketsMap && !socketsMap.get(sid)) continue; // skip stale
          const otherUser = getSessionUsernameBySocketId(sid) || null;
          if (otherUser && curUser && normalizeKey(otherUser) === normalizeKey(curUser)) continue;
          const otherSock = socketsMap ? socketsMap.get(sid) : null;
          const otherIp = otherSock ? getClientIP(otherSock) : '';
          if (curIp && otherIp && curIp === otherIp && !otherUser && !curUser) continue;
          return true;
        }
      } catch(_) {}
    }
    return false;
  } catch(_) { return true; } // be conservative on unexpected errors
}
// === Ultra-Robust Multi-Worker Bootstrap (least-loaded assignment) ===
// === Ultra-Robust Multi-Worker Bootstrap (least-loaded assignment) ===
/*__MULTIWORKER_BOOTSTRAP__*/
(function __multiWorkerBootstrap(){
  const cluster = require('cluster');
  const net = require('net');
  // Number of workers (1 = no clustering). Default to 4 if not provided.
  const WORKERS = Math.max(1, parseInt(process.env.WORKERS || '4', 10) || 1);
  const PORT = parseInt(process.env.PORT || '3000', 10);
  // Helper: parse ?w=K from a URL like "/?w=3" (returns NaN if missing)
  function extractWFromUrlPath(urlPath) {
    try {
      if (!urlPath || typeof urlPath !== 'string') return NaN;
      const qIdx = urlPath.indexOf('?');
      if (qIdx < 0) return NaN;
      const qs = urlPath.slice(qIdx + 1).split('&');
      for (const kv of qs) {
        const eq = kv.indexOf('=');
        if (eq > -1) {
          const k = decodeURIComponent(kv.slice(0, eq));
          if (k === 'w') return parseInt(decodeURIComponent(kv.slice(eq + 1)), 10);
        } else if (decodeURIComponent(kv) === 'w') {
          return NaN;
        }
      }
      return NaN;
    } catch (_) { return NaN; }
  }
  // Helper: parse request line path from first HTTP bytes
  function extractPathFromFirstChunk(buf) {
    try {
      const s = buf.toString('utf8');
      const firstLine = s.split('\r\n', 1)[0] || '';
      const parts = firstLine.split(' ');
      return parts[1] || '';
    } catch (_) { return ''; }
  }
  // Helper: parse "Referer" header from first HTTP bytes
  function extractRefererFromFirstChunk(buf) {
    try {
      const s = buf.toString('utf8');
      const lines = s.split('\r\n');
      for (let i=1;i<lines.length;i++){
        const line = lines[i];
        if (!line) break;
        const idx = line.indexOf(':');
        if (idx > 0) {
          const key = line.slice(0, idx).trim().toLowerCase();
          if (key === 'referer') {
            return line.slice(idx+1).trim();
          }
        }
      }
      return '';
    } catch (_) { return ''; }
  }
  
  // Helper: parse Cookie header from first HTTP bytes and extract w=<int>
  function extractCookieWFromFirstChunk(buf) {
    try {
      const s = buf.toString('utf8');
      const lines = s.split('\r\n');
      for (let i=1;i<lines.length;i++) {
        const line = lines[i];
        if (!line) break;
        const idx = line.indexOf(':');
        if (idx > 0) {
          const key = line.slice(0, idx).trim().toLowerCase();
          if (key === 'cookie') {
            const cookieStr = line.slice(idx+1).trim();
            // Parse simple cookie string: "a=1; b=2"
            const parts = cookieStr.split(';');
            for (const p of parts) {
              const eq = p.indexOf('=');
              let ck = '', cv = '';
              if (eq > -1) { ck = p.slice(0,eq).trim(); cv = p.slice(eq+1).trim(); }
              else { ck = p.trim(); cv=''; }
              if (ck === 'w') {
                const v = parseInt(decodeURIComponent(cv), 10);
                if (Number.isFinite(v)) return v;
              }
            }
          }
        }
      }
      return NaN;
    } catch (_) { return NaN; }
  }
// Helper: from a full URL, extract ?w=K
  function extractWFromFullUrl(fullUrl) {
    try {
      if (!fullUrl) return NaN;
      const qIdx = String(fullUrl).indexOf('?');
      if (qIdx < 0) return NaN;
      const qs = String(fullUrl).slice(qIdx + 1).split('&');
      for (const kv of qs) {
        const eq = kv.indexOf('=');
        if (eq > -1) {
          const k = decodeURIComponent(kv.slice(0, eq));
          if (k === 'w') return parseInt(decodeURIComponent(kv.slice(eq + 1)), 10);
        } else if (decodeURIComponent(kv) === 'w') {
          return NaN;
        }
      }
      return NaN;
    } catch (_) { return NaN; }
  }
  if (cluster.isPrimary && WORKERS > 1) {
    console.log('[Master] starting URL-directed cluster with', WORKERS, 'workers on port', PORT);
    const workerByIndex = new Map(); // index (1..N) -> Worker
    function spawnAtIndex(index) {
      const env = Object.assign({}, process.env, {
        IS_CLUSTER_WORKER: '1',
        WORKERS: String(WORKERS),
        WORKER_INDEX: String(index)
      });
      const w = cluster.fork(env);
      workerByIndex.set(index, w);
      w.on('exit', (code, signal) => {
        console.error(`[Master] worker ${index} exited (${code||''} ${signal||''}). Respawning at same index.`);
        // Replace with a new worker at the same index
        spawnAtIndex(index);
      });
      bindWorkerMessages(index, w);
      return w;
    }
    // Spawn all workers with deterministic indices
    // === Joined players live counts (capacity control) ===
    const joinedCounts = new Map(); // index -> joined (players who selected this worker)
    const connCounts = new Map(); // index -> current connected sockets (all)
    function broadcastJoinedCounts(){
      try {
        const arr = Array.from({ length: WORKERS }, (_,i)=> (joinedCounts.get(i+1) || 0));
        for (const [i,w] of workerByIndex.entries()) {
          try { w.send({ type: 'cluster:joined-counts', counts: arr }); } catch(_){}
        }
      } catch(_){}
    }
    function bindWorkerMessages(idx, w){
      try {
        w.on('message', (msg) => {
          try {
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'joined:delta') {
              const cur = joinedCounts.get(idx) || 0;
              const next = Math.max(0, cur + (parseInt(msg.delta,10)||0));
              joinedCounts.set(idx, next);
              broadcastJoinedCounts();
            }
            else if (msg.type === 'player:delta') {
      const cur2 = connCounts.get(idx) || 0;
      const next2 = Math.max(0, cur2 + (parseInt(msg.delta,10)||0));
      connCounts.set(idx, next2);
    }
} catch(_){}
        });
        w.on('exit', () => {
          try { joinedCounts.set(idx, 0); broadcastJoinedCounts(); } catch(_){}
        });
              try { connCounts.set(idx, 0); } catch(_){ }
} catch(_){}
    }
    for (let i=1;i<=WORKERS;i++) spawnAtIndex(i);
    // Broadcast initial counts (all 0)
    broadcastJoinedCounts();
// Periodic aggregated connected count (every 5 minutes)
try {
  if (!global.__connStatsTimerInstalled) {
    global.__connStatsTimerInstalled = true;
    setInterval(() => {
      try {
        const totalConn = Array.from({ length: WORKERS }, (_,i)=> (connCounts.get(i+1) || 0))
                               .reduce((a,b)=> (a + (b|0)), 0);
        console.log('[STATS] total connected (all workers): ' + totalConn);
      } catch(_){}
    }, 5 * 60 * 1000);
  }
} catch(_){}
    // Choose an available worker index, preferring the desired one; falls back to nearest available
    function resolveWorkerIndex(desired) {
      // Clamp desired to [1..WORKERS]
      if (!Number.isFinite(desired)) desired = 2; // default when not provided
      desired = Math.max(1, Math.min(WORKERS, desired));
      if (workerByIndex.get(desired)) return desired;
      // Fallback: search nearest available index
      let best = null, bestDist = Infinity;
      for (let i=1;i<=WORKERS;i++){
        if (workerByIndex.get(i)) {
          const d = Math.abs(i - desired);
          if (d < bestDist) { bestDist = d; best = i; }
        }
      }
      return best || 1;
    }
    // TCP balancer: route each connection to the worker chosen from URL (?w=K) or default 2
    const balancer = net.createServer({ pauseOnConnect: true }, (socket) => {
      let handed = false;
      function finalize(firstChunk) {
        if (handed) return;
        handed = true;
        // Extract desired worker from URL (?w=K); default is 2 when absent/invalid
        // Extract desired worker from URL (?w=K); default is 2 when absent/invalid
        let desired = 2;
        try {
          if (firstChunk && firstChunk.length) {
            const path = extractPathFromFirstChunk(firstChunk);
            const k = extractWFromUrlPath(path);
            if (Number.isFinite(k)) {
              desired = k;
            } else {
              // Fallback 1: cookie 'w' set by the app on the first HTML response
              const ck = extractCookieWFromFirstChunk(firstChunk);
              if (Number.isFinite(ck)) {
                desired = ck;
              } else {
                // Fallback 2: Referer (when assets/handshake omit ?w but browser sends the page URL)
                const ref = extractRefererFromFirstChunk(firstChunk);
                const rk = extractWFromFullUrl(ref);
                if (Number.isFinite(rk)) desired = rk;
              }
            }
          }
        } catch (_) {}
        const idx = resolveWorkerIndex(desired);
        const target = workerByIndex.get(idx);
        if (!target) { try { socket.destroy(); } catch(_){ } return; }
        try {
          target.send({ type: 'sticky-connection', initialData: firstChunk }, socket);
        } catch (e) {
          try { socket.destroy(); } catch(_){}
        }
      }
      
      // Try to read the first packet to capture headers (URL & Referer)
      let __routeTimer = null;
      try { __routeTimer = setTimeout(() => { try { finalize(null); } catch(_){} }, 2000); } catch(_) {}
      socket.once('readable', () => {
        try { if (__routeTimer) { clearTimeout(__routeTimer); __routeTimer = null; } } catch(_){}
        let chunk = null;
        try { chunk = socket.read(); } catch(_){}
        finalize(chunk);
      });
      socket.on('end', () => { try { if (__routeTimer) { clearTimeout(__routeTimer); __routeTimer = null; } } catch(_){} });
      socket.on('close', () => { try { if (__routeTimer) { clearTimeout(__routeTimer); __routeTimer = null; } } catch(_){} });
    });
    balancer.on('error', (err) => {
      console.error('[Master] balancer error:', err && err.message);
      process.exitCode = 1;
    });
    balancer.listen(PORT, () => {
      console.log('[Master] listening on', PORT, '— URL param "?w=K" selects worker; default is worker 2');
    });
    return; // master terminates here; workers run the app server
  }
})();
;
/*__/MULTIWORKER_BOOTSTRAP__*/
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
const fs = require('fs');
const nodeCrypto = require('crypto');

// --- PostgreSQL (users & ladder) ---
let __pgReady = false;
let __pgError = null;
let __registeredUsernames = new Set(); // lowercase usernames cache for fast sync checks
let __skinCache = new Map();           // username_lower -> { hair, skin, clothes }
let db = null;
try {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || undefined,
    ssl: (process.env.PGSSLMODE === 'require') ? { rejectUnauthorized: false } : false,
    max: Math.max(4, parseInt(process.env.PG_POOL_MAX || '10', 10) || 10),
    idleTimeoutMillis: 30000
  });
  db = {
    pool,
    async q(text, params){ return pool.query(text, params); },
    async tx(fn){
      const client = await pool.connect();
      try { await client.query('BEGIN'); const r = await fn(client); await client.query('COMMIT'); return r; }
      catch(e){ try{ await client.query('ROLLBACK'); }catch(_){ } throw e; }
      finally{ client.release(); }
    }
  };
  (async () => {
    try {
      // Ensure tables exist
      await db.q(`CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        username_lower TEXT NOT NULL UNIQUE,
        pass_hash TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )`);
      await db.q(`CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        ip TEXT,
        ua TEXT
      )`);
      await db.q(`CREATE TABLE IF NOT EXISTS ladder (
        player TEXT PRIMARY KEY,
        wave INTEGER NOT NULL DEFAULT 0,
        kills INTEGER NOT NULL DEFAULT 0,
        ts BIGINT NOT NULL
      )`);
    
      // Preload registered usernames cache (sync lookup for guest pseudo reservation)
      const res = await db.q('SELECT username_lower FROM users');
      (res.rows||[]).forEach(r => { try{ if (r && r.username_lower) __registeredUsernames.add(String(r.username_lower)); }catch(_){ } });
      __pgReady = true;
      __pgError = null;
      console.log('[DB] PostgreSQL connected — users cached:', __registeredUsernames.size);
    } catch(e) {
      __pgReady = false;
      __pgError = e;
      console.error('[DB] init failed:', e && e.message);
    }
  })();
} catch(e){
  __pgError = e;
  console.error('[DB] pg module not available — users/ladder features require PostgreSQL (disabled)');
}
const gameMapModule = require('./game/gameMap');
const app = express();

// Serve a blank favicon to avoid 404 noise
app.get('/favicon.ico', (req,res)=>{ res.status(204).end(); });
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// CSRF cookie middleware (minimal; no parser dependency)
function ensureCsrfCookie(req, res, next) {
  try {
    const cookieHeader = (req && req.headers && req.headers.cookie) ? String(req.headers.cookie) : '';
    if (cookieHeader && cookieHeader.indexOf('csrf=') !== -1) {
      return next();
    }
    const token = (nodeCrypto.randomBytes(16).toString('hex'));
    const isSecure = (req && (req.secure === true || (req.headers && req.headers['x-forwarded-proto'] === 'https')));
    const parts = [ `csrf=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax' ];
    if (isSecure) parts.push('Secure');
    const cookieStr = parts.join('; ');
    const prev = res.getHeader('Set-Cookie');
    if (prev) {
      res.setHeader('Set-Cookie', Array.isArray(prev) ? prev.concat(cookieStr) : [prev, cookieStr]);
    } else {
      res.setHeader('Set-Cookie', cookieStr);
    }
  } catch(_e) {}
  return next();
}


// ensure CSRF cookie exists for all requests
app.use(ensureCsrfCookie);

// --- Sessions & Auth (PostgreSQL only) ---
const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
let __sessionCache = new Map(); // sid -> { username, username_lower, user_id, exp }

function parseCookies(header) {
  const out = {};
  try {
    String(header || '').split(';').forEach(p => {
      const idx = p.indexOf('=');
      if (idx === -1) return;
      const k = p.slice(0, idx).trim();
      const v = p.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    });
  } catch(_){}
  return out;
}

function isHttpsReq(req){
  try {
    return !!(req.secure || (req.headers && req.headers['x-forwarded-proto'] === 'https') || process.env.COOKIE_SECURE === '1');
  } catch(_) { return false; }
}

function randomIdHex(n=32){ return nodeCrypto.randomBytes(n).toString('hex'); }

function pbkdf2Hash(password) {
  const salt = randomIdHex(16);
  const iter = 120000;
  const hash = nodeCrypto.pbkdf2Sync(String(password||''), salt, iter, 32, 'sha256').toString('hex');
  return `pbkdf2$${iter}$${salt}$${hash}`;
}
function pbkdf2Verify(password, stored) {
  try {
    const parts = String(stored||'').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iter = parseInt(parts[1], 10) || 120000;
    const salt = parts[2];
    const h = parts[3];
    const test = nodeCrypto.pbkdf2Sync(String(password||''), salt, iter, h.length/2, 'sha256').toString('hex');
    return nodeCrypto.timingSafeEqual(Buffer.from(test,'hex'), Buffer.from(h,'hex'));
  } catch(_) { return false; }
}

async function createSession(userId, username, username_lower, req, res){
  const sid = randomIdHex(32);
  const now = Date.now();
  const exp = now + SESSION_TTL_MS;
  await db.q(
    `INSERT INTO sessions (sid, user_id, created_at, expires_at, ip, ua)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [sid, userId, now, exp, (req.ip || ''), (req.headers['user-agent'] || '')]
  );
  __sessionCache.set(sid, { user_id: userId, username, username_lower, exp });
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true, sameSite: 'lax', secure: isHttpsReq(req), maxAge: SESSION_TTL_MS, path:'/'
  });
  return sid;
}

async function destroySessionBySid(sid){
  try {
    await db.q(`DELETE FROM sessions WHERE sid=$1`, [sid]);
  } catch(_){}
  __sessionCache.delete(sid);
}
async function destroySession(req, res){
  try {
    const cookies = parseCookies(req.headers && req.headers.cookie);
    const sid = cookies[SESSION_COOKIE];
    if (sid) await destroySessionBySid(sid);
  } catch(_){}
  try {
    res.cookie(SESSION_COOKIE, '', { httpOnly:true, sameSite:'lax', secure:isHttpsReq(req), maxAge:0, path:'/' });
  } catch(_){}
}
async function resolveSession(req){
  try {
    const cookies = parseCookies(req && req.headers && req.headers.cookie);
    const sid = cookies[SESSION_COOKIE];
    if (!sid) return null;
    const inMem = __sessionCache.get(sid);
    if (inMem && inMem.exp > Date.now()) return { sid, ...inMem };
    if (!db || !__pgReady) return null;
    const r = await db.q(
      `SELECT s.sid, s.user_id, s.expires_at, u.username, u.username_lower
       FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.sid=$1 AND s.expires_at > $2
       LIMIT 1`,
      [sid, Date.now()]
    );
    const row = (r && r.rows && r.rows[0]) ? r.rows[0] : null;
    if (!row) return null;
    const exp = Number(row.expires_at) || 0;
    const cacheVal = { user_id: row.user_id, username: row.username, username_lower: row.username_lower, exp };
    __sessionCache.set(sid, cacheVal);
    return { sid, ...cacheVal };
  } catch(_){ 
    return null; 
  }
}

// Replace stub: fetch username from socket's cookie via cache (non-blocking)
function getSessionUsernameBySocketId(sid) {
  try {
    const sock = io && io.sockets && io.sockets.sockets ? io.sockets.sockets.get(sid) : null;
    if (!sock || !sock.handshake || !sock.handshake.headers) return null;
    const cookies = parseCookies(sock.handshake.headers.cookie);
    const s = cookies[SESSION_COOKIE];
    if (!s) return null;
    const c = __sessionCache.get(s);
    return c ? c.username : null;
  } catch(_){ return null; }
}

// --- Minimal auth APIs (PostgreSQL-backed; no JSON fallback) ---
app.get('/api/me', async (req, res) => {
  try {
    if (!db || !__pgReady) {
      return res.status(200).json({ ok: true, username: null, skin: null });
    }
    const sess = await resolveSession(req);
    if (!sess) return res.status(200).json({ ok: true, username: null, skin: null });
    return res.status(200).json({ ok: true, username: sess.username, skin: null });
  } catch(e){
    return res.status(200).json({ ok: true, username: null, skin: null });
  }
});

app.get('/api/username-taken', async (req, res) => {
  try {
    const u = (req.query && req.query.u) ? String(req.query.u).trim() : '';
    const unameLower = u.toLowerCase();
    if (!u) return res.status(200).json({ ok: true, taken: false });
// Leaderboard API (PostgreSQL only)

    if (!db || !__pgReady) {
      // Without DB, we can't verify; do not block UI.
      return res.status(200).json({ ok: true, taken: false });
    }
    const r = await db.q('SELECT 1 FROM users WHERE username_lower = $1 LIMIT 1', [unameLower]);
    const taken = !!(r && r.rows && r.rows.length > 0);
    return res.status(200).json({ ok: true, taken });
  } catch(e){
    return res.status(200).json({ ok: true, taken: false });
  }
});


// --- Auth endpoints ---
app.post('/api/signup', async (req, res) => {
  try {
    if (!db || !__pgReady) return res.status(200).json({ ok:false, reason:'db_unavailable' });
    const { username, password } = (req.body || {});
    const u = sanitizeUsername(username);
    if (!u || u.length < 3) return res.status(200).json({ ok:false, reason:'bad_username' });
    if (String(password||'').length < 6) return res.status(200).json({ ok:false, reason:'weak_password' });
    const ul = normalizeKey(u);
    // enforce availability in DB
    const check = await db.q('SELECT id FROM users WHERE username_lower=$1 LIMIT 1', [ul]);
    if (check.rowCount > 0) return res.status(200).json({ ok:false, reason:'username_taken' });
    const now = Date.now();
    const pass_hash = pbkdf2Hash(password);
    // create user
    const ins = await db.q(
      'INSERT INTO users (username, username_lower, pass_hash, created_at) VALUES ($1,$2,$3,$4) RETURNING id',
      [u, ul, pass_hash, now]
    );
    const userId = ins.rows[0].id;
    __registeredUsernames.add(ul);
    await createSession(userId, u, ul, req, res);
    return res.status(200).json({ ok:true, username: u });
  } catch(e){
    try {
      // Map PostgreSQL unique violation to a clean username_taken error
      if (e && (e.code === '23505' || /unique/i.test(String(e.constraint||'')) || /duplicate key value/i.test(String(e.message||'')))) {
        return res.status(200).json({ ok:false, reason:'username_taken' });
      }
    } catch(_) {}
    try { console.error('[API signup] error:', e && e.code, e && e.message); } catch(_){}
    return res.status(200).json({ ok:false, reason:'server_error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    if (!db || !__pgReady) return res.status(200).json({ ok:false, reason:'db_unavailable' });
    const { username, password } = (req.body || {});
    const ul = normalizeKey(username);
    if (!ul) return res.status(200).json({ ok:false, reason:'bad_username' });
    const r = await db.q('SELECT id, username, username_lower, pass_hash FROM users WHERE username_lower=$1 LIMIT 1', [ul]);
    if (r.rowCount === 0) return res.status(200).json({ ok:false, reason:'invalid_credentials' });
    const row = r.rows[0];
    if (!pbkdf2Verify(password, row.pass_hash)) return res.status(200).json({ ok:false, reason:'invalid_credentials' });
    await createSession(row.id, row.username, row.username_lower, req, res);
    return res.status(200).json({ ok:true, username: row.username });
  } catch(e){
    return res.status(200).json({ ok:false, reason:'server_error' });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    await destroySession(req, res);
    return res.status(200).json({ ok:true });
  } catch(_){
    return res.status(200).json({ ok:true });
  }
});



app.get('/api/ladder', async (req, res) => {
  try {
    if (!db || !__pgReady) return res.status(200).json({ ok: true, ladder: [] });
    const r = await db.q(
      `SELECT player, wave, kills, ts
         FROM ladder
         ORDER BY wave DESC, kills DESC, ts ASC
         LIMIT 100`
    );
    const ladder = (r && r.rows) ? r.rows.map(row => ({
      player: row.player,
      wave: Number(row.wave)||0,
      kills: Number(row.kills)||0,
      ts: Number(row.ts)||0
    })) : [];
    return res.status(200).json({ ok: true, ladder });
  } catch(e){
    return res.status(200).json({ ok: true, ladder: [] });
  }
});


/* --- Ladder (PostgreSQL only) --- */
function sanitizePlayerName(u) {
  try { return String(u||'').trim().substring(0, 10).replace(/[^a-zA-Z0-9]/g, ''); } catch(_e) { return ''; }
}
function recordLadderScoreServer(playerName, wave, kills) {
  try {
    if (!db || !__pgReady) return false;
    const name = sanitizePlayerName(playerName);
    const w = Number(wave) || 0;
    const k = Number(kills) || 0;
    if (!name) return false;
    if (!Number.isFinite(w) || !Number.isFinite(k) || w < 0 || k < 0) return false;
    const now = Date.now();
    db.q(
      `INSERT INTO ladder (player, wave, kills, ts)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (player) DO UPDATE
         SET wave = EXCLUDED.wave,
             kills = EXCLUDED.kills,
             ts = EXCLUDED.ts
         WHERE (EXCLUDED.wave > ladder.wave)
            OR (EXCLUDED.wave = ladder.wave AND EXCLUDED.kills > ladder.kills)
            OR (EXCLUDED.wave = ladder.wave AND EXCLUDED.kills = ladder.kills AND EXCLUDED.ts < ladder.ts)`,
      [name, w|0, k|0, now]
    ).catch(()=>{});
    return true;
  } catch(_){ return false; }
}
const server = http.createServer(app);
// Persist chosen worker when a specific server is requested via the URL (?w=K).
// Do NOT set any worker by default — but if ?w=K is present, consider it an explicit join.
app.use((req, res, next) => {
  try {
    const WORKERS = Math.max(1, parseInt(process.env.WORKERS || '4', 10) || 1);
    const wParam = parseInt(String((req.query && req.query.w) || ''), 10);
    const joinParam = String((req.query && req.query.join) || '').trim().toLowerCase();
const isJoin = true; // legacy param no longer required; presence of ?w=K is considered a join
    function setWorkerCookie(val){
      try {
        const v = Math.max(1, Math.min(WORKERS, parseInt(val,10)||2));
        const parts = [
          'w=' + v,
          'Path=/',
          'Max-Age=' + (7*24*3600),
          'SameSite=Lax',
          'HttpOnly'
        ];
        const secure = String(process.env.NODE_ENV||'').toLowerCase() === 'production';
        if (secure) parts.push('Secure');
        const prev = res.getHeader('Set-Cookie');
        if (!prev) res.setHeader('Set-Cookie', parts.join('; '));
        else {
          const arr = Array.isArray(prev) ? prev.slice() : [String(prev)];
          arr.push(parts.join('; '));
          res.setHeader('Set-Cookie', arr);
        }
      } catch(_){}
    }
    // If user is joining a specific worker, persist cookie and ensure request is served by that worker.
    if (Number.isFinite(wParam)) {
      try {
        // If this request is already on a worker, and capacity is exceeded, reject join.
        const isCluster = String(process.env.IS_CLUSTER_WORKER||'0') === '1' && (parseInt(process.env.WORKERS||'1',10)>1);
        if (isCluster) {
          const curIdx = Math.max(1, parseInt(process.env.WORKER_INDEX||'1',10) || 1);
          const desired = Math.max(1, Math.min(WORKERS, parseInt(wParam,10)||2));
          // If the request is on the desired worker, check capacity gate (local value set later in worker code).
          if (desired === curIdx) {
            try {
              const cap = parseInt(process.env.WORKER_CAPACITY||'60',10) ||  60;
              const joined = (global.__joinedCountLocal|0);
              if (joined >= cap) {
                res.statusCode = 409;
                res.setHeader('Cache-Control', 'no-store, must-revalidate');
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                const html = '<!doctype html>'
                  + '<meta http-equiv="refresh" content="2; url=/">'
                  + '<title>Server full</title>'
                  + '<div style="font-family:system-ui,Arial,sans-serif;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;">'
                  + '<div style="background:#1b1b20;border-radius:12px;padding:18px 22px;box-shadow:0 10px 40px #000a;text-align:center;">'
                  + '<div style="font-weight:700;margin-bottom:6px;">Server full</div>'
                  + '<div style="color:#9ab;">This server currently has the maximum number of players. You will be redirected.</div>'
                  + '</div></div>';
                return res.end(html);
              }
            } catch(_){}
          }
        }
      } catch(_){}
      // Persist cookie (sticky routing) and redirect to the correct worker if needed
      setWorkerCookie(wParam);
      try {
        const isCluster = String(process.env.IS_CLUSTER_WORKER||'0') === '1' && (parseInt(process.env.WORKERS||'1',10)>1);
        if (isCluster && (req.method === 'GET' || req.method === 'HEAD')) {
          const curIdx = Math.max(1, parseInt(process.env.WORKER_INDEX||'1',10) || 1);
          const desired = Math.max(1, Math.min(WORKERS, parseInt(wParam,10)||2));
          if (desired !== curIdx) {
            const loc = String((req.originalUrl || req.url || '/')).replace(/[\r\n]/g,'');
            res.setHeader('Cache-Control', 'no-store, must-revalidate');
            res.setHeader('Connection', 'close');
            res.statusCode = 307;
            res.setHeader('Location', loc);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            const html = '<!doctype html><meta http-equiv="refresh" content="0;url=' + loc.replace('"','&quot;') + '"><title>Switching worker…</title>Redirecting…';
            return res.end(html);
          }
        }
      } catch(_){}
    }
    // Otherwise: do nothing — no default worker cookie is set.
  } catch(_){}
  next();
});
/*__STICKY_WORKER_HOOK__*/
if (String(process.env.IS_CLUSTER_WORKER||'0') === '1' && (parseInt(process.env.WORKERS||'1',10)>1)) {
  process.on('message', function(msg, handle){
    try{
      if (msg && msg.type === 'sticky-connection' && handle) {
        try { handle.on && handle.on('error', function(){}); } catch(_){}
        try { server.emit('connection', handle); } catch(_){}
        try {
          if (msg.initialData && handle && typeof handle.unshift === 'function') {
            handle.unshift(Buffer.isBuffer(msg.initialData) ? msg.initialData : Buffer.from(msg.initialData));
          }
          handle.resume && handle.resume();
        } catch(_){}
      }
    }catch(_){}
  });
}
const io = socketIo(server, {
  pingInterval: 10000,
  pingTimeout: 60000,
  perMessageDeflate: { threshold: 1024 }, // compresse les gros payloads
  transports: ['polling','websocket'],
});
// === Periodic connected count (single-process or non-cluster) ===
try {
  const __isClusterWorker = String(process.env.IS_CLUSTER_WORKER||'0') === '1' && (parseInt(process.env.WORKERS||'1',10)>1);
  if (!__isClusterWorker) {
    if (!global.__singleConnStatsTimerInstalled) {
      global.__singleConnStatsTimerInstalled = true;
      setInterval(() => {
        try {
          let total = 0;
          try {
            if (io && io.engine && typeof io.engine.clientsCount === 'number') total = io.engine.clientsCount|0;
            else if (io && io.of && io.of('/') && io.of('/').sockets && typeof io.of('/').sockets.size === 'number') total = io.of('/').sockets.size|0;
          } catch(_){ total = 0; }
          console.log('[STATS] total connected: ' + total);
        } catch(_){}
      }, 5 * 60 * 1000);
    }
  }
} catch(_){}
// --- Worker capacity & aggregated counts ---
const WORKER_INDEX = Math.max(1, parseInt(process.env.WORKER_INDEX || '1', 10) || 1);
const WORKER_CAPACITY = Math.max(1, parseInt(process.env.WORKER_CAPACITY || '60', 10) ||   60);
// Local joined players (only players that have chosen this worker: cookie w=<idx> on their socket)
global.__joinedCountLocal = global.__joinedCountLocal || 0;
let __joinedCountLocal = global.__joinedCountLocal;
// Cluster-wide joined counts snapshot (broadcast by master)
let __clusterJoinedCounts = Array.from({ length: Math.max(1, parseInt(process.env.WORKERS||'1',10) || 1) }, () => 0);
// Receive cluster-wide counts from master
try {
  process.on('message', (m) => {
    if (m && m.type === 'cluster:joined-counts' && Array.isArray(m.counts)) {
      __clusterJoinedCounts = m.counts.slice(0);
    }
  });
} catch(_) {}
// Public endpoint: returns server list with joined counts (auto-refresh friendly)
app.get('/api/servers', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.json({
      ok: true,
      capacity: WORKER_CAPACITY,
      total: __clusterJoinedCounts.length,
      me: WORKER_INDEX,
      workers: __clusterJoinedCounts.map((c, i) => ({ id: i+1, count: c|0 })),
      ts: Date.now()
    });
  } catch(e){
    res.status(500).json({ ok:false, error: 'internal' });
  }
});
// --- Chat globals ---
let worldChatHistory = [];
// Keep last known pseudo per socket to label chat messages even before game context is attached
const lastPseudoBySocket = new Map();
// === World chat display name registry (server-authoritative uniqueness) ===
// Maps socket.id -> assigned world chat display name (sanitized, <=10 chars)
const worldChatNameBySocket = new Map();
// Maps lowercased display name -> { ownerKey: 'user:<uname>' | 'sock:<sid>', count: number }
const worldNameClaims = new Map();
function getOwnerKeyForSocket(sock) {
  try {
    const u = getSessionUsernameBySocketId(sock && sock.id);
    if (u) return 'user:' + normalizeKey(u);
    return 'sock:' + String(sock && sock.id || '');
  } catch(_) { return 'sock:' + String(sock && sock.id || ''); }
}
// Claim a unique world-chat name for this socket; returns the assigned name.
// If the desired name is already owned by a different ownerKey, a numeric suffix is added (#2, #3, ...),
// ensuring total length <= 10. For authenticated users, exact name may be shared across their own sockets.
// Guests never share names.
function claimWorldChatName(sock, desired) {
  try {
    let base = sanitizeUsername(desired || '') || 'Player';
    const ownerKey = getOwnerKeyForSocket(sock);
    // helper to check availability
    function isAvailable(nameLower) {
      const entry = worldNameClaims.get(nameLower);
      return !entry || entry.ownerKey === ownerKey;
    }
    // helper to increment claim
    function addClaim(nameLower) {
      const entry = worldNameClaims.get(nameLower);
      if (entry) {
        entry.count++;
      } else {
        worldNameClaims.set(nameLower, { ownerKey, count: 1 });
      }
    }
    // helper to release previous mapping for this socket (if any)
    function releasePrevious() {
      const prev = worldChatNameBySocket.get(sock.id);
      if (!prev) return;
      const prevLower = String(prev).toLowerCase();
      const e = worldNameClaims.get(prevLower);
      if (e) {
        e.count = Math.max(0, (e.count|0) - 1);
        if (e.count === 0) worldNameClaims.delete(prevLower);
      }
      worldChatNameBySocket.delete(sock.id);
    }
    // Try base as-is first
    let finalName = base;
    let finalLower = base.toLowerCase();
    if (!isAvailable(finalLower)) {
      // Generate suffixed variants within 10-char limit
      // Use "#n" where n starts at 2
      let n = 2;
      // compute max base length to keep <=10
      function withSuffix(n) {
        const suf = '#' + String(n);
        const maxBaseLen = Math.max(1, 10 - suf.length);
        const truncated = base.slice(0, maxBaseLen);
        return truncated + suf;
      }
      while (true) {
        const candidate = withSuffix(n);
        const lower = candidate.toLowerCase();
        if (isAvailable(lower)) {
          finalName = candidate;
          finalLower = lower;
          break;
        }
        n++;
        if (n > 99) { // extreme fallback
          finalName = base.slice(0, 8) + '#' + (Math.random()*90+10|0);
          finalLower = finalName.toLowerCase();
          if (isAvailable(finalLower)) break;
        }
      }
    }
    // Update mappings: release previous, then claim new
    releasePrevious();
    addClaim(finalLower);
    worldChatNameBySocket.set(sock.id, finalName);
    try { lastPseudoBySocket.set(sock.id, finalName); } catch(_){}
    return finalName;
  } catch(_){
    // Safe fallback
    const fallback = 'Player';
    try { worldChatNameBySocket.set(sock.id, fallback); } catch(_){}
    return fallback;
  }
}
function releaseWorldChatName(sock) {
  try {
    const prev = worldChatNameBySocket.get(sock && sock.id);
    if (!prev) return;
    const prevLower = String(prev).toLowerCase();
    const e = worldNameClaims.get(prevLower);
    if (e) {
      e.count = Math.max(0, (e.count|0) - 1);
      if (e.count === 0) worldNameClaims.delete(prevLower);
    }
    worldChatNameBySocket.delete(sock && sock.id);
  } catch(_){}
}
const chatLastByIp = new Map(); // per-IP cooldown
// === Helper: normalize client IP (supports proxies) ===
function getClientIP(socket) {
  try {
    // Prefer the real remote peer address provided by the transport
    let peer = (socket && socket.conn && socket.conn.remoteAddress)
            || (socket && socket.handshake && socket.handshake.address)
            || '';
    if (Array.isArray(peer)) peer = peer[0] || '';
    if (typeof peer === 'string' && peer.startsWith('::ffff:')) peer = peer.slice(7);
    let ip = String(peer || '').trim();
    // Only honor X-Forwarded-For if the immediate peer is a trusted proxy
    const headers = (socket && socket.handshake && socket.handshake.headers) || {};
    const xff = headers['x-forwarded-for'];
    if (xff) {
      const TRUSTED = (process.env.TRUSTED_PROXIES || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const peerCmp = (String(peer || '').replace(/^::ffff:/, '')).trim();
      const isTrusted = TRUSTED.includes(peerCmp);
      if (isTrusted) {
        let f = String(xff).split(',')[0].trim();
        if (f.startsWith('::ffff:')) f = f.slice(7);
        if (f) ip = f;
      }
    }
    return ip;
  } catch (e) {
    return '';
  }
}
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
/*__IP_CONN_LIMIT_HTTP__*/
const __ipConnCounts = new Map();
function getIpFromReq(req){
  try{
    let ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (!ip) ip = (req.socket && req.socket.remoteAddress) || '';
    if (ip && typeof ip === 'string' && ip.startsWith('::ffff:')) ip = ip.slice(7);
    // Only honor X-Forwarded-For when behind trusted proxy
    const TRUSTED = (process.env.TRUSTED_PROXIES || '')
      .split(',')
      .map(s => s.trim()).filter(Boolean);
    const peer = ((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/,'');
    const isTrusted = TRUSTED.includes(peer);
    if (!isTrusted) {
      ip = ((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/,'');
    }
    return String(ip||'').trim();
  }catch(_){ return ''; }
}
// Gate HTTP access when this IP already has >= 6 active socket connections
app.use((req,res,next)=>{
  try{
    const ip = getIpFromReq(req) || 'unknown';
    const cnt = __ipConnCounts.get(ip) || 0;
    if (cnt >= 6) {
      res.statusCode = 429;
      res.setHeader('Cache-Control','no-store, max-age=0');
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end('<!doctype html><title>Too many tabs</title><div style="font:14px system-ui,Arial;color:#fff;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;"><div style="background:#1b1b20;border-radius:12px;padding:18px 22px;box-shadow:0 10px 40px #000a;text-align:center;"><div style="font-weight:700;margin-bottom:6px;">Limit reached</div><div style="opacity:.85">You already have 6 tabs open for this game from this IP.<br>Close one tab to continue.</div></div></div>');
      return;
    }
  }catch(_){}
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
const MAX_PLAYERS = 6;
const LOBBY_TIME = 5 * 1000;
const MAX_ACTIVE_ZOMBIES = 130;
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
  T: 2000, // Tourelle
  t: 500,  // Mini-tourelle
  G: 10000, // Big-tourelle
  B: 250,  // Mur
  D: 500   // Porte
};
// Cooldown for placing walls/doors (applies to both types)
const BLOCK_PLACE_COOLDOWN_MS = 5000;
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
// === Helper: check global nickname uniqueness (case-insensitive) ===
function isPseudoTaken(name, exceptSocketId) {
  try {
    const target = String(name || '').trim().toLowerCase();
    if (!target) return false;
    const socketsMap = (io && io.sockets && io.sockets.sockets) ? io.sockets.sockets : null;
    for (const g of activeGames) {
      if (!g) continue;
      // Lobby players — ignore stale/disconnected socket entries
      try {
        const lp = (g.lobby && g.lobby.players) ? g.lobby.players : {};
        for (const sid in lp) {
          if (exceptSocketId && sid === exceptSocketId) continue;
          if (socketsMap && !socketsMap.get(sid)) continue; // skip stale
          const p = lp[sid];
          if (p && typeof p.pseudo === 'string' && p.pseudo.toLowerCase() === target) return true;
        }
      } catch(_){}
      // In‑game players (exclude bots) — also ensure socket is alive
      try {
        const pl = g.players || {};
        for (const sid in pl) {
          if (exceptSocketId && sid === exceptSocketId) continue;
          if (socketsMap && !socketsMap.get(sid)) continue; // skip stale
          const p = pl[sid];
          if (p && !p.isBot && typeof p.pseudo === 'string' && p.pseudo.toLowerCase() === target) return true;
        }
      } catch(_){}
    }
  } catch(_){}
  return false;
}
function createNewGame() {
  let game = {
    structures: null,
    id: nextGameId++,
    lobby: { players: {}, timeLeft: LOBBY_TIME / 1000, started: false, joinCode: null, timer: null, manual: false, hostId: null, kickedUntilByIp: {} },
    // map: ip -> timestamp until which the ip is blocked from rejoining this lobby
    // only relevant for manual lobbies
    kickedUntilByIp: {},
    players: {},
    bots: {},
    zombies: {},
    bullets: {},
    chatHistory: [],
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
const SERVER_VIEW_RADIUS = 400; // rayon en px (monde) pour ce qu'on ENVOIE à chaque client
const BUILD_VIEW_RADIUS = 300; // rayon de halo autorisant le placement
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
        skin: (function(s){ try{ if(!s||typeof s!=='object') return null; const hex=/^#[0-9a-fA-F]{6}$/; const hair=(hex.test(s.hair)?s.hair.toLowerCase():null); const skin=(hex.test(s.skin)?s.skin.toLowerCase():null); const clothes=(hex.test(s.clothes)?s.clothes.toLowerCase():null); return (hair&&skin&&clothes)?{hair,skin,clothes}:null; }catch(_){return null; } })(p.skin),
      };
    }
  }
  return out;
}
// Build a public map for a specific recipient: keep self under real sid, others as p1, p2...
// If hostId is provided and differs from self, also include 'host' alias for the host player's entry.
function buildPublicMapForRecipient(selfSid, fullMap, hostId) {
  const out = {};
  if (!fullMap || typeof fullMap !== 'object') return out;
  let idx = 0;
  for (const k in fullMap) {
    if (Object.prototype.hasOwnProperty.call(fullMap, k)) {
      if (k === selfSid) {
        out[k] = fullMap[k];
      } else {
        // Do not alias the host as pX for non-host recipients;
        // it will be exposed once under 'host' below.
        if (hostId && hostId !== selfSid && k === hostId) {
          continue;
        }
        const alias = 'p' + (++idx);
        out[alias] = fullMap[k];
      }
    }
  }
  if (hostId && hostId !== selfSid && fullMap[hostId]) {
    out['host'] = fullMap[hostId];
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
      let baseDmg = (s.type === 't') ? 5 : (s.type === 'T' ? 10 : (s.type === 'G' ? 25 : 5));
      // Upgrades bonus per owner: sum of geometric series (+10% per level on the added amount)
      let bonus = 0;
      if (s.placedBy && game.players[s.placedBy]) {
        const up = game.players[s.placedBy].turretUpgrades || {};
        const lvl = (s.type === 't') ? (up['t']||0) : (s.type === 'T' ? (up['T']||0) : (up['G']||0));
        if (lvl > 0) {
          const baseAdd = (s.type === 't') ? 5 : (s.type === 'T' ? 10 : 25);
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
    try { game.players[sid].skin = resolvePlayerSkinForSocket(sid, (game.lobby && game.lobby.players && game.lobby.players[sid] && game.lobby.players[sid].pseudo) || null); } catch(_){ game.players[sid].skin = game.players[sid].skin || null; }
    // Attach account shop upgrades (hp/dmg) to player if logged-in
    try {
      const authUser = getSessionUsernameBySocketId(sid);
      if (authUser && db && __pgReady) {
        db.q('SELECT shop_hp, shop_dmg FROM users WHERE username_lower=$1 LIMIT 1', [ normalizeKey(authUser) ])
          .then(r=>{
            const row = r.rows && r.rows[0];
            if (!row) return;
            if (game && game.players && game.players[sid]) {
              game.players[sid].accountShop = { hp: (row.shop_hp|0)||0, dmg: (row.shop_dmg|0)||0 };
              try { io.to(sid).emit('accountShopUpdated', game.players[sid].accountShop); } catch(_){}
              try {
                const oldMax = game.players[sid].maxHealth || 100;
                const stats = getPlayerStats(game.players[sid]);
                const ratio = Math.max(0, Math.min(1, (game.players[sid].health || 0) / (oldMax || 100)));
                game.players[sid].maxHealth = stats.maxHp;
                game.players[sid].health = Math.round(stats.maxHp * ratio);
              } catch(_){}
            }
          }).catch(()=>{});
      }
    } catch(_){}
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
const TURRET_RANGE = 300;
const TURRET_RANGE_SQ = TURRET_RANGE * TURRET_RANGE;
// --- Anti-burst tourelles ---
// Décalage aléatoire de cadence par tir, centré sur 0 (moyenne nulle) → ne change pas le DPS moyen
const TURRET_JITTER_MS = 120;              // ex. ±120 ms par tir
// Nombre maximum de tirs de tourelles autorisés par "stepOnce" (un tick physique)
const TURRET_SHOTS_PER_TICK = 8;           // ajuste si besoin (ex. 6..12 selon charge)
// Événement de batch pour les lasers (un tableau de segments)
const TURRET_LASER_BATCH_EVENT = 'laserBeams';
const PATHFIND_BUDGET_PER_TICK = 8;     // nb max de findPath autorisés / tick (ajuste 8..20)
const TURRET_RETARGET_MS = 120;          // une tourelle ne re-choisit pas une cible + souvent que ça
// ---- PATHFINDING ADAPTATIF PAR TICK ----
// Retourne le nombre d'appels findPath autorisés ce tick pour UNE partie.
function computePathfindBudget(game) {
  if (!game.lobby.started) return 0;
  const z = game._zombieCount || 0;
  const t = game._turretCount || 0;
  const b = game._bulletCount || 0;
  // Base plus généreuse quand peu d'ennemis, plus stricte quand ça charge
  // 0 → 50 zombies : 8
  // 51 → 150 zombies : 6
  // >150 zombies : 4
  let base = 8;
  if (z > 150) base = 4;
  else if (z > 50) base = 6;
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
const FIXED_DT = 1 / TICK_HZ;  // seconds per fixed step
const MAX_STEPS = 5;              // anti-spirale si gros retard
// Budget courant de pathfinding pour CE tick (réinitialisé dans stepOnce)
let PF_BUDGET_THIS_TICK = 0;
let lastTime = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
let accumulator = 0;
function broadcastLobby(game) {
  try {
    const playersOrig = (game && game.lobby && game.lobby.players) ? game.lobby.players : {};
    const count = Object.keys(playersOrig).length;
    const manual = !!(game.lobby && game.lobby.manual);
    const started = !!(game.lobby && game.lobby.started);
    const timeLeft = game.lobby.timeLeft;
    const max = MAX_PLAYERS;
    const hostIdReal = (game.lobby && game.lobby.hostId) || null;
    for (const sid in playersOrig) {
      const pub = {};
      let idx = 0;
      for (const otherId in playersOrig) {
        if (otherId === sid) { pub[otherId] = playersOrig[otherId]; }
        else {
          // Avoid duplicating the host: if the recipient is NOT the host,
          // we expose the host only under the 'host' alias (not as pX).
          if (hostIdReal && hostIdReal !== sid && otherId === hostIdReal) {
            continue;
          }
          pub['p' + (++idx)] = playersOrig[otherId];
        }
      }
      let hostOut = (hostIdReal === sid) ? sid : 'host';
      if (hostOut === 'host' && hostIdReal && playersOrig[hostIdReal]) {
        // Provide a single 'host' entry so the UI can show the crown,
        // without adding another pX alias for the host.
        pub['host'] = playersOrig[hostIdReal];
      }
      io.to(sid).emit('lobbyUpdate', {
        id: game.id,
        players: pub,
        count, max, timeLeft, started, manual,
        hostId: hostOut
      });
    }
  } catch(e) {
    try { console.error('[broadcastLobby error]', e && e.message); } catch(_){}
  }
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
    const prevRound = game.currentRound;
    game.currentRound++;
    game.zombiesSpawnedThisWave = 0;
    game.zombiesKilledThisWave = 0;
    // GOLD AWARD: starting from wave 5, award (prevRound-4) gold
    try {
      if (prevRound >= 5 && game._lastAwardedRound !== prevRound) {
        const bonus = prevRound - 4;
        // Build map of connected sockets per account
        const socketsMap = (io && io.sockets && io.sockets.sockets) ? io.sockets.sockets : null;
        const perUserSids = {};
        for (const sid in game.players) {
          try {
            const auth = getSessionUsernameBySocketId(sid);
            if (!auth) continue;
            const key = normalizeKey(auth);
            if (!perUserSids[key]) perUserSids[key] = { username: auth, sids: [] };
            perUserSids[key].sids.push(sid);
          } catch(_){}
        }
        if (db && __pgReady) {
          db.tx(async (c)=>{
            for (const key in perUserSids) {
              const r = await c.query('SELECT gold FROM users WHERE username_lower=$1 FOR UPDATE', [key]);
              if (!r.rows.length) continue;
              const g0 = r.rows[0].gold|0;
              const g1 = g0 + bonus;
              await c.query('UPDATE users SET gold=$2 WHERE username_lower=$1', [key, g1]);
              if (socketsMap) {
                for (const sid of perUserSids[key].sids) {
                  if (socketsMap.get(sid)) { try { io.to(sid).emit('goldUpdate', { total: g1 }); } catch(_){ } }
                }
              }
            }
          }).catch(()=>{});
        }
        game._lastAwardedRound = prevRound;
      }
    } catch(_){ } 
const _nextTotal = Math.ceil(Math.min(game.totalZombiesToSpawn, MAX_ZOMBIES_PER_WAVE) * 1.2);
    game.totalZombiesToSpawn = Math.min(_nextTotal, MAX_ZOMBIES_PER_WAVE);
    io.to('lobby' + game.id).emit('waveMessage', `Vague ${game.currentRound}`);
    io.to('lobby' + game.id).emit('currentRound', game.currentRound);
    io.to('lobby' + game.id).emit('waveStarted', { totalZombies: game.totalZombiesToSpawn });
    io.to('lobby' + game.id).emit('zombiesRemaining', game.totalZombiesToSpawn);
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
  
  try{ console.log('[LAUNCH] game', game && game.id, 'readyCount=', (game && game.lobby && Object.values(game.lobby.players||{}).filter(p=>p&&p.ready).length)); }catch(_){ }
// === ROBUST START FIX ===
  // Some clients may reconnect right before the game starts, changing their socket.id.
  // To avoid spawning "ghost" players that don't match current connections, we reconstruct
  // the readyPlayers list from the CURRENT room membership intersected with lobby.ready.
  try {
    const roomNow = io.sockets.adapter.rooms.get('lobby' + game.id);
    const cidsNow = roomNow ? Array.from(roomNow) : [];
    const reconstructed = [];
    for (const cid of cidsNow) {
      const entry = game.lobby && game.lobby.players ? game.lobby.players[cid] : null;
      if (entry && entry.ready) reconstructed.push([cid, entry]);
    }
    if (reconstructed.length > 0) {
      readyPlayersArr = reconstructed;
    }
  } catch (e) {
    console.error('[launchGame] ready reconstruction failed', e);
  }
  // === ROBUST START FIX END ===
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
  // Ensure each spawned player gets the LATEST account-level shop upgrades (hp/dmg)
  try {
    if (db && __pgReady) {
      const lowers = [];
      const sidToLower = {};
      for (const sid of socketsArr) {
        try {
          const u = getSessionUsernameBySocketId(sid);
          if (!u) continue;
          const lower = normalizeKey(u);
          sidToLower[sid] = lower;
          lowers.push(lower);
        } catch(_){}
      }
      if (lowers.length) {
        db.q('SELECT username_lower, shop_hp, shop_dmg FROM users WHERE username_lower = ANY($1)', [lowers])
          .then(r=>{
            const map = new Map();
            for (const row of (r.rows||[])) map.set(row.username_lower, row);
            for (const sid of socketsArr) {
              const lower = sidToLower[sid];
              if (!lower) continue;
              const row = map.get(lower);
              if (!row) continue;
              if (game && game.players && game.players[sid]) {
                game.players[sid].accountShop = { hp: (row.shop_hp|0)||0, dmg: (row.shop_dmg|0)||0 };
                try {
                  const oldMax = game.players[sid].maxHealth || 100;
                  const stats = getPlayerStats(game.players[sid]);
                  const ratio = Math.max(0, Math.min(1, (game.players[sid].health || 0) / (oldMax || 100)));
                  game.players[sid].maxHealth = stats.maxHp;
                  game.players[sid].health = Math.round(stats.maxHp * ratio);
                } catch(_){}
                try { io.to(sid).emit('accountShopUpdated', game.players[sid].accountShop); } catch(_){}
              }
            }
          })
          .catch(()=>{});
      }
    }
  } catch(_){}
for (const sid in (game.players||{})) {
    try {
      const pubPlayers = buildPublicMapForRecipient(sid, game.players, (game.lobby && game.lobby.hostId) || null);
      io.to(sid).emit('gameStarted', { gameId: game.id,
        map: game.map,
        players: pubPlayers,
        round: game.currentRound,
        structures: game.structures,
        structurePrices: SHOP_BUILD_PRICES,
        accountShop: (game && game.players && game.players[sid] && game.players[sid].accountShop) ? game.players[sid].accountShop : { hp:0, dmg:0 }
      });
} catch(_){}
  }
io.to('lobby' + game.id).emit('waveStarted', { totalZombies: game.totalZombiesToSpawn });
  io.to('lobby' + game.id).emit('zombiesRemaining', game.totalZombiesToSpawn);
  console.log(`---- Partie lancée : ${nbPlayers} joueur(s) dans la partie !`);
  startSpawning(game);
 // --- Reset du temps pour éviter l'accélération initiale après le lobby ---
lastTime = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
accumulator = 0;
_lastTickAtMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
}
io.on('connection', socket => {
// Per-IP connection limiter (max 6 sockets/IP). Counts exactly once per socket.
try {
  if (!socket.__ipCounted) {
    const __ip = (typeof getClientIP === 'function') ? (getClientIP(socket) || 'unknown') : 'unknown';
    socket.__clientIp = __ip;
    const prev = __ipConnCounts.get(__ip) || 0;
    if (prev >= 6) {
      try { socket.emit('tooManyConnections', { limit: 6 }); } catch(_){}
      try { socket.disconnect(true); } catch(_){}
      return;
    }
    __ipConnCounts.set(__ip, prev + 1);
    socket.__ipCounted = true;
    socket.once('disconnect', () => {
      try {
        const cur = __ipConnCounts.get(__ip) || 1;
        if (cur <= 1) __ipConnCounts.delete(__ip);
        else __ipConnCounts.set(__ip, cur - 1);
      } catch(_){}
    });
  }
} catch(_){}
  try {
    // Determine if this socket is a joined player for this worker (cookie 'w=<idx>')
    const ck = String((socket && socket.handshake && socket.handshake.headers && socket.handshake.headers.cookie) || '');
    const m = ck.match(/(?:^|;\s*)w=(\d+)/);
    const wCookie = m ? parseInt(m[1],10) : 0;
    socket.__joined = (wCookie === WORKER_INDEX);
    if (socket.__joined) {
      if (__joinedCountLocal >= WORKER_CAPACITY) {
        try { socket.emit('serverFull', { reason: 'capacity' }); } catch(_){}
        try { socket.disconnect(true); } catch(_){}
        return; // refuse connection
      }
      __joinedCountLocal++; global.__joinedCountLocal = __joinedCountLocal;
      try { if (typeof process.send === 'function') process.send({ type: 'joined:delta', delta: +1 }); } catch(_){}
      socket.once('disconnect', () => {
        try {
          if (socket.__joined) {
            __joinedCountLocal = Math.max(0, __joinedCountLocal - 1);
            global.__joinedCountLocal = __joinedCountLocal;
            if (typeof process.send === 'function') process.send({ type: 'joined:delta', delta: -1 });
          }
        } catch(_){}
      });
    } else {
      // non-joined visitor; do not count against capacity
      socket.once('disconnect', () => {});
    }
  } catch(_){}
    
  /*__WORKER_CONN_METRICS__*/
  try {
    if (typeof process.send === 'function') { process.send({ type:'player:delta', delta:+1 }); }
  } catch(_){}
  try {
    const wid = parseInt(process.env.WORKER_INDEX||'1',10) || 1;
    const wtot = parseInt(process.env.WORKERS||'1',10) || 1;
    socket.emit('workerInfo', { id: wid, total: wtot });
    // Allow client to request workerInfo in case it missed the initial emit
    try {
      socket.on('requestWorkerInfo', function(){
        try {
          const wid = parseInt(process.env.WORKER_INDEX||'1',10) || 1;
          const wtot = parseInt(process.env.WORKERS||'1',10) || 1;
          socket.emit('workerInfo', { id: wid, total: wtot });
        } catch(_){}
      });
    } catch(_){}
  } catch(_){}
  try {
    socket.on('disconnect', function(){
      try { releaseWorldChatName(socket); } catch(_){}
      try { if (typeof process.send === 'function') { process.send({ type:'player:delta', delta:-1 }); } } catch(_){}
    });
  } catch(_){}
// Detect if the client is mobile from User-Agent (used to avoid sending chat to mobile in-game)
    try {
      const ua = (socket && socket.handshake && socket.handshake.headers && socket.handshake.headers['user-agent']) || '';
      socket.__isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(String(ua));
    } catch(_){ socket.__isMobile = false; }
  // Ultra-aggressive: host cleanup BEFORE disconnect completes
    // Soft handling: do NOT auto-close manual lobbies on transient disconnects.
  socket.on('disconnecting', () => { /* no-op (grace handled on 'disconnect') */ });
  // Token-based reclaim is now handled via 'reclaimHost' event from client after connect.
  let __reclaimed = false;
      if (!__reclaimed) {
// Attache tout de suite le joueur à un lobby pour avoir "game" dispo
    const game = getAvailableLobby();
    socketToGame[socket.id] = game.id;
    socket.join('lobby' + game.id);
  }
  // Allow non-host players to reclaim their previous lobby seat after a reconnect (by gameId + pseudo)
  socket.on('reclaimPlayer', (payload, cb) => {
    try {
      payload = payload || {};
      const targetId = Number(payload.gameId) || 0;
      let pseudo = String(payload.pseudo || '').trim().substring(0, 10).replace(/[^a-zA-Z0-9]/g, '');
      if (!targetId || !pseudo) { try { if (cb) cb({ ok:false, reason:'invalid' }); } catch(_){} return; }
      const currentGid = socketToGame[socket.id];
      const target = activeGames.find(g => g && g.id === targetId);
      if (!target || !target.lobby || target.lobby.started) { try { if (cb) cb({ ok:false, reason:'not_joinable' }); } catch(_){} return; }
      // Find a stale roster entry matching this pseudo (socket no longer connected)
      const roster = (target.lobby && target.lobby.players) || {};
      const socketsMap = (io && io.sockets && io.sockets.sockets) ? io.sockets.sockets : null;
      let oldSid = null;
      for (const sid in roster) {
        const entry = roster[sid];
        if (!entry) continue;
        if (String(entry.pseudo || '') === pseudo) {
          const alive = socketsMap && socketsMap.get(sid);
          if (!alive) { oldSid = sid; break; }
        }
      }
      if (!oldSid) { try { if (cb) cb({ ok:false, reason:'no_match' }); } catch(_){} return; }
      // Move the roster entry to this new socket id
      try {
        roster[socket.id] = roster[oldSid];
        delete roster[oldSid];
      } catch(_) {}
      // Move the socket to the right room and update mapping
      try {
        const prev = activeGames.find(g => g && g.id === currentGid);
        if (prev && prev.id !== target.id) { try { socket.leave('lobby' + prev.id); } catch(_){} }
      } catch(_) {}
      try { socket.join('lobby' + target.id); } catch(_) {}
      socketToGame[socket.id] = target.id;
      broadcastLobby(target);
      try { if (cb) cb({ ok:true, gameId: target.id }); } catch(_) {}
    } catch(e) {
      try { if (cb) cb({ ok:false, reason:'error' }); } catch(_){}
    }
  });
  // Client asked for an explicit lobby state snapshot
  socket.on('requestLobbyState', () => {
    try {
      const gid = socketToGame[socket.id];
      const g = activeGames.find(x => x && x.id === gid);
      if (g) {
        io.to(socket.id).emit('lobbyUpdate', {
          id: g.id,
          players: g.lobby.players,
          count: Object.keys(g.lobby.players||{}).length,
          max: MAX_PLAYERS,
          timeLeft: g.lobby.timeLeft,
          started: g.lobby.started,
          manual: !!(g.lobby && g.lobby.manual),
          hostId: (g.lobby && g.lobby.hostId) || null,
        });
      }
    } catch(_) {}
  });
socket.on('clientPing', () => {});
  
  // Emit initial lobby state for this socket's current lobby
  try {
    const __gid = socketToGame[socket.id];
    const __g = activeGames.find(g => g && g.id === __gid);
    if (__g) {
      socket.emit('lobbyUpdate', { id: __g.id, players: __g.lobby.players, count: Object.keys(__g.lobby.players).length, max: MAX_PLAYERS, timeLeft: __g.lobby.timeLeft, started: __g.lobby.started, hostId: __g.lobby.hostId });
    }
  } catch(e) { console.error('emit lobbyUpdate failed', e); }
// ====== ULTRA-AGGRESSIVE CHAT HANDLERS ======
  try { socket.join('world'); } catch(_) {}
  // Client asks history for a channel
  socket.on('chat:join', (payload) => {
    try {
      const channel = (payload && payload.channel) === 'lobby' ? 'lobby' : 'world';
      if (channel === 'world') {
        const history = Array.isArray(worldChatHistory) ? worldChatHistory.slice(-50) : [];
        io.to(socket.id).emit('chat:history', { channel, history });
      } else {
        const gid = socketToGame[socket.id];
        const game = activeGames.find(g => g && g.id === gid);
        if (!game) return;
        const history = Array.isArray(game.chatHistory) ? game.chatHistory.slice(-50) : [];
        io.to(socket.id).emit('chat:history', { channel, history });
      }
    } catch(e){}
  });
  // Fallback pull (explicit request)
  socket.on('chat:pull', (payload, cb) => {
    try {
      const channel = (payload && payload.channel) === 'lobby' ? 'lobby' : 'world';
      let arr = [];
      if (channel === 'world') {
        // Send only the most recent 30 messages to clients (reduced from 50)
        arr = Array.isArray(worldChatHistory) ? worldChatHistory.slice(-30) : [];
      } else {
        const gid = socketToGame[socket.id];
        const game = activeGames.find(g => g && g.id === gid);
        if (game && Array.isArray(game.chatHistory)) arr = game.chatHistory.slice(-30);
      }
      if (cb) cb({ ok:true, channel, history: arr });
      else io.to(socket.id).emit('chat:history', { channel, history: arr });
    } catch(e){ if (cb) cb({ ok:false }); }
  });
  // Send a message
  socket.on('chat:send', (payload) => {
  try {
    const now = Date.now();
    const channel = (payload && payload.channel) === 'lobby' ? 'lobby' : 'world';
    // basic sanitize
    let text = String((payload && payload.text) || '').replace(/[\r\n\t]/g,' ').trim();
    if (!text) return;
    // Allow up to 100 characters per message (increase from previous 50)
    if (text.length > 100) text = text.slice(0,100);
    // cooldown per IP (2s)
    {
      const ip = getClientIP(socket) || 'unknown';
      const last = chatLastByIp.get(ip) || 0;
      if (now - last < 2000) {
        try { io.to(socket.id).emit('chat:error', { type:'cooldown', waitMs: 2000 - (now - last) }); } catch(_){}
        return;
      }
      chatLastByIp.set(ip, now);
    }
    // resolve pseudo
    let pseudo = 'player';
    try {
      const gid = socketToGame[socket.id];
      const game = activeGames.find(g => g && g.id === gid);
      if (game) {
        pseudo = (game.players && game.players[socket.id] && game.players[socket.id].pseudo)
              || (game.lobby && game.lobby.players && game.lobby.players[socket.id] && game.lobby.players[socket.id].pseudo)
              || 'player';
      }
    } catch(_){}
    if (!pseudo || pseudo === 'player') {
      const lp = lastPseudoBySocket.get(socket.id);
      if (lp) pseudo = lp;
    }
    // Allow using client-provided display name ONLY as a fallback, sanitized,
    // and without letting users impersonate registered accounts.
    if ((!pseudo || pseudo === 'player') && payload && typeof payload.name === 'string') {
      try {
        let candidate = sanitizeUsername(payload.name);
        if (candidate) {
          const sessUser = getSessionUsernameBySocketId(socket.id);
          if (!isRegisteredUsername(candidate) || sessUser === candidate) {
            pseudo = candidate;
            try { lastPseudoBySocket.set(socket.id, candidate); } catch(_){}
          }
        }
      } catch(_){}
    }
    if (!pseudo || pseudo === 'player') {
      try {
        const ip2 = getClientIP(socket) || '';
        const h = require('crypto').createHash('md5').update(String(ip2||socket.id)).digest('hex').slice(0,4).toUpperCase();
        pseudo = 'Guest' + h;
      } catch(_){ pseudo = 'Guest'; }
    }
    // Enforce uniqueness rules by channel
    if (channel === 'world') {
      // Server-authoritative, collision-free assignment for world chat
      pseudo = claimWorldChatName(socket, pseudo);
    } else {
      // Lobby chat remains strict: any duplicate is rejected
      if (isPseudoTaken(pseudo, socket.id)) {
        try { io.to(socket.id).emit('chat:error', { type:'pseudo_taken' }); } catch(_){}
        return;
      }
    }
    const msg = { sid: socket.id, pseudo, text, ts: now, channel };
    if (channel === 'world') {
      worldChatHistory.push(msg);
      // Keep only the most recent 30 messages in the world chat history (was 500)
      if (worldChatHistory.length > 30) worldChatHistory.shift();
      // Global broadcast: everyone receives world chat regardless of room state
      // Echo to sender, then send to others in 'world' excluding mobile clients that are in-game
      try { io.to(socket.id).emit('chat:msg', msg); } catch(_){}
      try {
        const nsp = io.of('/');
        nsp.in('world').fetchSockets().then(clients => {
          clients.forEach(cl => {
            try {
              const gid2 = socketToGame[cl.id];
              const g2 = activeGames.find(gg => gg && gg.id === gid2);
              const inGameNow = !!(g2 && g2.lobby && g2.lobby.started);
              if (!(cl.id === socket.id) && !(cl.__isMobile && inGameNow)) {
                cl.emit('chat:msg', msg);
              }
            } catch(_){}
          });
        }).catch(_=>{});
      } catch(_){}
    } else {
      const gid = socketToGame[socket.id];
      const game = activeGames.find(g => g && g.id === gid);
      if (!game) return;
      game.chatHistory = game.chatHistory || [];
      game.chatHistory.push(msg);
      // Keep only the most recent 30 messages in each lobby chat history (was 200)
      if (game.chatHistory.length > 30) game.chatHistory.shift();
      // Broadcast lobby chat globally but with channel='lobby' (clients not on lobby tab will ignore)
      // Echo to sender, then broadcast to other lobby members (excluding mobile clients that are currently in-game)
      try { io.to(socket.id).emit('chat:msg', msg); } catch(_){}
      try {
        const nsp = io.of('/');
        nsp.in('lobby' + game.id).fetchSockets().then(clients => {
          clients.forEach(cl => {
            try {
              const gid2 = socketToGame[cl.id];
              const g2 = activeGames.find(gg => gg && gg.id === gid2);
              const inGameNow2 = !!(g2 && g2.lobby && g2.lobby.started);
              if (!(cl.id === socket.id) && !(cl.__isMobile && inGameNow2)) {
                cl.emit('chat:msg', msg);
              }
            } catch(_){}
          });
        }).catch(_=>{});
      } catch(_){}
    }
  } catch(e){}
});socket.on('createLobby', (pseudo, cb) => {
    // Sanitize pseudo and create a fresh manual lobby with this socket as host
    pseudo = (pseudo || '').trim().substring(0, 10).replace(/[^a-zA-Z0-9]/g, '');
    if (!pseudo) { if (cb) cb({ ok:false, reason:'invalid_pseudo' }); return; }
    
      // Reserved username enforcement: if pseudo is a registered account, only the authenticated owner can use it
      {
        const sessUser = getSessionUsernameBySocketId(socket.id);
        if (isRegisteredUsername(pseudo) && normalizeKey(sessUser||'') !== normalizeKey(pseudo)) {
          if (cb) cb({ ok:false, reason:'reserved' });
          return;
        }
      }
if (isPseudoTaken(pseudo, socket.id)) { if (cb) cb({ ok:false, reason:'pseudo_taken' }); return; }
// Enforce limit: up to two manual lobbies per public IP at the same time (as founder)
    const __hostIp = getClientIP(socket);
    // Count existing manual lobbies for this IP whose host is currently connected (not started)
    let __hostingCount = 0;
    try {
      for (const g of activeGames) {
        if (
          g && g.lobby && g.lobby.manual && !g.lobby.started &&
          g.lobby.hostIp && g.lobby.hostIp === __hostIp &&
          g.lobby.hostId && io.sockets.sockets.get(g.lobby.hostId)
        ) { __hostingCount++; if (__hostingCount >= 2) break; }
      }
    } catch(_){}
    if (__hostingCount >= 2) { if (cb) cb({ ok:false, reason:'ip_limit' }); return; }
    const oldGameId = socketToGame[socket.id];
    const oldGame = activeGames.find(g => g.id === oldGameId);
    const newGame = createNewGame();
    newGame.lobby.manual = true;
    newGame.lobby.hostId = socket.id;
    newGame.lobby.hostIp = __hostIp;
    // Generate a host token for secure reclaim
    newGame.lobby.hostToken = nodeCrypto.randomBytes(16).toString('hex');
    newGame.lobby.players[socket.id] = { pseudo, ready: true };
    try { lastPseudoBySocket.set(socket.id, pseudo); } catch(_){ }
    // Move socket room + mapping
    if (oldGame) { try { socket.leave('lobby' + oldGame.id); } catch(_){} }
    socketToGame[socket.id] = newGame.id;
    socket.join('lobby' + newGame.id);
    broadcastLobby(newGame);
    if (cb) cb({ ok:true, gameId:newGame.id , hostToken: newGame.lobby.hostToken});
  });
  // === Secure host reclaim by token ===
  socket.on('reclaimHost', (payload, cb) => {
    try {
      payload = payload || {};
      const gameId = Number(payload.gameId) || 0;
      const token = String(payload.token || '');
      const g = activeGames.find(x => x && x.id === gameId);
      if (!g || !g.lobby || !g.lobby.manual || g.lobby.started) { if (cb) cb({ ok:false }); return; }
      if (!token || token !== g.lobby.hostToken) { if (cb) cb({ ok:false }); return; }
      // Transfer host to this socket
      const prevHostId = g.lobby.hostId;
      let pseudo = 'Player';
      try {
        if (g.lobby.players && g.lobby.players[prevHostId] && g.lobby.players[prevHostId].pseudo) {
          pseudo = g.lobby.players[prevHostId].pseudo;
          delete g.lobby.players[prevHostId];
        }
      } catch(_) {}
      g.lobby.hostId = socket.id;
      g.lobby.players[socket.id] = { pseudo, ready: true };
      socketToGame[socket.id] = g.id;
      try { socket.join('lobby' + g.id); } catch(_) {}
      // Cancel any grace timers if they exist
      try { if (g.lobby._hostGraceTimer) { clearTimeout(g.lobby._hostGraceTimer); g.lobby._hostGraceTimer = null; } } catch(_){}
      broadcastLobby(g);
      if (cb) cb({ ok:true });
    } catch(e) {
      try { if (cb) cb({ ok:false, err: String(e && e.message || e) }); } catch(_) {}
    }
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
    pseudo = (pseudo || '').trim().substring(0, 10).replace(/[^a-zA-Z0-9]/g, '');
    if (!pseudo) { if (cb) cb({ ok:false, reason:'invalid_pseudo' }); return; }
    
      // Reserved username enforcement
      {
        const sessUser = getSessionUsernameBySocketId(socket.id);
        if (isRegisteredUsername(pseudo) && normalizeKey(sessUser||'') !== normalizeKey(pseudo)) {
          if (cb) cb({ ok:false, reason:'reserved' });
          return;
        }
      }
if (isPseudoTaken(pseudo, socket.id)) { try { io.to(socket.id).emit('join:error', { type:'pseudo_taken' }); } catch(_){ } if (cb) cb({ ok:false, reason:'pseudo_taken' }); return; }
    const target = activeGames.find(g => g.id === targetId);
    if (!target || !target.lobby.manual || target.lobby.started) { if (cb) cb({ ok:false, reason:'not_joinable' }); return; }
    const count = Object.keys(target.lobby.players||{}).length;
    if (count >= MAX_PLAYERS) { if (cb) cb({ ok:false, reason:'full' }); return; }
    // Refuse join if this IP was recently kicked from this lobby
    try {
      const ip = getClientIP(socket);
      const until = target && target.lobby && target.lobby.kickedUntilByIp ? target.lobby.kickedUntilByIp[ip] : 0;
      if (until && until > Date.now()) {
        if (cb) cb({ ok:false, reason:'kicked', wait: Math.ceil((until - Date.now())/1000) });
        return;
      }
    } catch(_) {}
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
  
// Host-only: kick a player from the manual lobby and block their IP for 30s
// Host-only: kick a player from the manual lobby and block their IP for 30s
socket.on('kickPlayer', (data, cb) => {
  try {
    const gameId = socketToGame[socket.id];
    const game = activeGames.find(g => g.id === gameId);
    if (!game || !game.lobby || !game.lobby.manual || game.lobby.started) { if (cb) cb && cb({ ok:false, reason:'not_in_manual' }); return; }
    if (game.lobby.hostId !== socket.id) { if (cb) cb && cb({ ok:false, reason:'not_host' }); return; }
        // Resolve target; accept real socket.id or host-view aliases like 'p1','p2'
    let targetId = data && data.targetId;
    if (!targetId) { if (cb) cb && cb({ ok:false, reason:'invalid_target' }); return; }
    if (targetId === socket.id) { if (cb) cb && cb({ ok:false, reason:'invalid_target' }); return; }
    if (typeof targetId === 'string') {
      const m = targetId.match(/^p(\d+)$/);
      if (m) {
        try {
          const idx = Math.max(0, parseInt(m[1], 10) - 1);
          const otherIds = Object.keys(game.lobby.players).filter(id => id !== socket.id);
          if (otherIds[idx]) targetId = otherIds[idx];
        } catch(_){}
      } else if (targetId === 'host') {
        if (cb) cb && cb({ ok:false, reason:'invalid_target' }); return;
      }
    }
    if (!game.lobby.players[targetId]) { if (cb) cb && cb({ ok:false, reason:'not_in_lobby' }); return; }
    // compute IP of target socket
    const targetSock = io.sockets.sockets.get(targetId);
    const ip = targetSock ? getClientIP(targetSock) : null;
    const until = Date.now() + 30000; // 30s
    if (!game.lobby.kickedUntilByIp) game.lobby.kickedUntilByIp = {};
    if (ip) game.lobby.kickedUntilByIp[ip] = until;
    // Remove from this lobby
    try { delete game.lobby.players[targetId]; } catch(_){}
    try { if (targetSock) targetSock.leave('lobby' + game.id); } catch(_){}
    // Clear mapping so the client is effectively "in menu"
    try { delete socketToGame[targetId]; } catch(_){}
    // Notify the kicked client; client will show main menu
    try { if (targetSock) io.to(targetId).emit('kicked', { gameId: game.id, until }); } catch(_){}
    // Update the original lobby for everyone else
    broadcastLobby(game);
    if (cb) cb({ ok:true, until });
  } catch (e) {
    try { if (cb) cb({ ok:false, reason:'error' }); } catch(_){}
  }
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
    const gameId = socketToGame[socket.id];
    const game = activeGames.find(g => g.id === gameId);
    if (!game) { return; }
    if (!['t','T','G'].includes(type)) { return; }
    const player = game.players[socket.id];
    if (!player) { return; }
    player.turretUpgrades = player.turretUpgrades || {};
    const current = player.turretUpgrades[type] || 0;
    const basePrice = (type === 't') ? 500 : (type === 'T' ? 2000 : 10000);
    const growth = (type === 'G') ? 1.20 : 1.30; // G 20%, others 30%
    const price = Math.round(basePrice * Math.pow(growth, current));
    if ((player.money||0) < price) {
      socket.emit('upgradeTurretResult', { ok:false, reason:'not_enough_money' });
      return;
    }
    player.money -= price;
    player.turretUpgrades[type] = current + 1;
    socket.emit('upgradeTurretResult', { ok:true, type, level: player.turretUpgrades[type], newMoney: player.money });
  } catch(e) {
    socket.emit('upgradeTurretResult', { ok:false, reason:'server_error' });
  }
});
  socket.on('giveMillion', () => {
  const gid = socketToGame[socket.id];
  const game = activeGames.find(g => g.id === gid);
  if (!game) return;
  const player = game.players[socket.id];
  if (player && isAdminSocket(socket)) {
    player.money = 1000000;
    socket.emit('upgradeUpdate', { myUpgrades: player.upgrades, myMoney: player.money });
  }
});
socket.on('skipRound', () => {
  const gameId = socketToGame[socket.id];
  const game = activeGames.find(g => g.id === gameId);
  if (!game) return;
  const player = game.players[socket.id];
  if (!isAdminSocket(socket)) return;
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
  pseudo = (pseudo || '').trim().substring(0, 10);
  pseudo = pseudo.replace(/[^a-zA-Z0-9]/g, '');
  if (!pseudo) pseudo = 'Joueur';
  
    // Reserved username enforcement
    {
      const sessUser = getSessionUsernameBySocketId(socket.id);
      if (isRegisteredUsername(pseudo) && normalizeKey(sessUser||'') !== normalizeKey(pseudo)) {
        try { io.to(socket.id).emit('setPseudoAndReadyResult', { ok:false, reason:'reserved' }); } catch(_){}
        return;
      }
    }
if (isPseudoTaken(pseudo, socket.id)) { try { io.to(socket.id).emit('setPseudoAndReadyResult', { ok:false, reason:'pseudo_taken' }); } catch(_) {} return; }
  game.lobby.players[socket.id] = { pseudo, ready: true };
  try { lastPseudoBySocket.set(socket.id, pseudo); } catch(_){ }
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
socket.on('renamePseudo', (data, cb) => {
  try {
    // Accept either a string or an object: { pseudo: '...' }
    let p = (typeof data === 'string') ? data : (data && data.pseudo) || '';
    p = String(p || '').trim().substring(0, 10).replace(/[^a-zA-Z0-9]/g, '');
    if (!p) { 
      try { if (cb) cb({ ok:false, reason:'invalid_pseudo' }); } catch(_){}
      try { io.to(socket.id).emit('renameResult', { ok:false, reason:'invalid_pseudo' }); } catch(_){}
      return;
    }
    
    // Reserved username enforcement
    {
      const sessUser = getSessionUsernameBySocketId(socket.id);
      if (isRegisteredUsername(p) && normalizeKey(sessUser||'') !== normalizeKey(p)) {
        try { if (cb) cb({ ok:false, reason:'reserved' }); } catch(_){}
        try { io.to(socket.id).emit('renameResult', { ok:false, reason:'reserved' }); } catch(_){}
        return;
      }
    }
if (isPseudoTaken(p, socket.id)) { try { if (cb) cb({ ok:false, reason:'pseudo_taken' }); } catch(_){} try { io.to(socket.id).emit('renameResult', { ok:false, reason:'pseudo_taken' }); } catch(_){} return; }
    const gid = socketToGame[socket.id];
    const game = activeGames.find(g => g && g.id === gid);
    if (game) {
      // Update pseudo in both lobby roster and active players if present
      try { if (game.lobby && game.lobby.players && game.lobby.players[socket.id]) game.lobby.players[socket.id].pseudo = p; } catch(_){}
      try { if (game.players && game.players[socket.id]) game.players[socket.id].pseudo = p; } catch(_){}
      try { lastPseudoBySocket.set(socket.id, p); } catch(_){ }
      // Notify lobby UIs
      try { broadcastLobby(game); } catch(_){}
      // Also refresh health/name overlays for clients already in-game
      try { for (const sid in (game.players||{})) { const _pl = game.players[sid]; if (!_pl) continue; const _cx = (_pl.spectator && _pl.viewX != null) ? _pl.viewX : (_pl.x || 0); const _cy = (_pl.spectator && _pl.viewY != null) ? _pl.viewY : (_pl.y || 0); io.to(sid).emit('playersHealthUpdate', getPlayersHealthStateFiltered(game, _cx, _cy, SERVER_VIEW_RADIUS)); } } catch(_){}
    }
    try { if (cb) cb({ ok:true, pseudo: p }); } catch(_){}
    try { io.to(socket.id).emit('renameResult', { ok:true, pseudo: p }); } catch(_){}
  } catch(e) {
    try { if (cb) cb({ ok:false, reason:'server_error' }); } catch(_){}
    try { io.to(socket.id).emit('renameResult', { ok:false, reason:'server_error' }); } catch(_){}
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
    try { releaseWorldChatName(socket); } catch(_){}
    try { lastPseudoBySocket.delete(socket.id); } catch(_){}
    // Try to resolve the game from mapping
    const mappedId = socketToGame[socket.id];
    let game = activeGames.find(g => g && g.id === mappedId) || null;
    // Fallback: direct lookup by hostId (covers cases where mapping was lost)
    if (!game) {
      game = activeGames.find(g => g && g.lobby && g.lobby.manual && !g.lobby.started && g.lobby.hostId === socket.id) || null;
    }
    // Immediate cleanup for NON-HOST players who are sitting in any lobby (not started)
    // This prevents a refreshed page from leaving a ghost seat.
    try {
      // Find the lobby that currently contains this socket as a player
      let _lobbyGame = activeGames.find(g => g && g.lobby && !g.lobby.started && g.lobby.players && g.lobby.players[socket.id]);
      if (_lobbyGame) {
        const _isHost = !!(_lobbyGame.lobby.manual && _lobbyGame.lobby.hostId === socket.id);
        if (!_isHost) {
          try { delete _lobbyGame.lobby.players[socket.id]; } catch(_) {}
          try { socket.leave('lobby' + _lobbyGame.id); } catch(_) {}
          try { broadcastLobby(_lobbyGame); } catch(_) {}
          try { delete socketToGame[socket.id]; } catch(_) {}
          try { cleanupEmptyManualLobbies(); } catch(_) {}
        }
      }
    } catch (e) { try { console.warn('[disconnect] early non-host cleanup failed', e && (e.message||e)); } catch(_) {} }
    // If the disconnecting socket is the HOST of a MANUAL lobby (not started) -> **do not close immediately**.
    // Set a grace timer; if the host doesn't reconnect in time, then close the lobby.
    if (game && game.lobby && game.lobby.manual && !game.lobby.started && game.lobby.hostId === socket.id) {
      try {
        if (game.lobby._hostGraceTimer) { clearTimeout(game.lobby._hostGraceTimer); }
        game.lobby._hostGraceTimer = setTimeout(() => {
          try {
            // If lobby still exists and still not started, and the host hasn't reclaimed it, close & evac players.
            if (!game || !game.lobby || !game.lobby.manual || game.lobby.started) return;
            // If the current hostId is connected again, cancel.
            const hostSock = io.sockets.sockets.get(game.lobby.hostId);
            if (hostSock) return;
            // Notify and force everyone out of this manual lobby
            try { io.to('lobby' + game.id).emit('lobbyClosed'); io.to('lobby' + game.id).emit('forceReload'); } catch (_) {}
            const room = io.sockets.adapter.rooms.get('lobby' + game.id);
            const ids = room ? Array.from(room) : [];
            for (const cid of ids) {
              try {
                const s = io.sockets.sockets.get(cid);
                if (s) { try { s.leave('lobby' + game.id); } catch(_){} }
                if (game.lobby && game.lobby.players) delete game.lobby.players[cid];
                if (game.players && game.players[cid]) delete game.players[cid];
                if (game._lastNetSend) delete game._lastNetSend[cid];
                try { delete socketToGame[cid]; } catch (_){}
              } catch(_){}
            }
    // For NON-HOST players or non-manual lobbies: immediately remove the player from the lobby on disconnect
    // (treat as if they pressed "Back"). This prevents ghost seats when a page is refreshed.
    try {
      // Re-evaluate the game mapping in case previous block mutated it
      const __gid = socketToGame[socket.id];
      let __game = activeGames.find(g => g && g.id === __gid) || null;
      if (!__game) {
        // attempt to find by presence in lobby roster
        __game = activeGames.find(g => g && g.lobby && g.lobby.players && g.lobby.players[socket.id]) || null;
      }
      if (__game && __game.lobby && !__game.lobby.started) {
        // If this is a manual lobby AND the disconnecting socket is the host, we already handled grace above;
        // skip the immediate kick here in that special case.
        const isHost = !!(__game.lobby.manual && __game.lobby.hostId === socket.id);
        if (!isHost) {
          try { if (__game.lobby.players && __game.lobby.players[socket.id]) delete __game.lobby.players[socket.id]; } catch(_){}
          try { broadcastLobby(__game); } catch(_){}
          try { delete socketToGame[socket.id]; } catch(_){}
          try { cleanupEmptyManualLobbies(); } catch(_){}
        }
      } else {
        // If the game was already started or not found, ensure the mapping is cleared.
        try { delete socketToGame[socket.id]; } catch(_){}
      }
    } catch (e) { try { console.warn('[disconnect] cleanup error', e && (e.message || e)); } catch(_){ } }
            try { if (game.lobby && game.lobby.timer) { clearInterval(game.lobby.timer); game.lobby.timer = null; } } catch (_){}
            // Remove game entirely
            activeGames = activeGames.filter(g => g !== game);
          } catch (e) {
            console.error('[disconnect host grace cleanup] error', e);
          }
        }, 30000); // 30s grace
      } catch (e) {
        console.error('[disconnect host] scheduling grace failed', e);
      }
    } else {
      // Non-host or non-manual lobbies: existing cleanup (if any) continues to apply elsewhere.
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
// Apply shared cooldown for walls & doors
if (type === 'B' || type === 'D') {
  const now = Date.now();
  const last = player.lastBlockPlaceAt || 0;
  const remaining = BLOCK_PLACE_COOLDOWN_MS - (now - last);
  if (remaining > 0) {
    io.to(socket.id).emit('blockCooldown', { until: now + remaining });
    io.to(socket.id).emit('buildResult', { ok: false, reason: 'block_cooldown', ms: remaining });
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
  // Grâce de collision
if (type === 'B' || type === 'D') {
  player.lastBlockPlaceAt = Date.now();
  try { io.to(socket.id).emit('blockCooldown', { until: player.lastBlockPlaceAt + BLOCK_PLACE_COOLDOWN_MS }); } catch(_){}
}
// Grâce de collision
// seulement si le joueur a posé sous lui
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
  if (!player || !player.alive || player.spectator) return;
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
  const now = Date.now();
  if (now - (p._lastZsnapAt || 0) < 200) return;
  p._lastZsnapAt = now;
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
    
    (function(){ try {
      const _p = game.players[socket.id];
      if (_p && !_p.isBot && !_p._ladderSubmitted) {
        _p._ladderSubmitted = true;
        recordLadderScoreServer((_p.pseudo && String(_p.pseudo)) || 'anonymous', Number(game.currentRound) || 0, Number(_p.kills) || 0);
      }
    } catch(_e) { console.error('[LADDER] record error', _e); } })();
for (const sid in (game.players||{})) { const _pl = game.players[sid]; if (!_pl) continue; const _cx = (_pl.spectator && _pl.viewX != null) ? _pl.viewX : (_pl.x || 0); const _cy = (_pl.spectator && _pl.viewY != null) ? _pl.viewY : (_pl.y || 0); io.to(sid).emit('playersHealthUpdate', getPlayersHealthStateFiltered(game, _cx, _cy, SERVER_VIEW_RADIUS)); }
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
    if (p.alive) return;
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
  if (!isAdminSocket(socket)) return;
  game.zombies = {};
  game._zombieCount = 0;
  io.to('lobby' + game.id).emit('zombiesUpdate', game.zombies);
});
});
function getPlayerStats(player) {
  const u = player?.upgrades || {};
  const base = { maxHp: 100, speed: 40, regen: 0, damage: 10, goldGain: 10 }; // regen à 0 pour éviter la confusion
  const lvl = u.regen || 0;
  const regen = (lvl <= 10) ? lvl : +(10 * Math.pow(1.1, lvl - 10)).toFixed(2);
  const acc = (player && player.accountShop) || {hp:0,dmg:0};
// Apply account-level additive bonuses FIRST, so in-game upgrades scale off the true base
const baseWithShop = {
  maxHp: base.maxHp + ((acc.hp|0) * 10),
  damage: base.damage + ((acc.dmg|0) * 1),
  speed: base.speed,
  goldGain: base.goldGain
};
const up = player && player.upgrades || {};
const maxHp = Math.round(baseWithShop.maxHp * Math.pow(1.1, (up.maxHp || 0)));
const damage = Math.round(baseWithShop.damage * Math.pow(1.1, (up.damage || 0)));
const speed  = +(baseWithShop.speed * (1 + 0.05 * (up.speed || 0))).toFixed(1);
const goldGain = Math.round(baseWithShop.goldGain * Math.pow(1.1, up.goldGain || 0));
const baseStats = { maxHp, speed, regen, damage, goldGain };
return baseStats;
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
              
              if (!p.isBot && !p._ladderSubmitted) {
                p._ladderSubmitted = true;
                recordLadderScoreServer((p.pseudo && String(p.pseudo)) || 'anonymous', Number(game.currentRound) || 0, Number(p.kills) || 0);
              }
io.to(pid).emit('youDied', { kills: p.kills || 0, round: game.currentRound, gameId: game.id });
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
          // --- Robust fix: remap bullet.owner to the SAME aliases used in playersHealth for this recipient ---
          const hostId = (game.lobby && game.lobby.hostId) || null;
          const ownerAliasMap = {};
          let __idx = 0;
          for (const k in phSnap) {
            if (k === sid) {
              ownerAliasMap[k] = k; // keep self under real sid
            } else {
              if (hostId && hostId !== sid && k === hostId) {
                // host will be exposed separately as 'host' (do not consume a pX slot)
                continue;
              }
              ownerAliasMap[k] = 'p' + (++__idx);
            }
          }
          if (hostId && hostId !== sid && phSnap[hostId]) {
            ownerAliasMap[hostId] = 'host';
          }
          const bPub = {};
          for (const bid in bSnap) {
            const b = bSnap[bid];
            if (!b) continue;
            const alias = ownerAliasMap[b.owner] || b.owner;
            if (alias === b.owner) {
              bPub[bid] = b; // no change
            } else {
              // shallow clone to avoid mutating shared snapshot
              bPub[bid] = { id: b.id, owner: alias, x: b.x, y: b.y, dx: b.dx, dy: b.dy, createdAt: b.createdAt, lifeFrames: b.lifeFrames };
            }
          }
          
          // Build a compact zombie snapshot to minimize bandwidth and avoid leaking server-only fields
          const zPub = {};
          for (const zid in zSnap) {
            const z = zSnap[zid];
            if (!z) continue;
            const hp = (typeof z.hp === 'number') ? z.hp : 0;
            if (hp <= 0) continue;
            const zx = (typeof z.x === 'number') ? z.x : 0;
            const zy = (typeof z.y === 'number') ? z.y : 0;
            zPub[zid] = { id: zid, x: zx, y: zy, hp: hp };
          }
io.to(sid).volatile.emit('stateUpdate', {
            zombies: zPub,
            bullets: bPub,
            playersHealth: buildPublicMapForRecipient(sid, phSnap, hostId),
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
/*__CONDITIONAL_LISTEN__*/
if ((parseInt(process.env.WORKERS||'1',10) || 1) > 1) {
  // Cluster mode: only workers should accept connections. Master does not listen here.
  if (String(process.env.IS_CLUSTER_WORKER||'0') === '1') {
    console.log(`[Worker ${process.env.WORKER_INDEX||'?'}] ready (port handled by master)`);
  } else {
    console.log('[Master] Application server is not listening here (balancer handles the port).');
  }
} else {
  server.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
  });
}
// (removed old conditional listen block)
/* === AUTH: PBKDF2 hashes, cookie sessions (PostgreSQL only) === */
