// FROG JAM — shell: lobby, screen switching, layout events, and the one rAF loop.
import { state, bus, send, OUTLINE, PLAYER_COLORS, clamp, spring, googlyEye, fitCanvas } from './bus.js';
import * as net from './net.js';
import * as audio from './audio.js';
import * as draw from './draw.js';
import * as instruments from './instruments.js';
import * as party from './party.js';

window.__fj = { state, bus, send };

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
const safe = (fn, ...a) => {
  try {
    const r = typeof fn === 'function' ? fn(...a) : undefined;
    if (r && typeof r.catch === 'function') r.catch((e) => console.error('[main]', e));
    return r;
  } catch (e) { console.error('[main]', e); }
};
const sfx = (name, o) => { safe(audio.sfx, name, o); };
const initAudio = () => { safe(audio.initAudio); };
const restartAnim = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };

const lobby = $('lobby'), game = $('game');
const codebox = $('codebox'), codein = $('codein');
const boxes = Array.from(codebox.querySelectorAll('.cb'));
const letters = boxes.map((b) => b.firstElementChild);
const diceBtn = $('dice'), playBtn = $('play');
const leaveBtn = $('leave'), shareBtn = $('share');
const roomcode = $('roomcode'), netbad = $('netbad');
const mascot = $('mascot'), hop = $('hop');

let phase = 'lobby'; // 'lobby' | 'joining' | 'game'

// ---------- the other modules ----------
safe(draw.init);
safe(instruments.init);
safe(party.init);

// =====================================================================
// Room code
// =====================================================================
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, no O
const clean = (s) => {
  let o = '';
  for (const ch of String(s == null ? '' : s).toUpperCase()) if (ch.length === 1 && ALPHA.includes(ch)) o += ch;
  return o;
};
// Pull a code out of arbitrary text (a bare code, or a pasted link ending in #CODE).
function codeFrom(text) {
  const s = String(text == null ? '' : text).slice(0, 2000);
  const hash = s.lastIndexOf('#');
  if (hash >= 0) { const c = clean(s.slice(hash + 1)).slice(0, 4); if (c.length === 4) return c; }
  const words = s.match(/[A-Za-z]+/g) || [];
  for (let i = words.length - 1; i >= 0; i--) {
    if (words[i].length === 4 && clean(words[i]).length === 4) return clean(words[i]);
  }
  return clean(s).slice(0, 4);
}
const hashCode = () => {
  const h = location.hash.slice(1);
  return /^[A-Za-z]{4}$/.test(h) && clean(h).length === 4 ? clean(h) : '';
};
const randomLetter = () => ALPHA[(Math.random() * ALPHA.length) | 0];

let prevCode = '';
let focused = false;
let rollTimers = [];
const tumbling = [false, false, false, false];

function renderBoxes() {
  const v = codein.value;
  for (let i = 0; i < 4; i++) {
    if (!tumbling[i]) letters[i].textContent = v[i] || '';
    boxes[i].classList.toggle('cur', focused && (v.length === 4 || i === v.length));
  }
}
function stopTumble() {
  for (const id of rollTimers) { clearTimeout(id); clearInterval(id); }
  rollTimers = [];
  for (let i = 0; i < 4; i++) { tumbling[i] = false; boxes[i].classList.remove('tumble'); }
}
function setCode(v, land) {
  stopTumble();
  codein.value = prevCode = v;
  renderBoxes();
  if (land) boxes.forEach((b, i) => { if (v[i]) restartAnim(b, 'land'); });
}
function caretToEnd() {
  try { const n = codein.value.length; codein.setSelectionRange(n, n); } catch (e) { /* not focusable yet */ }
}
function focusCode() {
  if (codein.disabled) return;
  try { codein.focus({ preventScroll: true }); } catch (e) { codein.focus(); }
  caretToEnd();
}

// Dice: pick the code right away, then let the boxes tumble into place one by one.
function roll(silent) {
  stopTumble();
  let code = '';
  for (let i = 0; i < 4; i++) code += randomLetter();
  codein.value = prevCode = code;
  boxes.forEach((b, i) => {
    tumbling[i] = true;
    b.classList.remove('land');
    b.classList.add('tumble');
    const iv = setInterval(() => { letters[i].textContent = randomLetter(); }, 55);
    const to = setTimeout(() => {
      clearInterval(iv);
      tumbling[i] = false;
      b.classList.remove('tumble');
      letters[i].textContent = code[i];
      restartAnim(b, 'land');
      if (!silent) sfx('pop');
    }, 300 + i * 150);
    rollTimers.push(iv, to);
  });
  renderBoxes();
}

