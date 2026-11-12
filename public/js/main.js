import { subsolar, solarHourWords } from './astro.js';
import { createSources, status, isLive } from './sources.js';
import { toggleSound, soundOn, playLife, playPage, playQuake } from './audio.js';

const D = Math.PI / 180, TAU = Math.PI * 2;
const HOUR = 3_600_000;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const $ = (id) => document.getElementById(id);

const canvas = $('c');
const ctx = canvas.getContext('2d');

// ───────────────────────────── geometry ─────────────────────────────
// The ring: angle is longitude (Sun at the top, east runs anticlockwise, as the
// Earth turns when seen from above the north pole); radius is latitude (north
// pole at the inner rim, south pole at the outer rim).
const G = { w: 0, h: 0, dpr: 1, cx: 0, cy: 0, R: 1, r0: 1, sunLon: 0, sunLat: 0 };
const INNER = 0.4;

const angOf = (lon) => -Math.PI / 2 - (lon - G.sunLon) * D;
const radOf = (lat) => G.r0 + ((90 - lat) / 180) * (G.R - G.r0);
function project(lon, lat) {
  const a = angOf(lon), r = radOf(lat);
  return [G.cx + r * Math.cos(a), G.cy + r * Math.sin(a)];
}
function unproject(x, y) {
  const dx = x - G.cx, dy = y - G.cy, r = Math.hypot(dx, dy);
  const lat = 90 - ((r - G.r0) / (G.R - G.r0)) * 180;
  let lon = G.sunLon - (Math.atan2(dy, dx) + Math.PI / 2) / D;
  lon = (((lon + 180) % 360) + 360) % 360 - 180;
  return { lon, lat, r };
}

// Layers painted once in the Earth's own frame and then turned with the planet.
const geoLayer = () => { const c = document.createElement('canvas'); return { c, x: c.getContext('2d') }; };
const lifeLayer = geoLayer(), auroraLayer = geoLayer();
const dayTex = document.createElement('canvas');
let geoSize = 0, geoScale = 1;

function geoXY(lon, lat) { // position inside a geo layer (lon 0 points right, unrotated)
  const a = -lon * D, r = radOf(lat) * geoScale, h = geoSize / 2;
  return [h + r * Math.cos(a), h + r * Math.sin(a)];
}
function drawGeo(layer, alpha, extraRot = 0, scale = 1) {
  if (!geoSize) return;
  const s = (geoSize / geoScale) * scale;
  ctx.save();
  ctx.translate(G.cx, G.cy);
  ctx.rotate(-Math.PI / 2 + G.sunLon * D + extraRot);
  ctx.globalAlpha = alpha;
  ctx.drawImage(layer.c, -s / 2, -s / 2, s, s);
  ctx.restore();
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  G.w = w; G.h = h; G.dpr = dpr;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const portrait = h > w * 1.15;
  G.R = Math.max(60, Math.min(w * 0.47, h * (portrait ? 0.4 : 0.43)));
  G.r0 = G.R * INNER;
  G.cx = w / 2;
  G.cy = portrait ? h * 0.47 : h * 0.48;
  geoScale = dpr;
  geoSize = Math.ceil((G.R + 6) * 2 * dpr);
  for (const l of [lifeLayer, auroraLayer]) { l.c.width = geoSize; l.c.height = geoSize; }
  paintLife();
  paintAurora();
  seedWind();
  seedDust();
}

