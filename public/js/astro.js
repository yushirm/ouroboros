// Where is the Sun right now? Low-precision solar ephemeris (good to ~0.01°),
// from the Astronomical Almanac's approximate formulas. Pure arithmetic on the clock.
const D = Math.PI / 180;

export function subsolar(ms) {
  const d = ms / 86400000 + 2440587.5 - 2451545.0; // days since J2000
  const g = (357.529 + 0.98560028 * d) * D;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D;
  const e = (23.439 - 0.00000036 * d) * D;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / D;
  const lat = Math.asin(Math.sin(e) * Math.sin(L)) / D;
  const gmst = (280.46061837 + 360.98564736629 * d) % 360;
  const lon = (((ra - gmst) % 360) + 540) % 360 - 180;
  return { lon, lat };
}

// Words for the local solar time at a longitude, given the subsolar longitude.
export function solarHourWords(lon, sunLon) {
  const h = ((((lon - sunLon) / 15 + 12) % 24) + 24) % 24;
  if (h < 4) return 'the dead of night';
  if (h < 6) return 'just before dawn';
  if (h < 8) return 'early morning';
  if (h < 11) return 'morning';
  if (h < 13) return 'midday';
  if (h < 17) return 'afternoon';
  if (h < 19) return 'dusk';
  if (h < 22) return 'evening';
  return 'night';
}
