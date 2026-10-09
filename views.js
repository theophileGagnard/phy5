// views.js -- visualiseurs interactifs du plugin, portés en canvas : pad XY des filtres (XYPadComponent.h), vue
// d'enveloppe à poignées de courbure (EnvelopeShapeView, EnvelopeLayout.h, EnvelopeCurve.h), schéma de la corde
// (StringSchematicComponent.h), courbe de saturation, forme du LFO, mapping Velocity / Pitch, et le panneau des
// sources de modulation (tuiles à glisser sur un contrôle).
//
// Les formules de dessin viennent des en-têtes cités (copiées ici, la page étant en JavaScript) ; celles qui touchent
// au son (saturation, LFO) sont demandées au moteur WASM (store.model), pour ne rien recopier du DSP.

import { store, param, on, value, real, setNorm, setReal, toNorm, fromNorm, defaultNorm, routesFor, onRoutes, onLive,
         liveMod, modRange, SOURCES, addRoute, removeRoutesOfSource } from './store.js';
import { CanvasView, colors, alpha, graphite, hatch, sketchFrame, rng } from './sketch.js';
import { el, controlLabels } from './widgets.js';

const coarse = matchMedia ('(pointer: coarse)').matches;   // doigt : zones de saisie plus grandes
const HIT = coarse ? 16 : 10;

function font (px) { return `400 ${px}px Cinzel, Georgia, serif`; }   // une seule graisse, comme la police du plugin

// Redessine `view` quand une des clés change, quand les routes changent, et (si une clé est modulée) à chaque envoi
// des valeurs en direct du worklet (~30 Hz).
function watch (view, keys)
{
    for (const k of keys) on (k, () => view.invalidate());
    onRoutes (() => view.invalidate());
    onLive (() => { if (keys.some (k => routesFor (k).length)) view.invalidate(); });
}

// ============================================================================ pad XY d'un filtre
// X = fréquence en échelle LOG (20 Hz - 15 kHz), Y = largeur ; la vraie réponse du filtre en fond (FilterResponse.h).
const kDisperserStages = 6;   // MultiModeFilter::kDisperserStages

// FilterResponse::bandpassMagnitude (formule fermée de la cellule SVF, mode Bandpass)
function bandpassMagnitude (sr, fcIn, wIn, fIn)
{
    const fc = Math.min (Math.max (fcIn, 20), sr * 0.49);
    const w = Math.min (Math.max (wIn, 0), 1);
    const f = Math.min (Math.max (fIn, 1e-3), sr * 0.4999);
    const g = Math.tan (Math.PI * fc / sr);
    const k = 0.06 + w * 1.94;
    const x = Math.tan (Math.PI * f / sr) / g;
    const d = 1 - x * x;
    return (k * x) / Math.sqrt (d * d + k * k * x * x);
}

export class XYPad extends CanvasView
{
    // keys : { mix, mode, freq, width }
    constructor (keys, height = 110)
    {
        super ('xypad', height);
        this.k = keys;
        const p = param (keys.freq);
        this.fMin = Math.max (1, p.min);
        this.fMax = Math.max (this.fMin * 1.01, p.max);
        this.canvas.setAttribute ('role', 'img');
        this.canvas.setAttribute ('aria-label', 'Filter pad: frequency (horizontal) and width (vertical)');
        this.root.title = 'Drag: frequency (horizontal, log scale) and width (vertical). Double-click: default values.';
        watch (this, Object.values (keys));
        this.drag ({
            down: (x, y) => { this.set (x, y); return true; },
            move: (x, y) => this.set (x, y),
        });
        this.canvas.addEventListener ('dblclick', () => { setNorm (keys.freq, defaultNorm (keys.freq)); setNorm (keys.width, defaultNorm (keys.width)); });
    }

    box() { return { x: 2, y: 2, w: this.w - 4, h: this.h - 4 }; }
    fx (f) { return Math.log (Math.min (Math.max (f, this.fMin), this.fMax) / this.fMin) / Math.log (this.fMax / this.fMin); }
    xf (x) { return this.fMin * Math.pow (this.fMax / this.fMin, Math.min (Math.max (x, 0), 1)); }

    set (x, y)
    {
        const b = this.box();
        setReal (this.k.freq, this.xf ((x - b.x) / b.w));                       // pixel -> Hz (log) -> paramètre
        setNorm (this.k.width, (b.y + b.h - y) / b.h);
    }

    curve (b, mode, fc, w)
    {
        const sr = store.sampleRate || 48000;
        const yOf = (mag) =>
        {
            const db = 20 * Math.log10 (Math.max (mag, 1e-5));
            return b.y + b.h - (Math.min (Math.max (db, -30), 6) + 30) / 36 * b.h;
        };
        const pts = [];
        const n = Math.max (16, Math.ceil (b.w / 2));
        const apex = this.fx (fc);
        let apexDone = mode !== 0;
        for (let i = 0; i <= n; ++i)
        {
            const t = i / n;
            if (! apexDone && apex <= t) { apexDone = true; pts.push ([b.x + apex * b.w, yOf (1)]); }
            pts.push ([b.x + t * b.w, yOf (mode === 0 ? bandpassMagnitude (sr, fc, w, this.xf (t)) : 1)]);
        }
        return pts;
    }

    disperserTicks (ctx, b, fc, w, color)
    {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        for (let i = 0; i < kDisperserStages; ++i)
        {
            const oct = (i - (kDisperserStages - 1) * 0.5) / (kDisperserStages - 1) * w * 4;
            const x = b.x + this.fx (fc * Math.pow (2, oct)) * b.w;
            ctx.beginPath(); ctx.moveTo (x, b.y + b.h - 4); ctx.lineTo (x, b.y + b.h); ctx.stroke();
        }
    }

