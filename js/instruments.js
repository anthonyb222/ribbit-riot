// FROG JAM — the four playable cartoon instruments, the picker, and drawIcon().
// This module never makes sound: it send()s the note messages and animates from
// the bus 'msg' handler (my own notes only), so the picture always matches what was sent.
import {
  bus, state, send, myPlayer, INSTRUMENTS, OUTLINE, PAPER, PALETTE,
  clamp, lerp, spring, googlyEye, fitCanvas,
} from './bus.js';

const TAU = Math.PI * 2;
const now = () => performance.now();

// wall + floor colour per instrument
const STAGE = {
  goose: ['#c4ecff', '#8ddb7c'],
  whistle: ['#ffe2ad', '#f4a261'],
  bonk: ['#ffd3e2', '#c9895a'],
  belly: ['#dccbff', '#9d8cf0'],
};

// ---------- canvas ----------
let canvas = null, ctx = null;
let W = 0, H = 0, dpr = 1, LW = 5;
let time = 0, sizeCheck = 0, wasReplaying = false;

let cur = null;                       // instrument on stage
let out = null;                       // {inst, t, dir} the one flying off
const drop = { x: 0, v: 0 };          // drop-in offset (1 = above the panel)
const shake = { x: 0, v: 0 };
const look = { x: 0, y: 0, on: false };
let LX = 0, LY = 0;

// ---------- instrument animation state ----------
const geese = Array.from({ length: 5 }, () => ({
  on: false, creep: 0, hx: 0, hy: 0,
  n: { x: 0, v: 0 }, w: { x: 0, v: 0 }, o: { x: 0, v: 0 },
}));
const guy = {
  st: 'idle', h: 0.04, x: 0, y: 0, placed: false, vx: 0,
  t: 0, t0: 0, dur: 1, p: 0, pp: 0, sx: 0, sy: 0, lx: 0, spin: 1,
  leg: { x: 0, v: 0 },
};
const HEAD_SCALE = [1.25, 1, 0.72, 0.95];
const HEAD_COL = ['#6fb8ff', '#ffd45e', '#ff7a7e', '#6fdc82'];
const heads = Array.from({ length: 4 }, () => ({ hit: 99, s: { x: 1, v: 0 } }));
const belly = { age: 99, px: 0.5, k: 2, dent: { x: 0, v: 0 }, j: { x: 0, v: 0 } };

// ---------- input state ----------
const ptrs = new Map();               // pointerId -> {k}
const gooseHold = [0, 0, 0, 0, 0];    // how many fingers/keys hold each goose
const keysDown = new Set();
const wh = { drag: false, pid: null, h: 0, sentH: -1, sentAt: 0 };
let pokeFrac = null;                  // exact local poke position for the belly dent

const GOOSE_KEYS = { KeyQ: 0, KeyW: 1, KeyE: 2, KeyR: 3, KeyT: 4 };
const BONK_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3 };
const BELLY_KEYS = { KeyZ: 0, KeyX: 1, KeyC: 2, KeyV: 3, KeyB: 4 };
const keyOf = (map, code) => (Object.prototype.hasOwnProperty.call(map, code) ? map[code] : -1);

// ---------- small drawing helpers ----------
function fs(c, fill, lw = LW) {
  c.fillStyle = fill; c.fill();
  c.lineWidth = lw; c.strokeStyle = OUTLINE; c.stroke();
}
function rr(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function starPath(c, x, y, r, rot) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = rot + i * Math.PI / 5, q = i % 2 ? r * 0.45 : r;
    const px = x + Math.cos(a) * q, py = y + Math.sin(a) * q;
    if (i) c.lineTo(px, py); else c.moveTo(px, py);
  }
  c.closePath();
}
function spiralEye(c, x, y, r, rot, lw) {
  c.beginPath(); c.arc(x, y, r, 0, TAU); fs(c, '#fff', lw);
  c.beginPath();
  for (let i = 0; i <= 14; i++) {
    const a = rot + i * 0.9, q = r * 0.78 * i / 14;
    const px = x + Math.cos(a) * q, py = y + Math.sin(a) * q;
    if (i) c.lineTo(px, py); else c.moveTo(px, py);
  }
  c.lineWidth = lw * 0.7; c.strokeStyle = OUTLINE; c.stroke();
}
function limb(c, x0, y0, x1, y1, w) {
  c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1);
  c.lineWidth = w; c.strokeStyle = OUTLINE; c.stroke();
}
function lookAt(x, y) {
  if (!look.on) { LX = 0; LY = 0; return; }
  const dx = look.x - x, dy = look.y - y, d = Math.hypot(dx, dy) || 1, m = Math.min(1, d / (H * 0.5 + 1));
  LX = dx / d * m; LY = dy / d * m;
}
const easeOut = (q) => 1 - (1 - q) * (1 - q);
const easeOutBack = (q) => { const k = 2.2, u = q - 1; return 1 + (k + 1) * u * u * u + k * u * u; };

// ---------- particles (cosmetic, my panel only) ----------
const parts = [];
function part(kind, x, y, vx, vy, life, size) {
  if (parts.length >= 90) return;
  parts.push({ kind, x, y, vx, vy, life, max: life, size, rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 12 });
}
function updateParts(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life -= dt;
    if (p.life <= 0) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
    if (p.kind === 'feather') { p.vy += H * 0.9 * dt; p.vx *= 1 - Math.min(1, 2.5 * dt); p.vy *= 1 - Math.min(1, 2 * dt); }
    else if (p.kind === 'dust') { p.vx *= 1 - Math.min(1, 3 * dt); p.vy *= 1 - Math.min(1, 3 * dt); p.size += H * 0.05 * dt; }
    else p.vy += H * 4 * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
  }
}
function drawParts(c) {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    c.globalAlpha = clamp(p.life / (p.max * 0.35), 0, 1);
    if (p.kind === 'feather') {
      c.beginPath(); c.ellipse(p.x, p.y, p.size, p.size * 0.4, p.rot, 0, TAU); fs(c, '#fff', LW * 0.55);
    } else if (p.kind === 'star') {
      starPath(c, p.x, p.y, p.size, p.rot); fs(c, '#ffc93c', LW * 0.6);
    } else if (p.kind === 'dust') {
      c.beginPath(); c.arc(p.x, p.y, p.size, 0, TAU); fs(c, PAPER, LW * 0.6);
    } else {
      c.beginPath(); c.arc(p.x, p.y, p.size, 0, TAU); fs(c, '#7fd0ff', LW * 0.5);
    }
  }
  c.globalAlpha = 1;
}

