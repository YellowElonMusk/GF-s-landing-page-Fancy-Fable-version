// Entry point for every page.
import { runAccent } from './accent.js';
import { runPagebits } from './pagebits.js';
import { runRouter } from './router.js';
import { runKeynav } from './keynav.js';
import { runFilm } from './film.js';

// Each module boots on its own so one failing (an old browser, a missing API) never stops the others.
for (const run of [runAccent, runPagebits, runRouter, runKeynav, runFilm]) {
  try {
    run();
  } catch (e) {
    console.warn(e);
  }
}

// The footer names the scene on screen; clicking it moves to the next one.
addEventListener('scenechange', (e) => {
  const { name, n, of } = e.detail;
  const button = document.querySelector('footer.site .scene');
  button.textContent = `scenes/${name}.js (${n}/${of})`;
  button.hidden = false;
});
document.addEventListener('click', (e) => {
  if (e.target.closest('footer.site .scene')) dispatchEvent(new Event('scenestep'));
});

// The 3D backdrop: only with WebGL2 and a reasonable machine, and only once the page is idle,
// so three.js never competes with first paint.
const canvas = document.querySelector('canvas.backdrop');
const capable = (() => {
  try {
    if (!document.createElement('canvas').getContext('webgl2')) return false;
  } catch {
    return false;
  }
  return (navigator.hardwareConcurrency ?? 8) >= 4 && (navigator.deviceMemory ?? 8) >= 4;
})();
if (canvas && capable) {
  const boot = () =>
    import('./backdrop.js').then(({ start }) => {
      start(canvas);
      canvas.classList.add('on');
    });
  'requestIdleCallback' in window ? requestIdleCallback(boot, { timeout: 1500 }) : setTimeout(boot, 300);
}
