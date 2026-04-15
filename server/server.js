const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
// ─── ALLOWED ORIGINS ─────────────────────────────────────────────────────────
// Add your GitHub Pages URL below (e.g. 'https://yourusername.github.io')
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://yourusername.github.io', // ← replace with your GitHub Pages URL
];

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
        return callback(null, true);
      }
      return callback(null, true); // permissive for now; tighten after testing
    },
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 20000,
  pingInterval: 10000,
});

app.use(express.static(path.join(__dirname, '../client')));

const CONFIG = {
  worldSize: 4000,
  tickRate: 14,           // ~14 ticks/sec — safe for Fly.io free tier
  maxPlayers: 15,         // hard cap on real players
  maxEntities: 25,        // bots fill the rest (up to 25 total)
  initialOrbCount: 300,   // lower initial orbs to reduce first-emit payload
  minOrbCount: 200,       // maintain at least 200 orbs at all times
  orbRefillBurst: 6,      // refill 6 at a time when below minOrbCount
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
  { name: 'Temple Gold', body: '#d8a93a', glow: '#f0cb72', head: '#8f6517', eye: '#1d1808' },
  { name: 'Monsoon', body: '#4bb48c', glow: '#73d0ab', head: '#236b56', eye: '#f3f8ef' },
  { name: 'Paddy', body: '#95c94d', glow: '#c2ea6a', head: '#55751d', eye: '#fffce6' },
  { name: 'Spice', body: '#c96d34', glow: '#e2a15a', head: '#7f3d17', eye: '#fff6e0' },
  { name: 'Backwater', body: '#3aa680', glow: '#67cfa7', head: '#16614b', eye: '#eefcf7' },
];

const ORB_COLORS = ['#5fbf6a', '#d8a93a', '#7ed957', '#95c94d', '#c96d34', '#73d0ab'];
const BOT_NAMES = ['Shadow', 'Viper', 'Cobra', 'Blaze', 'Storm', 'Neon', 'Dusk', 'Apex', 'Frost', 'Volt', 'Axel', 'Zara', 'Nova', 'Grit', 'Flux', 'Echo'];

let players = {};
let bots = [];
let orbs = [];
let nextBotId = 1;
let lastBotTrimAt = 0;

const TICK_MS = Math.round(1000 / CONFIG.tickRate);

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

function activePlayers() {
  return Object.values(players).filter((player) => player && player.alive);
}

function activeBots() {
  return bots.filter((bot) => bot && bot.alive);
}

function activeEntities() {
  return activePlayers().length + activeBots().length;
}

function canAcceptPlayer() {
  return activePlayers().length < CONFIG.maxPlayers;
}

function desiredBotCount() {
  return Math.max(0, CONFIG.maxEntities - activePlayers().length);
}

function canSpawnBot() {
  return activeBots().length < desiredBotCount() && activeEntities() < CONFIG.maxEntities;
}

function trimExcessBots(now = Date.now()) {
  const excessBots = activeBots().length - desiredBotCount();
  if (excessBots <= 0) return;
  if (now - lastBotTrimAt < CONFIG.botTrimIntervalMs) return;

  const botToTrim = bots.find((bot) => bot && bot.alive);
  if (!botToTrim) return;

  botToTrim.alive = false;
  lastBotTrimAt = now;
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

  update() {
    if (!this.alive) return;

    if (!this.isPlayer) {
      this.updateBotAI();
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
        orbs.push({
          id: Math.random().toString(36).slice(2),
          x: tail.x,
          y: tail.y,
          r: 5,
          color: this.skin.body,
          pulse: 0,
        });
        this.segments.pop();
        this.length = Math.max(10, this.length - 1);
      }
    } else if (!this.boosting) {
      this.boostE = Math.min(1, this.boostE + 0.002);
    }

    const nx = this.head.x + Math.cos(this.angle) * speed;
    const ny = this.head.y + Math.sin(this.angle) * speed;
    const hx = wrapCoord(nx);
    const hy = wrapCoord(ny);

    this.segments.unshift({ x: hx, y: hy });
    while (this.segments.length > this.length + 2) this.segments.pop();

    for (let i = orbs.length - 1; i >= 0; i--) {
      const orb = orbs[i];
      const dx = hx - orb.x;
      const dy = hy - orb.y;
      if (dx * dx + dy * dy < (this.width + orb.r) * (this.width + orb.r)) {
        this.score += Math.ceil(orb.r);
        this.length += Math.ceil(orb.r / 8);
        this.width = Math.min(32, 18 + this.length / 60);
        io.emit('particleSpawn', { x: orb.x, y: orb.y, color: orb.color, n: 5 });
        orbs.splice(i, 1);
        spawnOrbs(1);
      }
    }
  }

  updateBotAI() {
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
    const livePlayers = activePlayers();

    if (livePlayers.length > 0 && Math.random() < 0.3) {
      for (const player of livePlayers) {
        const distance = dist2(cx, cy, player.head.x, player.head.y);
        if (distance < 300 * 300 && distance < bestDist) {
          bestDist = distance;
          best = player.head;
        }
      }
    }

    if (!best) {
      for (const orb of orbs) {
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

function spawnOrbs(count) {
  for (let i = 0; i < count; i++) {
    orbs.push({
      id: Math.random().toString(36).slice(2),
      x: Math.random() * WORLD,
      y: Math.random() * WORLD,
      r: 5 + Math.random() * 6,
      color: ORB_COLORS[(Math.random() * ORB_COLORS.length) | 0],
      pulse: Math.random() * Math.PI * 2,
    });
  }
}

function spawnBot(skinIdx, name) {
  if (!canSpawnBot()) return null;

  const position = spawnPosition();
  const bot = new Snake(
    `bot_${nextBotId++}`,
    position.x,
    position.y,
    skinIdx !== undefined ? skinIdx : Math.floor(Math.random() * SKINS.length),
    name || BOT_NAMES[(Math.random() * BOT_NAMES.length) | 0],
    false
  );

  bot.length = (20 + Math.random() * 60) | 0;
  bot.width = Math.min(32, 18 + bot.length / 60);
  bot.score = Math.max(0, Math.round(bot.length * 0.8));
  bots.push(bot);
  return bot;
}

function fillBots() {
  while (canSpawnBot()) {
    spawnBot();
  }
}

function killSnake(snake) {
  if (!snake || !snake.alive) return;

  snake.alive = false;

  for (const segment of snake.segments) {
    if (Math.random() < 0.3) {
      orbs.push({
        id: Math.random().toString(36).slice(2),
        x: segment.x,
        y: segment.y,
        r: 6 + Math.random() * 8,
        color: snake.skin.body,
        pulse: Math.random() * Math.PI * 2,
      });
    }
  }

  io.emit('particleSpawn', { x: snake.head.x, y: snake.head.y, color: snake.skin.glow, n: 40 });

  if (snake.isPlayer) {
    io.to(snake.id).emit('died', snake.score);
    return;
  }

  setTimeout(() => {
    if (activeEntities() < CONFIG.maxEntities) {
      spawnBot(snake.skinIdx, snake.name);
    }
  }, CONFIG.botRespawnDelayMs);
}

function checkCollisions() {
  const all = [...activePlayers(), ...activeBots()];

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
          killSnake(snake);
          break;
        }
      }

      if (!snake.alive) break;
    }
  }
}

