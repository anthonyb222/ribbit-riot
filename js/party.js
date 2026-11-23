// FROG JAM — party.js
// The frogs strip, the chaos buttons (pie / tornado / frame), croaks and the
// ENCORE REPLAY. Everything that crosses a module boundary follows bus.js.
import {
  ART_W, ART_H, OUTLINE, PAPER, PLAYER_COLORS, PALETTE, INSTRUMENTS,
  state, bus, send, myPlayer, rng, clamp, lerp, spring, googlyEye, fitCanvas,
} from './bus.js';
import { sfx, playNote, getLevel } from './audio.js';
import { isOp, applyOp, snapshot, restore, blank, drawFlat } from './draw.js';
import { drawIcon } from './instruments.js';

const TAU = Math.PI * 2;
const CREAM = '#fffaf0', CREAM_D = '#efdfba', GOLD = '#ffc93c';
const LOG_CAP = 15000;
const FB = 100, FW = ART_W + FB * 2, FH = ART_H + FB * 2;   // framed picture geometry

let errCount = 0;
const safe = (fn, dflt) => {
  try { return fn(); } catch (e) { if (errCount++ < 20) console.error('[party]', e); return dflt; }
};
const snd = (name, o) => { try { sfx(name, o); } catch (e) { /* audio not ready */ } };
const known = (id) => typeof id === 'string' && state.players.has(id);
const okSender = (m) => m.local === true || known(m.from);
const hash = (s) => { s = String(s); let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const nowMs = () => performance.now();

// ---------- module state ----------
let inited = false, game = null;
let cv = null, cx = null, CW = 0, CH = 0, DPR = 1;      // frogs strip (CSS px)
let S = 60, GROUND = 80, LW = 4;                        // frog size, ground line, outline width
let T = 0, frameNo = 0, level = 0;
let frogRect = null;
const frogs = new Map();      // id -> frog
const ghosts = [];            // frogs hopping away
const blobs = [];             // note blobs / puffs / stars on the strip
const occ = [false, false, false, false];
let lastActor = null, lastActorAt = -99;
let firstRoster = true;

let pieBtn = null, twBtn = null, frBtn = null;
let armed = false, pieX = 0, pieY = 0, lastCroakSent = 0;
let hold = null;              // frame button hold {t, sq}

let fx = null, fg = null, fxOn = false, FXW = 0, FXH = 0, FXD = 1;   // full-screen fx overlay
const pies = [], splats = [], confetti = [];
let twister = null, twistUntil = 0;
const cur = { x: 0, v: 0 }; let curTarget = 0;         // theatre curtains 0 gone .. 1 closed

let cream = null, creamSuppressed = false;             // my pied overlay

const log = [];               // [{m, ts}]
let baseline = null;          // snapshot at log start; null = blank page
let enc = null, watchdog = 0; // running encore
let framed = null;            // framed picture overlay
let lastRoom = null;
const CHIP = { chip: true }, ROPT = { quiet: true, speed: 8 };

// ---------- tiny drawing helpers ----------
function rr(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
}
function ell(c, x, y, rx, ry, rot, fill) {
  c.beginPath(); c.ellipse(x, y, rx, ry, rot, 0, TAU);
  if (fill) { c.fillStyle = fill; c.fill(); }
  c.stroke();
}
function circ(c, x, y, r, fill) {
  c.beginPath(); c.arc(x, y, r, 0, TAU);
  if (fill) { c.fillStyle = fill; c.fill(); }
  c.stroke();
}
function star(c, x, y, r, n, rot) {
  c.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = rot + i * Math.PI / n, q = i % 2 ? r * 0.45 : r;
    const px = x + Math.cos(a) * q, py = y + Math.sin(a) * q;
    if (i) c.lineTo(px, py); else c.moveTo(px, py);
  }
  c.closePath();
}
function heart(c, x, y, r) {
  c.beginPath(); c.moveTo(x, y + r * 0.9);
  c.bezierCurveTo(x - r * 1.5, y - r * 0.1, x - r * 0.6, y - r * 1.15, x, y - r * 0.35);
  c.bezierCurveTo(x + r * 0.6, y - r * 1.15, x + r * 1.5, y - r * 0.1, x, y + r * 0.9);
  c.closePath();
}
function spiralEye(c, x, y, r, lw, ang) {
  c.beginPath(); c.arc(x, y, r, 0, TAU); c.fillStyle = '#fff'; c.fill();
  c.lineWidth = lw; c.strokeStyle = OUTLINE; c.stroke();
  c.beginPath();
  for (let i = 0; i <= 14; i++) {
    const a = ang + i * 0.9, q = r * 0.8 * i / 14;
    const px = x + Math.cos(a) * q, py = y + Math.sin(a) * q;
    if (i) c.lineTo(px, py); else c.moveTo(px, py);
  }
  c.lineWidth = lw * 0.7; c.stroke(); c.lineWidth = lw;
}
const PIE_BUMPS = [[-0.2, -0.02, 0.17], [0, -0.13, 0.21], [0.2, -0.02, 0.17]];
function drawPie(c, x, y, size, rot, kx = 1, ky = 1) {
  c.save(); c.translate(x, y); c.rotate(rot); c.scale(size * kx, size * ky);
  c.lineJoin = c.lineCap = 'round'; c.strokeStyle = OUTLINE; c.lineWidth = 0.075;
  c.beginPath(); c.moveTo(-0.36, 0.1); c.lineTo(0.36, 0.1); c.lineTo(0.26, 0.36); c.lineTo(-0.26, 0.36); c.closePath();
  c.fillStyle = '#e9a54a'; c.fill(); c.stroke();
  for (const b of PIE_BUMPS) { c.beginPath(); c.arc(b[0], b[1], b[2], 0, TAU); c.stroke(); }
  c.fillStyle = '#fff';
  for (const b of PIE_BUMPS) { c.beginPath(); c.arc(b[0], b[1], b[2], 0, TAU); c.fill(); }
  rr(c, -0.46, 0.04, 0.92, 0.13, 0.06); c.fillStyle = '#f6c56b'; c.fill(); c.stroke();
  circ(c, 0.02, -0.37, 0.085, '#ff5a5f');
  c.restore();
}
let iconFails = 0;
function icon(c, inst, x, y, size) {
  if (iconFails > 5) return;
  c.save();
  try { drawIcon(c, inst, x, y, size); } catch (e) { iconFails++; }
  c.restore();
}

// ---------- frogs ----------
function makeFrog(p, delay, quiet) {
  return {
    id: p.id, slot: clamp(p.slot | 0, 0, 3), inst: INSTRUMENTS.includes(p.inst) ? p.inst : INSTRUMENTS[0],
    x: -1, sq: { x: 0, v: 0 }, th: { x: 0, v: 0 }, croakT: 0, lastCroak: -9,
    hy: 0, hv: 0, drop: 4.5, dv: 0, delay, landed: false, quiet,
    tongue: 0, blinkAt: T + 1 + Math.random() * 3, blink: 0, dizzy: 0, dizzyMax: 1.7,
    lx: 0, ly: 0, ph: Math.random() * TAU, incoming: 0, pied: false, piedAt: -9,
    stk: null, sx: 0, sy: 0, lastBlob: -9, bow: null, twHit: true, leave: -1, dir: 1,
  };
}
const slotX = (slot) => CW * (slot + 0.5) / 4;
function hop(f, power = 1) {
  if (f.hy < 0.03 && f.drop <= 0) { f.hv = 2.2 * power; f.sq.v -= 4; }
}

function onPlayers() {
  const prev = new Map();
  for (const f of frogs.values()) prev.set(f.id, f.inst);
  let i = 0;
  for (const p of state.players.values()) {
    if (!p || typeof p.id !== 'string') continue;
    let f = frogs.get(p.id);
    if (!f) {
      f = makeFrog(p, firstRoster ? 0.12 * (i++) : 0, firstRoster || p.id === state.me);
      frogs.set(p.id, f);
    }
    f.slot = clamp(p.slot | 0, 0, 3);
    const pied = p.pied === true;
    if (pied && !f.pied) f.piedAt = T;
    f.pied = pied;
  }
  for (const [id, f] of frogs) {
    if (state.players.has(id)) continue;
    frogs.delete(id);
    f.leave = 0; f.dir = f.x > CW / 2 ? 1 : -1; f.stk = null; f.bow = null;
    ghosts.push(f); if (state.me && id !== state.me) snd('leave');
    for (let k = 0; k < 5; k++) puffAt(f.x + (Math.random() - 0.5) * S * 0.6, GROUND - S * 0.2);
  }
  if (frogs.size) firstRoster = false; else firstRoster = true;
  // instrument stickers fly to their new owners
  const twist = nowMs() < twistUntil;
  for (const f of frogs.values()) {
    const p = state.players.get(f.id);
    if (!p || !INSTRUMENTS.includes(p.inst) || p.inst === f.inst) continue;
    let src = null;
    for (const g of frogs.values()) { if (g !== f && prev.get(g.id) === p.inst) { src = g; break; } }
    f.inst = p.inst;
    f.stk = {
      t: 0, dur: twist ? 1.5 : 0.55, mode: twist ? 'twist' : 'fly',
      fx: src ? src.sx : f.sx, fy: src ? src.sy : -S * 0.5,
    };
  }
}

