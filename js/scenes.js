// Procedural wireframe scenes of Paris for the backdrop, drawn to scale and lit like a night photograph
// on 1950s film. Each scene is plain code: no models to download. A scene builds into a Kit and returns
// { kit, center, frame(camera, width) -> look-at point, shot }.
//   `center` is how strongly the scene shows through behind the text column (0 hides it, 1 doesn't dim).
//   `shot` is the slow camera move backdrop.js plays: { track, push, pan, settle }.
//
// Perf gate (manual): Chrome Performance panel on a UHD 620 / Iris Xe class laptop at 1440x900, DPR 1.5,
// with a page move running: GPU <= 20 ms/frame, scripting <= 2 ms/frame, no GC over 60 s. If over budget,
// reduce in this order: mist sheet count, pane pLit, smoke stacks (24 -> 12), hair detail beyond D 40
// (emit as 'mid'), Champ de Mars trees (104 -> 52). dev/scene-lab.html?scene=N&debug shows the counts.
//
// To add your own scene: write a function here and add it to SCENES at the bottom.
import * as THREE from 'three';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const deg = THREE.MathUtils.degToRad;
const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;

// Seeded PRNG so a scene looks the same every time it's built.
const prng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const hash01 = (v) => { const s = Math.sin(v * 12.9898) * 43758.5453; return s - Math.floor(s); };

// Read once: reduced motion builds no sparkle, smoke or boat; ?debug prints a table per kit.
const STILL = matchMedia('(prefers-reduced-motion: reduce)').matches;
const DEBUG = new URLSearchParams(location.search).has('debug');

