// Vim-ish keyboard navigation for the whole site.
//
//   ↑↓ / j k   move between rows          ←→ / h l   move within a row
//   g / G      first / last               /          find (type to jump, ⏎ keep, esc cancel)
//   ⏎          open (types "$ open …" into the status bar first)       esc   exit
//
// A blinking ">" cursor and a highlighted row follow the selection, and a status bar along the
// bottom shows the path, e.g. "~/work/experience [4/17]". The selection survives page changes.

const TARGETS = [
  'header.site .home',
  'header.site nav a',
  'main h1',
  'main .lede',
  'main .kv dt',
  'main h2',
  'main .log > li',
  'main .posts > li',
  'main .statement > p',
  'main .works > figure',
  'main ul.plain > li',
  'main .more a',
  'main p > a',
  'footer.site .socials a',
  'footer.site .foot > a',
  'footer.site .copy',
  'footer.site .scene',
  'footer.site .built',
].join(', ');

const label = (el) =>
  (el.getAttribute('aria-label') || el.innerText || '').trim().split('\n')[0].replace(/\s+/g, ' ').toLowerCase();

export function runKeynav() {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  const root = document.documentElement;
  const make = (cls, html = '') => {
    const el = document.createElement('div');
    el.className = cls;
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = html;
    document.body.append(el);
    return el;
  };
  const cursor = make('kcursor', '&gt;');
  const row = make('krow');
  const bar = make('kbar', '<span class="kpath"></span><span class="kkeys"></span>');
  const pathEl = bar.querySelector('.kpath');
  const keysEl = bar.querySelector('.kkeys');
  root.classList.add('kready');

  let sel = null;
  let query = null; // non-null while finding
  let findFrom = -1;
  const items = () => [...document.querySelectorAll(TARGETS)].filter((el) => el.offsetParent !== null);
  const top = (el) => el.getBoundingClientRect().top;
  const sameRow = (a, b) => Math.abs(top(a) - top(b)) < 8;
  const home = () => document.querySelector('header.site .home');
  const linkOf = (el) => (el.matches('a') ? el : el.querySelector('a'));
  const page = () => location.pathname.replace(/(index)?\.html$/, '').replace(/\/$/, '') || '';

  const idle = () => {
    pathEl.textContent = '~' + page();
    keysEl.textContent = '↑↓ navigate  / find';
  };
  idle();

  function status(list) {
    const main = sel.closest('main');
    const heads = main ? [...main.querySelectorAll('h2')].filter((h) => top(h) <= top(sel) + 1) : [];
    const section = heads.length ? label(heads[heads.length - 1]).replace(/[^a-z0-9]+/g, '-') : '';
    pathEl.textContent = `~${page()}${section ? '/' + section : ''} [${list.indexOf(sel) + 1}/${list.length}]`;
    const verb = sel.matches('button') ? sel.title || label(sel) : linkOf(sel) && 'open';
    keysEl.textContent = `↑↓ move  ←→ row  ${verb ? `⏎ ${verb}  ` : ''}/ find  esc exit`;
  }

  /** The first line of text in an element, so the cursor sits beside it rather than its box. */
  function firstLine(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      range.selectNodeContents(n);
      const r = [...range.getClientRects()].find((r) => r.width && r.height);
      if (r) return r;
    }
    return (el.querySelector('svg, img') ?? el).getBoundingClientRect();
  }

  function place() {
    if (!sel) return;
    const list = items();
    const main = document.querySelector('main').getBoundingClientRect();
    const peers = list.filter((el) => sameRow(el, sel)).map((el) => el.getBoundingClientRect());
    const y0 = Math.min(...peers.map((r) => r.top));
    const y1 = Math.max(...peers.map((r) => r.bottom));
    const pad = parseFloat(getComputedStyle(sel).paddingTop) >= 6 ? 0 : 6;
    const line = firstLine(sel);
    const inner = sel.innerText.trim() ? sel : sel.querySelector('svg, img') ?? sel;
    const x = sel === home() ? home().getBoundingClientRect().left
      : peers.length > 1 ? inner.getBoundingClientRect().left - 13
      : main.left - 19;
    cursor.style.transform = `translate(${x + scrollX}px, ${(line.top + line.bottom) / 2 + scrollY}px)`;
    row.style.transform = `translate(${main.left - 30 + scrollX}px, ${y0 - pad + scrollY}px)`;
    row.style.width = `${main.width + 44}px`;
    row.style.height = `${y1 - y0 + pad * 2}px`;
    if (query === null) status(list);
  }

  const watch = new ResizeObserver(() => place());
  function select(el) {
    const first = !sel;
    watch.disconnect();
    watch.observe(el);
    sel?.classList.remove('ksel');
    sel = el;
    el.classList.add('ksel');
    root.classList.add('keynav');
    const r = el.getBoundingClientRect();
    const margin = innerHeight * 0.22;
    if (r.top < margin || r.bottom > innerHeight - margin - 40) scrollBy({ top: r.top - innerHeight * 0.4 });
    if (first) root.classList.add('kjump'); // appear in place rather than sliding from the corner
    place();
    if (first) {
      cursor.offsetWidth;
      root.classList.remove('kjump');
    }
    // Restart the blink so the cursor is solid right after a move.
    cursor.style.animation = 'none';
    cursor.offsetWidth;
    cursor.style.animation = '';
  }

  function exit() {
    sel?.classList.remove('ksel');
    sel = null;
    query = null;
    root.classList.remove('keynav');
    idle();
  }

  function move(dir, wrap = true) {
    const list = items();
    if (!list.length) return;
    if (dir === 'first') return select(list[0]);
    if (dir === 'last') return select(list[list.length - 1]);
    if (!sel || !list.includes(sel)) {
      // Start at the top if it's on screen, otherwise at whatever is near the reading line.
      const h = home().getBoundingClientRect();
      const line = innerHeight * 0.4;
      return h.bottom > 0 && h.top < innerHeight ? select(home())
        : select(list.reduce((a, b) => (Math.abs(top(b) - line) < Math.abs(top(a) - line) ? b : a)));
    }
    const here = sel.getBoundingClientRect();
    if (dir === 'left' || dir === 'right') {
      const peers = list.filter((el) => sameRow(el, sel));
      const i = peers.indexOf(sel) + (dir === 'right' ? 1 : -1);
      if (peers.length > 1 && (wrap || (i >= 0 && i < peers.length))) select(peers[(i + peers.length) % peers.length]);
      return;
    }
    const down = dir === 'down';
    let ahead = list.filter((el) => (down ? top(el) > here.top + 4 : top(el) < here.top - 4));
    if (!ahead.length) {
      if (!wrap) return;
      ahead = list;
    }
    const y = (down ? Math.min : Math.max)(...ahead.map(top));
    const next = ahead.filter((el) => Math.abs(top(el) - y) < 8);
    // Moving between rows keeps your column where it can; from a single item, take the first.
    const fromRow = list.filter((el) => sameRow(el, sel)).length > 1;
    const left = (el) => el.getBoundingClientRect().left;
    next.sort((a, b) => (fromRow ? Math.abs(left(a) - here.left) - Math.abs(left(b) - here.left) : left(a) - left(b)));
    select(next[0]);
  }

  function find(q) {
    pathEl.textContent = `/${q}█`;
    if (!q) return;
    const list = items();
    const order = [...list.slice(findFrom + 1), ...list.slice(0, findFrom + 1)];
    const needle = q.toLowerCase();
    const score = (el) => {
      const text = el.innerText.toLowerCase();
      return label(el).startsWith(needle) ? 0 : text.split(/[^a-z0-9]+/).some((w) => w.startsWith(needle)) ? 1 : text.includes(needle) ? 2 : 3;
    };
    let best, bestScore = 3;
    for (const el of order) {
      const s = score(el);
      if (s < bestScore) [best, bestScore] = [el, s];
      if (!s) break;
    }
    if (best) {
      select(best);
      pathEl.textContent = `/${q}█`;
    }
  }

  function shake() {
    root.classList.remove('kshake');
    row.offsetWidth;
    root.classList.add('kshake');
  }
  row.addEventListener('animationend', () => root.classList.remove('kshake'));

  const remember = (a) => {
    if (a.origin !== location.origin) return;
    try { sessionStorage.setItem('keynav', a.href); } catch {}
  };

  function activate() {
    if (sel.matches('button')) {
      sel.click();
      return place();
    }
    const a = linkOf(sel);
    if (!a) return shake();
    remember(a);
    // Type the command out in the status bar, then go.
    const cmd = `$ open ${label(a) || a.hostname}`;
    let n = 0;
    const timer = setInterval(() => {
      pathEl.textContent = cmd.slice(0, ++n) + '█';
      if (n >= cmd.length) {
        clearInterval(timer);
        setTimeout(() => a.click(), 120);
      }
    }, 150 / cmd.length);
  }

  /** After a page change, pick up on the link that was followed (or the top of the page). */
  function restore() {
    let href = null;
    try {
      href = sessionStorage.getItem('keynav');
      sessionStorage.removeItem('keynav');
    } catch {}
    if (!href) return;
    const list = items();
    select(list.find((el) => linkOf(el)?.href === href) ?? home());
    document.fonts.ready.then(place);
  }

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (query !== null) {
      e.preventDefault();
      if (e.key === 'Escape' || e.key === 'Enter') {
        query = null;
        place();
      } else if (e.key === 'Backspace') find((query = query.slice(0, -1)));
      else if (e.key.length === 1) find((query += e.key));
      return;
    }
    const dirs = { ArrowDown: 'down', j: 'down', ArrowUp: 'up', k: 'up', ArrowLeft: 'left', h: 'left', ArrowRight: 'right', l: 'right', g: 'first', G: 'last' };
    if (dirs[e.key]) {
      e.preventDefault();
      move(dirs[e.key], !e.repeat);
    } else if (e.key === 'Enter' && sel) {
      e.preventDefault();
      activate();
    } else if (e.key === 'Escape' && sel) exit();
    else if (e.key === '/') {
      e.preventDefault();
      if (!sel) move('down');
      findFrom = items().indexOf(sel);
      query = '';
      keysEl.textContent = 'type to find  ⏎ keep  esc cancel';
      pathEl.textContent = '/█';
    }
  });

  // Clicking drops out of keyboard mode, but a click that was made while in it still restores.
  let wasKeyed = false;
  addEventListener('mousedown', () => {
    wasKeyed = !!sel;
    exit();
  });
  addEventListener('click', (e) => {
    const a = e.target.closest?.('a');
    if (wasKeyed && a && items().some((el) => linkOf(el) === a)) remember(a);
  });
  addEventListener('resize', place);
  addEventListener('scroll', place, { passive: true });
  addEventListener('pageswap', () => {
    watch.disconnect();
    sel = null;
    query = null;
    root.classList.remove('keynav');
    idle();
    restore();
  });
  // While the grains fly the cursor and row step out of the shot (html.ktx fades them); a timer
  // covers a transition that never reports its end.
  let safety = 0;
  addEventListener('pagebits:start', () => {
    root.classList.add('ktx');
    clearTimeout(safety);
    safety = setTimeout(() => root.classList.remove('ktx'), 2500);
  });
  addEventListener('pagebits:end', () => {
    clearTimeout(safety);
    root.classList.remove('ktx');
  });
  restore();
}
