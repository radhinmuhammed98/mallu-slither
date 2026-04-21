// worker/room.js — Cloudflare Durable Object (one instance per named room)
// All game logic lives here: Snake physics, bot AI, collisions, orbs, game loop.

'use strict';

const CONFIG = {
  worldSize: 4000,
  tickMs: 80,               // ~12.5 ticks/sec — smooth & cheap on free tier
  maxPlayers: 15,
  maxEntities: 25,
  initialOrbCount: 220,
  minOrbCount: 160,
  orbRefillBurst: 5,
  botRespawnDelayMs: 5000,
  botTrimIntervalMs: 2500,
  botSpawnPadding: 500,
  playerSpawnMin: 800,
  playerSpawnRange: 2400,
  inputRateLimitMs: 34,    // ~30 inputs/sec max per player
  maxMsgBytes: 256,        // reject oversized messages
};

const WORLD = CONFIG.worldSize;
const TWO_PI = Math.PI * 2;

const SKINS = [
  { name: 'Coconut',   body: '#5fbf6a', glow: '#8bd39a', head: '#2f6f46', eye: '#fef9e8' },
  { name: 'Leaf',      body: '#7ed957', glow: '#9ff06f', head: '#3f7d2b', eye: '#fef9e8' },
  { name: 'Lotus',     body: '#d67a52', glow: '#f3a96d', head: '#8c4b2d', eye: '#fff7df' },
  { name: 'Gold',      body: '#d8a93a', glow: '#f0cb72', head: '#8f6517', eye: '#1d1808' },
  { name: 'Monsoon',   body: '#4bb48c', glow: '#73d0ab', head: '#236b56', eye: '#f3f8ef' },
  { name: 'Paddy',     body: '#95c94d', glow: '#c2ea6a', head: '#55751d', eye: '#fffce6' },
  { name: 'Spice',     body: '#c96d34', glow: '#e2a15a', head: '#7f3d17', eye: '#fff6e0' },
  { name: 'Backwater', body: '#3aa680', glow: '#67cfa7', head: '#16614b', eye: '#eefcf7' },
];

const ORB_COLORS = ['#5fbf6a','#d8a93a','#7ed957','#95c94d','#c96d34','#73d0ab','#f0cb72'];

const BOT_NAMES = [
  'Achayan','Muttayi','Coconut Joe','Nair','Amma','Karimeen','Thekkan',
  'Vadakkan','Rajan','Molly','Rajesh','Padmini','Appan','Chechi',
  'Krishnan','Lakshmi','Unni','Kuttan','Meera','Balan',
];

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function dist2(ax, ay, bx, by) { const dx = ax-bx, dy = ay-by; return dx*dx + dy*dy; }
function wrapCoord(v) { return ((v % WORLD) + WORLD) % WORLD; }
function rnd36() { return Math.random().toString(36).slice(2, 9); }
function clampAngleDiff(d) { while (d > Math.PI) d -= TWO_PI; while (d < -Math.PI) d += TWO_PI; return d; }
function spawnPos() {
  const p = CONFIG.botSpawnPadding;
  return { x: p + Math.random() * (WORLD - p*2), y: p + Math.random() * (WORLD - p*2) };
}

// ─── SNAKE ────────────────────────────────────────────────────────────────────

class Snake {
  constructor(id, x, y, skinIdx, name, isPlayer = false) {
    this.id       = id;
    this.name     = name;
    this.skinIdx  = (Number.isInteger(skinIdx) && skinIdx >= 0 && skinIdx < SKINS.length)
                    ? skinIdx : (Math.random() * SKINS.length) | 0;
    this.skin     = SKINS[this.skinIdx];
    this.isPlayer = isPlayer;
    this.alive    = true;
    this.angle    = Math.random() * TWO_PI;
    this.targetAngle = this.angle;
    this.speed    = 2.2;
    this.segments = [];
    this.length   = 30;
    this.width    = 18;
    this.score    = 0;
    this.boosting = false;
    this.boostE   = 1;

    if (!isPlayer) {
      this.aiTimer    = 0;
      this.aiTarget   = null;
      this.fleeTimer  = 0;
      this.personality = Math.random(); // 0=passive/orb-chaser, 1=aggressive/player-hunter
    }

    for (let i = 0; i < this.length; i++) {
      this.segments.push({
        x: x - Math.cos(this.angle) * i * 6,
        y: y - Math.sin(this.angle) * i * 6,
      });
    }
  }

