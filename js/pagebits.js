// Page transitions: a reel change on an old projector.
//
// Leaving a page, a ragged elliptical burn front spreads from the clicked link: letters go soft (a
// half-resolution halation layer), flare white for a frame as the emulsion lifts, and shed irregular
// silver grains sized to their type. The grains drift like dust in the beam, then are drawn on
// wandering, mostly-one-way arcs with long-exposure streaks to the new page's text, which develops
// like a print in the tray: latent blur, rising density, a small print flash, focus snapping in, the
// h1 coming up last. The swap itself is one soft flash frame plus a light leak from the clicked side.
//
// The DOM text is never moved: the blocks that hold it go transparent (.tx-hide) and the effect is
// painted on a fixed canvas over them; at the end the canvas cross-fades out over the real text.
// draw() allocates nothing per frame.
import { PACE, ms, clamp01, easeOutCubic, easeOutQuad, easeFilm, speedFilm, announce } from './motion.js';

const ROOTS = 'main, footer.site';
const CELL = 12; // px of glyph ink per grain
// 'grain' = irregular silver specks (default); 'digits' = '0'/'1' in Geist Mono through the same halation/size/tint pipeline.
const BIT_STYLE = 'grain';

// Raw timings; every use goes through ms() so PACE scales the whole reel at once.
const SOFTEN = 180; // an old glyph loses focus
const BREAK = 160; // then lifts off as grain
const RIPPLE = 320; // the burn front crossing the page
const JITTER = 60;
const MIN_OUT = 520; // the outgoing effect always gets this long, however fast the fetch
const DEVELOP = 380; // a new glyph coming up
const DEVELOP_HERO = 520;
const LAND = 140; // a grain settling into its letter
const REVEAL = 120; // the canvas -> DOM cross-fade

const hash = (n) => {
  n = Math.imul(n ^ (n >>> 15), 739982445);
  n = Math.imul(n ^ (n >>> 12), 695872825);
  return (n ^ (n >>> 15)) >>> 0;
};
const rand = (n) => hash(n) / 4294967296;
const visible = (r, w, h, m) => r.width > 0 && r.bottom > -m && r.top < h + m && r.right > 0 && r.left < w;
const develop = (g) => ms(g.hero ? DEVELOP_HERO : DEVELOP);
const wait = (d) => new Promise((r) => setTimeout(r, d));

let canvas = null, ctx, soft, sampler, segmenter;
let G = null; // grain sprites for the current dpr
let dpr = 1;
let S = null; // the running transition
let raf = 0;
let serial = 0;
let nav = 0; // navigation id: only the newest one may swap
let FILTER_OK = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;

// Per-frame scratch: module floats instead of returned arrays.
let PX = 0, PY = 0, TX = 0, TY = 0, DX = 0, DY = 0, LAMP = 1, SY = 0;
let font = '', softFont = '', fill = '';
const useFont = (f) => { if (f !== font) ctx.font = font = f; };
const useSoftFont = (f) => { if (f !== softFont) soft.font = softFont = f; };
const useFill = (c) => { if (c !== fill) ctx.fillStyle = fill = c; };
const snap = (v) => Math.round(v * dpr) / dpr;
const BLUR = Array.from({ length: 26 }, (_, i) => `blur(${(i / 10).toFixed(1)}px)`);
const OPACITY = Array.from({ length: 33 }, (_, i) => (i / 32).toFixed(3));

// Long-exposure streaks: three classes of segments (x0 y0 x1 y1), stroked after the grains.
let CAP = 4096;
const SEG = [new Float32Array(4 * CAP), new Float32Array(4 * CAP), new Float32Array(4 * CAP)];
const segN = [0, 0, 0];
const STREAK_W = [3.5, 2, 1];
const STREAK_A = [0.04, 0.09, 0.16];

const DEBUG = (() => {
  try {
    return new URLSearchParams(location.search).has('debug') || !!localStorage.pagebitsDebug;
  } catch {
    return false;
  }
})();
const counters = { starts: 0, ends: 0, swaps: 0, worst: 0, frames: 0, bits: 0, glyphs: 0, phase: 'idle' };

function setup() {
  const c = document.createElement('canvas');
  c.className = 'pagebits';
  c.setAttribute('aria-hidden', 'true');
  c.hidden = true;
  ctx = c.getContext('2d');
  soft = document.createElement('canvas').getContext('2d');
  sampler = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx || !soft || !sampler) throw new Error('no 2d context');
  segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  sampler.font = '16px sans-serif';
  const t = sampler.measureText('Hg');
  if (!(t.fontBoundingBoxAscent > 0 || t.actualBoundingBoxAscent > 0)) throw new Error('no text metrics');
  document.documentElement.append(c);
  canvas = c;
}

// The viewport the glyph rects live in, in CSS px. html's scrollbar-gutter: stable reserves the classic
// scrollbar even on a page without one, so a fixed `width: 100%` canvas lays out at html's box (1425 at 1440),
// not at documentElement.clientWidth (1440); sizing the backing store from the latter squeezed every glyph
// by that ratio and doubled the text at the hand-off. Measure html's box and pin the canvas's CSS size to
// backing / dpr so one CSS px is exactly one unit of the dpr transform whatever `100%` resolves to.
const viewW = () => document.documentElement.getBoundingClientRect().width;
let VW = 0, VH = 0; // refreshed by resize(); read everywhere else (no layout reads in the frame loop)

function resize() {
  dpr = Math.min(devicePixelRatio, 2);
  VW = viewW();
  VH = innerHeight;
  canvas.width = Math.round(VW * dpr);
  canvas.height = Math.round(VH * dpr);
  canvas.style.width = canvas.width / dpr + 'px';
  canvas.style.height = canvas.height / dpr + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // The halation layer is a quarter of the pixels, in CSS-px coordinates.
  soft.canvas.width = Math.ceil(VW / 2);
  soft.canvas.height = Math.ceil(VH / 2);
  soft.setTransform(0.5, 0, 0, 0.5, 0, 0);
  soft.fillStyle = '#fff';
  font = softFont = fill = ''; // a buffer resize wipes context state
  G = grain(dpr);
}

/**
 * White grain sprites per size class (S, M, L) in six variants, dim and hot. White so the accent can
 * be applied at draw time through alpha (exact under 'lighter'). Cached per dpr, two entries at most.
 */