    draw (ctx)
    {
        const c = colors(), b = this.box(), k = this.k;
        sketchFrame (ctx, b.x, b.y, b.w, b.h, 11);
        // quadrillage : bandes horizontales, repères de fréquence (100, 1k, 5k, 10k) et intermédiaires
        ctx.lineWidth = 1;
        ctx.strokeStyle = alpha (c.inkFaint, 0.22);
        for (let i = 1; i < 4; ++i) { const y = Math.round (b.y + b.h * i / 4) + 0.5; ctx.beginPath(); ctx.moveTo (b.x + 1, y); ctx.lineTo (b.x + b.w - 1, y); ctx.stroke(); }
        ctx.strokeStyle = alpha (c.inkFaint, 0.12);
        for (const f of [200, 300, 500, 700, 2000, 3000, 7000])
        { const x = b.x + this.fx (f) * b.w; ctx.beginPath(); ctx.moveTo (x, b.y + 1); ctx.lineTo (x, b.y + b.h - 12); ctx.stroke(); }
        ctx.font = font (9);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (const [f, t] of [[100, '100'], [1000, '1k'], [5000, '5k'], [10000, '10k']])
        {
            const x = b.x + this.fx (f) * b.w;
            ctx.strokeStyle = alpha (c.inkFaint, 0.4);
            ctx.beginPath(); ctx.moveTo (x, b.y + 1); ctx.lineTo (x, b.y + b.h - 11); ctx.stroke();
            ctx.fillStyle = c.inkSoft;
            ctx.fillText (t, x, b.y + b.h - 10);
        }

        const mode = Math.round (real (k.mode));
        const active = real (k.mix) > 0.01;
        const fc = real (k.freq), w = real (k.width);
        const base = value (k.freq).norm, wNorm = value (k.width).norm;

        // fantôme de modulation (bleu-vert) : plage atteignable de la fréquence, puis filtre à la valeur modulée en direct
        const fMod = routesFor (k.freq).length > 0, wMod = routesFor (k.width).length > 0;
        if (fMod || wMod)
        {
            if (fMod)
            {
                const [lo, hi] = modRange (k.freq, base);
                const x0 = b.x + this.fx (fromNorm (k.freq, lo)) * b.w, x1 = b.x + this.fx (fromNorm (k.freq, hi)) * b.w;
                ctx.fillStyle = alpha (c.cool, 0.1);
                ctx.fillRect (x0, b.y, Math.max (1, x1 - x0), b.h);
            }
            const lf = fMod ? liveMod (k.freq) : null, lw = wMod ? liveMod (k.width) : null;
            if (lf !== null || lw !== null)
            {
                this.gf = lf === null ? base : (this.gf ?? lf) + (lf - (this.gf ?? lf)) * 0.35;
                this.gw = lw === null ? wNorm : (this.gw ?? lw) + (lw - (this.gw ?? lw)) * 0.35;
                const gfc = fromNorm (k.freq, this.gf), gwr = fromNorm (k.width, this.gw);
                if (mode === 0)
                {
                    const pts = this.curve (b, mode, gfc, gwr);
                    ctx.beginPath(); pts.forEach (([x, y], i) => i ? ctx.lineTo (x, y) : ctx.moveTo (x, y));
                    ctx.strokeStyle = alpha (c.cool, 0.75); ctx.lineWidth = 1; ctx.stroke();
                    ctx.lineTo (b.x + b.w, b.y + b.h); ctx.lineTo (b.x, b.y + b.h); ctx.closePath();
                    ctx.fillStyle = alpha (c.cool, 0.1); ctx.fill();
                }
                else if (mode === 2) this.disperserTicks (ctx, b, gfc, gwr, alpha (c.cool, 0.7));
                const gx = b.x + this.fx (gfc) * b.w, gy = b.y + b.h - this.gw * b.h;
                ctx.strokeStyle = c.cool; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc (gx, gy, 4, 0, Math.PI * 2); ctx.stroke();
            }
        }

        // courbe principale (valeurs de base), hachurée
        const col = active ? c.warm : c.inkFaint;
        const pts = this.curve (b, mode, fc, w);
        hatch (ctx, (cx) => { pts.forEach (([x, y], i) => i ? cx.lineTo (x, y) : cx.moveTo (x, y)); cx.lineTo (b.x + b.w, b.y + b.h); cx.lineTo (b.x, b.y + b.h); cx.closePath(); },
               b, alpha (col, 0.45), 4.5, 9);
        graphite (ctx, pts, alpha (col, 0.95), 1.6, 9);
        if (mode === 2) this.disperserTicks (ctx, b, fc, w, alpha (c.warm, active ? 0.5 : 0.2));

        ctx.strokeStyle = alpha (c.line, 0.3); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo (b.x, b.y + b.h / 2); ctx.lineTo (b.x + b.w, b.y + b.h / 2); ctx.stroke();

        // le point (centre du filtre)
        const px = b.x + this.fx (fc) * b.w, py = b.y + b.h - wNorm * b.h;
        ctx.fillStyle = active ? c.warm : c.inkFaint;
        ctx.beginPath(); ctx.arc (px, py, 6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = c.paper; ctx.lineWidth = 1.5; ctx.stroke();

        ctx.fillStyle = c.inkFaint;
        ctx.font = font (10);
        ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.fillText ('Freq', b.x + b.w - 4, b.y + b.h - 12);
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText ('Width', b.x + 4, b.y + 4);
    }
}

// ============================================================================ enveloppe ADSR à poignées
// Poignées pleines : fin d'attaque, fin de decay + sustain, fin de release ; anneaux bleu-vert : courbure de chaque
// segment (glisser verticalement ; double-clic = valeur par défaut). Largeurs : EnvelopeLayout.h ; courbes : EnvelopeCurve.h.
const SHARE = { a: 0.30, d: 0.30, s: 0.10, r: 0.30 };
const stageMax = (share, W) => share * Math.max (0, W);
const stageMin = (share, W) => Math.min (6, stageMax (share, W));
const widthFromNorm = (n, share, W) => stageMin (share, W) + (stageMax (share, W) - stageMin (share, W)) * Math.min (Math.max (n, 0), 1);
function normFromWidth (w, share, W)
{
    const mx = stageMax (share, W), mn = stageMin (share, W);
    return mx - mn <= 1e-6 ? 0 : Math.min (Math.max ((w - mn) / (mx - mn), 0), 1);
}
const warp = (t, c) => { t = Math.min (Math.max (t, 0), 1); return c === 0 ? t : Math.pow (t, Math.exp (-Math.min (Math.max (c, -1), 1) * Math.log (8))); };
const midValue = (c) => warp (0.5, c);
function curveFromMid (m)
{
    m = Math.min (Math.max (m, midValue (-1)), midValue (1));
    return Math.min (Math.max (-Math.log (Math.log (m) / Math.log (0.5)) / Math.log (8), -1), 1);
}

export class EnvelopeView extends CanvasView
{
    // keys : { a, d, s, r, ac, dc, rc } (clés des paramètres)
    constructor (keys, height = 80)
    {
        super ('env', height);
        this.k = keys;
        // info-bulle selon la poignée sous le pointeur (EnvelopeShapeView::getTooltip)
        const TIPS = {
            a:  'Drag horizontally to set the Attack time.',
            ds: 'Drag horizontally to set the Decay time and vertically to set the Sustain level.',
            r:  'Drag horizontally to set the Release time.',
            ca: 'Drag vertically to bend the Attack (up = fast then slow); double-click for linear.',
            cd: 'Drag vertically to bend the Decay (up = fast then slow); double-click for linear.',
            cr: 'Drag vertically to bend the Release (up = fast then slow); double-click to restore the default.',
        };
        this.canvas.addEventListener ('pointermove', (e) => { const [x, y] = this.local (e); this.root.title = TIPS[this.hit (x, y)] ?? ''; });
        this.canvas.setAttribute ('role', 'img');
        this.canvas.setAttribute ('aria-label', 'ADSR envelope');
        watch (this, Object.values (keys));
        this.target = null;
        this.drag ({
            down: (x, y) =>
            {
                this.target = this.hit (x, y);
                if (! this.target) return false;
                // anneaux de courbure : leur position est sous ca_ / cd_ / cr_ (ca / cd / cr sont les valeurs de courbe)
                const p = this.points(), h = p[this.target.startsWith ('c') ? this.target + '_' : this.target];
                this.grab = [x - h[0], y - h[1]];
                this.invalidate();
                return true;
            },
            move: (x, y) => this.move (x - this.grab[0], y - this.grab[1]),
            up: () => { this.target = null; this.invalidate(); },
        });
        this.canvas.addEventListener ('dblclick', (e) =>
        {
            const [x, y] = this.local (e);
            const t = this.hit (x, y);
            const key = { ca: keys.ac, cd: keys.dc, cr: keys.rc }[t];
            if (key) setNorm (key, defaultNorm (key));
        });
    }