// ───────────────────────────── day & night ─────────────────────────────
// The body of the ring is lit by where the Sun really is, season included.
let dayTexDecl = 99;
function paintDaylight() {
  if (Math.abs(G.sunLat - dayTexDecl) < 0.05) return;
  dayTexDecl = G.sunLat;
  const S = 288, img = new ImageData(S, S), d = img.data;
  const sd = Math.sin(G.sunLat * D), cd = Math.cos(G.sunLat * D);
  const edge = 2.5 / (S / 2), PAD = 1.04;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = ((x + 0.5) / (S / 2) - 1) * PAD, ny = ((y + 0.5) / (S / 2) - 1) * PAD;
      const r = Math.hypot(nx, ny);
      if (r < INNER - edge || r > 1 + edge) continue;
      const lat = (90 - ((r - INNER) / (1 - INNER)) * 180) * D;
      const hourAngle = -(Math.atan2(ny, nx) + Math.PI / 2);
      const cz = Math.sin(lat) * sd + Math.cos(lat) * cd * Math.cos(hourAngle); // cosine of the Sun's zenith angle
      const day = clamp((cz + 0.1) / 0.5, 0, 1);
      const dusk = Math.exp(-((cz / 0.09) ** 2));
      const feather = clamp((r - (INNER - edge)) / edge, 0, 1) * clamp((1 + edge - r) / edge, 0, 1);
      const i = (y * S + x) * 4;
      d[i] = 10 + day * 12 + dusk * 46;
      d[i + 1] = 12 + day * 44 + dusk * 16;
      d[i + 2] = 26 + day * 58 + dusk * 30;
      d[i + 3] = 255 * feather * (0.72 + day * 0.2);
    }
  }
  dayTex.width = dayTex.height = S;
  dayTex.getContext('2d').putImageData(img, 0, 0);
}

// ───────────────────────────── the air ─────────────────────────────
let wind = null;
const parts = [];
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
function respawn(p) {
  p.lon = Math.random() * 360 - 180;
  p.lat = Math.asin(Math.random() * 2 - 1) / D; // uniform over the sphere
  p.age = 0;
  p.life = 4 + Math.random() * 7;
  p.fresh = true;
}
function seedWind() {
  const n = Math.round(clamp(700 + G.R * 5, 900, 3200));
  parts.length = 0;
  for (let i = 0; i < n; i++) { const p = { tx: 0, ty: 0 }; respawn(p); p.age = Math.random() * p.life; parts.push(p); }
}
const BUCKETS = 4;
function drawWind(dt) {
  if (!wind || !isLive('air')) return;
  const kpx = G.R * 0.0052; // px per second per m/s — the one deliberate exaggeration
  const span = G.R - G.r0;
  const paths = [];
  for (let b = 0; b < BUCKETS; b++) paths.push(new Path2D());
  for (const p of parts) {
    p.age += dt;
    if (p.age > p.life || Math.abs(p.lat) > 87) respawn(p);
    const [u, v] = windAt(p.lon, p.lat);
    const r = radOf(p.lat);
    p.lat += ((v * kpx * dt) / span) * 180;
    p.lon += ((u * kpx * dt) / r) / D;
    if (p.lon > 180) p.lon -= 360; else if (p.lon < -180) p.lon += 360;
    const [x, y] = project(p.lon, p.lat);
    if (p.fresh) { p.tx = x; p.ty = y; p.fresh = false; }
    p.tx += (x - p.tx) * Math.min(1, dt * 2.2);
    p.ty += (y - p.ty) * Math.min(1, dt * 2.2);
    const sp = Math.hypot(u, v);
    const a = Math.sin((Math.PI * p.age) / p.life) * (0.25 + Math.min(1, sp / 13) * 0.75);
    const path = paths[Math.min(BUCKETS - 1, (a * BUCKETS) | 0)];
    path.moveTo(p.tx, p.ty);
    path.lineTo(x, y);
  }
  ctx.lineCap = 'round';
  ctx.lineWidth = 1;
  for (let b = 0; b < BUCKETS; b++) {
    ctx.strokeStyle = `rgba(176,222,236,${0.07 + (b / (BUCKETS - 1)) * 0.36})`;
    ctx.stroke(paths[b]);
  }
}

// ───────────────────────────── the living ─────────────────────────────
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
const rgb = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const kindColor = (k) => KINDS[k] || KINDS.unknown;