const grains = new Map();
function grain(dpr) {
  let g = grains.get(dpr);
  if (g) return g;
  if (grains.size >= 2) grains.delete(grains.keys().next().value);
  const digits = BIT_STYLE === 'digits';
  const R = [1.0, 1.5, 2.2].map((v) => v * dpr);
  const sides = R.map((r) => Math.ceil(r * (digits ? 9 : 7)));
  const make = (k, v, hot) => {
    const r = R[k], side = sides[k], c = side / 2;
    const cv = document.createElement('canvas');
    cv.width = cv.height = side;
    const x = cv.getContext('2d');
    const halo = x.createRadialGradient(c, c, 0, c, c, (hot ? 4 : 3.2) * r);
    halo.addColorStop(0, hot ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.32)');
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = halo;
    x.fillRect(0, 0, side, side);
    x.fillStyle = '#fff';
    x.globalAlpha = hot ? 1 : 0.95;
    if (digits) {
      x.font = `500 ${7 * r}px 'Geist Mono', ui-monospace, Menlo, monospace`;
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText(v & 1 ? '1' : '0', c, c);
    } else {
      const n = 3 + (hash(v * 31) % 3);
      for (let i = 0; i < n; i++) {
        x.beginPath();
        x.arc(c + (rand(v * 7 + i) - 0.5) * 1.2 * r, c + (rand(v * 13 + i) - 0.5) * 1.2 * r, (0.55 + 0.45 * rand(v * 31 + i)) * r, 0, 2 * Math.PI);
        x.fill();
      }
    }
    return cv;
  };
  const set = (hot) => R.map((_, k) => Array.from({ length: 6 }, (_, v) => make(k, v, hot)));
  g = { dim: set(false), hot: set(true), side: sides.map((s) => s / dpr) };
  grains.set(dpr, g);
  return g;
}

/** Luma of a CSS colour ('rgb(r g b)', 'rgb(r, g, b)' or '#hex'), 0..1. */
function luma(color) {
  let r, g, b;
  if (color[0] === '#') {
    const h = color.length < 7 ? color.slice(1).replace(/./g, '$&$&') : color.slice(1);
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else {
    const m = color.match(/[\d.]+/g);
    if (!m || m.length < 3) return 0.85;
    [r, g, b] = m.map(Number);
  }
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

const metricsCache = new Map();
function metrics(font) {
  let m = metricsCache.get(font);
  if (!m) {
    sampler.font = font;
    const t = sampler.measureText('Hg');
    const ascent = t.fontBoundingBoxAscent ?? t.actualBoundingBoxAscent * 1.15;
    const descent = t.fontBoundingBoxDescent ?? t.actualBoundingBoxDescent * 1.3;
    m = { ascent, height: ascent + descent };
    metricsCache.set(font, m);
  }
  return m;
}

/** Where a glyph's grains sit, relative to its pen position: the ink centroid of each ink-heavy cell. */
const cellsCache = new Map();
function glyphCells(font, ch) {
  const key = font + '\n' + ch;
  const hit = cellsCache.get(key);
  if (hit) return hit;
  const m = metrics(font);
  sampler.font = font;
  const w = Math.ceil(sampler.measureText(ch).width) + 4;
  const h = Math.ceil(m.height) + 4;
  if (sampler.canvas.width < w || sampler.canvas.height < h) {
    sampler.canvas.width = Math.max(w, sampler.canvas.width);
    sampler.canvas.height = Math.max(h, sampler.canvas.height);
  }
  sampler.clearRect(0, 0, w, h);
  sampler.font = font;
  sampler.fillStyle = '#000';
  sampler.fillText(ch, 2, 2 + m.ascent);
  const data = sampler.getImageData(0, 0, w, h).data;

  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3] >= 40) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  const cells = [];
  if (x1 >= 0) {
    const cols = Math.max(1, Math.round((x1 - x0 + 1) / CELL));
    const rows = Math.max(1, Math.round((y1 - y0 + 1) / CELL));
    const cw = (x1 - x0 + 1) / cols;
    const rh = (y1 - y0 + 1) / rows;
    const mass = new Float64Array(cols * rows), sx = new Float64Array(cols * rows), sy = new Float64Array(cols * rows);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const a = data[(y * w + x) * 4 + 3];
        if (!a) continue;
        const i = Math.min(cols - 1, Math.floor((x - x0) / cw)) + Math.min(rows - 1, Math.floor((y - y0) / rh)) * cols;
        mass[i] += a;
        sx[i] += a * x;
        sy[i] += a * y;
      }
    let max = 0;
    for (let i = 0; i < mass.length; i++) if (mass[i] > max) max = mass[i];
    mass.forEach((v, i) => {
      if (v >= max * 0.25) cells.push([sx[i] / v - 2, sy[i] / v - 2 - m.ascent]);
    });
  }
  const out = cells.length ? cells : [[(w - 4) / 2, m.height / 2 - m.ascent]];
  cellsCache.set(key, out);
  return out;
}

/** The nearest non-inline ancestor: where .tx-hide goes, so pseudo-elements and markers can be exempted. */
function blockOf(el, root) {
  let e = el;
  while (e !== root && e.parentElement && getComputedStyle(e).display === 'inline') e = e.parentElement;
  return e;
}

function widest(rects) {
  let best = null;
  for (let i = 0; i < rects.length; i++) if (rects[i].width > 0 && (!best || rects[i].width > best.width)) best = rects[i];
  return best;
}