    box() { return { x: 4, y: 4, w: this.w - 8, h: this.h - 8 }; }

    points()
    {
        const b = this.box(), k = this.k, W = b.w, h = b.h, x0 = b.x, yB = b.y + b.h;
        const xA = x0 + widthFromNorm (value (k.a).norm, SHARE.a, W);
        const xD = xA + widthFromNorm (value (k.d).norm, SHARE.d, W);
        const xS = xD + stageMax (SHARE.s, W);
        const xR = xS + widthFromNorm (value (k.r).norm, SHARE.r, W);
        const sus = real (k.s), ca = real (k.ac), cd = real (k.dc), cr = real (k.rc);
        return {
            b, sus, ca, cd, cr, xS,
            a: [xA, b.y], ds: [xD, yB - sus * h], r: [xR, yB],
            ca_: [(x0 + xA) / 2, yB - warp (0.5, ca) * h, (xA - x0) >= 14 && h >= 14],
            cd_: [(xA + xD) / 2, yB - (1 - (1 - sus) * warp (0.5, cd)) * h, (xD - xA) >= 14 && (1 - sus) * h >= 14],
            cr_: [(xS + xR) / 2, yB - sus * (1 - warp (0.5, cr)) * h, (xR - xS) >= 14 && sus * h >= 14],
        };
    }

    hit (x, y)
    {
        const p = this.points();
        const d2 = (q) => (q[0] - x) ** 2 + (q[1] - y) ** 2;
        let best = null, bd = HIT * HIT;
        for (const t of ['a', 'ds', 'r']) if (d2 (p[t]) <= bd) { bd = d2 (p[t]); best = t; }
        if (best) return best;
        bd = (HIT - 2) ** 2;
        for (const t of ['ca', 'cd', 'cr']) if (p[t + '_'][2] && d2 (p[t + '_']) <= bd) { bd = d2 (p[t + '_']); best = t; }
        return best;
    }

    move (x, y)
    {
        const p = this.points(), b = p.b, k = this.k, W = b.w;
        const level = Math.min (Math.max ((b.y + b.h - y) / b.h, 0), 1);
        const xA = p.a[0], xS = p.xS;
        switch (this.target)
        {
            case 'a':  setNorm (k.a, normFromWidth (x - b.x, SHARE.a, W)); break;
            case 'ds': setNorm (k.d, normFromWidth (x - xA, SHARE.d, W)); setReal (k.s, level); break;
            case 'r':  setNorm (k.r, normFromWidth (x - xS, SHARE.r, W)); break;
            case 'ca': setReal (k.ac, curveFromMid (level)); break;
            case 'cd': if (1 - p.sus > 1e-4) setReal (k.dc, curveFromMid ((1 - level) / (1 - p.sus))); break;
            case 'cr': if (p.sus > 1e-4) setReal (k.rc, curveFromMid (1 - level / p.sus)); break;
        }
    }