// =====================================================================
// 1. HONK GOOSE CHOIR
// =====================================================================
function gooseVis(k, on) {
  const g = geese[k];
  if (g.on === on) return;
  g.on = on;
  if (on) {
    g.n.v += 5; g.w.v += (Math.random() - 0.5) * 3;
    const u = H / 150;
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * TAU, sp = (60 + Math.random() * 110) * u;
      part('feather', g.hx, g.hy + 14 * u, Math.cos(a) * sp, Math.sin(a) * sp - 60 * u, 0.7 + Math.random() * 0.5, (3.5 + Math.random() * 2.5) * u);
    }
  } else {
    g.w.v += (Math.random() < 0.5 ? -1 : 1) * 7;
  }
}
function updateGeese(dt) {
  for (let k = 0; k < 5; k++) {
    const g = geese[k];
    if (g.on) { spring(g.n, 1, dt, 420, 17); g.creep = Math.min(1, g.creep + dt * 0.45); }
    else { spring(g.n, 0, dt, 130, 5.5); g.creep *= Math.exp(-dt * 12); }
    spring(g.w, 0, dt, 95, 4.2);
    spring(g.o, g.on ? 1 : 0, dt, 320, 15);
  }
}
function drawGeese(c) {
  const colW = W / 5, fy = H * 0.88, s = Math.min(colW * 0.95, H * 0.7);
  const hr = s * 0.15, nw = s * 0.11, brx = s * 0.3, bry = s * 0.2, bl = hr * 1.35;
  const keepLW = LW;
  LW = clamp(s * 0.05, 2.5, keepLW);      // five small geese on a phone: keep the outline in proportion
  for (let k = 0; k < 5; k++) {
    const g = geese[k], cx = colW * (k + 0.5);
    const bx = cx - s * 0.08, by = fy - bry - s * 0.05;
    const nx = bx + brx * 0.5, ny = by - bry * 0.5;
    const rest = s * 0.06 + H * 0.035 * k;
    const maxLen = Math.max(rest + s * 0.2, ny - hr * 0.5 - (hr + LW + 2));
    const len = Math.max(s * 0.02, rest + (maxLen - rest) * (0.72 * g.n.x + 0.28 * g.creep));
    const open = clamp(g.o.x, 0, 1.3);
    const jit = g.on ? Math.sin(time * 70 + k) * s * 0.012 : 0;
    const hx = nx + s * 0.04 + g.w.x * s * 0.22 + jit, hy = ny - len - hr * 0.5;
    g.hx = hx; g.hy = hy;

    // legs + feet
    limb(c, bx - brx * 0.3, by, bx - brx * 0.3, fy, LW);
    limb(c, bx + brx * 0.2, by, bx + brx * 0.2, fy, LW);
    c.beginPath(); c.ellipse(bx - brx * 0.22, fy, s * 0.075, s * 0.032, 0, 0, TAU); fs(c, '#ff9f1c', LW * 0.8);
    c.beginPath(); c.ellipse(bx + brx * 0.28, fy, s * 0.075, s * 0.032, 0, 0, TAU); fs(c, '#ff9f1c', LW * 0.8);
    // tail
    const wag = open * Math.sin(time * 45 + k) * bry * 0.25;
    c.beginPath();
    c.moveTo(bx - brx * 0.8, by - bry * 0.35);
    c.lineTo(bx - brx * 1.4, by - bry * 0.95 + wag);
    c.lineTo(bx - brx * 0.7, by + bry * 0.25);
    c.closePath(); fs(c, '#fff');
    // neck outline (behind the body)
    const kx = nx - g.w.x * s * 0.2, ky = (ny + hy) / 2;
    c.beginPath(); c.moveTo(nx, ny + bry * 0.35); c.quadraticCurveTo(kx, ky, hx - hr * 0.15, hy + hr * 0.3);
    c.lineWidth = nw + LW * 2; c.strokeStyle = OUTLINE; c.stroke();
    // body
    c.beginPath(); c.ellipse(bx, by, brx, bry * (1 - 0.08 * open), 0, 0, TAU); fs(c, '#fff');
    // neck fill (joins the body)
    c.beginPath(); c.moveTo(nx, ny + bry * 0.35); c.quadraticCurveTo(kx, ky, hx - hr * 0.15, hy + hr * 0.3);
    c.lineWidth = nw; c.strokeStyle = '#fff'; c.stroke();
    // wing (flaps in outrage)
    c.save();
    c.translate(bx + brx * 0.15, by - bry * 0.05);
    c.rotate(-open * 0.7 + (g.on ? Math.sin(time * 50 + k) * 0.35 : 0));
    c.beginPath(); c.ellipse(-brx * 0.4, bry * 0.12, brx * 0.48, bry * 0.42, 0.15, 0, TAU); fs(c, '#e8eef4', LW * 0.8);
    c.restore();
    // collar
    c.beginPath(); c.ellipse(nx + (kx - nx) * 0.1, ny - bry * 0.1, nw * 0.85, nw * 0.42, 0, 0, TAU); fs(c, PALETTE[k], LW * 0.8);

    // beak
    c.save();
    c.translate(hx + hr * 0.6, hy + hr * 0.15);
    if (open > 0.05) {
      c.beginPath(); c.moveTo(-hr * 0.2, 0);
      c.lineTo(Math.cos(-open * 0.6) * bl * 0.9, Math.sin(-open * 0.6) * bl * 0.9);
      c.lineTo(Math.cos(open * 0.5) * bl * 0.8, Math.sin(open * 0.5) * bl * 0.8);
      c.closePath(); fs(c, '#a3243b', LW * 0.8);
      c.beginPath(); c.arc(bl * 0.34, bl * 0.03, hr * 0.2 * Math.min(1, open), 0, TAU); c.fillStyle = '#ff8fa3'; c.fill();
    }
    c.save(); c.rotate(-open * 0.6);
    c.beginPath(); c.moveTo(-hr * 0.3, -hr * 0.45); c.quadraticCurveTo(bl * 0.6, -hr * 0.48, bl, 0); c.lineTo(-hr * 0.2, hr * 0.03); c.closePath();
    fs(c, '#ff9f1c', LW * 0.8); c.restore();
    c.save(); c.rotate(open * 0.5);
    c.beginPath(); c.moveTo(-hr * 0.2, 0); c.lineTo(bl * 0.86, 0); c.quadraticCurveTo(bl * 0.4, hr * 0.4, -hr * 0.3, hr * 0.32); c.closePath();
    fs(c, '#f08a00', LW * 0.8); c.restore();
    // honk lines
    if (open > 0.6) {
      c.lineWidth = LW * 0.8; c.strokeStyle = OUTLINE;
      for (let i = -1; i <= 1; i++) {
        const a = i * 0.5 - 0.05, r0 = bl * 1.45, r1 = r0 + hr * (0.55 + 0.35 * Math.sin(time * 30 + i * 2 + k));
        c.beginPath(); c.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); c.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); c.stroke();
      }
    }
    c.restore();
    // head
    c.beginPath(); c.arc(hx, hy, hr, 0, TAU); fs(c, '#fff');
    // eye
    const er = hr * (0.44 + 0.3 * Math.min(1, open)), ex = hx + hr * 0.12, ey = hy - hr * 0.25 - open * hr * 0.3;
    if (g.on) { LX = Math.sin(time * 41 + k) * 0.7; LY = Math.cos(time * 33 + k) * 0.7; } else lookAt(ex, ey);
    googlyEye(c, ex, ey, er, LX, LY, LW * 0.75);
    if (open > 0.3) limb(c, ex - er * 1.1, ey - er * 1.35, ex + er * 0.95, ey - er * 0.75, LW);
  }
  LW = keepLW;
}