/** Every grapheme under the roots within half a viewport of the fold, with font, colour, position and block. */
function collect(roots) {
  const vw = VW, vh = VH;
  const margin = 0.5 * vh;
  const range = document.createRange();
  const styles = new Map();
  const glyphs = [];
  let word = 0;
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      word++;
      if (!node.data.trim() || node.parentElement.closest('svg')) continue;
      range.selectNodeContents(node);
      if (!visible(range.getBoundingClientRect(), vw, vh, margin)) continue;
      const el = node.parentElement;
      let st = styles.get(el);
      if (st === undefined) {
        const cs = getComputedStyle(el);
        const px = parseFloat(cs.fontSize);
        st = cs.visibility !== 'visible' ? null : {
          font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
          color: cs.color,
          upper: cs.textTransform === 'uppercase',
          px,
          size: px < 17 ? 0 : px < 28 ? 1 : 2,
          hero: !!el.closest('main h1'),
          block: blockOf(el, root),
        };
        styles.set(el, st);
      }
      if (!st) continue;
      const m = metrics(st.font);
      for (const { segment, index } of segmenter.segment(node.data)) {
        if (!segment.trim()) {
          word++;
          continue;
        }
        range.setStart(node, index);
        range.setEnd(node, index + segment.length);
        const r = widest(range.getClientRects()); // one line box even at a soft wrap
        if (!r || !visible(r, vw, vh, margin)) continue;
        glyphs.push({
          ch: st.upper ? segment.toUpperCase() : segment,
          font: st.font,
          color: st.color,
          px: st.px,
          size: st.size,
          hero: st.hero,
          block: st.block,
          x: r.left,
          y: r.top + (r.height - m.height) / 2 + m.ascent, // baseline
          top: r.top,
          w: r.width,
          h: r.height,
          cx: r.left + r.width / 2,
          cy: r.top + r.height / 2,
          word,
          at: -Infinity,
        });
      }
    }
  }
  return glyphs.sort((a, b) => (a.font < b.font ? -1 : a.font > b.font ? 1 : 0));
}

function hideBlocks(glyphs) {
  for (const g of glyphs)
    if (!S.hidden.has(g.block)) {
      S.hidden.add(g.block);
      g.block.classList.add('tx-hide');
    }
}
function unhide() {
  for (const el of S.hidden) el.classList.remove('tx-hide');
  S.hidden.clear();
}

function bit(x, y, extra) {
  const seed = hash(++serial * 2654435761 + S.seed);
  const r = (seed % 1000) / 1000;
  const b = {
    x0: x, y0: y, ox: x, oy: y, tx: x, ty: y, bx: x, by: y, nx: 0, ny: 0,
    departAt: Infinity, dur: 1, bend: 0, flew: false, clone: false,
    seed, phi: (seed % 628) / 100, wamp: 5 + 7 * rand(seed * 3), wfreq: 2 * Math.PI * (1 + rand(seed * 5)),
    hot: r < 0.07, bright: r < 0.07 ? 1 : r < 0.32 ? 0.62 : 0.36,
    size: 0, variant: seed % 6, riseFrom: Infinity, g0: null, g1: null,
  };
  return extra ? Object.assign(b, extra) : b;
}

function fresh(meta) {
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e2e2e2';
  const vw = VW, vh = VH; // resize() has run
  const m = { kind: 'nav', dir: 0, ...meta };
  // Splice gradients, built once per transition and placed with setTransform.
  const leak = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  leak.addColorStop(0, 'rgba(255,255,255,.9)');
  leak.addColorStop(0.35, 'rgba(255,255,255,.35)');
  leak.addColorStop(1, 'rgba(255,255,255,0)');
  const bar = ctx.createLinearGradient(0, -1, 0, 1);
  bar.addColorStop(0, 'rgba(10,10,10,0)');
  bar.addColorStop(0.3, '#0a0a0a');
  bar.addColorStop(0.7, '#0a0a0a');
  bar.addColorStop(1, 'rgba(10,10,10,0)');
  if (DEBUG) counters.frames = counters.worst = 0;
  return {
    id: 0, t0: performance.now(), meta: m, entering: false,
    bits: [], olds: [], news: [], anims: [], roots: [], hidden: new Set(),
    swapped: false, cancelled: false, revealed: false,
    swapAt: Infinity, endAt: Infinity, heroAt: Infinity, imageEnd: 0, scroll1: 0,
    ox: vw / 2, oy: -0.3 * vh, side: 'top',
    accent, ink: luma(accent),
    seed: Math.floor(Math.random() * 1e9),
    bend: m.dir ? -m.dir : Math.random() < 0.5 ? 1 : -1, // forward and back mirror
    leak, bar,
  };
}

const wordCentres = (glyphs) => {
  const sums = new Map();
  for (const g of glyphs) {
    const s = sums.get(g.word) ?? [0, 0, 0];
    s[0] += g.cx; s[1] += g.cy; s[2]++;
    sums.set(g.word, s);
  }
  return new Map([...sums].map(([k, [x, y, n]]) => [k, [x / n, y / n]]));
};

/** The element to animate for an image: the figure's link wrapper when there is one (its stylesheet filter stays untouched). */
const imageTarget = (el) => el.closest('figure > a') ?? el;
const baseFilter = (el) => {
  const f = getComputedStyle(el).filter;
  return f === 'none' ? '' : f + ' ';
};

/** Pictures leave as prints pulled too early: soft and over-bright. */
function imagesOut(roots, far) {
  const vh = VH;
  let blurred = 0;
  for (const root of roots)
    for (const el of root.querySelectorAll('svg, img')) {
      const target = imageTarget(el);
      const r = target.getBoundingClientRect();
      const d = Math.hypot(r.left + r.width / 2 - S.ox, (r.top + r.height / 2 - S.oy) * 1.6) / far;
      const opts = { delay: ms(40 + d * 160), duration: ms(320), easing: 'cubic-bezier(.4,0,.8,.6)', fill: 'both' };
      if (blurred < 8 && r.bottom > -0.5 * vh && r.top < 1.5 * vh) {
        blurred++;
        const base = baseFilter(target);
        S.anims.push(target.animate([{ opacity: 1, filter: base + 'blur(0px) brightness(1)' }, { opacity: 0, filter: base + 'blur(5px) brightness(1.5)' }], opts));
      } else S.anims.push(target.animate([{ opacity: 1 }, { opacity: 0 }], opts));
    }
}

