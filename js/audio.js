// FROG JAM — audio.js. Every sound in the game, synthesized with the Web Audio API.
// No samples. Everything here is a safe no-op until initAudio() has run.
//
// Signal path:
//   voice -> player channel (gain -> lowpass, the pie muffle) -+-> pre -> master -> compressor -> out
//   voice -> sfxIn (effects, plucks, unknown senders) ---------+     \-> small feedback-delay "room" -> master
import { bus, state, SCALE, midiHz, clamp, lerp } from './bus.js';

const MAX_VOICES = 28;
const MAX_PLUCKS = 10;
const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;

let ctx = null;
let pre = null, master = null, analyser = null, sfxIn = null;
let noiseBuf = null, driveCurve = null, levelBuf = null;
let OPEN = 18000;                 // "wide open" cutoff for the player channel lowpass

const chans = new Map();          // playerId -> {g, lp, pied}
const voices = [];                // live voices, oldest first
const held = new Map();           // sustained voices by key: '<from>|g<k>' (goose), '<from>|w' (whistle)

let level = 0, levelAt = 0;
let tokens = 60, tokensAt = 0;

// ---------- setup ----------
export function initAudio() {
  if (!AC) return;
  if (!ctx) {
    try { build(); } catch (e) { console.warn('[audio] unavailable', e); ctx = null; return; }
  }
  wake();
  // iOS: a (silent) source started inside the gesture unlocks output.
  try {
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    s.connect(ctx.destination); s.start(0);
    s.onended = () => { try { s.disconnect(); } catch { /* gone */ } };
  } catch { /* fine */ }
}

function build() {
  let c;
  try { c = new AC({ latencyHint: 'interactive' }); } catch { c = new AC(); }
  // Play through the iOS ringer/silent switch where the browser lets us.
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* fine */ }
  const sr = c.sampleRate;
  OPEN = Math.min(18000, sr * 0.45);

  noiseBuf = c.createBuffer(1, Math.floor(sr * 2), sr);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  driveCurve = new Float32Array(257);
  for (let i = 0; i < 257; i++) driveCurve[i] = Math.tanh(((i - 128) / 128) * 2.2);

  pre = c.createGain();
  master = c.createGain(); master.gain.value = 0.85;
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 9;
  comp.attack.value = 0.003; comp.release.value = 0.18;
  analyser = c.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0;
  levelBuf = new Uint8Array(analyser.fftSize);
  pre.connect(master); master.connect(comp); comp.connect(c.destination); comp.connect(analyser);

  // Cheap "room": two short delays sharing one damped feedback path.
  const sendG = c.createGain(); sendG.gain.value = 0.15;
  const d1 = c.createDelay(0.5), d2 = c.createDelay(0.5);
  d1.delayTime.value = 0.061; d2.delayTime.value = 0.103;
  const damp = c.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = 2400;
  const fb = c.createGain(); fb.gain.value = 0.3;
  pre.connect(sendG); sendG.connect(d1); sendG.connect(d2);
  d1.connect(damp); d2.connect(damp); damp.connect(fb); fb.connect(d1); fb.connect(d2);
  damp.connect(master);

  sfxIn = c.createGain(); sfxIn.connect(pre);
  ctx = c;
}

function wake() {
  if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
  try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch { /* fine */ }
}

if (typeof window !== 'undefined') {
  // iOS suspends ("interrupts") the context again after backgrounding, so this stays armed.
  const opt = { capture: true, passive: true };
  for (const ev of ['pointerdown', 'pointerup', 'touchend', 'keydown']) window.addEventListener(ev, wake, opt);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
}

// ---------- player channels (pie muffle) ----------
function setPied(c, pied, t) {
  if (c.pied === pied) return;
  c.pied = pied;
  c.lp.frequency.setTargetAtTime(pied ? 400 : OPEN, t, 0.09);
  c.g.gain.setTargetAtTime(pied ? 1.6 : 1, t, 0.09);   // a little make-up so "mmff" is still audible
}

function chanFor(id) {
  const p = id ? state.players.get(id) : null;
  if (!p) return sfxIn;
  let c = chans.get(id);
  if (!c) {
    const g = ctx.createGain(), lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = OPEN; lp.Q.value = 0.8;
    g.connect(lp); lp.connect(pre);
    c = { g, lp, pied: false };
    chans.set(id, c);
    setPied(c, !!p.pied, ctx.currentTime);
  }
  return c.g;
}

bus.on('players', () => {
  if (!ctx) return;
  const t = ctx.currentTime;
  for (const [id, c] of chans) {
    const p = state.players.get(id);
    if (p) { setPied(c, !!p.pied, t); continue; }
    chans.delete(id);
    setTimeout(() => { try { c.g.disconnect(); c.lp.disconnect(); } catch { /* gone */ } }, 400);
  }
  for (const v of voices.slice()) if (v.owner && !state.players.has(v.owner)) kill(v);
});

// ---------- voices ----------
function mkVoice(dest, owner = null, sus = false) {
  if (voices.length >= MAX_VOICES) {
    let pick = voices[0];
    for (const x of voices) if (!x.sus) { pick = x; break; }   // spare held notes if we can
    kill(pick);
  }
  const out = ctx.createGain();
  out.connect(dest);
  const v = { out, owner, sus, srcs: [], nodes: [], key: null, timer: 0, safety: 0, dead: false, dying: false, pluck: false };
  voices.push(v);
  return v;
}

