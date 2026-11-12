import { subsolar, solarHourWords } from './astro.js';
import { createSources, status, isLive } from './sources.js';
import { toggleSound, soundOn, playLife, playPage, playQuake } from './audio.js';
import { RA, RB, K, NRIP, createPrograms, bindLayout, Batch, PTS_LAYOUT, perspective, lookAt, mul } from './gl.js';

const D = Math.PI / 180, TAU = Math.PI * 2;
const HOUR = 3_600_000;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const $ = (id) => document.getElementById(id);

const canvas = $('c');
const gl = canvas.getContext('webgl', { antialias: true, alpha: false, powerPreference: 'high-performance' });
if (!gl) { $('nogl').hidden = false; throw new Error('WebGL unavailable'); }
// If the GPU drops us (it happens on phones), start clean rather than limp.
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); setTimeout(() => location.reload(), 1500); });

const prog = createPrograms(gl);
const MAX_PT = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
const T0 = Date.now();
const secs = (ms) => (ms - T0) / 1000; // shader time: seconds since this page opened

// ───────────────────────────── the world ─────────────────────────────
// The creature is the Earth's skin wrapped around a ring. Around the ring runs
// longitude, with the Sun's meridian always facing +X. Around the body runs
// latitude: the equator is the outer rim, the north is the back, the south the
// belly, and both poles meet in the throat.
const G = { w: 1, h: 1, dpr: 1, sunLon: 0, sunLat: 0 };
const cam = { az: 0.9, el: 0.62, dist: 5, auto: true, idleAt: 0, vp: new Float32Array(16), eye: [0, 0, 0], px: 1 };
const FOVY = 44 * D;

function surface(lon, lat, h = 0, sun = G.sunLon) {
  const th = (lon - sun) * D, ph = lat * D * K, ct = Math.cos(th), st = Math.sin(th), cp = Math.cos(ph), sp = Math.sin(ph);
  const n = [cp * ct, sp, -cp * st], r = RA + RB * cp;
  return { p: [r * ct + n[0] * h, RB * sp + n[1] * h, -r * st + n[2] * h], n };
}
function toScreen(p) {
  const m = cam.vp, w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  if (w <= 0.01) return null;
  return [((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w * 0.5 + 0.5) * G.w, (0.5 - (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w * 0.5) * G.h, w];
}
const facing = (s) => s.n[0] * (cam.eye[0] - s.p[0]) + s.n[1] * (cam.eye[1] - s.p[1]) + s.n[2] * (cam.eye[2] - s.p[2]) > 0;

let maxDpr = 2; // lowered on its own if this device can't keep up
function fitDist() { return Math.max(4.3, 1.46 / (Math.tan(FOVY / 2) * (G.w / G.h))); }
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const first = G.w === 1;
  G.w = window.innerWidth; G.h = window.innerHeight; G.dpr = dpr;
  canvas.width = Math.round(G.w * dpr);
  canvas.height = Math.round(G.h * dpr);
  gl.viewport(0, 0, canvas.width, canvas.height);
  cam.px = canvas.height / (2 * Math.tan(FOVY / 2));
  if (first || cam.auto) cam.dist = fitDist();
}
function updateCamera(dt, t) {
  if (!cam.auto && performance.now() - cam.idleAt > 9000) cam.auto = true;
  if (cam.auto) {
    // A slow orbit of its own: the viewer drifting, not the data.
    cam.az += dt * 0.03;
    cam.el += (0.58 + 0.3 * Math.sin(t * 0.045) - cam.el) * Math.min(1, dt * 0.25);
  }
  const ce = Math.cos(cam.el);
  cam.eye = [cam.dist * ce * Math.cos(cam.az), cam.dist * Math.sin(cam.el), cam.dist * ce * Math.sin(cam.az)];
  cam.vp = mul(perspective(FOVY, G.w / G.h, 0.05, 80), lookAt(cam.eye, [0, 0, 0]));
}

// ───────────────────────────── the body ─────────────────────────────
const body = (() => {
  const NU = 256, NV = 64, v = new Float32Array((NU + 1) * (NV + 1) * 2), idx = new Uint16Array(NU * NV * 6);
  let k = 0;
  for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) { v[k++] = (i / NU) * TAU - Math.PI; v[k++] = (j / NV - 0.5) * Math.PI; }
  k = 0;
  for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
    const a = j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
    idx[k++] = a; idx[k++] = b; idx[k++] = c; idx[k++] = b; idx[k++] = d; idx[k++] = c;
  }
  const vb = gl.createBuffer(), ib = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  return { vb, ib, n: idx.length };
})();