/** Pictures arrive as prints developing: dark and soft, then dense and sharp, top rows first. */
function imagesIn(roots) {
  const now = performance.now();
  const vh = VH;
  const blur = VW < 520 ? 'blur(4px)' : 'blur(6px)';
  let blurred = 0;
  for (const root of roots)
    for (const el of root.querySelectorAll('svg, img')) {
      const target = imageTarget(el);
      const r = target.getBoundingClientRect();
      const half = !!el.closest('footer.site');
      const opts = { delay: ms(120 + clamp01(r.top / vh) * 180), duration: ms(half ? 310 : 620), easing: 'cubic-bezier(.2,.6,.3,1)', fill: 'backwards' };
      if (blurred < 8 && r.bottom > -0.5 * vh && r.top < 1.5 * vh) {
        blurred++;
        const base = baseFilter(target);
        S.anims.push(target.animate([{ opacity: 0, filter: base + blur + ' brightness(.5) contrast(.8)' }, { opacity: 1, filter: base + 'blur(0px) brightness(1) contrast(1)' }], opts));
      } else S.anims.push(target.animate([{ opacity: 0 }, { opacity: 1 }], opts));
      if (S.entering) el.style.opacity = ''; // runPagebits hid it inline until the animation could take over
    }
  S.imageEnd = now + ms(120 + 180 + 620) + 16;
}

/** Burn the current page up, from what was clicked outward along a ragged elliptical front. */
function breakUp(source, roots) {
  const now = S.t0;
  const vw = VW, vh = VH;
  const r = source?.getBoundingClientRect();
  S.ox = r ? r.left + r.width / 2 : vw / 2;
  S.oy = r ? r.top + r.height / 2 : -0.3 * vh;
  S.side = r ? (S.ox < vw / 2 ? 'left' : 'right') : 'top';
  announce('pageburn', { x: clamp01(S.ox / vw), y: clamp01(S.oy / vh), kind: S.meta.kind ?? 'nav', dir: S.meta.dir ?? 0, t0: now });
  const glyphs = collect(roots);
  const centres = wordCentres(glyphs);
  let far = 1;
  for (const c of centres.values()) far = Math.max(far, Math.hypot(c[0] - S.ox, (c[1] - S.oy) * 1.6));
  for (const g of glyphs) {
    const c = centres.get(g.word);
    g.at = now + ms(SOFTEN) + (Math.hypot(c[0] - S.ox, (c[1] - S.oy) * 1.6) / far) * ms(RIPPLE) + rand(g.word + S.seed) * ms(JITTER);
    for (const [dx, dy] of glyphCells(g.font, g.ch)) S.bits.push(bit(g.x + dx, g.y + dy, { g0: g, size: g.size, riseFrom: g.at }));
  }
  S.olds = glyphs;
  imagesOut(roots, far);
  hideBlocks(glyphs);
  if (DEBUG) {
    counters.bits = S.bits.length;
    counters.glyphs = glyphs.length;
    counters.phase = 'burn';
  }
}

function growStreaks(bits) {
  while (4 * bits > CAP && CAP < 16384) {
    CAP *= 2;
    for (let k = 0; k < 3; k++) SEG[k] = new Float32Array(4 * CAP);
  }
}

/** The h1 lands last, on the beat the camera stops; body grains are hurried if they would be late. */
function heroPass(glyphs, moving, base) {
  let landBody = -Infinity, hasHero = false;
  for (const b of moving) {
    if (!b.g1) continue;
    if (b.g1.hero) hasHero = true;
    else landBody = Math.max(landBody, b.departAt + b.dur);
  }
  if (!hasHero) return;
  const heroAt = Math.min(base + ms(900), Math.max(base + ms(560), landBody + ms(140)));
  const limit = heroAt - ms(60);
  if (landBody > limit) {
    const k = (limit - base) / (landBody - base);
    for (const b of moving) if (b.g1 && !b.g1.hero) b.dur = Math.max(ms(240), Math.min(b.dur * k, limit - b.departAt));
  }
  for (const b of moving) {
    if (!b.g1?.hero) continue;
    if (!b.hot && (b.seed % 1000) / 1000 < 0.3) { // hero grains run hotter
      b.hot = true;
      b.bright = 1;
    }
    // Late in the beat, but never before the grain's own glyph has started breaking.
    b.departAt = Math.max(b.g0 ? b.g0.at + ms(BREAK) * 0.6 : -Infinity, base + ms(220) + rand(b.seed * 11) * ms(100));
    b.dur = Math.max(ms(200), heroAt - b.departAt);
  }
  for (const g of glyphs) if (g.hero) g.at = heroAt;
  S.heroAt = heroAt;
}

/** Shared tail of reform()/enter(): glyph timing, end time, images, the pageshift announcement. */
function land(glyphs, moving, base, kind) {
  heroPass(glyphs, moving, base);
  for (const b of moving) if (b.g1 && !b.g1.hero) b.g1.at = Math.max(b.g1.at, b.departAt + b.dur - ms(60)); // the letter comes up under its last grains
  let last = base;
  for (const g of glyphs) {
    if (!(g.at > -Infinity)) g.at = base + ms(400);
    last = Math.max(last, g.at);
  }
  if (!(S.heroAt < Infinity)) S.heroAt = last; // pages without an h1
  S.bits = moving;
  growStreaks(moving.length);
  imagesIn(S.roots);
  let end = Math.max(base + ms(760), S.imageEnd);
  for (const g of glyphs) end = Math.max(end, g.at + develop(g) + ms(REVEAL));
  for (const b of moving) if (!b.g1) end = Math.max(end, b.departAt + b.dur);
  S.endAt = end;
  if (DEBUG) {
    counters.bits = moving.length;
    counters.glyphs = glyphs.length;
    counters.phase = 'fly';
  }
  const vw = VW, vh = VH;
  announce('pageshift', {
    x: clamp01(S.ox / vw), y: clamp01(S.oy / vh), kind, dir: S.meta.dir ?? 0,
    t0: S.t0, swapAt: S.swapAt, heroAt: S.heroAt, endAt: S.endAt,
  });
}

