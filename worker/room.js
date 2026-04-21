import { DurableObject } from 'cloudflare:workers';

// Cloudflare Durable Object: one instance per room.
// Keeps the existing game architecture but runs it behind native WebSockets.

const CONFIG = {
  worldSize: 4000,
  tickMs: 72,
  maxPlayers: 25,
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
  { name: 'Leaf', body: '#7ed957', glow: '#9ff06f', head: '#3f7d2b', eye: '#fef9e8' },
  { name: 'Lotus', body: '#d67a52', glow: '#f3a96d', head: '#8c4b2d', eye: '#fff7df' },
  { name: 'Gold', body: '#d8a93a', glow: '#f0cb72', head: '#8f6517', eye: '#1d1808' },
  { name: 'Monsoon', body: '#4bb48c', glow: '#73d0ab', head: '#236b56', eye: '#f3f8ef' },
  { name: 'Paddy', body: '#95c94d', glow: '#c2ea6a', head: '#55751d', eye: '#fffce6' },
  { name: 'Spice', body: '#c96d34', glow: '#e2a15a', head: '#7f3d17', eye: '#fff6e0' },
  { name: 'Backwater', body: '#3aa680', glow: '#67cfa7', head: '#16614b', eye: '#eefcf7' },
];

const ORB_COLORS = ['#5fbf6a', '#d8a93a', '#7ed957', '#95c94d', '#c96d34', '#73d0ab'];
const BOT_NAMES = [
  'Achayan', 'Muttayi', 'Coconut Joe', 'Nair', 'Amma', 'Karimeen', 'Thekkan',
  'Vadakkan', 'Rajan', 'Molly', 'Rajesh', 'Padmini', 'Appan', 'Chechi',
];

