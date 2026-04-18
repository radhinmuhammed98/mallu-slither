// worker/room.js — Cloudflare Durable Object: one instance per room
// Contains ALL game logic: Snake class, bots, collisions, orbs, game loop.
// Ported from server/server.js — logic unchanged, I/O adapted for native WebSockets.

const CONFIG = {
  worldSize: 4000,
  tickMs: 72,             // ~14 ticks/sec
  maxPlayers: 15,
  maxEntities: 25,
  initialOrbCount: 300,
  minOrbCount: 200,
  orbRefillBurst: 6,
  botRespawnDelayMs: 4000,
  botTrimIntervalMs: 2000,
  botSpawnPadding: 400,
  playerSpawnMin: 1000,
  playerSpawnRange: 2000,
};

const WORLD = CONFIG.worldSize;

const SKINS = [
  { name: 'Coconut', body: '#5fbf6a', glow: '#8bd39a', head: '#2f6f46', eye: '#fef9e8' },
  { name: 'Leaf',    body: '#7ed957', glow: '#9ff06f', head: '#3f7d2b', eye: '#fef9e8' },
  { name: 'Lotus',   body: '#d67a52', glow: '#f3a96d', head: '#8c4b2d', eye: '#fff7df' },
  { name: 'Gold',    body: '#d8a93a', glow: '#f0cb72', head: '#8f6517', eye: '#1d1808' },
  { name: 'Monsoon', body: '#4bb48c', glow: '#73d0ab', head: '#236b56', eye: '#f3f8ef' },
  { name: 'Paddy',   body: '#95c94d', glow: '#c2ea6a', head: '#55751d', eye: '#fffce6' },
  { name: 'Spice',   body: '#c96d34', glow: '#e2a15a', head: '#7f3d17', eye: '#fff6e0' },
  { name: 'Backwater',body: '#3aa680', glow: '#67cfa7', head: '#16614b', eye: '#eefcf7' },
];

const ORB_COLORS = ['#5fbf6a', '#d8a93a', '#7ed957', '#95c94d', '#c96d34', '#73d0ab'];

const BOT_NAMES = [
  'Achayan', 'Muttayi', 'Coconut Joe', 'Nair', 'Amma', 'Karimeen', 'Thekkan',
  'Vadakkan', 'Rajan', 'Molly', 'Rajesh', 'Padmini', 'Appan', 'Chechi',
];

// ─── UTILITIES ──────────────────────────────────────────────────────────────

function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

function wrapCoord(v) {
  return ((v % WORLD) + WORLD) % WORLD;
}

function spawnPosition() {
  return {
    x: CONFIG.botSpawnPadding + Math.random() * (WORLD - CONFIG.botSpawnPadding * 2),
    y: CONFIG.botSpawnPadding + Math.random() * (WORLD - CONFIG.botSpawnPadding * 2),
  };
}

function rnd36() {
  return Math.random().toString(36).slice(2, 9);
}

// ─── SNAKE CLASS ─────────────────────────────────────────────────────────────

class Snake {
  constructor(id, x, y, skinIdx, name, isPlayer = false) {
    this.id = id;
    this.name = name;
    this.skinIdx = Number.isInteger(skinIdx) ? skinIdx % SKINS.length : Math.floor(Math.random() * SKINS.length);
    this.skin = SKINS[this.skinIdx];
    this.isPlayer = isPlayer;
    this.alive = true;
    this.angle = Math.random() * Math.PI * 2;
    this.targetAngle = this.angle;
    this.speed = 2.2;
    this.segments = [];
    this.length = 30;
    this.width = 18;
    this.score = 0;
    this.boosting = false;
    this.boostE = 1;

    for (let i = 0; i < this.length; i++) {
      this.segments.push({
        x: x - Math.cos(this.angle) * i * 6,
        y: y - Math.sin(this.angle) * i * 6,
      });
    }

    if (!isPlayer) {
      this.aiTimer = 0;
      this.aiTarget = null;
    }
  }

  get head() { return this.segments[0]; }

  moveToward(tx, ty) {
    const dx = tx - this.head.x, dy = ty - this.head.y;
    const target = Math.atan2(dy, dx);
    let diff = target - this.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.angle += Math.min(Math.abs(diff), 0.07) * Math.sign(diff);
  }

