// FROG JAM — net.js: room transport over two public MQTT brokers (no server of our own).
// Everything arriving here was published by strangers on a public topic: validate it all.
import { bus, state, setTransport, sync, INSTRUMENTS } from './bus.js';

const BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
const TOPIC_PREFIX = 'frogjam/v1/';
const MAX_BYTES = 64 * 1024;       // biggest payload we accept or send
const HB_MS = 2000;                // heartbeat period
const DEAD_MS = 7000;              // silence after which a player is dropped
const PROBE_MS = 1200;             // how long a joiner listens for who is here
const CONNECT_MS = 10000;          // give up joining if no broker answers
const ROSTER_HOLD_MS = 3000;       // heartbeats may not revert a fresh inst/pied change
const CHUNK = 12000;               // chars per sync chunk
const SYNC_MAX = 3000000;          // chars of sync JSON, total
const MAX_CHUNKS = Math.ceil(SYNC_MAX / CHUNK);
const SYNC_GAP_MS = 40;            // spacing between sync chunks
const SYNC_WAIT_MS = 4000;         // silence before a sync request is retried
const SYNC_LATE_MS = 30000;        // after giving up, a late answer is still accepted this long
const SETTLE_MS = 300;             // drawing ops stay held this long after a sync is applied
const RATE_MAX = 80;               // outgoing messages per second before coalescing
const MAX_PLAYERS_TRACKED = 8;     // hard bound on the roster (4 real + ghosts)
const SEQ_WINDOW = 1024;           // recent sequence numbers remembered per sender
const ID_RE = /^[0-9a-z]{8}$/;
const DRAW_OPS = new Set(['s', 'wall', 'puff', 'eyes', 'worm', 'clear']);

// ---------- session state ----------
let phase = 'idle';                // 'idle' | 'probing' | 'joined'
let session = 0;                   // bumped on every teardown; stale callbacks compare against it
let clients = [];                  // [{url, client, up, dead}]
let topic = '';
let myId = '', seq = 0, joinedAt = 0;
let hbTimer = 0, tickTimer = 0, hbSoonTimer = 0, flushTimer = 0;
let lastTick = 0, lastWho = 0, downSince = 0;
let netOk = true, suspended = false;
let stale = false, staleTicks = 0; // we may have missed messages (sleep / long outage)
let onFirstUp = null;
let askedSync = false;

const lastSeen = new Map();        // id -> Date.now() of last sign of life
const holdUntil = new Map();       // id -> time until which heartbeat inst/pied is ignored
const seen = new Map();            // id -> {set, ring, i}   de-duplication
const limbo = new Map();           // unknown sender id -> {t0, msgs}

// late-join sync
let syncWait = null;               // {target, tries, src, n, parts, got, size, timer, lenient}
let holding = false, held = [];    // remote drawing ops parked while a sync is in flight
const deferredNeeds = new Set();   // requesters waiting for my own sync to finish
const anyTimers = new Map();       // requester id -> timer for a volunteered answer
const sending = new Set();         // requester ids I am streaming a sync to
const queuedAnswers = new Set();   // requester ids with an answer retry scheduled
const answered = new Map();        // requester id -> time I last answered

// outgoing rate safety
let winStart = 0, winCount = 0;
const pendStroke = new Map();      // stroke id -> coalesced {t:'s', ...}
let pendWhistle = null;

const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const anyUp = () => clients.some((c) => c.up);
const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

function randId() {
  let s = '';
  const a = new Uint32Array(8);
  if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
  else for (let i = 0; i < 8; i++) a[i] = Math.floor(Math.random() * 0xffffffff);
  for (let i = 0; i < 8; i++) s += (a[i] % 36).toString(36);
  return s;
}