codein.addEventListener('input', () => {
  stopTumble();
  let v = clean(codein.value);
  // Typing into a full row starts a fresh code instead of doing nothing.
  if (v.length > 4 && prevCode.length === 4 && v.startsWith(prevCode)) v = v.slice(4);
  v = v.slice(0, 4);
  if (codein.value !== v) codein.value = v;
  if (v.length && v !== prevCode) restartAnim(boxes[v.length - 1], 'land');
  prevCode = v;
  caretToEnd();
  renderBoxes();
});
codein.addEventListener('focus', () => { focused = true; codebox.classList.add('focus'); caretToEnd(); renderBoxes(); });
codein.addEventListener('blur', () => { focused = false; codebox.classList.remove('focus'); renderBoxes(); });
codein.addEventListener('click', caretToEnd);
codein.addEventListener('keyup', caretToEnd);

document.addEventListener('paste', (e) => {
  if (phase !== 'lobby') return;
  const t = e.clipboardData ? e.clipboardData.getData('text') : '';
  e.preventDefault();
  const c = codeFrom(t);
  if (c) setCode(c, true);
});

document.addEventListener('keydown', (e) => {
  if (phase !== 'lobby' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Enter') {
    if (e.target instanceof HTMLButtonElement) return; // the button's own click handles it
    e.preventDefault();
    play();
  } else if (e.target !== codein && typeof e.key === 'string' && /^[a-z]$/i.test(e.key)) {
    focusCode();
  }
});

window.addEventListener('hashchange', () => {
  if (phase !== 'lobby') return;
  const c = hashCode();
  if (c && c !== codein.value) setCode(c, true);
});

function setHash(code) {
  const base = location.href.split('#')[0];
  try { history.replaceState(null, '', code ? base + '#' + code : base); }
  catch (e) { try { location.hash = code || ''; } catch (e2) { /* sandboxed */ } }
}

// =====================================================================
// Joining / leaving
// =====================================================================
let joinSeq = 0, joinTimer = 0;

function nope() {
  restartAnim(codebox, 'shake');
  frog.dizzy = 0.75;
  frog.sq.v -= 1.6;
  sfx('nope');
}
function joinFailed() {
  clearTimeout(joinTimer);
  phase = 'lobby';
  lobby.classList.remove('joining');
  codein.disabled = false;
  nope();
}

async function play() {
  if (phase !== 'lobby') return;
  initAudio(); // must happen inside the gesture
  const code = codein.value;
  if (code.length !== 4) { nope(); focusCode(); return; }
  setCode(code, false);
  phase = 'joining';
  lobby.classList.add('joining');
  codein.disabled = true;
  hopDirty = true;
  const seq = ++joinSeq;
  const giveUp = () => {
    if (seq !== joinSeq || phase !== 'joining') return;
    safe(net.leave);
    joinFailed();
  };
  clearTimeout(joinTimer);
  joinTimer = setTimeout(giveUp, 20000);
  try { await net.join(code); }
  catch (e) { console.error('[main] join failed', e); giveUp(); }
}

function showGame(code) {
  clearTimeout(joinTimer);
  phase = 'game';
  roomcode.textContent = code;
  setHash(code);
  lobby.classList.remove('joining');
  codein.disabled = false;
  codein.blur();
  lobby.hidden = true;
  game.hidden = false;
  netbad.hidden = true;
  bus.emit('layout');
  scheduleLayout();
  clearTimeout(lateLayout);
  lateLayout = setTimeout(emitLayout, 300); // mobile browsers settle late
  sfx('join');
}
function showLobby() {
  clearTimeout(joinTimer);
  phase = 'lobby';
  game.hidden = true;
  lobby.hidden = false;
  lobby.classList.remove('joining');
  codein.disabled = false;
  mascotDirty = hopDirty = true;
  renderBoxes();
}

bus.on('joined', (e) => {
  const code = clean((e && e.room) || state.room || codein.value).slice(0, 4);
  if (phase === 'game') { if (code) roomcode.textContent = code; return; } // e.g. a reconnect
  if (phase !== 'joining') return;
  showGame(code);
});
bus.on('full', () => {
  if (phase === 'joining') joinFailed();
  else if (phase === 'game') {
    // Evicted after joining (lost a slot fight in a full room): net.js has already
    // torn the session down, so go back to the lobby instead of a dead game screen.
    safe(draw.blank);
    setHash('');
    showLobby();
    nope();
  }
});
bus.on('net', (e) => { netbad.hidden = !(e && e.ok === false); });