// ───────────────────────────── the air ─────────────────────────────
let wind = null;
function windAt(lon, lat) {
  const { lats, lons, u, v } = wind, nx = lons.length, ny = lats.length;
  const fx = (lon + 180) / (360 / nx), fy = clamp((lat - lats[0]) / (lats[1] - lats[0]), 0, ny - 1.001);
  const i0 = ((Math.floor(fx) % nx) + nx) % nx, i1 = (i0 + 1) % nx, j0 = Math.floor(fy), j1 = j0 + 1;
  const tx = fx - Math.floor(fx), ty = fy - j0;
  const a = j0 * nx + i0, b = j0 * nx + i1, c = j1 * nx + i0, e = j1 * nx + i1;
  return [
    (u[a] * (1 - tx) + u[b] * tx) * (1 - ty) + (u[c] * (1 - tx) + u[e] * tx) * ty,
    (v[a] * (1 - tx) + v[b] * tx) * (1 - ty) + (v[c] * (1 - tx) + v[e] * tx) * ty,
  ];
}
const TRAIL = 7, parts = [];
function respawn(p) {
  p.lon = Math.random() * 360 - 180;
  p.lat = Math.asin(Math.random() * 2 - 1) / D; // uniform over the real sphere
  p.age = 0; p.life = 5 + Math.random() * 8; p.sp = 0;
  for (let i = 0; i < TRAIL; i++) { p.hl[i] = p.lon; p.ha[i] = p.lat; }
}
for (let i = 0; i < 2600; i++) { const p = { hl: new Float32Array(TRAIL), ha: new Float32Array(TRAIL) }; respawn(p); p.age = Math.random() * p.life; parts.push(p); }
let trailClock = 0;
function stepWind(dt, batch, lines) {
  if (!wind || !isLive('air')) return;
  const kw = 0.0085; // world units per second per m/s — the one deliberate exaggeration
  trailClock += dt;
  const shift = trailClock > 0.16;
  if (shift) trailClock = 0;
  for (const p of parts) {
    p.age += dt;
    if (p.age > p.life || Math.abs(p.lat) > 86) respawn(p);
    const [u, v] = windAt(p.lon, p.lat);
    p.sp = Math.hypot(u, v);
    p.lat += (v * kw * dt) / (RB * K) / D;
    p.lon += (u * kw * dt) / (RA + RB * Math.cos(p.lat * D * K)) / D;
    if (p.lon > 180) p.lon -= 360; else if (p.lon < -180) p.lon += 360;
    if (shift) { p.hl.copyWithin(1, 0); p.ha.copyWithin(1, 0); }
    p.hl[0] = p.lon; p.ha[0] = p.lat;
    const env = Math.sin((Math.PI * p.age) / p.life) * (0.2 + Math.min(1, p.sp / 13) * 0.8);
    batch.push(p.lon * D, p.lat * D, 0.012, 0.62, 0.86, 0.95, env * 0.55, 0.014, 0);
    for (let i = 1; i < TRAIL; i++) {
      if (Math.abs(p.hl[i] - p.lon) > 90) break; // crossed the date line: drop the stale end
      const k0 = 1 - (i - 1) / TRAIL, k1 = 1 - i / TRAIL;
      lines.push(p.hl[i - 1] * D, p.ha[i - 1] * D, 0.012, 0.62, 0.86, 0.95, env * k0 * 0.6, 1, 0);
      lines.push(p.hl[i] * D, p.ha[i] * D, 0.012, 0.62, 0.86, 0.95, env * k1 * 0.6, 1, 0);
    }
  }
}

// ───────────────────────────── the living: fur ─────────────────────────────
const KINDS = {
  Plantae: [111, 220, 122], Aves: [111, 195, 255], Insecta: [255, 200, 87], Fungi: [229, 139, 255],
  Mammalia: [255, 143, 107], Reptilia: [181, 200, 74], Amphibia: [63, 224, 197], Mollusca: [242, 215, 192],
  Arachnida: [255, 93, 115], Actinopterygii: [77, 141, 255], Animalia: [255, 217, 160], Chromista: [154, 140, 255],
  Protozoa: [192, 192, 255], unknown: [207, 214, 224],
};
const KIND_NAMES = Object.keys(KINDS);
const KIND_WORDS = {
  Plantae: 'a plant', Aves: 'a bird', Insecta: 'an insect', Fungi: 'a fungus', Mammalia: 'a mammal', Reptilia: 'a reptile',
  Amphibia: 'an amphibian', Mollusca: 'a mollusc', Arachnida: 'an arachnid', Actinopterygii: 'a fish', Animalia: 'an animal',
  Chromista: 'a chromist', Protozoa: 'a protozoan', unknown: 'something alive',
};
const kindColor = (k) => KINDS[k] || KINDS.unknown;

const LIFE_MAX = 12000, FUR_STRIDE = 11, FUR_VERTS = 6;
const FUR_LAYOUT = [['aLL', 2], ['aT', 1], ['aLB', 2], ['aCol', 3], ['aW', 2], ['aPh', 1]];
const furData = new Float32Array(LIFE_MAX * FUR_VERTS * FUR_STRIDE), tipData = new Float32Array(LIFE_MAX * FUR_STRIDE);
const furBuf = gl.createBuffer(), tipBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, furBuf); gl.bufferData(gl.ARRAY_BUFFER, furData, gl.DYNAMIC_DRAW);
gl.bindBuffer(gl.ARRAY_BUFFER, tipBuf); gl.bufferData(gl.ARRAY_BUFFER, tipData, gl.DYNAMIC_DRAW);
const life = new Array(LIFE_MAX).fill(null); // a ring: the newest sighting overwrites the oldest
const lifeIds = new Set(), lifePending = [], blooms = [];
let lifeHead = 0, lifeCount = 0, furDirty = false;
const HAIR_T = [0, 1 / 3, 1 / 3, 2 / 3, 2 / 3, 1];