const life = [];        // on the ring
const lifePending = []; // waiting for their moment (replayed with their true spacing)
const blooms = [];      // arrivals still unfurling
const LIFE_MAX = 6000, LIFE_TTL = 6 * HOUR;
const lifeIds = new Set();

function lifeAlpha(o, now) {
  const age = now - o.t;
  return age < 0.5 * HOUR ? 0.85 : clamp(0.85 - ((age - 0.5 * HOUR) / (3 * HOUR)) * 0.6, 0.25, 0.85);
}
function stampLife(o, now) {
  const [x, y] = geoXY(o.lon, o.lat), x2 = lifeLayer.x;
  x2.fillStyle = rgb(kindColor(o.kind), lifeAlpha(o, now));
  x2.beginPath();
  x2.arc(x, y, 1.05 * geoScale, 0, TAU);
  x2.fill();
}
function paintLife() {
  const now = Date.now();
  while (life.length && (now - life[0].t > LIFE_TTL || life.length > LIFE_MAX)) lifeIds.delete(life.shift().id);
  lifeLayer.x.clearRect(0, 0, geoSize, geoSize);
  for (const o of life) stampLife(o, now);
}
function addLife(o, quiet) {
  if (lifeIds.has(o.id)) return;
  lifeIds.add(o.id);
  life.push(o);
  stampLife(o, Date.now());
  if (quiet) return;
  blooms.push({ o, born: performance.now() });
  if (blooms.length > 400) blooms.shift();
  const [x] = project(o.lon, o.lat);
  playLife(Math.max(0, KIND_NAMES.indexOf(o.kind)), (x - G.cx) / G.R);
  offerWhisper(1, () => `${o.name || KIND_WORDS[o.kind] || 'something alive'} — noticed${o.place ? ' in ' + o.place : ''}`);
}
function releaseLife() {
  const now = Date.now();
  let n = 0;
  while (lifePending.length && lifePending[0].due <= now && n++ < 12) addLife(lifePending.shift().o, false);
}
function drawBlooms(nowP) {
  for (let i = blooms.length - 1; i >= 0; i--) {
    const b = blooms[i], age = (nowP - b.born) / 1000;
    if (age > 5) { blooms.splice(i, 1); continue; }
    const [x, y] = project(b.o.lon, b.o.lat), c = kindColor(b.o.kind), k = age / 5;
    ctx.strokeStyle = rgb(c, (1 - k) * 0.7);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 1.5 + (1 - (1 - k) ** 3) * G.R * 0.045, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = rgb(c, (1 - k) * 0.9);
    ctx.beginPath();
    ctx.arc(x, y, 1.2 + (1 - k) * 1.8, 0, TAU);
    ctx.fill();
  }
}

// ───────────────────────────── the ground ─────────────────────────────
const quakes = new Map();
function depthColor(km) {
  const sh = [255, 176, 66], mid = [255, 88, 118], deep = [168, 112, 255];
  const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
  return km < 70 ? mix(sh, mid, clamp(km / 70, 0, 1)) : mix(mid, deep, clamp((km - 70) / 330, 0, 1));
}
const quakeSize = (mag) => (1 + Math.max(0, mag) ** 1.7 * 0.5) * (G.R / 300 + 0.35);
function drawQuakes(now, nowP) {
  for (const [id, q] of quakes) {
    const ageH = (now - q.t) / HOUR;
    if (ageH > 24) { quakes.delete(id); continue; }
    const [x, y] = project(q.lon, q.lat), c = q.color, s = quakeSize(q.mag);
    const a = 0.1 + 0.8 * (1 - ageH / 24) ** 2;
    ctx.fillStyle = rgb(c, a * 0.16);
    ctx.beginPath(); ctx.arc(x, y, s * 2.6, 0, TAU); ctx.fill();
    ctx.fillStyle = rgb(c, a);
    ctx.beginPath(); ctx.arc(x, y, s * 0.8, 0, TAU); ctx.fill();
    if (ageH < 0.5) { // the last half hour still trembles
      const ph = ((now - q.t) / 3800) % 1;
      ctx.strokeStyle = rgb(c, (1 - ph) * 0.5 * (1 - ageH * 2));
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, s * (1 + ph * 4.5), 0, TAU); ctx.stroke();
    }
    if (q.shock) { // it reached us just now
      const k = (nowP - q.shock) / (4000 + q.mag * 900);
      if (k >= 1) q.shock = 0;
      else {
        const reach = G.R * 0.035 * 2 ** (Math.max(0.5, q.mag) / 1.6);
        for (let ring = 0; ring < 3; ring++) {
          const kk = k - ring * 0.12;
          if (kk <= 0) continue;
          ctx.strokeStyle = rgb(c, (1 - kk) ** 2 * 0.9);
          ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.arc(x, y, s + (1 - (1 - kk) ** 3) * reach, 0, TAU); ctx.stroke();
        }
      }
    }
  }
}