// =====================================================================
// 2. SLIDE WHISTLE FALL GUY
// =====================================================================
const PG = { bx: 0, tx: 0, ty: 0, fy: 0, gr: 0, ux: 0, uy: -1, len: 1, dx: 0 };
function poleGeom() {
  const P = PG;
  P.fy = H * 0.86; P.gr = clamp(H * 0.11, 13, 26);
  P.dx = clamp(W - H * 1.3, 0, W * 0.7);
  P.bx = (W - P.dx) / 2; P.tx = (W + P.dx) / 2; P.ty = P.gr * 1.2 + LW;
  const vx = P.tx - P.bx, vy = P.ty - P.fy;
  P.len = Math.hypot(vx, vy) || 1; P.ux = vx / P.len; P.uy = vy / P.len;
  return P;
}
function whistleHAt(x, y) {
  const P = poleGeom();
  const t = ((x - P.bx) * P.ux + (y - P.fy) * P.uy) / P.len;
  return clamp((t - 0.08) / 0.84, 0, 1);
}
const r3 = (v) => Math.round(v * 1000) / 1000;
function sendWhistle(force) {
  const t = now();
  if (!force && (t - wh.sentAt < 66 || Math.abs(wh.h - wh.sentH) < 0.002)) return;
  wh.sentAt = t; wh.sentH = wh.h;
  send({ t: 'n', i: 'whistle', h: r3(wh.h), on: 1 });
}
function startWhistle(pid, h) {
  wh.drag = true; wh.pid = pid; wh.h = h;
  sendWhistle(true);
}
function dropWhistle() {
  if (!wh.drag) return;
  wh.drag = false; wh.pid = null;
  send({ t: 'n', i: 'whistle', h: r3(wh.h), drop: 1 });
}
function guyHeld(h) {
  guy.h = h; guy.st = 'held';
}
function guyDrop(h) {
  const P = poleGeom(), g = guy;
  if (g.st !== 'held') { g.h = h; placeGuy(P); }
  g.h = h; g.st = 'fall'; g.t0 = now(); g.dur = 0.35 + 0.55 * h; g.p = 0; g.pp = 0;
  g.sx = g.x; g.sy = g.y;
  g.lx = clamp(lerp(g.x, P.bx, 0.45) + (P.dx < P.gr * 3 ? P.gr * 2.4 : 0), P.gr * 2, Math.max(P.gr * 2, W - P.gr * 2));
  g.spin = g.lx < g.x ? -1 : 1;
}
function placeGuy(P) {
  const tt = (0.08 + 0.84 * guy.h) * P.len;
  guy.x = P.bx + P.ux * tt + P.uy * P.gr * 0.85;
  guy.y = P.fy + P.uy * tt - P.ux * P.gr * 0.85;
  guy.placed = true;
}
function landGuy(P) {
  const g = guy, u = H / 150;
  g.st = 'flat'; g.t = 0; g.x = g.lx; g.y = P.fy - P.gr * 0.3;
  shake.v += H * 1.3;
  for (let i = 0; i < 8; i++) {
    const d = i < 4 ? -1 : 1, sp = (50 + Math.random() * 120) * u;
    part('dust', g.lx + d * P.gr, P.fy - 2, d * sp, -Math.random() * 40 * u, 0.5 + Math.random() * 0.3, (4 + Math.random() * 4) * u);
  }
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI * (0.15 + 0.7 * Math.random()), sp = (150 + Math.random() * 130) * u;
    part('star', g.lx, P.fy - P.gr, Math.cos(a) * sp, Math.sin(a) * sp, 0.6 + Math.random() * 0.3, (5 + Math.random() * 3) * u);
  }
}
function updateGuy(dt) {
  const g = guy, P = poleGeom();
  if (!g.placed) placeGuy(P);
  if (g.st === 'fall') {
    const p = clamp((now() - g.t0) / (g.dur * 1000), 0, 1);
    const hf = g.dur > 0.5 ? 0.16 : 0;                 // a beat of hanging in mid-air first
    const pp = hf ? clamp((p - hf) / (1 - hf), 0, 1) : p;
    g.p = p; g.pp = pp;
    g.x = lerp(g.sx, g.lx, pp); g.y = lerp(g.sy, P.fy - P.gr * 0.3, pp * pp);
    if (p >= 1) landGuy(P);
  } else if (g.st === 'flat') {
    g.t += dt; g.x = g.lx;
    if (g.t >= 1.45) { g.st = 'idle'; g.h = 0.04; g.y = P.fy - P.gr; }
  } else {
    const tt = (0.08 + 0.84 * g.h) * P.len;
    const tx = P.bx + P.ux * tt + P.uy * P.gr * 0.85, ty = P.fy + P.uy * tt - P.ux * P.gr * 0.85;
    const k = 1 - Math.exp(-(g.st === 'held' ? 24 : 5) * dt), px = g.x;
    g.x += (tx - g.x) * k; g.y += (ty - g.y) * k;
    g.vx = dt > 0 ? (g.x - px) / dt : 0;
    spring(g.leg, clamp(-g.vx / (P.gr * 30), -1, 1), dt, 90, 6);
    if (g.st === 'held' && g.h > 0.45 && Math.random() < dt * 9 * g.h) {
      part('sweat', g.x + (Math.random() - 0.5) * P.gr * 1.6, g.y - P.gr * 0.6, (Math.random() - 0.5) * 60, -70 * (H / 150), 0.5, P.gr * 0.14);
    }
  }
}
function guyBody(c, gr, kx, ky, fear, lx, ly, open, dizzy) {
  c.beginPath(); c.ellipse(0, 0, gr * kx, gr * ky, 0, 0, TAU); fs(c, '#b46bff');
  const er = gr * (0.3 + 0.15 * fear), ex = gr * 0.4 * Math.sqrt(kx), ey = -gr * 0.22 * Math.min(1, ky * 1.4);
  if (dizzy) { spiralEye(c, -ex, ey, er, time * 9, LW * 0.7); spiralEye(c, ex, ey, er, -time * 9, LW * 0.7); }
  else { googlyEye(c, -ex, ey, er, lx, ly, LW * 0.7); googlyEye(c, ex, ey, er, lx, ly, LW * 0.7); }
  const my = gr * 0.52 * ky;
  if (open > 0.12) {
    c.beginPath(); c.ellipse(0, my, gr * 0.22, gr * 0.3 * open * Math.min(1, ky * 1.3), 0, 0, TAU);
    c.fillStyle = '#5b1a3a'; c.fill(); c.lineWidth = LW * 0.6; c.strokeStyle = OUTLINE; c.stroke();
  } else {
    c.beginPath(); c.moveTo(-gr * 0.26, my);
    c.quadraticCurveTo(-gr * 0.13, my - gr * 0.12, 0, my); c.quadraticCurveTo(gr * 0.13, my + gr * 0.12, gr * 0.26, my);
    c.lineWidth = LW * 0.7; c.strokeStyle = OUTLINE; c.stroke();
  }
}
function drawWhistle(c) {
  const P = poleGeom(), g = guy, gr = P.gr;
  // mound + pole + knob
  c.beginPath(); c.ellipse(P.bx, P.fy, gr * 1.15, gr * 0.36, 0, 0, TAU); fs(c, '#8a6a4f');
  c.beginPath(); c.moveTo(P.bx, P.fy); c.lineTo(P.tx, P.ty);
  c.lineWidth = gr * 0.42 + LW * 2; c.strokeStyle = OUTLINE; c.stroke();
  c.lineWidth = gr * 0.42; c.strokeStyle = '#d5dde8'; c.stroke();
  c.lineWidth = LW * 0.6; c.strokeStyle = OUTLINE;
  for (let i = 1; i < 8; i++) {
    const tt = (0.08 + 0.84 * i / 8) * P.len, x = P.bx + P.ux * tt, y = P.fy + P.uy * tt, q = gr * 0.21;
    c.beginPath(); c.moveTo(x - P.uy * q, y + P.ux * q); c.lineTo(x + P.uy * q, y - P.ux * q); c.stroke();
  }
  c.beginPath(); c.arc(P.tx, P.ty, gr * 0.44, 0, TAU); fs(c, '#ff5a5f');

  if (g.st === 'fall') {
    const hang = g.pp <= 0;
    c.save(); c.translate(g.x, g.y); c.rotate(g.spin * g.pp * TAU * 1.5);
    for (let i = 0; i < 4; i++) {
      const base = (i < 2 ? -1 : 1) * (i % 2 ? 2.3 : 0.75);
      const a = base + Math.sin(time * (hang ? 55 : 38) + i * 1.7) * 0.7, L = gr * 1.7;
      limb(c, 0, 0, Math.cos(a) * L, Math.sin(a) * L, LW);
      c.beginPath(); c.arc(Math.cos(a) * L, Math.sin(a) * L, gr * 0.2, 0, TAU); fs(c, '#b46bff', LW * 0.6);
    }
    guyBody(c, gr, 1 - 0.1 * g.pp, 1 + 0.12 * g.pp, 1, hang ? 0 : Math.sin(time * 30), hang ? 0 : 0.8, hang ? 0.5 : 1, false);
    c.restore();
    return;
  }
  if (g.st === 'flat') {
    const q = clamp((g.t - 0.45) / 1.0, 0, 1);
    const ky = lerp(0.22, 1, easeOutBack(q)), kx = lerp(1.9, 1, easeOut(q));
    const cy = P.fy - gr * ky;
    g.y = cy;
    c.save(); c.translate(g.lx, cy);
    if (q > 0.55) {
      const a = (q - 0.55) / 0.45;
      limb(c, -gr * kx * 0.8, 0, -gr * (kx + 0.6 * a), gr * 0.5 * a, LW);
      limb(c, gr * kx * 0.8, 0, gr * (kx + 0.6 * a), gr * 0.5 * a, LW);
    }
    guyBody(c, gr, kx, ky, 0.4, 0, -0.3, 0, q < 0.7);
    c.restore();
    if (q < 0.8) {
      c.globalAlpha = clamp((0.8 - q) / 0.2, 0, 1);
      for (let i = 0; i < 3; i++) {
        const a = time * 6 + i * TAU / 3;
        starPath(c, g.lx + Math.cos(a) * gr * 1.1, cy - gr * (ky + 0.75) + Math.sin(a) * gr * 0.25, gr * 0.3, a);
        fs(c, '#ffc93c', LW * 0.6);
      }
      c.globalAlpha = 1;
    }
    return;
  }
  // clinging / being dragged / waddling back to the pole
  const held = g.st === 'held', fear = held ? 0.35 + 0.65 * g.h : 0.12;
  const tg = clamp(((g.x - P.bx) * P.ux + (g.y - P.fy) * P.uy) / P.len, 0, 1) * P.len;
  const qx = P.bx + P.ux * tg, qy = P.fy + P.uy * tg;
  const dist = Math.hypot(g.x - qx, g.y - qy), near = dist < gr * 1.5;
  const hop = !held && !near ? Math.abs(Math.sin(time * 16)) * gr * 0.5 : 0;
  const x = g.x + Math.sin(time * 57) * gr * 0.05 * fear, y = g.y - hop;
  for (let i = -1; i <= 1; i += 2) {
    const lx0 = x + i * gr * 0.35, ly0 = y + gr * 0.75, L = gr * 0.8;
    const a = Math.PI / 2 + g.leg.x * 0.9 + i * 0.15 + (held ? Math.sin(time * 21 + i) * 0.3 * fear : (near ? 0 : Math.sin(time * 16 + i * 1.5) * 0.6));
    limb(c, lx0, ly0, lx0 + Math.cos(a) * L, ly0 + Math.sin(a) * L, LW);
    c.beginPath(); c.arc(lx0 + Math.cos(a) * L, ly0 + Math.sin(a) * L, gr * 0.17, 0, TAU); c.fillStyle = OUTLINE; c.fill();
  }
  if (near) for (let i = -1; i <= 1; i += 2) limb(c, x, y, qx + P.ux * i * gr * 0.75, qy + P.uy * i * gr * 0.75, LW);
  else for (let i = -1; i <= 1; i += 2) limb(c, x, y, x + i * gr * 1.35, y + gr * 0.35, LW);
  c.save(); c.translate(x, y); c.rotate(clamp(g.vx / (gr * 45), -0.45, 0.45));
  guyBody(c, gr, 1, 1, fear, -P.ux * 0.5, held ? 0.9 : 0.2, held ? 0.25 + 0.75 * g.h : 0, false);
  c.restore();
  if (near) for (let i = -1; i <= 1; i += 2) {
    c.beginPath(); c.arc(qx + P.ux * i * gr * 0.75, qy + P.uy * i * gr * 0.75, gr * 0.24, 0, TAU); fs(c, '#b46bff', LW * 0.7);
  }
}