playBtn.addEventListener('click', play);
diceBtn.addEventListener('click', () => {
  if (phase !== 'lobby') return;
  initAudio();
  restartAnim(diceBtn, 'spin');
  frog.sq.v += 1.5;
  roll(false);
});

leaveBtn.addEventListener('click', () => {
  if (phase !== 'game') return;
  sfx('leave');
  safe(net.leave);
  safe(draw.blank); // next room starts on a clean page
  setHash('');
  showLobby();
});

async function copyText(s) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(s); return true; }
  } catch (e) { /* fall through to the old way */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-999px;top:0;opacity:0;font-size:16px;-webkit-user-select:text;user-select:text';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (e) { return false; }
}
let okTimer = 0;
shareBtn.addEventListener('click', async () => {
  if (phase !== 'game') return;
  const code = clean(state.room || roomcode.textContent).slice(0, 4);
  const url = location.href.split('#')[0] + '#' + code;
  let ok = false;
  if (typeof navigator.share === 'function') {
    try { await navigator.share({ url }); ok = true; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  if (!ok) ok = await copyText(url);
  if (!ok) { sfx('nope'); return; }
  restartAnim(shareBtn, 'ok');
  sfx('pop');
  clearTimeout(okTimer);
  okTimer = setTimeout(() => shareBtn.classList.remove('ok'), 1400);
});

// Free our slot when the page goes away; if it comes back from the bfcache, start over.
window.addEventListener('pagehide', () => { if (phase !== 'lobby') safe(net.leave); });
window.addEventListener('pageshow', (e) => { if (e.persisted && phase !== 'lobby') showLobby(); });

// =====================================================================
// Layout events
// =====================================================================
let layoutRaf = 0, lateLayout = 0;
let mascotDirty = true, hopDirty = true;

function emitLayout() { if (phase === 'game') bus.emit('layout'); }
function scheduleLayout() {
  mascotDirty = hopDirty = true;
  if (layoutRaf) return;
  layoutRaf = requestAnimationFrame(() => { layoutRaf = 0; emitLayout(); });
}
window.addEventListener('resize', scheduleLayout);
window.addEventListener('orientationchange', () => {
  scheduleLayout();
  clearTimeout(lateLayout);
  lateLayout = setTimeout(() => { mascotDirty = hopDirty = true; emitLayout(); }, 300);
});
if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleLayout);
if (typeof ResizeObserver === 'function') {
  const ro = new ResizeObserver(scheduleLayout);
  for (const id of ['stage', 'frogs', 'inst', 'mascot', 'hop']) { const el = $(id); if (el) ro.observe(el); }
}

// =====================================================================
// No zoom, no pull-to-refresh, no context menu
// =====================================================================
const stop = (e) => { if (e.cancelable) e.preventDefault(); };
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, stop, { passive: false });
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) return stop(e); // pinch
  if (phase !== 'game') return;
  const el = e.target;
  if (el instanceof Element && el.closest('#tools, #chaos, #instpick')) return; // those trays may scroll
  stop(e);
}, { passive: false });
document.addEventListener('wheel', (e) => { if (e.ctrlKey && phase === 'game') stop(e); }, { passive: false });
document.addEventListener('dblclick', stop);
document.addEventListener('dragstart', stop);
document.addEventListener('contextmenu', (e) => { if (e.target !== codein) stop(e); });

// =====================================================================
// The frog (lobby mascot + little hopping loader)
// =====================================================================
const TAU = Math.PI * 2;
const GREEN = PLAYER_COLORS[3], BELLY = '#c4f3a4', SAC = '#fff0a6';
const path = (fn) => { const p = new Path2D(); fn(p); return p; };
// Local units: origin at the ground under the frog, y up is negative, ~250 wide, ~170 tall.
const FROG_SIL = [
  path((p) => p.ellipse(-84, -40, 36, 42, -0.35, 0, TAU)), // thighs
  path((p) => p.ellipse(84, -40, 36, 42, 0.35, 0, TAU)),
  path((p) => p.arc(-50, -126, 36, 0, TAU)),               // eye bumps
  path((p) => p.arc(50, -126, 36, 0, TAU)),
  path((p) => p.ellipse(0, -72, 100, 72, 0, 0, TAU)),      // body
];
const FROG_FEET = [
  path((p) => p.ellipse(-44, -8, 24, 12, 0, 0, TAU)),
  path((p) => p.ellipse(44, -8, 24, 12, 0, 0, TAU)),
];