/** A placement matrix: yaw (degrees) about y, then translate to (x, 0, z). For Kit.push(). */
const placed = (x, z, yawDeg) => new THREE.Matrix4().makeRotationY(deg(yawDeg)).setPosition(x, 0, z);
/** n+1 points of a 2D arc: [cx + r cos a, cy + r sin a] for a from a0 to a1. */
const arc = (cx, cy, r, a0, a1, n) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
/** A rectangular lot as a polygon in (x, z), positive area. */
const lot = (x0, x1, z0, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

/** Growable Float32Array. Everything the Kit collects goes through one of these: no spreads, no stack limits. */
class Buf {
  constructor(n = 4096) { this.a = new Float32Array(n); this.n = 0; }
  grow(k) {
    if (this.n + k > this.a.length) {
      const b = new Float32Array(Math.max(this.a.length * 2, this.n + k));
      b.set(this.a);
      this.a = b;
    }
  }
  push(...v) { this.grow(v.length); this.a.set(v, this.n); this.n += v.length; }
  push3(x, y, z) { this.grow(3); const a = this.a, n = this.n; a[n] = x; a[n + 1] = y; a[n + 2] = z; this.n = n + 3; }
  push2(x, y) { this.grow(2); const a = this.a, n = this.n; a[n] = x; a[n + 1] = y; this.n = n + 2; }
  set(arr) { this.grow(arr.length); this.a.set(arr, this.n); this.n += arr.length; }
  rep(v, k) { this.grow(k); this.a.fill(v, this.n, this.n + k); this.n += k; }
  view() { return this.a.subarray(0, this.n); }
}

// ---- GLSL -------------------------------------------------------------------------------------
// Two-octave value noise shared by the water, mist and smoke.
const NOISE = `
  float hash2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(hash2(i), hash2(i+vec2(1.0,0.0)), f.x), mix(hash2(i+vec2(0.0,1.0)), hash2(i+vec2(1.0,1.0)), f.x), f.y); }
  float n2(vec2 p){ return 0.65*vnoise(p) + 0.35*vnoise(p*2.3 + 7.1); }`;

// Height mist and a luminous horizon, injected into three's fog for the batched fill and line materials:
// low geometry softens into mist, and whatever the distance dissolves lands on a faintly lit band.
const FOG_FRAG = `#ifdef USE_FOG
  float dist = smoothstep(fogNear, fogFar, vFogDepth);
  float mist = uMist.x * exp(-max(vWorldY - uMist.z, 0.0) / uMist.y) * smoothstep(0.0, uMist.w, vFogDepth);
  float f = 1.0 - (1.0 - dist) * (1.0 - clamp(mist, 0.0, 0.85));
  vec3 haze = mix(fogColor + uGlow, fogColor, smoothstep(uHorizon.x, uHorizon.y, vWorldY));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, haze, f);
#endif`;

// Lamps: one instanced batch of camera-facing quads, each a hard core, a wide skirt and a faint streak.
const LAMP_VERT = `
  uniform float uTime; uniform vec2 uFog;
  attribute vec3 aPos; attribute float aSize, aIntensity, aSeed; attribute vec2 aShape;
  varying vec2 vUv; varying float vA, vFog;
  void main(){
    vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
    vFog = smoothstep(uFog.x, uFog.y, -mv.z);
    float flick = 0.86 + 0.10*sin(uTime*1.3 + aSeed*6.28) + 0.04*sin(uTime*7.1 + aSeed*19.0);
    vA = aIntensity * flick;
    float grow = 1.0 + 0.6*vFog;
    mv.xy += position.xy * aSize * 2.4 * grow * aShape;
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }`;
const LAMP_FRAG = `
  uniform vec3 uColor; varying vec2 vUv; varying float vA, vFog;
  void main(){
    vec2 p = (vUv - 0.5) * 2.0; float r = length(p);
    float core = exp(-r*r*34.0);
    float skirt = 0.42*exp(-r*4.2);
    float flare = 0.08*exp(-abs(p.x)*10.0)*exp(-p.y*p.y*2.0);
    float a = vA * (core*(1.0 - 0.7*vFog) + (skirt + flare)*(1.0 - 0.45*vFog));
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`;

// Lit windows: soft rectangles laid in the facade plane; a few are dark at any moment.
const PANE_VERT = `
  uniform vec2 uFog; attribute float aBright, aSeed;
  varying vec2 vUv; varying float vFog, vBright, vSeed;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFog = smoothstep(uFog.x, uFog.y, -mv.z);
    vUv = uv; vBright = aBright; vSeed = aSeed;
    gl_Position = projectionMatrix * mv;
  }`;
const PANE_FRAG = `
  uniform float uTime; uniform vec3 uColor; varying vec2 vUv; varying float vFog, vBright, vSeed;
  void main(){
    vec2 e = smoothstep(0.0, 0.38, vUv) * smoothstep(0.0, 0.38, 1.0 - vUv);
    float soft = e.x*e.y;
    float slow = 0.82 + 0.18*sin(uTime*0.6 + vSeed*40.0);
    float on = step(0.08, fract(vSeed*7.0 + uTime/37.0));
    float a = vBright * soft * slow * on * 0.42 * (1.0 - vFog);
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`;

// The Eiffel beacon: two short shafts that pick out the haze, nearly invisible end-on. The cone mesh is
// rotated (never its geometry), so position.y runs along the shaft: 0 at the apex, -uLen at the open base.
const BEACON_VERT = `
  uniform float uLen; varying float vU; varying vec3 vAxis, vView, vNrm;
  void main(){
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vU = clamp(-position.y / uLen, 0.0, 1.0);
    vAxis = normalize((modelMatrix * vec4(0.0, -1.0, 0.0, 0.0)).xyz);
    vNrm = (modelMatrix * vec4(normal, 0.0)).xyz;
    vView = cameraPosition - wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const BEACON_FRAG = `
  uniform float uTime; uniform vec3 uColor; varying float vU; varying vec3 vAxis, vView, vNrm;
  void main(){
    vec3 view = normalize(vView);
    float side = pow(1.0 - abs(dot(view, vAxis)), 1.3);
    // A hollow cone drawn as a volume: full where its wall faces the eye, nothing at the silhouette.
    float body = abs(dot(normalize(vNrm), view));
    float a = 0.1 * pow(1.0 - vU, 2.2) * (0.72 + 0.28*sin(vU*9.0 - uTime*1.6)) * side * body;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`;

// The Seine: a dark sheet whose only light is each lamp's column, standing exactly under its mirror point.
const WATER_VERT = `
  uniform vec2 uFog; varying vec3 vW; varying float vFog;
  void main(){
    vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz;
    vec4 mv = viewMatrix * wp; vFog = smoothstep(uFog.x, uFog.y, -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const WATER_FRAG = `${NOISE}
  uniform float uTime, uWaterY, uRough, uStretch; uniform vec3 uColor, uGlow; uniform vec4 uLamps[24]; uniform int uLampCount;
  varying vec3 vW; varying float vFog;
  void main(){
    vec3 C = cameraPosition;
    float gr = pow(1.0 - clamp(dot(normalize(C - vW), vec3(0.0, 1.0, 0.0)), 0.0, 1.0), 4.0);
    vec3 col = uGlow * 2.5 * gr;
    float swell = sin(vW.z*2.3 + uTime*0.9 + 2.0*sin(vW.x*0.7 + uTime*0.4));
    // Ripples break the columns into slivers; the water right under the camera stays dark.
    float rip = 0.3 + 0.7*n2(vW.xz*vec2(2.2, 1.1) + vec2(0.0, uTime*0.25));
    float nearFade = smoothstep(2.0, 14.0, length(vW.xz - C.xz));
    // Two slow noise fields shared by every column (sampled once, outside the loop): a lateral drift so
    // the columns wander instead of ruling straight lines, and broken glitter instead of a regular striation.
    float wob = n2(vW.xz*vec2(1.3, 0.6) + vec2(uTime*0.12, uTime*0.05)) - 0.5;
    float flick = n2(vec2(vW.x*2.5, vW.z*3.0 - uTime*0.5));
    vec3 lit = vec3(0.0);
    for (int i = 0; i < 24; i++) { if (i >= uLampCount) break;
      vec4 L = uLamps[i];
      vec3 Lm = vec3(L.x, 2.0*uWaterY - L.y, L.z);
      float t = clamp((uWaterY - C.y) / (Lm.y - C.y), 0.0, 1.0);
      vec2 P = C.xz + t * (Lm.xz - C.xz);
      float along = vW.z - P.y; float h = L.y - uWaterY;
      // uStretch lengthens the glitter path for a sheet seen at a grazing angle (the Trocadero's river).
      float wv = 0.75 + 0.5*fract(float(i)*0.618); // no two columns the same width
      float w = (0.05 + 0.025*h + 0.006*abs(along)) * wv * (1.0 + 1.5*uRough) * sqrt(uStretch);
      float across = vW.x - P.x + 0.025*swell*(1.0 + 0.15*abs(along)) + wob*(0.08 + 0.05*abs(along));
      float len = (along > 0.0 ? (0.9 + 0.5*h)*(1.0 - 0.6*uRough) : max(P.y - L.z, 0.5)*0.3) * uStretch;
      float a2 = across*across;
      // A bright core with a faint wide skirt, so the edges are soft rather than ruled.
      float streak = (exp(-a2/(w*w)) + 0.3*exp(-a2/(6.0*w*w))) * exp(-abs(along)/len);
      streak *= 0.55 + 0.45*flick;
      if (uRough > 0.0) streak *= smoothstep(0.42, 0.6, n2(vW.xz*1.7));
      lit += uColor * L.w * 0.2 * streak; }
    col += lit * rip * nearFade;
    col = col / (1.0 + col);
    gl_FragColor = vec4(col * (1.0 - vFog), 1.0);
    #include <colorspace_fragment>
  }`;

// Mist: a few horizontal sheets of slow noise lying on the water.
const MIST_VERT = `
  uniform vec2 uFog; attribute float aY, aSeed, aSpeed;
  varying vec3 vW; varying vec2 vUv; varying float vFog, vSeed, vSpeed;
  void main(){
    vec4 wp = modelMatrix * vec4(position + vec3(0.0, aY, 0.0), 1.0); vW = wp.xyz;
    vec4 mv = viewMatrix * wp; vFog = smoothstep(uFog.x, uFog.y, -mv.z);
    vUv = uv; vSeed = aSeed; vSpeed = aSpeed;
    gl_Position = projectionMatrix * mv;
  }`;
const MIST_FRAG = `${NOISE}
  uniform float uTime; uniform vec3 uColor; varying vec3 vW; varying vec2 vUv; varying float vFog, vSeed, vSpeed;
  void main(){
    vec2 e = smoothstep(0.0, 0.12, vUv) * smoothstep(0.0, 0.12, 1.0 - vUv);
    float n = n2(vW.xz*0.11 + vec2(uTime*vSpeed, vSeed));
    float a = 0.035*(0.3 + 0.7*n)*e.x*e.y*(1.0 - 0.6*vFog);
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`;

// Chimney smoke: puffs that rise, lean with the wind and thin out.
const SMOKE_VERT = `
  uniform float uTime; uniform vec2 uFog, uWind; attribute vec3 aStack; attribute float aSeed, aRate;
  varying vec2 vUv; varying float vA, vFog, vSeed;
  void main(){
    float age = fract(aSeed + uTime*0.06*aRate);
    vec3 c = aStack + vec3(uWind.x*age*age*3.5 + 0.15*age*sin(uTime*0.4 + aSeed*20.0), age*2.6, uWind.y*age*age*3.5);
    vec4 mv = modelViewMatrix * vec4(c, 1.0);
    vFog = smoothstep(uFog.x, uFog.y, -mv.z);
    // Puffs are sized for the middle distance; nearer the camera they shrink so smoke stays thin.
    float size = (0.22 + 1.3*age) * mix(0.3, 1.0, smoothstep(8.0, 40.0, -mv.z));
    vA = 0.09*(1.0 - age)*smoothstep(0.0, 0.12, age);
    mv.xy += position.xy*size;
    vUv = uv; vSeed = aSeed;
    gl_Position = projectionMatrix * mv;
  }`;
const SMOKE_FRAG = `${NOISE}
  uniform float uTime; uniform vec3 uColor; varying vec2 vUv; varying float vA, vFog, vSeed;
  void main(){
    float r = length((vUv - 0.5)*2.0);
    float n = n2(vUv*3.0 + vSeed*10.0 + vec2(0.0, uTime*0.05));
    float a = vA*exp(-r*r*5.0)*(0.55 + 0.45*n)*(1.0 - 0.7*vFog);
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`;

// The Eiffel sparkle: 320 points on the lattice, ~15 lit at a time, re-rolled 14 times a second.
const SPARKLE_VERT = `
  attribute vec3 aPos; attribute float aSeed; varying vec2 vUv; varying float vSeed;
  void main(){
    vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
    mv.xy += position.xy * 0.09;
    vUv = uv; vSeed = aSeed;
    gl_Position = projectionMatrix * mv;
  }`;
const SPARKLE_FRAG = `
  uniform float uTime, uSparkle; uniform vec3 uColor; varying vec2 vUv; varying float vSeed;
  void main(){
    float r = length((vUv - 0.5)*2.0);
    float h = fract(sin(dot(vec2(vSeed, floor(uTime*14.0)), vec2(12.9898, 78.233))) * 43758.5453);
    float a = uSparkle * step(0.955, h) * exp(-r*r*8.0);
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`;

const additive = (uniforms, vertexShader, fragmentShader, extra = {}) =>
  new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, ...extra });

const _p = new THREE.Vector3(); // scratch for transforms
const _q = new THREE.Vector3();

/** Collects geometry, then builds it into a few batched meshes tinted with the accent colour. */
export class Kit {
  constructor(bg, parent = null) {
    this.bg = bg;
    this.parent = parent; // a part (see part()) shares its parent's uniforms and renders under one Group
    this.scene = parent ? parent.scene : new THREE.Scene();
    if (!parent) this.scene.fog = new THREE.Fog(bg, 12, 46);
    this.root = parent ? new THREE.Group() : this.scene;
    this.solids = []; // { g, threshold, dark, tone, lit, edges }
    this.cls = {
      bold: { pos: new Buf(), tone: new Buf(), lit: new Buf(), opacity: 0.75, fog: true, bake: [0.55, 0.45] },
      fine: { pos: new Buf(), tone: new Buf(), lit: new Buf(), opacity: 0.28, fog: true, bake: [0.45, 0.55] },
      hair: { pos: new Buf(), tone: new Buf(), lit: new Buf(), opacity: 0.18, fog: true, bake: [0.5, 0.5] },
      far: { pos: new Buf(), tone: new Buf(), lit: new Buf(), opacity: 0.22, fog: false, bake: null },
    };
    this.lamps = [];
    this.lights = []; // bake-only sources [x, y, z, reach, intensity]
    this.panes = [];
    this.stacks = []; // chimney tops that may smoke
    this.smoke = false; // a scene at the rooftops' scale turns this on; the puffs are sized for 1 u ~ 7 m
    this.waters = []; // { geometry, y, rough }
    this.mists = []; // { y0, count, x0, x1, z0, z1 }
    this.sparklePts = null;
    this.slots = []; // Vector4s reserved in uLamps for moving lights
    this.animators = [];
    this.tinted = []; // extra materials whose .color follows the accent
    this.materials = { fill: null, edge: null, fine: null, hair: null, far: null, currents: [] };
    this.objects = { hair: null }; // the hair LineSegments, toggled per layout on phones
    this.xf = null;
    this.stack = [];
    this.litMode = false; // while true, lines keep their tone through the exposure bake
    this.phone = false; // set per layout by frame(): a narrow viewport (the column is the whole screen)
    this.exposure = 1; // multiplies the accent in tick(): a phone's veiled, flattened view gets a stop more
    this.view = null; // { camX, camZ, targetX, targetZ, halfW }: the column's footprint, for quiet()
    this.waterZ1 = 0; // the near edge of the water: lamps near it get the 24 reflection slots
    // Uniforms shared by every ShaderMaterial the kit makes: tick() writes each once.
    this.u = parent ? parent.u : {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color() },
      uFog: { value: new THREE.Vector2(12, 46) },
      uBg: { value: bg.clone() },
      uWind: { value: new THREE.Vector2() },
      uSparkle: { value: 0 },
      uLamps: { value: Array.from({ length: 24 }, () => new THREE.Vector4()) },
      uLampCount: { value: 0 },
    };
    this.atmos = parent ? parent.atmos : {
      uMist: { value: new THREE.Vector4(0.4, 1.4, 0, 8) },
      uGlow: { value: new THREE.Color(0.008, 0.008, 0.008) },
      uHorizon: { value: new THREE.Vector2(0, 10) },
    };
  }

  // ---- transforms ------------------------------------------------------------------------------
  push(m) { this.stack.push(this.xf); this.xf = this.xf ? this.xf.clone().multiply(m) : m.clone(); }
  pop() { this.xf = this.stack.pop(); }
  /** A world point for local (x, y, z) under the transform stack (scratch vector: read it right away). */
  world(x, y, z) { _p.set(x, y, z); if (this.xf) _p.applyMatrix4(this.xf); return _p; }
  /** A world direction for a local one (rotation only). */
  dir(x, y, z) { _q.set(x, y, z); if (this.xf) _q.transformDirection(this.xf); return _q; }
  /** Run `fn` with lit mode on: lines it emits keep their tone through the bake. */
  lit(fn) { const was = this.litMode; this.litMode = true; fn(); this.litMode = was; }

  // ---- lines -----------------------------------------------------------------------------------
  emit(c, a, b, tone) {
    const l = this.litMode ? 1 : 0;
    let ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
    if (this.xf) {
      _p.set(ax, ay, az).applyMatrix4(this.xf); ax = _p.x; ay = _p.y; az = _p.z;
      _p.set(bx, by, bz).applyMatrix4(this.xf); bx = _p.x; by = _p.y; bz = _p.z;
    }
    c.pos.push3(ax, ay, az); c.pos.push3(bx, by, bz);
    c.tone.push2(tone, tone);
    c.lit.push2(l, l);
  }
  poly(c, points, closed, tone) {
    for (let i = 1; i < points.length; i++) this.emit(c, points[i - 1], points[i], tone);
    if (closed) this.emit(c, points[points.length - 1], points[0], tone);
  }
  seg(a, b, tone = 1) { this.emit(this.cls.fine, a, b, tone); }
  line(points, closed = false, tone = 1) { this.poly(this.cls.fine, points, closed, tone); }
  edge(points, closed = false, tone = 1) { this.poly(this.cls.bold, points, closed, tone); }
  hairline(points, closed = false, tone = 1) { this.poly(this.cls.hair, points, closed, tone); }
  farline(points, closed = false, tone = 0.6) { this.poly(this.cls.far, points, closed, tone); }
  hseg(a, b, tone = 1) { this.emit(this.cls.hair, a, b, tone); }
  rect(x0, y0, x1, y1, z, tone = 1) { this.line([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], true, tone); }
  /** A closed rectangle standing in a vertical plane: centre (cx, cz), along direction (dx, dz), width w, from y0 to y1. */
  frameRect(c, cx, cz, dx, dz, w, y0, y1, tone = 1) {
    const hx = (dx * w) / 2, hz = (dz * w) / 2;
    this.poly(c, [[cx - hx, y0, cz - hz], [cx + hx, y0, cz + hz], [cx + hx, y1, cz + hz], [cx - hx, y1, cz - hz]], true, tone);
  }
  /** Alternating dashes from a to b. */
  dashed(a, b, dash, gap, cls = 'hair', tone = 1) {
    const c = this.cls[cls];
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-6) return;
    for (let s = 0; s < L; s += dash + gap) {
      const e = Math.min(s + dash, L);
      this.emit(c, [a[0] + (dx * s) / L, a[1] + (dy * s) / L, a[2] + (dz * s) / L], [a[0] + (dx * e) / L, a[1] + (dy * e) / L, a[2] + (dz * e) / L], tone);
    }
  }

  // ---- solids ----------------------------------------------------------------------------------
  /** A filled geometry: faces go into the one fill mesh, hard edges (over `threshold` degrees) into the bold lines. */
  solid(g, threshold = 20, { dark = false, tone = 1, edges = true } = {}) {
    if (this.xf) g.applyMatrix4(this.xf);
    this.solids.push({ g, threshold, dark, tone, lit: this.litMode, edges });
  }
  box(x0, x1, y0, y1, z0, z1, threshold = 20, opts) {
    this.solid(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), threshold, opts);
  }
  /** A vertical prism over a polygon in (x, z), from y0 to y1. */
  prism(pts, y0, y1, threshold = 20, opts) {
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    this.solid(new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, y0, 0), threshold, opts);
  }
  /** A truncated pyramid over a polygon: the top ring is the polygon inset by `inset`. */
  frustum(pts, y0, y1, inset, threshold = 20, opts) {
    const top = insetPoly(pts, inset);
    const out = [];
    const n = pts.length;
    const tri = (a, b, c, ox, oy, oz) => {
      // Flip to face `o` (outward): robust to either polygon winding.
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * ox + ny * oy + nz * oz < 0) [b, c] = [c, b];
      out.push(...a, ...b, ...c);
    };
    const sgn = Math.sign(area2(pts)) || 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], ta = top[i], tb = top[(i + 1) % n];
      const ex = b[0] - a[0], ez = b[1] - a[1];
      const ox = ez * sgn, oz = -ex * sgn; // outward normal in (x, z)
      const a0 = [a[0], y0, a[1]], b0 = [b[0], y0, b[1]], a1 = [ta[0], y1, ta[1]], b1 = [tb[0], y1, tb[1]];
      tri(a0, b0, b1, ox, 0, oz);
      tri(a0, b1, a1, ox, 0, oz);
    }
    let cx = 0, cz = 0;
    for (const [x, z] of top) (cx += x / n), (cz += z / n);
    for (let i = 0; i < n; i++) tri([cx, y1, cz], [top[i][0], y1, top[i][1]], [top[(i + 1) % n][0], y1, top[(i + 1) % n][1]], 0, 1, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
    this.solid(g, threshold, opts);
  }
  /** The ground: a flat dark plane with no edges, never lit by the bake. */
  ground(size, y, tone = 0.012) {
    this.solid(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2).translate(0, y, 0), 20, { dark: tone, edges: false });
  }
  /** A dome: drum + half-sphere (scaled `tall`) + lantern + finial. */
  dome(x, z, r, drum, y0, tall = 1.25, threshold = 45) {
    this.solid(new THREE.CylinderGeometry(r, r, drum, 16, 1).translate(x, y0 + drum / 2, z), threshold);
    this.solid(new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, tall, 1).translate(x, y0 + drum, z), threshold);
    this.solid(new THREE.CylinderGeometry(r * 0.2, r * 0.22, r * 0.5, 8, 1).translate(x, y0 + drum + r * tall + r * 0.25, z), threshold);
    this.seg([x, y0 + drum + r * tall + r * 0.5, z], [x, y0 + drum + r * tall + r * 0.95, z]);
    return y0 + drum + r * tall + r * 0.95;
  }

  // ---- lights, panes, water, mist, smoke ---------------------------------------------------------
  /** A lamp: a glow at (x, y, z) (local to the transform stack); `water` is the water level for a mirror image. */
  lamp(x, y, z, size = 1, { water = null, intensity = 1 } = {}) {
    const p = this.world(x, y, z);
    const seed = hash01(p.x * 1.7 + p.z + p.y * 0.3);
    this.lamps.push({ x: p.x, y: p.y, z: p.z, size, intensity, seed, shape: [1, 1], mirror: 0 });
    if (typeof water === 'number') this.lamps.push({ x: p.x, y: 2 * water - p.y, z: p.z, size, intensity: 0.35 * intensity, seed, shape: [0.8, 3.2], mirror: 1 });
  }
  /** A bake-only light source (floodlight): brightens nearby vertices, draws nothing. */
  light(x, y, z, reach, intensity) {
    const p = this.world(x, y, z);
    this.lights.push([p.x, p.y, p.z, reach, intensity]);
  }
  /** Reserve one of the 24 water-reflection slots for a moving light; update the returned Vector4 (x, y, z, intensity) per frame. */
  lightSlot() {
    const v = new THREE.Vector4(0, -1e3, 0, 0);
    (this.parent ?? this).slots.push(v);
    return v;
  }
  /** A lit window: centre (x, y, z), size w x h, outward normal (nx, nz), all local to the transform stack. */
  pane(x, y, z, w, h, nx, nz, bright, seed) {
    const p = this.world(x, y, z);
    const px = p.x, py = p.y, pz = p.z;
    const n = this.dir(nx, 0, nz);
    if (this.quiet(px, pz)) return;
    this.panes.push({ x: px + n.x * 0.006, y: py, z: pz + n.z * 0.006, w, h, nx: n.x, nz: n.z, bright, seed });
  }
  /** A sheet of water from x0..x1, z0..z1 at height y; `stretch` lengthens the lamp columns (grazing views). */
  water(x0, x1, z0, z1, y, { rough = 0, stretch = 1 } = {}) {
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, y + 0.01, (z0 + z1) / 2);
    this.waters.push({ g, y, rough, stretch });
  }
  /** A wet strip along a polyline of [x, y, z] centres (the water shader with roughness: puddles). */
  ribbon(points, width, rough = 1) {
    const pos = [], uv = [], idx = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[2] - a[2];
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      const [x, y, z] = points[i];
      pos.push(x - (dz * width) / 2, y, z + (dx * width) / 2, x + (dz * width) / 2, y, z - (dx * width) / 2);
      uv.push(0, i, 1, i);
      if (i) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(idx);
    let y = 0;
    for (const p of points) y += p[1] / points.length;
    this.waters.push({ g, y, rough, stretch: 1 });
  }
  /** `count` sheets of mist lying from y0 up, over x0..x1, z0..z1. */
  mist(y0, count, x0, x1, z0, z1) {
    this.mists.push({ y0, count: Math.min(count, 4), x0, x1, z0, z1 });
  }
  /** Points ([x, y, z]) that may sparkle. */
  sparkle(points) {
    if (!STILL) this.sparklePts = points;
  }
  /** True where (x, z) is behind the text column, so a scene can skip emitters nobody would see. */
  quiet(x, z) {
    const v = this.view;
    if (!v) return false;
    const k = (v.camZ - z) / (v.camZ - v.targetZ);
    const cx = v.camX + (v.targetX - v.camX) * k;
    return Math.abs(x - cx) < (v.halfW ?? 7.5) * k;
  }
  /** A sub-collector for something that moves as a whole (a boat): its own small batches under one Group. */
  part() {
    return new Kit(this.bg, this);
  }

  // ---- buildings ---------------------------------------------------------------------------------
  /**
   * A Haussmann block over a polygon in (x, z): the real floor stack (a tall shop floor, a low entresol,
   * then `fh` per floor), balconies on the etage noble and the top floor, a heavy cornice, a zinc mansard
   * with dormers, and chimney stacks on the party walls. `fronts` is 'all', an array of edge indices (edge i
   * runs from vertex i to i+1) or a predicate (midX, midZ, nx, nz) => bool; the other edges are party walls.
   * `detail` is 'near' | 'mid' | 'far' (LOD by depth). Returns { ridge, cornice }.
   */
  haussmann(poly, floors = 6, rnd, { base = 0, fh = 0.42, detail = 'near', fronts = 'all', pan = null, roof = 'mansard', pLit = 0.16 } = {}) {
    let pts = area2(poly) < 0 ? [...poly].reverse() : poly.map((p) => [p[0], p[1]]);
    const n0 = pts.length;
    let isFront = Array.from({ length: n0 }, (_, i) => {
      if (fronts === 'all') return true;
      if (Array.isArray(fronts)) return fronts.includes(i);
      const a = pts[i], b = pts[(i + 1) % n0];
      const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez) || 1;
      return fronts((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, ez / L, -ex / L);
    });
    // Pan coupe: chamfer the corner facing `pan` so one window axis sits on the diagonal.
    if (pan) {
      const [dx, dz] = { ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1] }[pan] ?? [0, 0];
      let best = 0, bv = -Infinity;
      pts.forEach(([x, z], i) => { const v = x * dx + z * dz; if (v > bv) (bv = v), (best = i); });
      const c = 0.45 * fh;
      const p = pts[best], prev = pts[(best - 1 + n0) % n0], next = pts[(best + 1) % n0];
      const toward = (q) => { const ex = q[0] - p[0], ez = q[1] - p[1], L = Math.hypot(ex, ez) || 1; return [p[0] + (ex / L) * c, p[1] + (ez / L) * c]; };
      pts = [...pts.slice(0, best), toward(prev), toward(next), ...pts.slice(best + 1)];
      isFront = [...isFront.slice(0, best), true, ...isFront.slice(best)];
    }
    const n = pts.length;
    const far = detail === 'far', near = detail === 'near';
    const thr = far ? 40 : 20;
    const so = { tone: far ? 0.6 : 1 }; // far roofs are a carpet: their outlines recede
    const hc = base + (floors - 0.2) * fh; // cornice: 1.25 + 0.55 + (floors - 2) floors
    const r0 = hc + 0.1 * fh; // eave: the top of the cornice band
    // Cornice: a band overhanging 0.06, with a bright line along its underside on every front. A far
    // building is one prism to the eave: the band is sub-pixel there.
    const cor = insetPoly(pts, -0.06);
    if (far) this.prism(pts, base, r0, thr, so);
    else {
      this.prism(pts, base, hc, thr, so);
      this.prism(cor, hc, r0, thr, so);
      this.lit(() => { for (let i = 0; i < n; i++) if (isFront[i]) this.edge([[cor[i][0], hc, cor[i][1]], [cor[(i + 1) % n][0], hc, cor[(i + 1) % n][1]]], false, 1); });
    }
    // Roof: zinc mansard (brisis + terrasson), a gable, or a flat terrace with a parapet.
    let ridge = r0;
    if (roof === 'mansard') {
      this.frustum(pts, r0, hc + 1.05 * fh, 0.22 * fh, thr, so);
      this.frustum(insetPoly(pts, 0.22 * fh), hc + 1.05 * fh, hc + 1.3 * fh, 0.23 * fh, thr, so);
      ridge = hc + 1.3 * fh;
    } else if (roof === 'gable') {
      ridge = this.gable(pts, r0, fh, thr);
    } else {
      this.hairline(pts.map(([x, z]) => [x, r0, z]), true, 0.8);
    }
    const yf = (f) => base + (f - 0.2) * fh; // the floor line of floor f >= 2
    const stacks = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
      if (L < 1e-6) continue;
      const dx = ex / L, dz = ez / L, nx = dz, nz = -dx; // outward normal
      if (!isFront[i]) {
        // A party wall: chimney stacks 0.15 in from it, at 0.35 (and 0.75 on long walls) of its length.
        if (L >= 1.2) for (const t of L > 4 && !far ? [0.35, 0.75] : [0.35]) stacks.push([a[0] + dx * L * t - nx * 0.15, a[1] + dz * L * t - nz * 0.15, dx, dz]);
        continue;
      }
      const ox = nx * 0.004, oz = nz * 0.004; // lines sit a hair in front of the fill
      const pitch = 1.05 * fh;
      const count = Math.max(1, Math.floor((L - 1.1 * fh) / pitch) + 1);
      const start = (L - (count - 1) * pitch) / 2;
      if (!far) {
        this.line([[a[0] + ox, base + 1.25 * fh, a[1] + oz], [b[0] + ox, base + 1.25 * fh, b[1] + oz]], false, 0.9); // shopfront
        if (near) for (const c of [0.35, 0.7, 1.05]) this.hairline([[a[0] + ox, base + c * fh, a[1] + oz], [b[0] + ox, base + c * fh, b[1] + oz]], false, 0.7);
        for (const f of [2, floors - 1]) {
          if (f < 2 || f >= floors || (f === floors - 1 && floors - 1 === 2)) continue;
          const y = yf(f) + 0.02;
          const bx = nx * 0.08, bz = nz * 0.08;
          this.edge([[a[0] + bx + dx * 0.05, y, a[1] + bz + dz * 0.05], [b[0] + bx - dx * 0.05, y, b[1] + bz - dz * 0.05]], false, 0.9);
          if (near) for (let s = 0.08; s < L - 0.05; s += 0.12) this.hseg([a[0] + bx + dx * s, y, a[1] + bz + dz * s], [a[0] + bx + dx * s, y + 0.2 * fh, a[1] + bz + dz * s], 0.7);
        }
      }
      for (let k = 0; k < count; k++) {
        const s = start + k * pitch;
        const cx = a[0] + dx * s, cz = a[1] + dz * s;
        for (let f = 2; f < floors; f++) {
          const y0 = yf(f) + 0.12 * fh, y1 = yf(f) + 0.84 * fh;
          if (!far) this.frameRect(this.cls.fine, cx + ox, cz + oz, dx, dz, 0.36 * fh, y0, y1, 0.8);
          if (near && (f === 3 || f === 4) && f !== floors - 1) {
            const hw = 0.22 * fh, y = yf(f) + 0.1 * fh;
            this.seg([cx + nx * 0.06 - dx * hw, y, cz + nz * 0.06 - dz * hw], [cx + nx * 0.06 + dx * hw, y, cz + nz * 0.06 + dz * hw], 0.8);
          }
          if (rnd() < pLit) this.pane(cx, (y0 + y1) / 2, cz, Math.max((0.2 * fh) / 0.42, 0.1), Math.max((0.3 * fh) / 0.42, 0.14), nx, nz, 0.5 + 0.5 * rnd(), rnd());
        }
        if (rnd() < 0.3) this.pane(cx, base + 0.6 * fh, cz, pitch * 0.9, (0.3 * fh) / 0.42, nx, nz, 0.35, rnd());
        // Lucarnes standing proud of the brisis.
        if (roof === 'mansard' && !far && (near || k % 2 === 0)) {
          this.push(new THREE.Matrix4().makeBasis(V(-dx, 0, -dz), V(0, 1, 0), V(nx, 0, nz)).setPosition(cx - nx * 0.14 * fh, 0, cz - nz * 0.14 * fh));
          const w = 0.3 * fh, hh = 0.42 * fh, dp = 0.25 * fh, y0 = r0 + 0.12 * fh;
          this.box(-w / 2, w / 2, y0, y0 + hh, -dp / 2, dp / 2, thr);
          this.edge([[-w / 2, y0 + hh, dp / 2 + 0.002], [0, y0 + hh + 0.15 * fh, dp / 2 + 0.002], [w / 2, y0 + hh, dp / 2 + 0.002]], false, 0.8);
          this.pop();
        }
      }
    }
    // Chimney stacks on the party walls, with pots; some will smoke.
    for (const [sx, sz, dx, dz] of stacks) {
      const w = 0.32 * fh, d = 0.22 * fh, top = ridge + 0.9 * fh;
      this.push(new THREE.Matrix4().makeBasis(V(-dx, 0, -dz), V(0, 1, 0), V(dz, 0, -dx)).setPosition(sx, 0, sz));
      this.box(-w / 2, w / 2, r0, top, -d / 2, d / 2, thr, so);
      const pots = 2 + Math.floor(rnd() * 3);
      for (let i = 0; i < pots; i++) { const px = (-(pots - 1) / 2 + i) * (w / pots); this.seg([px, top, 0], [px, top + 0.16 * fh, 0], 0.9); }
      this.pop();
      if (rnd() < 0.35) { const p = this.world(sx, top, sz); this.stacks.push([p.x, p.y, p.z]); }
    }
    return { ridge, cornice: hc };
  }
  /** A gable roof across the lot's short axis, extruded along its longest edge. Returns the ridge height. */
  gable(pts, r0, fh, thr) {
    const n = pts.length;
    let li = 0, lL = 0;
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L > lL) (lL = L), (li = i); }
    const a = pts[li], b = pts[(li + 1) % n];
    const dx = (b[0] - a[0]) / lL, dz = (b[1] - a[1]) / lL; // along
    const ax = dz, az = -dx; // across (right-handed with up and along)
    let cx = 0, cz = 0;
    for (const [x, z] of pts) (cx += x / n), (cz += z / n);
    let hl = 0, hw = 0;
    for (const [x, z] of pts) { hl = Math.max(hl, Math.abs((x - cx) * dx + (z - cz) * dz)); hw = Math.max(hw, Math.abs((x - cx) * ax + (z - cz) * az)); }
    const rise = Math.min(0.55 * hw, 1.3 * fh);
    const shape = new THREE.Shape([new THREE.Vector2(-hw, r0), new THREE.Vector2(hw, r0), new THREE.Vector2(0, r0 + rise)]);
    const g = new THREE.ExtrudeGeometry(shape, { depth: 2 * hl, bevelEnabled: false }).translate(0, 0, -hl);
    g.applyMatrix4(new THREE.Matrix4().makeBasis(V(ax, 0, az), V(0, 1, 0), V(dx, 0, dz)).setPosition(cx, 0, cz));
    this.solid(g, thr);
    return r0 + rise;
  }

  /**
   * The Eiffel Tower at (cx, cz), H tall (1 u = 19.06 m when H = 17): four splayed legs standing apart
   * under the first floor, the great arches, three floors, the campanile and antenna, floodlit at the feet.
   * The lattice is bake-exempt so it stays the brightest thing in any scene.
   */
  eiffel(cx, cz, H = 17, { beacon = true } = {}) {
    const k = H / 17;
    const p1 = 0.176 * H, p2 = 0.355 * H, p3 = 0.852 * H;
    const w = (y) => (y < p2 ? 3.28 * k * Math.exp((-0.1887 * y) / k) : 1.065 * k * Math.exp((-0.0925 * (y - p2)) / k));
    const l = (y) => (y < p1 ? lerp(0.62, 0.4, y / p1) : 0.4) * k;
    const inner = (y) => w(y) - 2 * l(y);
    const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
    const P = (x, y, z) => [cx + x, y, cz + z];
    const curves = []; // corner curves, sampled later for the sparkle
    this.lit(() => {
      // Four legs below the second floor: four vertical curves each, a ring and X-bracing per level,
      // and a second X at half-step below the first floor.
      const N = 27;
      const ys = Array.from({ length: N + 1 }, (_, i) => (p2 * i) / N);
      for (const [sx, sz] of corners) {
        const at = (y, ox, oz) => P(sx * (ox ? w(y) : inner(y)), y, sz * (oz ? w(y) : inner(y)));
        const ring = (y) => [at(y, 1, 1), at(y, 1, 0), at(y, 0, 0), at(y, 0, 1)];
        for (const [ox, oz] of [[1, 1], [1, 0], [0, 1], [0, 0]]) { const c = ys.map((y) => at(y, ox, oz)); this.edge(c, false, 0.95); curves.push(c); }
        ys.forEach((y, i) => {
          const r = ring(y);
          this.line(r, true, 0.9);
          if (!i) return;
          const p = ring(ys[i - 1]);
          for (let f = 0; f < 4; f++) { const g = (f + 1) % 4; this.seg(p[f], r[g], 0.9); this.seg(p[g], r[f], 0.9); }
          if (y <= p1 + 1e-6) {
            const m = ring((ys[i - 1] + y) / 2);
            for (let f = 0; f < 4; f++) { const g = (f + 1) % 4; this.hseg(p[f], m[g], 0.8); this.hseg(p[g], m[f], 0.8); this.hseg(m[f], r[g], 0.8); this.hseg(m[g], r[f], 0.8); }
          }
        });
      }
      // The great arches: circular, their ends landing inside the leg lattice.
      const R = 1.96 * k, yc = p1 - 0.35 * k - R;
      for (const [axis, side] of [['x', 1], ['x', -1], ['z', 1], ['z', -1]]) {
        const pts = (r) => Array.from({ length: 25 }, (_, i) => {
          const a = (Math.PI * i) / 24, u = -r * Math.cos(a), y = yc + r * Math.sin(a), out = (w(y) - 0.05 * k) * side;
          return axis === 'x' ? P(u, y, out) : P(out, y, u);
        });
        const outer = pts(R), innerArc = pts(R - 0.16 * k);
        this.edge(outer, false, 1);
        this.line(innerArc, false, 0.9);
        for (let i = 0; i < 25; i++) this.hseg(outer[i], innerArc[i], 0.8);
      }
      // First floor: a ring of four boxes with an arcaded frieze along the top edge of each face.
      const o1 = w(p1) + 0.05 * k, h1 = inner(p1), t1 = 0.35 * k;
      this.box(cx + h1, cx + o1, p1 - t1, p1, cz - o1, cz + o1);
      this.box(cx - o1, cx - h1, p1 - t1, p1, cz - o1, cz + o1);
      this.box(cx - h1, cx + h1, p1 - t1, p1, cz + h1, cz + o1);
      this.box(cx - h1, cx + h1, p1 - t1, p1, cz - o1, cz - h1);
      for (const [axis, side] of [['x', 1], ['x', -1], ['z', 1], ['z', -1]]) {
        const out = (o1 + 0.004) * side;
        for (let j = 0; j < 14; j++) {
          const u0 = (-1.82 + j * 0.26) * k;
          this.line(arc(u0 + 0.13 * k, p1 - 0.11 * k, 0.11 * k, Math.PI, 0, 4).map(([u, y]) => (axis === 'x' ? P(u, y, out) : P(out, y, u))), false, 0.9);
        }
      }
      // Second floor ring, then the column up to the third floor.
      const o2 = 1.165 * k, h2 = 0.5 * k, t2 = 0.3 * k;
      this.box(cx + h2, cx + o2, p2 - t2, p2, cz - o2, cz + o2);
      this.box(cx - o2, cx - h2, p2 - t2, p2, cz - o2, cz + o2);
      this.box(cx - h2, cx + h2, p2 - t2, p2, cz + h2, cz + o2);
      this.box(cx - h2, cx + h2, p2 - t2, p2, cz - o2, cz - h2);
      const M = 17;
      const cys = Array.from({ length: M + 1 }, (_, i) => p2 + ((p3 - p2) * i) / M);
      const cring = (y) => corners.map(([sx, sz]) => P(sx * w(y), y, sz * w(y)));
      for (const [sx, sz] of corners) { const c = cys.map((y) => P(sx * w(y), y, sz * w(y))); this.edge(c, false, 0.95); curves.push(c); }
      cys.forEach((y, i) => {
        const r = cring(y);
        this.line(r, true, 0.9);
        if (!i) return;
        const p = cring(cys[i - 1]);
        for (let f = 0; f < 4; f++) { const g = (f + 1) % 4; this.seg(p[f], r[g], 0.9); this.seg(p[g], r[f], 0.9); }
      });
      // Third floor, lantern, campanile and antenna.
      this.box(cx - 0.47 * k, cx + 0.47 * k, p3, p3 + 0.35 * k, cz - 0.47 * k, cz + 0.47 * k);
      this.box(cx - 0.32 * k, cx + 0.32 * k, p3 + 0.35 * k, p3 + 0.65 * k, cz - 0.32 * k, cz + 0.32 * k);
      const cy0 = p3 + 0.65 * k, cy1 = H - 0.6 * k;
      const camp = (y) => lerp(0.3 * k, 0.06 * k, (y - cy0) / (cy1 - cy0));
      const campYs = Array.from({ length: 6 }, (_, i) => cy0 + ((cy1 - cy0) * i) / 5);
      for (const [sx, sz] of corners) this.edge(campYs.map((y) => P(sx * camp(y), y, sz * camp(y))), false, 0.95);
      for (const y of campYs) this.line(corners.map(([sx, sz]) => P(sx * camp(y), y, sz * camp(y))), true, 0.9);
      this.edge([P(0, cy1, 0), P(0, H + 0.37 * k, 0)], false, 0.95);
      for (const y of [H - 0.3 * k, H, H + 0.2 * k]) { this.seg(P(-0.08 * k, y, 0), P(0.08 * k, y, 0), 0.9); this.seg(P(0, y, -0.08 * k), P(0, y, 0.08 * k), 0.9); }
    });
    // Floodlights at the feet and at the top, for the exposure bake.
    for (const [sx, sz] of corners) this.light(cx + sx * 2.6 * k, 0.6 * k, cz + sz * 2.6 * k, 5 * k, 0.9);
    this.light(cx, H - 0.5 * k, cz, 3 * k, 0.5);
    // The sparkle: 320 points along the corner curves, lit a few at a time for 7 s every 55 s.
    if (!STILL) {
      const rnd = prng(7);
      const pts = [];
      for (let i = 0; i < 320; i++) {
        const c = curves[Math.floor(rnd() * curves.length)];
        const t = rnd() * (c.length - 1), j = Math.floor(t), f = t - j;
        const a = c[j], b = c[Math.min(j + 1, c.length - 1)];
        pts.push([lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)]);
      }
      this.sparkle(pts);
      const u = this.u;
      this.animators.push((t) => { const sp = (t % 55) / 55; u.uSparkle.value = sstep(0, 0.02, sp) * (1 - sstep(0.11, 0.13, sp)); });
    }
    if (beacon) {
      // The beacon: two short shafts turning from the top, bright side-on and nearly invisible end-on.
      const pivot = new THREE.Group();
      pivot.position.set(cx, H - 0.5 * k, cz);
      const LEN = 14 * k;
      for (const d of [1, -1]) {
        const m = additive({ ...this.u, uLen: { value: LEN } }, BEACON_VERT, BEACON_FRAG, { side: THREE.DoubleSide });
        this.materials.currents.push(m);
        // Apex at the pivot, the shaft down -y; the MESH turns it to +-x (with a 0.06 rad lift) so the
        // shader's position.y still measures the distance along the shaft.
        const cone = new THREE.Mesh(new THREE.ConeGeometry(1.6 * k, LEN, 20, 1, true).translate(0, -LEN / 2, 0), m);
        cone.rotation.z = d * (Math.PI / 2 + 0.06);
        cone.frustumCulled = false;
        pivot.add(cone);
      }
      this.root.add(pivot);
      this.lamp(cx, H - 0.5 * k, cz, 1.4 * k, { intensity: 1 });
      this.animators.push((t) => (pivot.rotation.y = t * 0.2));
    }
  }

  // ---- build ---------------------------------------------------------------------------------------
  /** Batches everything collected so far. Call once, after all geometry, before the first tick(). */
  finish() {
    const t0 = performance.now();
    const u = this.u, atmos = this.atmos, root = this.root, part = !!this.parent;
    const addFog = (m) => {
      // Inject the height mist and horizon glow into three's fog for this material.
      m.onBeforeCompile = (s) => {
        Object.assign(s.uniforms, atmos);
        const v0 = s.vertexShader, f0 = s.fragmentShader;
        s.vertexShader = v0
          .replace('#include <fog_pars_vertex>', '#include <fog_pars_vertex>\nvarying float vWorldY;')
          .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWorldY = (modelMatrix * vec4(transformed, 1.0)).y;');
        s.fragmentShader = f0
          .replace('#include <fog_pars_fragment>', '#include <fog_pars_fragment>\nvarying float vWorldY; uniform vec4 uMist; uniform vec3 uGlow; uniform vec2 uHorizon;')
          .replace('#include <fog_fragment>', FOG_FRAG);
        if (DEBUG && (s.vertexShader === v0 || s.fragmentShader === f0)) console.warn('scenes: fog injection found nothing to replace');
      };
      m.customProgramCacheKey = () => 'parisfog';
      return m;
    };
    const add = (o) => { o.frustumCulled = false; root.add(o); return o; };

    // Fills: one mesh. Hard edges of every solid join the bold lines.
    const fillPos = new Buf(1 << 15);
    const meta = []; // per solid: [first float, last float, dark]
    for (const s of this.solids) {
      const g = s.g.index ? s.g.toNonIndexed() : s.g;
      const p = g.getAttribute('position').array;
      meta.push([fillPos.n, fillPos.n + p.length, s.dark]);
      fillPos.set(p);
      if (s.edges) {
        const e = new THREE.EdgesGeometry(s.g, s.threshold).getAttribute('position').array;
        const c = this.cls.bold;
        c.pos.set(e);
        c.tone.rep(s.tone, e.length / 3);
        c.lit.rep(s.lit ? 1 : 0, e.length / 3);
      }
    }

    // Exposure bake: every lamp and floodlight brightens the fill and line vertices near it, at build
    // time. Sources are bucketed on a 4 u grid over (x, z) so each vertex only sees its neighbours.
    const src = [...this.lights];
    for (const L of this.lamps) if (!L.mirror) src.push([L.x, L.y, L.z, 2.6 * L.size, L.intensity]);
    const CELL = 4;
    const grid = new Map();
    const key = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);
    for (const s of src) {
      const r = 4 * s[3];
      for (let ix = Math.floor((s[0] - r) / CELL); ix <= Math.floor((s[0] + r) / CELL); ix++)
        for (let iz = Math.floor((s[2] - r) / CELL); iz <= Math.floor((s[2] + r) / CELL); iz++) {
          const k = key(ix, iz);
          let a = grid.get(k);
          if (!a) grid.set(k, (a = []));
          a.push(s);
        }
    }
    const expose = (x, y, z) => {
      const a = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (!a) return 0;
      let E = 0;
      for (const s of a) {
        const dx = x - s[0], dy = y - s[1], dz = z - s[2], r2 = s[3] * s[3], d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 16 * r2) continue;
        E += ((s[4] * r2) / (r2 + d2)) * clamp(1 - dy / 5, 0.2, 1);
      }
      return E;
    };

    if (fillPos.n) {
      const pos = fillPos.view();
      let lo = Infinity, hi = -Infinity;
      for (let i = 1; i < pos.length; i += 3) { if (pos[i] < lo) lo = pos[i]; if (pos[i] > hi) hi = pos[i]; }
      const col = new Float32Array(pos.length);
      for (const [a, b, dark] of meta) {
        for (let i = a; i < b; i += 3) {
          const c = dark ? (typeof dark === 'number' ? dark : 0.012) : 0.004 + 0.012 * ((pos[i + 1] - lo) / (hi - lo || 1)) + 0.08 * Math.min(expose(pos[i], pos[i + 1], pos[i + 2]), 1.2);
          col[i] = col[i + 1] = col[i + 2] = c;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      this.materials.fill = addFog(new THREE.MeshBasicMaterial({ vertexColors: true, fog: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      add(new THREE.Mesh(g, this.materials.fill));
      if (part) this.parent.tinted.push(this.materials.fill);
    }

    // Lines: one LineSegments per class, tone in the vertex colour, the bake folded into the tone.
    const lines = (name, c) => {
      const nv = c.pos.n / 3;
      const pos = c.pos.view();
      const col = new Float32Array(c.pos.n);
      for (let i = 0; i < nv; i++) {
        let tone = c.tone.a[i];
        if (c.bake && !c.lit.a[i]) tone *= c.bake[0] + c.bake[1] * Math.min(expose(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]), 1);
        col[3 * i] = col[3 * i + 1] = col[3 * i + 2] = tone;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const m = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: c.opacity, fog: c.fog });
      if (c.fog) addFog(m);
      if (part) this.parent.tinted.push(m);
      this.materials[name] = m;
      return add(new THREE.LineSegments(g, m));
    };
    lines('edge', this.cls.bold);
    lines('fine', this.cls.fine);
    this.objects.hair = lines('hair', this.cls.hair);
    lines('far', this.cls.far);

    // Lamps: one instanced batch. The brightest near the water also feed the reflection shader.
    if (!part) {
      const z1 = this.waterZ1;
      const rank = (L) => L.intensity / (1 + Math.abs(L.z - z1));
      const ranked = this.lamps.filter((L) => !L.mirror).sort((a, b) => rank(b) - rank(a));
      const nStatic = Math.min(ranked.length, 24 - this.slots.length);
      for (let i = 0; i < nStatic; i++) u.uLamps.value[i].set(ranked[i].x, ranked[i].y, ranked[i].z, ranked[i].intensity);
      this.slots.forEach((v, j) => (u.uLamps.value[nStatic + j] = v));
      u.uLampCount.value = nStatic + this.slots.length;
    }
    const instanced = (base, n) => { const g = new THREE.InstancedBufferGeometry().copy(base); g.instanceCount = n; return g; };
    const iattr = (g, name, arr, size) => g.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));
    const quad = new THREE.PlaneGeometry(1, 1);
    if (this.lamps.length) {
      const n = this.lamps.length;
      const g = instanced(quad, n);
      const aPos = new Float32Array(3 * n), aSize = new Float32Array(n), aInt = new Float32Array(n), aSeed = new Float32Array(n), aShape = new Float32Array(2 * n);
      this.lamps.forEach((L, i) => { aPos[3 * i] = L.x; aPos[3 * i + 1] = L.y; aPos[3 * i + 2] = L.z; aSize[i] = L.size; aInt[i] = L.intensity; aSeed[i] = L.seed; aShape[2 * i] = L.shape[0]; aShape[2 * i + 1] = L.shape[1]; });
      iattr(g, 'aPos', aPos, 3); iattr(g, 'aSize', aSize, 1); iattr(g, 'aIntensity', aInt, 1); iattr(g, 'aSeed', aSeed, 1); iattr(g, 'aShape', aShape, 2);
      const m = additive(u, LAMP_VERT, LAMP_FRAG);
      this.materials.currents.push(m);
      add(new THREE.Mesh(g, m));
    }

    // Panes: one batch of quads laid in their facades.
    if (this.panes.length) {
      const n = this.panes.length;
      const pos = new Float32Array(18 * n), uv = new Float32Array(12 * n), br = new Float32Array(6 * n), sd = new Float32Array(6 * n);
      const C = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
      this.panes.forEach((p, i) => {
        const rx = (p.nz * p.w) / 2, rz = (-p.nx * p.w) / 2, h = p.h / 2;
        C.forEach(([sx, sy], j) => {
          const o = 18 * i + 3 * j;
          pos[o] = p.x + sx * rx; pos[o + 1] = p.y + sy * h; pos[o + 2] = p.z + sx * rz;
          uv[12 * i + 2 * j] = (sx + 1) / 2; uv[12 * i + 2 * j + 1] = (sy + 1) / 2;
          br[6 * i + j] = p.bright; sd[6 * i + j] = p.seed;
        });
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setAttribute('aBright', new THREE.BufferAttribute(br, 1));
      g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
      const m = additive(u, PANE_VERT, PANE_FRAG, { side: THREE.DoubleSide });
      this.materials.currents.push(m);
      add(new THREE.Mesh(g, m));
    }

    // Water sheets and wet ribbons.
    for (const w of this.waters) {
      const m = additive({ ...u, uWaterY: { value: w.y }, uRough: { value: w.rough }, uStretch: { value: w.stretch }, uGlow: atmos.uGlow }, WATER_VERT, WATER_FRAG, { side: THREE.DoubleSide });
      this.materials.currents.push(m);
      add(new THREE.Mesh(w.g, m));
    }

    // Mist: one instanced batch of sheets per call.
    for (const ms of this.mists) {
      const base = new THREE.PlaneGeometry(ms.x1 - ms.x0, ms.z1 - ms.z0).rotateX(-Math.PI / 2).translate((ms.x0 + ms.x1) / 2, 0, (ms.z0 + ms.z1) / 2);
      const g = instanced(base, ms.count);
      const H = [0.15, 0.55, 1.05, 1.7];
      iattr(g, 'aY', Float32Array.from({ length: ms.count }, (_, k) => ms.y0 + H[k]), 1);
      iattr(g, 'aSeed', Float32Array.from({ length: ms.count }, (_, k) => k * 13.7), 1);
      iattr(g, 'aSpeed', Float32Array.from({ length: ms.count }, (_, k) => 0.035 * (1 + 0.4 * k)), 1);
      const m = additive(u, MIST_VERT, MIST_FRAG, { side: THREE.DoubleSide });
      this.materials.currents.push(m);
      add(new THREE.Mesh(g, m));
    }

    // Smoke from up to 24 of the nearest visible chimney stacks (never under reduced motion). Stacks
    // within 10 u of the camera are passed over: their puffs would be soft discs the size of a roof.
    if (!STILL && !part && this.smoke && this.stacks.length) {
      const v = this.view;
      const near = (s) => (v ? Math.hypot(s[0] - v.camX, s[2] - v.camZ) : 0);
      const cand = this.stacks.filter(([x, , z]) => !this.quiet(x, z) && near([x, 0, z]) >= 10).sort((a, b) => near(a) - near(b)).slice(0, 24);
      if (cand.length) {
        const n = cand.length * 7;
        const g = instanced(quad, n);
        const aStack = new Float32Array(3 * n), aSeed = new Float32Array(n), aRate = new Float32Array(n);
        const rnd = prng(5);
        cand.forEach((s, i) => { for (let j = 0; j < 7; j++) { const k = 7 * i + j; aStack[3 * k] = s[0]; aStack[3 * k + 1] = s[1]; aStack[3 * k + 2] = s[2]; aSeed[k] = rnd(); aRate[k] = 0.8 + 0.4 * rnd(); } });
        iattr(g, 'aStack', aStack, 3); iattr(g, 'aSeed', aSeed, 1); iattr(g, 'aRate', aRate, 1);
        const m = additive(u, SMOKE_VERT, SMOKE_FRAG);
        this.materials.currents.push(m);
        add(new THREE.Mesh(g, m));
      }
    }

    // The Eiffel sparkle.
    if (this.sparklePts) {
      const n = this.sparklePts.length;
      const g = instanced(quad, n);
      const aPos = new Float32Array(3 * n), aSeed = new Float32Array(n);
      this.sparklePts.forEach((p, i) => { aPos[3 * i] = p[0]; aPos[3 * i + 1] = p[1]; aPos[3 * i + 2] = p[2]; aSeed[i] = hash01(i * 0.731 + 0.17); });
      iattr(g, 'aPos', aPos, 3); iattr(g, 'aSeed', aSeed, 1);
      const m = additive(u, SPARKLE_VERT, SPARKLE_FRAG);
      this.materials.currents.push(m);
      add(new THREE.Mesh(g, m));
    }

    // The sky: a vertex-coloured band at the back, brightest at the horizon, so distance has somewhere to go.
    if (!part) {
      const yLo = atmos.uHorizon.value.x;
      const g = new THREE.PlaneGeometry(1200, 60, 1, 4).translate(0, yLo + 24, -160);
      const pos = g.getAttribute('position');
      const col = new Float32Array(pos.count * 3);
      const glow = atmos.uGlow.value, bg = this.bg;
      for (let i = 0; i < pos.count; i++) {
        const f = clamp(1 - (pos.getY(i) - (yLo - 6)) / 60, 0, 1) ** 1.6;
        col[3 * i] = bg.r + glow.r * f; col[3 * i + 1] = bg.g + glow.g * f; col[3 * i + 2] = bg.b + glow.b * f; // bottom row = the fogged ground, so no seam
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const sky = add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, depthWrite: false })));
      sky.renderOrder = -10;
    } else {
      this.parent.scene.add(root);
    }

    if (DEBUG && !part) {
      console.table({
        bold: this.cls.bold.pos.n / 3, fine: this.cls.fine.pos.n / 3, hair: this.cls.hair.pos.n / 3, far: this.cls.far.pos.n / 3,
        solids: this.solids.length, triangles: fillPos.n / 9, lamps: this.lamps.length, panes: this.panes.length,
        stacks: this.stacks.length, sources: src.length, buildMs: Math.round(performance.now() - t0),
      });
    }
  }

  /** Called every frame with the current accent (linear) and the time in seconds. Allocates nothing. */
  tick(accent, time) {
    const t = time % 3600;
    const u = this.u, m = this.materials, fog = this.scene.fog;
    const col = u.uColor.value.copy(accent).multiplyScalar(this.exposure); // never clamped: the bump may exceed 1
    u.uTime.value = t;
    if (fog) u.uFog.value.set(fog.near, fog.far);
    m.fill?.color.copy(col);
    m.edge.color.copy(col);
    m.fine.color.copy(col);
    m.hair.color.copy(col);
    m.far.color.copy(col);
    for (const x of this.tinted) x.color.copy(col);
    for (const c of m.currents) { c.uniforms.uColor.value.copy(col); c.uniforms.uTime.value = t; } // shared objects: idempotent
    for (const a of this.animators) a(t);
  }
}