// =====================================================================
// 3. BONK HEADS
// =====================================================================
function bonkVis(k) {
  const hd = heads[k], u = H / 150;
  hd.hit = 0; hd.s.v = -13;
  shake.v += H * 0.5;
  const colW = W / 4, cx = colW * (k + 0.5), r = Math.min(colW * 0.36, H * 0.26) * HEAD_SCALE[k];
  for (let i = 0; i < 4; i++) {
    const a = -Math.PI * (0.1 + 0.8 * Math.random()), sp = (140 + Math.random() * 120) * u;
    part('star', cx, H * 0.79 - r * 1.3, Math.cos(a) * sp, Math.sin(a) * sp, 0.5 + Math.random() * 0.3, (4.5 + Math.random() * 3) * u);
  }
}
function updateHeads(dt) {
  for (let k = 0; k < 4; k++) {
    const hd = heads[k];
    hd.hit += dt;
    const q = clamp((hd.hit - 0.9) / 1.3, 0, 1);
    const target = hd.hit < 0.9 ? 0.5 : lerp(0.5, 1, q * q * (3 - 2 * q));
    spring(hd.s, target, dt, 260, 11);
  }
}
function drawHat(c, k, r, top) {
  if (k === 0) {                                      // nightcap
    const droop = Math.sin(time * 2) * r * 0.05;
    c.beginPath(); c.moveTo(-r * 0.78, top + r * 0.3);
    c.quadraticCurveTo(-r * 0.35, top - r * 0.8, r * 0.95, top + r * 0.05 + droop);
    c.quadraticCurveTo(r * 0.45, top - r * 0.05, r * 0.78, top + r * 0.3);
    c.closePath(); fs(c, '#b46bff');
    rr(c, -r * 0.86, top + r * 0.18, r * 1.72, r * 0.26, r * 0.13); fs(c, '#fff');
    c.beginPath(); c.arc(r * 0.95, top + r * 0.08 + droop, r * 0.17, 0, TAU); fs(c, '#fff');
  } else if (k === 1) {                               // crash helmet
    c.beginPath(); c.arc(0, top + r * 0.42, r * 1.04, Math.PI, 0); c.closePath(); fs(c, '#b9c7cf');
    rr(c, -r * 1.16, top + r * 0.33, r * 2.32, r * 0.2, r * 0.1); fs(c, '#8fa3ad');
    starPath(c, 0, top - r * 0.12, r * 0.2, -Math.PI / 2); fs(c, '#ff5a5f', LW * 0.6);
  } else if (k === 2) {                               // tiny top hat
    rr(c, -r * 0.45, top - r * 0.85, r * 0.9, r * 0.9, r * 0.08); fs(c, '#4a3f6b');
    c.fillStyle = '#ff5a5f'; c.fillRect(-r * 0.45, top - r * 0.3, r * 0.9, r * 0.17);
    rr(c, -r * 0.78, top - r * 0.06, r * 1.56, r * 0.22, r * 0.11); fs(c, '#4a3f6b');
  } else {                                            // fez
    c.beginPath(); c.moveTo(-r * 0.48, top + r * 0.05); c.lineTo(-r * 0.33, top - r * 0.55);
    c.lineTo(r * 0.33, top - r * 0.55); c.lineTo(r * 0.48, top + r * 0.05); c.closePath(); fs(c, '#ff5a5f');
    const sw = Math.sin(time * 3) * r * 0.06;
    c.beginPath(); c.moveTo(0, top - r * 0.55); c.quadraticCurveTo(r * 0.5, top - r * 0.7, r * 0.62 + sw, top - r * 0.2);
    c.lineWidth = LW * 0.7; c.strokeStyle = OUTLINE; c.stroke();
    c.beginPath(); c.arc(r * 0.62 + sw, top - r * 0.15, r * 0.1, 0, TAU); fs(c, '#ffc93c', LW * 0.6);
  }
}
function drawHead(c, k, r, hd, dizzy, annoy) {
  const cy = -r * 0.72, sq = k === 3, top = cy - r * (sq ? 0.9 : 1);
  const bump = annoy ? clamp(1 - (hd.hit - 0.9) / 1.7, 0, 1) : (dizzy ? clamp(hd.hit / 0.3, 0, 1) : 0);
  // sore lump
  if (bump > 0.02) { c.beginPath(); c.arc(r * 0.42, top + r * 0.12, r * 0.3 * bump, 0, TAU); fs(c, '#ff8fa3', LW * 0.8); }
  if (sq) rr(c, -r * 0.9, cy - r * 0.9, r * 1.8, r * 1.8, r * 0.28);
  else { c.beginPath(); c.arc(0, cy, r, 0, TAU); }
  fs(c, HEAD_COL[k]);
  // hat (knocked askew)
  c.save(); c.translate(0, top + r * 0.2); c.rotate(-0.38 * bump); c.translate(0, -(top + r * 0.2));
  drawHat(c, k, r, top);
  c.restore();

  const er = r * [0.26, 0.3, 0.32, 0.2][k], ex = r * 0.38, ey = cy + r * (sq ? 0.0 : 0.05), elw = LW * 0.75;
  const my = cy + r * 0.52;
  c.strokeStyle = OUTLINE;
  if (dizzy) {
    spiralEye(c, -ex, ey, er, time * 10, elw); spiralEye(c, ex, ey, er, -time * 10, elw);
    c.beginPath(); c.moveTo(-r * 0.3, my);
    c.quadraticCurveTo(-r * 0.15, my - r * 0.14, 0, my); c.quadraticCurveTo(r * 0.15, my + r * 0.14, r * 0.3, my);
    c.lineWidth = elw; c.stroke();
    c.beginPath(); c.ellipse(r * 0.14, my + r * 0.12, r * 0.1, r * 0.14, 0, 0, TAU); fs(c, '#ff8fa3', LW * 0.6);
    return;
  }
  if (annoy) {
    googlyEye(c, -ex, ey, er, 0.5, -0.8, elw); googlyEye(c, ex, ey, er, 0.5, -0.8, elw);
    limb(c, -ex - er * 1.2, ey - er * 1.35, -ex + er * 0.95, ey - er * 0.45, LW);
    limb(c, ex + er * 1.2, ey - er * 1.35, ex - er * 0.95, ey - er * 0.45, LW);
    c.beginPath(); c.arc(0, my + r * 0.28, r * 0.3, Math.PI * 1.2, Math.PI * 1.8); c.lineWidth = LW * 0.9; c.stroke();
    return;
  }
  if (k === 0) {                                      // big sleepy one
    for (let i = -1; i <= 1; i += 2) {
      googlyEye(c, i * ex, ey, er, 0, 0.9, elw);
      c.beginPath(); c.arc(i * ex, ey, er, Math.PI * 0.95, Math.PI * 0.05); c.closePath(); fs(c, HEAD_COL[0], elw);
    }
    c.beginPath(); c.ellipse(0, my, r * 0.1, r * 0.07, 0, 0, TAU); c.fillStyle = OUTLINE; c.fill();
    c.beginPath(); c.arc(r * 0.24, my - r * 0.1, r * 0.13 * (1 + 0.55 * Math.sin(time * 1.7)), 0, TAU); fs(c, '#e4f6ff', LW * 0.6);
  } else if (k === 1) {                               // nervous one
    const d = Math.sin(time * 5) > 0 ? 0.8 : -0.8;
    googlyEye(c, -ex, ey, er, d, 0.2, elw); googlyEye(c, ex, ey, er, d, 0.2, elw);
    c.beginPath();
    for (let i = 0; i <= 6; i++) {
      const x = -r * 0.3 + r * 0.1 * i, y = my + (i % 2 ? -1 : 1) * r * 0.05;
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
    }
    c.lineWidth = elw; c.stroke();
    const sl = (time * 0.6) % 1;
    c.globalAlpha = 1 - sl;
    c.beginPath(); c.arc(r * 0.78, cy - r * 0.2 + sl * r * 0.5, r * 0.09, 0, TAU); fs(c, '#7fd0ff', LW * 0.6);
    c.globalAlpha = 1;
  } else if (k === 2) {                               // tiny smug one
    const a = Math.sin(time * 0.8) * 0.5;
    googlyEye(c, -ex, ey, er, a, 0.1, elw); googlyEye(c, ex, ey, er, a, 0.1, elw);
    c.beginPath(); c.arc(0, my - r * 0.18, r * 0.3, Math.PI * 0.15, Math.PI * 0.85); c.lineWidth = elw; c.stroke();
  } else {                                            // square one
    googlyEye(c, -ex, ey, er, 0, 0, elw); googlyEye(c, ex, ey, er, 0, 0, elw);
    limb(c, -r * 0.62, ey - er * 1.5, r * 0.62, ey - er * 1.5, LW * 1.1);
    limb(c, -r * 0.28, my, r * 0.28, my, LW * 0.9);
  }
}
function drawBonk(c) {
  const colW = W / 4, holeY = H * 0.79, hs = Math.min(colW * 0.31, H * 0.26);   // the biggest head (x1.25) must fit its column
  for (let k = 0; k < 4; k++) {
    const hd = heads[k], r = hs * HEAD_SCALE[k], cx = colW * (k + 0.5);
    const sy = clamp(hd.s.x, 0.22, 1.3), sx = 1 + (1 - sy) * 0.6;
    const dizzy = hd.hit < 0.9, annoy = !dizzy && hd.hit < 2.6;
    const hrx = r * 1.2, hry = Math.max(r * 0.2, 5);
    c.beginPath(); c.ellipse(cx, holeY, hrx, hry, 0, 0, TAU); fs(c, '#3a2418');
    c.save();
    c.beginPath();
    c.rect(cx - colW, -H * 2, colW * 2, holeY + H * 2);
    c.ellipse(cx, holeY, hrx - LW * 0.5, Math.max(1, hry - LW * 0.5), 0, 0, TAU);
    c.clip();
    const tremble = k === 1 && !dizzy ? Math.sin(time * 47) * r * 0.03 : 0;
    const bob = dizzy ? 0 : Math.sin(time * 1.5 + k * 1.3) * r * 0.03;
    c.translate(cx + tremble, holeY + (1 - sy) * r * 0.25 + bob);
    c.scale(sx, sy);
    drawHead(c, k, r, hd, dizzy, annoy);
    c.restore();
    c.beginPath(); c.ellipse(cx, holeY, hrx, hry, 0, 0, Math.PI);
    c.lineWidth = LW; c.strokeStyle = OUTLINE; c.stroke();
    // seeing stars
    if (hd.hit < 1.1) {
      c.globalAlpha = clamp((1.1 - hd.hit) / 0.25, 0, 1);
      const ty = holeY - r * 1.75 * sy - r * 0.55;
      for (let i = 0; i < 3; i++) {
        const a = time * 7 + i * TAU / 3;
        starPath(c, cx + Math.cos(a) * r * 0.85, ty + Math.sin(a) * r * 0.22, r * 0.2, a); fs(c, '#ffc93c', LW * 0.6);
      }
      c.globalAlpha = 1;
    }
    // the mallet
    if (hd.hit < 0.34) {
      const a = hd.hit < 0.06 ? lerp(1.2, 0, hd.hit / 0.06) : lerp(0, 0.95, easeOut(clamp((hd.hit - 0.1) / 0.24, 0, 1)));
      c.save();
      c.globalAlpha = clamp((0.34 - hd.hit) / 0.1, 0, 1);
      c.translate(cx + r * 1.9, holeY - r * 1.75 * 0.5 - r * 0.75);
      c.rotate(a);
      rr(c, -r * 1.8, -r * 0.09, r * 1.9, r * 0.18, r * 0.09); fs(c, '#e0b070', LW * 0.8);
      rr(c, -r * 2.25, -r * 0.55, r * 0.75, r * 1.1, r * 0.14); fs(c, '#ff5a5f');
      c.restore();
    }
  }
}

