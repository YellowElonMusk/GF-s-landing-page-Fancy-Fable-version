# Page-transition cases (js/pagebits.js)

Four regression guards for the things the pipeline must never do again: drop a navigation,
double-break on a rapid second click, strand text below the fold, or blow the frame budget.
They run against the lab page with the gstack browse tool; nothing here is linked from the site.

- Lab: `http://localhost:3000/dev/tx-lab?debug` (the `?debug` flag turns on `window.__pagebits`
  and the bottom-left strip). `__pagebits.counters` = `{ starts, ends, swaps, worst, frames, bits, glyphs, phase }`;
  `frames` and `worst` reset at the start of every transition. `__pagebits.state` is the live `S` (null when idle),
  `__pagebits.freeze(t)` stops the loop and paints the frame for time `t`, `__pagebits.thaw()` resumes.
- URLs: never `.html?debug`. `serve` 301-redirects `/x.html?q` to `/x` and drops the query, so `__pagebits` is
  undefined. Use `/?debug`, `/gallery?debug`, `/about?debug`, `/dev/tx-lab?debug`.
- The entrance effect runs on load; wait until `__pagebits.state === null` (about 1.5 s after load) before a case.
- `B="$HOME/.claude/skills/gstack/browse/dist/browse"`; `$B js "EXPR"` returns the value of ONE expression (a
  returned Promise is awaited, so wait with a `.then()` chain, not `await ...;` statements).
  Multi-line probes go in `dev/_probe.js` and run with `$B eval dev/_probe.js` (delete the probe afterwards).
  A probe that contains `await` is wrapped in an async function: its result must be `return`ed, a bare
  trailing expression prints nothing.
- Run each case at 1440x900 with DPR 1 and, where the daemon allows it, DPR 1.5.
- The strip's `slow 2500` / `fail` buttons monkeypatch `fetch` for the NEXT fetch the router makes: press
  before hovering a link and reload the lab between modes (the router caches pages it has fetched).

```
$B viewport 1440x900
$B goto http://localhost:3000/dev/tx-lab?debug
$B wait --networkidle
$B console --clear
$B js "new Promise(r => setTimeout(r, 2000)).then(() => String(__pagebits.state === null))"   # entrance over
```

## Case 1: rapid double click (one swap, one break-up)

Click gallery, then about 120 ms later. Expect exactly one swap (to about), the lab text breaks once,
`pagebits:start` and `pagebits:end` fire once each with outcome `done`.

```js
// dev/_probe.js
const c0 = { ...__pagebits.counters };
const ends = [];
addEventListener('pagebits:end', (e) => ends.push(e.detail.outcome));
let burns = 0; addEventListener('pageburn', () => burns++);
document.querySelector('header.site nav a[href$="gallery.html"]').click();
await new Promise((r) => setTimeout(r, 120));
document.querySelector('header.site nav a[href$="about.html"]').click();
await new Promise((r) => setTimeout(r, 2500));
const c = __pagebits.counters;
return JSON.stringify({
  pass: location.pathname.endsWith('about.html') && c.swaps - c0.swaps === 1 && !document.querySelector('.tx-hide')
    && document.querySelector('.pagebits').hidden && c.starts - c0.starts === 1 && burns === 1 && ends.join() === 'done',
  path: location.pathname, swaps: c.swaps - c0.swaps, starts: c.starts - c0.starts, burns, ends, txHide: document.querySelectorAll('.tx-hide').length,
});
```

`$B eval dev/_probe.js` -> `pass: true`. Also `$B console --errors` must be clean (ignore `ReadPixels` and the base44 401).

## Case 2: width resize 300 ms after the click (the navigation still lands)

```js
// dev/_probe.js  (run on the lab page; the resize itself is a separate $B call, see below)
addEventListener('pagebits:end', (e) => (window.__txEnd = e.detail), { once: true });
document.querySelector('header.site nav a[href$="gallery.html"]').click();
'clicked';
```

