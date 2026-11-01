// The live 3D backdrop: wireframe Paris on a tripod that is not quite still. It is the same old
// projector as the page transition: every 20-40 s it hiccups (gate weave, a flicker, a soft frame,
// a tiny slip), a page move pulls it out of focus and smears the lamps along the direction of
// travel, and a scene change burns the frame through to the next one, silver specks drifting off.
//
//   , / .     previous / next scene      footer button    next scene      ?scene=N  pick one
import * as THREE from 'three';
import { SCENES } from './scenes.js';
import { accentNow } from './accent.js';
import { move, clamp01, easeOutCubic, smooth, PACE } from './motion.js';

const AUTO_NEXT = 45000; // move on to the next scene after this long
const DISSOLVE = 1500; // ms: the scene burns out
const RESOLVE = 2100; // ms: the next one develops
const HICCUP = 700; // ms: one projector hiccup
const untilHiccup = () => 20000 + Math.random() * 20000;
const SHIFT = 0.02; // the target plane trucks 2% of the frame width at a page swap
const COUNTER = 0.6; // the look point follows the eye this far, so the truck reads as a dolly, not a pan
const NO_SHOT = {}; // shared so a scene without a shot block costs no allocation per frame
const sstep = (a, b, x) => smooth(clamp01((x - a) / (b - a)));