// ---- geometry helpers ------------------------------------------------------------------------------
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** Twice the signed area of a polygon in (x, z). */
function area2(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a;
}
/** The polygon moved inward by `d` (outward when negative): neighbouring offset edges intersected. */
function insetPoly(pts, d) {
  const n = pts.length, sgn = Math.sign(area2(pts)) || 1;
  const ls = pts.map((a, i) => {
    const b = pts[(i + 1) % n];
    let ex = b[0] - a[0], ez = b[1] - a[1];
    const L = Math.hypot(ex, ez) || 1;
    ex /= L; ez /= L;
    const nx = ez * sgn, nz = -ex * sgn; // outward
    return { px: a[0] - nx * d, pz: a[1] - nz * d, ex, ez };
  });
  const out = pts.map((_, i) => {
    const A = ls[(i - 1 + n) % n], B = ls[i];
    const det = A.ex * B.ez - A.ez * B.ex;
    if (Math.abs(det) < 1e-6) return [B.px, B.pz];
    const t = ((B.px - A.px) * B.ez - (B.pz - A.pz) * B.ex) / det;
    return [A.px + A.ex * t, A.pz + A.ez * t];
  });
  if (d > 0 && Math.sign(area2(out)) !== sgn) {
    // Inset past the middle: collapse to the centroid (a pyramid instead of a frustum).
    let cx = 0, cz = 0;
    for (const [x, z] of pts) (cx += x / n), (cz += z / n);
    return pts.map(() => [cx, cz]);
  }
  return out;
}
/** Sutherland-Hodgman: the part of a convex polygon on the side where f(x, z) >= 0 (f affine). */
function clipPoly(pts, f) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const fa = f(a[0], a[1]), fb = f(b[0], b[1]);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}