```
$B eval dev/_probe.js
sleep 0.3 && $B viewport 900x700
$B js "new Promise(r => setTimeout(r, 1000)).then(() => JSON.stringify({ path: location.pathname, txHide: document.querySelectorAll('.tx-hide').length, canvasHidden: document.querySelector('.pagebits').hidden, end: window.__txEnd }))"
$B viewport 1440x900
```

Expect `path` ends with `gallery.html`, `txHide: 0`, `canvasHidden: true`, `end.outcome` is `cancelled`
(the width change gave up the animation; the swap still happened plainly). If the shell `sleep` lands after the
swap (~450 ms) the outcome is still `cancelled` with the canvas hidden immediately; either is a pass.

## Case 3: scrolled gallery (nothing below the fold goes blank; landing follows the document)

Part A: from the gallery at scrollY 2400, click `.home`.

```
$B goto http://localhost:3000/gallery?debug
$B wait --networkidle
$B js "(scrollTo(0, 2400), new Promise(r => setTimeout(r, 300))).then(() => { document.querySelector('header.site .home').click(); return new Promise(r => setTimeout(r, 300)); }).then(() => JSON.stringify({ midScroll: scrollY, hiddenBelowFold: [...document.querySelectorAll('.tx-hide')].filter(el => el.getBoundingClientRect().top > innerHeight * 1.5).length }))"
$B js "new Promise(r => setTimeout(r, 2200)).then(() => JSON.stringify({ path: location.pathname, scrollY, txHide: document.querySelectorAll('.tx-hide').length }))"
```

Expect `hiddenBelowFold: 0` while the old page burns, then `scrollY: 0`, `txHide: 0`, `path` is `/` or `/index.html`.

Part B: into the gallery, scroll 300 px at swap+100 ms, freeze at swap+500 ms, and find a developing glyph's ink
300 px above its DOM position.

```js
// dev/_probe.js  (on http://localhost:3000/?debug, entrance over)
let shift;
addEventListener('pageshift', (e) => (shift = e.detail), { once: true });
document.querySelector('header.site nav a[href$="gallery.html"]').click();
while (!shift) await new Promise((r) => setTimeout(r, 10));
await new Promise((r) => setTimeout(r, 100));
scrollBy(0, 300);
await new Promise((r) => setTimeout(r, 400));
__pagebits.freeze(shift.swapAt + 500);
const S = __pagebits.state;
const t = shift.swapAt + 500;
const g = S.news.find((g) => { const l = (t - g.at) / __pagebits.develop(g); return l > 0.3 && l < 1 && g.top > 300 && g.w > 4; });
const canvas = document.querySelector('.pagebits');
// Backing px per CSS px of the canvas's own box (pagebits pins the box to backing / dpr; html's
// scrollbar-gutter makes documentElement.clientWidth the wrong denominator).
const dpr = canvas.width / canvas.getBoundingClientRect().width;
const ink = (x, y, w, h) => {
  const d = canvas.getContext('2d').getImageData(Math.round(x * dpr), Math.round(y * dpr), Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr))).data;
  let s = 0; for (let i = 3; i < d.length; i += 4) s += d[i]; return s;
};
const shifted = g ? ink(g.x, g.top - 300, g.w, g.h) : -1;
const r = g ? g.block.getBoundingClientRect() : null;
__pagebits.thaw();
return JSON.stringify({ pass: !!g && shifted > 0 && scrollY - S.scroll1 === 300, glyph: g && g.ch, shifted, scrollDelta: scrollY - S.scroll1, domTopNow: r && Math.round(r.top) });
```

Expect `pass: true`: ink is present at `(g.x, g.top - 300)`, i.e. the canvas glyph moved with the document. After
the end (`await 2000` then check) `document.querySelectorAll('.tx-hide').length === 0` and the DOM text sits where
the last canvas frame painted it.

## Case 4: performance, gallery -> home at 1440x900