  update(orbsRef, activePlayers) {
    if (!this.alive) return null; // returns particle event or null

    if (!this.isPlayer) {
      this.updateBotAI(orbsRef, activePlayers);
    } else {
      let diff = this.targetAngle - this.angle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.angle += Math.min(Math.abs(diff), 0.09) * Math.sign(diff);
    }

    const speed = this.boosting ? this.speed * 1.75 : this.speed;

    if (this.boosting && this.boostE > 0) {
      this.boostE = Math.max(0, this.boostE - 0.005);
      if (this.boostE <= 0) this.boosting = false;

      if (Math.random() < 0.15 && this.segments.length > 20) {
        const tail = this.segments[this.segments.length - 1];
        orbsRef.push({ id: rnd36(), x: tail.x, y: tail.y, r: 5, color: this.skin.body, pulse: 0 });
        this.segments.pop();
        this.length = Math.max(10, this.length - 1);
      }
    } else if (!this.boosting) {
      this.boostE = Math.min(1, this.boostE + 0.002);
    }

    const nx = this.head.x + Math.cos(this.angle) * speed;
    const ny = this.head.y + Math.sin(this.angle) * speed;
    const hx = wrapCoord(nx), hy = wrapCoord(ny);
    this.segments.unshift({ x: hx, y: hy });
    while (this.segments.length > this.length + 2) this.segments.pop();

    // eat orbs
    let particleEvent = null;
    for (let i = orbsRef.length - 1; i >= 0; i--) {
      const o = orbsRef[i];
      const dx = hx - o.x, dy = hy - o.y;
      if (dx * dx + dy * dy < (this.width + o.r) * (this.width + o.r)) {
        this.score += Math.ceil(o.r);
        this.length += Math.ceil(o.r / 8);
        this.width = Math.min(32, 18 + this.length / 60);
        particleEvent = { x: o.x, y: o.y, color: o.color, n: 5 };
        orbsRef.splice(i, 1);
        // refill one orb
        orbsRef.push({
          id: rnd36(),
          x: Math.random() * WORLD,
          y: Math.random() * WORLD,
          r: 5 + Math.random() * 6,
          color: ORB_COLORS[(Math.random() * ORB_COLORS.length) | 0],
          pulse: Math.random() * Math.PI * 2,
        });
        break; // one orb per tick
      }
    }
    return particleEvent;
  }

  updateBotAI(orbsRef, activePlayers) {
    this.aiTimer -= 1;
    const cx = this.head.x, cy = this.head.y, margin = 200;

    if (cx < margin || cx > WORLD - margin || cy < margin || cy > WORLD - margin) {
      this.moveToward(WORLD / 2, WORLD / 2);
      return;
    }

    if (this.aiTimer > 0 && this.aiTarget) {
      this.moveToward(this.aiTarget.x, this.aiTarget.y);
      return;
    }

    let best = null, bestDist = Infinity;

    // occasionally chase a player
    if (activePlayers.length > 0 && Math.random() < 0.3) {
      for (const p of activePlayers) {
        const d = dist2(cx, cy, p.head.x, p.head.y);
        if (d < 300 * 300 && d < bestDist) { bestDist = d; best = p.head; }
      }
    }
    // chase nearest orb
    if (!best) {
      for (const o of orbsRef) {
        const d = dist2(cx, cy, o.x, o.y);
        if (d < bestDist) { bestDist = d; best = o; }
      }
    }

    this.aiTarget = best || { x: Math.random() * WORLD, y: Math.random() * WORLD };
    this.aiTimer = (20 + Math.random() * 30) | 0;
    this.moveToward(this.aiTarget.x, this.aiTarget.y);
    this.boosting = Math.random() < 0.05 && this.boostE > 0.3;
  }

  getSnapshot() {
    return {
      id: this.id,
      x: this.head.x,
      y: this.head.y,
      angle: this.angle,
      length: this.length,
      name: this.name,
      skinIdx: this.skinIdx,
    };
  }
}

// ─── ORB HELPERS ─────────────────────────────────────────────────────────────

function spawnOrbs(orbsRef, count) {
  for (let i = 0; i < count; i++) {
    orbsRef.push({
      id: rnd36(),
      x: Math.random() * WORLD,
      y: Math.random() * WORLD,
      r: 5 + Math.random() * 6,
      color: ORB_COLORS[(Math.random() * ORB_COLORS.length) | 0],
      pulse: Math.random() * Math.PI * 2,
    });
  }
}

