// worker/index.js — Cloudflare Worker entry point (matchmaker)
// Routes WebSocket connections to the correct Durable Object room.

export { GameRoom } from './room.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Upgrade, Connection',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // List available rooms
    if (url.pathname === '/rooms') {
      const rooms = ['backwaters', 'munnar', 'varkala', 'kovalam', 'thekkady'];
      return new Response(JSON.stringify({ rooms }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // WebSocket upgrade — route to Durable Object for the requested room
    if (url.pathname === '/room') {
      const roomName = url.searchParams.get('room') || 'backwaters';
      const id = env.GAME_ROOM.idFromName(roomName);
      const stub = env.GAME_ROOM.get(id);
      // Forward the entire request (including Upgrade header) to the DO
      return stub.fetch(request);
    }

    // Health check / default
    return new Response(JSON.stringify({ status: 'ok', server: 'Slither Kerala Arena' }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  },
};