function puffAt(x, y) {
  if (blobs.length > 90) return;
  blobs.push({ k: 'puff', x, y, vx: (Math.random() - 0.5) * S * 1.6, vy: -Math.random() * S * 1.2, r: S * (0.1 + Math.random() * 0.08), life: 0, max: 0.5 + Math.random() * 0.2, col: '#fff', rot: 0, vr: 0 });
}
function spawnBlob(f, kind) {
  if (blobs.length > 70 || CW < 8) return;
  f.lastBlob = T;
  blobs.push({
    k: kind, x: f.x + (Math.random() - 0.5) * S * 0.3, y: GROUND - S * (0.7 + f.hy),
    vx: (Math.random() - 0.5) * S * 2.4, vy: -S * (1.5 + Math.random() * 1.3),
    r: S * (0.09 + Math.random() * 0.05), life: 0, max: 0.65 + Math.random() * 0.3,
    col: kind === 'star' ? GOLD : PLAYER_COLORS[f.slot & 3], rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 9,
  });
}

function noteReact(f, m) {
  if (!INSTRUMENTS.includes(m.i)) return;
  if (m.i === 'goose' && !m.on) return;
  lastActor = f.id; lastActorAt = T;
  if (m.i === 'whistle' && !m.drop) {
    f.sq.v -= 1.4;
    if (T - f.lastBlob > 0.14) spawnBlob(f, 'whistle');
  } else {
    hop(f); spawnBlob(f, m.i);
    if (blobs.length < 40) spawnBlob(f, m.i);
  }
}
function drawReact(f) {
  lastActor = f.id; lastActorAt = T;
  if (f.tongue <= 0) f.sq.v += 2.5;
  f.tongue = 0.7;
}
function croak(id) {
  const f = frogs.get(id); if (!f || T - f.lastCroak < 0.12) return;
  f.lastCroak = T; f.croakT = 0.38; f.th.v += 6; f.sq.v += 3;
  lastActor = id; lastActorAt = T;
  snd('croak', { slot: f.slot });
}

function updateFrogs(dt) {
  for (const f of frogs.values()) {
    const tx = slotX(f.slot);
    f.x = f.x < 0 ? tx : f.x + (tx - f.x) * Math.min(1, dt * 10);
    spring(f.sq, 0, dt, 200, 11);
    if (f.croakT > 0) f.croakT -= dt;
    spring(f.th, f.croakT > 0 ? 1 : 0, dt, 260, 11);
    // drop in from above with a bounce
    if (f.delay > 0) f.delay -= dt;
    else if (f.drop > 0 || f.dv !== 0) {
      f.dv += 30 * dt; f.drop -= f.dv * dt;
      if (f.drop <= 0) {
        f.drop = 0;
        if (f.dv > 4) { f.dv = -f.dv * 0.32; f.drop = 0.001; f.sq.v += 9; if (!f.landed) { f.landed = true; if (!f.quiet) snd('join'); } }
        else f.dv = 0;
      }
    }
    if (f.hy > 0 || f.hv > 0) {
      f.hv -= 9 * dt; f.hy += f.hv * dt;
      if (f.hy <= 0) { f.hy = 0; f.hv = 0; f.sq.v += 6; }
    }
    if (f.tongue > 0) f.tongue -= dt;
    if (f.dizzy > 0) f.dizzy -= dt;
    if (T > f.blinkAt) { f.blink = 0.13; f.blinkAt = T + 1.5 + Math.random() * 4; }
    if (f.blink > 0) f.blink -= dt;
    // where to look
    let lx = Math.sin(T * 0.6 + f.ph) * 0.35, ly = 0.1;
    if (armed && frogRect) { lx = clamp((pieX - frogRect.left - f.x) / (S * 2), -1, 1); ly = -0.9; }
    else if (lastActor && lastActor !== f.id && T - lastActorAt < 2.5) {
      const a = frogs.get(lastActor);
      if (a) { lx = clamp((a.x - f.x) / (CW * 0.2 + 1), -1, 1); ly = 0; }
    }
    f.lx += (lx - f.lx) * Math.min(1, dt * 9); f.ly += (ly - f.ly) * Math.min(1, dt * 9);
    if (f.bow) {
      const b = f.bow; b.t += dt;
      if (b.fall && !b.hit && b.t >= 0.6) {
        b.hit = true; f.sq.v += 9; snd('bonk');
        for (let k = 0; k < 4; k++) spawnBlob(f, 'star');
      }
      if (b.t > 2.2) f.bow = null;
    }
    if (f.stk) {
      f.stk.t += dt;
      if (f.stk.t >= f.stk.dur) { f.stk = null; f.sq.v += 5; if (f.id === state.me) snd('pop'); }
    }
    if (twister && !f.twHit && frogRect && twister.x >= frogRect.left + f.x - S * 0.3) {
      f.twHit = true; f.dizzy = f.dizzyMax = 1.7; hop(f, 1.25);
    }
  }
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const g = ghosts[i]; g.leave += dt; spring(g.sq, 0, dt, 200, 11);
    if (g.leave > 0.8) ghosts.splice(i, 1);
  }
  for (let i = blobs.length - 1; i >= 0; i--) {
    const b = blobs[i]; b.life += dt;
    if (b.life >= b.max) { blobs[i] = blobs[blobs.length - 1]; blobs.pop(); continue; }
    if (b.k !== 'puff') b.vy += S * 3.2 * dt;
    b.x += b.vx * dt; b.y += b.vy * dt; b.rot += b.vr * dt;
  }
}

const CREAM_BLOBS = [[0, -0.45, 0.3], [-0.26, -0.5, 0.17], [0.26, -0.5, 0.17], [-0.16, -0.27, 0.16], [0.17, -0.29, 0.15], [0, -0.7, 0.15]];
const SPOTS = [[-0.3, -0.5, 0.065], [0.33, -0.42, 0.055], [-0.12, -0.62, 0.045], [0.18, -0.6, 0.04], [0.37, -0.25, 0.042], [-0.38, -0.28, 0.045]];
const WARTS = [[-0.33, -0.46, 0.045], [0.3, -0.5, 0.04], [-0.05, -0.63, 0.038], [0.37, -0.3, 0.038], [-0.39, -0.27, 0.034], [0.12, -0.6, 0.03]];
const STRIPES = [[-0.13, -0.66, -0.13, -0.56], [0, -0.68, 0, -0.57], [0.13, -0.66, 0.13, -0.56], [-0.42, -0.42, -0.32, -0.42], [-0.43, -0.3, -0.33, -0.3], [0.42, -0.42, 0.32, -0.42], [0.43, -0.3, 0.33, -0.3]];

function markings(c, slot, lw) {
  const dark = 'rgba(43,33,64,0.26)';
  if (slot === 0) {
    c.fillStyle = dark;
    for (const s of SPOTS) { c.beginPath(); c.arc(s[0], s[1], s[2], 0, TAU); c.fill(); }
  } else if (slot === 1) {
    c.save(); c.strokeStyle = dark; c.lineWidth = 0.05;
    c.beginPath(); for (const s of STRIPES) { c.moveTo(s[0], s[1]); c.lineTo(s[2], s[3]); }
    c.stroke(); c.restore();
  } else if (slot === 2) {
    c.save(); c.lineWidth = lw * 0.6;
    heart(c, -0.27, -0.5, 0.1); c.fillStyle = '#ff5a8a'; c.fill(); c.stroke(); c.restore();
  } else {
    c.save(); c.lineWidth = lw * 0.55; c.fillStyle = 'rgba(255,255,255,0.55)';
    for (const s of WARTS) { c.beginPath(); c.arc(s[0], s[1], s[2], 0, TAU); c.fill(); c.stroke(); }
    c.restore();
  }
}

