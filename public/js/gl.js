// Small WebGL helpers and the three shaders that draw the creature.
//
// Everything on the body is stored in geographic coordinates (longitude,
// latitude, height above the skin) and bent onto the ring inside the vertex
// shader, so the planet can turn and the skin can ripple without touching
// the data.

export const RA = 1.0;      // ring radius
export const RB = 0.42;     // body (tube) radius
export const K = 2;         // latitude -> angle around the body; the two poles meet in the throat
export const NRIP = 12;

const PLACE = `
uniform mat4 uVP;
uniform float uSun;   // subsolar longitude (radians): that meridian faces +X, towards the Sun
uniform float uTime;
uniform vec4 uRip[${NRIP}];     // xyz: where the ground moved (Earth frame), w: when
uniform float uRipAmp[${NRIP}];
vec3 gN, gE, gU;      // local up, east, north
float gRip;
vec3 rotY(vec3 p, float s) { float c = cos(s), n = sin(s); return vec3(p.x * c - p.z * n, p.y, p.z * c + p.x * n); }
vec3 place(float lon, float lat, float h) {
  float ph = lat * ${K.toFixed(5)}, ct = cos(lon), st = sin(lon), cp = cos(ph), sp = sin(ph);
  vec3 n = vec3(cp * ct, sp, -cp * st);
  vec3 p = vec3((${RA.toFixed(2)} + ${RB.toFixed(2)} * cp) * ct, ${RB.toFixed(2)} * sp, -(${RA.toFixed(2)} + ${RB.toFixed(2)} * cp) * st);
  float d = 0.0;
  for (int i = 0; i < ${NRIP}; i++) {
    float a = uRipAmp[i];
    if (a > 0.0) {
      float age = uTime - uRip[i].w;
      float f = distance(p, uRip[i].xyz) - age * 0.3;
      d += a * exp(-f * f * 40.0) * exp(-age * 0.4) * cos(f * 17.0);
    }
  }
  gRip = d;
  p += n * (h + d);
  gN = rotY(n, uSun);
  gE = rotY(vec3(-st, 0.0, -ct), uSun);
  gU = rotY(vec3(-sp * ct, cp, sp * st), uSun);
  return rotY(p, uSun);
}`;

const BODY_VS = `precision highp float;
attribute vec2 aLL;
uniform float uDecl;
varying float vCz, vRip;
varying vec3 vN, vP;
varying vec2 vLL;
${PLACE}
void main() {
  vec3 p = place(aLL.x, aLL.y, 0.0);
  // cosine of the Sun's zenith angle here: real day and night, season included
  vCz = sin(aLL.y) * sin(uDecl) + cos(aLL.y) * cos(uDecl) * cos(aLL.x - uSun);
  vN = gN; vP = p; vRip = gRip; vLL = aLL;
  gl_Position = uVP * vec4(p, 1.0);
}`;

const BODY_FS = `precision mediump float;
uniform vec3 uEye;
varying float vCz, vRip;
varying vec3 vN, vP;
varying vec2 vLL;
void main() {
  float day = smoothstep(-0.1, 0.45, vCz);
  float dusk = exp(-(vCz * vCz) / 0.0081);
  vec3 col = mix(vec3(0.028, 0.036, 0.085), vec3(0.045, 0.165, 0.250), day) + dusk * vec3(0.20, 0.055, 0.10);
  // scales
  vec2 g = vec2(vLL.x / 6.28318 * 120.0, vLL.y * ${K.toFixed(5)} / 6.28318 * 36.0);
  g.x += 0.5 * floor(mod(g.y, 2.0));
  vec2 f = abs(fract(g) - 0.5);
  col *= 1.0 - 0.16 * smoothstep(0.36, 0.5, max(f.x, f.y));
  // a thin atmosphere at the limb, and light where the skin is moving
  float rim = pow(1.0 - max(dot(normalize(vN), normalize(uEye - vP)), 0.0), 3.0);
  col += rim * mix(vec3(0.05, 0.07, 0.16), vec3(0.16, 0.42, 0.50), day);
  col *= clamp(1.0 + vRip * 18.0, 0.6, 1.5);   // crests catch the light, troughs fall into shadow
  col += max(vRip, 0.0) * 14.0 * vec3(1.0, 0.55, 0.3);
  gl_FragColor = vec4(col, 1.0);
}`;

// Glowing points and hairlines. Positions are either geographic (uGeo = 1) or already in world space.
const PTS_VS = `precision highp float;
attribute vec3 aP;
attribute vec4 aC;
attribute vec2 aS;    // size in world units, shape
uniform float uGeo, uPx, uShim, uMaxPt;
varying vec4 vC;
varying float vShape;
${PLACE}
void main() {
  vec3 w = uGeo > 0.5 ? place(aP.x, aP.y, aP.z) : aP;
  gl_Position = uVP * vec4(w, 1.0);
  float px = aS.x * uPx / gl_Position.w;
  gl_PointSize = clamp(px, 1.0, uMaxPt);
  vC = aC;
  vC.a *= min(1.0, px * px);   // sub-pixel points dim rather than flicker
  if (uShim > 0.0) vC.a *= 0.6 + 0.4 * sin(uTime * uShim + aP.x * 5.0 + sin(aP.x * 13.0 + uTime * 0.3) * 2.0);
  vShape = aS.y;
}`;

const PTS_FS = `precision mediump float;
uniform float uLine;
varying vec4 vC;
varying float vShape;
void main() {
  float a = 1.0;
  if (uLine < 0.5) {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float r = length(q);
    if (vShape < 0.5) { a = max(0.0, 1.0 - r); a *= a; }                       // soft glow
    else if (vShape < 1.5) { a = smoothstep(0.16, 0.0, abs(r - 0.82)); }       // ring
    else { a = smoothstep(1.0, 0.8, abs(q.x) + abs(q.y)); }                    // diamond
  }
  gl_FragColor = vec4(vC.rgb * vC.a * a, 1.0);
}`;