function buildLeaderboard() {
  const all = [...activePlayers(), ...activeBots()]
    .map((snake) => ({ id: snake.id, name: snake.name, score: snake.score }))
    .sort((a, b) => b.score - a.score);

  const ranks = new Map();
  all.forEach((entry, index) => ranks.set(entry.id, index + 1));

  return {
    top: all.slice(0, 10),
    ranks,
  };
}

function buildGameState() {
  const leaderboard = buildLeaderboard();
  const playerSnapshots = activePlayers().map((snake) => snake.getSnapshot());
  const botSnapshots = activeBots().map((snake) => snake.getSnapshot());

  return {
    world: WORLD,
    tickMs: TICK_MS,
    players: playerSnapshots,
    bots: botSnapshots,
    orbs,
    leaderboard: leaderboard.top,
    self: Object.fromEntries(
      activePlayers().map((snake) => [
        snake.id,
        {
          score: snake.score,
          rank: leaderboard.ranks.get(snake.id) || 0,
          boostE: snake.boostE,
        },
      ])
    ),
  };
}

spawnOrbs(CONFIG.initialOrbCount);
fillBots();

io.on('connection', (socket) => {
  socket.on('join', (data = {}) => {
    const existing = players[socket.id];
    if (existing && existing.alive) return;

    if (!canAcceptPlayer()) {
      socket.emit('joinDenied', {
        message: 'Player limit reached. Try again shortly.',
      });
      return;
    }

    const skinIdx = Number.isInteger(data.skinIdx) ? data.skinIdx : 0;
    const name = String(data.name || 'Player').trim().slice(0, 16) || 'Player';
    const spawnX = CONFIG.playerSpawnMin + Math.random() * CONFIG.playerSpawnRange;
    const spawnY = CONFIG.playerSpawnMin + Math.random() * CONFIG.playerSpawnRange;

    players[socket.id] = new Snake(socket.id, spawnX, spawnY, skinIdx, name, true);
    trimExcessBots();
    socket.emit('init', {
      id: socket.id,
      WORLD,
      tickMs: TICK_MS,
      config: {
        maxPlayers: CONFIG.maxPlayers,
        maxEntities: CONFIG.maxEntities,
      },
    });
  });

  socket.on('input', (data = {}) => {
    const player = players[socket.id];
    if (!player || !player.alive) return;

    if (typeof data.angle === 'number' && Number.isFinite(data.angle)) {
      player.targetAngle = data.angle;
    }

    player.boosting = Boolean(data.boosting);
  });

  socket.on('disconnect', () => {
    const player = players[socket.id];
    if (!player) return;

    if (player.alive) killSnake(player);
    delete players[socket.id];
    fillBots();
  });
});

let frame = 0;
setInterval(() => {
  frame += 1;

  for (const snake of [...Object.values(players), ...bots]) {
    if (snake) snake.update();
  }

  bots = bots.filter((bot) => bot.alive);
  trimExcessBots();

  if (frame % 2 === 0) {
    checkCollisions();
  }

  if (orbs.length < CONFIG.minOrbCount) {
    spawnOrbs(CONFIG.orbRefillBurst);
  }

  fillBots();
  io.emit('gameState', buildGameState());
}, TICK_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