// ───────────────────────────── people in orbit ─────────────────────────────
const iss = []; // recent true fixes
function issNow(now) {
  const n = iss.length;
  if (!n) return null;
  const b = iss[n - 1];
  if (n < 2) return b;
  const a = iss[n - 2], span = b.t - a.t;
  if (span <= 0) return b;
  // Between fixes, coast along the measured velocity (never more than 30 s ahead).
  const k = clamp((now - b.t) / span, 0, 30_000 / span);
  let dl = b.lon - a.lon;
  if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
  return { ...b, lon: b.lon + dl * k, lat: clamp(b.lat + (b.lat - a.lat) * k, -90, 90) };
}
function drawISS(now) {
  if (!isLive('orbit')) return;
  const p = issNow(now);
  if (!p) return;
  ctx.lineWidth = 1.2;
  for (let i = 1; i < iss.length; i++) {
    const [x0, y0] = project(iss[i - 1].lon, iss[i - 1].lat), [x1, y1] = project(iss[i].lon, iss[i].lat);
    ctx.strokeStyle = `rgba(210,240,255,${(i / iss.length) * 0.5})`;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  const [x, y] = project(p.lon, p.lat);
  const g = ctx.createRadialGradient(x, y, 0, x, y, 11);
  g.addColorStop(0, 'rgba(210,240,255,0.55)');
  g.addColorStop(1, 'rgba(210,240,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, 11, 0, TAU); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(x, y, 2.1, 0, TAU); ctx.fill();
}

// ───────────────────────────── the Sun ─────────────────────────────
let solar = null, auroraCells = null, auroraPeak = 0;
const dust = [];
function seedDust() {
  dust.length = 0;
  const n = Math.round(clamp((G.w * G.h) / 9000, 40, 130));
  for (let i = 0; i < n; i++) dust.push({ x: Math.random() * G.w, y: Math.random() * G.h, z: 0.4 + Math.random() * 0.6 });
}
function drawDust(dt) {
  if (!solar || !isLive('sun')) return;
  // True to scale: the ring is one Earth across (12,742 km), so 450 km/s crosses it in ~28 s.
  const vy = (solar.speed / 12742) * 2 * G.R;
  const keep = (G.R * 1.05) ** 2;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,226,170,0.34)';
  ctx.beginPath();
  for (const p of dust) {
    p.y += vy * dt;
    if (p.y > G.h + 10) { p.y = -10; p.x = Math.random() * G.w; }
    const dx = p.x - G.cx, dy = p.y - G.cy;
    if (dx * dx + dy * dy < keep) continue; // the planet's shelter
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x, p.y - Math.max(2, vy * 0.35 * p.z));
  }
  ctx.stroke();
}
function paintAurora() {
  const x2 = auroraLayer.x;
  x2.clearRect(0, 0, geoSize, geoSize);
  if (!auroraCells) return;
  const h = geoSize / 2, step = D * 1.08;
  x2.lineWidth = Math.max(1.3 * geoScale, ((G.R - G.r0) / 180) * geoScale * 2.2);
  x2.globalCompositeOperation = 'lighter';
  auroraPeak = 0;
  for (const cell of auroraCells) {
    const v = cell[2];
    if (v > auroraPeak) auroraPeak = v;
    if (v < 3) continue;
    const a = clamp((v - 2) / 45, 0, 1) ** 0.9, hot = clamp((v - 35) / 50, 0, 1);
    x2.strokeStyle = `rgba(${Math.round(90 + hot * 165)},${Math.round(255 - hot * 150)},${Math.round(165 + hot * 50)},${a})`;
    const r = radOf(cell[1]) * geoScale, a0 = -cell[0] * D;
    x2.beginPath();
    x2.arc(h, h, r, a0 - step, a0);
    x2.stroke();
  }
}
function drawAurora(t) {
  if (!auroraCells || !isLive('aurora')) return;
  // The curtains ripple faster when the solar wind blows harder.
  const rate = solar ? solar.speed / 450 : 1;
  const s1 = 0.5 + 0.5 * Math.sin(t * 0.9 * rate), s2 = 0.5 + 0.5 * Math.sin(t * 0.53 * rate + 2);
  ctx.globalCompositeOperation = 'lighter';
  drawGeo(auroraLayer, 0.55 + 0.3 * s1);
  drawGeo(auroraLayer, 0.16 + 0.2 * s2, 0.012 * Math.sin(t * 0.31), 1.012);
  drawGeo(auroraLayer, 0.16 + 0.2 * (1 - s2), -0.012 * Math.sin(t * 0.27), 0.988);
  ctx.globalCompositeOperation = 'source-over';
}