// ---------- brokers ----------
function connectAll() {
  const tok = session;
  clients = BROKERS.map((url) => {
    const c = { url, client: null, up: false, dead: false };
    const live = () => !c.dead && tok === session;
    try {
      c.client = globalThis.mqtt.connect(url, {
        clientId: 'fj_' + randId() + randId(),
        clean: true, reconnectPeriod: 1500, keepalive: 20, connectTimeout: 8000,
        resubscribe: false,   // we subscribe by hand on every connect
        queueQoSZero: false,  // never replay stale notes after an outage
      });
    } catch (e) {
      console.warn('[net] connect failed', url, e);
      c.dead = true;
      return c;
    }
    c.client.on('connect', () => {
      if (!live()) return;
      c.client.subscribe(topic, { qos: 0 }, (err, granted) => {
        if (!live()) return;
        if (err || (Array.isArray(granted) && granted[0] && granted[0].qos === 128)) {
          console.warn('[net] subscribe failed', url, err);
          return;
        }
        c.up = true;
        brokerUp();
      });
    });
    const down = () => { if (live() && c.up) { c.up = false; brokerDown(); } };
    c.client.on('close', down);
    c.client.on('offline', down);
    c.client.on('error', (e) => console.debug('[net]', url, e && e.message));
    c.client.on('message', (tp, payload) => { if (live() && tp === topic) receive(payload); });
    return c;
  });
}

function endClients() {
  for (const c of clients) {
    c.dead = true; c.up = false;
    try { if (c.client) c.client.end(false); } catch (e) { /* already gone */ }
  }
  clients = [];
}

function brokerUp() {
  if (onFirstUp) { const f = onFirstUp; onFirstUp = null; f(); }
  if (phase === 'probing') { rawPublish({ t: '_who' }); return; }
  if (phase !== 'joined') return;
  if (downSince && Date.now() - downSince > 4000) { stale = true; staleTicks = 0; }
  downSince = 0;
  graceAll(Date.now());
  heartbeat();
  who(true);
  setNet();
}

function brokerDown() {
  if (!anyUp() && !downSince) downSince = Date.now();
  setNet();
}

function setNet() {
  const ok = anyUp();
  if (phase === 'joined' && ok !== netOk) { netOk = ok; bus.emit('net', { ok }); }
}

// Publish on every connected broker. f and q go last so nothing in obj can override them.
function rawPublish(obj) {
  let s;
  try { s = JSON.stringify({ ...obj, f: myId, q: seq++ }); } catch (e) { return false; }
  if (s.length > MAX_BYTES - 512 || (s.length > 20000 && encoder && encoder.encode(s).length > MAX_BYTES - 512)) {
    console.warn('[net] message too big, dropped:', obj && obj.t);
    return false;
  }
  let sent = false;
  for (const c of clients) {
    if (c.dead || !c.client || !c.client.connected) continue;
    try { c.client.publish(topic, s, { qos: 0 }); sent = true; } catch (e) { /* broker hiccup */ }
  }
  return sent;
}

// ---------- outgoing game messages (the bus transport) ----------
function publishFn(msg) {
  if (phase !== 'joined' || !msg || typeof msg !== 'object' || typeof msg.t !== 'string' || msg.t[0] === '_') return;
  const now = Date.now();
  if (now - winStart >= 1000) { winStart = now; winCount = 0; }
  const hot = ++winCount > RATE_MAX;
  if (msg.t === 's' && typeof msg.id === 'string' && Array.isArray(msg.pts)) {
    const p = pendStroke.get(msg.id);
    if (!msg.end && (hot || p)) {
      // Too chatty: fold this batch into one pending message for the stroke.
      if (p) { for (let i = 0; i < msg.pts.length; i++) p.pts.push(msg.pts[i]); }
      else pendStroke.set(msg.id, { ...msg, pts: msg.pts.slice() });
      if (pendStroke.get(msg.id).pts.length > 3000) flushStroke(msg.id); else armFlush();
      return;
    }
    if (p) flushStroke(msg.id);   // keep order: pending points go out before the end
  } else if (msg.t === 'n' && msg.i === 'whistle') {
    if (hot && msg.on && !msg.drop) { pendWhistle = msg; armFlush(); return; } // latest slide wins
    pendWhistle = null;
  }
  rawPublish(msg);
}