const POST = `
  uniform sampler2D tScene; uniform vec2 uRes, uWind; uniform vec3 uBg, uInk;
  uniform float uTime, uProgress, uDir, uCell, uSeed, uWeave, uFlicker, uJump, uDefocus, uFlash, uMove, uGrain;
  varying vec2 vUv;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
  float hash1(float n){ return fract(sin(n) * 43758.5453); }
  float snoise(float x){ float i = floor(x), f = fract(x); return mix(hash1(i), hash1(i+1.0), f*f*(3.0-2.0*f)); }
  vec3 scene(vec2 uv){ return texture2D(tScene, clamp(uv, 0.0, 1.0)).rgb; }
  float inkOf(vec3 c){ return clamp(length(c - uBg) * 2.5, 0.0, 1.0); }
  float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
  vec3 soft(vec2 uv, float r){
    r = min(r, 2.5); if (r < 0.25) return scene(uv);
    vec2 px = r / uRes;
    vec3 c = scene(uv) * 2.0 + scene(uv + vec2(.7,.7)*px) + scene(uv + vec2(-.7,.7)*px) + scene(uv + vec2(.7,-.7)*px) + scene(uv + vec2(-.7,-.7)*px);
    float n = 6.0;
    if (r > 1.5) { c += scene(uv + vec2(px.x,0.)) + scene(uv - vec2(px.x,0.)) + scene(uv + vec2(0.,px.y)) + scene(uv - vec2(0.,px.y)); n = 10.0; }
    return c / n; }
  void main(){
    vec2 uv = vUv; float t = uTime; float p = uProgress;
    vec2 seed = vec2(hash1(uSeed), hash1(uSeed + 7.0)) * 0.6 + 0.2;
    // 1 gate weave: slow, continuous
    float wy = 0.7*sin(6.2832*1.4*t) + 0.3*sin(6.2832*3.7*t + 0.8);
    float wx = 0.5*sin(6.2832*0.9*t + 2.1) + 0.5*sin(6.2832*2.6*t);
    uv += vec2(wx * 0.6, wy * 1.4) * uWeave / uRes;
    // 2 frame slip
    uv.y += uJump;
    // 3 defocus: hiccups, the page burning, the reel burning
    vec3 col = soft(uv, uDefocus + 5.0 * p * p);
    // 4 long-exposure smear along the direction of travel (page change only)
    if (uMove > 0.0 && dot(uWind, uWind) > 1e-6) {
      vec3 acc = vec3(0.0); float ws = 0.0;
      for (int i = -4; i <= 4; i++) { float f = float(i) / 4.0; float wt = 1.0 - 0.6 * abs(f);
        acc += scene(uv + uWind * (0.016 * uMove * f)) * wt; ws += wt; }
      vec3 smear = acc / ws; float hot = smoothstep(0.25, 0.85, luma(smear));
      col = mix(col, smear, 0.55 * uMove) + smear * hot * (0.7 * uMove);
      col = uBg + (col - uBg) * (1.0 + 0.2 * uMove); }
    // 5 silver burn and develop, cell by cell (scene change)
    if (p > 0.0) {
      vec2 here = floor(gl_FragCoord.xy / uCell); float h0 = hash(here + uSeed);
      float front = smoothstep(0.0, 0.25, p * 1.3 - 0.35 * h0 - 0.5 * distance(vUv, seed));
      float ink0 = inkOf(col);
      col += uInk * (front * (1.0 - front) * 4.0) * 0.35 * ink0;                       // bright rim where the emulsion lifts
      col = mix(col, uBg, max(front * smoothstep(0.1, 0.5, ink0), smoothstep(0.2, 0.7, p)));
      // specks drift on their own heading (down-biased, +-35 deg), never in columns
      float ang = 1.5708 + (hash(here + 3.3) - 0.5) * 1.2;
      float fall = pow(clamp((p - 0.15) / 0.85, 0.0, 1.0), 2.0) * mix(0.4, 1.0, hash(here + 5.1)) * uRes.y * 0.12;
      vec2 from = gl_FragCoord.xy + vec2(cos(ang), sin(ang)) * fall * uDir;
      vec2 cell = floor(from / uCell), inCell = fract(from / uCell);
      vec2 base = cell * uCell / uRes, span = uCell / uRes;
      float ink = 0.0; vec3 tint = uInk;
      for (int i = 0; i < 5; i++) { vec2 o = i == 0 ? vec2(0.5) : vec2(i == 1 || i == 3 ? 0.2 : 0.8, i < 3 ? 0.2 : 0.8);
        vec3 c = scene(base + o * span); float d = inkOf(c); if (d > ink) { ink = d; tint = c; } }
      float hs = hash(cell + uSeed);
      float frontS = smoothstep(0.0, 0.25, p * 1.3 - 0.35 * hs - 0.5 * distance(base + 0.5 * span, seed));
      float shown = frontS * (1.0 - smoothstep(0.6 + 0.3 * hs, 0.85 + 0.15 * hs, p));
      vec2 c1 = vec2(hash(cell + 1.1), hash(cell + 2.2)) * 0.6 + 0.2, c2 = vec2(hash(cell + 3.3), hash(cell + 4.4)) * 0.6 + 0.2;
      float grow = 1.0 + 1.5 * clamp((p - 0.4) / 0.6, 0.0, 1.0);                       // specks soften as they drift
      float r1 = (0.12 + 0.14 * hash(cell + 5.5)) * grow, r2 = (0.08 + 0.10 * hash(cell + 6.6)) * grow;
      // (1 - smoothstep(lo, hi, d)) rather than smoothstep(hi, lo, d): reversed edges are undefined in GLSL ES
      float speck = (1.0 - smoothstep(r1 * 0.3, r1, distance(inCell, c1))) + 0.7 * (1.0 - smoothstep(r2 * 0.3, r2, distance(inCell, c2)));
      float shimmer = 0.6 + 0.4 * snoise(t * 9.0 + hs * 50.0);
      col = mix(col, mix(tint, uInk, 0.6), clamp(speck, 0.0, 1.0) * ink * shown * shimmer / grow); }
    // 6 lamp bloom at the reel change (page events flash on the pagebits canvas, never here)
    // Mostly a centred bloom with a weak flat lift, so the blank frame reads as a lamp, not two grey panels.
    float leak = uFlash * exp(-distance(vUv, seed) * 1.6);
    col += uInk * (uFlash * 0.10 + leak * 0.75);
    // 7 exposure flicker: smooth low-frequency noise, never a square wave
    float lamp = 1.0 + uFlicker * (0.10 * (snoise(t * 11.0) - 0.5) + 0.05 * (snoise(t * 3.3 + 9.0) - 0.5));
    col = uBg + (col - uBg) * lamp;
    // 8 grain so the post frame is never cleaner than the page around it. The CSS film layer is on
    // top of this canvas too, so this stays light: the burnt-out frame is only a touch coarser than
    // any other post frame (a steep ramp with p read as video snow on the blank lamp frame).
    // Hashed from uv, not gl_FragCoord: sin() of a six-figure argument streaks on some GPUs.
    col += (hash(vUv * 17.0 + fract(t) * 3.0) - 0.5) * (0.025 + 0.01 * p) * uGrain;
    // 9 black and white, always
    col = vec3(luma(col));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Renders the scene straight to screen, or through the effects pass when any effect is live. */
function postPass(renderer) {
  const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });
  const u = {
    tScene: { value: target.texture },
    uRes: { value: new THREE.Vector2() }, uWind: { value: new THREE.Vector2() },
    uBg: { value: new THREE.Color() }, uInk: { value: new THREE.Color() },
    uTime: { value: 0 }, uProgress: { value: 0 }, uDir: { value: 1 }, uCell: { value: 10 }, uSeed: { value: 0 },
    uWeave: { value: 0 }, uFlicker: { value: 0 }, uJump: { value: 0 }, uDefocus: { value: 0 },
    uFlash: { value: 0 }, uMove: { value: 0 }, uGrain: { value: 0 },
  };
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: u,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: POST,
      depthTest: false,
      depthWrite: false,
    }),
  );
  quad.frustumCulled = false;
  const screen = new THREE.Scene().add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const size = new THREE.Vector2();
  return {
    reseed: () => (u.uSeed.value = Math.random() * 100),
    render(scene, camera, fx) {
      // Idle is the common case: no quad, no target, the scene's own draw calls and nothing else.
      if (fx.progress <= 0.001 && fx.weave <= 0.001 && fx.flicker <= 0.001 && Math.abs(fx.jump) <= 0.001
        && fx.defocus <= 0.001 && fx.flash <= 0.001 && fx.move <= 0.001) return renderer.render(scene, camera);
      renderer.getDrawingBufferSize(size);
      if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      u.uRes.value.copy(size);
      u.uCell.value = Math.round(11 * renderer.getPixelRatio());
      u.uTime.value = fx.time;
      u.uProgress.value = fx.progress;
      u.uDir.value = fx.dir;
      u.uWeave.value = fx.weave;
      u.uFlicker.value = fx.flicker;
      u.uJump.value = fx.jump;
      u.uDefocus.value = fx.defocus;
      u.uFlash.value = fx.flash;
      u.uMove.value = fx.move;
      u.uWind.value.copy(fx.wind);
      u.uGrain.value = fx.grain;
      u.uBg.value.copy(fx.bg);
      u.uInk.value.copy(fx.ink);
      renderer.render(screen, cam);
    },
  };
}

export function start(canvas) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bg = new THREE.Color('#0a0a0a');
  const ink = new THREE.Color();
  const inkHot = new THREE.Color(); // the accent with the exposure bump; goes past 1.0 on purpose
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(bg, 1);
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 1500);

  const builders = Object.values(SCENES);
  const names = Object.keys(SCENES);
  const built = new Map();
  const build = (i, flip) => {
    const key = `${i}:${flip}`;
    if (!built.has(key)) built.set(key, builders[i](bg, flip));
    return built.get(key);
  };

  // A shuffled order that persists for the tab, so reloading carries on rather than restarting.
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('scenes') ?? 'null'); } catch {}
  const valid = Array.isArray(saved?.order) && saved.order.length === builders.length && builders.every((_, i) => saved.order.includes(i));
  const order = valid ? saved.order : builders.map((_, i) => i).sort(() => Math.random() - 0.5);
  let pos = valid && Number.isInteger(saved.pos) && saved.pos >= 0 && saved.pos < order.length ? saved.pos : 0;
  const params = new URLSearchParams(location.search);
  if (params.has('scene')) pos = Math.max(0, order.indexOf(Number(params.get('scene')) || 0));

  let current = build(order[pos], Math.random() < 0.5);
  const base = new THREE.Vector3();
  const target = new THREE.Vector3();
  const fogBase = { near: 12, far: 46 }; // the scene's own fog, recorded at layout; draw() contracts from here
  let truckK = 0; // world units of truck per unit of eye distance for a SHIFT of the target plane

  function layout() {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    target.copy(current.frame(camera, innerWidth));
    base.copy(camera.position);
    const fog = current.kit.scene.fog;
    if (fog) (fogBase.near = fog.near), (fogBase.far = fog.far);
    const hfov = 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
    truckK = (SHIFT * 2 * Math.tan(hfov / 2)) / (1 - COUNTER);
    canvas.style.setProperty('--center', String(current.center ?? 1));
    try { sessionStorage.setItem('scenes', JSON.stringify({ order, pos })); } catch {}
    dispatchEvent(new CustomEvent('scenechange', { detail: { name: names[order[pos]], n: pos + 1, of: order.length } }));
  }
  layout();
  addEventListener('resize', () => {
    layout();
    if (still) draw(performance.now()); // setSize cleared the canvas and no loop will repaint it
  });

  const post = still ? null : postPass(renderer);
  let change = null; // { step, at, swapped }: a scene change in progress
  let shift = null; // { t0, x, y, dir, swapAt, endAt }: a page move in progress
  let auto;
  let hiccupAt = performance.now() + untilHiccup();
  let amp = 0.65;

  const scheduleNext = () => {
    if (!still) auto = setTimeout(() => go(1), AUTO_NEXT);
  };
  const advance = (step) => {
    pos = (pos + step + order.length) % order.length;
    current = build(order[pos], Math.random() < 0.5);
    layout();
  };
  function go(step) {
    if (change) return;
    clearTimeout(auto);
    if (still) {
      advance(step);
      return draw(performance.now());
    }
    post.reseed();
    change = { step, at: performance.now(), swapped: false };
  }
  scheduleNext();

  addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === ',' || e.key === '.') {
      e.preventDefault();
      go(e.key === '.' ? 1 : -1);
    }
  });
  addEventListener('scenestep', () => go(1));

  // The page move: the backdrop follows the pagebits choreography by its timestamps. A scene change
  // in progress ignores it, and a page move pushes the auto-advance back so the two never collide.
  addEventListener('pageburn', (e) => {
    if (change) return;
    const d = e.detail ?? {};
    const t0 = d.t0 ?? performance.now();
    shift = { t0, x: clamp01(d.x ?? 0.5), y: 1 - clamp01(d.y ?? 0.3), dir: d.dir ?? 0, swapAt: Infinity, endAt: t0 + 1500 };
    clearTimeout(auto);
    scheduleNext();
  });
  addEventListener('pageshift', (e) => {
    if (change) return;
    const d = e.detail ?? {}; // a plain Event from an older pagebits has no detail
    const now = performance.now();
    shift ??= { t0: d.t0 ?? now, x: clamp01(d.x ?? 0.5), y: 1 - clamp01(d.y ?? 0.3), dir: d.dir ?? 0 };
    shift.swapAt = d.swapAt ?? now;
    shift.endAt = d.endAt ?? shift.swapAt + 700;
  });
  addEventListener('pagebits:end', (e) => {
    if (shift && e.detail?.outcome !== 'done') shift.endAt = Math.min(shift.endAt, performance.now() + 300);
  });
  // three.js loads lazily, so the first page move may already be running: join it.
  const m = move.current;
  const now0 = performance.now();
  if (!still && m?.t0 && now0 < (m.endAt ?? now0 + 1500)) {
    shift = { t0: m.t0, x: clamp01(m.x ?? 0.5), y: 1 - clamp01(m.y ?? 0.3), dir: m.dir ?? 0, swapAt: m.swapAt ?? Infinity, endAt: m.endAt ?? m.t0 + 1500 };
  }

  const offset = new THREE.Vector3();
  const side = new THREE.Vector3();
  const look = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  // One effects record, mutated in place: draw() allocates nothing.
  const fx = { time: 0, progress: 0, dir: 1, weave: 0, flicker: 0, jump: 0, defocus: 0, flash: 0, move: 0, wind: new THREE.Vector2(), grain: 0, bg, ink: inkHot };
  let last = -Infinity;

  function draw(t) {
    const a = accentNow();
    ink.setRGB(a[0], a[1], a[2], THREE.SRGBColorSpace);
    if (still) {
      current.kit.tick(ink, t / 1000);
      renderer.render(current.kit.scene, camera);
      return;
    }

    // Scene change first, so the frame that swaps already frames and ticks the new scene.
    // Burn out with a late lamp bloom, swap on the blank frame, develop the next one.
    let p = 0, dir = 1, flash = 0;
    if (change) {
      const out = (t - change.at) / DISSOLVE;
      if (out < 1) p = smooth(out) ** 1.25;
      else {
        if (!change.swapped) {
          advance(change.step);
          post.reseed();
          change.swapped = true;
        }
        const back = (t - change.at - DISSOLVE) / RESOLVE;
        if (back < 1) (p = (1 - back) ** 3), (dir = -1);
        else (change = null), scheduleNext();
      }
      if (change) flash = Math.max(0, (p - 0.75) / 0.25) ** 2 * (dir > 0 ? 0.6 : 0.35);
    }

    // The shot: a slow track and push, a slow pan, and the tripod's own sub-degree settle.
    const shot = current.shot ?? NO_SHOT;
    const track = shot.track ?? 0, push = shot.push ?? 0, pan = shot.pan ?? 0;
    const settle = ((shot.settle ?? 0.3) * Math.PI) / 180;
    offset.copy(base).sub(target);
    side.crossVectors(UP, offset).normalize();
    const tr = track * Math.sin((t / 60000) * Math.PI * 2);
    offset.multiplyScalar(1 - push * (0.5 - 0.5 * Math.cos((t / 90000) * Math.PI * 2)));
    const yaw = ((pan * Math.PI) / 180) * Math.sin((t / 80000) * Math.PI * 2)
      + settle * 0.5 * (Math.sin((t / 23000) * 2 * Math.PI) + 0.6 * Math.sin((t / 37000) * 2 * Math.PI + 1) + 0.4 * Math.sin((t / 51000) * 2 * Math.PI + 2));
    const pitch = settle * 0.5 * (Math.sin((t / 29000) * 2 * Math.PI + 0.7) + 0.6 * Math.sin((t / 43000) * 2 * Math.PI + 2));
    offset.applyAxisAngle(side, -pitch);

    // The page move: b rises to 1 at the swap and is back to 0 by endAt, so nothing accumulates.
    let b = 0, defocus = 0, weave = 0, flicker = 0, grain = 0, moveAmt = 0, windX = 0, jump = 0;
    if (shift && t >= shift.endAt) shift = null;
    if (shift) {
      const pre = t < shift.swapAt;
      let s;
      if (pre) {
        const u = clamp01((t - shift.t0) / (520 * PACE));
        s = 0.5 * u * u; // accelerate, then coast at the peak while a slow fetch finishes
      } else {
        const D = Math.max(300, shift.endAt - shift.swapAt);
        s = 0.5 + 0.5 * easeOutCubic(clamp01((t - shift.swapAt) / D));
      }
      b = Math.sin(Math.PI * s);
      defocus = pre ? 2 * smooth(clamp01((t - shift.t0) / 400)) : 2 * (1 - easeOutCubic(clamp01((t - shift.swapAt) / 500)));
      weave = 0.5 * (pre ? 1 : 1 - clamp01((t - shift.swapAt) / 600));
      flicker = weave;
      grain = 0.2 + 0.6 * b;
      moveAmt = pre || change ? 0 : b; // the smear never overlaps a scene burn
      windX = -shift.dir;
      if (moveAmt > 0) defocus = Math.min(defocus, 1.5);
    }

    // Camera: the shot's track moves eye and look together; the page truck moves the eye by
    // `lateral` and the look by COUNTER of it, so the target plane shifts SHIFT of the width.
    const lateral = (shift ? shift.dir : 0) * truckK * offset.length() * b;
    look.copy(target).addScaledVector(side, tr + lateral * COUNTER);
    camera.position.copy(target).addScaledVector(side, tr + lateral).add(offset);
    camera.lookAt(look);
    camera.rotateY(yaw);

    // Fog pulls in and the lamp runs hot while the page moves; the scene reads both at tick.
    const fog = current.kit.scene.fog;
    if (fog) (fog.near = fogBase.near * (1 - 0.35 * b)), (fog.far = fogBase.far * (1 - 0.25 * b));
    inkHot.copy(ink).multiplyScalar(1 + 0.3 * b);
    current.kit.tick(inkHot, t / 1000);

    // Hiccup: the gate weaves, the lamp flickers, focus drifts, and the frame slips a hair and rings back.
    const gp = (t - hiccupAt) / HICCUP;
    if (gp >= 0 && gp < 1) {
      const sp = Math.sin(Math.PI * gp);
      weave += amp * Math.sqrt(sp);
      flicker += amp * (0.5 + 0.5 * sp);
      defocus += amp * 1.5 * sp;
      jump = amp * 0.02 * Math.exp(-9 * gp) * Math.cos(20 * gp) * (1 - sstep(0.6, 1, gp));
    } else if (gp >= 1) (hiccupAt = t + untilHiccup()), (amp = 0.45 + Math.random() * 0.4);

    // A reel change runs the projector rough the whole way through.
    if (change) (weave = 0.6), (flicker = 0.7), (grain = 1);

    fx.time = (t / 1000) % 3600; // 3600 s is a whole number of periods for every weave sine
    fx.progress = p;
    fx.dir = dir;
    fx.weave = weave;
    fx.flicker = flicker;
    fx.jump = jump;
    fx.defocus = defocus;
    fx.flash = flash;
    fx.move = moveAmt;
    fx.wind.set(windX, 0);
    fx.grain = grain;
    post.render(current.kit.scene, camera, fx);
  }

  function frame(t) {
    // 30fps is plenty for something this slow, and halves the GPU cost.
    if (t - last >= 1000 / 30 - 2) {
      last = t;
      draw(t);
    }
    requestAnimationFrame(frame);
  }
  if (still) {
    draw(performance.now());
    document.fonts?.ready.then(() => draw(performance.now()));
  } else {
    // Link every program now, so the first page move or hiccup never stalls on a shader compile.
    const a = accentNow();
    ink.setRGB(a[0], a[1], a[2], THREE.SRGBColorSpace);
    current.kit.tick(ink, 0);
    renderer.compile(current.kit.scene, camera);
    fx.defocus = 0.002; // just past the direct-path gate, under soft()'s 0.25 px floor: a plain frame through POST
    post.render(current.kit.scene, camera, fx);
    fx.defocus = 0;
    requestAnimationFrame(frame);
  }
}