function writeHair(slot) {
  const o = life[slot], c = kindColor(o.kind);
  const w = wind && isLive('air') ? windAt(o.lon, o.lat) : [0, 0];
  const put = (arr, off, t) => {
    arr[off] = o.lon * D; arr[off + 1] = o.lat * D; arr[off + 2] = t; arr[off + 3] = o.len; arr[off + 4] = o.shown;
    arr[off + 5] = c[0] / 255; arr[off + 6] = c[1] / 255; arr[off + 7] = c[2] / 255; arr[off + 8] = w[0]; arr[off + 9] = w[1]; arr[off + 10] = o.ph;
  };
  for (let i = 0; i < FUR_VERTS; i++) put(furData, (slot * FUR_VERTS + i) * FUR_STRIDE, HAIR_T[i]);
  put(tipData, slot * FUR_STRIDE, 1);
}
function uploadHair(slot) {
  const a = slot * FUR_VERTS * FUR_STRIDE, b = slot * FUR_STRIDE;
  gl.bindBuffer(gl.ARRAY_BUFFER, furBuf); gl.bufferSubData(gl.ARRAY_BUFFER, a * 4, furData.subarray(a, a + FUR_VERTS * FUR_STRIDE));
  gl.bindBuffer(gl.ARRAY_BUFFER, tipBuf); gl.bufferSubData(gl.ARRAY_BUFFER, b * 4, tipData.subarray(b, b + FUR_STRIDE));
}
function refreshFur() { // e.g. when a new wind reading arrives
  for (let s = 0; s < LIFE_MAX; s++) if (life[s]) writeHair(s);
  gl.bindBuffer(gl.ARRAY_BUFFER, furBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, furData);
  gl.bindBuffer(gl.ARRAY_BUFFER, tipBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, tipData);
  furDirty = false;
}
function addLife(o, quiet) {
  if (lifeIds.has(o.id)) return;
  const slot = lifeHead;
  if (life[slot]) lifeIds.delete(life[slot].id);
  lifeHead = (lifeHead + 1) % LIFE_MAX;
  lifeCount = Math.min(LIFE_MAX, lifeCount + 1);
  lifeIds.add(o.id);
  o.len = 0.03 + Math.random() * 0.055;
  o.ph = Math.random() * TAU;
  o.shown = quiet ? secs(o.t) : secs(Date.now());
  life[slot] = o;
  writeHair(slot);
  if (quiet) { furDirty = true; return; }
  uploadHair(slot);
  blooms.push({ o, born: performance.now() });
  if (blooms.length > 300) blooms.shift();
  const s = toScreen(surface(o.lon, o.lat).p);
  playLife(Math.max(0, KIND_NAMES.indexOf(o.kind)), s ? clamp((s[0] / G.w) * 2 - 1, -1, 1) : 0);
  offerWhisper(1, () => `${o.name || KIND_WORDS[o.kind] || 'something alive'} — noticed${o.place ? ' in ' + o.place : ''}`);
}
function releaseLife() {
  const now = Date.now();
  let n = 0;
  while (lifePending.length && lifePending[0].due <= now && n++ < 12) addLife(lifePending.shift().o, false);
}

// ───────────────────────────── the ground ─────────────────────────────
const quakes = new Map();
function depthColor(km) {
  const sh = [1, 0.69, 0.26], mid = [1, 0.35, 0.46], deep = [0.66, 0.44, 1];
  const mix = (a, b, t) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);
  return km < 70 ? mix(sh, mid, clamp(km / 70, 0, 1)) : mix(mid, deep, clamp((km - 70) / 330, 0, 1));
}
const ripPos = new Float32Array(NRIP * 4), ripAmp = new Float32Array(NRIP);
function stepQuakes(now, nowP, batch) {
  const rips = [];
  for (const [id, q] of quakes) {
    const ageH = (now - q.t) / HOUR;
    if (ageH > 24) { quakes.delete(id); continue; }
    const c = q.color, m = Math.max(0, q.mag), size = 0.014 + m ** 1.7 * 0.0055, lon = q.lon * D, lat = q.lat * D;
    const a = 0.12 + 0.85 * (1 - ageH / 24) ** 2;
    batch.push(lon, lat, 0.006, c[0], c[1], c[2], a * 0.35, size * 4.5, 0);
    batch.push(lon, lat, 0.008, c[0], c[1], c[2], a, size * 1.4, 0);
    if (ageH < 0.5) { // the last half hour still trembles: a ripple through the skin every five seconds
      const ph = ((now - q.t) / 5000) % 1, k = 1 - ageH * 2;
      batch.push(lon, lat, 0.01, c[0], c[1], c[2], (1 - ph) * 0.6 * k, size * (2 + ph * 9), 1);
      rips.push({ q, amp: Math.min(0.012, 0.002 * 2 ** (m / 2)) * k, at: secs(now) - ph * 5 });
    }
    if (q.shock) { // it reached us just now
      const age = (nowP - q.shock) / 1000, dur = 9 + m;
      if (age > dur) q.shock = 0;
      else {
        rips.push({ q, amp: Math.min(0.14, 0.012 * 2 ** (m / 1.6)), at: secs(now) - age });
        for (let ring = 0; ring < 3; ring++) {
          const kk = age / 5 - ring * 0.15;
          if (kk > 0 && kk < 1) batch.push(lon, lat, 0.012, c[0], c[1], c[2], (1 - kk) ** 2, size * 2 + (1 - (1 - kk) ** 3) * 0.05 * 2 ** (m / 1.6), 1);
        }
      }
    }
  }
  rips.sort((a, b) => b.amp - a.amp);
  ripAmp.fill(0);
  for (let i = 0; i < Math.min(NRIP, rips.length); i++) {
    const r = rips[i], s = surface(r.q.lon, r.q.lat, 0, 0).p; // Earth frame, before it is turned to the Sun
    ripPos[i * 4] = s[0]; ripPos[i * 4 + 1] = s[1]; ripPos[i * 4 + 2] = s[2]; ripPos[i * 4 + 3] = r.at;
    ripAmp[i] = r.amp;
  }
}

