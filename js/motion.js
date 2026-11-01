// Shared tempo, easing and the page-move protocol used by pagebits.js, router.js and backdrop.js.
//
// PACE scales every transition duration at once (0.85 = a touch brisker than the raw timings).
// The easings are the "film" curves: a slow, heavy start, a peak at 35% and a long settle.

export const PACE = 0.85;
export const ms = (v) => v * PACE;

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeOutCubic = (u) => 1 - (1 - u) ** 3;
export const easeOutQuad = (u) => 1 - (1 - u) ** 2;
export const smooth = (x) => x * x * (3 - 2 * x);

// Position along a flight, 0..1. C1-continuous at p = 0.35 (both slopes 3.231).
export const easeFilm = (p) =>
  p < 0.35 ? 0.3 * (p / 0.35) ** 3.77 : 0.3 + 0.7 * (1 - (1 - (p - 0.35) / 0.65) ** 3);
// Its derivative, normalised so the peak (at p = 0.35) is 1. Drives streak length and sprite stretch.
export const speedFilm = (p) =>
  p <= 0 || p >= 1 ? 0 : p < 0.35 ? (p / 0.35) ** 2.77 : (1 - (p - 0.35) / 0.65) ** 2;

// The page move in progress, so a module that boots mid-transition (three.js loads lazily) can join it.
export const move = { current: null };

/** Dispatch a page-move event on window and keep `move.current` up to date. */
export function announce(name, detail) {
  move.current = name === 'pagebits:end' ? null : { ...(move.current ?? {}), ...detail };
  dispatchEvent(new CustomEvent(name, { detail }));
}

const slug = (p) => p.replace(/(index)?\.html$/, '').replace(/\/$/, '');

/** The site's page order, read from the header so it never goes stale: ['', '/gallery', '/about']. */
export function pageOrder() {
  return [...document.querySelectorAll('header.site .home, header.site nav a')].map((a) =>
    slug(new URL(a.href, location.href).pathname),
  );
}

/** -1, 0 or 1: which way a move from one path to another goes through the nav. */
export function dirOf(from, to) {
  const o = pageOrder();
  const a = o.indexOf(slug(from));
  const b = o.indexOf(slug(to));
  return a < 0 || b < 0 || a === b ? 0 : Math.sign(b - a);
}