// Fur: one hair per living thing noticed. It grows when the sighting arrives and
// leans and sways with the real wind at that spot (no wind data, no movement).
const FUR_VS = `precision highp float;
attribute vec2 aLL;
attribute float aT;     // 0 at the skin, 1 at the tip
attribute vec2 aLB;     // length, time it appeared
attribute vec3 aCol;
attribute vec2 aW;      // wind east, north (m/s)
attribute float aPh;
uniform mediump float uTip;   // shared with the fragment shader, so the precisions must match
uniform float uPx, uMaxPt;
varying vec4 vC;
${PLACE}
void main() {
  float age = uTime - aLB.y;
  float grow = clamp(age / 3.0, 0.0, 1.0);
  grow = 1.0 - pow(1.0 - grow, 3.0);
  float L = aLB.x * grow;
  vec3 base = place(aLL.x, aLL.y, 0.0);
  float wsp = length(aW);
  float sway = sin(uTime * (1.2 + wsp * 0.14) + aPh + aT * 1.6) * wsp * 0.028;
  vec2 lean = aW * 0.075 + sway * vec2(cos(aPh), sin(aPh)) + sway * normalize(aW + 0.0001) * 0.8;
  vec3 lateral = gE * lean.x + gU * lean.y;
  float ll = min(length(lateral), 1.4);
  vec3 p = base + gN * L * aT * (1.0 - 0.3 * ll * aT) + lateral * L * aT * aT;
  gl_Position = uVP * vec4(p, 1.0);
  float fade = mix(1.0, 0.3, clamp((age - 1800.0) / 10800.0, 0.0, 1.0)) * step(age, 21600.0) * step(0.0001, aLB.x);
  float fresh = max(0.0, 1.0 - age / 4.0);
  vC = vec4(aCol + fresh * 0.5, (0.10 + 0.42 * aT) * fade);
  if (uTip > 0.5) {
    float px = (0.011 + fresh * 0.03) * uPx / gl_Position.w;
    gl_PointSize = clamp(px, 1.0, uMaxPt);
    vC.a = fade * (0.6 + fresh) * min(1.0, px * px);
  }
}`;

const FUR_FS = `precision mediump float;
uniform float uTip;
varying vec4 vC;
void main() {
  float a = 1.0;
  if (uTip > 0.5) { float r = length(gl_PointCoord * 2.0 - 1.0); a = max(0.0, 1.0 - r); a *= a; }
  gl_FragColor = vec4(vC.rgb * vC.a * a, 1.0);
}`;

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader failed');
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link failed');
  const u = {}, a = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace('[0]', '');
    u[name] = gl.getUniformLocation(p, name);
  }
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i < n; i++) {
    const name = gl.getActiveAttrib(p, i).name;
    a[name] = gl.getAttribLocation(p, name);
  }
  return { p, u, a };
}

export function createPrograms(gl) {
  return { body: compile(gl, BODY_VS, BODY_FS), pts: compile(gl, PTS_VS, PTS_FS), fur: compile(gl, FUR_VS, FUR_FS) };
}

// Bind an interleaved float buffer to a program's attributes: layout = [['aP', 3], ['aC', 4], ...]
export function bindLayout(gl, prog, buf, layout) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  let stride = 0, off = 0;
  for (const [, n] of layout) stride += n * 4;
  for (const [name, n] of layout) {
    const loc = prog.a[name];
    if (loc !== undefined && loc >= 0) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, off); }
    off += n * 4;
  }
}

// A growable CPU-side batch of [x,y,z, r,g,b,a, size,shape] vertices, re-uploaded each frame.
export const PTS_LAYOUT = [['aP', 3], ['aC', 4], ['aS', 2]];
export class Batch {
  constructor(gl, cap = 1024) { this.gl = gl; this.a = new Float32Array(cap * 9); this.n = 0; this.buf = gl.createBuffer(); this.cap = 0; }
  reset() { this.n = 0; }
  push(x, y, z, r, g, b, al, size = 0, shape = 0) {
    if ((this.n + 1) * 9 > this.a.length) { const b2 = new Float32Array(this.a.length * 2); b2.set(this.a); this.a = b2; }
    const a = this.a, i = this.n++ * 9;
    a[i] = x; a[i + 1] = y; a[i + 2] = z; a[i + 3] = r; a[i + 4] = g; a[i + 5] = b; a[i + 6] = al; a[i + 7] = size; a[i + 8] = shape;
  }
  upload() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    if (this.a.length !== this.cap) { gl.bufferData(gl.ARRAY_BUFFER, this.a, gl.DYNAMIC_DRAW); this.cap = this.a.length; }
    else gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.a.subarray(0, this.n * 9));
  }
}

// ── tiny matrix kit (column-major) ──
export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = (2 * far * near) / (near - far);
  return m;
}
export function lookAt(e, c) {
  let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
  let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
  let xx = zz, xy = 0, xz = -zx; // up(0,1,0) × z
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx; m[1] = yx; m[2] = zx; m[4] = xy; m[5] = yy; m[6] = zy; m[8] = xz; m[9] = yz; m[10] = zz;
  m[12] = -(xx * e[0] + xy * e[1] + xz * e[2]); m[13] = -(yx * e[0] + yy * e[1] + yz * e[2]); m[14] = -(zx * e[0] + zy * e[1] + zz * e[2]); m[15] = 1;
  return m;
}
export function mul(a, b) {
  const m = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    m[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return m;
}