/**
 * Place the camera at an absolute eye height, `azimuthDeg` round from the target, at the distance that
 * makes `halfWidth` world units either side of the target fill the viewport. The eye never sinks with
 * the aspect ratio: a portrait phone flattens the view instead.
 */
function fitEye(kit, camera, eyeY, azimuthDeg, target, halfWidth, fog = [0.75, 1.9]) {
  // Wider than 1.7:1 shows more at the sides rather than closing in (a 21:9 screen would crop the tower).
  const hfov = 2 * Math.atan(Math.tan(deg(camera.fov / 2)) * Math.min(camera.aspect, 1.7));
  const dist = halfWidth / Math.tan(hfov / 2);
  const dy = eyeY - target.y;
  const dh = Math.sqrt(Math.max(dist * dist - dy * dy, (0.6 * dist) ** 2));
  const az = deg(azimuthDeg);
  camera.position.set(target.x + Math.sin(az) * dh, eyeY, target.z + Math.cos(az) * dh);
  camera.lookAt(target);
  // Fog relative to the camera, so near structure is crisp and the distance dissolves into mist.
  kit.scene.fog.near = dist * fog[0];
  kit.scene.fog.far = dist * fog[1];
  kit.u.uFog.value.set(kit.scene.fog.near, kit.scene.fog.far);
  return target;
}
/**
 * Frame a scene: fitEye with the phone narrowing (and a phone look-at, if given), the hair-detail toggle,
 * and the phone exposure. On a phone the text column is the whole screen and the site's veil covers all of
 * it, so the scene is pushed a stop (see PHONE_EXPOSURE) and reports `center` 1 (no second dimming).
 */