// sq: squash (+ = flat and wide), lx/ly: look direction, blink 0..1, sac 0..1, mouth 0..1, lw: outline width.
function drawFrog(ctx, x, y, s, sq, lx, ly, blink, sac, mouth, lw) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s * (1 + sq), s * (1 - sq));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = OUTLINE;

  // one merged silhouette: fat strokes first, fills on top
  ctx.lineWidth = lw * 2;
  for (const p of FROG_SIL) ctx.stroke(p);
  ctx.fillStyle = GREEN;
  for (const p of FROG_SIL) ctx.fill(p);

  ctx.fillStyle = BELLY;
  ctx.beginPath(); ctx.ellipse(0, -48, 60, 42, 0, 0, TAU); ctx.fill();

  ctx.lineWidth = lw;
  ctx.fillStyle = GREEN;
  for (const p of FROG_FEET) { ctx.fill(p); ctx.stroke(p); }

  // throat sac: a little pouch when idle, a ridiculous balloon when croaking
  const rs = Math.max(4, 20 + 40 * sac), sy = -62 + rs * 0.62;
  ctx.beginPath(); ctx.arc(0, sy, rs, 0, TAU);
  ctx.fillStyle = SAC; ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(-rs * 0.4, sy - rs * 0.42, rs * 0.2, rs * 0.11, -0.7, 0, TAU);
  ctx.fillStyle = '#fff'; ctx.fill();

  ctx.fillStyle = '#ff9aa2';
  ctx.beginPath(); ctx.arc(-77, -84, 10, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(77, -84, 10, 0, TAU); ctx.fill();

  const mo = clamp(mouth, 0, 1.3);
  ctx.beginPath();
  ctx.moveTo(-56, -94);
  if (mo > 0.04) {
    ctx.quadraticCurveTo(0, -84, 56, -94);
    ctx.quadraticCurveTo(0, -72 + 54 * mo, -56, -94);
    ctx.closePath();
    ctx.fillStyle = '#8a2a4c'; ctx.fill();
  } else {
    ctx.quadraticCurveTo(0, -70, 56, -94);
  }
  ctx.stroke();

  ctx.fillStyle = OUTLINE;
  ctx.beginPath(); ctx.arc(-8, -110, 2.6, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(8, -110, 2.6, 0, TAU); ctx.fill();

  for (let i = -1; i <= 1; i += 2) {
    const ex = 50 * i, ey = -130, er = 26;
    googlyEye(ctx, ex, ey, er, lx, ly, lw);
    if (blink > 0.03) {
      const lid = (er * 2 + 2) * Math.min(1, blink);
      ctx.save();
      ctx.beginPath(); ctx.arc(ex, ey, er, 0, TAU); ctx.clip();
      ctx.fillStyle = GREEN; ctx.fillRect(ex - er - 1, ey - er - 1, er * 2 + 2, lid);
      ctx.fillStyle = OUTLINE; ctx.fillRect(ex - er - 1, ey - er - 1 + lid - lw * 0.5, er * 2 + 2, lw);
      ctx.restore();
      ctx.beginPath(); ctx.arc(ex, ey, er, 0, TAU); ctx.lineWidth = lw; ctx.stroke();
    }
  }
  ctx.restore();
}

const frog = {
  sq: { x: 0, v: 0 }, sac: { x: 0.2, v: 0 }, mouth: { x: 0, v: 0 },
  lx: 0, ly: 0, blinkT: 0, nextBlink: 1.2, croak: 0, dizzy: 0,
  px: 0, py: 0, ptrAt: -1e9,
};
const BLINK = 0.17;
const mctx = mascot.getContext('2d'), hctx = hop.getContext('2d');
let msize = { w: 0, h: 0, dpr: 1 }, mrect = { left: 0, top: 0, width: 0, height: 0 };
let hsize = { w: 0, h: 0, dpr: 1 };
let hopPhase = 0;

const trackPointer = (e) => { frog.px = e.clientX; frog.py = e.clientY; frog.ptrAt = performance.now(); };
window.addEventListener('pointermove', trackPointer, { passive: true });
window.addEventListener('pointerdown', trackPointer, { passive: true });

mascot.addEventListener('pointerdown', () => {
  if (phase === 'game') return;
  initAudio();
  frog.croak = 0.45;
  frog.sq.v += 2.4;
  sfx('croak', { slot: (Math.random() * 4) | 0 });
});

function tickMascot(t, dt) {
  if (mascotDirty) { msize = fitCanvas(mascot); mrect = mascot.getBoundingClientRect(); mascotDirty = false; }
  const w = msize.w, h = msize.h;
  if (w < 4 || h < 4) return;

  // where to look: dizzy spin > the loader > the pointer > daydreaming
  let tx, ty;
  if (frog.dizzy > 0) {
    frog.dizzy -= dt; tx = Math.cos(t * 0.03); ty = Math.sin(t * 0.03);
  } else if (phase === 'joining') {
    tx = Math.sin(t * 0.005) * 0.35; ty = 1;
  } else if (t - frog.ptrAt < 2500) {
    const dx = frog.px - (mrect.left + mrect.width / 2), dy = frog.py - (mrect.top + mrect.height * 0.35);
    const d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 150);
    tx = (dx / d) * k; ty = (dy / d) * k;
  } else {
    tx = Math.sin(t * 0.0011) * 0.75; ty = Math.sin(t * 0.0017 + 1) * 0.45;
  }
  const a = 1 - Math.exp(-dt * (frog.dizzy > 0 ? 40 : 14));
  frog.lx += (tx - frog.lx) * a; frog.ly += (ty - frog.ly) * a;

  frog.nextBlink -= dt;
  if (frog.nextBlink <= 0) { frog.blinkT = BLINK; frog.nextBlink = Math.random() < 0.2 ? 0.3 : 1.4 + Math.random() * 3; }
  let blink = 0;
  if (frog.blinkT > 0) { frog.blinkT -= dt; blink = Math.sin(Math.PI * clamp(1 - frog.blinkT / BLINK, 0, 1)) * 1.25; }

  if (frog.croak > 0) frog.croak -= dt;
  const breath = Math.sin(t * 0.0042);
  spring(frog.sac, frog.croak > 0 ? 1 : 0.17 + 0.1 * breath, dt, 220, 10);
  spring(frog.mouth, frog.croak > 0 ? 1 : 0, dt, 260, 16);
  spring(frog.sq, 0, dt, 200, 9);
  const sq = clamp(frog.sq.x + 0.012 * breath, -0.35, 0.35);

  mctx.setTransform(msize.dpr, 0, 0, msize.dpr, 0, 0);
  mctx.clearRect(0, 0, w, h);
  const s = Math.min(w / 300, h / 236); // headroom for squash, stretch and the croak balloon
  drawFrog(mctx, w / 2, h - 46 * s, s, sq, frog.lx, frog.ly, blink, frog.sac.x, frog.mouth.x, 6);
}