// =====================================================================
// 4. BELLY BASS
// =====================================================================
const BG = { hr: 0, hx: 0, hy: 0, fy: 0, x0: 0, x1: 1, bx: 0, bw: 1, bh: 1, n: 2 };
function bellyGeom() {
  const B = BG, m = W * 0.04;
  B.hr = Math.min(H * 0.3, W * 0.11); B.hx = m + B.hr; B.fy = H * 0.87; B.hy = B.fy - B.hr * 0.95;
  B.x0 = m + B.hr * 1.75; B.x1 = Math.max(B.x0 + 20, W - m - B.hr * 0.8);
  B.bx = (B.x0 + B.x1) / 2; B.bw = (B.x1 - B.x0) / 2;
  B.bh = Math.min(H * 0.6, B.bw * 0.95);
  B.n = clamp(B.bw / B.bh * 0.9, 2, 4.5);
  return B;
}
function bellyVis(k) {
  const b = belly;
  b.k = k; b.px = pokeFrac == null ? (k + 0.5) / 5 : pokeFrac;
  b.age = 0; b.dent.x = 1; b.dent.v = 0; b.j.v -= 7;
}
function updateBelly(dt) {
  belly.age += dt;
  spring(belly.dent, 0, dt, 170, 7);
  spring(belly.j, 0, dt, 150, 6.5);
}
function bellyDis(f) {
  const b = belly, d = f - b.px;
  return b.dent.x * Math.exp(-(d * d) / 0.0098) * 0.32
    - Math.exp(-b.age * 3) * 0.07 * Math.sin(d * 42 - b.age * 24);
}
function bellyPath(c, B, sc) {
  const N = 40, e = 2 / B.n, jx = 1 - belly.j.x * 0.05, jy = 1 + belly.j.x * 0.1;
  c.beginPath();
  for (let i = 0; i <= N; i++) {
    const a = Math.PI * (1 - i / N), co = Math.cos(a), si = Math.abs(Math.sin(a));
    const ux = Math.sign(co) * Math.pow(Math.abs(co), e), uy = Math.pow(si, e);
    const x = B.bx + B.bw * ux * jx * sc, y = B.fy - B.bh * uy * jy * sc * (1 - bellyDis((ux + 1) / 2));
    if (i) c.lineTo(x, y); else c.moveTo(x, y);
  }
  c.closePath();
}
function bellyY(B, f, sc) {
  const ux = clamp(2 * f - 1, -1, 1), co = Math.pow(Math.abs(ux), B.n / 2);
  const uy = Math.pow(Math.sqrt(Math.max(0, 1 - co * co)), 2 / B.n);
  return B.fy - B.bh * uy * (1 + belly.j.x * 0.1) * sc * (1 - bellyDis(f));
}
function drawBelly(c) {
  const B = bellyGeom(), b = belly, hr = B.hr, jx = 1 - b.j.x * 0.05;
  const happy = Math.exp(-b.age * 0.8), zing = Math.exp(-b.age * 3);
  // feet in the air
  for (let i = 0; i < 2; i++) {
    c.save();
    c.translate(B.x1 + hr * (0.1 + i * 0.42), B.fy - hr * 0.1);
    c.rotate(0.15 + i * 0.25 + Math.sin(time * 30 + i * 2) * zing * 0.4);
    c.beginPath(); c.ellipse(0, -hr * 0.4, hr * 0.26, hr * 0.42, 0, 0, TAU); fs(c, '#ffb26b');
    c.beginPath(); c.ellipse(0, -hr * 0.42, hr * 0.12, hr * 0.2, 0, 0, TAU); c.fillStyle = '#ffd9a8'; c.fill();
    c.restore();
  }
  // the belly
  bellyPath(c, B, 1); fs(c, '#ffb26b');
  bellyPath(c, B, 0.8); c.fillStyle = '#ffe3b8'; c.fill();
  // ears + head
  for (let i = -1; i <= 1; i += 2) {
    c.beginPath(); c.arc(B.hx + i * hr * 0.68, B.hy - hr * 0.72, hr * 0.28, 0, TAU); fs(c, '#ffb26b');
  }
  c.beginPath(); c.arc(B.hx, B.hy, hr, 0, TAU); fs(c, '#ffb26b');
  // zone marks (no labels: freckles, spot, belly button, plaster, one curly hair)
  const ms = clamp(B.bh * 0.07, 4, 12);
  c.strokeStyle = OUTLINE;
  for (let k = 0; k < 5; k++) {
    const f = (k + 0.5) / 5, x = B.bx + B.bw * (2 * f - 1) * jx, y = bellyY(B, f, 0.55);
    const pop = b.k === k ? zing : 0;
    c.save(); c.translate(x, y); c.scale(1 + pop * 0.5, 1 + pop * 0.5);
    if (k === 0) {
      c.fillStyle = '#e08a45';
      c.beginPath(); c.arc(-ms * 0.8, 0, ms * 0.28, 0, TAU); c.arc(ms * 0.5, -ms * 0.6, ms * 0.28, 0, TAU); c.fill();
      c.beginPath(); c.arc(ms * 0.6, ms * 0.6, ms * 0.28, 0, TAU); c.fill();
    } else if (k === 1) {
      c.beginPath(); c.ellipse(0, 0, ms * 1.1, ms * 0.8, -0.4, 0, TAU); c.fillStyle = '#ffc48a'; c.fill();
      c.lineWidth = LW * 0.5; c.stroke();
    } else if (k === 2) {
      c.beginPath(); c.arc(0, 0, ms * 0.75, 0.5, TAU - 0.9); c.lineWidth = LW * 0.8; c.stroke();
      c.beginPath(); c.arc(0, 0, ms * 0.18, 0, TAU); c.fillStyle = OUTLINE; c.fill();
    } else if (k === 3) {
      c.rotate(-0.5);
      rr(c, -ms * 1.5, -ms * 0.55, ms * 3, ms * 1.1, ms * 0.5); fs(c, '#fff6e6', LW * 0.6);
      c.fillStyle = '#f2c79a'; c.fillRect(-ms * 0.5, -ms * 0.4, ms, ms * 0.8);
    }
    c.restore();
  }
  {                                                   // k 4: one proud curly hair on top
    const f = 0.9, x = B.bx + B.bw * (2 * f - 1) * jx, y = bellyY(B, f, 1);
    const sw = Math.sin(time * 26) * zing * ms * 1.2 + b.j.x * ms * 3;
    c.beginPath(); c.moveTo(x, y + LW * 0.5);
    c.bezierCurveTo(x + ms * 0.4 + sw * 0.4, y - ms * 1.4, x + ms * 2 + sw, y - ms * 1.2, x + ms * 1.4 + sw, y - ms * 2.4);
    c.bezierCurveTo(x + ms * 1 + sw, y - ms * 3.2, x + ms * 0.2 + sw, y - ms * 2.6, x + ms * 0.8 + sw, y - ms * 2.1);
    c.lineWidth = LW * 0.75; c.strokeStyle = OUTLINE; c.stroke();
  }
  // poke ripple ring
  if (b.age < 0.4) {
    const x = B.bx + B.bw * (2 * b.px - 1) * jx, y = bellyY(B, b.px, 0.62);
    c.globalAlpha = clamp(1 - b.age / 0.4, 0, 1);
    c.beginPath(); c.ellipse(x, y, b.age * B.bh * 1.6 + 2, b.age * B.bh * 0.9 + 1, 0, 0, TAU);
    c.lineWidth = LW * 0.8; c.strokeStyle = '#fff'; c.stroke();
    c.globalAlpha = 1;
  }
  // face
  const er = hr * 0.3, ey = B.hy - hr * 0.15, exL = B.hx - hr * 0.34, exR = B.hx + hr * 0.38, elw = LW * 0.75;
  const blink = b.age > 2 && (time % 4.2) < 0.13;
  if (blink) {
    limb(c, exL - er, ey, exL + er, ey, LW); limb(c, exR - er, ey, exR + er, ey, LW);
  } else if (b.age < 1.6) {
    const px = B.bx + B.bw * (2 * b.px - 1), py = bellyY(B, b.px, 0.6);
    const dx = px - B.hx, dy = py - ey, d = Math.hypot(dx, dy) || 1, cross = Math.exp(-b.age * 2.2);
    googlyEye(c, exL, ey, er, dx / d + cross * 0.6, dy / d + cross * 0.5, elw);
    googlyEye(c, exR, ey, er, dx / d - cross * 1.7, dy / d + cross * 0.5, elw);
  } else {
    lookAt(B.hx, ey);
    googlyEye(c, exL, ey, er, LX, LY, elw); googlyEye(c, exR, ey, er, LX, LY, elw);
  }
  c.globalAlpha = 0.35 + 0.55 * happy; c.fillStyle = '#ff7a9a';
  c.beginPath(); c.arc(B.hx - hr * 0.62, B.hy + hr * 0.3, hr * 0.16, 0, TAU); c.arc(B.hx + hr * 0.66, B.hy + hr * 0.3, hr * 0.16, 0, TAU); c.fill();
  c.globalAlpha = 1;
  const mx = B.hx + hr * 0.02, my = B.hy + hr * 0.42;
  if (b.age < 0.16) {
    c.beginPath(); c.ellipse(mx, my + hr * 0.05, hr * 0.14, hr * 0.2, 0, 0, TAU); c.fillStyle = '#5b1a3a'; c.fill();
    c.lineWidth = LW * 0.6; c.strokeStyle = OUTLINE; c.stroke();
  } else {
    c.beginPath(); c.arc(mx, my - hr * 0.12, hr * (0.28 + 0.16 * happy), Math.PI * 0.15, Math.PI * 0.85);
    c.lineWidth = LW * 0.9; c.strokeStyle = OUTLINE; c.stroke();
  }
}