function unlist(v) {
  const i = voices.indexOf(v);
  if (i >= 0) voices.splice(i, 1);
  if (v.key && held.get(v.key) === v) held.delete(v.key);
  clearTimeout(v.safety);
}

function free(v) {
  if (v.dead) return;
  v.dead = true;
  unlist(v);
  clearTimeout(v.timer);
  for (const s of v.srcs) { try { s.stop(); } catch { /* already stopped */ } try { s.disconnect(); } catch { /* gone */ } }
  for (const n of v.nodes) { try { n.disconnect(); } catch { /* gone */ } }
  try { v.out.disconnect(); } catch { /* gone */ }
}

// Fast fade and free (voice stealing, player left, retrigger).
function kill(v) {
  if (v.dead || v.dying) return;
  v.dying = true;
  unlist(v);
  const t = ctx.currentTime, p = v.out.gain;
  try { if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else p.cancelScheduledValues(t); } catch { /* fine */ }
  p.setTargetAtTime(0, t, 0.008);
  clearTimeout(v.timer);
  v.timer = setTimeout(() => free(v), 60);
}

// The voice is over at audio time `when`: stop its sources then, free shortly after.
function fin(v, when) {
  if (v.dead || v.dying) return;
  for (const s of v.srcs) { try { s.stop(when); } catch { /* fine */ } }
  clearTimeout(v.timer);
  v.timer = setTimeout(() => free(v), Math.max(0, when - ctx.currentTime) * 1000 + 80);
}

