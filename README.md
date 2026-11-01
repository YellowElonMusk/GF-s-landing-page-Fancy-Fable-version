# Lillith W

Static, no build step. ES modules need HTTP, so serve the folder:

    npx serve .

## What's in it

| File | Does |
|---|---|
| `js/scenes.js` | Procedural wireframe Paris, drawn to scale and lit like night film: the Eiffel Tower from the Trocadéro (four splayed legs, the great arches, a searchlight, a sparkle every 55 s), the Pont Neuf from the Pont des Arts (turrets, voussoirs, lamp standards, Notre-Dame and the Conciergerie in the mist, a bateau-mouche every few minutes), and Haussmann rooftops toward Sacré-Cœur (two lit boulevards, chimney smoke). Mist, a horizon glow, a Seine sheet with each lamp's reflection, lit windows. `SCENES` at the bottom is the list. |
| `js/backdrop.js` | three.js render loop: a fixed eye height per scene with a slow tripod settle, scene changes as a silver burn, a projector "hiccup" (gate weave, flicker, soft focus) every 20-40 s, and the reaction to page changes (soft focus, lamps smearing along the direction of travel, exposure bump). `,` `.` switch scenes; `?scene=N` picks one. Idle frames bypass the post shader. |
| `js/pagebits.js` | Page transitions: letters soften, flare and shed silver grains sized to their type; the grains drift, then fly on streaked arcs to the next page, which develops like a print with the title last. One soft flash and a light leak from the side you clicked. `BIT_STYLE` near the top switches the grains back to `'digits'` (0/1). |
| `js/motion.js` | Shared tempo (`PACE`), film easings and the page-move events (`pageburn`, `pageshift`, `pagebits:start/end`). |
| `js/router.js` | Swaps pages in place so the backdrop and transitions persist. Prefetches on hover/press. Never drops a navigation. |
| `js/keynav.js` | Keyboard nav: `↑↓`/`jk` rows, `←→`/`hl` within a row, `g`/`G`, `/` find, `⏎` open, `esc`. Blinking cursor, row highlight, status bar with path. Steps out of the frame during a transition. |
| `js/film.js` | Light cinematic grain over everything (the same fractal noise as the original base44 page) plus a vignette. Tune `--grain` on `.film-grain` and `--vignette` in `css/site.css`. |
| `js/accent.js` | Accent drifts slowly between shades of silver. |

Everything respects `prefers-reduced-motion` (one still frame, plain page swaps). The 3D only loads on idle, on machines with WebGL2 and 4+ cores.

## Lab pages (not linked from the site)

- `dev/scene-lab?scene=N&flip=1&debug&t=10` renders one scene with no page over it. `?debug` prints draw calls, vertices and build time; `?t=` freezes the clock; `?still` renders one frame. Use the clean URL: `serve` drops the query string when redirecting from `.html`.
- `dev/tx-lab?debug` and `dev/tx-cases.md`: a fixture page and four transition stress cases (double click, resize mid-flight, scrolled gallery, frame budget) for the headless browser.
- `?debug` on any real page exposes `window.__pagebits` (state, counters, `freeze(t)`/`thaw()`).

## Content

`index.html` (statement + selected work), `gallery.html` (all 32 works), `about.html` (biography).
Images are loaded from the original base44 media host, resized on the fly via `/v1/fill/...` URLs.
To add a page, copy `about.html` and add it to the `<nav>` in each page; the transition direction is read from the nav order.
