// FROG JAM — the shared canvas: slippery pen, whoopee-cushion fill, googly-eye
// stamps, eraser, and the scanner worm that plays the drawing as music.
import {
  ART_W, ART_H, OUTLINE, PAPER, PALETTE, BEAT_MS,
  state, bus, send, sync, rng, newSeed, clamp, lerp, spring, googlyEye, myPlayer,
} from './bus.js';
import { sfx, pluck } from './audio.js';

// ---------- constants ----------
const TAU = Math.PI * 2;
const OPS = new Set(['s', 'wall', 'puff', 'eyes', 'worm', 'clear']);
const PEN_W = 10, ERASE_W = 46;
const PEN_K = 75, PEN_C = 8.5, COAST_C = 6.5, PEN_VMAX = 2600, WALL = 5;
const LOOP = 8 * BEAT_MS, STEPS = 32, BANDS = 12;
const MAX_EYES = 60, EYE_MIN = 14, EYE_MAX = 70;
const WORM_C = '#8fe36b', PINK = '#ff9bb0';
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const PAL_RGB = PALETTE.map(hexRgb);
const [PR, PG, PB] = hexRgb(PAPER);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const validC = (v, d) => (Number.isInteger(v) && v >= 0 && v < PALETTE.length ? v : d);

// ---------- module state ----------
let art = null, actx = null, fx = null, fctx = null, toolsEl = null;
let shown = false, frame = 0;
let tool = 0, color = 0, colorPicked = false;
let wormOn = true;
const strokes = new Map();       // key -> in-flight stroke render state
let eyes = [];                   // live googly-eye pairs
let puffs = [];                  // in-flight paint clouds
const parts = [];                // fx particles
const focus = { x: ART_W / 2, y: ART_H / 2, tx: ART_W / 2, ty: ART_H / 2 };
let held = [];                   // ops that arrived during the encore / sync image load
let syncLoading = false, syncGen = 0;
let crumple = null, crumpleCv = null;
let lastBonk = 0, lastPop = 0, lastStale = 0;

// local input
const ges = { pid: null, tool: -1, x: 0, y: 0, t0: 0 };
const pen = {
  active: false, down: false, id: '', c: 0, x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0,
  coast: 0, pend: [], lastFlush: 0, rx: 0, ry: 0, sq: { x: 0, v: 0 }, lastWall: 0, lastSkid: 0, lastDust: 0,
};
const era = { id: '', c: 0, pend: [], lastFlush: 0, rx: 0, ry: 0, lastSfx: 0 };
let hover = null, lastSqueak = 0, strokeN = 0;
const clr = { held: false, t: 0 };
const worm = { x: -40, scr: 0, cheek: { x: 0, v: 0 }, gag: 0, lastStep: -1, gagLoop: -1 };
const btn = { tools: [], colors: [], worm: null, clear: null };

// ---------- public API ----------
export function isOp(m) { return !!m && typeof m === 'object' && typeof m.t === 'string' && OPS.has(m.t); }
export function artCanvas() { return art; }

export function applyOp(m, opts) {
  if (!actx || !isOp(m)) return;
  const o = opts || {};
  const quiet = !!o.quiet;
  const speed = isNum(o.speed) && o.speed > 0 ? clamp(o.speed, 0.25, 64) : (quiet ? 8 : 1);
  switch (m.t) {
    case 's': opStroke(m, quiet); break;
    case 'wall': opWall(m, quiet); break;
    case 'puff': opPuff(m, quiet, speed); break;
    case 'eyes': opEyes(m, quiet); break;
    case 'worm': opWorm(m, quiet); break;
    case 'clear': opClear(quiet); break;
  }
}

export function snapshot() {
  finishPuffs();
  const c = document.createElement('canvas');
  c.width = ART_W; c.height = ART_H;
  if (art) c.getContext('2d').drawImage(art, 0, 0);
  return { canvas: c, eyes: eyes.map(plainEye), worm: wormOn ? 1 : 0 };
}

export function restore(snap) {
  if (!actx || !snap || typeof snap !== 'object') return;
  cancelAll();
  actx.fillStyle = PAPER; actx.fillRect(0, 0, ART_W, ART_H);
  if (snap.canvas) { try { actx.drawImage(snap.canvas, 0, 0, ART_W, ART_H); } catch (e) { console.error(e); } }
  eyes = readEyes(snap.eyes);
  if (snap.worm === 0 || snap.worm === 1 || typeof snap.worm === 'boolean') setWorm(!!snap.worm);
}

export function blank() {
  if (!actx) return;
  cancelAll();
  actx.fillStyle = PAPER; actx.fillRect(0, 0, ART_W, ART_H);
  eyes = [];
}

// Paint the whole picture (pixels + googly eyes, eyes looking straight out) into
// another context at (x, y), 1:1 in art pixels. Used for the framed picture.
export function drawFlat(g, x, y) {
  if (!art || !g) return;
  finishPuffs();
  g.drawImage(art, x, y, ART_W, ART_H);
  g.save();
  g.beginPath(); g.rect(x, y, ART_W, ART_H); g.clip();
  for (const e of eyes) {
    const lw = clamp(e.r * 0.16, 3, 7);
    googlyEye(g, x + e.x - e.r * 0.92, y + e.y, e.r, 0.25, 0.5, lw);
    googlyEye(g, x + e.x + e.r * 0.92, y + e.y, e.r, 0.25, 0.5, lw);
  }
  g.restore();
}

export function init() {
  art = document.getElementById('art');
  fx = document.getElementById('fx');
  toolsEl = document.getElementById('tools');
  if (!art || !fx) { console.error('[draw] #art / #fx missing'); return; }
  if (art.width !== ART_W || art.height !== ART_H) { art.width = ART_W; art.height = ART_H; }
  if (fx.width !== ART_W || fx.height !== ART_H) { fx.width = ART_W; fx.height = ART_H; }
  actx = art.getContext('2d', { alpha: false });
  fctx = fx.getContext('2d');
  actx.fillStyle = PAPER; actx.fillRect(0, 0, ART_W, ART_H);
  fx.style.touchAction = 'none';

  fx.addEventListener('pointerdown', onDown);
  fx.addEventListener('pointermove', onMove);
  fx.addEventListener('pointerup', (e) => onUp(e, false));
  fx.addEventListener('pointercancel', (e) => onUp(e, true));
  fx.addEventListener('pointerleave', () => { hover = null; });
  fx.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => { if (document.hidden) finishPuffs(); });

  if (toolsEl) buildTools();

  bus.on('msg', (m) => {
    if (!isOp(m)) return;
    if (state.replaying || syncLoading) { if (held.length < 4000) held.push(m); return; }
    applyOp(m);
  });
  bus.on('tick', onTick);
  bus.on('layout', () => { shown = fx.getClientRects().length > 0; });
  bus.on('joined', (d) => { if (!colorPicked && d && isNum(d.slot)) setColor(clamp(Math.round(d.slot), 0, 3), false); });
  bus.on('players', () => { const p = myPlayer(); if (!colorPicked && p && isNum(p.slot)) setColor(clamp(Math.round(p.slot), 0, 3), false); });

  sync.provide('art', () => {
    finishPuffs();
    return { img: encodeArt(), eyes: eyes.map(plainEye), worm: wormOn ? 1 : 0 };
  });
  sync.apply('art', (v) => {
    if (!v || typeof v !== 'object') return;
    if (v.worm === 0 || v.worm === 1) setWorm(!!v.worm);
    if (Array.isArray(v.eyes)) eyes = readEyes(v.eyes);
    if (typeof v.img !== 'string' || v.img.length > 3000000) return;
    if (!/^data:image\/(webp|png|jpeg);base64,/.test(v.img)) return;
    const gen = ++syncGen, im = new Image();
    syncLoading = true;
    im.onload = () => {
      if (gen !== syncGen) return;
      syncLoading = false;
      strokes.clear(); puffs = [];
      actx.fillStyle = PAPER; actx.fillRect(0, 0, ART_W, ART_H);
      try { actx.drawImage(im, 0, 0, ART_W, ART_H); } catch (e) { console.error(e); }
      bus.emit('artsync');
    };
    im.onerror = () => { if (gen === syncGen) syncLoading = false; };
    im.src = v.img;
  });
}