/** Send the grains we have to the new page's glyphs. */
function reform(roots) {
  const now = performance.now();
  // The gutter keeps html's width stable across the swap; if it ever moved, re-pin the canvas before collecting.
  if (viewW() !== VW || innerHeight !== VH) resize();
  const vh = VH;
  const glyphs = collect(roots);
  S.swapped = true;
  S.swapAt = now;
  S.roots = roots;
  S.news = glyphs;
  S.scroll1 = scrollY; // after the router's scrollTo and keynav's restore(), both synchronous in the swap
  hideBlocks(glyphs);

  const targets = [];
  for (const g of glyphs) for (const [dx, dy] of glyphCells(g.font, g.ch)) targets.push({ g, x: g.x + dx, y: g.y + dy });

  // Map old grains onto targets in reading order, then untangle crossings with a few local swaps.
  const old = S.bits;
  const n = old.length;
  const m = targets.length;
  const pick = targets.map((_, i) => Math.min(n - 1, Math.floor(((i + 0.5) * n) / m)));
  if (n) {
    const cost = (b, t) => Math.hypot(old[b].x0 - targets[t].x, old[b].y0 - targets[t].y);
    for (let pass = 0; pass < 2; pass++)
      for (let a = 0; a < m; a++)
        for (let b = a + 1; b < Math.min(m, a + 10); b++)
          if (cost(pick[a], a) + cost(pick[b], b) > cost(pick[b], a) + cost(pick[a], b)) [pick[a], pick[b]] = [pick[b], pick[a]];
  }

  const used = new Set();
  const moving = [];
  for (let i = 0; i < m; i++) {
    const { g, x, y } = targets[i];
    let b;
    if (!n) b = bit(x, y, { clone: true, size: g.size, flew: true }); // nothing left the old page: develop in place
    else if (used.has(pick[i])) {
      const src = old[pick[i]];
      b = bit(src.x0, src.y0, { clone: true, size: g.size, phi: src.phi, riseFrom: src.riseFrom });
    } else {
      used.add(pick[i]);
      b = old[pick[i]];
    }
    b.g1 = g;
    b.tx = x;
    b.ty = y;
    moving.push(b);
  }

  const perWord = new Map();
  for (const b of moving) {
    const s = perWord.get(b.g1.word) ?? { top: Infinity, dist: 0, n: 0 };
    s.top = Math.min(s.top, b.g1.top);
    s.dist += Math.hypot(b.tx - b.x0, b.ty - b.y0);
    s.n++;
    perWord.set(b.g1.word, s);
  }
  for (const b of moving) {
    const w = b.g1.word;
    const s = perWord.get(w);
    const rw = rand(w + S.seed);
    const rb = b.hot ? 0 : rand(b.seed);
    const go = now + ms(30 + clamp01(s.top / vh) * 180 + rw * 50 + rb * 40);
    b.departAt = Math.max(b.g0 ? b.g0.at + ms(BREAK) * 0.6 : -Infinity, go);
    b.dur = ms(360 + Math.min(s.dist / s.n, 800) * 0.26 + rand(w * 3 + S.seed) * 80 + (rb - 0.5) * 30);
    if (b.hot) b.dur *= 0.85;
    // Most arcs bow with the direction of travel; 18% of words bow against it.
    const sign = rand(w * 11 + S.seed) < 0.82 ? 1 : -1;
    b.bend = S.bend * sign * (0.04 + rw * 0.18) + (rand(b.seed * 7) - 0.5) * 0.05;
  }
  // Grains with nowhere to go settle like dust.
  old.forEach((b, i) => {
    if (used.has(i)) return;
    b.g1 = null;
    b.departAt = Math.max(b.g0.at + ms(BREAK), now + rand(b.seed * 5) * ms(200));
    b.dur = ms(700);
    moving.push(b);
  });
  land(glyphs, moving, now, S.meta.kind);
}

/** First load: grain condenses inward from outside the frame onto the text. */
function enter(roots) {
  const now = performance.now();
  const vw = VW, vh = VH;
  const glyphs = collect(roots);
  S.entering = true;
  S.swapped = true;
  S.swapAt = now;
  S.roots = roots;
  S.news = glyphs;
  S.scroll1 = scrollY;
  S.ox = vw / 2;
  S.oy = 0.3 * vh;
  S.side = 'top';
  hideBlocks(glyphs);

  let minY = Infinity, maxY = -Infinity, left = Infinity, right = -Infinity;
  for (const g of glyphs) {
    minY = Math.min(minY, g.top); maxY = Math.max(maxY, g.top);
    left = Math.min(left, g.cx); right = Math.max(right, g.cx);
  }
  const cx = vw / 2, cy = 0.42 * vh;
  const moving = [];
  let i = 0;
  for (const g of glyphs) {
    const order = (0.85 * (g.top - minY)) / Math.max(1, maxY - minY) + (0.15 * (g.cx - left)) / Math.max(1, right - left);
    const rw = rand(g.word + S.seed);
    for (const [dx, dy] of glyphCells(g.font, g.ch)) {
      const tx = g.x + dx, ty = g.y + dy;
      const k = 1.6 + 0.5 * rand(g.word * 5 + i);
      const ox = cx + (tx - cx) * k + (rand(i * 3) - 0.5) * 80;
      const oy = cy + (ty - cy) * k + (rand(i * 7) - 0.5) * 60;
      const b = bit(ox, oy, { clone: true, size: g.size, flew: true, g1: g, tx, ty });
      b.departAt = now + ms(60) + order * ms(260) + rw * ms(40);
      b.dur = ms(520 + 380 * order) + rand(i * 13 + S.seed) * ms(60);
      // A slow vortex around the column's centre instead of the chord-based bend.
      b.bx = Math.max(-40, Math.min(vw + 40, (ox + tx) / 2 - (ty - cy) * 0.1 * S.bend));
      b.by = (oy + ty) / 2 + (tx - cx) * 0.1 * S.bend;
      normalOf(b);
      moving.push(b);
      i++;
    }
  }
  land(glyphs, moving, now, 'enter');
}

/** Unit normal to the chord, for the perpendicular wander. */
function normalOf(b) {
  const dxc = b.tx - b.ox, dyc = b.ty - b.oy;
  const chord = Math.max(1, Math.hypot(dxc, dyc));
  b.nx = -dyc / chord;
  b.ny = dxc / chord;
}

/** Dust in the projector heat: a slow wander and a slow rise, in CSS px. */
function drift(t, b) {
  const p = b.phi;
  DX = 1.4 * Math.sin(t / 310 + p) + 0.6 * Math.sin(t / 127 + 2 * p);
  DY = 1.1 * Math.sin(t / 430 + 1.7 * p) + 0.5 * Math.sin(t / 151 + p) - 0.006 * Math.max(0, t - b.riseFrom);
}