// ---------- tiny node helpers ----------
function O(v, type, f, t) {
  const o = ctx.createOscillator();
  o.type = type; o.frequency.value = f; o.start(t);
  v.srcs.push(o);
  return o;
}
function N(v, t) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf; s.loop = true; s.start(t, Math.random() * 1.5);
  v.srcs.push(s);
  return s;
}
function G(v, val) {
  const g = ctx.createGain();
  g.gain.value = val;
  v.nodes.push(g);
  return g;
}
function F(v, type, f, q) {
  const b = ctx.createBiquadFilter();
  b.type = type; b.frequency.value = f; b.Q.value = q;
  v.nodes.push(b);
  return b;
}
function drive(v) {
  const w = ctx.createWaveShaper();
  w.curve = driveCurve;
  v.nodes.push(w);
  return w;
}
function chain(...n) {
  for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]);
}
// percussive attack/decay envelope
function ad(p, t, peak, a, d) {
  p.setValueAtTime(0.0001, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.exponentialRampToValueAtTime(0.0001, t + a + d);
}
function sweep(p, t, a, b, dur) {
  p.setValueAtTime(a, t);
  p.exponentialRampToValueAtTime(b, t + dur);
}

// ---------- validation / flood guard ----------
const num = (x, def) => (typeof x === 'number' && Number.isFinite(x) ? x : def);
const idx = (x, n) => (Number.isInteger(x) && x >= 0 && x < n ? x : -1);

// Token bucket on note starts: the relay is public, so a flood must not melt a phone.
function take() {
  const now = performance.now();
  tokens = Math.min(60, tokens + (now - tokensAt) * 0.15);
  tokensAt = now;
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

// ---------- goose ----------
function gooseOn(key, k, dest, owner, chip) {
  const old = held.get(key);
  if (old) kill(old);
  const t = ctx.currentTime, d = chip ? 0.5 : 1;
  const f = midiHz(SCALE[5 + k] + (chip ? 12 : 0));
  const v = mkVoice(dest, owner, true);
  v.key = key; v.t0 = t; v.d = d;

  const lp = F(v, 'lowpass', 3400, 0.7);
  const pk = F(v, 'peaking', 1100, 3.2);       // the nasal bit
  pk.gain.value = 13;
  sweep(pk.frequency, t, 680, chip ? 1500 : 1150, 0.06 * d);
  const a = O(v, 'square', f * 0.9948, t), b = O(v, 'square', f * 1.0058, t), c = O(v, 'sawtooth', f, t);
  const cg = G(v, 0.35);
  chain(a, lp); chain(b, lp); chain(c, cg, lp); chain(lp, pk, v.out);

  // vibrato that gets sillier the longer you hold
  const lfo = O(v, 'sine', 5.6, t), lg = G(v, 0);
  lfo.frequency.linearRampToValueAtTime(7.4, t + 3 * d);
  lg.gain.setValueAtTime(2, t);
  lg.gain.linearRampToValueAtTime(42, t + 2.6 * d);
  lfo.connect(lg);

  v.det = [a.detune, b.detune, c.detune];
  for (const p of v.det) {
    p.setValueAtTime(-380, t);                              // scoop up into the note...
    p.linearRampToValueAtTime(50, t + 0.06 * d);            // ...overshoot...
    p.linearRampToValueAtTime(0, t + 0.11 * d);
    p.setTargetAtTime(32, t + 0.11 * d, 1.3 * d);           // ...and creep sharp while held
    lg.connect(p);
  }
  v.pk = pk.frequency;
  v.out.gain.setValueAtTime(0, t);
  v.out.gain.setTargetAtTime(0.13, t, 0.007);

  held.set(key, v);
  v.safety = setTimeout(() => gooseOff(key), 6000 * d);     // a lost note-off can never drone
}

function gooseOff(key) {
  const v = held.get(key);
  if (!v || !v.det) return;
  held.delete(key); v.key = null; v.sus = false;
  clearTimeout(v.safety);
  const d = v.d, tr = Math.max(ctx.currentTime, v.t0 + 0.12 * d);   // even a tap gets a full "hnk"
  for (const p of v.det) p.setTargetAtTime(-1000, tr, 0.1 * d);     // deflate
  v.pk.setTargetAtTime(520, tr, 0.08 * d);
  v.out.gain.setTargetAtTime(0, tr + 0.03 * d, 0.07 * d);
  fin(v, tr + 0.45 * d);
}

// ---------- slide whistle ----------
const whistleHz = (h, chip) => 280 * Math.pow(2, h * 2.3) * (chip ? 2 : 1);

function whistleVoice(key, h, dest, owner, chip) {
  const t = ctx.currentTime, f = whistleHz(h, chip);
  const v = mkVoice(dest, owner, true);
  v.key = key; v.chip = chip;
  const wg = G(v, 0);
  wg.gain.setValueAtTime(0, t);
  wg.gain.setTargetAtTime(0.3, t, 0.015);
  const o = O(v, 'sine', f, t);
  const lfo = O(v, 'sine', 5.5, t), lg = G(v, 11);
  chain(lfo, lg, o.detune);
  const n = N(v, t), bp = F(v, 'bandpass', f, 5), ng = G(v, 0.55);   // breath
  chain(o, wg); chain(n, bp, ng, wg); chain(wg, v.out);
  v.fo = o.frequency; v.fb = bp.frequency; v.wg = wg.gain; v.lg = lg.gain;
  held.set(key, v);
  return v;
}

function whistleSet(key, h, dest, owner, chip) {
  let v = held.get(key);
  if (v && !v.fo) return;
  if (!v) {
    if (!take()) return;
    v = whistleVoice(key, h, dest, owner, chip);
  } else {
    const t = ctx.currentTime, f = whistleHz(h, v.chip);
    v.fo.setTargetAtTime(f, t, 0.03);
    v.fb.setTargetAtTime(f, t, 0.03);
  }
  clearTimeout(v.safety);
  v.safety = setTimeout(() => whistleOff(key), v.chip ? 750 : 1500);
}

function whistleOff(key) {
  const v = held.get(key);
  if (!v || !v.fo) return;
  held.delete(key); v.key = null; v.sus = false;
  clearTimeout(v.safety);
  const t = ctx.currentTime;
  v.wg.setTargetAtTime(0, t, 0.03);
  fin(v, t + 0.2);
}

// The little guy falls: fall time is the contract formula, shared with the visuals.
function whistleDrop(key, h, dest, owner, chip) {
  let v = held.get(key);
  if (v && !v.fo) return;
  if (!v) {
    if (!take()) return;
    v = whistleVoice(key, h, dest, owner, chip);
  }
  held.delete(key); v.key = null; v.sus = false;
  clearTimeout(v.safety);
  chip = v.chip;
  const t = ctx.currentTime, d = chip ? 0.5 : 1, x = chip ? 2 : 1;
  const T = (0.35 + 0.55 * h) * d, tl = t + T;
  const f0 = whistleHz(h, chip), f1 = 120 * x;

  // Classic falling whistle: hangs for a moment, then plummets.
  for (const p of [v.fo, v.fb]) {
    p.cancelScheduledValues(t);
    p.setValueAtTime(f0, t);
    for (let i = 1; i <= 10; i++) {
      const u = i / 10;
      p.exponentialRampToValueAtTime(f0 * Math.pow(f1 / f0, Math.pow(u, 1.8)), t + u * T);
    }
  }
  v.lg.setTargetAtTime(28, t, T * 0.5);          // wobblier as he panics
  v.wg.setTargetAtTime(0.38, t, T * 0.5);
  v.wg.setTargetAtTime(0, tl, 0.005);

  // Landing: thud...
  const amp = 0.65 + 0.35 * h;
  const th = O(v, 'sine', 190 * x, tl), tg = G(v, 0), dr = drive(v);
  sweep(th.frequency, tl, 190 * x, 52 * x, 0.13 * d);
  ad(tg.gain, tl, 0.8 * amp, 0.002, 0.22 * d);
  chain(th, dr, tg, v.out);
  const n = N(v, tl), nl = F(v, 'lowpass', 1500, 0.8), ng = G(v, 0);
  ad(ng.gain, tl, 0.6 * amp, 0.001, 0.08 * d);
  chain(n, nl, ng, v.out);
  // ...and a root + fifth stab.
  const sl = F(v, 'lowpass', 2200, 2), sg = G(v, 0);
  sweep(sl.frequency, tl, 2200, 600, 0.26 * d);
  ad(sg.gain, tl, 0.2 * amp, 0.004, 0.3 * d);
  const lift = chip ? 12 : 0;
  for (const m of [48, 55, 60]) O(v, 'sawtooth', midiHz(m + lift), tl).connect(sl);
  chain(sl, sg, v.out);

  fin(v, tl + 0.45 * d);
}

// ---------- bonk (drums) ----------
function bonk(k, dest, owner, chip) {
  const t = ctx.currentTime, d = chip ? 0.5 : 1, x = chip ? 2 : 1;
  const v = mkVoice(dest, owner);
  if (k === 0) {
    // kick: pitch-dropping thump with a click, and a tiny "boing" after it
    const o = O(v, 'sine', 240 * x, t), o2 = O(v, 'triangle', 240 * x, t), og = G(v, 0.5);
    sweep(o.frequency, t, 240 * x, 56 * x, 0.1 * d);
    sweep(o2.frequency, t, 240 * x, 56 * x, 0.1 * d);
    const dr = drive(v), body = G(v, 0);
    ad(body.gain, t, 0.8, 0.002, 0.26 * d);
    chain(o, dr); chain(o2, og, dr); chain(dr, body, v.out);
    const n = N(v, t), hp = F(v, 'highpass', 1500, 0.7), cg = G(v, 0);
    ad(cg.gain, t, 0.5, 0.001, 0.012);
    chain(n, hp, cg, v.out);
    const tb = t + 0.07 * d, ob = O(v, 'sine', 100 * x, tb), bg = G(v, 0);
    sweep(ob.frequency, tb, 100 * x, 230 * x, 0.24 * d);
    const lfo = O(v, 'sine', 17, tb), lg = G(v, 45);
    chain(lfo, lg, ob.detune);
    ad(bg.gain, tb, 0.3, 0.02 * d, 0.26 * d);
    chain(ob, bg, v.out);
    fin(v, t + 0.44 * d);
  } else if (k === 1) {
    // snare: noise + 180Hz triangle, with a sloppy little flam
    const n = N(v, t), hp = F(v, 'highpass', 900, 0.7), ng = G(v, 0);
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(0.7, t + 0.001);
    ng.gain.exponentialRampToValueAtTime(0.06, t + 0.065 * d);
    ng.gain.linearRampToValueAtTime(0.32, t + 0.072 * d);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.2 * d);
    chain(n, hp, ng, v.out);
    const o = O(v, 'triangle', 185 * x, t), og = G(v, 0);
    sweep(o.frequency, t, 185 * x, 140 * x, 0.08 * d);
    ad(og.gain, t, 0.65, 0.001, 0.09 * d);
    chain(o, og, v.out);
    fin(v, t + 0.26 * d);
  } else if (k === 2) {
    // hat: 40ms of fizz plus a tiny "tsip"
    const n = N(v, t), hp = F(v, 'highpass', 6500, 0.8), ng = G(v, 0);
    ad(ng.gain, t, 0.5, 0.001, 0.04 * d);
    chain(n, hp, ng, v.out);
    const o = O(v, 'sine', 2600 * x, t), og = G(v, 0);
    sweep(o.frequency, t, 2600 * x, 5200 * x, 0.03 * d);
    ad(og.gain, t, 0.09, 0.001, 0.03 * d);
    chain(o, og, v.out);
    fin(v, t + 0.1 * d);
  } else {
    // woodblock: "tok" with a cheeky upward flick on the tail
    const o = O(v, 'sine', 860 * x, t), q = O(v, 'square', 860 * x, t), qg = G(v, 0.25);
    const bp = F(v, 'bandpass', 900 * x, 2.5);
    for (const p of [o.frequency, q.frequency]) {
      p.setValueAtTime(860 * x, t);
      p.exponentialRampToValueAtTime(800 * x, t + 0.012 * d);
      p.exponentialRampToValueAtTime(1150 * x, t + 0.09 * d);
    }
    ad(v.out.gain, t, 0.85, 0.001, 0.075 * d);
    chain(o, bp); chain(q, qg, bp); chain(bp, v.out);
    fin(v, t + 0.12 * d);
  }
}

// ---------- belly bass ----------
function belly(k, dest, owner, chip) {
  const t = ctx.currentTime, d = chip ? 0.5 : 1;
  const f = midiHz(SCALE[k] - 12 + (chip ? 12 : 0));
  const v = mkVoice(dest, owner);
  const a = O(v, 'sine', f, t), b = O(v, 'triangle', f * 2, t), c = O(v, 'sawtooth', f, t);
  const bg = G(v, 0.55), cg = G(v, 0.3), dr = drive(v);
  const lp = F(v, 'lowpass', 2400, 5);
  sweep(lp.frequency, t, 2400, 320, 0.32 * d);
  const lfo = O(v, 'sine', 6.5, t), lg = G(v, 20);     // the wobble
  lfo.connect(lg);
  for (const p of [a.detune, b.detune, c.detune]) {
    p.setValueAtTime(700, t);                          // "bw-" starts a fifth up
    p.linearRampToValueAtTime(0, t + 0.06 * d);        // "-omp"
    lg.connect(p);
  }
  chain(a, dr); chain(b, bg, dr); chain(c, cg, dr); chain(dr, lp, v.out);
  ad(v.out.gain, t, 0.6, 0.004, 0.5 * d);
  fin(v, t + 0.6 * d);
}

// ---------- public: notes ----------
export function playNote(m, opts) {
  if (!ctx || !m || typeof m !== 'object') return;
  const chip = !!(opts && opts.chip);
  const from = typeof m.from === 'string' ? m.from.slice(0, 64) : '';
  const owner = from && state.players.has(from) ? from : null;
  switch (m.i) {
    case 'goose': {
      const k = idx(m.k, 5);
      if (k < 0) return;
      const key = from + '|g' + k;
      if (!m.on) gooseOff(key);
      else if (take()) gooseOn(key, k, chanFor(owner), owner, chip);
      break;
    }
    case 'whistle': {
      const key = from + '|w';
      if (!m.drop && !m.on) { whistleOff(key); return; }
      if (typeof m.h !== 'number' || !Number.isFinite(m.h)) return;
      const h = clamp(m.h, 0, 1);
      if (m.drop) whistleDrop(key, h, chanFor(owner), owner, chip);
      else whistleSet(key, h, chanFor(owner), owner, chip);
      break;
    }
    case 'bonk': {
      const k = idx(m.k, 4);
      if (k >= 0 && take()) bonk(k, chanFor(owner), owner, chip);
      break;
    }
    case 'belly': {
      const k = idx(m.k, 5);
      if (k >= 0 && take()) belly(k, chanFor(owner), owner, chip);
      break;
    }
    default: // unknown instrument: ignore
  }
}

bus.on('msg', (m) => { if (m && m.t === 'n') playNote(m); });

// ---------- public: pluck (scanner worm) ----------
export function pluck(degree, timbre, vol) {
  if (!ctx) return;
  const deg = clamp(Math.round(num(degree, 0)), 0, SCALE.length - 1);
  const tb = clamp(Math.round(num(timbre, 0)), 0, 5);
  const vl = clamp(num(vol, 0.25), 0, 1);
  if (vl < 0.002) return;
  let n = 0, oldest = null;
  for (const x of voices) if (x.pluck) { n++; if (!oldest) oldest = x; }
  if (n >= MAX_PLUCKS) kill(oldest);

  const t = ctx.currentTime, f = midiHz(SCALE[deg]);
  const v = mkVoice(sfxIn);
  v.pluck = true;
  let dur = 0.16, peak = vl;
  if (tb === 0) {            // square-ish
    const lp = F(v, 'lowpass', 2400, 1);
    chain(O(v, 'square', f, t), lp, v.out);
    peak = vl * 0.5;
  } else if (tb === 1) {     // sine
    O(v, 'sine', f, t).connect(v.out);
    dur = 0.22;
  } else if (tb === 2) {     // triangle
    O(v, 'triangle', f, t).connect(v.out);
    dur = 0.18; peak = vl * 1.15;
  } else if (tb === 3) {     // pitched noise blip
    const bp = F(v, 'bandpass', f * 2, 9);
    chain(N(v, t), bp, v.out);
    dur = 0.07; peak = vl * 2.4;
  } else if (tb === 4) {     // saw-ish
    const lp = F(v, 'lowpass', 3000, 1.5);
    chain(O(v, 'sawtooth', f, t), lp, v.out);
    peak = vl * 0.55;
  } else {                   // deep thunk
    const o = O(v, 'triangle', f, t);
    sweep(o.frequency, t, f * 1.5, f * 0.5, 0.05);
    o.connect(v.out);
    dur = 0.2; peak = vl * 1.5;
  }
  ad(v.out.gain, t, peak, 0.003, dur);
  fin(v, t + dur + 0.02);
}

// ---------- sfx ----------
const SFX = {
  // cream pie hits face: wet burst, a "blop", and a couple of drips
  splat(o, t) {
    const v = mkVoice(sfxIn);
    const n = N(v, t), lp = F(v, 'lowpass', 5200, 3), ng = G(v, 0);
    sweep(lp.frequency, t, 5200, 260, 0.26);
    ad(ng.gain, t, 0.8, 0.003, 0.3);
    chain(n, lp, ng, v.out);
    const b = O(v, 'sine', 340, t), bg = G(v, 0);
    sweep(b.frequency, t, 340, 80, 0.14);
    ad(bg.gain, t, 0.7, 0.004, 0.18);
    chain(b, bg, v.out);
    for (let i = 0; i < 2; i++) {
      const td = t + 0.17 + i * 0.1 + Math.random() * 0.05, f = 380 + Math.random() * 300;
      const dp = O(v, 'sine', f, td), dg = G(v, 0);
      sweep(dp.frequency, td, f, f * 2.4, 0.05);
      ad(dg.gain, td, 0.22, 0.004, 0.06);
      chain(dp, dg, v.out);
    }
    fin(v, t + 0.5);
  },

  throw(o, t) {
    const v = mkVoice(sfxIn);
    const n = N(v, t), bp = F(v, 'bandpass', 350, 2.5);
    sweep(bp.frequency, t, 350, 2600, 0.2);
    const s = O(v, 'sine', 250, t), sg = G(v, 0.25);
    sweep(s.frequency, t, 250, 1100, 0.2);
    chain(n, bp, v.out); chain(s, sg, v.out);
    const g = v.out.gain;
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(0.5, t + 0.14);
    g.exponentialRampToValueAtTime(0.0001, t + 0.25);
    fin(v, t + 0.28);
  },

  // tornado: fluttering swept wind for o.dur, ending in a pop
  whoosh(o, t) {
    const dur = clamp(num(o.dur, 1), 0.15, 6);
    const v = mkVoice(sfxIn);
    const n = N(v, t), bp = F(v, 'bandpass', 300, 1.8), ng = G(v, 0);
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(1900, t + dur * 0.6);
    bp.frequency.exponentialRampToValueAtTime(600, t + dur);
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.55, t + dur * 0.5);
    ng.gain.linearRampToValueAtTime(0.35, t + dur * 0.9);
    ng.gain.linearRampToValueAtTime(0, t + dur);
    const am = G(v, 1), lfo = O(v, 'sine', 9, t), lg = G(v, 0.35);
    lfo.frequency.linearRampToValueAtTime(15, t + dur);
    chain(lfo, lg, am.gain);
    chain(n, bp, ng, am, v.out);
    fin(v, t + dur + 0.05);
    SFX.pop(o, t + dur);
  },

  pop(o, t) {
    const v = mkVoice(sfxIn);
    const s = O(v, 'sine', 950, t), sg = G(v, 0);
    sweep(s.frequency, t, 950, 140, 0.07);
    ad(sg.gain, t, 0.75, 0.002, 0.09);
    chain(s, sg, v.out);
    const n = N(v, t), hp = F(v, 'highpass', 2000, 0.7), ng = G(v, 0);
    ad(ng.gain, t, 0.3, 0.001, 0.012);
    chain(n, hp, ng, v.out);
    fin(v, t + 0.14);
  },

  // whoopee cushion: jittery low saw with flappy gating; ruder with o.p
  fart(o, t) {
    const dur = clamp(num(o.dur, 0.5), 0.08, 4), p = clamp(num(o.p, 0.5), 0, 1);
    const v = mkVoice(sfxIn);
    const s = O(v, 'sawtooth', 100, t);
    const lp = F(v, 'lowpass', 500 + 1500 * p, 2 + 5 * p), dr = drive(v);
    const n = N(v, t), bp = F(v, 'bandpass', 900, 1), ng = G(v, 0.12 + 0.2 * p);
    chain(s, lp, dr, v.out); chain(n, bp, ng, v.out);
    const g = v.out.gain, amp = 0.3 + 0.35 * p;
    const hi = 125 - 45 * p, lo = 62, end = t + dur;
    g.setValueAtTime(0, t);
    let tt = t, f = hi;
    while (tt < end) {
      const u = (tt - t) / dur;
      f = lerp(hi, lo, u * u) * (1 + (Math.random() - 0.5) * (0.12 + 0.5 * p));
      s.frequency.setValueAtTime(f, tt);
      const flap = Math.random() < 0.16 + 0.2 * p ? 0.12 : 0.6 + Math.random() * 0.4;
      g.setTargetAtTime(flap * amp * (u > 0.85 ? (1 - u) / 0.15 * 0.7 + 0.3 : 1), tt, 0.004);
      tt += 0.018 + Math.random() * 0.03;
    }
    if (p > 0.55 && dur > 0.25) {
      // the little squeak of shame at the end
      const ts = Math.max(tt - 0.02, end - 0.07);
      s.frequency.setValueAtTime(f, ts);
      s.frequency.exponentialRampToValueAtTime(lo * (2 + 3 * p), end + 0.03);
      g.setTargetAtTime(amp * 0.5, ts, 0.01);
    }
    g.setTargetAtTime(0, end + 0.02, 0.012);
    fin(v, end + 0.1);
  },

  // rubbery inflate squeak; call repeatedly with rising o.p
  squeak(o, t) {
    const p = clamp(num(o.p, 0.5), 0, 1), f = 320 * Math.pow(2, p * 2.2);
    const v = mkVoice(sfxIn);
    const s = O(v, 'triangle', f, t);
    sweep(s.frequency, t, f * 0.82, f * 1.22, 0.06);
    s.connect(v.out);
    ad(v.out.gain, t, 0.24, 0.004, 0.07);
    fin(v, t + 0.1);
  },

  bonk(o, t) {
    const v = mkVoice(sfxIn);
    const s = O(v, 'triangle', 560, t), q = O(v, 'square', 1120, t), qg = G(v, 0.14);
    sweep(s.frequency, t, 560, 170, 0.09);
    sweep(q.frequency, t, 1120, 340, 0.05);
    chain(s, v.out); chain(q, qg, v.out);
    ad(v.out.gain, t, 0.7, 0.002, 0.12);
    fin(v, t + 0.16);
  },

  // "rrrib-bit"; o.slot picks the frog's pitch
  croak(o, t) {
    const slot = ((Math.round(num(o.slot, 0)) % 4) + 4) % 4;
    const base = [92, 112, 138, 170][slot];
    const v = mkVoice(sfxIn);
    const s = O(v, 'square', base, t), bp = F(v, 'bandpass', 800 + slot * 130, 1.2);
    chain(s, bp, v.out);
    const fr = s.frequency, g = v.out.gain;
    fr.setValueAtTime(base, t);
    fr.linearRampToValueAtTime(base * 1.08, t + 0.16);
    fr.setValueAtTime(base * 1.35, t + 0.2);
    fr.linearRampToValueAtTime(base * 1.9, t + 0.31);
    for (let i = 0; i < 6; i++) {
      g.setValueAtTime(0.75, t + i * 0.028);
      g.setValueAtTime(0.12, t + i * 0.028 + 0.016);
    }
    g.setValueAtTime(0, t + 0.17);
    g.setValueAtTime(0.8, t + 0.2);
    g.exponentialRampToValueAtTime(0.0001, t + 0.34);
    fin(v, t + 0.38);
  },

  // pie in the mouth: a choking detuned cluster
  gag(o, t) {
    const v = mkVoice(sfxIn);
    const lp = F(v, 'lowpass', 1300, 6);
    sweep(lp.frequency, t, 1300, 450, 0.5);
    for (const f of [170, 183, 199]) {
      const s = O(v, 'sawtooth', f, t);
      s.detune.setValueAtTime(700, t);
      s.detune.linearRampToValueAtTime(-900, t + 0.55);
      s.connect(lp);
    }
    lp.connect(v.out);
    const g = v.out.gain;
    g.setValueAtTime(0, t);
    for (let i = 0; i < 9; i++) g.setTargetAtTime(i % 2 ? 0.04 + Math.random() * 0.1 : 0.2 + Math.random() * 0.15, t + i * 0.06 + Math.random() * 0.02, 0.008);
    g.setTargetAtTime(0, t + 0.56, 0.02);
    fin(v, t + 0.68);
  },

  // a small but enthusiastic crowd: lots of random claps, plus a couple of "woo"s
  applause(o, t) {
    const dur = clamp(num(o.dur, 2.5), 0.3, 8), sr = ctx.sampleRate;
    const len = Math.floor(sr * dur), buf = ctx.createBuffer(1, len, sr), data = buf.getChannelData(0);
    const claps = Math.floor(dur * 110), scale = sr / 48000;
    for (let i = 0; i < claps; i++) {
      const L = Math.floor((200 + Math.random() * 400) * scale);
      const pos = Math.floor(Math.random() * Math.max(1, len - L)), a = 0.3 + Math.random() * 0.7;
      for (let j = 0; j < L && pos + j < len; j++) {
        const e = 1 - j / L;
        data[pos + j] += (Math.random() * 2 - 1) * a * e * e;
      }
    }
    const v = mkVoice(sfxIn);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.start(t);
    v.srcs.push(src);
    const bp = F(v, 'bandpass', 1500, 0.7), cg = G(v, 0);
    const fade = Math.min(0.7, dur * 0.4);
    cg.gain.setValueAtTime(0, t);
    cg.gain.linearRampToValueAtTime(0.6, t + Math.min(0.25, dur * 0.3));
    cg.gain.setValueAtTime(0.6, t + dur - fade);
    cg.gain.linearRampToValueAtTime(0, t + dur);
    chain(src, bp, cg, v.out);
    if (dur >= 1.2) {
      for (let i = 0; i < 2; i++) {
        const tw = t + 0.25 + Math.random() * (dur - 1), f = 600 + Math.random() * 250;
        const w = O(v, 'sine', f, tw), wg = G(v, 0);
        w.frequency.setValueAtTime(f, tw);
        w.frequency.exponentialRampToValueAtTime(f * 2.2, tw + 0.18);
        w.frequency.exponentialRampToValueAtTime(f * 1.4, tw + 0.42);
        ad(wg.gain, tw, 0.07, 0.05, 0.36);
        chain(w, wg, v.out);
      }
    }
    fin(v, t + dur + 0.05);
  },

  // "ta-da-da-DAAA~" with a wobble that gets out of hand
  tada(o, t) {
    const v = mkVoice(sfxIn);
    const lp = F(v, 'lowpass', 2800, 1);
    lp.connect(v.out);
    const arp = [60, 64, 67];
    for (let i = 0; i < 3; i++) {
      const tn = t + i * 0.085, s = O(v, 'sawtooth', midiHz(arp[i]), tn), g = G(v, 0);
      ad(g.gain, tn, 0.2, 0.004, 0.11);
      chain(s, g, lp);
    }
    const tc = t + 0.27, cg = G(v, 0), lfo = O(v, 'sine', 6.5, tc), lg = G(v, 0);
    lg.gain.setValueAtTime(0, tc);
    lg.gain.linearRampToValueAtTime(60, tc + 0.75);
    lfo.connect(lg);
    for (const n of [60, 72, 76, 79]) {
      const s = O(v, n === 60 ? 'square' : 'sawtooth', midiHz(n), tc);
      s.detune.setValueAtTime(-320, tc);
      s.detune.linearRampToValueAtTime(0, tc + 0.09);
      s.detune.setValueAtTime(0, tc + 0.6);
      s.detune.linearRampToValueAtTime(-160, tc + 0.88);
      lg.connect(s.detune);
      s.connect(cg);
    }
    cg.gain.setValueAtTime(0.0001, tc);
    cg.gain.linearRampToValueAtTime(0.15, tc + 0.02);
    cg.gain.linearRampToValueAtTime(0.11, tc + 0.55);
    cg.gain.exponentialRampToValueAtTime(0.0001, tc + 0.9);
    cg.connect(lp);
    fin(v, tc + 0.95);
  },

  // googly-eye stamp: "boing"
  stamp(o, t) {
    const v = mkVoice(sfxIn);
    const s = O(v, 'triangle', 190, t), sg = G(v, 0);
    sweep(s.frequency, t, 190, 235, 0.4);
    const lfo = O(v, 'sine', 11, t), lg = G(v, 0);
    lg.gain.setValueAtTime(650, t);
    lg.gain.exponentialRampToValueAtTime(8, t + 0.4);
    chain(lfo, lg, s.detune);
    ad(sg.gain, t, 0.5, 0.003, 0.4);
    chain(s, sg, v.out);
    const n = N(v, t), hp = F(v, 'highpass', 1200, 0.7), ng = G(v, 0);
    ad(ng.gain, t, 0.3, 0.001, 0.015);
    chain(n, hp, ng, v.out);
    fin(v, t + 0.46);
  },

  erase(o, t) {
    const v = mkVoice(sfxIn);
    const bp = F(v, 'bandpass', 1800 + Math.random() * 1800, 1.2);
    chain(N(v, t), bp, v.out);
    ad(v.out.gain, t, 0.16, 0.008, 0.06);
    fin(v, t + 0.09);
  },

  // slippery pen: resonant tick whose cutoff follows speed o.v
  skid(o, t) {
    const sp = clamp(num(o.v, 0.5), 0, 1);
    const v = mkVoice(sfxIn);
    const bp = F(v, 'bandpass', 500 + 3800 * sp, 6);
    chain(N(v, t), bp, v.out);
    ad(v.out.gain, t, 0.14 + 0.24 * sp, 0.004, 0.045);
    fin(v, t + 0.07);
  },

  // squeaky clean: "squee-squee"
  wipe(o, t) {
    const v = mkVoice(sfxIn);
    const s = O(v, 'sine', 1300, t), lfo = O(v, 'sine', 55, t), lg = G(v, 70);
    chain(lfo, lg, s.detune);
    s.connect(v.out);
    const fr = s.frequency, g = v.out.gain;
    fr.setValueAtTime(1300, t);
    fr.exponentialRampToValueAtTime(2300, t + 0.09);
    fr.setValueAtTime(1500, t + 0.13);
    fr.exponentialRampToValueAtTime(2700, t + 0.22);
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(0.22, t + 0.01);
    g.exponentialRampToValueAtTime(0.0001, t + 0.1);
    g.setValueAtTime(0.0001, t + 0.13);
    g.linearRampToValueAtTime(0.22, t + 0.14);
    g.exponentialRampToValueAtTime(0.0001, t + 0.24);
    fin(v, t + 0.28);
  },

  join(o, t) {
    const v = mkVoice(sfxIn);
    const s = O(v, 'square', midiHz(76), t), lp = F(v, 'lowpass', 3000, 1);
    s.frequency.setValueAtTime(midiHz(76), t);
    s.frequency.setValueAtTime(midiHz(81), t + 0.09);
    chain(s, lp, v.out);
    const g = v.out.gain;
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(0.2, t + 0.005);
    g.exponentialRampToValueAtTime(0.07, t + 0.085);
    g.linearRampToValueAtTime(0.22, t + 0.095);
    g.exponentialRampToValueAtTime(0.0001, t + 0.27);
    fin(v, t + 0.3);
  },

  leave(o, t) {
    const v = mkVoice(sfxIn);
    const s = O(v, 'triangle', midiHz(69), t);
    s.frequency.setValueAtTime(midiHz(69), t);
    s.frequency.setValueAtTime(midiHz(64), t + 0.13);
    s.frequency.exponentialRampToValueAtTime(midiHz(60.5), t + 0.44);   // droops
    s.connect(v.out);
    const g = v.out.gain;
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(0.32, t + 0.006);
    g.exponentialRampToValueAtTime(0.1, t + 0.125);
    g.linearRampToValueAtTime(0.32, t + 0.135);
    g.exponentialRampToValueAtTime(0.0001, t + 0.46);
    fin(v, t + 0.5);
  },

  // "eh-eh"
  nope(o, t) {
    const v = mkVoice(sfxIn);
    const lp = F(v, 'lowpass', 1500, 1);
    chain(O(v, 'square', 116, t), lp); chain(O(v, 'square', 123, t), lp); chain(lp, v.out);
    const g = v.out.gain;
    g.setValueAtTime(0, t);
    g.setTargetAtTime(0.26, t, 0.004);
    g.setTargetAtTime(0, t + 0.09, 0.004);
    g.setTargetAtTime(0.26, t + 0.13, 0.004);
    g.setTargetAtTime(0, t + 0.25, 0.006);
    fin(v, t + 0.3);
  },

  curtain(o, t) {
    const v = mkVoice(sfxIn);
    const n = N(v, t), bp = F(v, 'bandpass', 2600, 0.9), ng = G(v, 0);
    sweep(bp.frequency, t, 2600, 500, 0.85);
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.4, t + 0.25);
    ng.gain.linearRampToValueAtTime(0, t + 0.9);
    const am = G(v, 1), lfo = O(v, 'sine', 14, t), lg = G(v, 0.25);
    chain(lfo, lg, am.gain);
    chain(n, bp, ng, am, v.out);
    fin(v, t + 0.95);
  },
};