  get head() { return this.segments[0]; }

  _steerToward(tx, ty) {
    const diff = clampAngleDiff(Math.atan2(ty - this.head.y, tx - this.head.x) - this.angle);
    this.angle += Math.min(Math.abs(diff), 0.08) * Math.sign(diff);
  }

  update(orbs, players, allSnakes) {
    if (!this.alive) return null;

    if (this.isPlayer) {
      const diff = clampAngleDiff(this.targetAngle - this.angle);
      this.angle += Math.min(Math.abs(diff), 0.10) * Math.sign(diff);
    } else {
      this._botAI(orbs, players, allSnakes);
    }

    // Boost drain/regen
    if (this.boosting && this.boostE > 0) {
      this.boostE = Math.max(0, this.boostE - 0.005);
      if (this.boostE <= 0) this.boosting = false;
      // Shed tail orb while boosting
      if (Math.random() < 0.15 && this.segments.length > 20) {
        const tail = this.segments[this.segments.length - 1];
        orbs.push({ id: rnd36(), x: tail.x, y: tail.y, r: 5, color: this.skin.body, pulse: 0 });
        this.segments.pop();
        this.length = Math.max(10, this.length - 1);
      }
    } else if (!this.boosting) {
      this.boostE = Math.min(1, this.boostE + 0.002);
    }

    // Move head
    const spd = this.boosting ? this.speed * 1.75 : this.speed;
    const hx = wrapCoord(this.head.x + Math.cos(this.angle) * spd);
    const hy = wrapCoord(this.head.y + Math.sin(this.angle) * spd);
    this.segments.unshift({ x: hx, y: hy });
    while (this.segments.length > this.length + 2) this.segments.pop();

    // Eat orbs
    let eat = null;
    for (let i = orbs.length - 1; i >= 0; i--) {
      const o = orbs[i];
      const d = (hx-o.x)**2 + (hy-o.y)**2;
      const r = this.width + o.r;
      if (d < r*r) {
        this.score  += Math.ceil(o.r);
        this.length += Math.ceil(o.r / 8);
        this.width   = Math.min(32, 18 + this.length / 60);
        eat = { x: o.x, y: o.y, color: o.color, n: 4 };
        orbs.splice(i, 1);
        // Immediate local refill
        orbs.push({ id: rnd36(), x: Math.random()*WORLD, y: Math.random()*WORLD,
          r: 5 + Math.random()*6, color: ORB_COLORS[(Math.random()*ORB_COLORS.length)|0],
          pulse: Math.random()*TWO_PI });
        break;
      }
    }
    return eat;
  }