    draw (ctx)
    {
        const c = colors(), p = this.points(), b = p.b, h = b.h, x0 = b.x, yB = b.y + b.h;
        sketchFrame (ctx, b.x, b.y, b.w, b.h, 21);
        const pts = [[x0, yB]];
        const seg = 24;
        for (let i = 1; i <= seg; ++i) { const t = i / seg; pts.push ([x0 + t * (p.a[0] - x0), yB - warp (t, p.ca) * h]); }
        for (let i = 1; i <= seg; ++i) { const t = i / seg; pts.push ([p.a[0] + t * (p.ds[0] - p.a[0]), yB - (1 - (1 - p.sus) * warp (t, p.cd)) * h]); }
        pts.push ([p.xS, p.ds[1]]);
        for (let i = 1; i <= seg; ++i) { const t = i / seg; pts.push ([p.xS + t * (p.r[0] - p.xS), yB - p.sus * (1 - warp (t, p.cr)) * h]); }
        hatch (ctx, (cx) => { pts.forEach (([x, y], i) => i ? cx.lineTo (x, y) : cx.moveTo (x, y)); cx.lineTo (p.r[0], yB); cx.closePath(); },
               b, alpha (c.warm, 0.45), 4.5, 8);
        graphite (ctx, pts, c.warm, 1.6, 5);

        const handle = (q, t) =>
        {
            const r = this.target === t ? 5.5 : 4.5;
            ctx.beginPath(); ctx.arc (q[0], q[1], r, 0, Math.PI * 2);
            ctx.fillStyle = alpha (c.paper, 0.85); ctx.fill();
            if (this.target !== t) { ctx.fillStyle = alpha (c.warm, 0.8); ctx.beginPath(); ctx.arc (q[0], q[1], r - 1.6, 0, Math.PI * 2); ctx.fill(); }
            ctx.strokeStyle = c.ink; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc (q[0], q[1], r, 0, Math.PI * 2); ctx.stroke();
        };
        handle (p.a, 'a'); handle (p.ds, 'ds'); handle (p.r, 'r');
        for (const t of ['ca', 'cd', 'cr'])
        {
            const q = p[t + '_'];
            if (! q[2]) continue;
            const r = this.target === t ? 4.5 : 3.5;
            ctx.beginPath(); ctx.arc (q[0], q[1], r, 0, Math.PI * 2);
            ctx.fillStyle = alpha (c.paper, 0.85); ctx.fill();
            ctx.strokeStyle = c.cool; ctx.lineWidth = 1.3; ctx.stroke();
        }
    }
}

// ============================================================================ schéma de la corde (famille CONSTRUCTION)
// Sillet à gauche, chevalet à droite. Rond : position du micro (dephasage, horizontal) et profondeur (square, vertical),
// copie en pointillés symétrique ; triangles : écart gauche/droite (pickupSpread) ; piste à droite : couplage au
// chevalet (bridgeCoupling, n'agit que si NOMBRE > 1). Les cordes se transforment avec TYPE (blend) : nette, chaotique,
// puis tube. Conversions : RezonathorDSP.h (pluckPosFromParam, pickupPositionForChannel).
const pickupX = (deph) => Math.min (Math.max (deph, 0.02), 1) * 0.5;
const dephFromX = (x) => Math.min (Math.max (x, 0.01), 0.5) * 2;
const channelX = (xc, spread, right) => Math.min (Math.max (xc + (right ? 1 : -1) * Math.min (Math.max (spread, 0), 1) * 0.2, 0.01), 0.5);
const Y = { d0: 46, d1: 22, string: 62, tri: 79, labels: 87, trackBottom: 74, trackTop: 30 };

export class StringSchematic extends CanvasView
{
    constructor()
    {
        super ('schematic', 102);
        // info-bulle selon le repère sous le pointeur (StringSchematicComponent::getTooltip)
        const TIPS = {
            pickup: 'Pickup position and depth (one comb per string). Drag sideways: position along the string (Pickup position). '
                  + 'Drag up/down: depth of the comb (Pickup depth, 0 = off). At the middle, even harmonics are cancelled. '
                  + 'The dashed copy is the mirror: the comb is identical at x and 1 - x. Double-click: reset both.',
            spread: 'Pickup spread: the left and right channels read the string at different points (up to 0.2 of the string '
                  + 'each way at 1). Drag a triangle sideways. Double-click: reset to 0 (same point on both channels).',
            bridge: 'Bridge coupling between the strings of a note (needs NUM > 1): the in-phase motion dies faster than the '
                  + 'out-of-phase motion (double decay of a piano). Drag up/down. Double-click: reset to 0.',
        };
        const base = 'String schematic: nut on the left, bridge on the right. Every marker is also available as a knob.';
        this.root.title = base;
        this.canvas.addEventListener ('pointermove', (e) => { const [x, y] = this.local (e); this.root.title = TIPS[this.hit (x, y)?.kind] ?? base; });
        this.canvas.setAttribute ('role', 'img');
        this.canvas.setAttribute ('aria-label', 'String schematic');
        watch (this, ['dephasage', 'square', 'pickupSpread', 'bridgeCoupling', 'numStrings', 'blend']);
        this.active = null;
        this.drag ({
            down: (x, y) =>
            {
                const h = this.hit (x, y);
                if (! h) return false;
                if (h.kind === 'pickup')
                {
                    const d = real ('dephasage'), s = real ('pickupSpread');
                    h.grab = pickupX (d) - channelX (pickupX (d), s, h.right);
                }
                this.active = h;
                return true;
            },
            move: (x, y) => this.move (x, y),
            up: () => { this.active = null; this.invalidate(); },
        });
        this.canvas.addEventListener ('dblclick', (e) =>
        {
            const [x, y] = this.local (e);
            const h = this.hit (x, y);
            const keys = { pickup: ['dephasage', 'square'], spread: ['pickupSpread'], bridge: ['bridgeCoupling'] }[h?.kind] ?? [];
            for (const k of keys) setNorm (k, defaultNorm (k));
        });
    }

    resize()
    {
        super.resize();
        this.x0 = 24;
        this.x1 = Math.max (this.x0 + 60, this.w - 66);
        this.trackX = Math.min (this.w - 22, this.x1 + 40);
    }

    px (x) { return this.x0 + Math.min (Math.max (x, 0), 1) * (this.x1 - this.x0); }
    xOf (px) { return this.x1 > this.x0 ? Math.min (Math.max ((px - this.x0) / (this.x1 - this.x0), 0), 1) : 0; }
    yDepth (d) { return Y.d0 + Math.min (Math.max (d, 0), 1) * (Y.d1 - Y.d0); }
    strings() { return Math.min (3, Math.max (1, Math.round (real ('numStrings')))); }
    stringY (i, S) { return Y.string + (i - 0.5 * (S - 1)) * 7; }