// ---------- helpers ----------
function plainEye(e) { return { id: e.id, x: e.x, y: e.y, r: e.r }; }
function makeEye(id, x, y, r, land) {
  return {
    id, x, y, r,
    sq: { x: land ? 1.7 : 1, v: 0 }, rot: { x: 0, v: land ? (Math.random() - 0.5) * 8 : 0 },
    blink: 0, nb: 1 + Math.random() * 5,
  };
}
function readEyes(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const e of list.slice(-MAX_EYES)) {
    if (!e || typeof e !== 'object' || !isNum(e.x) || !isNum(e.y) || !isNum(e.r)) continue;
    const id = typeof e.id === 'string' ? e.id.slice(0, 48) : isNum(e.id) ? String(e.id) : '';
    if (!id) continue;
    out.push(makeEye(id, clamp(Math.round(e.x), 0, ART_W), clamp(Math.round(e.y), 0, ART_H), clamp(e.r, EYE_MIN, EYE_MAX), false));
  }
  return out;
}
function cancelAll() {
  syncGen++; syncLoading = false;
  strokes.clear(); puffs = []; parts.length = 0; crumple = null;
  abortGesture();
}
function abortGesture() {
  if (ges.pid !== null) { try { fx.releasePointerCapture(ges.pid); } catch (e) { /* gone */ } }
  ges.pid = null; ges.tool = -1;
  pen.active = false; pen.down = false; pen.pend = [];
  era.pend = [];
}
function setFocus(x, y) { focus.tx = x; focus.ty = y; }
function addPart(k, x, y, vx, vy, life, r, c, grav) {
  if (parts.length >= 220) return;
  parts.push({ k, x, y, vx, vy, l: life, m: life, r, c, g: grav || 0 });
}
function burst(x, y, n, c, v, r) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, s = v * (0.4 + Math.random() * 0.8);
    addPart(0, x, y, Math.cos(a) * s, Math.sin(a) * s, 0.3 + Math.random() * 0.3, r * (0.6 + Math.random() * 0.7), c, 500);
  }
}
function jiggleNear(x, y, reach) {
  for (const e of eyes) {
    const d = Math.hypot(e.x - x, e.y - y);
    if (d > reach + e.r) continue;
    const k = 1 - 0.6 * d / (reach + e.r);
    e.sq.v += 9 * k * (Math.random() < 0.5 ? -1 : 1);
    e.rot.v += (Math.random() - 0.5) * 16 * k;
  }
}
function distSeg(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}
function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}
function encodeArt() {
  const enc = (cv, type, q) => { try { return cv.toDataURL(type, q); } catch (e) { return ''; } };
  let s = enc(art, 'image/webp', 0.8);            // browsers without webp encoding hand back PNG
  if (s.length > 900000) {
    const sm = document.createElement('canvas');
    sm.width = 600; sm.height = 450;
    sm.getContext('2d').drawImage(art, 0, 0, 600, 450);
    s = enc(sm, 'image/webp', 0.8);
    if (s.length > 900000) s = enc(sm, 'image/jpeg', 0.7);
  }
  return s;
}

// ---------- ops ----------
function opStroke(m, quiet) {
  const id = typeof m.id === 'string' ? m.id : isNum(m.id) ? String(m.id) : null;
  if (id === null || id.length > 48) return;
  if (m.tool !== 'pen' && m.tool !== 'erase') return;
  if (!Array.isArray(m.pts)) return;
  const erase = m.tool === 'erase';
  const c = validC(m.c, PALETTE.length - 1);
  const w = isNum(m.w) ? clamp(m.w, 2, 60) : (erase ? ERASE_W : PEN_W);
  const key = String(m.from == null ? '' : m.from).slice(0, 64) + '|' + id;
  let st = strokes.get(key);
  if (!st) {
    if (strokes.size >= 48) { const k0 = strokes.keys().next().value; endStroke(k0, strokes.get(k0)); }
    st = { x: 0, y: 0, mx: 0, my: 0, gx: 0, gy: 0, n: 0, t: 0, c, w, erase, local: !!m.local };
    strokes.set(key, st);
  }
  st.t = performance.now(); st.c = c; st.w = w; st.erase = erase;
  const n = Math.min(m.pts.length, 400) & ~1;
  actx.lineCap = 'round'; actx.lineJoin = 'round'; actx.lineWidth = w;
  actx.strokeStyle = actx.fillStyle = erase ? PAPER : PALETTE[c];
  let open = false;
  for (let i = 0; i < n; i += 2) {
    const px = m.pts[i], py = m.pts[i + 1];
    if (!isNum(px) || !isNum(py)) break;
    const x = clamp(Math.round(px), 0, ART_W), y = clamp(Math.round(py), 0, ART_H);
    if (st.n === 0) {
      st.x = st.mx = st.gx = x; st.y = st.my = st.gy = y; st.n = 1;
      actx.beginPath(); actx.arc(x, y, w / 2, 0, TAU); actx.fill();
      if (erase) eraseEyes(x, y, x, y, w, quiet);
      continue;
    }
    if (x === st.x && y === st.y) continue;
    if (!open) { actx.beginPath(); actx.moveTo(st.mx, st.my); open = true; }
    const mx = (st.x + x) / 2, my = (st.y + y) / 2;
    actx.quadraticCurveTo(st.x, st.y, mx, my);
    if (erase) eraseEyes(st.x, st.y, x, y, w, quiet);
    st.mx = mx; st.my = my; st.x = x; st.y = y; st.n++;
  }
  if (m.end && st.n > 0) {
    if (!open) { actx.beginPath(); actx.moveTo(st.mx, st.my); open = true; }
    actx.lineTo(st.x, st.y);
  }
  if (open) actx.stroke();
  if (st.n) setFocus(st.x, st.y);
  if (m.end) strokes.delete(key);
}
function endStroke(key, st) {       // finish a stale stroke's last half-segment and forget it
  if (st && st.n > 1) {
    actx.lineCap = 'round'; actx.lineJoin = 'round'; actx.lineWidth = st.w;
    actx.strokeStyle = st.erase ? PAPER : PALETTE[st.c];
    actx.beginPath(); actx.moveTo(st.mx, st.my); actx.lineTo(st.x, st.y); actx.stroke();
  }
  strokes.delete(key);
}
function eraseEyes(x0, y0, x1, y1, w, quiet) {
  for (let i = eyes.length - 1; i >= 0; i--) {
    const e = eyes[i];
    if (distSeg(e.x, e.y, x0, y0, x1, y1) > w / 2 + e.r * 0.5) continue;
    eyes.splice(i, 1);
    burst(e.x, e.y, 7, '#ffffff', 260, 7);
    addPart(1, e.x, e.y, 0, 0, 0.3, e.r, OUTLINE, 0);
    const now = performance.now();
    if (!quiet && now - lastPop > 70) { lastPop = now; sfx('pop'); }
  }
}

function opWall(m, quiet) {
  if (!isNum(m.x) || !isNum(m.y)) return;
  const x = clamp(Math.round(m.x), 0, ART_W), y = clamp(Math.round(m.y), 0, ART_H);
  const rnd = rng((Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0);
  const spikes = 5 + Math.floor(rnd() * 3), R = 20 + rnd() * 12, a0 = rnd() * TAU;
  actx.fillStyle = OUTLINE;
  actx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const a = a0 + i * Math.PI / spikes, r = i & 1 ? R * 0.42 : R * (0.8 + rnd() * 0.35);
    const px = Math.round(x + Math.cos(a) * r), py = Math.round(y + Math.sin(a) * r);
    if (i) actx.lineTo(px, py); else actx.moveTo(px, py);
  }
  actx.closePath(); actx.fill();
  actx.beginPath();
  for (let i = 0; i < 4; i++) {            // a few flung ink specks
    const a = rnd() * TAU, d = R + 8 + rnd() * 22, r = 2 + Math.round(rnd() * 3);
    const px = Math.round(x + Math.cos(a) * d), py = Math.round(y + Math.sin(a) * d);
    actx.moveTo(px + r, py); actx.arc(px, py, r, 0, TAU);
  }
  actx.fill();
  setFocus(x, y);
  jiggleNear(x, y, 280);
  addPart(1, x, y, 0, 0, 0.35, 34, OUTLINE, 0);
  burst(x, y, 6, '#ffc93c', 380, 6);
  const now = performance.now();
  if (!quiet && now - lastBonk > 60) { lastBonk = now; sfx('bonk'); }
}

