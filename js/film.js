// A light, cinematic film grain over the whole site, matched to the grain on Lillith's original
// homepage: SVG fractal noise at low opacity, overlay-blended so it sits in the image rather than on
// top of it. It shifts a few times a second so it breathes like projected film, plus a soft vignette.
//
// Tune the look with --grain and --vignette in site.css.

const NOISE = `url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.7'/%3E%3C/svg%3E")`;
const FPS = 12;

export function runFilm() {
  const layer = (cls) => {
    const el = document.createElement('div');
    el.className = cls;
    el.setAttribute('aria-hidden', 'true');
    document.body.append(el);
    return el;
  };
  layer('film-vignette');
  const grains = [layer('film-grain'), layer('film-grain shadows')];
  for (const g of grains) g.style.backgroundImage = NOISE;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let last = 0;
  const tick = (t) => {
    requestAnimationFrame(tick);
    if (t - last < 1000 / FPS - 2) return;
    last = t;
    for (const g of grains) g.style.transform = `translate(${-Math.floor(Math.random() * 180)}px, ${-Math.floor(Math.random() * 180)}px)`;
  };
  requestAnimationFrame(tick);
}