// ─── DURABLE OBJECT ──────────────────────────────────────────────────────────

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // Game state
    this.players = new Map();   // socketId -> Snake
    this.bots = [];             // Snake[]
    this.orbs = [];
    this.nextBotId = 1;
    this.frame = 0;
    this.lastBotTrimAt = 0;

    // WebSocket sessions: ws -> { id, joined }
    this.sessions = new Map();

    this.loopHandle = null;

    // Seed world
    spawnOrbs(this.orbs, CONFIG.initialOrbCount);
    this._fillBots();
  }

  // ── incoming fetch (WebSocket upgrade) ──────────────────────────────────

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

const { 0: client, 1: server } = new WebSocketPair();

server.accept();

const sessionId = rnd36();
this.sessions.set(server, { id: sessionId, joined: false });

// ✅ ADD THIS BLOCK (CRITICAL)
server.addEventListener("message", (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }

  const session = this.sessions.get(server);
  if (!session) return;

  if (msg.type === 'join') {
    this._handleJoin(server, session, msg);
  } else if (msg.type === 'input') {
    this._handleInput(session, msg);
  }
});

server.addEventListener("close", () => {
  const session = this.sessions.get(server);
  if (session && session.joined) {
    const snake = this.players.get(session.id);
    if (snake && snake.alive) this._killSnake(snake);
    this.players.delete(session.id);
    this._fillBots();
  }
  this.sessions.delete(server);
});

this._ensureLoop();