    hit (x, y)
    {
        const by = Y.trackBottom + value ('bridgeCoupling').norm * (Y.trackTop - Y.trackBottom);
        if ((x - this.trackX) ** 2 + (y - by) ** 2 <= HIT * HIT) return { kind: 'bridge' };
        const d = real ('dephasage'), s = real ('pickupSpread'), xc = pickupX (d);
        const pr = [channelX (xc, s, false), channelX (xc, s, true)];
        let best = null, bd = HIT * HIT;
        const consider = (kind, xs, mirrored, right, cy) =>
        {
            const cx = this.px (mirrored ? 1 - xs : xs);
            const dd = (x - cx) ** 2 + (y - cy) ** 2;
            if (dd <= bd) { bd = dd; best = { kind, mirrored, right }; }
        };
        for (const mirrored of [true, false])
        {
            consider ('spread', pr[0], mirrored, false, Y.tri);
            consider ('spread', pr[1], mirrored, true, Y.tri);
            consider ('pickup', pr[0], mirrored, false, this.yDepth (real ('square')));
            consider ('pickup', pr[1], mirrored, true, this.yDepth (real ('square')));
        }
        return best;
    }

    move (x, y)
    {
        const a = this.active;
        if (! a) return;
        const raw = this.xOf (x), xm = a.mirrored ? 1 - raw : raw;
        if (a.kind === 'pickup')
        {
            setReal ('dephasage', dephFromX (Math.min (Math.max (xm + a.grab, 0.01), 0.5)));
            setReal ('square', Math.min (Math.max ((y - Y.d0) / (Y.d1 - Y.d0), 0), 1));
        }
        else if (a.kind === 'spread')
            setReal ('pickupSpread', Math.min (Math.abs (xm - pickupX (real ('dephasage'))) / 0.2, 1));
        else if (a.kind === 'bridge')
            setNorm ('bridgeCoupling', (y - Y.trackBottom) / (Y.trackTop - Y.trackBottom));
    }

    draw (ctx)
    {
        const c = colors();
        sketchFrame (ctx, 1, 1, this.w - 2, this.h - 2, 31);
        const S = this.strings();
        const depth = real ('square'), depthOff = depth <= 0.0005 && ! routesFor ('square').length;
        const bridgeN = value ('bridgeCoupling').norm, bridgeOff = S <= 1;

        // axe de symétrie (milieu) et axe de profondeur à gauche
        ctx.save();
        ctx.setLineDash ([2, 4]);
        ctx.strokeStyle = c.line; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo (this.px (0.5), Y.d1 - 4); ctx.lineTo (this.px (0.5), Y.tri + 6); ctx.stroke();
        ctx.restore();
        graphite (ctx, [[10, Y.d0], [10, Y.d1]], c.inkFaint, 1, 3);
        graphite (ctx, [[7, Y.d0], [13, Y.d0]], c.inkFaint, 1, 4);
        graphite (ctx, [[7, Y.d1], [13, Y.d1]], c.inkFaint, 1, 5);

        // sillet et chevalet (le chevalet rougit avec le couplage)
        const top = this.stringY (0, S) - 12, bottom = this.stringY (S - 1, S) + 12;
        graphite (ctx, [[this.x0, top], [this.x0, bottom]], c.ink, 2.4, 11);
        graphite (ctx, [[this.x1, top], [this.x1, bottom]], S > 1 && bridgeN > 0.02 ? c.warm : c.ink, 2.4 + (S > 1 ? 2 * bridgeN : 0), 12);
        ctx.fillStyle = c.inkSoft;
        ctx.font = font (10);
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText ('nut', this.x0, Y.labels);
        ctx.fillText ('bridge', this.x1, Y.labels);

        // cordes : TYPE (blend, modulé en direct si une route le vise) -> nette, chaotique, tube
        const bl = liveMod ('blend') ?? value ('blend').norm;
        const chaos = bl <= 0.5 ? bl * 2 : (1 - bl) * 2, tube = Math.min (Math.max ((bl - 0.5) * 2, 0), 1);
        for (let i = 0; i < S; ++i) this.drawString (ctx, c, this.stringY (i, S), i, S, chaos, tube);

        // micros (copie en pointillés d'abord, puis l'original par-dessus)
        const xc = pickupX (real ('dephasage')), sp = real ('pickupSpread');
        const pr = [channelX (xc, sp, false), channelX (xc, sp, true)];
        const split = Math.abs (pr[1] - pr[0]) > 1e-4;
        for (const mirrored of [true, false])
        {
            for (const [i, xs] of pr.entries())
            {
                if (i === 1 && ! split) continue;
                this.marker (ctx, c, xs, mirrored, depth, depthOff, false, S);
                this.triangle (ctx, c, xs, mirrored, depthOff, false);
            }
        }
        if (split)
        {
            ctx.fillStyle = c.inkSoft; ctx.font = font (10); ctx.textBaseline = 'top';
            const cy = this.yDepth (depth) - 16;
            ctx.fillText ('L', this.px (pr[0]), cy);
            ctx.fillText ('R', this.px (pr[1]), cy);
        }

        // piste du chevalet
        const a = bridgeOff ? 0.35 : 1;
        ctx.fillStyle = alpha (c.ink, a); ctx.font = font (10); ctx.textBaseline = 'top';
        ctx.fillText ('Bridge', this.trackX, Y.trackTop - 20);
        graphite (ctx, [[this.trackX, Y.trackTop], [this.trackX, Y.trackBottom]], alpha (c.inkSoft, a), 1.3, 31);
        graphite (ctx, [[this.trackX - 4, Y.trackBottom], [this.trackX + 4, Y.trackBottom]], alpha (c.inkSoft, a), 1.3, 32);
        this.dot (ctx, c, this.trackX, Y.trackBottom + bridgeN * (Y.trackTop - Y.trackBottom), 6, ! bridgeOff, a);

        // fantômes (valeurs modulées en direct)
        const lm = (k) => routesFor (k).length ? liveMod (k) : null;
        const gd = lm ('dephasage'), gq = lm ('square'), gs = lm ('pickupSpread'), gb = lm ('bridgeCoupling');
        if (gd !== null || gq !== null || gs !== null)
        {
            const d = gd !== null ? fromNorm ('dephasage', gd) : real ('dephasage');
            const q = gq !== null ? fromNorm ('square', gq) : depth;
            const s = gs !== null ? fromNorm ('pickupSpread', gs) : sp;
            const gxc = pickupX (d);
            const gpr = [channelX (gxc, s, false), channelX (gxc, s, true)];
            for (const xs of gpr) { this.marker (ctx, c, xs, false, q, false, true, S); this.triangle (ctx, c, xs, false, false, true); }
        }
        if (gb !== null)
        {
            ctx.strokeStyle = c.cool; ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.arc (this.trackX, Y.trackBottom + gb * (Y.trackTop - Y.trackBottom), 4.5, 0, Math.PI * 2); ctx.stroke();
        }
    }