// ───────────────────────────── the written ─────────────────────────────
const seeds = [];
let corePulse = 0;
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
const SEED_LIFE = 120;
function addSeed(p) {
  const h = hash01(p.wiki);
  seeds.push({
    ...p, born: performance.now(),
    ang: h * TAU + (Math.random() - 0.5) * 0.3,
    reach: 0.2 + 0.68 * clamp(Math.log10(p.len + 10) / 4.6, 0.05, 1) + (Math.random() - 0.5) * 0.06,
    bend: (hash01(p.wiki + '~') - 0.5) * 0.9,
    ph: Math.random() * TAU,
  });
  if (seeds.length > 600) seeds.shift();
  corePulse = 1;
  playPage(p.bot, p.len);
  offerWhisper(0, () => `${p.bot ? 'a machine wrote' : 'a new page'} — “${p.title.length > 64 ? p.title.slice(0, 62) + '…' : p.title}” — ${p.domain}`);
}
function seedTip(s, nowP) {
  const age = (nowP - s.born) / 1000;
  const grow = 1 - (1 - clamp(age / 3.5, 0, 1)) ** 3;
  const a = s.ang + Math.sin(nowP / 2600 + s.ph) * 0.014;
  const r = G.r0 * 0.86 * s.reach * grow;
  return { x: G.cx + r * Math.cos(a), y: G.cy + r * Math.sin(a), a, r, age };
}
function drawSeeds(nowP, dt) {
  const live = isLive('written');
  for (let i = seeds.length - 1; i >= 0; i--) {
    const s = seeds[i], tip = seedTip(s, nowP);
    if (tip.age > SEED_LIFE) { seeds.splice(i, 1); continue; }
    const fade = clamp(tip.age / 0.6, 0, 1) * clamp((SEED_LIFE - tip.age) / 30, 0, 1);
    const col = s.bot ? [150, 200, 255] : [255, 214, 150];
    // stalk
    const mx = G.cx + tip.r * 0.5 * Math.cos(tip.a + s.bend * 0.35), my = G.cy + tip.r * 0.5 * Math.sin(tip.a + s.bend * 0.35);
    ctx.strokeStyle = rgb(col, fade * 0.2);
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(G.cx, G.cy); ctx.quadraticCurveTo(mx, my, tip.x, tip.y); ctx.stroke();
    // seed
    const size = 1.1 + clamp(Math.log10(s.len + 10) / 4.6, 0, 1) * 1.9 + (tip.age < 1.5 ? (1.5 - tip.age) * 1.6 : 0);
    ctx.fillStyle = rgb(col, fade * 0.95);
    ctx.beginPath();
    if (s.bot) { ctx.moveTo(tip.x, tip.y - size * 1.25); ctx.lineTo(tip.x + size * 1.25, tip.y); ctx.lineTo(tip.x, tip.y + size * 1.25); ctx.lineTo(tip.x - size * 1.25, tip.y); }
    else ctx.arc(tip.x, tip.y, size, 0, TAU);
    ctx.fill();
  }
  corePulse = Math.max(0, corePulse - dt * 1.6);
  if (live || seeds.length) {
    const r = G.r0 * (0.07 + corePulse * 0.05);
    const g = ctx.createRadialGradient(G.cx, G.cy, 0, G.cx, G.cy, r);
    g.addColorStop(0, `rgba(255,236,200,${0.5 + corePulse * 0.4})`);
    g.addColorStop(1, 'rgba(255,236,200,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(G.cx, G.cy, r, 0, TAU); ctx.fill();
  }
}

// ───────────────────────────── whispers ─────────────────────────────
// One quiet line of text at a time, each one a real event that just happened.
const whisperEl = $('whisper');
let whisperNext = null, whisperBusyUntil = 0;
function offerWhisper(priority, make) {
  if (whisperNext && whisperNext.priority > priority) return;
  if (whisperNext && whisperNext.priority === priority && Math.random() < 0.7) return;
  whisperNext = { priority, make };
}
function tickWhisper(nowP) {
  if (nowP < whisperBusyUntil) return;
  if (whisperEl.classList.contains('on')) {
    whisperEl.classList.remove('on');
    whisperBusyUntil = nowP + 1300;
    return;
  }
  if (!whisperNext) return;
  whisperEl.textContent = whisperNext.make();
  whisperNext = null;
  whisperEl.classList.add('on');
  whisperBusyUntil = nowP + 5200;
}

// ───────────────────────────── touch: ask what is there ─────────────────────────────
const probeEl = $('probe');
let probe = null, probeHide = 0;
const fmtDeg = (v, pos, neg) => `${Math.abs(Math.round(v))}°${v >= 0 ? pos : neg}`;
function ago(t) {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
}
function setProbe(x, y, title, sub, hx = x, hy = y) {
  probeEl.replaceChildren();
  const b = document.createElement('b'); b.textContent = title; probeEl.append(b);
  if (sub) { const s = document.createElement('span'); s.textContent = sub; probeEl.append(s); }
  probeEl.hidden = false;
  const r = probeEl.getBoundingClientRect();
  const px = clamp(x - r.width / 2, 8, G.w - r.width - 8);
  const py = y - r.height - 22 < 8 ? y + 26 : y - r.height - 22;
  probeEl.style.transform = `translate(${Math.round(px)}px,${Math.round(py)}px)`;
  probe = { x: hx, y: hy };
}
function ask(x, y, isTouch) {
  clearTimeout(probeHide);
  probeHide = setTimeout(() => { probeEl.hidden = true; probe = null; }, isTouch ? 6000 : 3500);
  const now = Date.now(), nowP = performance.now(), reach = isTouch ? 26 : 16;
  let best = null, bestD = reach * reach;
  const consider = (px, py, bias, make) => {
    const d = (px - x) ** 2 + (py - y) ** 2 - bias;
    if (d < bestD) { bestD = d; best = { px, py, make }; }
  };
  const p = isLive('orbit') && issNow(now);
  if (p) {
    const [px, py] = project(p.lon, p.lat);
    consider(px, py, 200, () => ['International Space Station', `people, ${Math.round(p.alt)} km up, moving at ${Math.round(p.vel).toLocaleString()} km/h — in ${p.vis === 'daylight' ? 'sunlight' : "the Earth's shadow"}`]);
  }
  for (const q of quakes.values()) {
    const [px, py] = project(q.lon, q.lat);
    consider(px, py, 20 + q.mag * 12, () => [`Earthquake · magnitude ${q.mag.toFixed(1)}`, `${q.place} — ${Math.round(q.depth)} km deep, ${ago(q.t)}`]);
  }
  const u = unproject(x, y);
  if (u.r < G.r0 * 0.92) {
    for (const s of seeds) {
      const tip = seedTip(s, nowP);
      consider(tip.x, tip.y, 0, () => [`“${s.title}”`, `a page created on ${s.domain} by ${s.bot ? 'a bot' : 'a person'}, ${ago(s.t)}`]);
    }
  } else if (u.r <= G.R + reach) {
    for (let i = life.length - 1; i >= 0; i--) {
      const o = life[i];
      if (Math.abs(o.lat - u.lat) > 25) continue;
      const [px, py] = project(o.lon, o.lat);
      consider(px, py, 0, () => [o.name || KIND_WORDS[o.kind] || 'something alive', `${KIND_WORDS[o.kind] || 'a living thing'}${o.latin && o.latin !== o.name ? ` (${o.latin})` : ''}, noticed${o.place ? ' in ' + o.place : ''} — shared ${ago(o.t)}`]);
    }
  }
  if (best) { const [t, s] = best.make(); setProbe(x, y, t, s, best.px, best.py); return; }
  if (u.r >= G.r0 && u.r <= G.R) {
    let sub = `it is ${solarHourWords(u.lon, G.sunLon)} there`;
    if (wind && isLive('air')) { const [wu, wv] = windAt(u.lon, u.lat); sub += ` · wind ${Math.hypot(wu, wv).toFixed(0)} m/s`; }
    setProbe(x, y, `${fmtDeg(u.lat, 'N', 'S')} ${fmtDeg(u.lon, 'E', 'W')}`, sub);
  } else if (u.r < G.r0) {
    setProbe(x, y, 'The written', seeds.length ? `${seeds.length} pages born in the last ${SEED_LIFE} seconds` : 'waiting for a page to be born');
  } else { probeEl.hidden = true; probe = null; }
}
canvas.addEventListener('pointerdown', (e) => ask(e.clientX, e.clientY, e.pointerType !== 'mouse'));
canvas.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || e.buttons || e.pressure > 0) ask(e.clientX, e.clientY, e.pointerType !== 'mouse'); });