function drawFrog(f) {
  const c = cx, s = S, col = PLAYER_COLORS[f.slot & 3];
  const q = clamp(f.sq.x, -0.7, 0.7);
  const br = Math.sin(T * 2.2 + f.ph) * 0.022 + level * 0.05;
  let sx = 1 + q * 0.45 - br * 0.6, sy = 1 - q * 0.45 + br;
  let rot = 0, ox = 0, oy = -(f.hy + f.drop) * s, alpha = 1;
  let shut = f.blink > 0, swirl = f.dizzy > 0;
  const nervous = armed && f.leave < 0, showCream = f.pied && f.incoming === 0 && T - f.piedAt > 0.1;
  if (f.tongue > 0) rot += Math.sin(T * 19 + f.ph) * 0.06;
  if (nervous) ox += Math.sin(T * 51 + f.ph * 7) * s * 0.012;
  if (f.dizzy > 0) {
    const u = clamp((f.dizzyMax - f.dizzy) / 1.1, 0, 1), k = Math.cos(TAU * 3 * (1 - (1 - u) * (1 - u)));
    sx *= Math.abs(k) < 0.08 ? 0.08 : k; rot += Math.sin(T * 9) * 0.1;
  }
  if (f.bow) {
    const t = Math.max(0, f.bow.t);
    if (f.bow.fall) {
      const a = t < 0.3 ? 0 : t < 0.6 ? Math.pow((t - 0.3) / 0.3, 2) : t < 1.7 ? 1 : Math.max(0, 1 - (t - 1.7) / 0.25);
      rot += f.bow.dir * a * 1.5; if (a >= 1) { sy *= 0.82; swirl = true; } else if (a > 0) shut = true;
    } else {
      const a = t < 1.3 ? Math.max(0, Math.sin(t * 4.83)) : 0;
      sy *= 1 - a * 0.35; sx *= 1 + a * 0.15; rot += f.bow.dir * a * 0.22; if (a > 0.25) shut = true;
    }
  }
  if (f.leave >= 0) {
    const t = f.leave;
    ox += f.dir * t * 2.6 * s; oy -= (3.4 * t - 7 * t * t) * s; rot += f.dir * t * 5;
    alpha = 1 - clamp((t - 0.5) / 0.3, 0, 1);
  }
  f.sx = f.x + ox + 0.4 * s * sx; f.sy = GROUND + oy - 0.17 * s * sy;

  c.save(); c.globalAlpha = alpha;
  c.translate(f.x + ox, GROUND + oy); c.rotate(rot); c.scale(s * sx, s * sy);
  const lw = LW / s; c.lineWidth = lw; c.strokeStyle = OUTLINE;
  // back legs + feet
  ell(c, -0.4, -0.13, 0.2, 0.15, -0.35, col); ell(c, 0.4, -0.13, 0.2, 0.15, 0.35, col);
  ell(c, -0.5, -0.035, 0.15, 0.055, 0, col); ell(c, 0.5, -0.035, 0.15, 0.055, 0, col);
  // eye bumps, body, belly
  circ(c, -0.24, -0.68, 0.165, col); circ(c, 0.24, -0.68, 0.165, col);
  ell(c, 0, -0.36, 0.46, 0.36, 0, col);
  c.beginPath(); c.ellipse(0, -0.2, 0.3, 0.18, 0, 0, TAU); c.fillStyle = 'rgba(255,244,214,0.85)'; c.fill();
  markings(c, f.slot & 3, lw);
  c.fillStyle = 'rgba(255,90,138,0.4)';
  c.beginPath(); c.arc(-0.34, -0.36, 0.05, 0, TAU); c.arc(0.34, -0.36, 0.05, 0, TAU); c.fill();
  // throat sac
  const th = clamp(f.th.x, 0, 1.3);
  if (th > 0.03) circ(c, 0, -0.24, 0.05 + 0.3 * th, PAPER);
  // mouth
  const mo = th * 0.6 + (f.hy > 0.03 ? 0.3 : 0);
  c.beginPath();
  if (nervous && mo < 0.05) {
    c.moveTo(-0.24, -0.4);
    for (let i = 1; i <= 6; i++) c.lineTo(-0.24 + 0.08 * i, -0.4 + (i % 2 ? -0.028 : 0.028));
    c.stroke();
  } else {
    c.moveTo(-0.3, -0.44); c.quadraticCurveTo(0, -0.34, 0.3, -0.44);
    if (mo > 0.05) { c.quadraticCurveTo(0, -0.34 + mo * 0.4, -0.3, -0.44); c.closePath(); c.fillStyle = OUTLINE; c.fill(); }
    c.stroke();
  }
  if (f.tongue > 0) ell(c, 0.2, -0.345, 0.06, 0.1, 0.5 + Math.sin(T * 14) * 0.25, '#ff8fb1');
  // front feet
  ell(c, -0.17, -0.035, 0.09, 0.045, 0, col); ell(c, 0.17, -0.035, 0.09, 0.045, 0, col);
  // cream pie face: everything but the eyes
  if (showCream) {
    c.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      c.strokeStyle = pass ? CREAM : OUTLINE; c.lineWidth = pass ? 0.08 : 0.08 + lw * 2;
      c.beginPath();
      for (let i = 0; i < 3; i++) {
        const dx = -0.2 + i * 0.21, len = 0.1 + 0.07 * (0.5 + 0.5 * Math.sin(T * 1.7 + i * 2.1 + f.ph));
        c.moveTo(dx, -0.25); c.lineTo(dx, -0.2 + len);
      }
      c.stroke();
    }
    c.strokeStyle = OUTLINE; c.lineWidth = lw * 2;
    for (const b of CREAM_BLOBS) { c.beginPath(); c.arc(b[0], b[1], b[2], 0, TAU); c.stroke(); }
    c.fillStyle = CREAM;
    for (const b of CREAM_BLOBS) { c.beginPath(); c.arc(b[0], b[1], b[2], 0, TAU); c.fill(); }
    c.lineWidth = lw; c.strokeStyle = CREAM_D;
    c.beginPath(); c.arc(-0.05, -0.42, 0.13, 0.4, 2.6); c.stroke();
    c.strokeStyle = OUTLINE;
  }
  // eyes
  for (let sg = -1; sg <= 1; sg += 2) {
    const ex = sg * 0.24, ey = -0.7;
    if (swirl) spiralEye(c, ex, ey, 0.13, lw, T * 10 * sg);
    else if (shut) {
      circ(c, ex, ey, 0.13, showCream ? CREAM : col);
      c.beginPath(); c.arc(ex, ey - 0.03, 0.08, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
    } else if (f.tongue > 0) googlyEye(c, ex, ey, 0.13, -sg * 0.7, 0.55, lw);
    else googlyEye(c, ex, ey, 0.13, f.lx, f.ly, lw);
  }
  c.restore();
}

function drawPad(slot) {
  const c = cx, x = slotX(slot), y = GROUND + S * 0.03;
  c.lineWidth = LW; c.strokeStyle = OUTLINE;
  c.beginPath(); c.moveTo(x, y); c.ellipse(x, y, S * 0.64, S * 0.13, 0, 0.35, TAU - 0.12); c.closePath();
  c.fillStyle = '#35b27a'; c.fill(); c.stroke();
}
function drawEmpty(slot) {
  const c = cx, x = slotX(slot), s = S;
  c.save(); c.globalAlpha = 0.3; c.lineWidth = LW * 0.8; c.strokeStyle = OUTLINE; c.setLineDash([LW * 1.2, LW * 2]);
  c.translate(x, GROUND); c.scale(s, s); c.lineWidth = LW * 0.8 / s; c.setLineDash([0.06, 0.1]);
  c.beginPath(); c.ellipse(0, -0.36, 0.46, 0.36, 0, 0, TAU); c.stroke();
  c.beginPath(); c.arc(-0.24, -0.7, 0.14, 0, TAU); c.stroke();
  c.beginPath(); c.arc(0.24, -0.7, 0.14, 0, TAU); c.stroke();
  c.restore();
}
function stickerPos(f, out) {
  const k = f.stk; let x = f.sx, y = f.sy, rot = Math.sin(T * 3 + f.ph) * 0.12;
  if (k) {
    const u = clamp(k.t / k.dur, 0, 1);
    if (k.mode === 'twist') {
      if (u < 0.5) { const v = u / 0.5; x = k.fx + Math.sin(v * 10) * S * 0.3 * v; y = lerp(k.fy, -S * 0.5, v * v); rot = v * 12; }
      else { const v = (u - 0.5) / 0.5, e = 1 - Math.abs(Math.cos(v * Math.PI * 1.5)) * (1 - v); x = f.sx + Math.sin(v * 8) * (1 - v) * S * 0.25; y = lerp(-S * 0.5, f.sy, e); rot = (1 - v) * 6; }
    } else {
      const e = u * u * (3 - 2 * u);
      x = lerp(k.fx, f.sx, e); y = lerp(k.fy, f.sy, e) - Math.sin(u * Math.PI) * S * 0.55; rot = u * TAU;
    }
  }
  out.x = x; out.y = y; out.rot = rot;
}
const SP = { x: 0, y: 0, rot: 0 };