function opPuff(m, quiet, speed) {
  if (!isNum(m.x) || !isNum(m.y) || !isNum(m.p) || !isNum(m.seed)) return;
  const x = clamp(Math.round(m.x), 0, ART_W), y = clamp(Math.round(m.y), 0, ART_H);
  const p = clamp(m.p, 0, 1), c = validC(m.c, 0), seed = m.seed >>> 0;
  const rnd = rng(seed);
  const R = 60 + 240 * p, n = 15 + Math.round(25 * p);
  const cs = new Int16Array(n * 3);        // x, y, r triples, centre first, spreading outward
  cs[0] = x; cs[1] = y; cs[2] = Math.round(R * 0.42);
  for (let i = 1; i < n; i++) {
    const a = rnd() * TAU, d = R * (0.12 + 0.72 * Math.sqrt((i + rnd()) / n));
    const r = Math.max(6, Math.min(R * 1.04 - d, R * (0.14 + 0.22 * rnd())));
    cs[i * 3] = Math.round(x + Math.cos(a) * d);
    cs[i * 3 + 1] = Math.round(y + Math.sin(a) * d * 0.92);
    cs[i * 3 + 2] = Math.round(r);
  }
  const pf = { cs, n, c, t: 0, dur: 0.6, speed, done: false, sp: null };
  setFocus(x, y);
  jiggleNear(x, y, R + 160);
  if (document.hidden) { paintPuff(pf, 1); return; }
  if (puffs.length >= 8) { const old = puffs.shift(); if (!old.done) paintPuff(old, 1); }
  const sr = rng(seed ^ 0x9e3779b9);
  pf.sp = {
    x, y, h: sr() * TAU, v: 520 + 900 * p, t: 0, dur: 0.25 + 1.1 * p, s0: 26 + 70 * p,
    f1: 9 + sr() * 9, p1: sr() * TAU, f2: 21 + sr() * 14, p2: sr() * TAU, tr: 0,
  };
  puffs.push(pf);
  if (!quiet) sfx('fart', { dur: 0.25 + 1.1 * p, p });
}
// u in 0..1 paints the bloom so far; u >= 1 paints the exact final shape. Growing
// circles stay 2px inside their final edge, so the end result never depends on timing.
function paintPuff(pf, u) {
  const cs = pf.cs, n = pf.n;
  actx.fillStyle = PALETTE[pf.c];
  actx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = cs[i * 3], y = cs[i * 3 + 1];
    let r = cs[i * 3 + 2];
    if (u < 1) {
      const k = clamp((u - (i / n) * 0.55) / 0.45, 0, 1);
      if (k <= 0) continue;
      r = (r - 2) * (1 - (1 - k) * (1 - k));
      if (r < 1) continue;
    }
    actx.moveTo(x + r, y); actx.arc(x, y, r, 0, TAU);
  }
  actx.fill();
  if (u >= 1) pf.done = true;
}
function finishPuffs() {
  for (const pf of puffs) if (!pf.done) paintPuff(pf, 1);
}

function opEyes(m, quiet) {
  if (!isNum(m.x) || !isNum(m.y) || !isNum(m.r)) return;
  const id = typeof m.id === 'string' ? m.id : isNum(m.id) ? String(m.id) : null;
  if (!id || id.length > 48) return;
  for (const e of eyes) if (e.id === id) return;
  const x = clamp(Math.round(m.x), 0, ART_W), y = clamp(Math.round(m.y), 0, ART_H);
  const r = clamp(m.r, EYE_MIN, EYE_MAX);
  eyes.push(makeEye(id, x, y, r, true));
  while (eyes.length > MAX_EYES) eyes.shift();
  setFocus(x, y);
  addPart(1, x, y, 0, 0, 0.3, r * 1.6, OUTLINE, 0);
  if (!quiet) sfx('stamp');
}

function opWorm(m, quiet) {
  if (m.on !== 0 && m.on !== 1 && typeof m.on !== 'boolean') return;
  const on = !!m.on;
  if (on === wormOn) return;
  setWorm(on);
  if (!quiet) sfx('pop');
}
function setWorm(on) {
  wormOn = on;
  worm.lastStep = -1;
  if (btn.worm) { btn.worm.b.classList.toggle('on', wormOn); paintIcon(btn.worm); }
}

function opClear(quiet) {
  const show = !quiet && shown && !document.hidden;
  if (show) {
    if (!crumpleCv) { crumpleCv = document.createElement('canvas'); crumpleCv.width = 600; crumpleCv.height = 450; }
    finishPuffs();
    crumpleCv.getContext('2d').drawImage(art, 0, 0, 600, 450);
  }
  blank();
  if (show) crumple = { t: 0 };
  if (!quiet) sfx('whoosh', { dur: 0.5 });
}

// ---------- local input ----------
function toArt(e) {
  const r = fx.getBoundingClientRect();
  const w = r.width || 1, h = r.height || 1;
  ges.x = (e.clientX - r.left) / w * ART_W;
  ges.y = (e.clientY - r.top) / h * ART_H;
}
const cx = (v) => clamp(Math.round(v), 0, ART_W);
const cy = (v) => clamp(Math.round(v), 0, ART_H);
const newId = () => Math.random().toString(36).slice(2, 8) + (strokeN++).toString(36);