// ───────────────────────────── wiring the sources ─────────────────────────────
const sources = createSources({
  quakes(list, initial) {
    for (const q of list) {
      const known = quakes.get(q.id);
      if (known) { Object.assign(known, q, { color: depthColor(q.depth) }); continue; }
      q.color = depthColor(q.depth);
      q.shock = 0;
      quakes.set(q.id, q);
      if (!initial && Date.now() - q.t < HOUR) {
        q.shock = performance.now();
        const [x] = project(q.lon, q.lat);
        playQuake(q.mag, (x - G.cx) / G.R);
        offerWhisper(q.mag >= 4 ? 3 : 2, () => `the ground moved — magnitude ${q.mag.toFixed(1)}, ${q.place}`);
      }
    }
  },
  life(list, initial) {
    list.sort((a, b) => a.t - b.t);
    if (initial) { for (const o of list) addLife(o, true); life.sort((a, b) => a.t - b.t); return; }
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
    if (iss.length > 60) iss.shift();
  },
  solarWind(s) { solar = s; },
  aurora(cells) { auroraCells = cells; paintAurora(); },
  wind(w) { wind = w; },
  page: addSeed,
});

// ───────────────────────────── the frame ─────────────────────────────
let last = performance.now(), lastSlow = 0;
const meridian = -new Date().getTimezoneOffset() / 4; // your clock's meridian, not your location