    drawString (ctx, c, y, index, S, chaos, tube)
    {
        const seed = 20 + index;
        const sa = Math.min (Math.max (1 - tube * 1.3, 0), 1);
        if (sa > 0.01)
        {
            const pts = [[this.x0, y]];
            if (chaos < 0.02) pts.push ([this.x1, y]);
            else
            {
                const r = rng (seed * 977 + 13);
                const amp = chaos * (S > 1 ? 2.6 : 4);
                const n = Math.max (4, Math.floor ((this.x1 - this.x0) / 5));
                let prev = 0;
                for (let k = 1; k <= n; ++k)
                {
                    prev = prev * 0.35 + (r() - 0.5) * 2 * amp * 0.65;
                    pts.push ([this.x0 + (this.x1 - this.x0) * k / n, y + (k === n ? 0 : prev)]);
                }
            }
            graphite (ctx, pts, alpha (c.ink, sa), 1.1 + chaos * 0.3, seed);
        }
        if (tube > 0.02)
        {
            const half = Math.max (0.7, tube * (S > 1 ? 3 : 7)), a = Math.min (tube * 3, 1), xe = this.x1 - half * 0.7;
            ctx.fillStyle = alpha (c.paper, 0.55 * a);
            ctx.fillRect (this.x0, y - half, xe - this.x0, half * 2);
            hatch (ctx, (cx) => cx.rect (this.x0, y + half * 0.25, xe - this.x0, half * 0.75),
                   { x: this.x0, y: y + half * 0.25, w: xe - this.x0, h: half * 0.75 }, alpha (c.ink, 0.35 * a), 2.2, seed + 3);
            graphite (ctx, [[this.x0, y - half], [xe, y - half]], alpha (c.ink, a), 1.1, seed + 5);
            graphite (ctx, [[this.x0, y + half], [xe, y + half]], alpha (c.ink, a), 1.1, seed + 6);
            ctx.beginPath(); ctx.ellipse (xe, y, half * 0.55, half, 0, 0, Math.PI * 2);
            ctx.fillStyle = alpha (c.paper, 0.8 * a); ctx.fill();
            ctx.strokeStyle = alpha (c.ink, a); ctx.lineWidth = 1.1; ctx.stroke();
        }
    }