const PHONE_EXPOSURE = 1.6;
function frameOf(kit, eyeY, azimuthDeg, target, halfWidth, fog, phoneTarget = target) {
  return (camera, width) => {
    const phone = width < 760;
    kit.phone = phone;
    kit.exposure = phone ? PHONE_EXPOSURE : 1;
    kit.objects.hair.visible = !phone;
    return fitEye(kit, camera, eyeY, azimuthDeg, phone ? phoneTarget : target, halfWidth * (phone ? 0.72 : 1), fog);
  };
}
// Each scene's `center` (how much shows through behind the column) is a getter: the scene's value on a
// desktop, 1 on a phone. backdrop.js reads it at every layout, right after frame() has set kit.phone.

// ---- the scenes ------------------------------------------------------------------------------------

/**
 * The Trocadero postcard at true scale (1 u = 19.06 m): the tower left of the column over the Pont
 * d'Iena and the Seine, the Champ de Mars and the Ecole Militaire behind it, a lit carpet of Quai Branly
 * roofs and the Bir-Hakeim viaduct on the right, the far domes faint on the horizon glow.
 */
function eiffelTower(bg, flip) {
  const kit = new Kit(bg);
  const rnd = prng(flip ? 41 : 17);
  const s = flip ? -1 : 1;
  const xr = (a, b) => [Math.min(a * s, b * s), Math.max(a * s, b * s)];
  const EYE = 2.2, HW = 19, TX = -13.5 * s, TZ = -2, WATER = -0.32, QUAI = -0.27, Z1 = 23.2; // Z1: the near bank
  kit.view = { camX: 1.79 * s, camZ: 51.2, targetX: 0, targetZ: 0, halfW: HW * 0.472 };
  kit.waterZ1 = 22;
  kit.atmos.uMist.value.set(0.5, 1.4, -0.4, 10);
  kit.atmos.uHorizon.value.set(-0.4, 9);

  kit.eiffel(TX, TZ, 17);

  // The river between its two quai walls: the far bank at grade, the near one a low towpath so the water
  // shows over its edge from this eye height. Seen this flat, the lamp columns are stretched toward the
  // camera (a glitter path), or they would be a few pixels tall.
  kit.ground(400, -0.4, 0.006);
  kit.box(-70, 70, -0.4, 0, -90, 14, 20, { dark: true, edges: false });
  kit.edge([[-50, 0, 14], [50, 0, 14]], false, 0.8);
  kit.box(-70, 70, -0.4, QUAI, Z1, 80, 20, { dark: true, edges: false });
  kit.edge([[-50, QUAI, Z1], [50, QUAI, Z1]], false, 0.8);
  kit.water(-50, 50, 14, Z1, WATER, { stretch: 3 });
  kit.mist(WATER, 3, -50, 50, 14, Z1);

  // Pont d'Iena: five segmental arches with voussoir rings, statue plinths, lamps. It stands 4 u right
  // of the tower's axis so it lands inside the frame left of the column (the camera looks 15 deg right
  // of the tower, which the real bridge does not allow for).
  kit.push(placed(TX + 4 * s, 18.25, 90));
  {
    const L = 8.5, n = 5, pier = 0.22, pitch = L / n, span = pitch - pier, DECK = 0.12, SPRING = -0.3, CROWN = -0.04;
    kit.box(-L / 2, L / 2, 0, DECK, -0.9, 0.9);
    const rise = CROWN - SPRING, R = (span * span / 4 + rise * rise) / (2 * rise), yc = CROWN - R, a0 = Math.asin((span / 2) / R);
    for (let j = 0; j < n; j++) {
      const cx = -L / 2 + pitch * (j + 0.5);
      for (const z of [-0.9, 0.9]) {
        const o = arc(cx, yc, R, Math.PI / 2 + a0, Math.PI / 2 - a0, 24).map(([x, y]) => [x, y, z]);
        const i = arc(cx, yc, R + 0.08, Math.PI / 2 + a0, Math.PI / 2 - a0, 24).map(([x, y]) => [x, y, z]);
        kit.edge(o, false, 0.85);
        kit.line(i, false, 0.9);
        for (let k = 0; k <= 24; k += 3) kit.hseg(o[k], i[k], 0.8);
      }
      if (j < n - 1) kit.box(cx + span / 2, cx + span / 2 + pier, WATER, 0, -1, 1);
    }
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const px = sx * (L / 2 - 0.15), pz = sz * 0.75;
      kit.box(px - 0.15, px + 0.15, DECK, DECK + 0.6, pz - 0.15, pz + 0.15);
      kit.seg([px, DECK + 0.6, pz], [px, DECK + 1.1, pz], 0.9);
    }
    for (const x of [-3.2, -1.07, 1.07, 3.2]) for (const z of [-0.95, 0.95]) {
      kit.seg([x, DECK, z], [x, 0.5, z], 0.8);
      kit.lamp(x, 0.5, z, 0.5, { water: WATER, intensity: 0.8 });
    }
  }
  kit.pop();

  // The Trocadero basin below the eye: a low terrace, its outline, twelve jets and six lamps.
  {
    const [bx0, bx1] = xr(-9.5, -1.5);
    kit.box(bx0, bx1, QUAI, 0.05, 24, 31, 20, { dark: 0.009, edges: false });
    kit.hairline([[bx0, 0.05, 24], [bx1, 0.05, 24], [bx1, 0.05, 31], [bx0, 0.05, 31]], true, 0.8);
    const [ox0, ox1] = xr(-8.5, -2.2);
    kit.line([[ox0, 0.06, 24.5], [ox1, 0.06, 24.5], [ox1, 0.06, 30.5], [ox0, 0.06, 30.5]], true, 0.8);
    kit.lit(() => {
      for (let i = 0; i < 12; i++) {
        const x = (-8 + i * 0.4) * s;
        kit.line(Array.from({ length: 10 }, (_, k) => { const t = k / 9; return [x, 0.08 + 1.2 * (1 - ((t - 0.5) / 0.5) ** 2), 30.5 - 6 * t]; }), false, 1);
      }
    });
    for (let i = 0; i < 6; i++) kit.lamp((-8.5 + i * 1.26) * s, 0.3, 24.2, 0.4, { intensity: 0.7 });
  }

  // A Bir-Hakeim-style viaduct standing in the river on the right: piers, arches, iron columns, a slab.
  kit.push(placed(8 * s, 17.5, s > 0 ? 0 : 180));
  {
    for (let i = 0; i < 7; i++) {
      const x = i * 1.4;
      kit.box(x - 0.3, x + 0.3, WATER, 0.4, -0.5, 0.5);
      if (i < 6) for (const z of [-0.46, 0.46]) kit.edge(Array.from({ length: 13 }, (_, k) => { const t = k / 12; return [x + 0.3 + 0.8 * t, 0.05 + 0.35 * Math.sin(Math.PI * t), z]; }), false, 0.85);
    }
    kit.box(-0.3, 8.7, 0.4, 0.55, -0.45, 0.45);
    for (let x = -0.15; x <= 8.6; x += 0.35) {
      kit.seg([x, 0.55, 0.36], [x, 1.05, 0.36], 0.85);
      if (x + 0.35 <= 8.6) { kit.hseg([x, 0.55, 0.36], [x + 0.35, 1.05, 0.36], 0.7); kit.hseg([x + 0.35, 0.55, 0.36], [x, 1.05, 0.36], 0.7); }
    }
    kit.box(-0.3, 8.7, 1.05, 1.15, -0.35, 0.35);
    for (let i = 0; i < 5; i++) { kit.seg([0.7 + i * 1.75, 0.55, 0.5], [0.7 + i * 1.75, 0.75, 0.5], 0.8); kit.lamp(0.7 + i * 1.75, 0.75, 0.5, 0.35, { water: WATER, intensity: 0.7 }); }
  }
  kit.pop();

  // The Champ de Mars beyond the tower: a lawn with cross paths and four rows of plane trees.
  {
    const [lx0, lx1] = xr(-13.5 - 5.75, -13.5 + 5.75);
    kit.line([[lx0, 0.01, -6], [lx1, 0.01, -6], [lx1, 0.01, -47], [lx0, 0.01, -47]], true, 0.7);
    for (const z of [-16, -26, -36]) kit.seg([lx0, 0.01, z], [lx1, 0.01, z], 0.7);
    for (const dx of [-6.9, -5.75, 5.75, 6.9]) for (let z = -7; z >= -47; z -= 1.6) {
      const x = TX + dx * s;
      if (kit.quiet(x, z)) continue;
      kit.seg([x, 0, z], [x, 0.5, z], 0.8);
      const r = 0.4 + (rnd() - 0.5) * 0.2;
      kit.hairline(Array.from({ length: 8 }, (_, k) => { const a = (k / 8) * Math.PI * 2, rr = r * (0.8 + 0.4 * rnd()); return [x + rr * Math.cos(a), 1.1 + 0.25 * Math.sin(a * 2 + k), z + rr * Math.sin(a)]; }), true, 0.8);
    }
    // The Ecole Militaire closes the vista.
    const [ex0, ex1] = xr(-18.5, -8.5);
    kit.box(ex0, ex1, 0, 1.5, -49.5, -48);
    kit.dome(TX, -48.75, 0.9, 0.5, 1.5, 1, 45);
  }

  // Quai Branly at true scale: a lit carpet of small roofs right of the tower.
  for (let x = -3; x < 22; ) {
    const w = 1 + rnd() * 0.6;
    const [x0, x1] = xr(x, x + w - 0.05);
    kit.haussmann(lot(x0, x1, -3, -1), 5 + Math.floor(rnd() * 2), rnd, { fh: 0.173, detail: 'far', fronts: [2], pLit: 0.12 });
    x += w;
  }

  // The far skyline on the fog-free class: Montparnasse, the Invalides, the Pantheon.
  {
    const mx = 28 * s, mz = -60, hw = 1.3, hd = 0.85, H = 11;
    const c = [[mx - hw, mz + hd], [mx + hw, mz + hd], [mx + hw, mz - hd], [mx - hw, mz - hd]];
    kit.farline(c.map(([x, z]) => [x, 0, z]), true, 0.6);
    kit.farline(c.map(([x, z]) => [x, H, z]), true, 0.6);
    for (const [x, z] of c) kit.farline([[x, 0, z], [x, H, z]], false, 0.6);
    const ix = 19 * s, iz = -45;
    kit.solid(new THREE.CylinderGeometry(1.4, 1.4, 1.2, 16, 1).translate(ix, 0.6, iz), 45);
    kit.solid(new THREE.SphereGeometry(1.4, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1.3, 1).translate(ix, 1.2, iz), 45);
    kit.seg([ix, 1.2 + 1.82, iz], [ix, 1.2 + 1.82 + 0.5, iz]);
    kit.farline([[ix - 1.4, 0, iz], [ix - 1.4, 1.2, iz], ...arc(ix, 1.2, 1.4, Math.PI, 0, 10).map(([x, y]) => [x, 1.2 + (y - 1.2) * 1.3, iz]), [ix + 1.4, 0, iz]], false, 0.6);
    kit.farline([[ix, 1.2 + 1.82, iz], [ix, 1.2 + 1.82 + 0.5, iz]], false, 0.6);
    const px = 34 * s, pz = -70;
    kit.farline([[px - 1.1, 0, pz], [px - 1.1, 1.3, pz], ...arc(px, 1.3, 1.1, Math.PI, 0, 10).map(([x, y]) => [x, 1.3 + (y - 1.3) * 1.2, pz]), [px + 1.1, 0, pz]], false, 0.6);
    kit.farline([[px, 1.3 + 1.32, pz], [px, 1.3 + 1.32 + 0.4, pz]], false, 0.6);
  }

  kit.finish();
  return {
    kit,
    get center() { return kit.phone ? 1 : 0.8; },
    frame: frameOf(kit, EYE, 2 * s, V(0, 6.8, 0), HW, [0.7, 2.0], V(-6 * s, 6.8, 0)),
    shot: { track: 1.2, push: 0.015 },
  };
}