function frame(nowP) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (nowP - last) / 1000);
  last = nowP;
  const now = Date.now(), t = nowP / 1000;

  if (nowP - lastSlow > 1000) {
    lastSlow = nowP;
    const s = subsolar(now);
    G.sunLon = s.lon; G.sunLat = s.lat;
    paintDaylight();
    if (Math.floor(now / 120000) !== paintLife.stamp) { paintLife.stamp = Math.floor(now / 120000); paintLife(); }
    if ($('about').open) updateAbout();
  }
  releaseLife();
  tickWhisper(nowP);

  ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#04050a';
  ctx.fillRect(0, 0, G.w, G.h);

  // the Sun's side of the sky
  const sg = ctx.createRadialGradient(G.cx, G.cy - G.R * 2.1, 0, G.cx, G.cy - G.R * 2.1, G.R * 1.9);
  sg.addColorStop(0, 'rgba(255,214,150,0.16)');
  sg.addColorStop(1, 'rgba(255,214,150,0)');
  ctx.fillStyle = sg;
  ctx.fillRect(0, 0, G.w, G.h);

  drawDust(dt);
  if (dayTex.width > 1) ctx.drawImage(dayTex, G.cx - G.R * 1.04, G.cy - G.R * 1.04, G.R * 2.08, G.R * 2.08);
  ctx.globalCompositeOperation = 'lighter';
  drawWind(dt);
  ctx.globalCompositeOperation = 'source-over';
  drawAurora(t);
  if (isLive('life') || life.length) { ctx.globalCompositeOperation = 'lighter'; drawGeo(lifeLayer, 1); }
  drawBlooms(nowP);
  ctx.globalCompositeOperation = 'source-over';
  drawQuakes(now, nowP);
  drawISS(now);
  drawSeeds(nowP, dt);

  // your meridian
  const ma = angOf(meridian);
  ctx.strokeStyle = 'rgba(233,228,216,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(G.cx + (G.R + 4) * Math.cos(ma), G.cy + (G.R + 4) * Math.sin(ma));
  ctx.lineTo(G.cx + (G.R + 10) * Math.cos(ma), G.cy + (G.R + 10) * Math.sin(ma));
  ctx.stroke();

  if (probe) {
    ctx.strokeStyle = 'rgba(233,228,216,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(probe.x, probe.y, 9, 0, TAU); ctx.stroke();
  }
}