// ───────────────────────────── people in orbit ─────────────────────────────
const iss = [];
function issNow(now) {
  const n = iss.length;
  if (!n) return null;
  const b = iss[n - 1];
  if (n < 2) return b;
  const a = iss[n - 2], span = b.t - a.t;
  if (span <= 0) return b;
  const k = clamp((now - b.t) / span, 0, 30_000 / span); // coast on the measured velocity, never more than 30 s
  let dl = b.lon - a.lon;
  if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
  return { ...b, lon: b.lon + dl * k, lat: clamp(b.lat + (b.lat - a.lat) * k, -90, 90) };
}
const ISS_H = 0.07;

// ───────────────────────────── the Sun ─────────────────────────────
let solar = null, auroraPeak = 0, auroraN = 0, auroraLive = false;
const auroraBatch = new Batch(gl, 4096);
function paintAurora(cells) {
  auroraBatch.reset();
  auroraPeak = 0;
  for (const cell of cells) {
    const v = cell[2];
    if (v > auroraPeak) auroraPeak = v;
    if (v < 3) continue;
    const a = clamp((v - 2) / 45, 0, 1) ** 0.9, hot = clamp((v - 35) / 50, 0, 1);
    const lon = cell[0] > 180 ? cell[0] - 360 : cell[0];
    auroraBatch.push(lon * D, cell[1] * D, 0.02 + a * 0.03, 0.35 + hot * 0.65, 1 - hot * 0.6, 0.65 + hot * 0.2, a * 0.7, 0.045, 0);
  }
  auroraBatch.cap = 0; // force a full upload
  auroraBatch.upload();
  auroraN = auroraBatch.n;
  auroraLive = true;
}
// Solar wind: dust crossing the whole space from the Sun's side, at its measured speed
// to the scale of the body (one Earth across).
const DUST = 420, BOX = 7, dust = [];
for (let i = 0; i < DUST; i++) dust.push([Math.random() * 2 * BOX, (Math.random() * 2 - 1) * BOX, (Math.random() * 2 - 1) * BOX]);
let dustShift = 0;
function stepDust(dt, lines) {
  if (!solar || !isLive('sun')) return;
  const v = (solar.speed / 12742) * 2 * (RA + RB);
  dustShift = (dustShift + v * dt) % (2 * BOX);
  const cd = Math.cos(G.sunLat * D), sd = Math.sin(G.sunLat * D), len = v * 1.6;
  for (const p of dust) {
    const s = ((p[0] - dustShift + 4 * BOX) % (2 * BOX)) - BOX; // along the Sun line
    // Sun direction S = (cd, sd, 0); perpendiculars (-sd, cd, 0) and (0, 0, 1)
    const x = cd * s - sd * p[1], y = sd * s + cd * p[1], z = p[2];
    lines.push(x, y, z, 1, 0.89, 0.67, 0.4);
    lines.push(x + cd * len, y + sd * len, z, 1, 0.89, 0.67, 0);
  }
}