/**
 * From the Pont des Arts looking east (1 u = 7.9 m): the two arms of the Pont Neuf either side of the
 * Vert-Galant's dark prow, the Conciergerie and Notre-Dame in the mist behind, and once in a long while a
 * bateau-mouche crossing with its lights in the water.
 */
function seineBridge(bg, flip) {
  const kit = new Kit(bg);
  const rnd = prng(flip ? 23 : 9);
  const s = flip ? -1 : 1;
  const xr = (a, b) => [Math.min(a * s, b * s), Math.max(a * s, b * s)];
  const WATER = -2, QUAI = -0.9, HW = 16;
  kit.view = { camX: 6.03 * s, camZ: 27.1, targetX: 1.5 * s, targetZ: -16, halfW: HW * 0.472 };
  kit.waterZ1 = 27;
  kit.atmos.uMist.value.set(0.55, 1.6, WATER, 6);
  kit.atmos.uHorizon.value.set(WATER, 8);

  kit.ground(400, WATER - 0.08, 0.006);
  kit.water(-45, 45, -40, 27, WATER);
  kit.mist(WATER, 4, -45, 45, -30, 27);
  // The banks: quai walls running away from the camera, lamps along each.
  for (const side of [-1, 1]) {
    const [x0, x1] = xr(16 * side, 18 * side);
    kit.box(x0, x1, WATER, QUAI, -45, 27, 20, { dark: true, edges: false });
    const xe = 16 * side * s;
    kit.edge([[xe, QUAI, -45], [xe, QUAI, 27]], false, 0.8);
    for (let z = -42; z <= -8; z += 5.7) {
      kit.seg([xe + 0.3 * side * s, QUAI, z], [xe + 0.3 * side * s, 0.1, z], 0.8);
      kit.lamp(xe + 0.3 * side * s, 0.2, z, 0.55, { water: WATER, intensity: 0.8 });
    }
    // Low 'far' roofs along each bank beyond the bridges.
    for (let z = -44; z < -22; ) {
      const d = 2 + rnd() * 1.5;
      const [bx0, bx1] = xr(18.2 * side, 21 * side);
      kit.haussmann(lot(bx0, bx1, z, z + d - 0.1), 5 + Math.floor(rnd() * 2), rnd, { base: QUAI, fh: 0.37, detail: 'far', fronts: side * s > 0 ? [3] : [1], pLit: 0.1 });
      z += d;
    }
  }

  // The Vert-Galant: the island's prow, a hair rim, willows and one lamp at the tip.
  {
    const w = (t) => 0.6 + 2.6 * Math.sqrt(t);
    const right = Array.from({ length: 7 }, (_, i) => { const t = i / 6; return [w(t), -10 - 20 * t]; });
    const left = right.map(([x, z]) => [-x, z]).reverse();
    const prow = [...right, ...left];
    kit.prism(prow, WATER, QUAI, 20, { dark: 0.008, edges: false });
    kit.hairline(prow.map(([x, z]) => [x, QUAI, z]), true, 0.8);
    for (let i = 0; i < 7; i++) {
      const t = 0.15 + 0.8 * rnd(), z = -10 - 20 * t, x = (rnd() - 0.5) * 1.4 * w(t);
      const h = 0.6 + 0.4 * rnd();
      kit.seg([x, QUAI, z], [x, QUAI + h, z], 0.8);
      for (let k = 0; k < 9; k++) {
        const a = (k / 9) * Math.PI * 2 + rnd() * 0.3, r = 0.5 + 0.3 * rnd();
        kit.hairline(Array.from({ length: 7 }, (_, j) => { const u = (j / 6) * (Math.PI / 2); return [x + Math.cos(a) * r * Math.sin(u), QUAI + h + r * 0.25 - r * (1 - Math.cos(u)), z + Math.sin(a) * r * Math.sin(u)]; }), false, 0.7);
      }
    }
    kit.seg([0, QUAI, -11], [0, 0.3, -11], 0.8);
    kit.lamp(0, 0.3, -11, 0.5, { water: WATER, intensity: 0.8 });
  }

  // One arm of the Pont Neuf, in local coordinates (x along the bridge, z across).
  const arm = (nArches, L, pier) => {
    const pitch = L / nArches, span = pitch - pier, R = span / 2, SPRING = -1.8, CROWN = SPRING + R, DECK = -0.55, PARAPET = -0.4, W = 1.4;
    kit.box(-L / 2, L / 2, CROWN + 0.02, DECK, -W, W);
    for (const z of [-W, W]) {
      kit.box(-L / 2, L / 2, DECK, PARAPET, z - 0.06, z + 0.06);
      kit.dashed([-L / 2, DECK - 0.1, z + 0.065], [L / 2, DECK - 0.1, z + 0.065], 0.07, 0.09, 'hair', 0.8);
    }
    for (let j = 0; j < nArches; j++) {
      const cx = -L / 2 + pitch * (j + 0.5);
      for (const z of [-W, W]) {
        const o = arc(cx, SPRING, R, Math.PI, 0, 24).map(([x, y]) => [x, y, z * 1.003]);
        const i = arc(cx, SPRING, R + 0.12, Math.PI, 0, 24).map(([x, y]) => [x, y, z * 1.003]);
        kit.edge(o, false, 0.85);
        kit.line(i, false, 0.9);
        for (let k = 0; k <= 24; k += 2) kit.hseg(o[k], i[k], 0.8);
      }
      for (const z of [-0.7, 0, 0.7]) kit.line(arc(cx, SPRING, R, Math.PI, 0, 24).map(([x, y]) => [x, y, z]), false, 0.7);
      if (j < nArches - 1) {
        const px = cx + span / 2 + pier / 2;
        kit.box(px - pier / 2, px + pier / 2, WATER, DECK, -W, W);
        for (const z of [-W, W]) {
          // Turrets on the pier heads, a lamp standard on each.
          kit.solid(new THREE.CylinderGeometry(0.5, 0.5, PARAPET + 0.08 - WATER, 12, 1).translate(px, (WATER + PARAPET + 0.08) / 2, z), 45);
          kit.solid(new THREE.CylinderGeometry(0.58, 0.58, 0.1, 12, 1).translate(px, PARAPET + 0.13, z), 45);
          kit.hairline(arc(px, z, 0.58, 0, Math.PI * 2, 12).map(([x, zz]) => [x, PARAPET + 0.18, zz]), true, 0.8);
          kit.seg([px, PARAPET + 0.18, z], [px, 0.45, z], 0.9);
          kit.seg([px - 0.25, 0.4, z], [px + 0.25, 0.4, z], 0.9);
          for (const dx of [-0.25, 0.25]) {
            kit.solid(new THREE.OctahedronGeometry(0.07).scale(1, 1.5, 1).translate(px + dx, 0.4, z), 45);
            kit.lamp(px + dx, 0.4, z, 0.55, { water: WATER, intensity: 0.8 });
          }
        }
      }
    }
  };
  kit.push(placed(-10 * s, -14, 10 * s));
  arm(7, 16, 0.5);
  kit.pop();
  kit.push(placed(10 * s, -16, -8 * s));
  arm(5, 13.4, 0.6);
  kit.pop();

  // The Conciergerie: a long body with four round towers and the Tour de l'Horloge at the east end.
  kit.push(placed(12 * s, -26, -8 * s));
  {
    const B = QUAI;
    kit.box(-4.5, 4.5, B, B + 2.6, -1.5, 1.5);
    for (const tx of [-3.6, -1.2, 1.2]) {
      kit.solid(new THREE.CylinderGeometry(0.6, 0.6, 4.2, 12, 1).translate(tx, B + 2.1, 1.2), 45);
      kit.solid(new THREE.ConeGeometry(0.7, 1.6, 12, 1).translate(tx, B + 4.2 + 0.8, 1.2), 45);
      kit.edge(arc(tx, 1.2, 0.7, 0, Math.PI * 2, 12).map(([x, z]) => [x, B + 4.2, z]), true, 0.85);
      for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; kit.seg([tx + 0.7 * Math.cos(a), B + 4.2, 1.2 + 0.7 * Math.sin(a)], [tx, B + 5.8, 1.2], 0.8); }
    }
    kit.box(3.5, 4.5, B, B + 5.2, 0.5, 1.5);
    kit.line(arc(4, B + 3.7, 0.3, 0, Math.PI * 2, 16).map(([x, y]) => [x, y, 1.504]), true, 0.9);
    for (const y of [B + 1.2, B + 1.9]) kit.hairline([[-4.5, y, 1.504], [3.5, y, 1.504]], false, 0.7);
  }
  kit.pop();

  // The island's quai of houses curving behind the prow.
  for (let i = 0; i <= 22; i++) {
    const a = i * 0.022;
    const x = (-16 + 60 * Math.sin(a)) * s, z = -34 + 60 * (1 - Math.cos(a));
    kit.push(placed(x, z, (-a * 180) / Math.PI * s));
    kit.haussmann(lot(-1.2, 1.2, -1.5, 1.5), 5 + Math.floor(rnd() * 3), rnd, { base: QUAI, fh: 0.37, detail: 'far', fronts: [2], pLit: 0.12 });
    kit.pop();
  }

  // Notre-Dame, simplified to what reads at 65 u: towers, rose, portals, roof, fleche, four buttress
  // arcs a side, the chevet. Its silhouette is repeated on the fog-free class so it survives the mist.
  kit.push(placed(19 * s, -42, -18 * s));
  {
    const B = QUAI, NW = 2.215, Z0 = -8.1, Z1 = 8.1;
    kit.box(-NW, NW, B, B + 4.43, Z0, Z1);
    kit.box(-3.05, 3.05, B, B + 2.4, Z0, 7.1);
    const roof = new THREE.Shape([new THREE.Vector2(-2.6, 4.43), new THREE.Vector2(2.6, 4.43), new THREE.Vector2(0, 5.44)]);
    kit.solid(new THREE.ExtrudeGeometry(roof, { depth: 15.2, bevelEnabled: false }).translate(0, B, Z0));
    kit.box(-3.3, 3.3, B, B + 4.43, -0.5, 1.7);
    const tr = new THREE.Shape([new THREE.Vector2(-1.1, 4.43), new THREE.Vector2(1.1, 4.43), new THREE.Vector2(0, 5.44)]);
    kit.solid(new THREE.ExtrudeGeometry(tr, { depth: 6.6, bevelEnabled: false }).rotateY(Math.PI / 2).translate(-3.3, B, 0.6));
    for (const tx of [-1.75, 1.75]) {
      kit.box(tx - 1, tx + 1, B, B + 8.73, 7.1, 9.1);
      for (const [nx, nz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const cx = tx + nx * 1.004, cz = 8.1 + nz * 1.004;
        kit.frameRect(kit.cls.fine, cx, cz, -nz, nx, 0.35, B + 6, B + 8.2, 0.85);
      }
      kit.hairline([[tx - 0.9, B + 8.83, 7.2], [tx + 0.9, B + 8.83, 7.2], [tx + 0.9, B + 8.83, 9], [tx - 0.9, B + 8.83, 9]], true, 0.8);
      for (const dx of [-0.6, 0.6]) kit.lamp(tx + dx, B + 0.3, 9.4, 0.3, { intensity: 0.7 });
    }
    kit.box(-0.75, 0.75, B, B + 5.7, 8.4, 9.1);
    kit.line(arc(0, B + 3.5, 0.61, 0, Math.PI * 2, 24).map(([x, y]) => [x, y, 9.104]), true, 0.9);
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI; kit.hseg([-0.61 * Math.cos(a), B + 3.5 - 0.61 * Math.sin(a), 9.104], [0.61 * Math.cos(a), B + 3.5 + 0.61 * Math.sin(a), 9.104], 0.8); }
    kit.lit(() => {
      for (const [px, hw, h] of [[0, 0.45, 1.6], [-1.75, 0.35, 1.3], [1.75, 0.35, 1.3]]) {
        const ys = B + h - hw * Math.SQRT2, z = 9.104;
        kit.edge([[px - hw, B, z], [px - hw, ys, z], ...arc(px + hw, ys, 2 * hw, Math.PI, Math.PI - Math.PI / 3, 8).map(([x, y]) => [x, y, z])], false, 0.9);
        kit.edge([[px + hw, B, z], [px + hw, ys, z], ...arc(px - hw, ys, 2 * hw, 0, Math.PI / 3, 8).map(([x, y]) => [x, y, z])], false, 0.9);
      }
    });
    kit.solid(new THREE.ConeGeometry(0.5, 6.7, 8, 1).translate(0, B + 5.44 + 3.35, 0.6), 45);
    kit.lit(() => { for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2 + Math.PI / 4; kit.edge([[0.5 * Math.cos(a), B + 5.44, 0.6 + 0.5 * Math.sin(a)], [0, B + 12.14, 0.6]], false, 0.9); } });
    kit.seg([0, B + 12.14, 0.6], [0, B + 12.44, 0.6], 1);
    kit.seg([-0.15, B + 12.3, 0.6], [0.15, B + 12.3, 0.6], 1);
    for (const sx of [-1, 1]) for (const z of [-6.5, -4, 2.5, 5]) {
      kit.line(Array.from({ length: 7 }, (_, j) => { const u = (j / 6) * (Math.PI / 2); return [sx * (2.55 + 0.75 * Math.sin(u)), B + 4.3 - 0.5 * (1 - Math.cos(u)), z]; }), false, 0.85);
      kit.box(sx * 3.3 - 0.15, sx * 3.3 + 0.15, B, B + 3.8, z - 0.15, z + 0.15);
    }
    kit.solid(new THREE.CylinderGeometry(2.55, 2.55, 4.43, 14, 1, false, Math.PI / 2, Math.PI).translate(0, B + 2.215, Z0), 45);
    kit.solid(new THREE.ConeGeometry(2.6, 1.01, 14, 1, false, Math.PI / 2, Math.PI).translate(0, B + 4.43 + 0.505, Z0), 45);
    for (const a of [Math.PI * 0.62, Math.PI * 0.87, Math.PI * 1.13, Math.PI * 1.38]) {
      const ux = Math.sin(a), uz = Math.cos(a);
      kit.line(Array.from({ length: 7 }, (_, j) => { const u = (j / 6) * (Math.PI / 2); const r = 2.55 + 0.75 * Math.sin(u); return [ux * r, B + 4.3 - 0.5 * (1 - Math.cos(u)), Z0 + uz * r]; }), false, 0.85);
      kit.box(ux * 3.3 - 0.15, ux * 3.3 + 0.15, B, B + 3.8, Z0 + uz * 3.3 - 0.15, Z0 + uz * 3.3 + 0.15);
    }
    kit.farline([[-2.75, B, 9.1], [-2.75, B + 8.73, 9.1], [-0.75, B + 8.73, 9.1], [-0.75, B + 5.7, 9.1], [0.75, B + 5.7, 9.1], [0.75, B + 8.73, 9.1], [2.75, B + 8.73, 9.1], [2.75, B, 9.1]], false, 0.7);
    kit.farline([[0, B + 5.44, 7.1], [0, B + 5.44, Z0]], false, 0.7);
    kit.farline([[-0.5, B + 5.44, 0.6], [0, B + 12.14, 0.6], [0.5, B + 5.44, 0.6]], false, 0.7);
  }
  kit.pop();

  // Far silhouettes: the Tour Saint-Jacques and the Pantheon's dome.
  {
    const jx = -9 * s, jz = -60, B = QUAI;
    kit.farline([[jx - 0.45, B, jz], [jx - 0.45, B + 6.6, jz], [jx + 0.45, B + 6.6, jz], [jx + 0.45, B, jz]], false, 0.6);
    for (const dx of [-0.45, -0.15, 0.15, 0.45]) kit.farline([[jx + dx, B + 6.6, jz], [jx + dx, B + 6.9, jz]], false, 0.6);
    const px = 30 * s, pz = -85, py = B + 3;
    kit.farline([[px - 1.6, py, pz], [px - 1.6, py + 1.8, pz], ...arc(px, py + 1.8, 1.6, Math.PI, 0, 10).map(([x, y]) => [x, py + 1.8 + (y - py - 1.8) * 1.2, pz]), [px + 1.6, py, pz]], false, 0.5);
    kit.farline([[px, py + 1.8 + 1.92, pz], [px, py + 1.8 + 2.5, pz]], false, 0.5);
  }

  // The bateau-mouche: a lit hull that crosses between the camera and the island every 200 s.
  if (!STILL) {
    const boat = kit.part();
    const BZ = 0; // its lane: between the camera and the island's tip
    boat.box(-3.8, 3.8, WATER + 0.05, WATER + 0.5, -0.9, 0.9, 20, { tone: 0.7 });
    boat.box(-3.3, 3, WATER + 0.5, WATER + 1.1, -0.75, 0.75, 20, { tone: 0.7 });
    for (let i = 0; i < 10; i++) for (const nz of [-1, 1]) boat.pane(-3 + i * 0.62, WATER + 0.8, nz * 0.75, 0.42, 0.32, 0, nz, 0.5, rnd());
    boat.lamp(3.8, WATER + 0.65, 0, 0.7, { water: WATER, intensity: 0.7 });
    boat.lamp(-0.2, WATER + 0.9, 0, 1.6, { intensity: 0.25 });
    boat.line([[-3.8, WATER + 0.02, 0.6], [-14, WATER + 0.02, 2.6]], false, 0.6);
    boat.line([[-3.8, WATER + 0.02, -0.6], [-14, WATER + 0.02, -2.6]], false, 0.6);
    boat.finish();
    const group = boat.root;
    group.position.z = BZ;
    const slots = [kit.lightSlot(), kit.lightSlot(), kit.lightSlot()];
    kit.animators.push((t) => {
      const x = (44 - 0.65 * ((t + 60) % 200)) * s;
      group.position.x = x;
      group.visible = x * s > -46;
      slots[0].set(x + 3.7 * s, WATER + 0.7, BZ, group.visible ? 0.7 : 0);
      slots[1].set(x, WATER + 0.9, BZ, group.visible ? 0.35 : 0);
      slots[2].set(x - 2.5 * s, WATER + 0.8, BZ, group.visible ? 0.3 : 0);
    });
    if (s < 0) group.rotation.y = Math.PI;
  }

  kit.finish();
  return {
    kit,
    get center() { return kit.phone ? 1 : 0.65; },
    frame: frameOf(kit, -0.4, 6 * s, V(1.5 * s, 0.3, -16), HW, [0.7, 2.2]),
    shot: { track: 0.5, push: 0.03 },
  };
}