// ───────────────────────────── the panel ─────────────────────────────
function updateAbout() {
  const now = Date.now();
  let big = null, hourCount = 0;
  for (const q of quakes.values()) { if (!big || q.mag > big.mag) big = q; if (now - q.t < HOUR) hourCount++; }
  const p = issNow(now);
  const lines = {
    ground: quakes.size ? `${quakes.size} in the past day, ${hourCount} in the past hour. Strongest: magnitude ${big.mag.toFixed(1)}, ${big.place}.` : '',
    air: wind ? `Read ${ago(wind.at)}; refreshed every two hours.` : '',
    life: life.length ? `${life.length.toLocaleString()} sightings on the ring, the oldest shared ${ago(life[0].t)}.` : '',
    written: seeds.length ? `${seeds.length} pages born in the last ${SEED_LIFE} seconds, ${seeds.filter((s) => s.bot).length} of them by bots.` : '',
    orbit: p ? `Now over ${fmtDeg(p.lat, 'N', 'S')} ${fmtDeg(p.lon, 'E', 'W')}, ${Math.round(p.alt)} km up.` : '',
    sun: solar ? `Solar wind ${Math.round(solar.speed)} km/s${solar.bz == null ? '' : `, magnetic field ${solar.bz < 0 ? 'tilted south (aurora-friendly)' : 'tilted north'}`}.${auroraCells && isLive('aurora') ? ` Aurora peaks at ${auroraPeak}% likelihood.` : ''}` : '',
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
paintDaylight();
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 120); });
// Listen only while someone is looking: kind to batteries, data plans and the sources.
document.addEventListener('visibilitychange', () => (document.hidden ? sources.stop() : sources.start()));
if (!document.hidden) sources.start();
requestAnimationFrame(frame);
