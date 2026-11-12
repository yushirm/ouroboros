// Every listener here talks straight from the visitor's browser to the public
// source. No keys, no server in between, nothing synthesised. If a source goes
// quiet, its part of the creature goes dark — it is never filled in.

const MIN = 60_000;

export const status = {}; // name -> { lastOk, every, error }

function mark(name, every, error) {
  const s = (status[name] ||= { lastOk: 0, every, error: null });
  s.every = every;
  if (error) s.error = String(error.message || error);
  else { s.lastOk = Date.now(); s.error = null; }
}

export function isLive(name) {
  const s = status[name];
  return !!s && s.lastOk > 0 && Date.now() - s.lastOk < s.every * 3 + 30_000;
}

async function getJSON(url, timeout = 25_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// A polite poller: fixed cadence, exponential backoff on failure, pausable.
function poller(name, every, fn) {
  let gen = 0, timer = 0, fails = 0, lastRun = 0;
  async function tick(my) {
    if (my !== gen) return;
    lastRun = Date.now();
    try {
      const r = await fn();
      fails = 0;
      mark(name, every);
      if (r && r.at) status[name].lastOk = r.at; // served from cache: keep its true age
    } catch (e) { fails++; mark(name, every, e); }
    if (my !== gen) return;
    // Back off on failure, but never retry a slow source faster than its own cadence.
    const wait = fails ? Math.min(Math.max(every, MIN) * 2 ** fails, Math.max(every, 15 * MIN)) : every;
    timer = setTimeout(tick, wait, my);
  }
  return {
    // Resuming (e.g. the tab becomes visible again) never polls sooner than the cadence allows.
    start() {
      clearTimeout(timer);
      const my = ++gen;
      timer = setTimeout(tick, Math.max(0, lastRun + every - Date.now()), my);
    },
    stop() { gen++; clearTimeout(timer); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createSources(on) {
  const all = [];

  // ── The ground: USGS earthquake feeds (public domain; updated every minute).
  let quakeRuns = 0;
  all.push(poller('ground', MIN, async () => {
    const feed = quakeRuns % 15 === 0 ? 'all_day' : 'all_hour';
    const j = await getJSON(`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${feed}.geojson`);
    const list = [];
    for (const f of j.features || []) {
      const p = f.properties, c = f.geometry && f.geometry.coordinates;
      if (!p || !c || p.type !== 'earthquake' || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
      list.push({ id: f.id, lon: c[0], lat: c[1], depth: c[2] || 0, mag: Number.isFinite(p.mag) ? p.mag : 0, place: p.place || 'somewhere', t: p.time });
    }
    on.quakes(list, quakeRuns === 0);
    quakeRuns++;
  }));

  // ── The living: iNaturalist observations as they are uploaded.
  const INAT = 'https://api.inaturalist.org/v2/observations?geo=true&per_page=200&order_by=id' +
    '&fields=(id:!t,location:!t,created_at:!t,place_guess:!t,species_guess:!t,taxon:(name:!t,iconic_taxon_name:!t,preferred_common_name:!t))';
  const parseObs = (r) => {
    if (!r || !r.location) return null;
    const [lat, lon] = r.location.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const tx = r.taxon || {};
    return {
      id: r.id, lat, lon, t: Date.parse(r.created_at) || Date.now(),
      kind: tx.iconic_taxon_name || 'unknown',
      name: tx.preferred_common_name || tx.name || r.species_guess || '',
      latin: tx.name || '', place: r.place_guess || '',
    };
  };
  let lastObs = 0, seeded = false;
  all.push(poller('life', 40_000, async () => {
    if (!seeded) {
      // First breath: the most recent uploads, then a few pages further back so
      // the continents have something to stand on. ~10 minutes of the world.
      let below = 0;
      for (let page = 0; page < 5; page++) {
        const j = await getJSON(INAT + '&order=desc' + (below ? '&id_below=' + below : ''));
        const obs = (j.results || []).map(parseObs).filter(Boolean);
        if (!obs.length) break;
        lastObs = Math.max(lastObs, ...obs.map((o) => o.id));
        below = Math.min(...(j.results || []).map((r) => r.id));
        on.life(obs, true);
        seeded = true;
        await sleep(1200);
      }
      return;
    }
    const j = await getJSON(INAT + '&order=asc&id_above=' + lastObs);
    const obs = (j.results || []).map(parseObs).filter(Boolean);
    for (const r of j.results || []) if (r.id > lastObs) lastObs = r.id;
    if (obs.length) on.life(obs, false);
  }));

  // ── People in orbit: the International Space Station.
  all.push(poller('orbit', 10_000, async () => {
    const j = await getJSON('https://api.wheretheiss.at/v1/satellites/25544', 9000);
    if (!Number.isFinite(j.latitude)) throw new Error('bad ISS payload');
    on.iss({ lat: j.latitude, lon: j.longitude, alt: j.altitude, vel: j.velocity, vis: j.visibility, t: j.timestamp * 1000 });
  }));

  // ── The Sun's weather: NOAA Space Weather Prediction Center (public domain).
  all.push(poller('sun', MIN, async () => {
    const [sp, mf] = await Promise.all([
      getJSON('https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json'),
      getJSON('https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json').catch(() => null),
    ]);
    const speed = Number(sp && sp[0] && sp[0].proton_speed);
    if (!Number.isFinite(speed) || speed <= 0) throw new Error('no solar wind reading');
    const bz = mf && mf[0] ? Number(mf[0].bz_gsm) : NaN;
    on.solarWind({ speed, bz: Number.isFinite(bz) ? bz : null });
  }));
  all.push(poller('aurora', 10 * MIN, async () => {
    const j = await getJSON('https://services.swpc.noaa.gov/json/ovation_aurora_latest.json', 60_000);
    if (!Array.isArray(j.coordinates)) throw new Error('bad aurora payload');
    on.aurora(j.coordinates, j['Forecast Time']);
  }));

  // ── The air: 10 m winds from Open-Meteo on a coarse global grid (CC BY 4.0).
  // 144 points every two hours stays well inside the free non-commercial quota,
  // and a fresh copy is kept in localStorage so reloads cost nothing.
  const LATS = [], LONS = [];
  for (let la = -80; la <= 80; la += 20) LATS.push(la);
  for (let lo = -180; lo < 180; lo += 22.5) LONS.push(lo);
  const WIND_EVERY = 120 * MIN, WIND_KEY = 'ouroboros.wind.v1';
  const cachedWind = (maxAge) => {
    try {
      const c = JSON.parse(localStorage.getItem(WIND_KEY) || 'null');
      if (c && Date.now() - c.at < maxAge && c.u.length === LATS.length * LONS.length && c.v.length === c.u.length) return c;
    } catch { /* storage unavailable */ }
    return null;
  };
  all.push(poller('air', WIND_EVERY, async () => {
    const c = cachedWind(WIND_EVERY);
    if (c) { on.wind({ lats: LATS, lons: LONS, u: c.u, v: c.v, at: c.at }); return { at: c.at }; }
    try { return await fetchWind(); }
    catch (e) {
      // The source refused (it meters by network). An older real reading, honestly
      // dated in the panel, is better than still air — up to six hours old.
      const old = cachedWind(3 * WIND_EVERY);
      if (!old) throw e;
      on.wind({ lats: LATS, lons: LONS, u: old.u, v: old.v, at: old.at });
      return { at: old.at };
    }
  }));
  async function fetchWind() {
    const la = [], lo = [];
    for (const a of LATS) for (const b of LONS) { la.push(a); lo.push(b); }
    const j = await getJSON('https://api.open-meteo.com/v1/forecast?latitude=' + la.join(',') + '&longitude=' + lo.join(',') +
      '&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms', 40_000);
    const arr = Array.isArray(j) ? j : [j];
    if (arr.length !== la.length) throw new Error('unexpected wind grid');
    const u = [], v = [];
    for (const p of arr) {
      const s = Number(p.current && p.current.wind_speed_10m), d = Number(p.current && p.current.wind_direction_10m);
      if (!Number.isFinite(s) || !Number.isFinite(d)) throw new Error('bad wind sample');
      // Meteorological direction is where the wind comes FROM.
      const r = (d * Math.PI) / 180;
      u.push(+(-s * Math.sin(r)).toFixed(2));
      v.push(+(-s * Math.cos(r)).toFixed(2));
    }
    const at = Date.now();
    try { localStorage.setItem(WIND_KEY, JSON.stringify({ at, u, v })); } catch { /* fine */ }
    on.wind({ lats: LATS, lons: LONS, u, v, at });
  }

  // ── The written: every page newly created on any Wikimedia project, as a
  // server-sent event stream. (The full edit stream is ~50 kB/s — too greedy
  // for a phone — so we listen only for births: ~1–2 a second.)
  let es = null, esWatch = 0, lastMsg = 0;
  const WIKI = 'https://stream.wikimedia.org/v2/stream/mediawiki.page-create';
  function openWiki() {
    closeWiki();
    lastMsg = Date.now();
    es = new EventSource(WIKI);
    es.onmessage = (ev) => {
      lastMsg = Date.now();
      let j;
      try { j = JSON.parse(ev.data); } catch { return; }
      if (!j || !j.database || typeof j.page_title !== 'string') return;
      mark('written', 20_000);
      on.page({
        wiki: j.database, domain: (j.meta && j.meta.domain) || j.database,
        title: j.page_title.replace(/_/g, ' '), ns: j.page_namespace | 0,
        len: Number(j.rev_len) || 0, bot: !!(j.performer && j.performer.user_is_bot),
        t: Date.now(),
      });
    };
    es.onerror = () => mark('written', 20_000, 'stream interrupted');
    // EventSource reconnects on its own; this catches the silent-hang case.
    esWatch = setInterval(() => { if (Date.now() - lastMsg > 90_000) openWiki(); }, 30_000);
  }
  function closeWiki() {
    clearInterval(esWatch);
    if (es) { es.close(); es = null; }
  }

  return {
    start() { all.forEach((p) => p.start()); openWiki(); },
    stop() { all.forEach((p) => p.stop()); closeWiki(); },
  };
}