return new Response(null, { status: 101, webSocket: client });
  // ── Hibernation API handlers ─────────────────────────────────────────────
  }
  

  // ── join / input handlers ────────────────────────────────────────────────

  _handleJoin(ws, session, msg) {
    // re-join: kill old snake if alive
    if (session.joined) {
      const old = this.players.get(session.id);
      if (old && old.alive) this._killSnake(old);
    }

    if (this._activePlayers().length >= CONFIG.maxPlayers) {
      this._send(ws, { type: 'joinDenied', message: 'Room is full. Try again shortly.' });
      return;
    }

    const skinIdx = Number.isInteger(msg.skinIdx) ? msg.skinIdx : 0;
    const name = String(msg.name || 'Player').trim().slice(0, 16) || 'Player';
    const spawnX = CONFIG.playerSpawnMin + Math.random() * CONFIG.playerSpawnRange;
    const spawnY = CONFIG.playerSpawnMin + Math.random() * CONFIG.playerSpawnRange;

    const snake = new Snake(session.id, spawnX, spawnY, skinIdx, name, true);
    this.players.set(session.id, snake);
    session.joined = true;

    this._trimBots();

    this._send(ws, {
      type: 'init',
      id: session.id,
      WORLD,
      tickMs: CONFIG.tickMs,
    });
  }

  _handleInput(session, msg) {
    const snake = this.players.get(session.id);
    if (!snake || !snake.alive) return;
    if (typeof msg.angle === 'number' && isFinite(msg.angle)) {
      snake.targetAngle = msg.angle;
    }
    snake.boosting = Boolean(msg.boosting);
  }

  // ── game loop ────────────────────────────────────────────────────────────

  _ensureLoop() {
    if (!this.loopHandle) {
      this.loopHandle = setInterval(() => this._tick(), CONFIG.tickMs);
    }
  }

  _tick() {
    this.frame += 1;

    const activePlayers = this._activePlayers();
    const particleEvents = [];

    // update players
    for (const snake of this.players.values()) {
      const evt = snake.update(this.orbs, activePlayers);
      if (evt) particleEvents.push(evt);
    }

    // update bots
    for (const bot of this.bots) {
      const evt = bot.update(this.orbs, activePlayers);
      if (evt) particleEvents.push(evt);
    }

    // prune dead bots
    this.bots = this.bots.filter(b => b.alive);

    // collisions every 2 frames
    if (this.frame % 2 === 0) this._checkCollisions(particleEvents);

    // top up orbs
    if (this.orbs.length < CONFIG.minOrbCount) {
      spawnOrbs(this.orbs, CONFIG.orbRefillBurst);
    }

    // fill bot slots
    this._fillBots();

    // broadcast
    const state = this._buildState();
    const stateMsg = JSON.stringify({ type: 'gameState', ...state });

    for (const [ws, session] of this.sessions.entries()) {
      if (!session.joined) continue;
      ws.send(stateMsg);
    }

    // broadcast particles
    if (particleEvents.length > 0) {
      const pMsg = JSON.stringify({ type: 'particleSpawn', events: particleEvents });
      for (const [ws, session] of this.sessions.entries()) {
        if (session.joined) ws.send(pMsg);
      }
    }
  }

  // ── collision check ──────────────────────────────────────────────────────

  _checkCollisions(particleEvents) {
    const all = [...this._activePlayers(), ...this.bots.filter(b => b.alive)];

    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      if (!a.alive) continue;
      const hx = a.head.x, hy = a.head.y;

      for (let j = 0; j < all.length; j++) {
        if (i === j) continue;
        const b = all[j];
        const startSeg = b.isPlayer ? 5 : 3;
        for (let k = startSeg; k < b.segments.length; k++) {
          const seg = b.segments[k];
          const dx = hx - seg.x, dy = hy - seg.y;
          const killDist = (a.width + b.width) * 0.8;
          if (dx * dx + dy * dy < killDist * killDist) {
            particleEvents.push({ x: a.head.x, y: a.head.y, color: a.skin.glow, n: 20 });
            this._killSnake(a);
            break;
          }
        }
        if (!a.alive) break;
      }
    }
  }

  _killSnake(snake) {
    if (!snake.alive) return;
    snake.alive = false;

    // drop orbs
    for (const seg of snake.segments) {
      if (Math.random() < 0.25) {
        this.orbs.push({
          id: rnd36(),
          x: seg.x, y: seg.y,
          r: 6 + Math.random() * 8,
          color: snake.skin.body,
          pulse: Math.random() * Math.PI * 2,
        });
      }
    }

    if (snake.isPlayer) {
      // find ws for this player and notify
      for (const [ws, session] of this.sessions.entries()) {
        if (session.id === snake.id) {
          this._send(ws, { type: 'died', score: snake.score });
          break;
        }
      }
    } else {
      // respawn bot after delay if room has space
      setTimeout(() => {
        if (this._activeEntities() < CONFIG.maxEntities) {
          this._spawnBot(snake.skinIdx, snake.name);
        }
      }, CONFIG.botRespawnDelayMs);
    }
  }

  // ── bot management ───────────────────────────────────────────────────────

  _activePlayers()  { return [...this.players.values()].filter(s => s.alive); }
  _activeBots()     { return this.bots.filter(b => b.alive); }
  _activeEntities() { return this._activePlayers().length + this._activeBots().length; }

  _desiredBotCount() {
    return Math.max(0, CONFIG.maxEntities - this._activePlayers().length);
  }

  _canSpawnBot() {
    return this._activeBots().length < this._desiredBotCount() && this._activeEntities() < CONFIG.maxEntities;
  }

  _spawnBot(skinIdx, name) {
    if (!this._canSpawnBot()) return;
    const pos = spawnPosition();
    const si  = skinIdx !== undefined ? skinIdx : Math.floor(Math.random() * SKINS.length);
    const nm  = name || BOT_NAMES[(Math.random() * BOT_NAMES.length) | 0];
    const bot = new Snake(`bot_${this.nextBotId++}`, pos.x, pos.y, si, nm, false);
    bot.length = (20 + Math.random() * 60) | 0;
    bot.width  = Math.min(32, 18 + bot.length / 60);
    bot.score  = Math.max(0, Math.round(bot.length * 0.8));
    this.bots.push(bot);
  }

  _fillBots()  { while (this._canSpawnBot()) this._spawnBot(); }

  _trimBots() {
    const now = Date.now();
    if (now - this.lastBotTrimAt < CONFIG.botTrimIntervalMs) return;
    const excess = this._activeBots().length - this._desiredBotCount();
    if (excess <= 0) return;
    const toKill = this.bots.find(b => b.alive);
    if (toKill) { toKill.alive = false; this.lastBotTrimAt = now; }
  }

  // ── state snapshot ───────────────────────────────────────────────────────

  _buildState() {
    const all = [...this._activePlayers(), ...this._activeBots()];
    all.sort((a, b) => b.score - a.score);

    const leaderboard = all.slice(0, 10).map((s, i) => ({
      id: s.id, name: s.name, score: s.score, rank: i + 1,
    }));

    const rankMap = new Map(leaderboard.map(e => [e.id, e.rank]));

    const self = {};
    for (const s of this._activePlayers()) {
      self[s.id] = { score: s.score, rank: rankMap.get(s.id) || 0, boostE: s.boostE };
    }

    return {
      world: WORLD,
      tickMs: CONFIG.tickMs,
      players: this._activePlayers().map(s => s.getSnapshot()),
      bots:    this._activeBots().map(s => s.getSnapshot()),
      orbs:    this.orbs,
      leaderboard,
      self,
    };
  }

  // ── send helper ──────────────────────────────────────────────────────────

  _send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}