// =====================================================================
// stage: update + render
// =====================================================================
function drawInst(c, inst) {
  if (inst === 'goose') drawGeese(c);
  else if (inst === 'whistle') drawWhistle(c);
  else if (inst === 'bonk') drawBonk(c);
  else if (inst === 'belly') drawBelly(c);
}
function fit() {
  if (!canvas) return;
  const r = fitCanvas(canvas);
  W = r.w; H = r.h; dpr = r.dpr;
  LW = clamp(Math.min(H * 0.03, W * 0.0125), 3, 6);   // narrow phone panels get a lighter line
}
function render() {
  const c = ctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.globalAlpha = 1; c.lineJoin = 'round'; c.lineCap = 'round';
  const cols = STAGE[cur] || [PAPER, '#ecdcb0'];
  const fT = H * (cur === 'bonk' ? 0.66 : 0.8);
  c.fillStyle = cols[0]; c.fillRect(0, 0, W, fT);
  c.fillStyle = cols[1]; c.fillRect(0, fT, W, H - fT);
  c.beginPath(); c.moveTo(-10, fT); c.lineTo(W + 10, fT);
  c.lineWidth = LW; c.strokeStyle = OUTLINE; c.stroke();
  if (cur) {
    c.save();
    c.translate(0, shake.x - Math.abs(drop.x) * H * 1.25);
    drawInst(c, cur);
    c.restore();
  }
  if (out) {
    const p = out.t / 0.5;
    c.save();
    c.translate(W / 2 + out.dir * W * 0.55 * p * p, H / 2 - H * 1.5 * p);
    c.rotate(out.dir * p * 2.4);
    c.scale(1 - 0.35 * p, 1 - 0.35 * p);
    c.translate(-W / 2, -H / 2);
    drawInst(c, out.inst);
    c.restore();
  }
  drawParts(c);
}
function frame(dt) {
  if (!canvas) return;
  if (state.replaying !== wasReplaying) { wasReplaying = !!state.replaying; if (wasReplaying) releaseAll(); }
  sizeCheck += dt;
  if (sizeCheck > 0.5) {                               // safety net if a 'layout' was missed
    sizeCheck = 0;
    if (Math.abs(canvas.clientWidth - W) > 1 || Math.abs(canvas.clientHeight - H) > 1) fit();
  }
  if (W < 8 || H < 8) return;
  time += dt;

  // keyboard slide whistle + trailing throttled send
  if (cur === 'whistle' && !state.replaying) {
    const dir = (keysDown.has('ArrowUp') ? 1 : 0) - (keysDown.has('ArrowDown') ? 1 : 0);
    const any = keysDown.has('ArrowUp') || keysDown.has('ArrowDown');
    if (any && !wh.drag && guy.st !== 'fall') startWhistle('key', guy.st === 'flat' ? 0.04 : guy.h);
    if (wh.drag && wh.pid === 'key') wh.h = clamp(wh.h + dir * dt * 0.85, 0, 1);
    if (wh.drag) sendWhistle(false);
  }

  updateGeese(dt); updateGuy(dt); updateHeads(dt); updateBelly(dt); updateParts(dt);
  spring(drop, 0, dt, 150, 9);
  spring(shake, 0, dt, 300, 14);
  if (out) { out.t += dt; if (out.t >= 0.5) out = null; }
  render();
}

