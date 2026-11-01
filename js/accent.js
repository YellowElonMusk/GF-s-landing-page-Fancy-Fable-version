// The accent drifts through shades of silver: it holds each for most of a 25s slot, then
// eases into the next. The clock starts once per tab session, so navigating doesn't reset it.
const PALETTE = ['#f2f2f2', '#bcbcbc', '#e2e2e2', '#a5a5a5', '#d0d0d0'];
const SLOT = 25000;

const start = (() => {
  try {
    const saved = Number(sessionStorage.getItem('accent-start'));
    if (saved) return saved;
    sessionStorage.setItem('accent-start', String(Date.now()));
  } catch {}
  return Date.now();
})();

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** The accent at the current moment as [r, g, b] in 0..1. */
export function accentNow() {
  const t = (Date.now() - start) / SLOT;
  const i = Math.floor(t) % PALETTE.length;
  const f = t - Math.floor(t);
  const mix = f < 0.4 ? 0 : (1 - Math.cos(((f - 0.4) / 0.6) * Math.PI)) / 2;
  const a = rgb(PALETTE[i]);
  const b = rgb(PALETTE[(i + 1) % PALETTE.length]);
  return a.map((v, k) => v + (b[k] - v) * mix);
}

export function runAccent() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const style = document.documentElement.style;
  const set = () => {
    const [r, g, b] = accentNow().map((v) => Math.round(v * 255));
    style.setProperty('--accent', `rgb(${r} ${g} ${b})`);
  };
  set();
  setInterval(set, 150);
}