function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function wrapCoord(value) {
  return ((value % WORLD) + WORLD) % WORLD;
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

  get head() {
    return this.segments[0];
  }

  moveToward(tx, ty) {
    const dx = tx - this.head.x;
    const dy = ty - this.head.y;
    const target = Math.atan2(dy, dx);
    let diff = target - this.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.angle += Math.min(Math.abs(diff), 0.07) * Math.sign(diff);
  }

  update(orbsRef, activePlayers) {
    if (!this.alive) return null;

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

    const nextX = this.head.x + Math.cos(this.angle) * speed;
    const nextY = this.head.y + Math.sin(this.angle) * speed;
    const hx = wrapCoord(nextX);
    const hy = wrapCoord(nextY);

    this.segments.unshift({ x: hx, y: hy });
    while (this.segments.length > this.length + 2) this.segments.pop();

    let particleEvent = null;
    for (let i = orbsRef.length - 1; i >= 0; i--) {
      const orb = orbsRef[i];
      const dx = hx - orb.x;
      const dy = hy - orb.y;
      if (dx * dx + dy * dy < (this.width + orb.r) * (this.width + orb.r)) {
        this.score += Math.ceil(orb.r);
        this.length += Math.ceil(orb.r / 8);
        this.width = Math.min(32, 18 + this.length / 60);
        particleEvent = { x: orb.x, y: orb.y, color: orb.color, n: 5 };
        orbsRef.splice(i, 1);
        orbsRef.push({
          id: rnd36(),
          x: Math.random() * WORLD,
          y: Math.random() * WORLD,
          r: 5 + Math.random() * 6,
          color: ORB_COLORS[(Math.random() * ORB_COLORS.length) | 0],
          pulse: Math.random() * Math.PI * 2,
        });
        break;
      }
    }

    return particleEvent;
  }

  updateBotAI(orbsRef, activePlayers) {
    this.aiTimer -= 1;
    const cx = this.head.x;
    const cy = this.head.y;
    const margin = 200;

    if (cx < margin || cx > WORLD - margin || cy < margin || cy > WORLD - margin) {
      this.moveToward(WORLD / 2, WORLD / 2);
      return;
    }

    if (this.aiTimer > 0 && this.aiTarget) {
      this.moveToward(this.aiTarget.x, this.aiTarget.y);
      return;
    }

    let best = null;
    let bestDist = Infinity;

    if (activePlayers.length > 0 && Math.random() < 0.3) {
      for (const player of activePlayers) {
        const distance = dist2(cx, cy, player.head.x, player.head.y);
        if (distance < 300 * 300 && distance < bestDist) {
          bestDist = distance;
          best = player.head;
        }
      }
    }

    if (!best) {
      for (const orb of orbsRef) {
        const distance = dist2(cx, cy, orb.x, orb.y);
        if (distance < bestDist) {
          bestDist = distance;
          best = orb;
        }
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

export class GameRoom extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.players = new Map();
    this.bots = [];
    this.orbs = [];
    this.nextBotId = 1;
    this.frame = 0;
    this.lastBotTrimAt = 0;
    this.sessions = new Map();
    this.loopHandle = null;

    spawnOrbs(this.orbs, CONFIG.initialOrbCount);
    this._fillBots();
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    const session = { id: rnd36(), joined: false };
    this.sessions.set(server, session);

    server.addEventListener('message', (event) => {
      this._handleMessage(server, event);
    });

    server.addEventListener('close', () => {
      this._handleDisconnect(server);
    });

    server.addEventListener('error', () => {
      this._handleDisconnect(server);
    });

    this._ensureLoop();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  _handleMessage(ws, event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    const session = this.sessions.get(ws);
    if (!session || !msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      this._handleJoin(ws, session, msg);
      return;
    }

    if (msg.type === 'input') {
      this._handleInput(session, msg);
    }
  }

  _handleDisconnect(ws) {
    const session = this.sessions.get(ws);
    if (!session) return;

    if (session.joined) {
      const snake = this.players.get(session.id);
      if (snake && snake.alive) this._killSnake(snake);
      this.players.delete(session.id);
      this._fillBots();
    }

    this.sessions.delete(ws);
  }

  _handleJoin(ws, session, msg) {
    if (session.joined) {
      const oldSnake = this.players.get(session.id);
      if (oldSnake && oldSnake.alive) this._killSnake(oldSnake);
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
    this._ensureLoop();

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

    if (typeof msg.angle === 'number' && Number.isFinite(msg.angle)) {
      snake.targetAngle = msg.angle;
    }

    snake.boosting = Boolean(msg.boosting);
  }

  _ensureLoop() {
    if (!this.loopHandle) {
      this.loopHandle = setInterval(() => this._tick(), CONFIG.tickMs);
    }
  }

  _tick() {
    this.frame += 1;

    const activePlayers = this._activePlayers();
    const particleEvents = [];

    for (const snake of this.players.values()) {
      const event = snake.update(this.orbs, activePlayers);
      if (event) particleEvents.push(event);
    }

    for (const bot of this.bots) {
      const event = bot.update(this.orbs, activePlayers);
      if (event) particleEvents.push(event);
    }

    this.bots = this.bots.filter((bot) => bot.alive);

    if (this.frame % 2 === 0) {
      this._checkCollisions(particleEvents);
    }

    if (this.orbs.length < CONFIG.minOrbCount) {
      spawnOrbs(this.orbs, CONFIG.orbRefillBurst);
    }

    this._fillBots();

    const stateMsg = JSON.stringify({ type: 'gameState', ...this._buildState() });
    for (const [ws, session] of this.sessions.entries()) {
      if (!session.joined) continue;
      this._safeSend(ws, stateMsg);
    }

    if (particleEvents.length > 0) {
      const particleMsg = JSON.stringify({ type: 'particleSpawn', events: particleEvents });
      for (const [ws, session] of this.sessions.entries()) {
        if (!session.joined) continue;
        this._safeSend(ws, particleMsg);
      }
    }
  }

  _checkCollisions(particleEvents) {
    const all = [...this._activePlayers(), ...this._activeBots()];

    for (let i = 0; i < all.length; i++) {
      const snake = all[i];
      if (!snake.alive) continue;

      const hx = snake.head.x;
      const hy = snake.head.y;

      for (let j = 0; j < all.length; j++) {
        if (i === j) continue;
        const other = all[j];
        const startSeg = other.isPlayer ? 5 : 3;

        for (let k = startSeg; k < other.segments.length; k++) {
          const segment = other.segments[k];
          const dx = hx - segment.x;
          const dy = hy - segment.y;
          const killDist = (snake.width + other.width) * 0.8;

          if (dx * dx + dy * dy < killDist * killDist) {
            particleEvents.push({ x: snake.head.x, y: snake.head.y, color: snake.skin.glow, n: 20 });
            this._killSnake(snake);
            break;
          }
        }

        if (!snake.alive) break;
      }
    }
  }

  _killSnake(snake) {
    if (!snake || !snake.alive) return;

    snake.alive = false;

    for (const segment of snake.segments) {
      if (Math.random() < 0.25) {
        this.orbs.push({
          id: rnd36(),
          x: segment.x,
          y: segment.y,
          r: 6 + Math.random() * 8,
          color: snake.skin.body,
          pulse: Math.random() * Math.PI * 2,
        });
      }
    }

    if (snake.isPlayer) {
      for (const [ws, session] of this.sessions.entries()) {
        if (session.id === snake.id) {
          this._send(ws, { type: 'died', score: snake.score });
          break;
        }
      }
      return;
    }

    setTimeout(() => {
      if (this._activeEntities() < CONFIG.maxEntities) {
        this._spawnBot(snake.skinIdx, snake.name);
      }
    }, CONFIG.botRespawnDelayMs);
  }

  _activePlayers() {
    return [...this.players.values()].filter((snake) => snake.alive);
  }

  _activeBots() {
    return this.bots.filter((bot) => bot.alive);
  }

  _activeEntities() {
    return this._activePlayers().length + this._activeBots().length;
  }

  _desiredBotCount() {
    return Math.max(0, CONFIG.maxEntities - this._activePlayers().length);
  }

  _canSpawnBot() {
    return this._activeBots().length < this._desiredBotCount() && this._activeEntities() < CONFIG.maxEntities;
  }

  _spawnBot(skinIdx, name) {
    if (!this._canSpawnBot()) return;

    const position = spawnPosition();
    const finalSkinIdx = skinIdx !== undefined ? skinIdx : Math.floor(Math.random() * SKINS.length);
    const finalName = name || BOT_NAMES[(Math.random() * BOT_NAMES.length) | 0];
    const bot = new Snake(`bot_${this.nextBotId++}`, position.x, position.y, finalSkinIdx, finalName, false);
    bot.length = (20 + Math.random() * 60) | 0;
    bot.width = Math.min(32, 18 + bot.length / 60);
    bot.score = Math.max(0, Math.round(bot.length * 0.8));
    this.bots.push(bot);
  }

  _fillBots() {
    while (this._canSpawnBot()) {
      this._spawnBot();
    }
  }

  _trimBots() {
    const now = Date.now();
    if (now - this.lastBotTrimAt < CONFIG.botTrimIntervalMs) return;

    const excessBots = this._activeBots().length - this._desiredBotCount();
    if (excessBots <= 0) return;

    const botToTrim = this.bots.find((bot) => bot.alive);
    if (!botToTrim) return;

    botToTrim.alive = false;
    this.lastBotTrimAt = now;
  }

  _buildState() {
    const all = [...this._activePlayers(), ...this._activeBots()].sort((a, b) => b.score - a.score);
    const rankMap = new Map();
    all.forEach((snake, index) => rankMap.set(snake.id, index + 1));

    const leaderboard = all.slice(0, 10).map((snake) => ({
      id: snake.id,
      name: snake.name,
      score: snake.score,
      rank: rankMap.get(snake.id) || 0,
    }));

    const self = {};
    for (const snake of this._activePlayers()) {
      self[snake.id] = {
        score: snake.score,
        rank: rankMap.get(snake.id) || 0,
        boostE: snake.boostE,
      };
    }

    return {
      world: WORLD,
      tickMs: CONFIG.tickMs,
      players: this._activePlayers().map((snake) => snake.getSnapshot()),
      bots: this._activeBots().map((snake) => snake.getSnapshot()),
      orbs: this.orbs,
      leaderboard,
      self,
    };
  }

  _safeSend(ws, payload) {
    try {
      ws.send(payload);
    } catch {
      this._handleDisconnect(ws);
    }
  }

  _send(ws, obj) {
    this._safeSend(ws, JSON.stringify(obj));
  }
}