function drawStrip() {
  const c = cx;
  c.setTransform(DPR, 0, 0, DPR, 0, 0); c.clearRect(0, 0, CW, CH); c.lineJoin = c.lineCap = 'round';
  occ[0] = occ[1] = occ[2] = occ[3] = false;
  for (const f of frogs.values()) occ[f.slot & 3] = true;
  for (let i = 0; i < 4; i++) { drawPad(i); if (!occ[i]) drawEmpty(i); }
  for (const f of frogs.values()) if (f.delay <= 0) drawFrog(f);
  for (const g of ghosts) drawFrog(g);
  // instrument stickers
  for (const f of frogs.values()) {
    if (f.delay > 0) continue;
    stickerPos(f, SP);
    const size = S * 0.3;
    c.save(); c.translate(SP.x, SP.y); c.rotate(SP.rot);
    c.lineWidth = LW * 0.7; c.strokeStyle = OUTLINE; circ(c, 0, 0, size * 0.66, '#fff');
    icon(c, f.inst, 0, 0, size);
    c.restore();
  }
  // note blobs
  c.strokeStyle = OUTLINE;
  for (const b of blobs) {
    const u = b.life / b.max;
    c.globalAlpha = u > 0.7 ? (1 - u) / 0.3 : 1; c.lineWidth = LW * 0.6; c.fillStyle = b.col;
    if (b.k === 'goose') {
      c.beginPath();
      for (let i = 0; i < 3; i++) { const a = b.rot + i * TAU / 3; const px = b.x + Math.cos(a) * b.r * 1.2, py = b.y + Math.sin(a) * b.r * 1.2; if (i) c.lineTo(px, py); else c.moveTo(px, py); }
      c.closePath(); c.fill(); c.stroke();
    } else if (b.k === 'whistle') {
      c.beginPath(); c.arc(b.x, b.y, b.r * 0.9, 0, TAU); c.lineWidth = b.r * 0.75; c.stroke();
      c.strokeStyle = b.col; c.lineWidth = b.r * 0.38; c.stroke(); c.strokeStyle = OUTLINE;
    } else if (b.k === 'bonk' || b.k === 'star') {
      star(c, b.x, b.y, b.r * 1.3, b.k === 'star' ? 5 : 4, b.rot); c.fill(); c.stroke();
    } else if (b.k === 'puff') {
      c.globalAlpha = (1 - u) * 0.9; c.beginPath(); c.arc(b.x, b.y, b.r * (1 + u * 1.6), 0, TAU); c.fill(); c.stroke();
    } else {
      c.beginPath(); c.ellipse(b.x, b.y, b.r * 1.25, b.r, 0, 0, TAU); c.fill(); c.stroke();
    }
  }
  c.globalAlpha = 1;
  // arrow over my frog
  const me = frogs.get(state.me);
  if (me && me.delay <= 0 && me.drop < 0.5) {
    const a = S * 0.11, y = Math.max(LW + a * 1.7, GROUND - (me.hy + me.drop) * S - S * 0.98 - Math.abs(Math.sin(T * 5)) * S * 0.1);
    c.lineWidth = LW * 0.8; c.strokeStyle = OUTLINE; c.fillStyle = '#fff';
    c.beginPath(); c.moveTo(me.x - a, y - a * 1.5); c.lineTo(me.x + a, y - a * 1.5); c.lineTo(me.x, y); c.closePath(); c.fill(); c.stroke();
  }
}

function onFrogTap(e) {
  if (state.replaying || !cv) return;
  frogRect = cv.getBoundingClientRect();
  const x = e.clientX - frogRect.left;
  let best = null, bd = CW / 8 + 4;
  for (const f of frogs.values()) { const d = Math.abs(f.x - x); if (d < bd) { bd = d; best = f; } }
  if (!best) return;
  e.preventDefault();
  if (armed) {
    setArmed(false);
    pieBtn.cool = pieBtn.max = 10;
    send({ t: 'pie', to: best.id });
  } else {
    const n = nowMs(); if (n - lastCroakSent < 180) return;
    lastCroakSent = n;
    send({ t: 'croak', who: best.id });
  }
}

// ---------- chaos buttons ----------
function mkBtn(label, draw) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'rb'; b.setAttribute('aria-label', label);
  const c = document.createElement('canvas'); c.width = c.height = 96;
  c.style.pointerEvents = 'none';
  b.appendChild(c);
  return { b, g: c.getContext('2d'), draw, cool: 0, max: 1, ring: 0, wig: { x: 0, v: 0 }, dirty: true, wasCool: false };
}
function paintBtn(o) {
  const g = o.g; g.setTransform(2, 0, 0, 2, 0, 0); g.clearRect(0, 0, 48, 48); g.lineJoin = g.lineCap = 'round';
  g.save(); g.translate(24, 24); g.rotate(o.wig.x); g.translate(-24, -24); g.strokeStyle = OUTLINE; o.draw(g); g.restore();
  if (o.cool > 0) {
    g.strokeStyle = OUTLINE; g.lineWidth = 5;
    g.beginPath(); g.arc(24, 24, 20, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(o.cool / o.max, 0, 1)); g.stroke();
  }
  if (o.ring > 0) {
    const a1 = -Math.PI / 2 + TAU * clamp(o.ring, 0, 1);
    g.strokeStyle = OUTLINE; g.lineWidth = 8; g.beginPath(); g.arc(24, 24, 19.5, -Math.PI / 2, a1); g.stroke();
    g.strokeStyle = '#5ad66f'; g.lineWidth = 4; g.beginPath(); g.arc(24, 24, 19.5, -Math.PI / 2, a1); g.stroke();
  }
}
function tickBtn(o, dt) {
  if (!o) return;
  if (o.cool > 0) { o.cool = Math.max(0, o.cool - dt); o.dirty = true; }
  const cooling = o.cool > 0;
  if (cooling !== o.wasCool) { o.b.classList.toggle('cool', cooling); o.wasCool = cooling; o.dirty = true; }
  if (Math.abs(o.wig.x) > 0.002 || Math.abs(o.wig.v) > 0.02) { spring(o.wig, 0, dt, 260, 9); o.dirty = true; }
  if (o.dirty) { paintBtn(o); o.dirty = false; }
}
function nope(o) { o.wig.v = 9; o.dirty = true; snd('nope'); }

function icoPie(g) { drawPie(g, 24, 25, 40, 0); }
function icoTwister(g) {
  const ys = [11, 19, 26.5, 33, 38.5], rs = [17, 13, 9.5, 6, 3.2], xs = [0, 1.5, -1, 1.5, 0];
  g.lineWidth = 3;
  for (let i = 4; i >= 0; i--) ell(g, 24 + xs[i], ys[i], rs[i], rs[i] * 0.3 + 2.2, 0, i % 2 ? '#d9d5f3' : '#c3bde6');
  googlyEye(g, 18.5, 11, 4.8, 0.9, 0.3, 2.4); googlyEye(g, 29.5, 11, 4.8, -0.9, 0.3, 2.4);
}
function icoFrame(g) {
  g.lineWidth = 3.5; rr(g, 5, 8, 38, 32, 6); g.fillStyle = GOLD; g.fill(); g.stroke();
  g.lineWidth = 3; rr(g, 11.5, 14, 25, 20, 2); g.fillStyle = PAPER; g.fill(); g.stroke();
  g.beginPath(); g.moveTo(13.5, 32.5); g.quadraticCurveTo(20, 20, 27, 32.5); g.closePath(); g.fillStyle = '#5ad66f'; g.fill();
  g.beginPath(); g.arc(30.5, 20, 3.2, 0, TAU); g.fillStyle = '#ff5a5f'; g.fill();
}
function icoDownload(g) {
  g.lineWidth = 3.5;
  g.beginPath(); g.moveTo(19, 6); g.lineTo(29, 6); g.lineTo(29, 18); g.lineTo(36, 18); g.lineTo(24, 31); g.lineTo(12, 18); g.lineTo(19, 18); g.closePath();
  g.fillStyle = '#3fa7ff'; g.fill(); g.stroke();
  g.lineWidth = 5; g.beginPath(); g.moveTo(8, 32); g.lineTo(8, 41); g.lineTo(40, 41); g.lineTo(40, 32); g.stroke();
}
const CRUMPLE = [24, 6, 33, 9, 41, 17, 38, 27, 42, 34, 31, 42, 21, 39, 12, 42, 6, 31, 10, 22, 7, 13, 16, 11];
function icoCrumple(g) {
  g.lineWidth = 3.5; g.beginPath();
  for (let i = 0; i < CRUMPLE.length; i += 2) { if (i) g.lineTo(CRUMPLE[i], CRUMPLE[i + 1]); else g.moveTo(CRUMPLE[i], CRUMPLE[i + 1]); }
  g.closePath(); g.fillStyle = '#fff'; g.fill(); g.stroke();
  g.lineWidth = 2; g.beginPath();
  g.moveTo(16, 11); g.lineTo(22, 22); g.lineTo(33, 9); g.moveTo(22, 22); g.lineTo(21, 39);
  g.moveTo(22, 22); g.lineTo(38, 27); g.moveTo(10, 22); g.lineTo(22, 22); g.stroke();
}
function icoCheck(g) {
  for (let p = 0; p < 2; p++) {
    g.strokeStyle = p ? '#5ad66f' : OUTLINE; g.lineWidth = p ? 6.5 : 13;
    g.beginPath(); g.moveTo(10, 25); g.lineTo(20, 35); g.lineTo(38, 13); g.stroke();
  }
}