// =====================================================================
// input
// =====================================================================
function holdGoose(k) { if (gooseHold[k]++ === 0) send({ t: 'n', i: 'goose', k, on: 1 }); }
function unholdGoose(k) {
  if (gooseHold[k] > 0 && --gooseHold[k] === 0) send({ t: 'n', i: 'goose', k, on: 0 });
}
function releaseAll() {
  ptrs.clear(); keysDown.clear();
  for (let k = 0; k < 5; k++) {
    if (gooseHold[k] > 0) { gooseHold[k] = 0; send({ t: 'n', i: 'goose', k, on: 0 }); }
  }
  dropWhistle();
}
function gooseAt(x, y) {
  if (x < 0 || x > W || y < 0 || y > H) return -1;
  return clamp(Math.floor(x / W * 5), 0, 4);
}
function pokeBelly(x) {
  const B = bellyGeom(), f = clamp((x - B.x0) / (B.x1 - B.x0), 0, 0.999);
  pokeFrac = f;
  try { send({ t: 'n', i: 'belly', k: Math.floor(f * 5) }); } finally { pokeFrac = null; }
}
function evXY(e) {
  const r = canvas.getBoundingClientRect();
  look.x = e.clientX - r.left; look.y = e.clientY - r.top; look.on = true;
}
function onDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  if (!cur || state.replaying || W < 8) return;
  evXY(e);
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* fine */ }
  const x = look.x, y = look.y;
  if (cur === 'goose') {
    const k = gooseAt(x, y);
    ptrs.set(e.pointerId, { k });
    if (k >= 0) holdGoose(k);
  } else if (cur === 'whistle') {
    ptrs.set(e.pointerId, { k: -1 });
    if (!wh.drag && guy.st !== 'fall') startWhistle(e.pointerId, whistleHAt(x, y));
  } else if (cur === 'bonk') {
    send({ t: 'n', i: 'bonk', k: clamp(Math.floor(x / W * 4), 0, 3) });
  } else if (cur === 'belly') {
    pokeBelly(x);
  }
}
function onMove(e) {
  evXY(e);
  const p = ptrs.get(e.pointerId);
  if (!p || state.replaying) return;
  if (cur === 'goose') {
    const k = gooseAt(look.x, look.y);
    if (k !== p.k) {
      if (p.k >= 0) unholdGoose(p.k);
      p.k = k;
      if (k >= 0) holdGoose(k);
    }
  } else if (cur === 'whistle') {
    if (!wh.drag && guy.st !== 'fall') startWhistle(e.pointerId, whistleHAt(look.x, look.y));
    else if (wh.drag && wh.pid === e.pointerId) { wh.h = whistleHAt(look.x, look.y); sendWhistle(false); }
  }
}
function onUp(e) {
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  ptrs.delete(e.pointerId);
  if (cur === 'goose') { if (p.k >= 0) unholdGoose(p.k); }
  else if (cur === 'whistle' && wh.drag && wh.pid === e.pointerId) dropWhistle();
}
function keysOk(e) {
  if (!cur || state.replaying || e.ctrlKey || e.metaKey || e.altKey) return false;
  const tg = e.target;
  if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT' || tg.isContentEditable)) return false;
  return W >= 8 && canvas.getClientRects().length > 0;
}
function onKeyDown(e) {
  if (!keysOk(e)) return;
  const code = e.code;
  if (cur === 'goose') {
    const k = keyOf(GOOSE_KEYS, code);
    if (k < 0) return;
    e.preventDefault();
    if (e.repeat || keysDown.has(code)) return;
    keysDown.add(code); holdGoose(k);
  } else if (cur === 'whistle') {
    if (code === 'ArrowUp' || code === 'ArrowDown') { e.preventDefault(); keysDown.add(code); }
    else if (code === 'Space' && wh.drag && wh.pid === 'key') {
      e.preventDefault(); keysDown.delete('ArrowUp'); keysDown.delete('ArrowDown'); dropWhistle();
    }
  } else if (cur === 'bonk') {
    const k = keyOf(BONK_KEYS, code);
    if (k < 0) return;
    e.preventDefault();
    if (!e.repeat) send({ t: 'n', i: 'bonk', k });
  } else if (cur === 'belly') {
    const k = keyOf(BELLY_KEYS, code);
    if (k < 0) return;
    e.preventDefault();
    if (!e.repeat) send({ t: 'n', i: 'belly', k });
  }
}
function onKeyUp(e) {
  const code = e.code;
  if (!keysDown.delete(code)) return;
  if (cur === 'goose') { const k = keyOf(GOOSE_KEYS, code); if (k >= 0) unholdGoose(k); }
  else if (cur === 'whistle' && wh.drag && wh.pid === 'key' && !keysDown.has('ArrowUp') && !keysDown.has('ArrowDown')) dropWhistle();
}

