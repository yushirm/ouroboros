// Optional sound, off until asked for. Every note is triggered by a real event;
// there is no background loop pretending something is happening.

let ctx = null, master = null, lastPluck = 0;

export function soundOn() { return !!ctx && ctx.state === 'running'; }

export async function toggleSound() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
    await ctx.resume();
    return true;
  }
  if (ctx.state === 'running') await ctx.suspend(); else await ctx.resume();
  return ctx.state === 'running';
}

function voice(type, freq, gain, attack, decay, pan, glideTo) {
  if (!soundOn()) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + decay);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  let out = g;
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan || 0));
    g.connect(p);
    out = p;
  }
  o.connect(g);
  out.connect(master);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

// A pentatonic scale, so that whatever the world plays, it is never ugly.
const SCALE = [0, 2, 4, 7, 9];
const note = (i) => 220 * 2 ** ((SCALE[i % 5] + 12 * Math.floor(i / 5)) / 12);

// A living thing was noticed: a soft pluck, pitched by its kingdom, placed left/right by where it sits on screen.
export function playLife(kindIndex, pan) {
  const now = performance.now();
  if (now - lastPluck < 140) return;
  lastPluck = now;
  voice('triangle', note(5 + (kindIndex % 10)), 0.07, 0.008, 1.1, pan);
}

// A page was born: a small glassy tick; bots are a fifth lower and drier.
export function playPage(bot, len) {
  const f = note(15 + Math.min(4, Math.floor(Math.log10(len + 10))));
  voice('sine', bot ? f / 1.5 : f, bot ? 0.012 : 0.022, 0.004, bot ? 0.12 : 0.45, 0);
}

// The ground moved: a low drop, louder and deeper with magnitude.
export function playQuake(mag, pan) {
  const m = Math.max(0, Math.min(8, mag));
  voice('sine', 95 - m * 6, 0.06 + m * 0.07, 0.02, 1.2 + m * 0.5, pan, 30);
}