```js
// dev/_probe.js  (on http://localhost:3000/gallery?debug, entrance over)
addEventListener('pagebits:end', (e) => (window.__txEnd = e.detail), { once: true });
document.querySelector('header.site .home').click();
await new Promise((r) => setTimeout(r, 2600));
const c = __pagebits.counters, e = window.__txEnd;
return JSON.stringify({ pass: c.worst < 50 && c.frames / (e.ms / 16.7) > 0.9, worst: +c.worst.toFixed(1), frames: c.frames, ms: Math.round(e.ms), ratio: +(c.frames / (e.ms / 16.7)).toFixed(2), bits: c.bits, glyphs: c.glyphs, dpr: devicePixelRatio });
```

Target: `worst` <= 10 ms (hard cap 16; the assertion's 50 ms bar only guards a stall), frame ratio > 0.9.

### Recorded numbers (filled in by the QA pass; step 12 tuning)

| run | DPR | worst frame ms | frames / expected | bits | glyphs | PACE |
|---|---|---|---|---|---|---|
| gallery -> home | 1 | | | | | 0.85 |
| gallery -> home | 1.5 | | | | | 0.85 |
| POST ms during navigation (backdrop) | 1.5 | | | | | |
| POST ms during scene change (backdrop) | 1.5 | | | | | |

## Case 5: the canvas box matches its backing store (no doubled text at the hand-off)

html has `scrollbar-gutter: stable`, so a fixed `width: 100%` canvas is narrower than `documentElement.clientWidth`
on a page without a scrollbar (1425 vs 1440 at 1440x900 with classic scrollbars). pagebits sizes the backing store
from html's box and pins the canvas's inline size to backing / dpr; a mismatch squeezes every glyph horizontally
and the last canvas frame no longer sits on the DOM text.

```js
// dev/_probe.js  (on http://localhost:3000/?debug, entrance over; freezes mid-develop, then thaws)
let shift;
addEventListener('pageshift', (e) => (shift = e.detail), { once: true });
document.querySelector('header.site nav a[href$="gallery.html"]').click();
while (!shift) await new Promise((r) => setTimeout(r, 10));
await new Promise((r) => setTimeout(r, 1000));
__pagebits.freeze(shift.swapAt + 1000);
const canvas = document.querySelector('.pagebits');
const box = canvas.getBoundingClientRect();
const html = document.documentElement.getBoundingClientRect();
const dpr = Math.min(devicePixelRatio, 2);
const g = __pagebits.state.news.find((g) => g.hero) ?? __pagebits.state.news[0];
const r = g.block.getBoundingClientRect();
__pagebits.thaw();
return JSON.stringify({
  pass: Math.abs(box.width * dpr - canvas.width) <= 1 && Math.abs(box.height * dpr - canvas.height) <= 1 && Math.abs(box.width - html.width) <= 1,
  backing: [canvas.width, canvas.height], box: [box.width, box.height], htmlW: html.width, clientWidth: document.documentElement.clientWidth,
  dpr, heroDomLeft: Math.round(r.left), heroCanvasX: Math.round(g.x),
});
```

Expect `pass: true` with `box[0] === htmlW` (1425 at 1440x900 with classic scrollbars, where `clientWidth` reads 1440).
Then a screenshot in the last ~120 ms before `endAt` must show a single copy of every line: no ghost offset that
grows toward the right edge.

## Extra checks that need no assertion

- `slow 2500` then click gallery: grains hover and slowly rise for ~2.5 s, no text is blank below the fold, the swap
  lands when the fetch does, `pagebits:end` is `done`.
- `fail` then click gallery, then click about within 1.5 s: no hard navigation to gallery; about loads normally.
- `fail` then click gallery and wait: the page hard-loads gallery (the only navigation in flight may fall back).
- Reduced motion (`$B` emulation or OS setting): plain swaps, no `.pagebits` canvas, no `pageburn`/`pageshift`.
- Back/Forward after a click: a dark frame bar rolls down once (only on history navigations) and the arcs mirror.