/** First flying frame: the arc starts where the grain actually is, and the control point follows. */
function takeOff(b, vw) {
  b.flew = true;
  drift(b.departAt, b);
  b.ox = b.x0 + DX;
  b.oy = b.y0 + DY;
  if (!b.g1) return;
  const dxc = b.tx - b.ox, dyc = b.ty - b.oy;
  b.bx = Math.max(-40, Math.min(vw + 40, (b.ox + b.tx) / 2 - dyc * b.bend));
  b.by = (b.oy + b.ty) / 2 + dxc * b.bend;
  normalOf(b);
}

/** Position on the arc at progress p (film easing), with the lateral wander; sy follows the document. */
function bez(b, p, sy) {
  const e = easeFilm(clamp01(p));
  const u = 1 - e;
  PX = u * u * b.ox + 2 * u * e * b.bx + e * e * b.tx;
  PY = u * u * b.oy + 2 * u * e * b.by + e * e * b.ty - sy * e;
  const w = Math.sin(Math.PI * e) * b.wamp * Math.sin(b.wfreq * e + b.phi);
  PX += b.nx * w;
  PY += b.ny * w;
}
function tangent(b, e) {
  TX = 2 * (1 - e) * (b.bx - b.ox) + 2 * e * (b.tx - b.bx);
  TY = 2 * (1 - e) * (b.by - b.oy) + 2 * e * (b.ty - b.by);
}

function put(k, x0, y0, x1, y1) {
  const buf = SEG[k], i = segN[k] * 4;
  buf[i] = x0; buf[i + 1] = y0; buf[i + 2] = x1; buf[i + 3] = y1;
  segN[k]++;
}
/** Four sub-steps of the recent path, longer where the grain is faster; a full buffer just skips. */
function streak(b, d, v) {
  const k = Math.min(1.6, Math.max(0.5, (b.dur * v) / 500));
  const step = 0.055 * k;
  const c1 = b.hot || b.bright >= 0.62, c2 = b.hot;
  if (segN[0] + 4 > CAP || (c1 && segN[1] + 4 > CAP) || (c2 && segN[2] + 4 > CAP)) return;
  bez(b, d - 4 * step, SY);
  let px = PX, py = PY;
  for (let j = 3; j >= 0; j--) {
    bez(b, d - j * step, SY);
    put(0, px, py, PX, PY);
    if (c1) put(1, px, py, PX, PY);
    if (c2) put(2, px, py, PX, PY);
    px = PX; py = PY;
  }
}

/** One grain. The accent is applied through alpha (white sprites under 'lighter'); a slow glint replaces the digit flip. */
function sprite(b, t, x, y, scale, alpha, stretch, c, s) {
  if (alpha <= 0.01) return;
  alpha *= (b.hot ? 0.6 + 0.4 * S.ink : S.ink) * (0.8 + 0.2 * Math.sin(t / 180 + b.phi)) * LAMP;
  if (alpha <= 0.01) return;
  const img = (b.hot ? G.hot : G.dim)[b.size][b.variant];
  const side = G.side[b.size] * scale;
  ctx.globalAlpha = alpha > 1 ? 1 : alpha;
  if (stretch > 1.05) {
    ctx.setTransform(dpr * c, dpr * s, -dpr * s, dpr * c, x * dpr, y * dpr);
    ctx.drawImage(img, (-side * stretch) / 2, -side / 2, side * stretch, side);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  } else ctx.drawImage(img, x - side / 2, y - side / 2, side, side);
}

function softText(g, alpha, y) {
  useSoftFont(g.font);
  soft.globalAlpha = alpha;
  soft.fillText(g.ch, g.x, y);
}