  _botAI(orbs, players, allSnakes) {
    this.aiTimer--;
    this.fleeTimer = Math.max(0, this.fleeTimer - 1);

    const { x: cx, y: cy } = this.head;
    const margin = 400;

    // Strong wall avoidance
    if (cx < margin || cx > WORLD - margin || cy < margin || cy > WORLD - margin) {
      this._steerToward(WORLD / 2, WORLD / 2);
      this.boosting = false;
      return;
    }

    // Danger avoidance: scan nearby snake segments
    if (this.fleeTimer <= 0) {
      let dangerX = 0, dangerY = 0, found = false;
      const dangerR2 = 110 * 110;
      for (const other of allSnakes) {
        if (other === this || !other.alive) continue;
        for (let k = 2; k < Math.min(other.segments.length, 20); k++) {
          const s = other.segments[k];
          if (dist2(cx, cy, s.x, s.y) < dangerR2) {
            dangerX = s.x; dangerY = s.y; found = true; break;
          }
        }
        if (found) break;
      }
      if (found) {
        const awayAngle = Math.atan2(cy - dangerY, cx - dangerX);
        this._steerToward(cx + Math.cos(awayAngle) * 400, cy + Math.sin(awayAngle) * 400);
        this.fleeTimer = 25;
        this.boosting  = this.boostE > 0.5;
        return;
      }
    }

    if (this.fleeTimer > 0 && this.aiTarget) {
      this._steerToward(this.aiTarget.x, this.aiTarget.y);
      return;
    }

    if (this.aiTimer > 0 && this.aiTarget) {
      this._steerToward(this.aiTarget.x, this.aiTarget.y);
      return;
    }

    // Pick a new target
    let best = null, bestD = Infinity;

    // Aggressive bots may hunt players
    if (players.length > 0 && Math.random() < this.personality * 0.25) {
      for (const p of players) {
        const d = dist2(cx, cy, p.head.x, p.head.y);
        if (d < 500*500 && d < bestD) { bestD = d; best = p.head; }
      }
    }

    // Default: chase nearest orb
    if (!best) {
      for (const o of orbs) {
        const d = dist2(cx, cy, o.x, o.y);
        if (d < bestD) { bestD = d; best = o; }
      }
    }

    this.aiTarget = best || { x: Math.random()*WORLD, y: Math.random()*WORLD };
    this.aiTimer  = (28 + Math.random() * 32) | 0;
    this._steerToward(this.aiTarget.x, this.aiTarget.y);
    this.boosting = Math.random() < 0.025 && this.boostE > 0.65; // bots boost rarely
  }

  getSnapshot() {
    return { id: this.id, x: this.head.x, y: this.head.y,
             angle: this.angle, length: this.length,
             name: this.name, skinIdx: this.skinIdx };
  }
}

// ─── ORB HELPERS ──────────────────────────────────────────────────────────────

function spawnOrbs(arr, n) {
  for (let i = 0; i < n; i++) {
    arr.push({ id: rnd36(), x: Math.random()*WORLD, y: Math.random()*WORLD,
      r: 5 + Math.random()*6, color: ORB_COLORS[(Math.random()*ORB_COLORS.length)|0],
      pulse: Math.random()*TWO_PI });
  }
}

// ─── DURABLE OBJECT ───────────────────────────────────────────────────────────

export class GameRoom {
  constructor(state, env) {
    this.state  = state;
    this.env    = env;

    this.players     = new Map();   // sessionId → Snake
    this.bots        = [];          // Snake[]
    this.orbs        = [];
    this.nextBotId   = 1;
    this.frame       = 0;
    this.lastTrimAt  = 0;

    this.sessions    = new Map();   // ws → { id, joined }
    this.inputLastAt = new Map();   // sessionId → ms (rate limiting)
    this.loopHandle  = null;

    spawnOrbs(this.orbs, CONFIG.initialOrbCount);
    this._fillBots();
  }

  // ─── WebSocket entry point ──────────────────────────────────────────────────