function setArmed(v) {
  armed = !!v;
  if (pieBtn) pieBtn.b.classList.toggle('on', armed);
  if (armed && cv) frogRect = cv.getBoundingClientRect();
}
function buildSwap() {
  const ps = [];
  for (const p of state.players.values()) if (p && typeof p.id === 'string') ps.push(p);
  ps.sort((a, b) => a.slot - b.slot);
  const n = ps.length, map = {};
  const curI = ps.map((p) => (INSTRUMENTS.includes(p.inst) ? p.inst : INSTRUMENTS[0]));
  for (let i = 0; i < n; i++) {
    let nx = curI[(i + 1) % n];
    if (nx === curI[i]) nx = INSTRUMENTS[(INSTRUMENTS.indexOf(curI[i]) + 1 + (i % 3)) % 4];
    map[ps[i].id] = nx;
  }
  return map;
}
function startHold() {
  if (hold) return;
  if (state.replaying || frBtn.cool > 0) { nope(frBtn); return; }
  hold = { t: 0, sq: 0 };
}
function stopHold() {
  if (!hold) return;
  hold = null; frBtn.ring = 0; frBtn.wig.v = 8; frBtn.dirty = true;
}
function buildChaos() {
  const box = document.getElementById('chaos'); if (!box) return;
  pieBtn = mkBtn('pie', icoPie); twBtn = mkBtn('tornado', icoTwister); frBtn = mkBtn('frame', icoFrame);
  pieBtn.b.addEventListener('click', () => {
    if (armed) { setArmed(false); return; }
    if (state.replaying || pieBtn.cool > 0 || !frogs.size) { nope(pieBtn); return; }
    setArmed(true); pieBtn.wig.v = 5; snd('pop');
  });
  twBtn.b.addEventListener('click', () => {
    if (state.replaying || twBtn.cool > 0 || !state.players.size) { nope(twBtn); return; }
    twBtn.cool = twBtn.max = 20;
    send({ t: 'swap', map: buildSwap() });
  });
  const fb = frBtn.b;
  fb.style.touchAction = 'none'; fb.style.userSelect = 'none'; fb.style.webkitUserSelect = 'none'; fb.style.webkitTouchCallout = 'none';
  fb.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    startHold();
    try { fb.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
  });
  fb.addEventListener('pointerup', stopHold);
  fb.addEventListener('pointercancel', stopHold);
  fb.addEventListener('lostpointercapture', stopHold);
  fb.addEventListener('contextmenu', (e) => e.preventDefault());
  fb.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startHold(); } });
  fb.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') stopHold(); });
  box.appendChild(pieBtn.b); box.appendChild(twBtn.b); box.appendChild(fb);
}
function tickButtons(dt) {
  if (hold && frBtn) {
    hold.t += dt; frBtn.ring = Math.min(1, hold.t / 0.8); frBtn.dirty = true;
    if (T - hold.sq > 0.09) { hold.sq = T; snd('squeak', { p: frBtn.ring }); }
    if (state.replaying) stopHold();
    else if (hold.t >= 0.8) { hold = null; frBtn.ring = 0; send({ t: 'frame' }); }
  }
  tickBtn(pieBtn, dt); tickBtn(twBtn, dt); tickBtn(frBtn, dt);
}

// ---------- full-screen fx overlay: pies, twister, curtains, confetti ----------
function ensureFx() {
  if (fx) return;
  fx = document.createElement('canvas');
  fx.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:70;pointer-events:none;display:none;touch-action:none';
  fg = fx.getContext('2d');
  game.appendChild(fx);
}
function sizeFx() {
  const w = window.innerWidth, h = window.innerHeight, d = Math.min(window.devicePixelRatio || 1, 1.5);
  if (w === FXW && h === FXH && d === FXD) return;
  FXW = w; FXH = h; FXD = d;
  fx.width = Math.max(1, Math.round(w * d)); fx.height = Math.max(1, Math.round(h * d));
}
function setFxInput(on) { if (fx) fx.style.pointerEvents = on ? 'auto' : 'none'; }