// ───────────────────────────── the written: breath ─────────────────────────────
const spores = [];
let heartPulse = 0;
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
const SPORE_LIFE = 150;
function addSpore(p) {
  // Each wiki breathes out in its own fixed direction, up or down through the throat.
  const az = hash01(p.wiki) * TAU + (Math.random() - 0.5) * 0.35;
  const el = (30 + hash01(p.wiki + '~') * 52) * D * (hash01(p.wiki + '^') < 0.5 ? -1 : 1) + (Math.random() - 0.5) * 0.12;
  const big = clamp(Math.log10(p.len + 10) / 4.6, 0.05, 1);
  spores.push({ ...p, born: performance.now(), big, dir: [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)], reach: 0.9 + 1.9 * big + Math.random() * 0.2, ph: Math.random() * TAU });
  if (spores.length > 700) spores.shift();
  heartPulse = 1;
  playPage(p.bot, p.len);
  offerWhisper(0, () => `${p.bot ? 'a machine wrote' : 'a new page'} — “${p.title.length > 64 ? p.title.slice(0, 62) + '…' : p.title}” — ${p.domain}`);
}
function sporePos(s, nowP) {
  const age = (nowP - s.born) / 1000, r = 0.06 + s.reach * (1 - Math.exp(-age / 38));
  const wob = 0.035 * Math.sin(age * 0.5 + s.ph);
  return [s.dir[0] * r + wob * s.dir[2], s.dir[1] * r, s.dir[2] * r - wob * s.dir[0], age];
}
function stepSpores(nowP, dt, pts, lines) {
  for (let i = spores.length - 1; i >= 0; i--) {
    const s = spores[i], q = sporePos(s, nowP), age = q[3];
    if (age > SPORE_LIFE) { spores.splice(i, 1); continue; }
    const fade = clamp(age / 0.6, 0, 1) * clamp((SPORE_LIFE - age) / 40, 0, 1);
    const c = s.bot ? [0.59, 0.78, 1] : [1, 0.84, 0.59];
    const flash = age < 1.5 ? (1.5 - age) * 0.03 : 0;
    pts.push(q[0], q[1], q[2], c[0], c[1], c[2], fade * (s.bot ? 0.9 : 0.8), (s.bot ? 0.016 : 0.022) + s.big * 0.03 + flash, s.bot ? 2 : 0);
    const stalk = fade * clamp(1 - age / 45, 0, 1) * 0.22;
    if (stalk > 0.004) { lines.push(0, 0, 0, c[0], c[1], c[2], stalk * 0.3); lines.push(q[0], q[1], q[2], c[0], c[1], c[2], stalk); }
  }
  heartPulse = Math.max(0, heartPulse - dt * 1.6);
  if (isLive('written') || spores.length) pts.push(0, 0, 0, 1, 0.92, 0.78, 0.5 + heartPulse * 0.5, 0.22 + heartPulse * 0.14, 0);
}

// ───────────────────────────── whispers ─────────────────────────────
const whisperEl = $('whisper');
let whisperNext = null, whisperBusyUntil = 0;
function offerWhisper(priority, make) {
  if (whisperNext && whisperNext.priority > priority) return;
  if (whisperNext && whisperNext.priority === priority && Math.random() < 0.7) return;
  whisperNext = { priority, make };
}
function tickWhisper(nowP) {
  if (nowP < whisperBusyUntil) return;
  if (whisperEl.classList.contains('on')) { whisperEl.classList.remove('on'); whisperBusyUntil = nowP + 1300; return; }
  if (!whisperNext) return;
  whisperEl.textContent = whisperNext.make();
  whisperNext = null;
  whisperEl.classList.add('on');
  whisperBusyUntil = nowP + 5200;
}

// ───────────────────────────── touch: turn it, enter it, ask it ─────────────────────────────
const probeEl = $('probe'), markEl = $('mark');
let probeHide = 0, marked = null;
const fmtDeg = (v, pos, neg) => `${Math.abs(Math.round(v))}°${v >= 0 ? pos : neg}`;
function ago(t) {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
}
function hideProbe() { probeEl.hidden = true; markEl.hidden = true; marked = null; }
function setProbe(x, y, title, sub, world) {
  probeEl.replaceChildren();
  const b = document.createElement('b'); b.textContent = title; probeEl.append(b);
  if (sub) { const s = document.createElement('span'); s.textContent = sub; probeEl.append(s); }
  probeEl.hidden = false;
  const r = probeEl.getBoundingClientRect();
  const px = clamp(x - r.width / 2, 8, G.w - r.width - 8);
  const py = y - r.height - 22 < 8 ? y + 26 : y - r.height - 22;
  probeEl.style.transform = `translate(${Math.round(px)}px,${Math.round(py)}px)`;
  marked = world; // a function returning the thing's current world position, so the mark follows it
  markEl.hidden = !world;
}
function ask(x, y, isTouch) {
  clearTimeout(probeHide);
  probeHide = setTimeout(hideProbe, isTouch ? 7000 : 4000);
  const now = Date.now(), reach = isTouch ? 28 : 16;
  let best = null, bestD = reach * reach;
  const consider = (world, bias, make) => {
    const s = toScreen(world());
    if (!s) return;
    const d = (s[0] - x) ** 2 + (s[1] - y) ** 2 - bias;
    if (d < bestD) { bestD = d; best = { world, make }; }
  };
  const geo = (lon, lat, h, bias, make) => { const s = surface(lon, lat, h); if (facing(s)) consider(() => surface(lon, lat, h).p, bias, make); };
  const p = isLive('orbit') && issNow(now);
  if (p) geo(p.lon, p.lat, ISS_H, 250, () => ['International Space Station', `people, ${Math.round(p.alt)} km up, moving at ${Math.round(p.vel).toLocaleString()} km/h — in ${p.vis === 'daylight' ? 'sunlight' : "the Earth's shadow"}`]);
  for (const q of quakes.values()) geo(q.lon, q.lat, 0.01, 30 + q.mag * 14, () => [`Earthquake · magnitude ${q.mag.toFixed(1)}`, `${q.place} — ${Math.round(q.depth)} km deep, ${ago(q.t)}`]);
  for (const s of spores) consider(() => sporePos(s, performance.now()), 0, () => [`“${s.title}”`, `a page created on ${s.domain} by ${s.bot ? 'a bot' : 'a person'}, ${ago(s.t)}`]);
  for (const o of life) {
    if (o) geo(o.lon, o.lat, o.len, 0, () => [o.name || KIND_WORDS[o.kind] || 'something alive', `${KIND_WORDS[o.kind] || 'a living thing'}${o.latin && o.latin !== o.name ? ` (${o.latin})` : ''}, noticed${o.place ? ' in ' + o.place : ''} — shared ${ago(o.t)}`]);
  }
  if (best) { const [t, s] = best.make(); setProbe(x, y, t, s, best.world); return; }
  // Nothing in particular: where on the Earth is this patch of skin?
  let spot = null, spotD = 30 * 30;
  for (let lat = -85; lat <= 85; lat += 5) for (let lon = -180; lon < 180; lon += 5) {
    const s = surface(lon, lat);
    if (!facing(s)) continue;
    const sc = toScreen(s.p);
    if (!sc) continue;
    const d = (sc[0] - x) ** 2 + (sc[1] - y) ** 2;
    if (d < spotD) { spotD = d; spot = { lon, lat }; }
  }
  if (!spot) { hideProbe(); return; }
  let sub = `it is ${solarHourWords(spot.lon, G.sunLon)} there`;
  if (wind && isLive('air')) { const [wu, wv] = windAt(spot.lon, spot.lat); sub += ` · wind ${Math.hypot(wu, wv).toFixed(0)} m/s`; }
  setProbe(x, y, `near ${fmtDeg(spot.lat, 'N', 'S')} ${fmtDeg(spot.lon, 'E', 'W')}`, sub, null);
}

