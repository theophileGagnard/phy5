// sketch.js -- le trait « carnet de physique » du plugin (Source/SketchDraw.h) pour la page : hasard déterministe,
// chemins tremblés (SVG et canvas), hachures, couleurs lues dans les jetons CSS, et le planificateur de dessin.
//
// Performances (téléphone) : un canvas n'est JAMAIS redessiné en boucle. On le marque « à redessiner » (invalidate) quand
// une de ses valeurs change ; un seul requestAnimationFrame dessine ensuite tout ce qui est marqué. Les valeurs en direct
// du worklet arrivent ~30 fois par seconde : le dessin ne dépasse donc pas 30 images/s.

// ---------------------------------------------------------------- hasard déterministe (même dessin à chaque fois)
export function rng (seed)
{
    let a = (seed >>> 0) || 1;
    return () =>
    {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul (t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul (t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function hashString (s)
{
    let h = 2166136261;
    for (let i = 0; i < s.length; ++i) h = Math.imul (h ^ s.charCodeAt (i), 16777619);
    return h >>> 0;
}

// ---------------------------------------------------------------- couleurs (jetons CSS de :root)
let palette = null;

function readPalette()
{
    const cs = getComputedStyle (document.documentElement);
    const get = (name) => cs.getPropertyValue (name).trim();
    palette = {
        paper: get ('--paper'), sheet: get ('--sheet'), grid: get ('--grid'), wash: get ('--wash'),
        ink: get ('--ink'), inkSoft: get ('--ink-soft'), inkFaint: get ('--ink-faint'), line: get ('--line'),
        warm: get ('--warm'), cool: get ('--cool'), hover: get ('--hover'),
    };
}

export function colors()
{
    if (! palette) readPalette();
    return palette;
}

// couleur '#rrggbb' -> 'rgba(…, a)'
export function alpha (hex, a)
{
    const h = hex.replace ('#', '');
    const n = parseInt (h.length === 3 ? h.split ('').map (c => c + c).join ('') : h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Le thème change (système ou bouton de la page) : on relit les jetons, on refait le papier et les cadres, on redessine.
export function watchTheme()
{
    const refresh = () => { palette = null; applySkin(); invalidateAll(); };
    matchMedia ('(prefers-color-scheme: dark)').addEventListener ('change', refresh);
    new MutationObserver (refresh).observe (document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    applySkin();
}

// ---------------------------------------------------------------- papier du plugin (rebuildBackgroundImage)
// Pré-rendu UNE fois par thème dans une tuile raccordable (528 px = 11 cellules de marbrure de 48 px = 24 carreaux de
// 22 px), puis posée en fond par le CSS (--paper-tex) : rien n'est redessiné pendant le jeu. Mêmes étapes que le
// plugin : marbrure basse fréquence (bruit de valeur bilinéaire), grain fin, fibres, auréoles, quadrillage de carnet.
// Le vignettage, lié à la taille de la fenêtre, est un dégradé CSS posé sur la fenêtre de l'instrument.
const TILE = 528, CELL = 48, GRID = 22;
const paperCache = new Map();   // couleur du papier -> URL de la tuile (une par thème, gardée : rebasculer est instantané)
let paperWanted = '';

function paperTile (c, dark)
{
    const dpr = Math.min (2, window.devicePixelRatio || 1);
    const N = Math.round (TILE * dpr);
    const cv = document.createElement ('canvas');
    cv.width = cv.height = N;
    const ctx = cv.getContext ('2d');
    ctx.fillStyle = c.paper;
    ctx.fillRect (0, 0, N, N);

    // 1) marbrure + 2) grain, pixel par pixel (sur le papier sombre, un peu plus marqués pour rester visibles)
    const g = TILE / CELL, r = rng (20240607), lat = new Float32Array (g * g);
    for (let i = 0; i < lat.length; ++i) lat[i] = r() - 0.5;
    const L = (ix, iy) => lat[(iy % g) * g + (ix % g)];
    const img = ctx.getImageData (0, 0, N, N), px = img.data;
    const kMottle = dark ? 0.10 : 0.06, kGrain = dark ? 0.06 : 0.035;
    for (let y = 0; y < N; ++y)
    {
        const yy = y / dpr, gy = Math.floor (yy / CELL), fy = (yy % CELL) / CELL;
        for (let x = 0; x < N; ++x)
        {
            const xx = x / dpr, gx = Math.floor (xx / CELL), fx = (xx % CELL) / CELL;
            const top = L (gx, gy) + (L (gx + 1, gy) - L (gx, gy)) * fx;
            const bot = L (gx, gy + 1) + (L (gx + 1, gy + 1) - L (gx, gy + 1)) * fx;
            const k = 1 + (top + (bot - top) * fy) * kMottle + (r() - 0.5) * kGrain;
            const o = (y * N + x) * 4;
            px[o] *= k; px[o + 1] *= k; px[o + 2] *= k;
        }
    }
    ctx.putImageData (img, 0, 0);
    ctx.scale (dpr, dpr);

    // dessine `fn` aux 9 positions décalées d'une tuile : ce qui déborde d'un bord revient par l'autre (raccord)
    const wrap = (fn) => { for (const dx of [-TILE, 0, TILE]) for (const dy of [-TILE, 0, TILE]) { ctx.save(); ctx.translate (dx, dy); fn(); ctx.restore(); } };

    // 3) fibres : courts traits très discrets
    const r2 = rng (777);
    ctx.strokeStyle = alpha (c.inkFaint, dark ? 0.16 : 0.10);
    ctx.lineWidth = 0.5;
    for (let i = 0; i < (TILE * TILE) / 5000; ++i)
    {
        const x = r2() * TILE, y = r2() * TILE, a = r2() * Math.PI * 2, len = 4 + r2() * 9;
        wrap (() => { ctx.beginPath(); ctx.moveTo (x, y); ctx.lineTo (x + Math.cos (a) * len, y + Math.sin (a) * len); ctx.stroke(); });
    }
    // 4) auréoles d'humidité (6 sur la fenêtre de 900 x 820 du plugin, soit ~2 par tuile)
    for (let i = 0; i < 2; ++i)
    {
        const rad = 40 + r2() * 90, x = r2() * TILE, y = r2() * TILE;
        wrap (() =>
        {
            const grad = ctx.createRadialGradient (x, y, 0, x, y, rad);
            grad.addColorStop (0, alpha (c.warm, dark ? 0.08 : 0.06));
            grad.addColorStop (1, alpha (c.warm, 0));
            ctx.fillStyle = grad;
            ctx.fillRect (x - rad, y - rad, rad * 2, rad * 2);
        });
    }
    // 5) quadrillage de carnet, 1 px tous les 22 px
    ctx.fillStyle = alpha (c.grid, dark ? 0.55 : 0.28);
    for (let p = 0; p < TILE; p += GRID)
    {
        ctx.fillRect (p, 0, 1, TILE);
        ctx.fillRect (0, p, TILE, 1);
    }
    return cv;
}

function usePaper (url)
{
    document.documentElement.style.setProperty ('--paper-tex', `url("${url}")`);
    document.documentElement.classList.add ('paper');
}

function setPaper (c, dark)
{
    paperWanted = c.paper;
    if (paperCache.has (c.paper)) { usePaper (paperCache.get (c.paper)); return; }
    const cv = paperTile (c, dark), key = c.paper;
    const done = (url) => { paperCache.set (key, url); if (paperWanted === key) usePaper (url); };
    // JPEG : le grain rend le PNG énorme ; une texture sans transparence n'y perd rien. Blob d'abord (léger), sinon data:
    cv.toBlob ((blob) =>
    {
        if (! blob) { done (cv.toDataURL ('image/jpeg', 0.9)); return; }
        const url = URL.createObjectURL (blob);
        const probe = new Image();
        probe.onload = () => done (url);
        probe.onerror = () => { URL.revokeObjectURL (url); done (cv.toDataURL ('image/jpeg', 0.9)); };
        probe.src = url;
    }, 'image/jpeg', 0.9);
}

// ---------------------------------------------------------------- cadres « à main levée » (SketchDraw.h) en SVG
// Chaque cadre est une petite image SVG (data:) étirée à la taille de l'élément ; le trait garde son épaisseur
// (vector-effect: non-scaling-stroke). Générées une fois par thème et posées dans des variables CSS (--f-*).

// wobblyRect : côtés légèrement bombés, coins décalés d'une fraction de pixel
function wobblyRectD (x, y, w, h, amp, seed, open = false)
{
    const r = rng (seed);
    const j = (a) => (r() - 0.5) * 2 * a;
    const c = open ? [[x, y + h], [x, y], [x + w, y], [x + w, y + h]]
                   : [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    if (! open) for (const p of c) { p[0] += j (amp * 0.6); p[1] += j (amp * 0.6); }
    const n = open ? 3 : 4;
    let d = `M${c[0][0].toFixed (2)} ${c[0][1].toFixed (2)}`;
    for (let i = 0; i < n; ++i)
    {
        const a = c[i], b = [...c[(i + 1) % 4]];
        if (open) { b[0] += j (amp * 0.5); b[1] += j (amp * 0.5); }
        const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.max (1, Math.hypot (dx, dy));
        const k = j (amp);
        d += `Q${((a[0] + b[0]) / 2 - dy / len * k).toFixed (2)} ${((a[1] + b[1]) / 2 + dx / len * k).toFixed (2)} ${b[0].toFixed (2)} ${b[1].toFixed (2)}`;
    }
    return open ? d : d + 'Z';
}

// wobblyLine : droite légèrement ondulée (séparateurs)
function wobblyLineD (x0, y0, x1, y1, amp, seed)
{
    const r = rng (seed);
    const dx = x1 - x0, dy = y1 - y0, len = Math.max (1, Math.hypot (dx, dy)), nx = -dy / len, ny = dx / len;
    const segs = Math.max (1, Math.round (len / 45));
    let d = `M${x0} ${y0}`;
    for (let i = 1; i <= segs; ++i)
    {
        const t0 = (i - 1) / segs, t1 = i / segs, m = (r() - 0.5) * 2 * amp, e = i === segs ? 0 : (r() - 0.5) * amp * 0.5;
        d += `Q${(x0 + dx * (t0 + t1) / 2 + nx * m).toFixed (2)} ${(y0 + dy * (t0 + t1) / 2 + ny * m).toFixed (2)} `
           + `${(x0 + dx * t1 + nx * e).toFixed (2)} ${(y0 + dy * t1 + ny * e).toFixed (2)}`;
    }
    return d;
}

function svgUrl (w, h, body)
{
    const s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${body}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent (s)}")`;
}
const strokeAttr = (color, width, extra = '') =>
    `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"${extra}`;

// trait « graphite » : un passage net + deux passages plus pâles, très légèrement décalés (strokeGraphite)
function graphiteD (d, color, width)
{
    return `<path d="${d}" ${strokeAttr (color, width)}/>`
         + `<path d="${d}" ${strokeAttr (color, width * 0.7, ' opacity="0.55" transform="translate(0.45 -0.35)"')}/>`
         + `<path d="${d}" ${strokeAttr (color, width * 0.55, ' opacity="0.35" transform="translate(-0.6 0.5)"')}/>`;
}

// cadre : remplissage + trait au crayon
function frameUrl (w, h, { inset = 1.5, amp = 1, seed = 1, fill = 'none', stroke, width = 1.3, graphite = false, extra = '' })
{
    const d = wobblyRectD (inset, inset, w - 2 * inset, h - 2 * inset, amp, seed);
    return svgUrl (w, h, (fill !== 'none' ? `<path d="${d}" fill="${fill}"/>` : '') + extra
                       + (graphite ? graphiteD (d, stroke, width) : `<path d="${d}" ${strokeAttr (stroke, width)}/>`));
}

export function applySkin()
{
    const c = colors();
    const dark = (() =>
    {
        const h = c.paper.replace ('#', '');
        const n = parseInt (h.length === 3 ? h.split ('').map (x => x + x).join ('') : h, 16);
        return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255) < 384;
    }) ();
    setPaper (c, dark);

    const ink = (a) => alpha (c.ink, a);
    const set = (name, v) => document.documentElement.style.setProperty (name, v);
    const cross = (s, inset) =>
    {
        const a = inset + 2.5, b = s - inset - 2.5;
        const d = `M${a - 1} ${a + 0.5}Q${s / 2 + 1.2} ${s / 2 - 1} ${b + 1} ${b - 0.5}M${a + 0.5} ${b + 1}Q${s / 2 - 1} ${s / 2 + 1.2} ${b - 0.5} ${a - 1}`;
        return graphiteD (d, c.warm, 2);
    };

    // case de valeur (drawLabel) : papier clair, trait encre pâle
    set ('--f-val', frameUrl (80, 20, { inset: 1, amp: 0.7, seed: 21, fill: alpha (c.paper, 0.35), stroke: c.inkFaint, width: 1.1 }));
    // menu (drawComboBox) et bouton (drawButtonBackground)
    set ('--f-combo', frameUrl (110, 24, { amp: 0.9, seed: 33, fill: alpha (c.grid, 0.55), stroke: ink (0.85), width: 1.3 }));
    set ('--f-combo-focus', frameUrl (110, 24, { amp: 0.9, seed: 33, fill: alpha (c.grid, 0.75), stroke: c.warm, width: 1.3 }));
    set ('--f-btn', frameUrl (110, 30, { amp: 1, seed: 45, fill: alpha (c.grid, 0.55), stroke: ink (0.9), width: 1.4 }));
    set ('--f-btn-hover', frameUrl (110, 30, { amp: 1, seed: 45, fill: alpha (c.grid, 0.8), stroke: c.warm, width: 1.4 }));
    set ('--f-btn-on', frameUrl (110, 30, { amp: 1, seed: 45, fill: alpha (c.warm, 0.45), stroke: ink (0.9), width: 1.4 }));
    // onglets (drawTabButton) : inactif = fiche fermée teintée ; actif = cadre ouvert en bas + soulignement rouge
    set ('--f-tab', frameUrl (90, 55, { inset: 1.5, amp: 1, seed: 57, fill: alpha (c.grid, 0.45), stroke: ink (0.6), width: 1.2 }));
    set ('--f-tab-hover', frameUrl (90, 55, { inset: 1.5, amp: 1, seed: 57, fill: alpha (c.grid, 0.45), stroke: c.warm, width: 1.2 }));
    set ('--f-tab-on', svgUrl (90, 59, `<path d="${wobblyRectD (1.5, 2, 87, 58, 1, 69, true)}" ${strokeAttr (ink (0.9), 1.7)}/>`));
    set ('--f-underline', svgUrl (60, 4, `<path d="M0 2.5Q30 4 60 2" ${strokeAttr (c.warm, 2)}/>`));
    // case à cocher (drawToggleButton)
    const box = (checked) => svgUrl (18, 18, `<path d="${wobblyRectD (1, 1, 16, 16, 0.8, 81)}" fill="${alpha (c.paper, 0.6)}"/>`
        + `<path d="${wobblyRectD (1, 1, 16, 16, 0.8, 81)}" ${strokeAttr (ink (0.8), 1.4)}/>` + (checked ? cross (18, 1) : ''));
    set ('--f-check', box (false));
    set ('--f-check-on', box (true));
    // tuiles du panneau de modulation (ModSourceTile::paint) : générateurs en encre, sources liées à la note en bleu-vert
    set ('--f-tile', frameUrl (140, 34, { amp: 1, seed: 93, fill: alpha (c.grid, 0.55), stroke: ink (0.95), width: 1.3, graphite: true }));
    set ('--f-tile-note', frameUrl (140, 34, { amp: 1, seed: 95, fill: alpha (c.cool, 0.16), stroke: alpha (c.cool, 0.95), width: 1.3, graphite: true }));
    set ('--f-tile-btn', frameUrl (18, 16, { inset: 1, amp: 0.6, seed: 97, fill: alpha (c.paper, 0.8), stroke: ink (0.85), width: 1.1 }));
    // fenêtre de l'instrument et cartes de la page ; séparateurs de familles (SeparatorLine) et traits de l'en-tête
    set ('--f-window', frameUrl (900, 800, { inset: 1, amp: 1.6, seed: 101, stroke: ink (0.85), width: 1.5 }));
    set ('--f-card', frameUrl (900, 160, { inset: 1, amp: 1.4, seed: 103, fill: alpha (c.paper, 0.25), stroke: ink (0.6), width: 1.2 }));
    set ('--f-hsep', svgUrl (600, 4, `<path d="${wobblyLineD (0, 2, 600, 2, 0.7, 111)}" ${strokeAttr (alpha (c.inkFaint, 0.75), 1.2)}/>`));
    set ('--f-vsep', svgUrl (4, 300, `<path d="${wobblyLineD (2, 0, 2, 300, 0.7, 113)}" ${strokeAttr (alpha (c.inkFaint, 0.75), 1.2)}/>`));
    set ('--f-rule', svgUrl (900, 4, `<path d="${wobblyLineD (0, 2, 900, 2, 0.9, 11)}" ${strokeAttr (ink (0.85), 1.5)}/>`));
}

// ---------------------------------------------------------------- planificateur de dessin
const views = new Set();     // toutes les vues canvas
const dirty = new Set();
let frame = 0;

export function register (view) { views.add (view); }

export function invalidate (view)
{
    dirty.add (view);
    if (! frame) frame = requestAnimationFrame (flush);
}

export function invalidateAll() { for (const v of views) invalidate (v); }

function flush()
{
    frame = 0;
    const list = [...dirty];
    dirty.clear();
    for (const v of list) v.paint();
}

// ---------------------------------------------------------------- SVG
export const SVGNS = 'http://www.w3.org/2000/svg';
export function svg (tag, attrs = {}, parent = null)
{
    const e = document.createElementNS (SVGNS, tag);
    for (const [k, v] of Object.entries (attrs)) e.setAttribute (k, v);
    parent?.append (e);
    return e;
}

// cercle à main levée (rayon qui varie légèrement), en chemin SVG
export function wobblyCirclePath (cx, cy, r, amp, rand, steps = 28)
{
    const ph = rand() * Math.PI * 2;
    let d = '';
    for (let i = 0; i <= steps; ++i)
    {
        const a = i / steps * Math.PI * 2;
        const rr = r * (1 + amp * Math.sin (a * 2 + ph) + amp * 0.55 * Math.sin (a * 3 - ph));
        d += `${i ? 'L' : 'M'}${(cx + rr * Math.cos (a)).toFixed (2)} ${(cy + rr * Math.sin (a)).toFixed (2)}`;
    }
    return d + 'Z';
}

// ---------------------------------------------------------------- canvas
// Trait de crayon : un passage principal, deux passages tremblés plus clairs (strokeGraphite du plugin).
export function graphite (ctx, points, color, width, seed = 1)
{
    const pass = (pts, a, w) =>
    {
        ctx.globalAlpha = a;
        ctx.lineWidth = w;
        ctx.beginPath();
        pts.forEach (([x, y], i) => i ? ctx.lineTo (x, y) : ctx.moveTo (x, y));
        ctx.stroke();
    };
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineJoin = ctx.lineCap = 'round';
    pass (points, 1, width);
    const r = rng (seed * 7 + 3);
    const jit = (amp) => points.map (([x, y]) => [x + (r() - 0.5) * 2 * amp, y + (r() - 0.5) * 2 * amp]);
    pass (jit (0.55), 0.5, width * 0.7);
    pass (jit (0.95), 0.3, width * 0.55);
    ctx.restore();
}

// Hachures diagonales irrégulières, limitées au chemin `clip` (fonction qui trace le chemin).
export function hatch (ctx, clip, box, color, spacing = 4.5, seed = 3)
{
    const r = rng (seed);
    ctx.save();
    ctx.beginPath();
    clip (ctx);
    ctx.clip();
    ctx.strokeStyle = color;
    for (let d = -box.h; d < box.w; d += spacing)
    {
        const j = (r() - 0.5) * 1.2;
        ctx.lineWidth = 0.6 + r() * 0.4;
        ctx.beginPath();
        ctx.moveTo (box.x + d + j, box.y + box.h);
        ctx.lineTo (box.x + d + box.h + j, box.y);
        ctx.stroke();
    }
    ctx.restore();
}

// Cadre de visualiseur : papier très légèrement teinté + trait de crayon (drawSketchFrame du plugin).
export function sketchFrame (ctx, x, y, w, h, seed = 1)
{
    const c = colors();
    const r = rng (seed);
    const j = (a) => (r() - 0.5) * 2 * a;
    const pts = [[x + j (0.6), y + j (0.6)], [x + w + j (0.6), y + j (0.6)], [x + w + j (0.6), y + h + j (0.6)], [x + j (0.6), y + h + j (0.6)]];
    ctx.save();
    ctx.beginPath();
    pts.forEach (([px, py], i) =>
    {
        if (i === 0) ctx.moveTo (px, py);
        const [nx, ny] = pts[(i + 1) % 4];
        ctx.quadraticCurveTo ((px + nx) / 2 + j (1), (py + ny) / 2 + j (1), nx, ny);
    });
    ctx.closePath();
    ctx.fillStyle = c.wash;
    ctx.fill();
    ctx.strokeStyle = alpha (c.ink, 0.85);
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.restore();
}

// ---------------------------------------------------------------- vue canvas de base
// Canvas net sur écran haute densité, taille suivie (ResizeObserver), dessin seulement sur invalidate().
export class CanvasView
{
    constructor (className, height)
    {
        this.root = document.createElement ('div');
        this.root.className = `view ${className}`;
        if (height) this.root.style.height = `${height}px`;
        this.canvas = document.createElement ('canvas');
        this.root.append (this.canvas);
        this.ctx = this.canvas.getContext ('2d');
        this.w = 0; this.h = 0;
        new ResizeObserver (() => this.resize()).observe (this.root);
        register (this);
    }

    resize()
    {
        const w = this.root.clientWidth, h = this.root.clientHeight;
        if (w === this.w && h === this.h) return;
        const dpr = Math.min (2, window.devicePixelRatio || 1);   // 2 au plus : assez net, moins de pixels à remplir
        this.w = w; this.h = h;
        this.canvas.width = Math.max (1, Math.round (w * dpr));
        this.canvas.height = Math.max (1, Math.round (h * dpr));
        this.dpr = dpr;
        this.invalidate();
    }

    invalidate() { invalidate (this); }

    paint()
    {
        if (! this.w || ! this.h) return;
        const ctx = this.ctx;
        ctx.setTransform (this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect (0, 0, this.w, this.h);
        this.draw (ctx, this.w, this.h);
    }

    // position du pointeur dans la vue (pixels CSS)
    local (e)
    {
        const b = this.canvas.getBoundingClientRect();
        return [e.clientX - b.left, e.clientY - b.top];
    }

    // glisser au pointeur (souris, doigt, stylet) : down(x, y, e) -> true pour capturer ; move(x, y) ; up()
    drag ({ down, move, up = () => {} })
    {
        const c = this.canvas;
        c.style.touchAction = 'none';
        c.addEventListener ('pointerdown', (e) =>
        {
            const [x, y] = this.local (e);
            if (! down (x, y, e)) return;
            e.preventDefault();
            c.setPointerCapture (e.pointerId);
            const mv = (ev) => { const [mx, my] = this.local (ev); move (mx, my, ev); };
            const end = () => { c.removeEventListener ('pointermove', mv); c.removeEventListener ('pointerup', end); c.removeEventListener ('pointercancel', end); up(); };
            c.addEventListener ('pointermove', mv);
            c.addEventListener ('pointerup', end);
            c.addEventListener ('pointercancel', end);
        });
    }
}