function flingPie(m) {
  if (pies.length >= 6) return;
  if (cv) frogRect = cv.getBoundingClientRect();
  const tf = frogs.get(m.to), ff = frogs.get(m.from);
  let ax = window.innerWidth / 2, ay = window.innerHeight + 40;
  const r = m.local && pieBtn ? pieBtn.b.getBoundingClientRect() : null;
  if (r && r.width) { ax = r.left + r.width / 2; ay = r.top + r.height / 2; }
  else if (ff && frogRect) { ax = frogRect.left + ff.x; ay = frogRect.top + GROUND - S * 0.6; }
  if (tf) tf.incoming++;
  pies.push({ to: m.to, ax, ay, bx: window.innerWidth / 2, by: window.innerHeight / 2, t: 0, dur: 0.62, dir: ax > window.innerWidth / 2 ? -1 : 1, seed: hash(m.to) ^ hash(m.from) });
  snd('throw');
}
function pieImpact(p) {
  const tf = frogs.get(p.to);
  if (tf) { tf.incoming = Math.max(0, tf.incoming - 1); tf.sq.v += 10; tf.piedAt = Math.min(tf.piedAt, T - 1); }
  snd('splat'); setTimeout(() => snd('gag'), 200);
  const r = rng(p.seed || 7);
  for (let i = 0; i < 16; i++) {
    const a = r() * TAU, v = 160 + r() * 420;
    splats.push({ x: p.bx, y: p.by, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 180, r: 5 + r() * 11, life: 0, max: 0.6 + r() * 0.5 });
  }
  if (p.to === state.me) { creamSuppressed = false; startCream(); }
}
function startTwister(m) {
  if (twister && twister.t < 0.8) return;
  twister = { t: 0, dur: 1.5, x: -1e9 };
  twistUntil = nowMs() + 400;
  if (cv) frogRect = cv.getBoundingClientRect();
  for (const f of frogs.values()) {
    f.twHit = false;
    if (f.stk && f.stk.mode === 'fly' && f.stk.t < 0.15) { f.stk.mode = 'twist'; f.stk.dur = 1.5; }
  }
  if (!m.local && twBtn && twBtn.cool < 5) { twBtn.cool = 5; twBtn.max = 5; }
  snd('whoosh', { dur: 1.2 });
}
function drawTwister(g, x, top, bot, time) {
  const h = bot - top, n = 11, lw = clamp(h * 0.011, 4, 8);
  let eyeX = x, eyeY = top;
  for (let i = n - 1; i >= 0; i--) {
    const k = i / (n - 1), y = top + h * k, rx = lerp(h * 0.24, h * 0.02, Math.pow(k, 0.8)), ry = rx * 0.3 + 4;
    const wx = x + Math.sin(time * 7 + k * 5) * h * 0.04 * (k + 0.2);
    g.lineWidth = lw; g.strokeStyle = OUTLINE;
    ell(g, wx, y, rx, ry, 0, i % 2 ? '#d9d5f3' : '#c3bde6');
    const a0 = time * 9 + i * 1.3;
    g.beginPath(); g.ellipse(wx, y, rx * 0.72, ry * 0.6, 0, a0, a0 + 2.2); g.lineWidth = lw * 0.7; g.strokeStyle = '#fff'; g.stroke();
    if (i === 2) { eyeX = wx; eyeY = y; }
    if (i >= 3 && i <= 6) {
      const a = time * 8 + i * TAU / 4;
      icon(g, INSTRUMENTS[i - 3], wx + Math.cos(a) * rx * 1.15, y + Math.sin(a) * ry * 1.4 - h * 0.03, clamp(h * 0.075, 26, 60));
    }
  }
  const er = clamp(h * 0.05, 14, 40);
  googlyEye(g, eyeX - er * 1.25, eyeY, er, 0.95, 0.3, lw * 0.8);
  googlyEye(g, eyeX + er * 1.25, eyeY, er, -0.95, 0.3, lw * 0.8);
}
function drawCurtains(g, W, H, x) {
  const pw = W * 0.5 * Math.min(x, 1.02) + (x > 0.9 ? 6 : 0);
  for (let side = -1; side <= 1; side += 2) {
    const ex = side < 0 ? -10 : W + 10, ix = side < 0 ? pw : W - pw;
    g.beginPath(); g.moveTo(ex, -10); g.lineTo(ix, -10);
    for (let i = 1; i <= 8; i++) g.lineTo(ix - side * Math.sin(T * 2.3 + i * 1.1 + side) * 7 * (i / 8), H * i / 8 + (i === 8 ? 10 : 0));
    g.lineTo(ex, H + 10); g.closePath();
    g.fillStyle = '#e8394f'; g.fill(); g.lineWidth = 6; g.strokeStyle = OUTLINE; g.stroke();
    const nf = Math.max(1, Math.round(pw / 70));
    g.lineWidth = Math.min(14, pw / (nf * 3)); g.strokeStyle = '#b8243a';
    for (let k = 1; k <= nf; k++) {
      const fxp = ex + (ix - ex) * (k / (nf + 0.6));
      g.beginPath(); g.moveTo(fxp, 0); g.quadraticCurveTo(fxp - side * Math.sin(T * 2 + k) * 6, H * 0.5, fxp, H); g.stroke();
    }
  }
  const vh = Math.min(H * 0.085, 64) * Math.min(1, x * 4), n = Math.max(4, Math.round(W / 110)), sw = W / n;
  g.beginPath(); g.moveTo(-10, -10); g.lineTo(W + 10, -10); g.lineTo(W + 10, vh * 0.5);
  for (let i = n; i > 0; i--) g.quadraticCurveTo((i - 0.5) * sw, vh * 1.7, (i - 1) * sw - (i === 1 ? 10 : 0), vh * 0.5);
  g.closePath(); g.fillStyle = '#c92a41'; g.fill(); g.lineWidth = 6; g.strokeStyle = OUTLINE; g.stroke();
  g.lineWidth = 4;
  for (let i = 0; i <= n; i++) circ(g, i * sw, vh * 0.5 + 4, 7, GOLD);
}
function spawnConfetti() {
  const W = window.innerWidth, H = window.innerHeight;
  for (let i = 0; i < 110 && confetti.length < 160; i++) {
    confetti.push({
      x: Math.random() * W, y: -20 - Math.random() * H * 0.5, vx: (Math.random() - 0.5) * 140, vy: 160 + Math.random() * 260,
      rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 10, w: 8 + Math.random() * 8, ph: Math.random() * TAU,
      col: PALETTE[(Math.random() * 5) | 0], life: 0,
    });
  }
}
function tickFx(dt) {
  if (!fx) return;
  if (curTarget > 0 || cur.x > 0.004 || Math.abs(cur.v) > 0.02) {
    spring(cur, curTarget, dt, 70, 13);
    if (cur.x < 0) { cur.x = 0; cur.v = 0; }
  }
  const active = pies.length || splats.length || twister || cur.x > 0.004 || confetti.length || armed;
  if (!active) {
    if (fxOn) { fg.setTransform(1, 0, 0, 1, 0, 0); fg.clearRect(0, 0, fx.width, fx.height); fx.style.display = 'none'; fxOn = false; }
    return;
  }
  if (!fxOn) { fx.style.display = 'block'; fxOn = true; }
  sizeFx();
  const g = fg, W = FXW, H = FXH;
  g.setTransform(FXD, 0, 0, FXD, 0, 0); g.clearRect(0, 0, W, H); g.lineJoin = g.lineCap = 'round';

  if (cur.x > 0.004) drawCurtains(g, W, H, cur.x);

  if (armed && frogRect) {
    pieX = frogRect.left + frogRect.width * (0.5 + 0.36 * Math.sin(T * 1.4));
    pieY = Math.max(36, frogRect.top - 2) + Math.sin(T * 5) * 7;
    const k = 1 + Math.sin(T * 9) * 0.07;
    drawPie(g, pieX, pieY, 58, Math.sin(T * 3.1) * 0.3, k, 1 / k);
  }
  for (let i = pies.length - 1; i >= 0; i--) {
    const p = pies[i]; p.t += dt;
    const tf = frogs.get(p.to);
    if (tf && frogRect) { p.bx = frogRect.left + tf.x; p.by = frogRect.top + GROUND - (tf.hy + 0.5) * S; }
    const u = p.t / p.dur;
    if (u >= 1) { pies.splice(i, 1); pieImpact(p); continue; }
    const d = Math.hypot(p.bx - p.ax, p.by - p.ay), arc = Math.max(110, d * 0.3);
    const x = lerp(p.ax, p.bx, u), y = lerp(p.ay, p.by, u) - Math.sin(u * Math.PI) * arc, k = 1 + 0.28 * Math.sin(u * Math.PI);
    drawPie(g, x, y, lerp(44, 74, u), u * TAU * 2 * p.dir, k, 1 / k);
  }
  if (splats.length) {
    g.lineWidth = 3; g.strokeStyle = OUTLINE; g.fillStyle = CREAM;
    for (let i = splats.length - 1; i >= 0; i--) {
      const s = splats[i]; s.life += dt;
      if (s.life >= s.max) { splats[i] = splats[splats.length - 1]; splats.pop(); continue; }
      s.vy += 1100 * dt; s.x += s.vx * dt; s.y += s.vy * dt;
      g.beginPath(); g.arc(s.x, s.y, s.r * (1 - 0.5 * s.life / s.max), 0, TAU); g.fill(); g.stroke();
    }
  }
  if (twister) {
    twister.t += dt;
    const u = twister.t / twister.dur;
    if (u >= 1) twister = null;
    else {
      twister.x = lerp(-W * 0.25, W * 1.25, u);
      drawTwister(g, twister.x, H * 0.05, H * 0.97, T);
    }
  }
  if (confetti.length) {
    g.lineWidth = 1.5; g.strokeStyle = OUTLINE;
    for (let i = confetti.length - 1; i >= 0; i--) {
      const c = confetti[i]; c.life += dt;
      c.x += (c.vx + Math.sin(T * 3 + c.ph) * 60) * dt; c.y += c.vy * dt; c.rot += c.vr * dt;
      if (c.y > H + 30 || c.life > 6) { confetti[i] = confetti[confetti.length - 1]; confetti.pop(); continue; }
      const co = Math.cos(c.rot), si = Math.sin(c.rot), fl = Math.cos(T * 7 + c.ph);
      g.setTransform(FXD * co, FXD * si, -FXD * si * fl, FXD * co * fl, FXD * c.x, FXD * c.y);
      g.fillStyle = c.col; g.fillRect(-c.w / 2, -c.w * 0.3, c.w, c.w * 0.6); g.strokeRect(-c.w / 2, -c.w * 0.3, c.w, c.w * 0.6);
    }
    g.setTransform(FXD, 0, 0, FXD, 0, 0);
  }
}