const pointers = new Map();
let gesture = null;
function holdCamera() { cam.auto = false; cam.idleAt = performance.now(); }
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 1) gesture = { x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, pinch: 0 };
  else if (pointers.size === 2 && gesture) { const [a, b] = [...pointers.values()]; gesture.pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); gesture.moved = true; }
  stayAwake();
});
canvas.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) { if (e.pointerType === 'mouse') ask(e.clientX, e.clientY, false); return; }
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2 && gesture) {
    const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (gesture.pinch > 0 && d > 0) cam.dist = clamp((cam.dist * gesture.pinch) / d, 1.7, 12);
    gesture.pinch = d;
    holdCamera();
  } else if (gesture) {
    if (!gesture.moved && Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) > 7) gesture.moved = true;
    if (gesture.moved) {
      const k = 4.2 / Math.min(G.w, G.h);
      cam.az += (e.clientX - prev[0]) * k;
      cam.el = clamp(cam.el + (e.clientY - prev[1]) * k, -1.45, 1.45);
      holdCamera();
      hideProbe();
    }
  }
});
const endPointer = (e) => {
  if (!pointers.delete(e.pointerId)) return;
  if (pointers.size === 0 && gesture) {
    if (!gesture.moved && e.type === 'pointerup' && performance.now() - gesture.t0 < 500) ask(e.clientX, e.clientY, e.pointerType !== 'mouse');
    gesture = null;
  } else if (gesture) gesture.pinch = 0;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0012), 1.7, 12); holdCamera(); }, { passive: false });

// ───────────────────────────── wiring the sources ─────────────────────────────
const sources = createSources({
  quakes(list, initial) {
    for (const q of list) {
      const known = quakes.get(q.id);
      if (known) { Object.assign(known, q, { color: depthColor(q.depth), shock: known.shock }); continue; }
      q.color = depthColor(q.depth);
      q.shock = 0;
      quakes.set(q.id, q);
      if (!initial && Date.now() - q.t < HOUR) {
        q.shock = performance.now();
        const s = toScreen(surface(q.lon, q.lat).p);
        playQuake(q.mag, s ? clamp((s[0] / G.w) * 2 - 1, -1, 1) : 0);
        offerWhisper(q.mag >= 4 ? 3 : 2, () => `the ground moved — magnitude ${q.mag.toFixed(1)}, ${q.place}`);
      }
    }
  },
  life(list, initial) {
    list.sort((a, b) => a.t - b.t);
    if (initial) { for (const o of list) addLife(o, true); return; }
    // Replay the batch with its true rhythm, compressed only if it would outlast the next one.
    const now = Date.now(), t0 = list[0].t, span = Math.max(1, list[list.length - 1].t - t0), squeeze = Math.min(1, 38_000 / span);
    for (const o of list) lifePending.push({ o, due: now + (o.t - t0) * squeeze });
    if (lifePending.length > 1500) lifePending.splice(0, lifePending.length - 1500).forEach((p) => addLife(p.o, true));
  },
  iss(fix) {
    const last = iss[iss.length - 1];
    if (last && fix.t <= last.t) return;
    if (last && fix.t - last.t > 120_000) iss.length = 0; // a gap: don't draw a line through the unknown
    iss.push(fix);
    if (iss.length > 90) iss.shift();
  },
  solarWind(s) { solar = s; },
  aurora: paintAurora,
  wind(w) { wind = w; furDirty = true; },
  page: addSpore,
});