// =====================================================================
// bus
// =====================================================================
const intIn = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : -1);
function onMsg(m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'frame') { releaseAll(); return; }
  if (m.t !== 'n' || state.me == null || m.from !== state.me) return;   // only my own notes animate here
  if (m.i === 'goose') {
    const k = intIn(m.k, 0, 4);
    if (k >= 0) gooseVis(k, m.on === 1 || m.on === true);
  } else if (m.i === 'whistle') {
    if (typeof m.h !== 'number' || !Number.isFinite(m.h)) return;
    const h = clamp(m.h, 0, 1);
    if (m.drop) guyDrop(h); else if (m.on) guyHeld(h);
  } else if (m.i === 'bonk') {
    const k = intIn(m.k, 0, 3);
    if (k >= 0) bonkVis(k);
  } else if (m.i === 'belly') {
    const k = intIn(m.k, 0, 4);
    if (k >= 0) bellyVis(k);
  }
}
const pickBtns = [];
function onPlayers() {
  const p = myPlayer();
  const inst = p && INSTRUMENTS.includes(p.inst) ? p.inst : null;
  for (const b of pickBtns) b.classList.toggle('on', b.dataset.inst === inst);
  if (inst === cur) return;
  releaseAll();                                        // nothing may drone across a switch
  for (let k = 0; k < 5; k++) geese[k].on = false;
  if (cur && W >= 8) out = { inst: cur, t: 0, dir: Math.random() < 0.5 ? -1 : 1 };
  cur = inst;
  parts.length = 0;
  drop.x = 1; drop.v = 0;
}
function buildPicker() {
  const box = document.getElementById('instpick');
  if (!box) return;
  const px = 40, d = Math.min(window.devicePixelRatio || 1, 3);
  for (const inst of INSTRUMENTS) {
    const b = document.createElement('button');
    b.className = 'rb'; b.type = 'button'; b.dataset.inst = inst;
    const cv = document.createElement('canvas');
    cv.width = cv.height = Math.round(px * d);
    cv.style.width = cv.style.height = px + 'px';
    cv.style.display = 'block'; cv.style.pointerEvents = 'none';
    const g = cv.getContext('2d');
    g.scale(d, d);
    drawIcon(g, inst, px / 2, px / 2, px);
    b.appendChild(cv);
    b.addEventListener('click', () => {
      if (state.replaying || state.me == null) return;
      const p = myPlayer();
      if (!p || p.inst === inst) return;
      send({ t: 'inst', i: inst });
    });
    box.appendChild(b);
    pickBtns.push(b);
  }
}

// =====================================================================
// public API
// =====================================================================
let inited = false;
export function init() {
  if (inited) return;
  inited = true;
  buildPicker();
  canvas = document.getElementById('inst');
  if (canvas) {
    ctx = canvas.getContext('2d');
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('lostpointercapture', onUp);
    canvas.addEventListener('pointerleave', () => { look.on = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    fit();
  }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  bus.on('layout', fit);
  bus.on('msg', onMsg);
  bus.on('players', onPlayers);
  bus.on('joined', onPlayers);
  bus.on('tick', (e) => frame(e && e.dt > 0 ? Math.min(e.dt, 0.05) : 0.016));
  onPlayers();
}

// A bold little sticker of an instrument, centred at (x, y) inside a size x size box.
// Pure function of its arguments.
export function drawIcon(ctx, inst, x, y, size) {
  const u = size / 48, lw = Math.max(3.4, 1.7 / u), c = ctx;
  c.save();
  c.translate(x, y); c.scale(u, u);
  c.lineJoin = 'round'; c.lineCap = 'round';
  const fill = (col, w = lw) => { c.fillStyle = col; c.fill(); c.lineWidth = w; c.strokeStyle = OUTLINE; c.stroke(); };
  if (inst === 'goose') {
    c.beginPath(); c.moveTo(-7, 21); c.lineTo(-5, 4);
    c.lineWidth = 9 + lw * 2; c.strokeStyle = OUTLINE; c.stroke();
    c.lineWidth = 9; c.strokeStyle = '#fff'; c.stroke();
    c.beginPath(); c.moveTo(2, -2); c.lineTo(20, -12); c.lineTo(19, 7); c.closePath(); fill('#a3243b', lw * 0.8);
    c.beginPath(); c.moveTo(0, -11); c.lineTo(23, -15); c.lineTo(5, -1); c.closePath(); fill('#ff9f1c', lw * 0.8);
    c.beginPath(); c.moveTo(4, 2); c.lineTo(21, 9); c.lineTo(0, 8); c.closePath(); fill('#f08a00', lw * 0.8);
    c.beginPath(); c.arc(-5, -3, 11, 0, TAU); fill('#fff');
    googlyEye(c, -6, -6, 5.2, 0.7, -0.3, lw * 0.7);
  } else if (inst === 'whistle') {
    c.beginPath(); c.moveTo(-14, 21); c.lineTo(12, -15);
    c.lineWidth = 5 + lw * 2; c.strokeStyle = OUTLINE; c.stroke();
    c.lineWidth = 5; c.strokeStyle = '#d5dde8'; c.stroke();
    c.beginPath(); c.arc(13, -16, 5, 0, TAU); fill('#ff5a5f', lw * 0.8);
    c.beginPath(); c.arc(-3, 1, 11, 0, TAU); fill('#b46bff');
    googlyEye(c, -7.5, -1.5, 4.4, -0.3, 0.9, lw * 0.6);
    googlyEye(c, 1.5, -1.5, 4.4, -0.3, 0.9, lw * 0.6);
    c.beginPath(); c.ellipse(-3, 6.5, 2.4, 2.8, 0, 0, TAU); c.fillStyle = OUTLINE; c.fill();
  } else if (inst === 'bonk') {
    c.beginPath(); c.arc(-2, 8, 13, 0, TAU); fill('#ffd45e');
    c.beginPath(); c.rect(-9, -21, 14, 14); fill('#ff5a5f');
    c.beginPath(); c.moveTo(-14, -6); c.lineTo(10, -6); c.lineWidth = 4 + lw; c.strokeStyle = OUTLINE; c.stroke();
    googlyEye(c, -7, 7, 4.3, 0.4, -0.8, lw * 0.6);
    googlyEye(c, 3, 7, 4.3, 0.4, -0.8, lw * 0.6);
    c.beginPath(); c.moveTo(-5, 15); c.lineTo(1, 15); c.lineWidth = lw * 0.8; c.strokeStyle = OUTLINE; c.stroke();
    c.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, q = i % 2 ? 3 : 6.5;
      const px = 17 + Math.cos(a) * q, py = -13 + Math.sin(a) * q;
      if (i) c.lineTo(px, py); else c.moveTo(px, py);
    }
    c.closePath(); fill('#ffc93c', lw * 0.7);
  } else if (inst === 'belly') {
    c.beginPath(); c.arc(-12, -11, 4.5, 0, TAU); fill('#ffb26b', lw * 0.8);
    c.beginPath(); c.arc(12, -11, 4.5, 0, TAU); fill('#ffb26b', lw * 0.8);
    c.beginPath(); c.arc(0, 4, 17, 0, TAU); fill('#ffb26b');
    c.beginPath(); c.arc(0, 9, 9.5, 0, TAU); c.fillStyle = '#ffe3b8'; c.fill();
    c.beginPath(); c.arc(0, 10, 2.2, 0.5, TAU - 0.9); c.lineWidth = lw * 0.6; c.strokeStyle = OUTLINE; c.stroke();
    googlyEye(c, -6, -6, 4.4, 0, 0.7, lw * 0.6);
    googlyEye(c, 6, -6, 4.4, 0, 0.7, lw * 0.6);
  }
  c.restore();
}