// ---------- the cream overlay for a pied me ----------
const GW = 20, GH = 14;
function paintCream(o) {
  const g = o.g, W = o.W, H = o.H, r = rng((Math.random() * 1e9) | 0);
  g.setTransform(o.d, 0, 0, o.d, 0, 0); g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, W, H); g.fillStyle = CREAM; g.fillRect(0, 0, W, H);
  g.lineCap = 'round';
  const m = Math.min(W, H);
  for (let i = 0; i < 16; i++) {
    const a0 = r() * TAU;
    g.beginPath(); g.arc(r() * W, r() * H, m * (0.08 + r() * 0.2), a0, a0 + 1.5 + r() * 2.5);
    g.lineWidth = m * (0.025 + r() * 0.03); g.strokeStyle = i % 3 ? CREAM_D : '#ffffff'; g.stroke();
  }
  circ2(g, W * (0.3 + r() * 0.4), H * (0.25 + r() * 0.3), m * 0.07);
  // ragged see-through bites around the edge so the game peeks out
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 14; i++) {
    const e = (r() * 4) | 0, u = r(), q = m * (0.04 + r() * 0.07);
    g.beginPath(); g.arc(e === 0 ? 0 : e === 1 ? W : u * W, e === 2 ? 0 : e === 3 ? H : u * H, q, 0, TAU); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
}
function circ2(g, x, y, r) {   // the cherry
  g.lineWidth = Math.max(4, r * 0.16); g.strokeStyle = OUTLINE;
  g.beginPath(); g.moveTo(x, y - r * 0.8); g.quadraticCurveTo(x + r * 0.5, y - r * 1.9, x + r * 1.1, y - r * 1.7); g.stroke();
  circ(g, x, y, r, '#ff5a5f');
  g.beginPath(); g.arc(x - r * 0.3, y - r * 0.3, r * 0.22, 0, TAU); g.fillStyle = '#fff'; g.fill();
}
function startCream() {
  if (!game) return;
  if (cream) {   // pied again: fresh coat
    paintCream(cream); cream.grid.fill(0); cream.hit = 0;
    clearTimeout(cream.timer); cream.timer = setTimeout(() => endCream(true), 15000);
    return;
  }
  const c = document.createElement('canvas');
  c.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:75;touch-action:none;cursor:grab';
  const W = Math.max(1, window.innerWidth), H = Math.max(1, window.innerHeight), d = Math.min(window.devicePixelRatio || 1, 1.5);
  c.width = Math.round(W * d); c.height = Math.round(H * d);
  const o = { c, g: c.getContext('2d'), W, H, d, grid: new Uint8Array(GW * GH), hit: 0, pts: new Map(), wipeAt: 0, born: nowMs(), timer: 0, R: Math.max(40, Math.min(W, H) * 0.1) };
  paintCream(o);
  o.timer = setTimeout(() => endCream(true), 15000);
  const at = (e) => { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / (r.width || 1), y: (e.clientY - r.top) * H / (r.height || 1) }; };
  c.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { c.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
    const p = at(e); o.pts.set(e.pointerId, p); scrub(o, p.x, p.y, p.x, p.y);
  });
  c.addEventListener('pointermove', (e) => {
    const l = o.pts.get(e.pointerId); if (!l) return;
    const p = at(e); scrub(o, l.x, l.y, p.x, p.y); l.x = p.x; l.y = p.y;
  });
  const up = (e) => o.pts.delete(e.pointerId);
  c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
  game.appendChild(c);
  if (c.animate) c.animate([{ transform: 'scale(0.25)', opacity: 0.7 }, { transform: 'scale(1.07)', opacity: 1 }, { transform: 'scale(1)' }], { duration: 280, easing: 'ease-out' });
  cream = o;
}
function scrub(o, x0, y0, x1, y1) {
  if (cream !== o) return;
  const g = o.g, R = o.R;
  g.globalCompositeOperation = 'destination-out'; g.lineCap = 'round'; g.lineWidth = R * 2;
  g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1 + 0.01, y1 + 0.01); g.stroke();
  g.globalCompositeOperation = 'source-over';
  const cw = o.W / GW, ch = o.H / GH, steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (R * 0.5)));
  for (let s = 0; s <= steps; s++) {
    const x = lerp(x0, x1, s / steps), y = lerp(y0, y1, s / steps);
    const i0 = Math.max(0, Math.floor((x - R) / cw)), i1 = Math.min(GW - 1, Math.floor((x + R) / cw));
    const j0 = Math.max(0, Math.floor((y - R) / ch)), j1 = Math.min(GH - 1, Math.floor((y + R) / ch));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * GW + i; if (o.grid[k]) continue;
      const dx = (i + 0.5) * cw - x, dy = (j + 0.5) * ch - y;
      if (dx * dx + dy * dy <= R * R) { o.grid[k] = 1; o.hit++; }
    }
  }
  const n = nowMs();
  if (n - o.wipeAt > 110) { o.wipeAt = n; snd('wipe'); }
  if (o.hit >= GW * GH * 0.68) endCream(true);
}
function endCream(clean) {
  const o = cream; if (!o) return;
  cream = null; clearTimeout(o.timer);
  const c = o.c; c.style.pointerEvents = 'none';
  const kill = () => { if (c.parentNode) c.parentNode.removeChild(c); };
  if (c.animate) {
    c.animate([{ transform: 'translateY(0) rotate(0)' }, { transform: 'translateY(110%) rotate(5deg)' }], { duration: 450, easing: 'ease-in', fill: 'forwards' });
    setTimeout(kill, 470);
  } else kill();
  if (clean) { creamSuppressed = true; send({ t: 'clean' }); }
}
function tickPied() {
  const me = myPlayer();
  if (!me) { if (cream) endCream(false); return; }
  if (!me.pied) {
    creamSuppressed = false;
    if (cream && nowMs() - cream.born > 500) endCream(false);
  } else if (!cream && !creamSuppressed) {
    const f = frogs.get(state.me);
    if (f && f.incoming === 0 && T - f.piedAt > 0.2) startCream();
  }
}

// ---------- encore replay ----------
function trimLog() {
  let drop = 1000, out = 0;
  for (let i = 0; i < log.length; i++) {
    if (drop > 0 && log[i].m.t === 'n') { drop--; continue; }
    log[out++] = log[i];
  }
  log.length = out;
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP + 500);
}
function record(m) {
  const note = m.t === 'n';
  if (!note && !safe(() => isOp(m), false)) return;
  if (note) {
    if (state.replaying) return;
  } else {
    if (m.t === 'worm') return;                                  // a live thing, not part of the picture
    if (m.t === 'clear') { log.length = 0; baseline = null; return; }
  }
  const ts = typeof m.ts === 'number' && isFinite(m.ts) ? m.ts : Date.now();
  log.push({ m, ts });
  if (log.length > LOG_CAP) trimLog();
}

function startEncore() {
  if (state.replaying || enc) return;
  closeFramed();
  setArmed(false); stopHold();
  state.replaying = true;
  const final = safe(snapshot, null);
  const src = final ? log.slice() : [], n = src.length, Ts = new Float64Array(n);
  let acc = 0, prev = n ? src[0].ts : 0;
  for (let i = 0; i < n; i++) { const ts = src[i].ts; acc += clamp(ts - prev, 0, 1500); if (ts > prev) prev = ts; Ts[i] = acc; }
  let speed = Math.max(8, acc / 10000);
  if (acc / speed < 3000) speed = Math.max(1, acc / 3000);
  enc = {
    phase: n ? 'close' : 'bow', t: 0, src, Ts, idx: 0, clock: -250, speed, final, settled: false,
    wh: new Map(), whAt: new Map(), nb: 0, seed: (Math.imul(log.length + 1, 2654435761) + 97) >>> 0, whClosed: false,
  };
  ROPT.speed = speed;
  if (frBtn) { frBtn.cool = frBtn.max = 60; }
  clearTimeout(watchdog); watchdog = setTimeout(endEncore, 25000);
  setFxInput(true);
  if (n) { curTarget = 1; snd('curtain'); } else takeBow();
}
function replayNote(e, m) {
  if (m.i === 'whistle') {
    if (m.drop) { e.wh.delete(m.from); safe(() => playNote(m, CHIP)); return true; }
    const n = nowMs(), last = e.whAt.get(m.from) || 0;
    if (n - last < 70) return false;
    e.whAt.set(m.from, n); e.wh.set(m.from, m.h);
    safe(() => playNote(m, CHIP)); return true;
  }
  if (m.i === 'goose') {
    if (!m.on) return false;
    if (e.nb++ > 5) return false;
    safe(() => playNote(m, CHIP));
    const off = { ...m, on: 0 };
    setTimeout(() => safe(() => playNote(off, CHIP)), 110);
    return true;
  }
  if (e.nb++ > 5) return false;
  safe(() => playNote(m, CHIP));
  return true;
}
function settle(e) {
  if (!e.whClosed) {
    e.whClosed = true;
    for (const [from, h] of e.wh) safe(() => playNote({ t: 'n', i: 'whistle', h, drop: 1, from }, CHIP));
    e.wh.clear();
  }
  // Back to the true picture. Ops that arrived while we were watching are NOT
  // re-applied here: draw.js holds every live op while state.replaying is true
  // and paints them itself on the first tick after it goes false (i.e. on top of
  // this restore), so applying them here too would paint them twice.
  if (!e.settled) { e.settled = true; if (e.final) safe(() => restore(e.final)); }
}
function takeBow() {
  const e = enc; if (!e) return;
  e.phase = 'bow'; e.t = 0;
  snd('applause', { dur: 2.5 }); snd('tada');
  const fs = [...frogs.values()].sort((a, b) => a.slot - b.slot);
  const fall = fs.length ? Math.floor(rng(e.seed)() * fs.length) : -1;
  fs.forEach((f, i) => { f.bow = { t: -0.1 * i, fall: i === fall, hit: false, dir: f.x < CW / 2 ? 1 : -1 }; });
  spawnConfetti();
  if (cur.x > 0.01 || curTarget > 0) curTarget = 0.24;
}
function tickEncore(dt) {
  const e = enc; if (!e) return;
  e.t += dt;
  if (e.phase === 'close') {
    if (e.t > 0.7) {
      safe(() => (baseline ? restore(baseline) : blank()));
      curTarget = 0.24; e.phase = 'play'; e.t = 0;
    }
  } else if (e.phase === 'play') {
    e.clock += dt * 1000 * e.speed; e.nb = 0;
    const n = e.src.length; let budget = 400;
    while (e.idx < n && e.Ts[e.idx] <= e.clock && budget-- > 0) {
      const m = e.src[e.idx++].m, f = frogs.get(m.from);
      if (m.t === 'n') { if (replayNote(e, m) && f) noteReact(f, m); }
      else { safe(() => applyOp(m, ROPT)); if (f) drawReact(f); }
    }
    if (e.idx >= n && e.clock > (n ? e.Ts[n - 1] : 0) + 350 * e.speed) { settle(e); takeBow(); }
  } else if (e.t > 2.0) endEncore();
}
function endEncore() {
  clearTimeout(watchdog);
  const e = enc; enc = null;
  if (!e) { state.replaying = false; return; }
  settle(e);
  state.replaying = false;
  setFxInput(false); curTarget = 0;
  if (frBtn) { frBtn.cool = frBtn.max = 30; }
  showFramed();
}