/**
 * A Haussmann street plan seen from a sixth-floor zinc roof, looking north (1 u ~ 7 m): blocks two lots
 * deep around courtyards, two diagonal boulevards cut through them as lit trenches, chimney stacks along
 * every party wall, Sacre-Coeur on its butte right of the column, far silhouettes on the left.
 */
function rooftops(bg, flip) {
  const kit = new Kit(bg);
  const rnd = prng(flip ? 31 : 13);
  const s = flip ? -1 : 1;
  const HW = 15, EYE = 3.9;
  kit.view = { camX: 1.42 * s, camZ: 18.6, targetX: 0, targetZ: -22, halfW: HW * 0.472 };
  kit.waterZ1 = 18.6;
  kit.atmos.uMist.value.set(0.3, 1.2, 0, 8);
  kit.atmos.uHorizon.value.set(3, 13);
  kit.u.uWind.value.set(0.6 * s, 0.1);
  kit.smoke = true;
  kit.ground(400, -0.05);

  // The street plan: seven blocks of two lot rows about a courtyard, cross streets, two boulevards.
  // Boulevard A passes a unit left of the camera and recedes obliquely, so from the roof its trench is
  // seen into near the bottom-left and as a gap beyond; B crosses far behind the column (lamps only).
  const BW = 1.25; // boulevard half-width
  const bvds = [[[-1.6 * s, 12], [-22.1 * s, -56]], [[34 * s, 2], [-10 * s, -50]]].map(([p, q]) => {
    const dx = q[0] - p[0], dz = q[1] - p[1], L = Math.hypot(dx, dz);
    return { p, q, dx: dx / L, dz: dz / L, L, sd: (x, z) => ((x - p[0]) * -dz + (z - p[1]) * dx) / L };
  });
  const baseAt = (z) => 0.25 * clamp((4 - z) / 8.5, 0, 6.5);
  const D = (x, z) => Math.hypot(x - kit.view.camX, z - kit.view.camZ);
  let polys = 0;
  // Blocks -2 and -1 are under and just before the camera: it stands on a roof of block -2.
  for (let b = -2; b < 7; b++) {
    const zb = 4 - 8.5 * b, base = 0.25 * b;
    kit.box(-40, 40, base - 0.3, base, zb - 8.5, zb, 20, { dark: true, edges: false });
    kit.box(-40, 40, base, base + 0.02, zb - 4.2, zb - 3.2, 20, { dark: 0.006, edges: false });
    const half = 7 + 0.4 * (kit.view.camZ - zb + 4); // only lots that can be in the frame at this depth
    const streets = []; // cross-street edge x positions
    for (let x = -half + rnd() * 4; x < half; x += 9 + rnd() * 6) streets.push(x, x + 1.1);
    const fronts = (mx, mz, nx, nz) =>
      Math.abs(mz - zb) < 0.3 || Math.abs(mz - (zb - 7.4)) < 0.3 || streets.some((sx) => Math.abs(mx - sx) < 0.3) || bvds.some((bv) => Math.abs(bv.sd(mx, mz)) < BW + 0.45);
    for (const [z0, z1] of [[zb - 3.2, zb], [zb - 7.4, zb - 4.2]]) {
      for (let k = 0; k + 1 < streets.length + 1; k++) {
        const xa = k === 0 ? -half : streets[2 * k - 1], xb = k * 2 < streets.length ? streets[2 * k] : half;
        if (xb - xa < 1.8) continue;
        for (let x = xa; x < xb - 0.9; ) {
          const w = Math.min(2.2 + rnd() * 2.4, xb - x);
          if (rnd() > 0.1) {
            let poly = lot(x, x + w - 0.08, z0, z1);
            let fronting = false;
            for (const bv of bvds) {
              const d = poly.map(([px, pz]) => bv.sd(px, pz));
              const lo = Math.min(...d), hi = Math.max(...d);
              if (hi < -BW || lo > BW) continue; // clear of the boulevard
              if (hi < BW && lo > -BW) { poly = null; break; } // swallowed by it
              // Straddles: keep the side with more of the lot.
              const pos = d.filter((v) => v > 0).length >= d.length / 2;
              poly = clipPoly(poly, pos ? (px, pz) => bv.sd(px, pz) - BW : (px, pz) => -bv.sd(px, pz) - BW);
              fronting = true;
              if (poly.length < 3) { poly = null; break; }
              const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
              if (Math.max(...xs) - Math.min(...xs) < 0.9 || Math.max(...zs) - Math.min(...zs) < 0.9) { poly = null; break; }
            }
            if (poly) {
              if (fronting) poly = chamferCorner(poly, bvds, BW, 0.19);
              const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length, cz = poly.reduce((a, p) => a + p[1], 0) / poly.length;
              const dist = D(cx, cz);
              const r = rnd();
              kit.haussmann(poly, 5 + Math.floor(rnd() * 3), rnd, {
                base, detail: b < 0 ? 'mid' : dist < 22 ? 'near' : dist < 40 ? 'mid' : 'far', fronts, // b < 0: only roofs show
                roof: r < 0.72 ? 'mansard' : r < 0.92 && poly.length === 4 ? 'gable' : 'flat', pLit: dist < 22 ? 0.14 : 0.08,
              });
              polys++;
            }
          }
          x += w;
        }
      }
    }
  }

  // Boulevard A: lamps both sides and a wet ribbon; boulevard B: lamps only (its ribbon is behind the column).
  bvds.forEach((bv, i) => {
    const step = i === 0 ? 3.7 : 3.9, size = i === 0 ? 0.5 : 0.4;
    const nx = -bv.dz, nz = bv.dx; // across the boulevard
    for (let d = 1.5; d < bv.L; d += step) for (const side of [-1, 1]) {
      const x = bv.p[0] + bv.dx * d + nx * side * (BW - 0.25), z = bv.p[1] + bv.dz * d + nz * side * (BW - 0.25);
      if (kit.quiet(x, z) || z > 6) continue;
      const y = baseAt(z);
      kit.seg([x, y, z], [x, y + 0.9, z], 0.8);
      kit.lamp(x, y + 0.9, z, size, { intensity: 0.85 });
      kit.light(x, y + 0.9, z, 3, 0.5); // lights the facades either side for the bake
    }
    if (i === 0) kit.ribbon(Array.from({ length: 13 }, (_, k) => { const d = (bv.L * k) / 12; const z = bv.p[1] + bv.dz * d; return [bv.p[0] + bv.dx * d, baseAt(z) + 0.02, z]; }), 2 * BW, 1);
  });

  // Sacre-Coeur on the butte, drawn at half scale for its distance: a stepped hill with the stairs down
  // its south face, the portico, five domes and the campanile.
  kit.push(placed(21 * s, -66, 0));
  {
    for (const z of [1, -1, -3]) kit.hairline(Array.from({ length: 45 }, (_, i) => { const t = i / 44; return [-22 + 44 * t, 4.2 + 2.8 * Math.sin(Math.PI * t) ** 1.4, z]; }), false, 0.7);
    const steps = [[4, 4.9, 9], [4.9, 5.6, 6.2], [5.6, 6.3, 4.4], [6.3, 7, 2.6]];
    steps.forEach(([y0, y1, zf], i) => kit.box(-6 + i * 0.5, 6 - i * 0.5, y0, y1, -3.5 + i * 0.3, zf, 20, { dark: 0.007, edges: false }));
    kit.lit(() => {
      for (const [, y1, zf] of steps.slice(0, 3)) {
        kit.hairline([[-2, y1, zf], [2, y1, zf]], false, 0.8);
        for (let x = -2; x <= 2; x += 0.2) kit.hseg([x, y1, zf], [x, y1 - 0.7, zf + 1.8], 0.7);
      }
    });
    for (let i = 0; i < 6; i++) kit.lamp(0, 4.6 + i * 0.5, 9 - i * 1.3, 0.35, { intensity: 0.7 });
    for (const sx of [-3, 3]) for (let i = 0; i < 5; i++) kit.hairline(Array.from({ length: 7 }, (_, k) => { const a = (k / 7) * Math.PI * 2; return [sx + 0.5 * Math.cos(a), 5 + i * 0.45 + 0.6, 8.5 - i * 1.4 + 0.5 * Math.sin(a)]; }), true, 0.7);
    const Y = 7;
    kit.box(-3.2, 3.2, Y, Y + 1.8, -1.9, 1.9);
    kit.box(-2.6, 2.6, Y, Y + 1.3, 1.9, 2.6);
    kit.lit(() => { for (const x of [-1.4, 0, 1.4]) kit.edge([[x - 0.55, Y, 2.604], [x - 0.55, Y + 0.5, 2.604], ...arc(x, Y + 0.5, 0.55, Math.PI, 0, 10).map(([px, py]) => [px, py, 2.604]), [x + 0.55, Y, 2.604]], false, 0.9); });
    kit.hairline([[-2.6, Y + 1.4, 1.9], [2.6, Y + 1.4, 1.9], [2.6, Y + 1.4, 2.6], [-2.6, Y + 1.4, 2.6]], true, 0.8);
    for (const sx of [-2.3, 2.3]) kit.dome(sx, 1.6, 0.55, 0.5, Y + 1.8, 1.3, 45);
    for (const sx of [-2.6, 2.6]) kit.dome(sx, -0.4, 0.5, 0.45, Y + 1.8, 1.3, 45);
    kit.solid(new THREE.CylinderGeometry(1.5, 1.5, 1.6, 24, 1).translate(0, Y + 1.8 + 0.8, -0.2), 45);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2, x = 1.504 * Math.cos(a), z = -0.2 + 1.504 * Math.sin(a);
      kit.hseg([x, Y + 1.8, z], [x, Y + 3.4, z], 0.8);
      const a2 = a + Math.PI / 12, x2 = 1.504 * Math.cos(a2), z2 = -0.2 + 1.504 * Math.sin(a2);
      kit.line([[x2 - 0.12 * Math.sin(a2), Y + 2.2, z2 + 0.12 * Math.cos(a2)], [x2 - 0.12 * Math.sin(a2), Y + 2.9, z2 + 0.12 * Math.cos(a2)], [x2, Y + 3.05, z2], [x2 + 0.12 * Math.sin(a2), Y + 2.9, z2 - 0.12 * Math.cos(a2)], [x2 + 0.12 * Math.sin(a2), Y + 2.2, z2 - 0.12 * Math.cos(a2)]], false, 0.8);
    }
    kit.solid(new THREE.SphereGeometry(1.5, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1.35, 1).translate(0, Y + 3.4, -0.2), 45);
    kit.lit(() => {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        kit.edge(Array.from({ length: 7 }, (_, j) => { const u = (j / 6) * (Math.PI / 2); return [1.505 * Math.cos(a) * Math.cos(u), Y + 3.4 + 1.35 * 1.505 * Math.sin(u), -0.2 + 1.505 * Math.sin(a) * Math.cos(u)]; }), false, 0.9);
      }
      kit.solid(new THREE.CylinderGeometry(0.3, 0.3, 0.5, 12, 1).translate(0, Y + 3.4 + 1.35 * 1.5 + 0.25, -0.2), 45);
      const top = Y + 3.4 + 1.35 * 1.5 + 0.5;
      kit.edge([[0, top, -0.2], [0, top + 0.4, -0.2]], false, 1);
      kit.edge([[-0.12, top + 0.28, -0.2], [0.12, top + 0.28, -0.2]], false, 1);
    });
    kit.box(2.6, 3.6, Y, Y + 5.2, -2.2, -1.2);
    for (const [nx, nz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) for (const o of [-0.22, 0.22]) {
      const cx = 3.1 + nx * 0.504 + -nz * o, cz = -1.7 + nz * 0.504 + nx * o;
      kit.line([[cx, Y + 4.2, cz], ...arc(0, Y + 4.7, 0.12, Math.PI, 0, 6).map(([px, py]) => [cx + px * -nz, py, cz + px * nx])], false, 0.8);
    }
    kit.dome(3.1, -1.7, 0.4, 0.3, Y + 5.2, 1.3, 45);
  }
  kit.pop();

  // Far silhouettes on the left: Opera, Tour Saint-Jacques, Saint-Augustin.
  {
    const B = 3.6;
    const ox = -26 * s, oz = -66;
    kit.farline([[ox - 2.2, B, oz], [ox - 2.2, B + 2.4, oz], [ox - 1.2, B + 2.4, oz], [ox - 1.2, B + 3.2, oz], [ox + 1.2, B + 3.2, oz], [ox + 1.2, B + 2.4, oz], [ox + 2.2, B + 2.4, oz], [ox + 2.2, B, oz]], false, 0.55);
    kit.farline([[ox - 1, B + 3.2, oz], ...arc(ox, B + 3.2, 1, Math.PI, 0, 8).map(([x, y]) => [x, y, oz]), [ox + 1, B + 3.2, oz]], false, 0.55);
    const jx = -19 * s, jz = -70;
    kit.farline([[jx - 0.45, B, jz], [jx - 0.45, B + 6.6, jz], [jx + 0.45, B + 6.6, jz], [jx + 0.45, B, jz]], false, 0.6);
    for (const dx of [-0.45, -0.15, 0.15, 0.45]) kit.farline([[jx + dx, B + 6.6, jz], [jx + dx, B + 6.9, jz]], false, 0.6);
    const ax = -34 * s, az = -80;
    kit.farline([[ax - 1.3, B, az], [ax - 1.3, B + 2, az], ...arc(ax, B + 2, 1.3, Math.PI, 0, 8).map(([x, y]) => [x, B + 2 + (y - B - 2) * 1.3, az]), [ax + 1.3, B, az]], false, 0.5);
    kit.farline([[ax, B + 2 + 1.69, az], [ax, B + 2 + 2.3, az]], false, 0.5);
  }

  if (DEBUG) console.info(`rooftops: ${polys} lots`);
  kit.finish();
  return {
    kit,
    get center() { return kit.phone ? 1 : 0.6; },
    frame: frameOf(kit, EYE, 2 * s, V(0, 3.4, -22), HW, [0.85, 2.3]),
    shot: { track: 0, pan: 1.5 },
  };
}

/** Chamfer the lot corner where a boulevard edge meets a street edge (a pan coupe), if there is one. */
function chamferCorner(poly, bvds, BW, c) {
  const n = poly.length;
  const onBvd = (a, b) => bvds.some((bv) => Math.abs(bv.sd((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) < BW + 0.05);
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n], p = poly[i], next = poly[(i + 1) % n];
    const e0 = onBvd(prev, p), e1 = onBvd(p, next);
    if (e0 === e1) continue;
    const toward = (q) => { const ex = q[0] - p[0], ez = q[1] - p[1], L = Math.hypot(ex, ez) || 1; return L > 2 * c ? [p[0] + (ex / L) * c, p[1] + (ez / L) * c] : null; };
    const a = toward(prev), b = toward(next);
    if (!a || !b) continue;
    return [...poly.slice(0, i), a, b, ...poly.slice(i + 1)];
  }
  return poly;
}

export const SCENES = { eiffelTower, seineBridge, rooftops };