// ───────────────────────────── the frame ─────────────────────────────
const geoPts = new Batch(gl, 24000), geoLines = new Batch(gl, 40000), worldPts = new Batch(gl, 1024), worldLines = new Batch(gl, 2048);
const lineTo = (batch) => ({ push: (x, y, z, r, g, b, a) => batch.push(x, y, z, r, g, b, a, 1, 0) });
const meridian = -new Date().getTimezoneOffset() / 4; // your clock's meridian, not your location
let last = performance.now(), lastSlow = 0, slowSum = 0, slowN = 0, airWasLive = false;

function common(p, t) {
  gl.useProgram(p.p);
  gl.uniformMatrix4fv(p.u.uVP, false, cam.vp);
  gl.uniform1f(p.u.uSun, G.sunLon * D);
  gl.uniform1f(p.u.uTime, t);
  gl.uniform4fv(p.u.uRip, ripPos);
  gl.uniform1fv(p.u.uRipAmp, ripAmp);
}
function drawBatch(batch, mode, geoFlag, shim = 0) {
  if (!batch.n) return;
  const p = prog.pts;
  gl.uniform1f(p.u.uGeo, geoFlag);
  gl.uniform1f(p.u.uLine, mode === gl.LINES ? 1 : 0);
  gl.uniform1f(p.u.uShim, shim);
  bindLayout(gl, p, batch.buf, PTS_LAYOUT);
  gl.drawArrays(mode, 0, batch.n);
}

function frame(nowP) {
  requestAnimationFrame(frame);
  const rawDt = nowP - last;
  const dt = Math.min(0.05, rawDt / 1000);
  last = nowP;
  // Self-care: if frames are slow for a sustained stretch, draw fewer pixels rather than stutter.
  if (rawDt < 1000) { slowSum += rawDt; slowN++; }
  if (slowN >= 120) {
    if (slowSum / slowN > 36 && maxDpr > 1 && (window.devicePixelRatio || 1) > 1) { maxDpr = maxDpr > 1.5 ? 1.5 : 1; resize(); }
    slowSum = slowN = 0;
  }
  const now = Date.now(), t = secs(now);

  if (nowP - lastSlow > 1000) {
    lastSlow = nowP;
    const s = subsolar(now);
    G.sunLon = s.lon; G.sunLat = s.lat;
    const air = !!wind && isLive('air');
    if (air !== airWasLive) { airWasLive = air; furDirty = true; }
    if ($('about').open) updateAbout();
  }
  if (furDirty) refreshFur();
  releaseLife();
  tickWhisper(nowP);
  updateCamera(dt, nowP / 1000);

  // gather everything that moves
  geoPts.reset(); geoLines.reset(); worldPts.reset(); worldLines.reset();
  stepWind(dt, geoPts, geoLines);
  stepQuakes(now, nowP, geoPts);
  for (let i = blooms.length - 1; i >= 0; i--) {
    const b = blooms[i], age = (nowP - b.born) / 1000;
    if (age > 5) { blooms.splice(i, 1); continue; }
    const c = kindColor(b.o.kind), k = age / 5;
    geoPts.push(b.o.lon * D, b.o.lat * D, b.o.len, c[0] / 255, c[1] / 255, c[2] / 255, (1 - k) * 0.8, 0.02 + (1 - (1 - k) ** 3) * 0.14, 1);
  }
  if (isLive('orbit')) {
    const p = issNow(now);
    if (p) {
      geoPts.push(p.lon * D, p.lat * D, ISS_H, 0.82, 0.94, 1, 0.55, 0.16, 0);
      geoPts.push(p.lon * D, p.lat * D, ISS_H, 1, 1, 1, 1, 0.035, 0);
      for (let i = 1; i < iss.length; i++) {
        if (Math.abs(iss[i].lon - iss[i - 1].lon) > 180) continue; // don't draw across the date-line seam
        geoLines.push(iss[i - 1].lon * D, iss[i - 1].lat * D, ISS_H, 0.82, 0.94, 1, ((i - 1) / iss.length) * 0.6, 1, 0);
        geoLines.push(iss[i].lon * D, iss[i].lat * D, ISS_H, 0.82, 0.94, 1, (i / iss.length) * 0.6, 1, 0);
      }
    }
  }
  for (let lat = -84; lat < 84; lat += 6) { // your meridian: a faint band around the body
    geoLines.push(meridian * D, lat * D, 0.004, 0.91, 0.89, 0.85, 0.2, 1, 0);
    geoLines.push(meridian * D, (lat + 6) * D, 0.004, 0.91, 0.89, 0.85, 0.2, 1, 0);
  }
  stepDust(dt, lineTo(worldLines));
  stepSpores(nowP, dt, worldPts, lineTo(worldLines));
  // the Sun itself, far off along its true direction
  worldPts.push(Math.cos(G.sunLat * D) * 40, Math.sin(G.sunLat * D) * 40, 0, 1, 0.86, 0.6, 0.9, 9, 0);
  for (const b of [geoPts, geoLines, worldPts, worldLines]) b.upload();

  // draw
  gl.clearColor(0.016, 0.02, 0.039, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  common(prog.body, t);
  gl.uniform1f(prog.body.u.uDecl, G.sunLat * D);
  gl.uniform3fv(prog.body.u.uEye, cam.eye);
  bindLayout(gl, prog.body, body.vb, [['aLL', 2]]);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, body.ib);
  gl.drawElements(gl.TRIANGLES, body.n, gl.UNSIGNED_SHORT, 0);

  // everything else is light: added on top, hidden by the body but never hiding each other
  gl.depthMask(false);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);

  if (lifeCount) {
    const p = prog.fur;
    common(p, t);
    gl.uniform1f(p.u.uPx, cam.px);
    gl.uniform1f(p.u.uMaxPt, MAX_PT);
    gl.uniform1f(p.u.uTip, 0);
    bindLayout(gl, p, furBuf, FUR_LAYOUT);
    gl.drawArrays(gl.LINES, 0, lifeCount * FUR_VERTS);
    gl.uniform1f(p.u.uTip, 1);
    bindLayout(gl, p, tipBuf, FUR_LAYOUT);
    gl.drawArrays(gl.POINTS, 0, lifeCount);
  }

  common(prog.pts, t);
  gl.uniform1f(prog.pts.u.uPx, cam.px);
  gl.uniform1f(prog.pts.u.uMaxPt, MAX_PT);
  if (auroraLive && isLive('aurora')) {
    auroraBatch.n = auroraN;
    // the curtains ripple faster when the solar wind blows harder
    drawBatch(auroraBatch, gl.POINTS, 1, solar ? (solar.speed / 450) * 1.1 : 1.1);
  }
  drawBatch(geoPts, gl.POINTS, 1);
  drawBatch(geoLines, gl.LINES, 1);
  drawBatch(worldLines, gl.LINES, 0);
  drawBatch(worldPts, gl.POINTS, 0);

  if (marked) {
    const s = toScreen(marked());
    if (s) markEl.style.transform = `translate(${Math.round(s[0])}px,${Math.round(s[1])}px)`;
  }
}