    dot (ctx, c, x, y, r, filled, a = 1)
    {
        ctx.beginPath(); ctx.arc (x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = alpha (c.paper, 0.7 * a); ctx.fill();
        if (filled) hatch (ctx, (cx) => cx.arc (x, y, r, 0, Math.PI * 2), { x: x - r, y: y - r, w: 2 * r, h: 2 * r }, alpha (c.warm, 0.9 * a), 2.4, Math.round (x));
        ctx.strokeStyle = alpha (filled ? c.ink : c.inkSoft, a); ctx.lineWidth = 1.1;
        ctx.beginPath(); ctx.arc (x, y, r, 0, Math.PI * 2); ctx.stroke();
    }

    marker (ctx, c, xs, mirrored, depth, depthOff, ghost, S)
    {
        const cx = this.px (mirrored ? 1 - xs : xs), cy = this.yDepth (depth), sTop = this.stringY (0, S);
        ctx.save();
        ctx.strokeStyle = alpha (ghost ? c.cool : c.inkSoft, mirrored ? 0.5 : 0.8);
        ctx.lineWidth = 1;
        if (mirrored) ctx.setLineDash ([2, 3]);
        ctx.beginPath(); ctx.moveTo (cx, sTop); ctx.lineTo (cx, cy); ctx.stroke();
        ctx.restore();
        if (ghost) { ctx.strokeStyle = c.cool; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc (cx, cy, 4.5, 0, Math.PI * 2); ctx.stroke(); }
        else if (mirrored)
        {
            ctx.save(); ctx.setLineDash ([3, 3]);
            ctx.strokeStyle = alpha (c.warm, depthOff ? 0.4 : 0.8); ctx.lineWidth = 1.4;
            ctx.beginPath(); ctx.arc (cx, cy, 6, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
        }
        else this.dot (ctx, c, cx, cy, 6, ! depthOff);
    }

    triangle (ctx, c, xs, mirrored, dim, ghost)
    {
        const cx = this.px (mirrored ? 1 - xs : xs), y = Y.tri;
        ctx.save();
        ctx.beginPath(); ctx.moveTo (cx, y - 5); ctx.lineTo (cx - 5, y + 3); ctx.lineTo (cx + 5, y + 3); ctx.closePath();
        if (ghost) { ctx.strokeStyle = c.cool; ctx.lineWidth = 1.1; ctx.stroke(); }
        else if (mirrored) { ctx.setLineDash ([2, 2]); ctx.strokeStyle = alpha (c.inkSoft, dim ? 0.3 : 0.55); ctx.lineWidth = 1.2; ctx.stroke(); }
        else { ctx.fillStyle = alpha (c.inkSoft, dim ? 0.4 : 1); ctx.fill(); }
        ctx.restore();
    }
}

// ============================================================================ courbe de saturation (famille SATURATION)
export class SaturationView extends CanvasView
{
    constructor()
    {
        super ('sat', 120);
        this.root.title = 'Transfer curve of the saturation (output vs input) for the current Curve and Drive.';
        this.canvas.setAttribute ('role', 'img');
        this.canvas.setAttribute ('aria-label', 'Saturation curve');
        watch (this, ['distortionCurve', 'drive']);
    }

    draw (ctx, w, h)
    {
        const c = colors(), b = { x: 2, y: 2, w: w - 4, h: h - 4 };
        sketchFrame (ctx, b.x, b.y, b.w, b.h, 41);
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        ctx.strokeStyle = alpha (c.line, 0.4); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo (b.x, cy); ctx.lineTo (b.x + b.w, cy); ctx.moveTo (cx, b.y); ctx.lineTo (cx, b.y + b.h); ctx.stroke();
        ctx.strokeStyle = alpha (c.line, 0.25);
        ctx.beginPath(); ctx.moveTo (b.x, b.y + b.h); ctx.lineTo (b.x + b.w, b.y); ctx.stroke();
        const curve = Math.round (real ('distortionCurve')), drive = real ('drive');
        const pts = [];
        for (let i = 0; i <= 120; ++i)
        {
            const x = -1 + 2 * i / 120;
            const y = Math.min (Math.max (store.model.softClip (curve, drive, x), -1), 1);
            pts.push ([cx + x * b.w / 2, cy - y * b.h / 2]);
        }
        graphite (ctx, pts, c.warm, 2, 7);
    }
}

// ============================================================================ forme d'un LFO (onglet Mod)
export class LfoView extends CanvasView
{
    constructor (sfx)
    {
        super ('lfo', 50);
        this.keys = [`modLfoWaveform${sfx}`, `modLfoDepth${sfx}`, `modLfoRandomSmooth${sfx}`];
        this.canvas.setAttribute ('role', 'img');
        this.canvas.setAttribute ('aria-label', 'LFO waveform');
        watch (this, this.keys);
    }

    draw (ctx, w, h)
    {
        const c = colors(), b = { x: 4, y: 4, w: w - 8, h: h - 8 };
        sketchFrame (ctx, b.x, b.y, b.w, b.h, 51);
        ctx.strokeStyle = alpha (c.line, 0.6); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo (b.x, b.y + b.h / 2); ctx.lineTo (b.x + b.w, b.y + b.h / 2); ctx.stroke();
        const [wk, dk, sk] = this.keys;
        const s = store.model.lfoPreview (Math.round (real (wk)), real (dk), real (sk));   // même code que le moteur (ModLFO)
        const amp = b.h / 2 - 3;
        const pts = Array.from (s, (v, i) => [b.x + b.w * i / (s.length - 1), b.y + b.h / 2 - Math.min (Math.max (v, -1), 1) * amp]);
        graphite (ctx, pts, c.warm, 2, 9);
    }
}

// ============================================================================ mapping Velocity / Pitch (onglet Mod)
// Abscisse : entrée MIDI brute 0..127 ; ordonnée : sortie 0..1. Poignées : (In Min, Out Min) et (In Max, Out Max) ;
// ailleurs : la courbe (glisser vertical). Point bleu-vert : dernière entrée reçue, en direct.
const mapMidiInput = (raw01, inMin, inMax) =>
{
    const v = raw01 * 127;
    if (inMax <= inMin) return v >= inMin ? 1 : 0;
    return Math.min (Math.max ((v - inMin) / (inMax - inMin), 0), 1);
};

export class MappingView extends CanvasView
{
    constructor (prefix, source)
    {
        super ('mapping', 80);
        this.p = prefix;
        this.source = source;
        this.k = { mn: `${prefix}Min`, mx: `${prefix}Max`, cv: `${prefix}Curve`, inMin: `${prefix}InMin`, inMax: `${prefix}InMax` };
        this.root.title = 'Drag a handle: input (horizontal) and output (vertical). Elsewhere: curve (vertical).';
        this.canvas.setAttribute ('role', 'img');
        this.canvas.setAttribute ('aria-label', 'Mapping curve');
        for (const k of Object.values (this.k)) on (k, () => this.invalidate());
        onLive (() => this.invalidate());
        this.target = null;
        this.drag ({
            down: (x, y) =>
            {
                const h = this.handles();
                const d2 = (q) => (q[0] - x) ** 2 + (q[1] - y) ** 2;
                this.target = d2 (h[0]) <= (HIT + 1) ** 2 ? 'min' : d2 (h[1]) <= (HIT + 1) ** 2 ? 'max' : 'curve';
                this.y0 = y;
                this.c0 = real (this.k.cv);
                return true;
            },
            move: (x, y) =>
            {
                const b = this.box();
                const xin = Math.round (Math.min (Math.max ((x - b.x) / b.w, 0), 1) * 127);
                const v = Math.min (Math.max ((b.y + b.h - y) / b.h, 0), 1);
                if (this.target === 'min') { setReal (this.k.mn, v); setReal (this.k.inMin, xin); }
                else if (this.target === 'max') { setReal (this.k.mx, v); setReal (this.k.inMax, xin); }
                else setReal (this.k.cv, this.c0 * Math.pow (2, -(this.y0 - y) / 100));   // multiplicatif, comme le plugin
            },
            up: () => { this.target = null; this.invalidate(); },
        });
    }

    box() { return { x: 4, y: 4, w: this.w - 8, h: this.h - 8 }; }

    handles()
    {
        const b = this.box(), k = this.k;
        return [[b.x + real (k.inMin) / 127 * b.w, b.y + b.h - Math.min (Math.max (real (k.mn), 0), 1) * b.h],
                [b.x + real (k.inMax) / 127 * b.w, b.y + b.h - Math.min (Math.max (real (k.mx), 0), 1) * b.h]];
    }

    draw (ctx)
    {
        const c = colors(), b = this.box(), k = this.k;
        sketchFrame (ctx, b.x, b.y, b.w, b.h, 61);
        const mn = real (k.mn), mx = real (k.mx), cv = real (k.cv), inMin = real (k.inMin), inMax = real (k.inMax);
        const pts = [];
        for (let i = 0; i <= 96; ++i)
        {
            const raw = i / 96;
            const y01 = Math.min (Math.max (mn + Math.pow (mapMidiInput (raw, inMin, inMax), cv) * (mx - mn), 0), 1);
            pts.push ([b.x + raw * b.w, b.y + b.h - y01 * b.h]);
        }
        graphite (ctx, pts, c.warm, 2, 6);
        for (const [i, q] of this.handles().entries())
        {
            const on = this.target === (i ? 'max' : 'min');
            ctx.beginPath(); ctx.arc (q[0], q[1], on ? 5 : 3.5, 0, Math.PI * 2);
            ctx.fillStyle = on ? c.paper : c.warm; ctx.fill();
            ctx.strokeStyle = c.ink; ctx.lineWidth = 1; ctx.stroke();
        }
        if (store.live)
        {
            const rawIn = this.source === 2 ? store.live.velIn : store.live.pitchIn;
            const out = store.live.sources[this.source];
            ctx.fillStyle = c.cool;
            ctx.beginPath(); ctx.arc (b.x + rawIn * b.w, b.y + b.h - Math.min (Math.max (out, 0), 1) * b.h, 3.5, 0, Math.PI * 2); ctx.fill();
        }
    }
}

// ============================================================================ panneau des sources de modulation
// Une tuile par source active (LFO 1-4, Envelope 1-2, Env Follower 1-2, Velocity, Pitch), avec sa jauge en direct.
// Glisser une tuile sur un contrôle crée une route (profondeur 0,5) ; sur écran tactile, toucher la tuile puis le
// contrôle. « + » active l'instance suivante (LFO jusqu'à 4, les autres 2) ; « × » la retire avec ses routes.
export function modPanel (onOpen)
{
    const root = el ('div', 'modpanel');
    const head = el ('p', 'modpanel-label', 'Modulation (drag a source onto a parameter):');
    const row = el ('div', 'tiles');
    root.append (head, row);
    const tiles = new Map();
    const levels = new Map();

    const enabledNext = (src) =>   // « + » d'une tuile de base : première instance inactive de sa famille
    {
        if (src.id === 0) return SOURCES.filter (s => s.family === 0 && s.enable).find (s => real (s.enable) < 0.5);
        const twin = { 4: 8, 5: 9 }[src.id];
        const s = SOURCES.find (x => x.id === twin);
        return s && real (s.enable) < 0.5 ? s : null;
    };

    for (const src of SOURCES)
    {
        const t = el ('div', `tile ${src.note ? 'note' : ''}`);
        t.dataset.source = src.id;
        t.tabIndex = 0;
        t.setAttribute ('role', 'button');
        t.setAttribute ('aria-label', `Modulation source ${src.name}`);
        const name = el ('span', 'tile-name', src.name);
        const meter = el ('span', 'tile-meter');
        const fill = el ('span', 'tile-fill');
        meter.append (fill);
        t.append (name, meter);
        levels.set (src.id, { fill, smooth: null, bipolar: !! src.bipolar });
        if (src.enable)
        {
            const x = el ('button', 'tile-btn', 'x');
            x.type = 'button';
            x.title = `Remove ${src.name} (and its routes)`;
            x.setAttribute ('aria-label', x.title);
            x.addEventListener ('click', (e) => { e.stopPropagation(); setNorm (src.enable, 0); removeRoutesOfSource (src.id); });
            t.append (x);
        }
        else if (! src.note)
        {
            const plus = el ('button', 'tile-btn', '+');
            plus.type = 'button';
            plus.title = `Add an instance (${src.id === 0 ? 'LFO 2 to 4' : src.name + ' 2'})`;
            plus.setAttribute ('aria-label', plus.title);
            plus.addEventListener ('click', (e) => { e.stopPropagation(); const n = enabledNext (src); if (n) setNorm (n.enable, 1); });
            t.append (plus);
        }
        tileDrag (t, src, onOpen);
        row.append (t);
        tiles.set (src.id, t);
        if (src.enable) on (src.enable, (v) => { t.hidden = v.real < 0.5; });
    }

    // jauges : lissées (1 pôle), recentrées pour les sources bipolaires ; ~30 Hz
    onLive (() =>
    {
        for (const [id, l] of levels)
        {
            const raw = store.live.sources[id] ?? 0;
            const target = l.bipolar ? raw * 0.5 + 0.5 : raw;
            l.smooth = l.smooth === null ? target : l.smooth + (target - l.smooth) * 0.35;
            l.fill.style.transform = `scaleX(${Math.min (Math.max (l.smooth, 0), 1).toFixed (3)})`;
        }
    });
    return root;
}

// glisser-déposer d'une tuile (souris et doigt, par événements pointeur) ; clic / toucher court = ouvrir sa section (onOpen)
function tileDrag (tile, src, onOpen)
{
    tile.addEventListener ('pointerdown', (e) =>
    {
        if (e.button !== 0 || e.target.closest ('.tile-btn')) return;
        e.preventDefault();   // pas de sélection de texte pendant le glisser
        const x0 = e.clientX, y0 = e.clientY;
        let ghost = null, over = null;
        tile.setPointerCapture (e.pointerId);
        const targetAt = (x, y) => document.elementFromPoint (x, y)?.closest ('[data-mod-key]') ?? null;
        const mv = (ev) =>
        {
            if (! ghost && Math.hypot (ev.clientX - x0, ev.clientY - y0) > 6)
            {
                ghost = el ('div', 'tile-ghost', src.name);
                document.body.append (ghost);
            }
            if (! ghost) return;
            ghost.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY + 8}px)`;
            const t = targetAt (ev.clientX, ev.clientY);
            if (t !== over) { over?.classList.remove ('drop-hover'); t?.classList.add ('drop-hover'); over = t; }
        };
        const end = (ev) =>
        {
            tile.removeEventListener ('pointermove', mv);
            tile.removeEventListener ('pointerup', end);
            tile.removeEventListener ('pointercancel', end);
            over?.classList.remove ('drop-hover');
            if (ghost)
            {
                ghost.remove();
                if (over && ev.type === 'pointerup') addRoute (src.id, over.dataset.modKey);
            }
            else if (ev.type === 'pointerup') onOpen (src);
        };
        tile.addEventListener ('pointermove', mv);
        tile.addEventListener ('pointerup', end);
        tile.addEventListener ('pointercancel', end);
    });
    tile.addEventListener ('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen (src); } });
}

export { controlLabels };