function flushStroke(id) {
  const p = pendStroke.get(id);
  if (!p) return;
  pendStroke.delete(id);
  rawPublish(p);
}

function armFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = 0;
    if (phase !== 'joined') return;
    for (const id of [...pendStroke.keys()]) flushStroke(id);
    if (pendWhistle) { const w = pendWhistle; pendWhistle = null; rawPublish(w); }
  }, 120);
}

// ---------- incoming ----------
function receive(payload) {
  if (phase === 'idle') return;
  let text;
  try {
    if (typeof payload === 'string') {
      if (payload.length > MAX_BYTES) return;
      text = payload;
    } else {
      if (!payload || !(payload.length <= MAX_BYTES)) return;
      text = decoder ? decoder.decode(payload) : String(payload);
    }
  } catch (e) { return; }
  let o;
  try { o = JSON.parse(text); } catch (e) { return; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return;
  const f = o.f, q = o.q, t = o.t;
  if (typeof f !== 'string' || !ID_RE.test(f)) return;
  if (typeof q !== 'number' || !Number.isFinite(q)) return;
  if (typeof t !== 'string' || !t || t.length > 16) return;
  if (f === myId) return;            // my own echo
  if (duplicate(f, q)) return;       // the other broker got there first
  if (t[0] === '_') control(f, t, o); else game(f, o);
}

function duplicate(f, q) {
  let s = seen.get(f);
  if (!s) {
    if (seen.size >= 64) {           // bounded: forget a sender who is not in the room
      let victim;
      for (const id of seen.keys()) { if (!state.players.has(id)) { victim = id; break; } }
      if (victim === undefined) victim = seen.keys().next().value;
      seen.delete(victim);
    }
    s = { set: new Set(), ring: new Array(SEQ_WINDOW), i: 0 };
    seen.set(f, s);
  }
  if (s.set.has(q)) return true;
  const old = s.ring[s.i];
  if (old !== undefined) s.set.delete(old);
  s.ring[s.i] = q;
  s.i = (s.i + 1) % SEQ_WINDOW;
  s.set.add(q);
  return false;
}

function control(f, t, o) {
  switch (t) {
    case '_hb': onHeartbeat(f, o); break;
    case '_who': if (phase === 'joined') hbSoon(); break;
    case '_bye': if (removePlayer(f)) bus.emit('players'); break;
    case '_need': if (phase === 'joined') onNeed(f, o); break;
    case '_sync': if (phase === 'joined') onSync(f, o); break;
    default: break;
  }
}

function game(f, o) {
  if (phase !== 'joined') return;
  const { f: _f, q: _q, ...rest } = o;
  const m = { ...rest, from: f, local: false, ts: Date.now() };
  if (!state.players.has(f)) {
    // Not someone we know yet: park it and ask who is here. A heartbeat releases it.
    let l = limbo.get(f);
    if (!l) {
      if (limbo.size >= 6) return;
      l = { t0: m.ts, msgs: [] };
      limbo.set(f, l);
    }
    if (l.msgs.length < 300) l.msgs.push(m);
    who(false);
    return;
  }
  lastSeen.set(f, m.ts);
  deliver(m);
}

function deliver(m) {
  if (holding && DRAW_OPS.has(m.t) && held.length < 5000) { held.push(m); return; }
  bus.emit('msg', m);
}

function releaseHeld() {
  holding = false;
  if (!held.length) return;
  const list = held;
  held = [];
  if (phase !== 'joined') return;
  for (const m of list) bus.emit('msg', m);
}

// ---------- roster ----------
function heartbeat() {
  const me = state.players.get(myId);
  if (phase !== 'joined' || !me) return;
  rawPublish({ t: '_hb', slot: me.slot, inst: me.inst, pied: !!me.pied, j: joinedAt });
}

function hbSoon() {
  if (hbSoonTimer) return;
  hbSoonTimer = setTimeout(() => { hbSoonTimer = 0; heartbeat(); }, Math.random() * 150);
}

function who(force) {
  const now = Date.now();
  if (!force && now - lastWho < 1000) return;
  lastWho = now;
  rawPublish({ t: '_who' });
}

function graceAll(now) { for (const id of state.players.keys()) lastSeen.set(id, now); }

function freeSlot() {
  const used = new Set();
  for (const p of state.players.values()) if (p.id !== myId) used.add(p.slot);
  for (let s = 0; s < 4; s++) if (!used.has(s)) return s;
  return -1;
}

function lowestOther(exceptId) {
  let best = null;
  for (const p of state.players.values()) {
    if (p.id === exceptId) continue;
    if (!best || p.slot < best.slot || (p.slot === best.slot && p.id < best.id)) best = p;
  }
  return best ? best.id : null;
}

function removePlayer(id) {
  if (id === myId || !state.players.has(id)) return false;
  state.players.delete(id);
  lastSeen.delete(id);
  holdUntil.delete(id);
  limbo.delete(id);
  return true;
}

function onHeartbeat(f, o) {
  const slot = o.slot, inst = o.inst, j = o.j;
  if (!Number.isInteger(slot) || slot < 0 || slot > 3) return;
  if (typeof inst !== 'string' || !INSTRUMENTS.includes(inst)) return;
  if (typeof j !== 'number' || !Number.isFinite(j)) return;
  const pied = o.pied === true || o.pied === 1;
  const now = Date.now();
  let p = state.players.get(f), changed = false, fresh = false;
  if (!p) {
    if (state.players.size >= MAX_PLAYERS_TRACKED) return;
    p = { id: f, slot, inst, me: false, pied };
    state.players.set(f, p);
    changed = fresh = true;
  } else {
    if (p.slot !== slot) { p.slot = slot; changed = true; }
    if (!(holdUntil.get(f) > now)) {
      if (p.inst !== inst) { p.inst = inst; changed = true; }
      if (p.pied !== pied) { p.pied = pied; changed = true; }
    }
  }
  lastSeen.set(f, now);
  if (changed) bus.emit('players');
  if (phase !== 'joined') return;

  // Flush anything this player said before we knew them.
  const l = limbo.get(f);
  if (l) { limbo.delete(f); for (const m of l.msgs) deliver(m); }

  // Two of us grabbed the same slot at the same moment: the later joiner moves.
  const me = state.players.get(myId);
  if (me && me.slot === slot) {
    const iMove = joinedAt > j || (joinedAt === j && myId > f);
    if (!iMove) hbSoon();
    else {
      const free = freeSlot();
      if (free < 0) { leave(); bus.emit('full'); return; }
      const old = me.slot;
      me.slot = free;
      if (me.inst === INSTRUMENTS[old]) me.inst = INSTRUMENTS[free];
      heartbeat();
      bus.emit('players');
    }
  }

  // I thought the room was empty, but a veteran turns up right after: get their state.
  if (fresh && !askedSync && !syncWait && now - joinedAt < 6000 && j < joinedAt - 2500) {
    askedSync = true;
    requestSync(f);
  }
}

// One handler for local and remote roster messages (registered at module load).
bus.on('msg', (m) => {
  if (!m || typeof m.t !== 'string') return;
  const until = Date.now() + ROSTER_HOLD_MS;
  let changed = false;
  switch (m.t) {
    case 'inst': {
      const p = state.players.get(m.from);
      if (!p || typeof m.i !== 'string' || !INSTRUMENTS.includes(m.i)) break;
      holdUntil.set(p.id, until);
      if (p.inst !== m.i) { p.inst = m.i; changed = true; }
      break;
    }
    case 'swap': {
      const map = m.map;
      if (!map || typeof map !== 'object' || Array.isArray(map)) break;
      let n = 0;
      for (const id of Object.keys(map)) {
        if (++n > 16) break;
        const p = state.players.get(id), i = map[id];
        if (!p || typeof i !== 'string' || !INSTRUMENTS.includes(i)) continue;
        holdUntil.set(p.id, until);
        if (p.inst !== i) { p.inst = i; changed = true; }
      }
      break;
    }
    case 'pie': {
      const p = typeof m.to === 'string' ? state.players.get(m.to) : null;
      if (!p) break;
      holdUntil.set(p.id, until);
      if (!p.pied) { p.pied = true; changed = true; }
      break;
    }
    case 'clean': {
      const p = state.players.get(m.from);
      if (!p) break;
      holdUntil.set(p.id, until);
      if (p.pied) { p.pied = false; changed = true; }
      break;
    }
    default: break;
  }
  if (changed) bus.emit('players');
});

// Once a second: drop silent players, notice sleeps, tidy up.
function tick() {
  if (phase !== 'joined') return;
  const now = Date.now(), gap = now - lastTick;
  lastTick = now;
  if (gap > 5000) {                 // timers were frozen (phone slept, tab buried)
    stale = true; staleTicks = 0;
    graceAll(now);
    heartbeat();
    who(true);
  }
  if (!anyUp()) { graceAll(now); return; }   // deaf, so silence proves nothing

  let changed = false;
  for (const id of [...state.players.keys()]) {
    if (id !== myId && now - (lastSeen.get(id) || 0) > DEAD_MS && removePlayer(id)) changed = true;
  }
  if (changed) bus.emit('players');
  for (const [id, l] of limbo) if (now - l.t0 > 3000) limbo.delete(id);

  // After a sleep or a long outage, quietly fetch the room state again.
  if (stale && visible() && !state.replaying && !syncWait && ++staleTicks >= 2) {
    stale = false; staleTicks = 0;
    if (state.players.size > 1) requestSync(null);
  }
}

// ---------- late-join sync: requester side ----------
function requestSync(target) {
  if (syncWait || phase !== 'joined') return;
  syncWait = { target, tries: 0, src: null, n: 0, parts: null, got: 0, size: 0, timer: 0, lenient: false };
  holding = true;
  askNeed();
}

function resetParts(w) { w.src = null; w.n = 0; w.parts = null; w.got = 0; w.size = 0; }

function armSyncTimer(ms) {
  const w = syncWait;
  if (!w) return;
  clearTimeout(w.timer);
  w.timer = setTimeout(syncStalled, ms);
}

function askNeed() {
  const w = syncWait;
  if (!w) return;
  w.tries++;
  resetParts(w);
  const targeted = w.tries === 1 && typeof w.target === 'string' && state.players.has(w.target);
  rawPublish(targeted ? { t: '_need', to: w.target } : { t: '_need', any: 1 });
  armSyncTimer(SYNC_WAIT_MS);
}

function syncStalled() {
  const w = syncWait;
  if (!w) return;
  clearTimeout(w.timer);
  if (w.lenient) { syncWait = null; return; }
  if (w.tries < 2) { askNeed(); return; }
  // Nobody answered twice: carry on without it, but still take a late answer.
  w.lenient = true;
  resetParts(w);
  releaseHeld();
  armSyncTimer(SYNC_LATE_MS);
  runDeferredNeeds();
}

function onSync(f, o) {
  const to = o.to;
  if (typeof to !== 'string') return;
  if (to !== myId) {                 // someone else is already answering that requester
    const t = anyTimers.get(to);
    if (t) { clearTimeout(t); anyTimers.delete(to); }
    return;
  }
  const w = syncWait;
  if (!w || !state.players.has(f)) return;
  const n = o.n, i = o.i, d = o.d;
  if (!Number.isInteger(n) || n < 1 || n > MAX_CHUNKS) return;
  if (!Number.isInteger(i) || i < 0 || i >= n) return;
  if (typeof d !== 'string' || d.length > CHUNK) return;
  if (!w.src) { w.src = f; w.n = n; w.parts = new Array(n); w.got = 0; w.size = 0; }
  if (w.src !== f || w.n !== n || w.parts[i] !== undefined) return;
  w.parts[i] = d; w.got++; w.size += d.length;
  if (w.size > SYNC_MAX) { syncStalled(); return; }
  if (w.got < w.n) { armSyncTimer(SYNC_WAIT_MS); return; }

  clearTimeout(w.timer);
  let obj;
  try { obj = JSON.parse(w.parts.join('')); } catch (e) { obj = null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { syncStalled(); return; }
  syncWait = null;
  try { sync.applyAll(obj); } catch (e) { console.error('[net] sync apply', e); }
  bus.emit('synced');
  // Drawing ops that arrived meanwhile go on top, after appliers have had a moment to settle.
  const tok = session;
  setTimeout(() => { if (tok === session) releaseHeld(); }, SETTLE_MS);
  runDeferredNeeds();
}

// ---------- late-join sync: answering side ----------
const canAnswer = () => !syncWait || syncWait.lenient;

function onNeed(f, o) {
  if (!canAnswer()) {                // my own state is not in yet
    if (o.to === myId && deferredNeeds.size < 4) deferredNeeds.add(f);
    return;
  }
  if (o.any === 1 || o.any === true) {
    // Anyone may answer: wait a random moment, back off if another answer starts.
    if (anyTimers.has(f) || anyTimers.size >= 4) return;
    const tok = session;
    anyTimers.set(f, setTimeout(() => {
      anyTimers.delete(f);
      if (tok === session) answerSync(f, 0);
    }, Math.random() * 600));
    return;
  }
  const target = typeof o.to === 'string' ? o.to : lowestOther(f);
  if (target === myId) answerSync(f, 0);
}

function runDeferredNeeds() {
  if (!deferredNeeds.size) return;
  const ids = [...deferredNeeds];
  deferredNeeds.clear();
  for (const id of ids) answerSync(id, 0);
}

function answerSync(to, attempt) {
  if (phase !== 'joined' || sending.has(to)) return;
  if (attempt === 0 && queuedAnswers.has(to)) return;
  const tok = session;
  const retry = () => {
    queuedAnswers.add(to);
    setTimeout(() => { if (tok === session) answerSync(to, attempt + 1); }, 500);
  };
  // Wait for the requester's heartbeat, and never snapshot in the middle of an encore replay.
  if (!state.players.has(to)) { if (attempt < 2) retry(); else queuedAnswers.delete(to); return; }
  if (state.replaying) { if (attempt < 60) retry(); else queuedAnswers.delete(to); return; }
  queuedAnswers.delete(to);
  const now = Date.now();
  if (sending.size >= 2 || now - (answered.get(to) || 0) < 2500) return;
  if (answered.size > 32) answered.clear();
  answered.set(to, now);

  let json;
  try { json = JSON.stringify(sync.collect()); } catch (e) { console.error('[net] sync collect', e); return; }
  if (typeof json !== 'string' || json.length > SYNC_MAX) {
    console.warn('[net] sync state too big to send');
    return;
  }
  const n = Math.max(1, Math.ceil(json.length / CHUNK));
  let i = 0;
  sending.add(to);
  const step = () => {
    if (tok !== session || phase !== 'joined' || !state.players.has(to)) { sending.delete(to); return; }
    rawPublish({ t: '_sync', to, n, i, d: json.slice(i * CHUNK, (i + 1) * CHUNK) });
    if (++i < n) setTimeout(step, SYNC_GAP_MS); else sending.delete(to);
  };
  step();
}

// ---------- lifecycle ----------
function teardown() {
  session++;
  phase = 'idle';
  suspended = false;
  clearInterval(hbTimer); clearInterval(tickTimer);
  clearTimeout(hbSoonTimer); clearTimeout(flushTimer);
  hbTimer = tickTimer = hbSoonTimer = flushTimer = 0;
  if (syncWait) clearTimeout(syncWait.timer);
  syncWait = null; holding = false; held = [];
  for (const t of anyTimers.values()) clearTimeout(t);
  anyTimers.clear(); deferredNeeds.clear(); sending.clear(); queuedAnswers.clear(); answered.clear();
  pendStroke.clear(); pendWhistle = null;
  endClients();
  setTransport(null);
  lastSeen.clear(); holdUntil.clear(); seen.clear(); limbo.clear();
  stale = false; staleTicks = 0; downSince = 0; askedSync = false;
  const had = state.players.size > 0;
  state.players.clear();
  state.room = null;
  state.me = null;
  if (onFirstUp) { const f = onFirstUp; onFirstUp = null; f(); }
  if (had) bus.emit('players');
}

function firstUp(ms) {
  return new Promise((resolve, reject) => {
    if (anyUp()) { resolve(); return; }
    const timer = setTimeout(() => { onFirstUp = null; reject(new Error('no broker reachable')); }, ms);
    onFirstUp = () => { clearTimeout(timer); resolve(); };
  });
}

// Connect, find out who is here, take a slot. Resolves true (joined) or false (room full
// or cancelled by leave()); rejects if no broker could be reached.
export async function join(roomCode) {
  const room = String(roomCode == null ? '' : roomCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!room) throw new Error('bad room code');
  if (!globalThis.mqtt || typeof globalThis.mqtt.connect !== 'function') throw new Error('mqtt.js is not loaded');
  if (phase !== 'idle') leave();

  const tok = ++session;
  myId = randId();
  seq = 0;
  topic = TOPIC_PREFIX + room;
  phase = 'probing';
  connectAll();                       // each broker publishes '_who' as it comes up
  try {
    await firstUp(CONNECT_MS);
  } catch (e) {
    if (tok === session) teardown();
    throw e;
  }
  if (tok !== session) return false;
  await sleep(PROBE_MS / 2);
  if (tok !== session) return false;
  rawPublish({ t: '_who' });          // ask twice in case the first one was lost
  await sleep(PROBE_MS / 2);
  if (tok !== session) return false;

  const slot = freeSlot();
  if (slot < 0) {
    teardown();
    bus.emit('full');
    return false;
  }
  joinedAt = Date.now();
  lastTick = joinedAt;
  state.room = room;
  state.me = myId;
  state.players.set(myId, { id: myId, slot, inst: INSTRUMENTS[slot], me: true, pied: false });
  phase = 'joined';
  netOk = true;
  setTransport(publishFn);
  hbTimer = setInterval(heartbeat, HB_MS);
  tickTimer = setInterval(tick, 1000);
  heartbeat();
  bus.emit('joined', { room, slot });
  if (tok !== session) return false;
  bus.emit('players');
  if (tok !== session) return false;
  setNet();

  const veteran = lowestOther(myId);  // everyone here was heard before I took my slot
  if (veteran) { askedSync = true; requestSync(veteran); }
  return true;
}

export function leave() {
  if (phase === 'idle') return;
  if (phase === 'joined') rawPublish({ t: '_bye' });
  teardown();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (phase === 'probing') { leave(); return; }
    if (phase !== 'joined' || suspended) return;
    rawPublish({ t: '_bye' });
    endClients();
    suspended = true;                 // keep the seat in case the page comes back from bfcache
  });
  window.addEventListener('pageshow', () => {
    if (!suspended || phase !== 'joined') return;
    suspended = false;
    stale = true; staleTicks = 0;
    connectAll();
  });
  document.addEventListener('visibilitychange', () => { if (visible()) tick(); });
}
