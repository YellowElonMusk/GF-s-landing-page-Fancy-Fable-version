// A tiny client-side router: same-origin links fetch the next page and swap `.wrap` in place,
// so the 3D backdrop and keyboard state survive and pagebits.js can animate between pages.
import { transition } from './pagebits.js';
import { dirOf } from './motion.js';

const ROOTS = 'main, footer.site';
const pages = new Map();
let latest = 0; // only the newest navigation may fall back to a hard load
let prev = location.pathname; // where we came from; on popstate location has already changed
// Hosts often serve /work.html as /work, so treat the two as the same page.
const same = (a, b) => a.replace(/(index)?\.html$/, '') === b.replace(/(index)?\.html$/, '');

function load(url) {
  const key = url.split('#')[0];
  if (!pages.has(key)) {
    const opts = typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(8000) } : undefined;
    const p = fetch(key, opts).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status))));
    p.catch(() => pages.delete(key));
    pages.set(key, p);
  }
  return pages.get(key);
}

function internal(a) {
  if (!a || a.target || a.hasAttribute('download') || a.dataset.reload !== undefined) return null;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || !/(\/|\.html|\/[^./]+)$/.test(url.pathname)) return null;
  if (same(url.pathname, location.pathname) && url.hash) return null; // same-page anchor
  return url;
}

async function go(url, source, push) {
  const my = ++latest;
  const from = prev;
  const meta = { from, to: url.pathname, dir: dirOf(from, url.pathname), kind: push ? 'nav' : 'pop' };
  const ready = load(url.href).then((html) => {
    const next = new DOMParser().parseFromString(html, 'text/html');
    return () => {
      const wrap = document.querySelector('.wrap');
      const incoming = next.querySelector('.wrap');
      // The scene button belongs to the backdrop, so carry it across rather than resetting it.
      const scene = wrap.querySelector('.scene');
      incoming.querySelector('.scene')?.replaceWith(scene);
      wrap.replaceWith(document.adoptNode(incoming));
      document.title = next.title;
      if (push) history.pushState(null, '', url.href);
      prev = url.pathname;
      scrollTo(0, 0);
      dispatchEvent(new Event('pageswap'));
      return [...document.querySelectorAll(ROOTS)];
    };
  });
  try {
    await transition(source, ready, meta);
  } catch {
    if (my === latest) location.href = url.href; // an abandoned navigation never drags the page away
  }
}

export function runRouter() {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a');
    const url = internal(a);
    if (!url) return;
    e.preventDefault();
    if (!same(url.pathname, location.pathname)) go(url, a, true);
  });
  addEventListener('popstate', () => go(new URL(location.href), null, false));
  // Prefetch on hover/focus/press so the outgoing effect is usually the only wait.
  const warm = (e) => {
    const url = internal(e.target.closest?.('a'));
    if (url) load(url.href);
  };
  document.addEventListener('mouseover', warm, { passive: true });
  document.addEventListener('focusin', warm, { passive: true });
  document.addEventListener('pointerdown', warm, { passive: true });
  document.addEventListener('touchstart', warm, { passive: true });
}