// ---------- the framed picture ----------
function scEdge(g, ax, ay, bx, by, nx, ny) {
  const len = Math.hypot(bx - ax, by - ay), n = Math.max(2, Math.round(len / 92));
  for (let i = 1; i <= n; i++) {
    const m = (i - 0.5) / n, u = i / n;
    g.quadraticCurveTo(lerp(ax, bx, m) + nx * 17, lerp(ay, by, m) + ny * 17, lerp(ax, bx, u), lerp(ay, by, u));
  }
}
function composeFrame(c) {
  const g = c.getContext('2d'), W = FW, H = FH, B = FB, m = 24;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H); g.lineJoin = g.lineCap = 'round';
  g.beginPath(); g.moveTo(m, m);
  scEdge(g, m, m, W - m, m, 0, -1); scEdge(g, W - m, m, W - m, H - m, 1, 0);
  scEdge(g, W - m, H - m, m, H - m, 0, 1); scEdge(g, m, H - m, m, m, -1, 0);
  g.closePath(); g.fillStyle = GOLD; g.fill(); g.lineWidth = 10; g.strokeStyle = OUTLINE; g.stroke();
  g.lineWidth = 12; g.strokeStyle = '#e8961f'; rr(g, B * 0.52, B * 0.52, W - B * 1.04, H - B * 1.04, 20); g.stroke();
  g.lineWidth = 6; g.strokeStyle = '#fff3b0';
  g.beginPath(); g.moveTo(B * 1.5, B * 0.3); g.lineTo(B * 3.2, B * 0.3); g.moveTo(B * 3.6, B * 0.3); g.lineTo(B * 3.9, B * 0.3);
  g.moveTo(B * 0.3, B * 1.5); g.lineTo(B * 0.3, B * 2.6); g.stroke();
  // the art
  g.fillStyle = PAPER; g.fillRect(B, B, ART_W, ART_H);
  safe(() => drawFlat(g, B, B));   // pixels + googly eyes
  g.lineWidth = 10; g.strokeStyle = OUTLINE; g.strokeRect(B, B, ART_W, ART_H);
  // corner bosses with swirls
  const cs = [[B * 0.5, B * 0.5], [W - B * 0.5, B * 0.5], [W - B * 0.5, H - B * 0.5], [B * 0.5, H - B * 0.5]];
  for (let i = 0; i < 4; i++) {
    g.lineWidth = 8; circ(g, cs[i][0], cs[i][1], 32, '#ffe27a');
    g.lineWidth = 5; g.beginPath(); g.arc(cs[i][0], cs[i][1], 15, i, i + 4.4); g.stroke();
  }
  // gems
  const gems = [[W / 2, B * 0.5, 0], [W - B * 0.5, H / 2, 1], [B * 0.5, H / 2, 4]];
  for (const q of gems) {
    g.lineWidth = 7; circ(g, q[0], q[1], 19, PALETTE[q[2]]);
    g.beginPath(); g.arc(q[0] - 6, q[1] - 6, 5, 0, TAU); g.fillStyle = '#fff'; g.fill();
  }
  // a tiny frog signs the piece
  const fxp = W / 2, fy = H - B * 0.46;
  g.lineWidth = 7; circ(g, fxp - 17, fy - 22, 15, '#5ad66f'); circ(g, fxp + 17, fy - 22, 15, '#5ad66f');
  ell(g, fxp, fy, 36, 27, 0, '#5ad66f');
  googlyEye(g, fxp - 17, fy - 24, 11, 0.3, -0.5, 5); googlyEye(g, fxp + 17, fy - 24, 11, -0.3, -0.5, 5);
  g.lineWidth = 6; g.beginPath(); g.moveTo(fxp - 20, fy + 2); g.quadraticCurveTo(fxp, fy + 16, fxp + 20, fy + 2); g.stroke();
}
function sizeFramed() {
  if (!framed) return;
  const w = Math.max(120, Math.min(window.innerWidth * 0.94, (window.innerHeight - 120) * FW / FH));
  framed.pic.style.width = w + 'px'; framed.pic.style.height = (w * FH / FW) + 'px';
}
function showFramed() {
  closeFramed();
  if (!game) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:80;background:rgba(43,33,64,0.8);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;touch-action:none;overflow:hidden';
  const pic = document.createElement('canvas'); pic.width = FW; pic.height = FH;
  pic.style.cssText = 'display:block;flex:none;transform:rotate(-2.5deg)';
  composeFrame(pic);
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:18px;align-items:center;justify-content:center;flex:none';
  const dl = mkBtn('save', icoDownload), fresh = mkBtn('new page', icoCrumple), ok = mkBtn('close', icoCheck);
  for (const o of [dl, fresh, ok]) { paintBtn(o); row.appendChild(o.b); }
  dl.b.addEventListener('click', () => {
    composeFrame(pic); snd('pop');
    safe(() => pic.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = 'frog-jam.png'; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png'));
  });
  fresh.b.addEventListener('click', () => { closeFramed(); send({ t: 'clear' }); });
  ok.b.addEventListener('click', () => { snd('pop'); closeFramed(); });
  wrap.appendChild(pic); wrap.appendChild(row);
  game.appendChild(wrap);
  framed = { wrap, pic };
  sizeFramed();
  setTimeout(() => { if (framed && framed.pic === pic) composeFrame(pic); }, 150);
  if (pic.animate) {
    pic.animate([{ transform: 'rotate(-14deg) scale(0.15)' }, { transform: 'rotate(1.5deg) scale(1.08)', offset: 0.7 }, { transform: 'rotate(-2.5deg) scale(1)' }], { duration: 520, easing: 'ease-out' });
    pic.animate([{ transform: 'rotate(-2.5deg)' }, { transform: 'rotate(-0.6deg)' }], { duration: 1700, delay: 520, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' });
  }
}
function closeFramed() {
  if (!framed) return;
  const w = framed.wrap; framed = null;
  if (w.parentNode) w.parentNode.removeChild(w);
  if (!enc) state.replaying = false;
}

// ---------- bus wiring ----------
function onMsg(m) {
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
  record(m);
  const f = frogs.get(m.from);
  switch (m.t) {
    case 'n': if (f) noteReact(f, m); break;
    case 's': case 'puff': case 'eyes': if (f) drawReact(f); break;
    case 'croak': if (known(m.who)) croak(m.who); break;
    case 'pie': if (known(m.to) && okSender(m)) flingPie(m); break;
    case 'swap': if (m.map && typeof m.map === 'object' && okSender(m)) startTwister(m); break;
    case 'frame': if (okSender(m)) startEncore(); break;
    default: break;
  }
}
function layout() {
  if (cv) {
    const r = fitCanvas(cv);
    CW = r.w; CH = r.h; DPR = r.dpr;
    S = Math.max(16, Math.min(CH * 0.6, CW / 4 * 0.8)); GROUND = CH - Math.max(6, CH * 0.13); LW = clamp(S * 0.065, 2.2, 5.5);
    frogRect = cv.getBoundingClientRect();
    for (const f of frogs.values()) f.x = -1;
  }
  sizeFramed();
}
function onTick(e) {
  const dt = clamp((e && e.dt) || 0.016, 0, 0.05);
  T += dt; frameNo++;
  try { level = clamp(+getLevel() || 0, 0, 1); } catch (err) { level = 0; }
  if (cv && frameNo % 90 === 0 && Math.abs(cv.clientWidth - CW) > 1) layout();
  tickEncore(dt);
  if (framed && state.me == null) closeFramed();
  tickPied();
  updateFrogs(dt);
  if (cx && CW >= 8 && CH >= 8) drawStrip();
  tickButtons(dt);
  tickFx(dt);
}

export function init() {
  if (inited) return; inited = true;
  game = document.getElementById('game') || document.body;
  cv = document.getElementById('frogs');
  if (cv) {
    cx = cv.getContext('2d');
    cv.style.touchAction = 'none'; cv.style.cursor = 'pointer';
    cv.addEventListener('pointerdown', onFrogTap);
  }
  buildChaos();
  ensureFx();
  bus.on('msg', onMsg);
  bus.on('players', onPlayers);
  bus.on('layout', layout);
  bus.on('tick', onTick);
  bus.on('joined', (e) => {
    const room = (e && e.room) || state.room;
    if (room !== lastRoom) { lastRoom = room; closeFramed(); if (cream) endCream(false); }
    log.length = 0; baseline = safe(snapshot, null);
  });
  bus.on('synced', () => { baseline = safe(snapshot, null); log.length = 0; });
  // The synced picture decodes a moment after 'synced': that is the real starting
  // point for my encore replay (anything logged since then is not painted yet).
  bus.on('artsync', () => { if (!state.replaying) baseline = safe(snapshot, null); });
  layout(); onPlayers();
}
