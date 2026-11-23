// RIBBIT RIOT — shared contract. Every module imports from here. Do not add
// dependencies on other modules to this file.

// ---------- constants ----------
export const ART_W = 1200, ART_H = 900;            // logical size of the shared canvas
export const OUTLINE = '#2b2140';                   // every cartoon outline
export const PAPER = '#fff4d6';                     // canvas paper colour
export const PLAYER_COLORS = ['#ff5a5f', '#3fa7ff', '#ffc93c', '#5ad66f']; // by slot 0-3
export const PALETTE = ['#ff5a5f', '#3fa7ff', '#ffc93c', '#5ad66f', '#b46bff', '#2b2140']; // ink colours, index = msg.c
export const INSTRUMENTS = ['goose', 'whistle', 'bonk', 'belly'];
export const BPM = 112;
export const BEAT_MS = 60000 / BPM;
// C major pentatonic as MIDI notes. Instruments index into this so everything is consonant.
export const SCALE = [48, 50, 52, 55, 57, 60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84];
export const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ---------- shared state ----------
// players: Map<id, {id, slot, inst, me, pied}>; `inst` is one of INSTRUMENTS.
export const state = {
  room: null,          // 'ABCD'
  me: null,            // my player id (string) once joined
  players: new Map(),
  replaying: false,    // true while the encore replay runs; modules ignore local input
};
export const myPlayer = () => state.players.get(state.me) || null;
export const playerColor = (id) => PLAYER_COLORS[(state.players.get(id)?.slot ?? 0) % 4];

// ---------- event bus ----------
// Events:
//   'msg'     (m)            every game message, local AND remote, exactly once each.
//                            m = {t, ...payload, from: playerId, local: bool, ts: Date.now()}
//   'players' ()             roster / instrument / pied changed (read state.players)
//   'joined'  ({room, slot}) I am in the room
//   'full'    ()             room already has 4 players
//   'net'     ({ok})         connectivity changed
//   'tick'    ({t, dt})      one per animation frame, t in ms, dt in seconds (clamped)
const handlers = new Map();
export const bus = {
  on(type, fn) { (handlers.get(type) || handlers.set(type, []).get(type)).push(fn); return fn; },
  off(type, fn) { const l = handlers.get(type); if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } },
  emit(type, data) {
    const l = handlers.get(type); if (!l) return;
    for (const fn of l.slice()) { try { fn(data); } catch (e) { console.error('[bus]', type, e); } }
  },
};

// ---------- sending ----------
// send(msg): dispatches locally right away (bus 'msg' with local:true) and relays
// to the other players, who get the same bus 'msg' with local:false. Write ONE
// handler for 'msg' and treat local and remote the same so everyone sees the same thing.
let transport = null;
export function setTransport(fn) { transport = fn; }
export function send(msg) {
  const m = { ...msg, from: state.me, local: true, ts: Date.now() };
  bus.emit('msg', m);
  if (transport) transport(msg);
}

// ---------- late-join sync ----------
// A module with state that a late joiner needs calls
//   sync.provide('key', () => jsonValue)   and   sync.apply('key', (value) => {...})
// The longest-present player answers a newcomer with collect(); the newcomer runs applyAll().
const providers = new Map(), appliers = new Map();
export const sync = {
  provide(key, fn) { providers.set(key, fn); },
  apply(key, fn) { appliers.set(key, fn); },
  collect() { const o = {}; for (const [k, fn] of providers) { try { o[k] = fn(); } catch (e) { console.error(e); } } return o; },
  applyAll(o) { for (const [k, fn] of appliers) { if (o && k in o) { try { fn(o[k]); } catch (e) { console.error(e); } } } },
};

// ---------- helpers ----------
// Deterministic RNG: same seed -> same sequence on every client. Use for anything
// random that all players must see identically (splats, puffs, particles).
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const newSeed = () => (Math.random() * 0xffffffff) >>> 0;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;

// A damped spring for squash-and-stretch. s = {x, v}; call every tick.
export function spring(s, target, dt, stiffness = 180, damping = 12) {
  s.v += ((target - s.x) * stiffness - s.v * damping) * dt;
  s.x += s.v * dt;
  return s.x;
}

// The house googly eye. (lx, ly) is a look direction in -1..1.
export function googlyEye(ctx, x, y, r, lx = 0, ly = 0, lw = 4) {
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fff'; ctx.fill();
  ctx.lineWidth = lw; ctx.strokeStyle = OUTLINE; ctx.stroke();
  const m = Math.hypot(lx, ly) || 1, k = Math.min(1, Math.hypot(lx, ly));
  ctx.beginPath(); ctx.arc(x + (lx / m) * k * r * 0.45, y + (ly / m) * k * r * 0.45, r * 0.48, 0, Math.PI * 2);
  ctx.fillStyle = OUTLINE; ctx.fill();
  ctx.restore();
}

// Fit a canvas' backing store to its CSS box (call on resize); returns the CSS size.
export function fitCanvas(canvas, maxDpr = 2) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return { w: r.width, h: r.height, dpr };
}