function onDown(e) {
  if (state.replaying || ges.pid !== null) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  try { fx.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
  toArt(e);
  ges.pid = e.pointerId; ges.tool = tool; ges.t0 = performance.now();
  hover = null;
  if (tool === 0) {
    if (pen.active) finishPen();
    pen.active = true; pen.down = true; pen.id = newId(); pen.c = color;
    pen.x = pen.tx = clamp(ges.x, WALL, ART_W - WALL); pen.y = pen.ty = clamp(ges.y, WALL, ART_H - WALL);
    pen.vx = pen.vy = 0; pen.coast = 0; pen.sq.x = 0; pen.sq.v = 0;
    pen.rx = Math.round(pen.x); pen.ry = Math.round(pen.y);
    pen.pend = [pen.rx, pen.ry]; pen.lastFlush = 0;
  } else if (tool === 3) {
    era.id = newId(); era.c = color;
    era.rx = cx(ges.x); era.ry = cy(ges.y);
    era.pend = [era.rx, era.ry]; era.lastFlush = 0;
  } else {
    lastSqueak = 0;
  }
}
function onMove(e) {
  if (e.pointerId !== ges.pid) {
    if (ges.pid === null && e.pointerType === 'mouse') {
      const r = fx.getBoundingClientRect();
      hover = hover || { x: 0, y: 0 };
      hover.x = (e.clientX - r.left) / (r.width || 1) * ART_W;
      hover.y = (e.clientY - r.top) / (r.height || 1) * ART_H;
    }
    return;
  }
  if (ges.tool === 3 && e.getCoalescedEvents) {
    const list = e.getCoalescedEvents();
    for (let i = 0; i < list.length; i++) { toArt(list[i]); erasePoint(); }
  }
  toArt(e);
  if (ges.tool === 0) { pen.tx = clamp(ges.x, -80, ART_W + 80); pen.ty = clamp(ges.y, -80, ART_H + 80); }
  else if (ges.tool === 3) erasePoint();
}
function onUp(e, cancelled) {
  if (e.pointerId !== ges.pid) return;
  const tl = ges.tool, heldFor = (performance.now() - ges.t0) / 1000;
  try { fx.releasePointerCapture(ges.pid); } catch (err) { /* gone */ }
  ges.pid = null; ges.tool = -1;
  if (state.replaying) { abortGesture(); return; }
  if (tl === 0) { pen.down = false; pen.coast = 0; }
  else if (tl === 3) { erasePoint(); flushStroke(era, 'erase', ERASE_W, 1); }
  else if (cancelled) return;
  else if (tl === 1) {
    send({ t: 'puff', x: cx(ges.x), y: cy(ges.y), p: Math.round(clamp(heldFor / 1.5, 0, 1) * 100) / 100, c: color, seed: newSeed() });
  } else if (tl === 2) {
    send({ t: 'eyes', x: cx(ges.x), y: cy(ges.y), r: Math.round(eyeR(heldFor)), id: newId() });
  }
}
const eyeR = (secs) => EYE_MIN + (EYE_MAX - EYE_MIN) * clamp((secs - 0.12) / 1.1, 0, 1);

function erasePoint() {
  const x = cx(ges.x), y = cy(ges.y);
  const dx = x - era.rx, dy = y - era.ry;
  if (dx * dx + dy * dy < 9) return;
  era.rx = x; era.ry = y; era.pend.push(x, y);
  const now = performance.now();
  if (now - era.lastSfx > 110) { era.lastSfx = now; sfx('erase'); }
}
function flushStroke(s, toolName, w, end) {
  let pts = s.pend;
  s.pend = [];
  s.lastFlush = performance.now();
  while (pts.length > 400) {
    send({ t: 's', id: s.id, tool: toolName, c: s.c, w, pts: pts.slice(0, 400), end: 0 });
    pts = pts.slice(400);
  }
  send({ t: 's', id: s.id, tool: toolName, c: s.c, w, pts, end: end ? 1 : 0 });
}
function finishPen() {
  if (!pen.active) return;
  pen.active = false; pen.down = false;
  flushStroke(pen, 'pen', PEN_W, 1);
}
function penPoint(force) {
  const x = Math.round(pen.x), y = Math.round(pen.y);
  const dx = x - pen.rx, dy = y - pen.ry;
  if (!force && dx * dx + dy * dy < 9) return;
  if (!dx && !dy) return;
  pen.rx = x; pen.ry = y; pen.pend.push(x, y);
}
function penTick(dt, now) {
  const n = Math.max(1, Math.ceil(dt * 120)), h = dt / n;
  for (let i = 0; i < n; i++) {
    if (pen.down) {
      pen.vx += ((pen.tx - pen.x) * PEN_K - pen.vx * PEN_C) * h;
      pen.vy += ((pen.ty - pen.y) * PEN_K - pen.vy * PEN_C) * h;
    } else {
      pen.vx -= pen.vx * COAST_C * h; pen.vy -= pen.vy * COAST_C * h;
    }
    const sp = Math.hypot(pen.vx, pen.vy);
    if (sp > PEN_VMAX) { const k = PEN_VMAX / sp; pen.vx *= k; pen.vy *= k; }
    pen.x += pen.vx * h; pen.y += pen.vy * h;
    let hit = 0;
    if (pen.x < WALL) { pen.x = WALL; if (pen.vx < 0) { hit = -pen.vx; pen.vx *= -0.72; } }
    else if (pen.x > ART_W - WALL) { pen.x = ART_W - WALL; if (pen.vx > 0) { hit = pen.vx; pen.vx *= -0.72; } }
    if (pen.y < WALL) { pen.y = WALL; if (pen.vy < 0) { hit = Math.max(hit, -pen.vy); pen.vy *= -0.72; } }
    else if (pen.y > ART_H - WALL) { pen.y = ART_H - WALL; if (pen.vy > 0) { hit = Math.max(hit, pen.vy); pen.vy *= -0.72; } }
    penPoint(hit > 0);
    if (hit > 240 && now - pen.lastWall > 160) {
      pen.lastWall = now; pen.sq.v += 16;
      send({ t: 'wall', x: Math.round(pen.x), y: Math.round(pen.y) });
    }
  }
  spring(pen.sq, 0, dt, 200, 10);
  const sp = Math.hypot(pen.vx, pen.vy);
  if (sp > 520 && now - pen.lastSkid > 90) { pen.lastSkid = now; sfx('skid', { v: clamp(sp / 2200, 0, 1) }); }
  if (sp > 900 && now - pen.lastDust > 45) {
    pen.lastDust = now;
    addPart(0, pen.x, pen.y + 14, -pen.vx * 0.08, -pen.vy * 0.08 - 30, 0.28, 5, 'rgba(43,33,64,0.35)', 0);
  }
  if (!pen.down) {
    pen.coast += dt;
    if (pen.coast > 0.45 || sp < 35) { finishPen(); return; }
  }
  if (now - pen.lastFlush >= 50 && pen.pend.length) flushStroke(pen, 'pen', PEN_W, 0);
}

function onKey(e) {
  if (!shown || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const tg = e.target;
  if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
  if (e.key.length !== 1) return;
  const i = '1234'.indexOf(e.key);
  if (i >= 0) setTool(i);
}

// ---------- toolbar ----------
function mkBtn(draw, small) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = small ? 'rb dot' : 'rb';
  const px = small ? 28 : 40;
  if (small) b.style.cssText = 'width:44px;height:44px;min-width:44px;min-height:44px;flex:0 0 auto;padding:0';
  const c = document.createElement('canvas');
  c.width = c.height = px * 2;
  c.style.cssText = `width:${px}px;height:${px}px;display:block;margin:auto;pointer-events:none`;
  b.appendChild(c);
  toolsEl.appendChild(b);
  return { b, c, g: c.getContext('2d'), draw, px };
}
function paintIcon(o) {
  const g = o.g, k = o.c.width / 40;
  g.setTransform(k, 0, 0, k, 0, 0);
  g.clearRect(0, 0, 40, 40);
  g.lineCap = 'round'; g.lineJoin = 'round';
  o.draw(g);
}
function buildTools() {
  const icons = [icPen, icCushion, icEyes, icEraser];
  icons.forEach((fn, i) => {
    const o = mkBtn(fn, false);
    o.b.addEventListener('click', () => setTool(i));
    btn.tools.push(o);
  });
  btn.worm = mkBtn(icWorm, false);
  btn.worm.b.addEventListener('click', () => { if (!state.replaying) send({ t: 'worm', on: wormOn ? 0 : 1 }); });
  // fresh page: hold to confirm so one stray tap cannot wipe everybody's drawing
  btn.clear = mkBtn(icClear, false);
  const cb = btn.clear.b;
  cb.style.touchAction = 'none';
  cb.addEventListener('pointerdown', (e) => {
    if (state.replaying) return;
    clr.held = true; clr.t = 0;
    try { cb.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
  });
  const stop = () => {
    if (!clr.held) return;
    clr.held = false; clr.t = 0; paintIcon(btn.clear);
    sfx('nope');
  };
  cb.addEventListener('pointerup', stop);
  cb.addEventListener('pointercancel', stop);
  cb.addEventListener('contextmenu', (e) => e.preventDefault());
  // colours go last, after a row break the stylesheet uses where the tray wraps
  const brk = document.createElement('i');
  brk.className = 'brk'; brk.setAttribute('aria-hidden', 'true');
  toolsEl.appendChild(brk);
  PALETTE.forEach((col, i) => {
    const o = mkBtn((g) => icDot(g, col), true);
    o.b.addEventListener('click', () => setColor(i, true));
    btn.colors.push(o);
  });
  refreshButtons();
}
function refreshButtons() {
  btn.tools.forEach((o, i) => { o.b.classList.toggle('on', i === tool); paintIcon(o); });
  btn.colors.forEach((o, i) => { o.b.classList.toggle('on', i === color); paintIcon(o); });
  if (btn.worm) { btn.worm.b.classList.toggle('on', wormOn); paintIcon(btn.worm); }
  if (btn.clear) paintIcon(btn.clear);
}
function setTool(i) {
  if (i === tool) return;
  tool = i; refreshButtons();
  sfx('pop');
}
function setColor(i, picked) {
  if (picked) colorPicked = true;
  if (i === color) return;
  color = i; refreshButtons();
  if (picked) sfx('pop');
}

// icons live in a 40x40 box
function icPen(g) {
  const col = PALETTE[color];
  g.beginPath(); g.moveTo(5, 31); g.bezierCurveTo(9, 15, 15, 41, 21, 25);
  g.strokeStyle = OUTLINE; g.lineWidth = 8; g.stroke();
  g.strokeStyle = col; g.lineWidth = 4; g.stroke();
  g.beginPath(); g.arc(27, 15, 10, 0, TAU); g.fillStyle = col; g.fill();
  g.strokeStyle = OUTLINE; g.lineWidth = 3; g.stroke();
  googlyEye(g, 23.5, 13, 4, 0.7, -0.5, 1.6); googlyEye(g, 31, 13, 4, 0.7, -0.5, 1.6);
}
function icCushion(g) {
  const col = PALETTE[color];
  g.fillStyle = col; g.strokeStyle = OUTLINE; g.lineWidth = 3;
  g.beginPath(); g.moveTo(27, 18); g.lineTo(36, 16); g.lineTo(36, 26); g.lineTo(27, 24); g.closePath(); g.fill(); g.stroke();
  g.beginPath(); g.arc(17, 21, 13, 0, TAU); g.fill(); g.stroke();
  googlyEye(g, 12, 18, 4.2, 0.5, 0.2, 1.6); googlyEye(g, 21, 18, 4.2, 0.5, 0.2, 1.6);
  g.lineWidth = 2.2;
  g.beginPath(); g.moveTo(11, 27); g.lineTo(13.5, 25); g.lineTo(16, 27); g.lineTo(18.5, 25); g.lineTo(21, 27); g.stroke();
  g.beginPath(); g.moveTo(37, 9); g.lineTo(39, 6); g.moveTo(38.5, 32); g.lineTo(39.5, 35); g.stroke();
}
function icEyes(g) {
  googlyEye(g, 11.5, 20, 9, -0.6, 0.6, 3); googlyEye(g, 28.5, 20, 9, 0.3, 0.8, 3);
}
function icEraser(g) {
  g.save(); g.translate(20, 20); g.rotate(-0.6);
  rr(g, -14, -8, 28, 16, 4); g.fillStyle = PINK; g.fill();
  g.strokeStyle = OUTLINE; g.lineWidth = 3; g.stroke();
  g.save(); rr(g, -14, -8, 28, 16, 4); g.clip();
  g.fillStyle = '#3fa7ff'; g.fillRect(-14, -8, 11, 16);
  g.restore();
  g.beginPath(); g.moveTo(-3, -8); g.lineTo(-3, 8); g.stroke();
  rr(g, -14, -8, 28, 16, 4); g.stroke();
  googlyEye(g, 3, -1, 3.2, 0.6, 0.4, 1.4); googlyEye(g, 9.5, -1, 3.2, 0.6, 0.4, 1.4);
  g.restore();
  g.fillStyle = OUTLINE;
  g.beginPath(); g.arc(8, 34, 1.6, 0, TAU); g.arc(14, 36, 1.2, 0, TAU); g.fill();
}
function icDot(g, col) {
  g.beginPath(); g.arc(20, 20, 14, 0, TAU); g.fillStyle = col; g.fill();
  g.strokeStyle = OUTLINE; g.lineWidth = 4.5; g.stroke();
  g.beginPath(); g.arc(20, 20, 8.5, Math.PI * 1.05, Math.PI * 1.5);
  g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 3; g.stroke();
}
function icWorm(g) {
  g.strokeStyle = OUTLINE; g.lineWidth = 3; g.fillStyle = WORM_C;
  const pts = [[7, 29], [13, 24], [19, 28], [25, 23]];
  for (const [x, y] of pts) { g.beginPath(); g.arc(x, y, 5.5, 0, TAU); g.fill(); g.stroke(); }
  g.beginPath(); g.arc(30, 15, 8.5, 0, TAU); g.fill(); g.stroke();
  if (wormOn) {
    googlyEye(g, 27, 13, 3.4, 0.4, 0.7, 1.4); googlyEye(g, 33.5, 13, 3.4, 0.4, 0.7, 1.4);
    g.beginPath(); g.arc(30, 19.5, 1.8, 0, TAU); g.fillStyle = OUTLINE; g.fill();
    g.lineWidth = 2.2;                      // a little sound puff
    g.beginPath(); g.arc(11, 9, 3, 0, TAU); g.stroke();
    g.beginPath(); g.arc(18, 5, 1.8, 0, TAU); g.stroke();
  } else {
    g.lineWidth = 2.2;
    g.beginPath(); g.arc(27, 13, 2.6, 0.1 * Math.PI, 0.9 * Math.PI); g.stroke();
    g.beginPath(); g.arc(33.5, 13, 2.6, 0.1 * Math.PI, 0.9 * Math.PI); g.stroke();
  }
}
function icClear(g) {
  g.save(); g.translate(20, 21); g.rotate(-0.12);
  rr(g, -11, -14, 22, 27, 3); g.fillStyle = '#fffaf0'; g.fill();
  g.strokeStyle = OUTLINE; g.lineWidth = 3; g.stroke();
  g.beginPath(); g.moveTo(4, -14); g.lineTo(11, -7); g.lineTo(4, -7); g.closePath();
  g.fillStyle = '#ffc93c'; g.fill(); g.stroke();
  g.restore();
  g.fillStyle = '#ffc93c'; g.strokeStyle = OUTLINE; g.lineWidth = 2;      // sparkle
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4, r = i & 1 ? 2.2 : 6.5;
    const x = 8 + Math.cos(a) * r, y = 9 + Math.sin(a) * r;
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.closePath(); g.fill(); g.stroke();
  if (clr.held && clr.t > 0) {
    g.beginPath(); g.arc(20, 20, 17.5, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(clr.t / 0.7, 0, 1));
    g.strokeStyle = '#ff5a5f'; g.lineWidth = 4; g.stroke();
  }
}

// ---------- scanner worm ----------
const votes = new Uint16Array(PALETTE.length);
const inkList = new Uint8Array(BANDS), bandTim = new Uint8Array(BANDS), picks = new Uint8Array(3);
function wormStep(step, loopIdx) {
  const colX = Math.round((step + 0.5) / STEPS * ART_W);
  let d;
  try { d = actx.getImageData(clamp(colX - 1, 0, ART_W - 2), 0, 2, ART_H).data; } catch (e) { return; }
  const bh = Math.floor(ART_H / BANDS);
  let n = 0;
  for (let b = 0; b < BANDS; b++) {
    votes.fill(0);
    let cnt = 0;
    const i1 = (b + 1) * bh * 8;
    for (let i = b * bh * 8; i < i1; i += 4) {
      const r = d[i], gg = d[i + 1], bl = d[i + 2];
      if (Math.abs(r - PR) + Math.abs(gg - PG) + Math.abs(bl - PB) < 90) continue;
      cnt++;
      let best = 0, bd = 1e9;
      for (let q = 0; q < PAL_RGB.length; q++) {
        const c = PAL_RGB[q], dr = r - c[0], dg = gg - c[1], db = bl - c[2], dd = dr * dr + dg * dg + db * db;
        if (dd < bd) { bd = dd; best = q; }
      }
      votes[best]++;
    }
    if (cnt < 6) continue;
    let best = 0;
    for (let q = 1; q < votes.length; q++) if (votes[q] > votes[best]) best = q;
    bandTim[b] = best; inkList[n++] = b;
  }
  if (!n) return;
  if (n >= 8 && worm.gagLoop !== loopIdx) {           // too much ink: bleurgh
    worm.gagLoop = loopIdx; worm.gag = 1;
    sfx('gag');
    const rnd = rng((loopIdx * 33 + step + 7) >>> 0);
    for (let i = 0; i < 7; i++) {
      addPart(0, colX + (rnd() - 0.5) * 30, 74, (rnd() - 0.5) * 260, -60 - rnd() * 160, 0.7 + rnd() * 0.5, 5 + rnd() * 6, WORM_C, 900);
    }
    return;
  }
  let k = n;
  if (n <= 3) { for (let i = 0; i < n; i++) picks[i] = inkList[i]; }
  else {
    const off = step % Math.max(1, Math.floor(n / 3));
    picks[0] = inkList[off]; picks[1] = inkList[n >> 1]; picks[2] = inkList[n - 1 - off];
    k = 3;
  }
  const vol = k === 1 ? 0.9 : k === 2 ? 0.75 : 0.62;
  for (let i = 0; i < k; i++) {
    const b = picks[i], tim = bandTim[b];
    pluck(13 - b, tim, vol);                           // band 0 (top) -> SCALE[13], band 11 -> SCALE[2]
    const y = (b + 0.5) * bh;
    addPart(1, colX, y, 0, 0, 0.32, 30, PALETTE[tim], 0);
    addPart(0, colX + 16, y - 8, 120, -160, 0.3, 5, PALETTE[tim], 600);
  }
  worm.cheek.v += 9;
}
function wormTick(dt) {
  spring(worm.cheek, 0, dt, 160, 14);
  if (worm.gag > 0) worm.gag = Math.max(0, worm.gag - dt / 0.9);
  if (!wormOn || state.replaying || document.hidden) return;
  const now = Date.now();
  const sf = (now % LOOP) / LOOP * STEPS, step = Math.min(STEPS - 1, Math.floor(sf)), fr = sf - step;
  if (step !== worm.lastStep) { worm.lastStep = step; wormStep(step, Math.floor(now / LOOP)); }
  const k = Math.min(1, fr / 0.55), e = 1 - (1 - k) * (1 - k) * (1 - k);     // inch forward, then sit
  worm.x = (step - 0.5 + e) / STEPS * ART_W;
  worm.scr = Math.sin(k * Math.PI);
}
function drawWorm(g, t) {
  if (state.replaying) return;
  if (!wormOn) { drawSleepWorm(g, t); return; }
  const gag = worm.gag, ch = clamp(worm.cheek.x, 0, 1.3);
  const wx = worm.x + (gag > 0 ? Math.sin(t * 0.07) * 8 * gag : 0);
  g.save();
  g.globalAlpha = 0.34; g.fillStyle = WORM_C; g.strokeStyle = OUTLINE; g.lineWidth = 4;
  for (let i = 27; i >= 0; i--) {
    const y = 96 + i * 30;
    const sx = wx + Math.sin(t * 0.006 + i * 0.6) * (5 + 9 * worm.scr);
    g.beginPath(); g.arc(sx, y, 15 + 3 * Math.sin(i * 1.3) + 3 * worm.scr, 0, TAU); g.fill(); g.stroke();
  }
  g.restore();
  const hy = 52 + Math.sin(t * 0.008) * 3;
  g.strokeStyle = OUTLINE; g.lineWidth = 5;
  g.beginPath(); g.arc(wx, hy, 31, 0, TAU); g.fillStyle = WORM_C; g.fill(); g.stroke();
  g.fillStyle = PINK; g.lineWidth = 4;
  for (let s = -1; s <= 1; s += 2) {
    g.beginPath(); g.arc(wx + s * (27 + 6 * ch), hy + 10, 7 + 13 * ch, 0, TAU); g.fill(); g.stroke();
  }
  const er = 12 * (1 + 0.75 * gag);
  googlyEye(g, wx - 13, hy - 10, er, gag > 0 ? 0.9 : 0.3, gag > 0 ? 0 : 0.9, 4);
  googlyEye(g, wx + 13, hy - 10, er, gag > 0 ? -0.9 : 0.3, gag > 0 ? 0 : 0.9, 4);
  g.fillStyle = OUTLINE; g.lineWidth = 4;
  if (gag > 0) {
    g.beginPath(); g.ellipse(wx, hy + 16, 12, 9 * gag + 3, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(wx + 2, hy + 22 + 8 * gag, 6, 8 * gag + 2, 0, 0, TAU); g.fillStyle = '#ff5a5f'; g.fill(); g.stroke();
  } else if (ch > 0.12) {
    g.beginPath(); g.arc(wx, hy + 15, 4 + 5 * ch, 0, TAU); g.fill();
  } else {
    g.beginPath(); g.arc(wx, hy + 9, 9, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
  }
}
function drawSleepWorm(g, t) {
  const cxx = 82, cyy = ART_H - 72, br = 1 + Math.sin(t * 0.003) * 0.04;
  g.save();
  g.globalAlpha = 0.9; g.fillStyle = WORM_C; g.strokeStyle = OUTLINE; g.lineWidth = 4;
  for (let i = 0; i < 13; i++) {
    const a = i * 0.72 + 0.6, rad = (50 - i * 3.1) * br;
    g.beginPath(); g.arc(cxx + Math.cos(a) * rad, cyy + Math.sin(a) * rad * 0.8, 15 - i * 0.2, 0, TAU); g.fill(); g.stroke();
  }
  g.lineWidth = 5;
  g.beginPath(); g.arc(cxx, cyy - 2, 22 * br, 0, TAU); g.fill(); g.stroke();
  g.lineWidth = 3.5;
  g.beginPath(); g.arc(cxx - 9, cyy - 6, 5, 0.1 * Math.PI, 0.9 * Math.PI); g.stroke();
  g.beginPath(); g.arc(cxx + 9, cyy - 6, 5, 0.1 * Math.PI, 0.9 * Math.PI); g.stroke();
  g.beginPath(); g.arc(cxx, cyy + 8, 3, 0, TAU); g.fillStyle = OUTLINE; g.fill();
  g.fillStyle = '#ffffff'; g.lineWidth = 3;
  for (let i = 0; i < 3; i++) {           // snore bubbles
    const u = (t * 0.00035 + i / 3) % 1;
    g.globalAlpha = 0.9 * (1 - u);
    g.beginPath(); g.arc(cxx + 26 + u * 34 + Math.sin(u * 9 + i) * 6, cyy - 26 - u * 100, 4 + u * 10, 0, TAU); g.fill(); g.stroke();
  }
  g.restore();
}

// ---------- fx sprites ----------
function drawNib(g, x, y, vx, vy, col, sq, r) {
  const sp = Math.hypot(vx, vy), st = clamp(sp / 2400, 0, 0.55);
  g.save(); g.translate(x, y);
  if (sp > 20) g.rotate(Math.atan2(vy, vx));
  g.scale(1 + st - sq * 0.3, 1 - st * 0.45 + sq * 0.3);
  g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fillStyle = col; g.fill();
  g.lineWidth = 5; g.strokeStyle = OUTLINE; g.stroke();
  g.restore();
  const lx = clamp(vx / 500, -1, 1), ly = clamp(vy / 500, -1, 1);
  googlyEye(g, x - r * 0.4, y - r * 0.18, r * 0.38, lx, ly, 3);
  googlyEye(g, x + r * 0.4, y - r * 0.18, r * 0.38, lx, ly, 3);
}
// worry: 0..1 inflating (calm -> clenched), -1 = blowing off steam
function drawCushion(g, x, y, s, sx, sy, rot, col, worry) {
  const lw = clamp(s * 0.14, 3, 6);
  g.save(); g.translate(x, y); g.rotate(rot); g.scale(sx, sy);
  g.fillStyle = col; g.strokeStyle = OUTLINE; g.lineWidth = lw; g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath(); g.moveTo(-s * 0.8, -s * 0.22); g.lineTo(-s * 1.42, -s * 0.32); g.lineTo(-s * 1.42, s * 0.32); g.lineTo(-s * 0.8, s * 0.22);
  g.closePath(); g.fill(); g.stroke();
  g.beginPath(); g.arc(0, 0, s, 0, TAU); g.fill(); g.stroke();
  g.globalAlpha = 0.22; g.lineWidth = lw * 0.6;
  g.beginPath(); g.arc(0, 0, s * 0.74, 0, TAU); g.stroke();
  g.globalAlpha = 1; g.lineWidth = lw * 0.7;
  const w = Math.max(0, worry), er = s * 0.22 * (1 + 0.4 * w + (worry < 0 ? 0.3 : 0));
  googlyEye(g, -s * 0.3, -s * 0.2, er, worry < 0 ? 1 : 0, worry < 0 ? 0 : w * 0.8 - 0.3, lw * 0.6);
  googlyEye(g, s * 0.3, -s * 0.2, er, worry < 0 ? 1 : 0, worry < 0 ? 0 : w * 0.8 - 0.3, lw * 0.6);
  if (w > 0.3) {                           // worried brows
    g.beginPath();
    g.moveTo(-s * 0.52, -s * 0.5 - s * 0.14 * w); g.lineTo(-s * 0.14, -s * 0.5);
    g.moveTo(s * 0.52, -s * 0.5 - s * 0.14 * w); g.lineTo(s * 0.14, -s * 0.5);
    g.stroke();
  }
  if (worry < 0) {
    g.beginPath(); g.arc(0, s * 0.36, s * 0.2, 0, TAU); g.fillStyle = OUTLINE; g.fill();
  } else if (w < 0.35) {
    g.beginPath(); g.arc(0, s * 0.2, s * 0.3, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
  } else if (w < 0.75) {
    g.beginPath(); g.moveTo(-s * 0.32, s * 0.4);
    for (let i = 1; i <= 6; i++) g.lineTo(-s * 0.32 + i * s * 0.107, s * 0.4 + (i & 1 ? -1 : 1) * s * 0.07);
    g.stroke();
  } else {
    rr(g, -s * 0.34, s * 0.26, s * 0.68, s * 0.26, s * 0.08); g.fillStyle = '#ffffff'; g.fill(); g.stroke();
    g.beginPath();
    for (let i = 1; i < 4; i++) { g.moveTo(-s * 0.34 + i * s * 0.17, s * 0.26); g.lineTo(-s * 0.34 + i * s * 0.17, s * 0.52); }
    g.stroke();
  }
  g.restore();
}
function drawEyePairs(g, dt) {
  for (let i = 0; i < eyes.length; i++) {
    const e = eyes[i];
    spring(e.sq, 1, dt, 240, 9); spring(e.rot, 0, dt, 180, 7);
    e.nb -= dt;
    if (e.nb <= 0) { e.blink = 0.14; e.nb = 1.5 + Math.random() * 5; }
    if (e.blink > 0) e.blink -= dt;
    const dx = focus.x - e.x, dy = focus.y - e.y, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 200);
    const r = e.r, lw = clamp(r * 0.16, 3, 7);
    g.save(); g.translate(e.x, e.y); g.rotate(clamp(e.rot.x, -0.8, 0.8));
    g.scale(clamp(e.sq.x, 0.5, 1.9), clamp(2 - e.sq.x, 0.4, 1.6));
    if (e.blink > 0) {
      g.strokeStyle = OUTLINE; g.lineWidth = lw; g.lineCap = 'round';
      for (let s = -1; s <= 1; s += 2) {
        g.beginPath(); g.arc(s * r * 0.92, 0, r, 0, TAU); g.fillStyle = '#ffd9b0'; g.fill(); g.stroke();
        g.beginPath(); g.arc(s * r * 0.92, -r * 0.15, r * 0.6, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
      }
    } else {
      googlyEye(g, -r * 0.92, 0, r, dx / d * k, dy / d * k, lw);
      googlyEye(g, r * 0.92, 0, r, dx / d * k, dy / d * k, lw);
    }
    g.restore();
  }
}
function drawParts(g, dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.l -= dt;
    if (p.l <= 0) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
    const u = p.l / p.m;
    if (p.k === 1) {                        // expanding ring
      g.globalAlpha = u; g.lineWidth = 2 + 5 * u; g.strokeStyle = p.c;
      g.beginPath(); g.arc(p.x, p.y, p.r * (1.15 - u * 0.85), 0, TAU); g.stroke();
    } else {
      p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      g.globalAlpha = Math.min(1, u * 2); g.fillStyle = p.c;
      g.beginPath(); g.arc(p.x, p.y, p.r * (0.4 + 0.6 * u), 0, TAU); g.fill();
    }
  }
  g.globalAlpha = 1;
}
function drawPuffSprite(g, pf, dt, t) {
  const s = pf.sp, col = PALETTE[pf.c];
  s.t += dt * pf.speed;
  const u = s.t / s.dur;
  if (u < 1) {
    const d = dt * pf.speed;
    s.h += (Math.sin(s.t * s.f1 + s.p1) * 7 + Math.sin(s.t * s.f2 + s.p2) * 4) * d;
    const v = s.v * (1 - 0.55 * u);
    s.x += Math.cos(s.h) * v * d; s.y += Math.sin(s.h) * v * d;
    if (s.x < 30) { s.x = 30; s.h = Math.PI - s.h; } else if (s.x > ART_W - 30) { s.x = ART_W - 30; s.h = Math.PI - s.h; }
    if (s.y < 30) { s.y = 30; s.h = -s.h; } else if (s.y > ART_H - 30) { s.y = ART_H - 30; s.h = -s.h; }
    const size = lerp(s.s0, 15, u);
    s.tr -= dt;
    if (s.tr <= 0) {
      s.tr = 0.035;
      addPart(0, s.x - Math.cos(s.h) * size * 1.4, s.y - Math.sin(s.h) * size * 1.4, -Math.cos(s.h) * 90, -Math.sin(s.h) * 90, 0.3, 4 + size * 0.22, col, 0);
    }
    drawCushion(g, s.x, s.y, size, 1.15, 0.85 + Math.sin(t * 0.05) * 0.1, s.h, col, -1);
  } else {
    const k = (s.t - s.dur) / 0.45;
    if (k >= 1) { pf.sp = null; return; }
    g.globalAlpha = 1 - k * k;
    drawCushion(g, s.x, s.y, 15, 1.3, 0.5, s.h, col, 0);
    g.globalAlpha = 1;
  }
}
function drawPaperBall(g, x, y, r, rot) {
  g.save(); g.translate(x, y); g.rotate(rot);
  g.beginPath();
  for (let i = 0; i < 9; i++) {
    const a = i / 9 * TAU, rr2 = r * (0.84 + 0.2 * Math.sin(i * 2.7));
    if (i) g.lineTo(Math.cos(a) * rr2, Math.sin(a) * rr2); else g.moveTo(Math.cos(a) * rr2, Math.sin(a) * rr2);
  }
  g.closePath(); g.fillStyle = '#f5e4b5'; g.fill();
  g.strokeStyle = OUTLINE; g.lineWidth = 6; g.lineJoin = 'round'; g.stroke();
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(-r * 0.5, -r * 0.2); g.lineTo(0, r * 0.1); g.lineTo(r * 0.45, -r * 0.3);
  g.moveTo(-r * 0.1, r * 0.55); g.lineTo(r * 0.15, r * 0.1); g.stroke();
  g.restore();
}
function drawCrumple(g, dt) {
  crumple.t += dt;
  const u = crumple.t / 0.85;
  if (u >= 1) { crumple = null; return; }
  if (u < 0.5) {
    const k = u / 0.5, e = k * k * (3 - 2 * k), sc = lerp(1, 0.13, e), wob = Math.sin(k * 30) * 0.09 * k;
    if (sc > 0.3) {
      g.save(); g.translate(ART_W / 2, ART_H / 2); g.rotate(e * 1.3 + Math.sin(k * 14) * 0.08);
      g.scale(sc * (1 + wob), sc * (1 - wob));
      g.drawImage(crumpleCv, -ART_W / 2, -ART_H / 2, ART_W, ART_H);
      g.strokeStyle = OUTLINE; g.lineWidth = 6 / sc; g.lineJoin = 'round';
      g.strokeRect(-ART_W / 2, -ART_H / 2, ART_W, ART_H);
      g.restore();
    } else {
      drawPaperBall(g, ART_W / 2, ART_H / 2, ART_W * sc * 0.42 * (1 + wob), e * 1.3);
    }
  } else {
    const k = (u - 0.5) / 0.5;
    drawPaperBall(g, lerp(ART_W / 2, ART_W + 140, k), ART_H / 2 - Math.sin(k * Math.PI) * 280 + k * 220, 66, 1.3 + k * 10);
  }
}
function drawLocal(g, t, now) {
  if (pen.active) {
    if (pen.down) {                        // the elastic thread
      const dx = pen.x - pen.tx, dy = pen.y - pen.ty, len = Math.hypot(dx, dy) || 1;
      const slack = clamp(30 - len / 5, 0, 30), wob = Math.sin(t * 0.03) * clamp(len / 14, 0, 12);
      g.strokeStyle = OUTLINE; g.lineCap = 'round'; g.lineWidth = clamp(7 - len / 45, 2, 7);
      g.beginPath(); g.moveTo(pen.tx, pen.ty);
      g.quadraticCurveTo((pen.tx + pen.x) / 2 - dy / len * wob, (pen.ty + pen.y) / 2 + dx / len * wob + slack, pen.x, pen.y);
      g.stroke();
      g.beginPath(); g.arc(pen.tx, pen.ty, 9, 0, TAU); g.fillStyle = '#ffffff'; g.fill(); g.lineWidth = 4; g.stroke();
    }
    drawNib(g, pen.x, pen.y, pen.vx, pen.vy, PALETTE[pen.c], pen.sq.x, 20);
  }
  if (ges.pid !== null) {
    const secs = (now - ges.t0) / 1000;
    if (ges.tool === 1) {
      const p = clamp(secs / 1.5, 0, 1), sh = Math.sin(t * 0.09) * 5 * p, wb = Math.sin(t * 0.05) * 0.07 * p;
      drawCushion(g, clamp(ges.x, 0, ART_W) + sh, clamp(ges.y, 0, ART_H), 26 + 70 * p, 1 + wb, 1 - wb, Math.sin(t * 0.021) * 0.1 * p, PALETTE[color], p);
      if (now - lastSqueak > (p >= 1 ? 240 : 110)) { lastSqueak = now; sfx('squeak', { p }); }
      if (p > 0.7 && Math.random() < 0.25) addPart(0, ges.x + (Math.random() - 0.5) * 120 * p, ges.y - 60 * p, (Math.random() - 0.5) * 200, -200, 0.35, 5, '#3fa7ff', 900);
    } else if (ges.tool === 2) {
      const r = eyeR(secs), x = clamp(ges.x, 0, ART_W), y = clamp(ges.y, 0, ART_H) - 10 - Math.abs(Math.sin(t * 0.012)) * 8;
      g.globalAlpha = 0.8;
      googlyEye(g, x - r * 0.92, y, r, 0, 0.9, clamp(r * 0.16, 3, 7));
      googlyEye(g, x + r * 0.92, y, r, 0, 0.9, clamp(r * 0.16, 3, 7));
      g.globalAlpha = 1;
    } else if (ges.tool === 3) drawEraser(g, clamp(ges.x, 0, ART_W), clamp(ges.y, 0, ART_H), Math.sin(t * 0.05) * 0.15);
  } else if (hover && !state.replaying) {
    if (tool === 0) { if (!pen.active) drawNib(g, hover.x, hover.y, 0, 0, PALETTE[color], 0, 15); }
    else if (tool === 1) drawCushion(g, hover.x, hover.y, 20, 1, 1, 0, PALETTE[color], 0);
    else if (tool === 2) {
      g.globalAlpha = 0.6;
      googlyEye(g, hover.x - 13, hover.y, EYE_MIN, 0, 0.8, 3); googlyEye(g, hover.x + 13, hover.y, EYE_MIN, 0, 0.8, 3);
      g.globalAlpha = 1;
    } else drawEraser(g, hover.x, hover.y, 0);
  }
}
function drawEraser(g, x, y, rot) {
  g.save(); g.translate(x, y);
  g.beginPath(); g.arc(0, 0, ERASE_W / 2, 0, TAU);
  g.fillStyle = 'rgba(255,155,176,0.35)'; g.fill();
  g.strokeStyle = OUTLINE; g.lineWidth = 3; g.setLineDash([7, 7]); g.stroke(); g.setLineDash([]);
  g.rotate(rot - 0.5);
  rr(g, -15, -10, 30, 20, 5); g.fillStyle = PINK; g.fill(); g.lineWidth = 4; g.stroke();
  googlyEye(g, -6, -1, 4.5, 0, 0.8, 2); googlyEye(g, 6, -1, 4.5, 0, 0.8, 2);
  g.restore();
}
function drawGhosts(g, dt) {               // other players' nibs / erasers, from their live strokes
  const a = 1 - Math.exp(-dt * 22);
  for (const st of strokes.values()) {
    if (st.local || !st.n) continue;
    st.gx = lerp(st.gx, st.x, a); st.gy = lerp(st.gy, st.y, a);
    if (st.erase) {
      g.beginPath(); g.arc(st.gx, st.gy, st.w / 2, 0, TAU);
      g.strokeStyle = OUTLINE; g.lineWidth = 3; g.setLineDash([7, 7]); g.stroke(); g.setLineDash([]);
    } else drawNib(g, st.gx, st.gy, (st.x - st.gx) * 14, (st.y - st.gy) * 14, PALETTE[st.c], 0, 13);
  }
}

// ---------- frame ----------
function onTick(d) {
  if (!actx) return;
  const dt = d && isNum(d.dt) ? clamp(d.dt, 0, 0.1) : 1 / 60;
  const t = d && isNum(d.t) ? d.t : performance.now();
  const now = performance.now();

  if (held.length && !state.replaying && !syncLoading) {
    const q = held; held = [];
    for (const m of q) applyOp(m, { quiet: true });
  }
  if (state.replaying) {
    if (ges.pid !== null || pen.active) abortGesture();
    clr.held = false;
  } else {
    if (pen.active) penTick(dt, now);
    if (ges.pid !== null && ges.tool === 3 && era.pend.length && now - era.lastFlush >= 50) flushStroke(era, 'erase', ERASE_W, 0);
    if (clr.held) {
      clr.t += dt;
      if (clr.t >= 0.7) { clr.held = false; clr.t = 0; send({ t: 'clear' }); }
      paintIcon(btn.clear);
    }
  }

  for (let i = puffs.length - 1; i >= 0; i--) {
    const pf = puffs[i];
    if (!pf.done) { pf.t += dt * pf.speed; paintPuff(pf, pf.t / pf.dur); }
    if (!shown) pf.sp = null;
    if (pf.done && !pf.sp) puffs.splice(i, 1);
  }
  if (now - lastStale > 1000) {
    lastStale = now;
    for (const [k, st] of strokes) if (now - st.t > 5000) endStroke(k, st);
  }

  // re-check visibility now and then, so the worm goes quiet if the game screen is hidden again
  if ((frame++ & 31) === 0) shown = fx.getClientRects().length > 0;
  if (!shown) { parts.length = 0; return; }
  wormTick(dt);
  const fk = 1 - Math.exp(-dt * 12);
  focus.x = lerp(focus.x, focus.tx, fk); focus.y = lerp(focus.y, focus.ty, fk);

  const g = fctx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.clearRect(0, 0, ART_W, ART_H);
  g.lineCap = 'round'; g.lineJoin = 'round';
  drawWorm(g, t);
  drawEyePairs(g, dt);
  drawParts(g, dt);
  for (let i = 0; i < puffs.length; i++) if (puffs[i].sp) drawPuffSprite(g, puffs[i], dt, t);
  drawGhosts(g, dt);
  drawLocal(g, t, now);
  if (crumple) drawCrumple(g, dt);
}