// ───────────────────────────── the panel ─────────────────────────────
function updateAbout() {
  const now = Date.now();
  let big = null, hourCount = 0;
  for (const q of quakes.values()) { if (!big || q.mag > big.mag) big = q; if (now - q.t < HOUR) hourCount++; }
  const p = issNow(now);
  let oldest = now;
  for (const o of life) if (o && o.t < oldest) oldest = o.t;
  const lines = {
    ground: quakes.size ? `${quakes.size} in the past day, ${hourCount} in the past hour. Strongest: magnitude ${big.mag.toFixed(1)}, ${big.place}.` : '',
    air: wind ? `Read ${ago(wind.at)}; refreshed every two hours.` : '',
    life: lifeCount ? `${lifeCount.toLocaleString()} hairs on the body, the oldest shared ${ago(oldest)}.` : '',
    written: spores.length ? `${spores.length} pages born in the last ${SPORE_LIFE} seconds, ${spores.filter((s) => s.bot).length} of them by bots.` : '',
    orbit: p ? `Now over ${fmtDeg(p.lat, 'N', 'S')} ${fmtDeg(p.lon, 'E', 'W')}, ${Math.round(p.alt)} km up.` : '',
    sun: solar ? `Solar wind ${Math.round(solar.speed)} km/s${solar.bz == null ? '' : `, magnetic field ${solar.bz < 0 ? 'tilted south (aurora-friendly)' : 'tilted north'}`}.${auroraLive && isLive('aurora') ? ` Aurora peaks at ${auroraPeak}% likelihood.` : ''}` : '',
  };
  for (const li of document.querySelectorAll('#layers li')) {
    const k = li.dataset.src, live = isLive(k);
    li.classList.toggle('live', live);
    const st = status[k];
    li.querySelector('em').textContent = live ? lines[k] || 'Listening…' : st && st.error
      ? (/429/.test(st.error) ? 'The source is rationing your network right now — will try again later.' : 'Silent right now — will keep trying.') : 'Listening…';
  }
}
const about = $('about');
$('about-open').addEventListener('click', () => { updateAbout(); about.showModal(); });
about.addEventListener('click', (e) => { if (e.target === about) about.close(); });

const soundBtn = $('sound');
soundBtn.addEventListener('click', async () => {
  let on = false;
  try { on = await toggleSound(); } catch { on = false; }
  soundBtn.setAttribute('aria-pressed', String(on && soundOn()));
});

// ───────────────────────────── go ─────────────────────────────
{ const s = subsolar(Date.now()); G.sunLon = s.lon; G.sunLat = s.lat; }
resize();
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 120); });
// Listen only while someone is looking: kind to batteries, data plans and the sources.
// And keep the screen awake while it is being watched (released automatically when hidden).
let wake = null;
async function stayAwake() {
  if (!('wakeLock' in navigator) || wake || document.hidden) return;
  try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } catch { /* denied or unsupported: fine */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { sources.stop(); slowSum = slowN = 0; }
  else { sources.start(); last = performance.now(); stayAwake(); }
});
stayAwake();
if (!document.hidden) sources.start();
requestAnimationFrame(frame);