const SFX_GAP = { skid: 50, squeak: 50, erase: 50 };   // ms between repeats; everything else 25
const sfxLast = new Map();
const NO_OPTS = Object.freeze({});

export function sfx(name, o) {
  if (!ctx || typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(SFX, name)) return;
  const now = performance.now();
  if (now - (sfxLast.get(name) ?? -1e9) < (SFX_GAP[name] || 25)) return;
  sfxLast.set(name, now);
  if (!take()) return;
  try {
    SFX[name](o && typeof o === 'object' ? o : NO_OPTS, ctx.currentTime);
  } catch (e) {
    console.warn('[audio] sfx', name, e);
  }
}

// ---------- level meter ----------
export function getLevel() {
  if (!ctx || !analyser) return 0;
  const now = performance.now();
  if (now - levelAt < 12) return level;               // several callers per frame share one read
  const dt = Math.min(0.1, (now - levelAt) / 1000);
  levelAt = now;
  analyser.getByteTimeDomainData(levelBuf);
  let sum = 0;
  for (let i = 0; i < levelBuf.length; i++) { const s = (levelBuf[i] - 128) / 128; sum += s * s; }
  const target = clamp(Math.sqrt(sum / levelBuf.length) * 3.2, 0, 1);
  level = target > level ? target : Math.max(target, level - dt * 2.5);   // snap up, ease down
  return level;
}