  async fetch(request) {
    const upgrade = request.headers.get('Upgrade') || '';
    if (upgrade.toLowerCase() !== 'websocket') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    const sessionId = rnd36();
    this.sessions.set(server, { id: sessionId, joined: false });

    server.addEventListener('message', (evt) => this._onMessage(server, evt.data));
    server.addEventListener('close',   ()    => this._onClose(server));
    server.addEventListener('error',   ()    => this._onClose(server));

    this._ensureLoop();

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  // ─── Message & close handlers ───────────────────────────────────────────────

  _onMessage(ws, rawData) {
    // Security: reject oversized payloads
    if (typeof rawData !== 'string' || rawData.length > CONFIG.maxMsgBytes) return;

    let msg;
    try { msg = JSON.parse(rawData); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    const session = this.sessions.get(ws);
    if (!session) return;

    // Rate-limit input messages
    if (msg.type === 'input') {
      const now = Date.now();
      const last = this.inputLastAt.get(session.id) || 0;
      if (now - last < CONFIG.inputRateLimitMs) return;
      this.inputLastAt.set(session.id, now);
    }

    if      (msg.type === 'join')  this._handleJoin(ws, session, msg);
    else if (msg.type === 'input') this._handleInput(session, msg);
  }

  _onClose(ws) {
    const session = this.sessions.get(ws);
    if (!session) return;

    if (session.joined) {
      const snake = this.players.get(session.id);
      if (snake && snake.alive) this._killSnake(snake);
      this.players.delete(session.id);
      this._fillBots();
    }

    this.inputLastAt.delete(session.id);
    this.sessions.delete(ws);

    // Pause the loop when the room is empty to save resources
    if (this.sessions.size === 0 && this.loopHandle) {
      clearInterval(this.loopHandle);
      this.loopHandle = null;
    }
  }

  // ─── Join / Input ───────────────────────────────────────────────────────────

  _handleJoin(ws, session, msg) {
    // Sanitize name
    const base = typeof msg.name === 'string' ? msg.name.trim().replace(/[<>"']/g, '').slice(0, 16) : '';
    const baseName = base || 'Player';

    // Unique name enforcement
    const used = new Set([...this.players.values()].map(s => s.name));
    let name = baseName;
    for (let i = 2; used.has(name) && i < 100; i++) name = `${baseName}${i}`;

    // Kill previous snake on re-join
    if (session.joined) {
      const old = this.players.get(session.id);
      if (old && old.alive) this._killSnake(old);
    }

    if (this._activePlayers().length >= CONFIG.maxPlayers) {
      this._send(ws, { type: 'joinDenied', message: 'Room is full. Try another room.' });
      return;
    }

    const skinIdx = (Number.isInteger(msg.skinIdx) && msg.skinIdx >= 0 && msg.skinIdx < SKINS.length)
      ? msg.skinIdx : 0;
    const spawnX = CONFIG.playerSpawnMin + Math.random() * CONFIG.playerSpawnRange;
    const spawnY = CONFIG.playerSpawnMin + Math.random() * CONFIG.playerSpawnRange;

    const snake = new Snake(session.id, spawnX, spawnY, skinIdx, name, true);
    this.players.set(session.id, snake);
    session.joined = true;

    this._trimBots();
    this._send(ws, { type: 'init', id: session.id, WORLD, tickMs: CONFIG.tickMs });
  }

  _handleInput(session, msg) {
    const snake = this.players.get(session.id);
    if (!snake || !snake.alive) return;
    if (typeof msg.angle === 'number' && Number.isFinite(msg.angle)) {
      snake.targetAngle = msg.angle;
    }
    if (typeof msg.boosting === 'boolean') snake.boosting = msg.boosting;
  }

  // ─── Game loop ──────────────────────────────────────────────────────────────

  _ensureLoop() {
    if (!this.loopHandle) {
      this.loopHandle = setInterval(() => this._tick(), CONFIG.tickMs);
    }
  }

  _tick() {
    this.frame++;

    const activePlayers = this._activePlayers();
    const activeBots    = this._activeBots();
    const allSnakes     = [...activePlayers, ...activeBots];
    const particles     = [];

    for (const snake of this.players.values()) {
      const p = snake.update(this.orbs, activePlayers, allSnakes);
      if (p) particles.push(p);
    }
    for (const bot of this.bots) {
      const p = bot.update(this.orbs, activePlayers, allSnakes);
      if (p) particles.push(p);
    }

    this.bots = this.bots.filter(b => b.alive);

    if (this.frame % 2 === 0) this._checkCollisions(particles);

    if (this.orbs.length < CONFIG.minOrbCount) spawnOrbs(this.orbs, CONFIG.orbRefillBurst);

    this._fillBots();

    // Broadcast game state
    const statePayload = JSON.stringify({ type: 'gameState', ...this._buildState() });
    for (const [ws, session] of this.sessions) {
      if (session.joined) try { ws.send(statePayload); } catch {}
    }

    // Broadcast particles
    if (particles.length > 0) {
      const pPayload = JSON.stringify({ type: 'particleSpawn', events: particles });
      for (const [ws, session] of this.sessions) {
        if (session.joined) try { ws.send(pPayload); } catch {}
      }
    }
  }

  // ─── Collisions ─────────────────────────────────────────────────────────────

  _checkCollisions(particles) {
    const all = [...this._activePlayers(), ...this._activeBots()];
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      if (!a.alive) continue;
      const { x: hx, y: hy } = a.head;
      for (let j = 0; j < all.length; j++) {
        if (i === j) continue;
        const b = all[j];
        const startK = b.isPlayer ? 5 : 3;
        for (let k = startK; k < b.segments.length; k++) {
          const s = b.segments[k];
          const killR = (a.width + b.width) * 0.8;
          if (dist2(hx, hy, s.x, s.y) < killR * killR) {
            particles.push({ x: hx, y: hy, color: a.skin.glow, n: 20 });
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

    for (const seg of snake.segments) {
      if (Math.random() < 0.22) {
        this.orbs.push({ id: rnd36(), x: seg.x, y: seg.y,
          r: 6 + Math.random() * 8, color: snake.skin.body,
          pulse: Math.random() * TWO_PI });
      }
    }

    if (snake.isPlayer) {
      for (const [ws, session] of this.sessions) {
        if (session.id === snake.id) {
          this._send(ws, { type: 'died', score: snake.score });
          break;
        }
      }
    } else {
      setTimeout(() => {
        if (this._activeEntities() < CONFIG.maxEntities) {
          this._spawnBot(snake.skinIdx, snake.name);
        }
      }, CONFIG.botRespawnDelayMs);
    }
  }

  // ─── Bot management ─────────────────────────────────────────────────────────

  _activePlayers()   { return [...this.players.values()].filter(s => s.alive); }
  _activeBots()      { return this.bots.filter(b => b.alive); }
  _activeEntities()  { return this._activePlayers().length + this._activeBots().length; }
  _desiredBots()     { return Math.max(0, CONFIG.maxEntities - this._activePlayers().length); }
  _canSpawnBot()     { return this._activeBots().length < this._desiredBots() && this._activeEntities() < CONFIG.maxEntities; }

  _spawnBot(skinIdx, name) {
    if (!this._canSpawnBot()) return;
    const pos = spawnPos();
    const si  = (Number.isInteger(skinIdx) && skinIdx >= 0 && skinIdx < SKINS.length)
                ? skinIdx : (Math.random() * SKINS.length) | 0;
    const nm  = (typeof name === 'string' && name.length > 0)
                ? name : BOT_NAMES[(Math.random() * BOT_NAMES.length) | 0];
    const bot = new Snake(`bot_${this.nextBotId++}`, pos.x, pos.y, si, nm, false);
    bot.length = (20 + Math.random() * 60) | 0;
    bot.width  = Math.min(32, 18 + bot.length / 60);
    bot.score  = Math.max(0, Math.round(bot.length * 0.8));
    this.bots.push(bot);
  }

  _fillBots() { while (this._canSpawnBot()) this._spawnBot(); }

  _trimBots() {
    const now = Date.now();
    if (now - this.lastTrimAt < CONFIG.botTrimIntervalMs) return;
    const excess = this._activeBots().length - this._desiredBots();
    if (excess <= 0) return;
    const b = this.bots.find(b => b.alive);
    if (b) { b.alive = false; this.lastTrimAt = now; }
  }

  // ─── State snapshot ──────────────────────────────────────────────────────────

  _buildState() {
    const all = [...this._activePlayers(), ...this._activeBots()].sort((a, b) => b.score - a.score);
    const leaderboard = all.slice(0, 10).map((s, i) => ({ id: s.id, name: s.name, score: s.score, rank: i + 1 }));
    const rankMap = new Map(leaderboard.map(e => [e.id, e.rank]));
    const self = {};
    for (const s of this._activePlayers()) {
      self[s.id] = { score: s.score, rank: rankMap.get(s.id) || 0, boostE: s.boostE };
    }
    return {
      world: WORLD, tickMs: CONFIG.tickMs,
      players: this._activePlayers().map(s => s.getSnapshot()),
      bots:    this._activeBots().map(s => s.getSnapshot()),
      orbs: this.orbs, leaderboard, self,
    };
  }

  _send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
}