// Loader: a small frog hopping in place while lily pads slide under it.
function tickHop(t, dt) {
  if (hopDirty) { hsize = fitCanvas(hop); hopDirty = false; }
  const w = hsize.w, h = hsize.h;
  if (w < 4 || h < 4) return;
  hopPhase += dt / 0.46;
  const u = hopPhase % 1;
  const cx = w / 2, gy = h - 18, step = Math.min(86, w / 3);

  hctx.setTransform(hsize.dpr, 0, 0, hsize.dpr, 0, 0);
  hctx.clearRect(0, 0, w, h);
  hctx.lineWidth = 4; hctx.strokeStyle = OUTLINE; hctx.fillStyle = '#38c172';
  for (let k = -2; k <= 2; k++) {
    const x = cx + (k - u) * step;
    const alpha = clamp(1.7 - Math.abs(x - cx) / (step * 0.9), 0, 1);
    if (alpha <= 0) continue;
    hctx.globalAlpha = alpha;
    hctx.beginPath(); hctx.ellipse(x, gy, 27, 9, 0, 0, TAU); hctx.fill(); hctx.stroke();
  }
  hctx.globalAlpha = 1;

  const air = Math.sin(Math.PI * u);
  const land = u < 0.2 ? 1 - u / 0.2 : 0;
  const s = clamp(h / 350, 0.18, 0.34);
  drawFrog(hctx, cx, gy - 2 - air * h * 0.22, s, land * 0.3 - air * 0.13, 0.7, air > 0.5 ? -0.5 : 0.4, 0, 0.2 + land * 0.5, air * 0.5, 11);
}

// =====================================================================
// The one animation loop
// =====================================================================
bus.on('tick', ({ t, dt }) => {
  if (phase === 'game') return;
  tickMascot(t, dt);
  if (phase === 'joining') tickHop(t, dt);
});

let lastT = performance.now();
function frame(t) {
  const dt = clamp((t - lastT) / 1000, 0, 0.05);
  lastT = t;
  bus.emit('tick', { t, dt });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// =====================================================================
// Boot: a code is always ready, so the fastest path is "open page, hit play"
// =====================================================================
{
  const c = hashCode();
  if (c) setCode(c, true); else roll(true);
  if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) focusCode();
}