/** The splice: one soft flash frame, a light leak from the clicked side, and on Back/Forward the frame bar re-catching. */
function splice(t, vw, vh) {
  const since = t - S.swapAt;
  const f = since / ms(1000);
  if (f < 0.3) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (f < 0.04 ? (0.15 * f) / 0.04 : 0.15 * Math.exp(-(f - 0.04) / 0.09)) * LAMP;
    useFill('#fff');
    ctx.fillRect(0, 0, vw, vh);
  }
  const u = clamp01(since / ms(700));
  if (u < 1) {
    const E = easeOutCubic(u);
    const side = S.side;
    const cx = side === 'left' ? -40 + 120 * E : side === 'right' ? vw + 40 - 120 * E : vw / 2;
    const cy = side === 'top' ? -40 + 120 * E : S.oy;
    const R = 0.55 * vw;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.12 * Math.sin(Math.PI * u) ** 0.8 * S.ink * LAMP;
    ctx.setTransform(dpr * R, 0, 0, dpr * R, cx * dpr, cy * dpr);
    ctx.fillStyle = S.leak;
    fill = '';
    ctx.fillRect(-1, -1, 2, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  if (S.meta.kind === 'pop') {
    const v = clamp01((since - ms(60)) / ms(500));
    if (v > 0 && v < 1) {
      const yc = (-0.12 + 1.24 * easeOutQuad(v)) * vh;
      const H = 0.11 * vh;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.25 * Math.sqrt(Math.sin(Math.PI * v));
      ctx.setTransform(dpr, 0, 0, (dpr * H) / 2, 0, yc * dpr);
      ctx.fillStyle = S.bar;
      fill = '';
      ctx.fillRect(0, -1, vw, 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.1 * S.ink;
      useFill('#fff');
      ctx.fillRect(0, yc - H / 2, vw, 1);
    }
  }
}

/** One frame. Paint order: old glyphs, new glyphs, halation, grains, streaks, splice. */
function draw(t) {
  const vw = VW, vh = VH;
  const swapped = S.swapped;
  const accent = S.accent;
  SY = swapped ? scrollY - S.scroll1 : 0;
  LAMP = 1 + 0.02 * Math.sin((2 * Math.PI * 2.9 * t) / 1000) + 0.01 * Math.sin((2 * Math.PI * 6.8 * t) / 1000 + 1.3);
  if (S.entering) LAMP *= Math.min(1, (t - S.t0) / 400); // the lamp warming up
  ctx.clearRect(0, 0, vw, vh);
  soft.clearRect(0, 0, vw, vh);
  ctx.globalCompositeOperation = 'source-over';

  // Old glyphs: soften, then lift off as the accent with a silver flare.
  const olds = S.olds;
  for (let i = 0; i < olds.length; i++) {
    const g = olds[i];
    const l = (t - g.at) / ms(BREAK);
    if (l >= 1) continue;
    const s = clamp01((t - g.at) / ms(SOFTEN) + 1);
    useFont(g.font);
    if (s <= 0) {
      useFill(g.color);
      ctx.globalAlpha = 1;
      ctx.fillText(g.ch, g.x, g.y);
    } else if (l < 0) {
      useFill(g.color);
      ctx.globalAlpha = 1 - 0.55 * s;
      ctx.fillText(g.ch, g.x, g.y);
      softText(g, 0.9 * s, g.y);
    } else {
      useFill(accent);
      ctx.globalAlpha = 0.45 * (1 - l) * (1 - l);
      ctx.fillText(g.ch, g.x, g.y);
      softText(g, 0.9 * (1 - l), g.y);
      if (l < 0.15) {
        ctx.globalCompositeOperation = 'lighter';
        useFill('#fff');
        ctx.globalAlpha = 0.5 * Math.sin((Math.PI * l) / 0.15);
        ctx.fillText(g.ch, g.x, g.y);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  // New glyphs develop in document space: latent, rising density, a print flash, then their own colour.
  if (swapped) {
    const news = S.news;
    for (let i = 0; i < news.length; i++) {
      const g = news[i];
      const l = (t - g.at) / develop(g);
      if (l < 0) continue;
      const y = g.y - SY;
      useFont(g.font);
      if (l >= 1) {
        useFill(g.color);
        ctx.globalAlpha = 1;
        ctx.fillText(g.ch, g.x, y);
      } else if (l < 0.25) {
        softText(g, l / 0.25, y);
      } else if (l < 0.75) {
        const k = (l - 0.25) / 0.5;
        useFill(accent);
        ctx.globalAlpha = easeOutCubic(k);
        ctx.fillText(g.ch, g.x, y);
        softText(g, 1 - 0.75 * k, y);
        if (l >= 0.5 && l < 0.68) {
          ctx.globalCompositeOperation = 'lighter';
          useFill('#fff');
          ctx.globalAlpha = (g.hero ? 0.3 : 0.22) * Math.sin((Math.PI * (l - 0.5)) / 0.18);
          ctx.fillText(g.ch, g.x, y);
          ctx.globalCompositeOperation = 'source-over';
        }
      } else {
        const k = (l - 0.75) / 0.25;
        useFill(accent);
        ctx.globalAlpha = 1 - k;
        ctx.fillText(g.ch, g.x, y);
        useFill(g.color);
        ctx.globalAlpha = k;
        ctx.fillText(g.ch, g.x, y);
        softText(g, 0.25 * (1 - k), y);
      }
    }
  }

  // Halation: the soft layer, out of focus as the page burns, snapping back in after the swap.
  const blur = swapped ? 2.5 * (1 - easeOutCubic(clamp01((t - S.swapAt) / ms(700)))) : 1.5 + clamp01((t - S.t0) / ms(500));
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.min(1, S.ink * LAMP);
  ctx.imageSmoothingEnabled = true;
  if (FILTER_OK) ctx.filter = BLUR[Math.round(Math.min(2.5, blur) * 10)];
  ctx.drawImage(soft.canvas, 0, 0, vw, vh);
  if (FILTER_OK) ctx.filter = 'none';

  // Grains, additive so clusters glow; over the letters so a landing grain lights its letter.
  segN[0] = segN[1] = segN[2] = 0;
  const bits = S.bits;
  const entering = S.entering;
  for (let i = 0; i < bits.length; i++) {
    const b = bits[i];
    const born = b.g0 ? clamp01((t - b.g0.at) / ms(BREAK)) : 1;
    if (born <= 0) continue;
    if (!(swapped && t >= b.departAt)) {
      if (b.clone) continue;
      drift(t, b);
      sprite(b, t, snap(b.x0 + DX), snap(b.y0 + DY), 1.6 - 0.6 * easeOutCubic(born), b.bright * born, 1, 1, 0);
      continue;
    }
    if (!b.flew) takeOff(b, vw);
    const d = clamp01((t - b.departAt) / b.dur);
    let a = b.bright * born;
    if (!b.g1) {
      const s = (t - b.departAt) / 1000;
      sprite(b, t, b.ox + 8 * Math.sin(2 * Math.PI * s + b.phi), b.oy + 90 * s + 160 * s * s, 1, a * (1 - d) ** 1.2, 1, 1, 0);
      continue;
    }
    const landed = clamp01((t - b.g1.at) / ms(LAND));
    if (landed >= 1) continue;
    if (b.clone) a *= clamp01(d / 0.3);
    let scale = entering ? 1.9 - 0.9 * easeFilm(d) : 1;
    if (b.g1.hero) scale *= 1.25;
    scale *= 1 - 0.5 * landed;
    a *= 1 - landed;
    bez(b, d, SY);
    if (d >= 1) {
      sprite(b, t, snap(PX), snap(PY), scale, a, 1, 1, 0);
      continue;
    }
    const v = speedFilm(d);
    const x = PX, y = PY;
    if (v > 0.15) streak(b, d, v);
    tangent(b, easeFilm(d));
    const len = Math.hypot(TX, TY);
    const stretch = 1 + 1.4 * v;
    sprite(b, t, x, y, scale, (a * (0.7 + 0.5 * v)) / Math.sqrt(stretch), stretch, len > 1e-3 ? TX / len : 1, len > 1e-3 ? TY / len : 0);
  }

  // Streaks: wide and faint for everything, narrower and brighter for the bright and the hot.
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#fff';
  for (let k = 0; k < 3; k++) {
    const n = segN[k];
    if (!n) continue;
    const buf = SEG[k];
    ctx.lineWidth = STREAK_W[k];
    ctx.globalAlpha = STREAK_A[k] * (k === 2 ? 1 : S.ink) * LAMP;
    ctx.beginPath();
    for (let i = 0, e = n * 4; i < e; i += 4) {
      ctx.moveTo(buf[i], buf[i + 1]);
      ctx.lineTo(buf[i + 2], buf[i + 3]);
    }
    ctx.stroke();
  }

  if (swapped) splice(t, vw, vh);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

// A session gate for ctx.filter: if frames run slow, the bilinear upscale alone softens enough.
const DT = new Float32Array(10);
let dtI = 0, dtN = 0, lastT = 0;
function gate(t) {
  if (lastT) {
    const d = t - lastT;
    if (d < 250) {
      DT[dtI] = d;
      dtI = (dtI + 1) % 10;
      if (dtN < 10) dtN++;
      if (FILTER_OK && dtN === 10) {
        let sum = 0;
        for (let i = 0; i < 10; i++) sum += DT[i];
        if (sum / 10 > 24) FILTER_OK = false;
      }
    }
  }
  lastT = t;
}

function loop(t) {
  if (!S) return;
  if (S.swapped && t >= S.endAt) return finish('done');
  if (S.swapped && !S.revealed && t >= S.endAt - ms(REVEAL)) {
    // Hand-off: the DOM text comes back under the canvas text, then the canvas fades out.
    S.revealed = true;
    unhide();
    if (DEBUG) counters.phase = 'reveal';
  }
  if (S.revealed) canvas.style.opacity = OPACITY[Math.round((1 - clamp01((t - (S.endAt - ms(REVEAL))) / ms(REVEAL))) * 32)];
  gate(t);
  const a = DEBUG ? performance.now() : 0;
  draw(t);
  if (DEBUG) {
    counters.frames++;
    const d = performance.now() - a;
    if (d > counters.worst) counters.worst = d;
  }
  raf = requestAnimationFrame(loop);
}

/** End the transition for any reason: everything back to the DOM, canvas gone, one 'pagebits:end'. */
function settle(outcome) {
  if (!S) return;
  cancelAnimationFrame(raf);
  for (const a of S.anims) a.cancel();
  unhide();
  for (const el of document.querySelectorAll('.tx-hide')) el.classList.remove('tx-hide');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvas.hidden = true;
  canvas.style.opacity = '';
  lastT = 0;
  const done = S;
  S = null;
  if (DEBUG) {
    counters.ends++;
    counters.phase = 'idle';
  }
  announce('pagebits:end', { id: done.id, outcome, ms: performance.now() - done.t0 });
}
const finish = (outcome = 'done') => settle(outcome);

/** Give up on the animation: if the swap has landed, end now; if not, the grains hover and the swap lands plainly. */
function cancel() {
  if (!S) return;
  S.cancelled = true;
  if (S.swapped) settle('cancelled');
}

const enabled = () => canvas && !document.hidden;

/**
 * Run a page change. `ready` resolves to a function that swaps the DOM and returns the new roots;
 * `meta` = { from, to, dir, kind } from the router. The newest call always swaps; an older one that
 * is overtaken returns without swapping. Resolves once the swap has happened.
 */
export async function transition(source, ready, meta = {}) {
  const id = ++nav;
  if (!enabled()) {
    if (S) settle('cancelled');
    const swap = await ready;
    if (id === nav) swap();
    return;
  }
  let mine;
  if (S && !S.swapped) {
    // A second click before the swap: keep the hovering grains and retarget them later.
    mine = S;
    S.id = id;
    S.meta = { ...S.meta, ...meta };
    if (S.meta.dir) S.bend = -S.meta.dir;
    const r = source?.getBoundingClientRect();
    if (r) S.side = r.left + r.width / 2 < VW / 2 ? 'left' : 'right';
  } else {
    finish('superseded');
    resize(); // before fresh(): its default origin is the centre of the measured viewport
    S = fresh(meta);
    mine = S;
    S.id = id;
    canvas.hidden = false;
    breakUp(source, [...document.querySelectorAll(ROOTS)]);
    if (DEBUG) counters.starts++;
    announce('pagebits:start', { id, source, x: clamp01(S.ox / VW), y: clamp01(S.oy / VH) });
    draw(performance.now()); // painted in the same frame .tx-hide lands
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }
  let swap;
  try {
    [swap] = await Promise.all([ready, wait(ms(MIN_OUT))]);
  } catch (e) {
    if (id !== nav) return; // a newer navigation owns the page now
    if (S === mine) settle('failed');
    throw e;
  }
  if (id !== nav) return;
  const roots = swap();
  if (DEBUG) counters.swaps++;
  if (S === mine && !mine.cancelled) {
    reform(roots);
    draw(performance.now());
  } else settle('cancelled');
}

export function runPagebits() {
  const html = document.documentElement;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    html.classList.remove('entering');
    return;
  }
  try {
    setup();
  } catch (e) {
    // No Intl.Segmenter or no text metrics: every transition is a plain swap.
    canvas = null;
    html.classList.remove('entering');
    console.warn('pagebits: plain swaps only', e);
    return;
  }
  // A width or pixel-ratio change moves the text, so give up; a height-only change (mobile URL bar) just resizes
  // the buffers. Width is html's box, the same measure resize() sizes the canvas from.
  let w0 = viewW(), dpr0 = devicePixelRatio;
  addEventListener('resize', () => {
    const w = viewW();
    if (w !== w0 || devicePixelRatio !== dpr0) {
      w0 = w;
      dpr0 = devicePixelRatio;
      cancel();
    } else if (S) resize();
  });
  // rAF pauses while hidden; by the time we are back the swap has landed, so show the page as it is.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S?.swapped) finish('done');
  });
  document.fonts?.addEventListener('loadingdone', () => {
    metricsCache.clear();
    cellsCache.clear();
  });
  if (DEBUG)
    window.__pagebits = {
      get state() { return S; },
      counters, PACE, ms, develop,
      freeze(t) { cancelAnimationFrame(raf); if (S) draw(t ?? performance.now()); },
      thaw() { if (S) { cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); } },
    };

  // First visit: the page condenses out of grain.
  if (!html.classList.contains('entering')) return;
  const fonts = document.fonts
    ? Promise.all([document.fonts.load('600 44px Geist'), document.fonts.load("500 12px 'Geist Mono'")]).catch(() => {})
    : Promise.resolve();
  Promise.race([fonts, wait(1200)]).then(() => {
    if (!document.hidden && performance.now() < 2500 && !S) {
      const roots = [...document.querySelectorAll(ROOTS)];
      for (const r of roots) for (const el of r.querySelectorAll('svg, img')) el.style.opacity = '0';
      resize();
      S = fresh();
      canvas.hidden = false;
      announce('pagebits:start', { id: 0, source: null, x: 0.5, y: 0.3 });
      enter(roots);
      draw(performance.now());
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    }
    html.classList.remove('entering');
  });
}
