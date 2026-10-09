// widgets.js -- contrôles de l'interface, dessinés comme ceux du plugin (Source/RezonathorLookAndFeel.h,
// ModulationUI.h) : bouton rotatif au crayon (graduations, cadran hachuré, arc de valeur rouge sépia), case de valeur
// éditable, curseur horizontal, menu, case à cocher à croix, et le marqueur de modulation bleu-vert.
//
// Chaque contrôle est lié à UN paramètre du Core par sa clé (Source/Core/RezoParams.h) et passe par store.js :
// geste -> valeur normalisée -> modèle + worklet. L'affichage suit les abonnements (preset, autre contrôle lié…).

import { store, param, on, value, setNorm, setReal, defaultNorm, fromNorm, routesFor, onRoutes, onLive, liveMod,
         modRange, updateRoute, removeRoute, sourceInfo } from './store.js';
import { svg, rng, hashString, wobblyCirclePath } from './sketch.js';

// ---------------------------------------------------------------- DOM
export function el (tag, cls = '', text = '')
{
    const e = document.createElement (tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

// ---------------------------------------------------------------- textes
// Les choix s'affichent avec les noms du plugin (ceux du Core, sauvegardés dans les presets) ; les valeurs comme la case
// de texte des sliders JUCE (AudioParameterFloat::getText) : décimales tirées du pas du paramètre (« decimals », calculé
// par web_api.cpp), entiers sans décimale, et pas d'unité.
export const choiceLabel = (c) => c;

export function formatValue (p, real)
{
    if (p.kind === 'choice') return choiceLabel (p.choices[Math.round (real)] ?? String (real));
    if (p.kind === 'bool') return real > 0.5 ? 'On' : 'Off';
    if (p.kind === 'int') return String (Math.round (real));
    return real.toFixed (p.decimals ?? 7);
}

const parseNumber = (text) => parseFloat (String (text).replace (',', '.').replace (/[^0-9eE+\-.]/g, ''));

// ---------------------------------------------------------------- géométrie des boutons rotatifs
// Angles de JUCE (slider rotatif par défaut) : de 1,2 pi à 2,8 pi, comptés depuis midi dans le sens horaire.
const A0 = -0.8 * Math.PI, A1 = 0.8 * Math.PI;
const angleOf = (n) => A0 + Math.min (1, Math.max (0, n)) * (A1 - A0);
const pt = (a, r) => [50 + r * Math.sin (a), 50 - r * Math.cos (a)];
const f2 = (v) => v.toFixed (2);

function arcPath (a0, a1, r)
{
    if (a1 < a0) [a0, a1] = [a1, a0];
    if (a1 - a0 < 0.001) return '';
    const [x0, y0] = pt (a0, r), [x1, y1] = pt (a1, r);
    return `M${f2 (x0)} ${f2 (y0)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${f2 (x1)} ${f2 (y1)}`;
}

let clipCounter = 0;

// Partie fixe du bouton (graduations, cadran, hachures) : dessinée une fois. Repère 100 x 100, rayon extérieur 47 ;
// les épaisseurs de trait sont en pixels (CSS, vector-effect: non-scaling-stroke), comme dans drawRotarySlider.
function knobFace (s, seed, ticks)
{
    const r = rng (seed);
    const j = (a) => (r() - 0.5) * 2 * a;
    const R = 47, body = R * 0.62;
    for (let i = 0; i <= ticks; ++i)
    {
        const a = A0 + i / ticks * (A1 - A0) + j (0.015);
        const major = i % (ticks >= 12 ? 4 : 2) === 0;
        const ro = R - 1 + j (0.6), ri = ro - (major ? R * 0.22 : R * 0.12) + j (0.8);
        const [x0, y0] = pt (a, ro), [x1, y1] = pt (a, ri);
        svg ('line', { x1: f2 (x0), y1: f2 (y0), x2: f2 (x1), y2: f2 (y1), class: major ? 'tick major' : 'tick' }, s);
    }
    const d = wobblyCirclePath (50, 50, body, 0.018, r);
    svg ('path', { d, class: 'face' }, s);
    // hachures d'ombre dans le quart bas-droit du cadran (clip : cadran ET quart bas-droit)
    const id = `kc${++clipCounter}`;
    const defs = svg ('defs', {}, s);
    svg ('path', { d }, svg ('clipPath', { id }, defs));
    svg ('rect', { x: 50, y: 50, width: body + 2, height: body + 2 }, svg ('clipPath', { id: `${id}q` }, defs));
    const g = svg ('g', { 'clip-path': `url(#${id})`, class: 'shade' }, svg ('g', { 'clip-path': `url(#${id}q)` }, s));
    const step = Math.max (2.8, body * 0.16);
    for (let dd = -body; dd < body * 1.6; dd += step)
        svg ('line', { x1: f2 (50 + dd), y1: f2 (50 + body * 0.15), x2: f2 (50 + dd - body * 0.7), y2: f2 (50 + body * 1.05) }, g);
    svg ('path', { d, class: 'rim' }, s);
    svg ('path', { d, class: 'rim ghost', transform: 'translate(0.6 -0.4)' }, s);
    return body;
}

// ---------------------------------------------------------------- bouton rotatif
// opts : size 'prim' | 'sec' ; tip ; ends [gauche, droite] ; format (real) ; parse (texte) -> réel ; mid (libellé à mi-course)
export function knob (key, label, opts = {})
{
    const p = param (key);
    const prim = opts.size === 'prim';
    const root = el ('div', `ctl knob ${prim ? 'prim' : 'sec'}`);
    root.dataset.modKey = key;
    const lab = el ('label', 'lbl', label);
    lab.title = opts.tip ?? `${p.name}`;
    const id = `k_${key}_${++clipCounter}`;
    lab.htmlFor = id;

    const dial = el ('div', 'dial');
    dial.tabIndex = 0;
    dial.setAttribute ('role', 'slider');
    dial.setAttribute ('aria-label', label);
    dial.setAttribute ('aria-valuemin', '0');
    dial.setAttribute ('aria-valuemax', '100');
    dial.title = opts.tip ?? p.name;
    const s = svg ('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' });
    knobFace (s, hashString (key), prim ? 24 : 16);
    const modArc = svg ('path', { class: 'mod-range' }, s);
    // arc de valeur au crayon de couleur : un trait net et deux passages plus pâles, légèrement décalés (strokeGraphite)
    const arc = svg ('path', { class: 'value-arc' }, s);
    const arc1 = svg ('path', { class: 'value-arc g1', transform: 'translate(0.5 -0.4)' }, s);
    const arc2 = svg ('path', { class: 'value-arc g2', transform: 'translate(-0.7 0.6)' }, s);
    const needle = svg ('path', { class: 'needle' }, s);
    svg ('circle', { cx: 50, cy: 50, r: 2.1, class: 'hub' }, s);
    const modDot = svg ('circle', { r: 3.6, class: 'mod-dot' }, s);
    dial.append (s);

    const val = el ('input', 'val');
    val.id = id;
    val.type = 'text';
    val.inputMode = 'decimal';
    val.autocomplete = 'off';
    val.spellcheck = false;

    root.append (lab, dial, val);
    if (opts.mid) { const m = el ('span', 'mid', opts.mid); dial.append (m); }
    if (opts.ends)
    {
        const e0 = el ('span', 'end lo', opts.ends[0]), e1 = el ('span', 'end hi', opts.ends[1]);
        dial.append (e0, e1);
    }
    const badge = modBadge (key, label);
    root.append (badge);

    const fmt = (r) => (opts.format ?? ((x) => formatValue (p, x))) (r);
    let norm = 0;
    const show = (v) =>
    {
        norm = v.norm;
        const a = angleOf (v.norm);
        const d = arcPath (A0, a, 37.2);
        arc.setAttribute ('d', d);
        arc1.setAttribute ('d', d);
        arc2.setAttribute ('d', d);
        const tip = pt (a, 26.8), mid = pt (a + 0.04, 13.4);
        needle.setAttribute ('d', `M50 50Q${f2 (mid[0])} ${f2 (mid[1])} ${f2 (tip[0])} ${f2 (tip[1])}`);
        if (document.activeElement !== val) val.value = fmt (v.real);
        dial.setAttribute ('aria-valuenow', String (Math.round (v.norm * 100)));
        dial.setAttribute ('aria-valuetext', fmt (v.real));
        drawRange();
    };

    // --- modulation : plage atteignable (statique) + point en direct (lissé comme dans le plugin)
    let smooth = null;
    const drawRange = () =>
    {
        const modded = routesFor (key).length > 0;
        root.classList.toggle ('modded', modded);
        if (! modded) { modArc.setAttribute ('d', ''); modDot.style.display = 'none'; smooth = null; return; }
        const [lo, hi] = modRange (key, norm);
        modArc.setAttribute ('d', arcPath (angleOf (lo), angleOf (hi), 45));
    };
    on (key, show);
    onRoutes (drawRange);
    onLive (() =>
    {
        const m = liveMod (key);
        if (m === null || ! root.classList.contains ('modded')) { modDot.style.display = 'none'; return; }
        smooth = smooth === null ? m : smooth + (m - smooth) * 0.35;
        const [x, y] = pt (angleOf (smooth), 45);
        modDot.setAttribute ('cx', f2 (x));
        modDot.setAttribute ('cy', f2 (y));
        modDot.style.display = '';
    });

    // --- gestes : glisser (haut / droite = plus), Maj = fin, double-clic = défaut, flèches au clavier
    dial.style.touchAction = 'none';
    dial.addEventListener ('pointerdown', (e) =>
    {
        if (e.button !== 0) return;
        e.preventDefault();
        dial.focus ({ preventScroll: true });
        dial.setPointerCapture (e.pointerId);
        const x0 = e.clientX, y0 = e.clientY, n0 = norm;
        const span = prim ? 240 : 200;
        const mv = (ev) =>
        {
            const k = ev.shiftKey ? 0.2 : 1;
            setNorm (key, n0 + ((ev.clientX - x0) - (ev.clientY - y0)) / span * k);
        };
        const end = () => { dial.removeEventListener ('pointermove', mv); dial.removeEventListener ('pointerup', end); dial.removeEventListener ('pointercancel', end); };
        dial.addEventListener ('pointermove', mv);
        dial.addEventListener ('pointerup', end);
        dial.addEventListener ('pointercancel', end);
    });
    dial.addEventListener ('dblclick', () => setNorm (key, defaultNorm (key)));
    dial.addEventListener ('contextmenu', (e) => { if (routesFor (key).length) { e.preventDefault(); openRoutes (key, label, dial); } });
    dial.addEventListener ('keydown', (e) =>
    {
        const stepKeys = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 };
        let n = null;
        if (e.key in stepKeys) n = norm + stepKeys[e.key] * (e.shiftKey ? 0.001 : 0.01);
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = 1;
        if (n === null) return;
        e.preventDefault();
        e.stopPropagation();
        setNorm (key, n);
    });

    valueBox (val, key, fmt, opts.parse);
    return {
        root,
        setLabel (t) { lab.textContent = t; dial.setAttribute ('aria-label', t); },
        setTip (t) { lab.title = t; dial.title = t; },
        setDim (d) { root.classList.toggle ('dim', d); },
        refresh () { show (value (key)); },
    };
}

// Case de valeur éditable (comme la zone de texte des sliders JUCE) : Entrée valide, Échap annule.
function valueBox (input, key, fmt, parse)
{
    const p = param (key);
    const revert = () => { input.value = fmt (value (key).real); };
    input.addEventListener ('focus', () => input.select());
    input.addEventListener ('keydown', (e) =>
    {
        e.stopPropagation();   // ne pas jouer de notes en tapant une valeur
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { revert(); input.blur(); }
    });
    input.addEventListener ('change', () =>
    {
        const r = parse ? parse (input.value) : parseNumber (input.value);
        if (Number.isFinite (r)) setReal (key, Math.min (Math.max (r, p.min), p.max));
        revert();
    });
    input.addEventListener ('blur', revert);
}

// ---------------------------------------------------------------- curseur horizontal (Mix des filtres, Smooth / Rate)
export function hslider (key, label, opts = {})
{
    const p = param (key);
    const root = el ('div', `ctl hs ${opts.small ? 'small' : ''}`);
    root.dataset.modKey = key;
    const lab = el ('label', 'lbl', label);
    lab.title = opts.tip ?? p.name;
    const track = el ('div', 'track');
    track.tabIndex = 0;
    track.setAttribute ('role', 'slider');
    track.setAttribute ('aria-label', label);
    track.title = opts.tip ?? p.name;
    const range = el ('span', 'mrange'), fill = el ('span', 'fill'), thumb = el ('span', 'thumb'), mod = el ('span', 'mline');
    track.append (range, fill, thumb, mod);
    const val = el ('input', 'val');
    val.type = 'text';
    val.inputMode = 'decimal';
    val.setAttribute ('aria-label', `${label} (value)`);
    root.append (lab, track, val);
    root.append (modBadge (key, label));

    const fmt = (r) => (opts.format ?? ((x) => formatValue (p, x))) (r);
    let norm = 0;
    const show = (v) =>
    {
        norm = v.norm;
        fill.style.width = `${v.norm * 100}%`;
        thumb.style.left = `${v.norm * 100}%`;
        if (document.activeElement !== val) val.value = fmt (v.real);
        track.setAttribute ('aria-valuenow', String (Math.round (v.norm * 100)));
        drawRange();
    };
    const drawRange = () =>
    {
        const modded = routesFor (key).length > 0;
        root.classList.toggle ('modded', modded);
        if (! modded) { range.style.display = mod.style.display = 'none'; return; }
        const [lo, hi] = modRange (key, norm);
        range.style.display = '';
        range.style.left = `${lo * 100}%`;
        range.style.width = `${(hi - lo) * 100}%`;
    };
    on (key, show);
    onRoutes (drawRange);
    let smooth = null;
    onLive (() =>
    {
        const m = liveMod (key);
        if (m === null || ! root.classList.contains ('modded')) { mod.style.display = 'none'; smooth = null; return; }
        smooth = smooth === null ? m : smooth + (m - smooth) * 0.35;
        mod.style.display = '';
        mod.style.left = `${smooth * 100}%`;
    });

    track.style.touchAction = 'none';
    const fromX = (x) => { const b = track.getBoundingClientRect(); return (x - b.left) / b.width; };
    track.addEventListener ('pointerdown', (e) =>
    {
        if (e.button !== 0) return;
        e.preventDefault();
        track.focus ({ preventScroll: true });
        track.setPointerCapture (e.pointerId);
        setNorm (key, fromX (e.clientX));
        const mv = (ev) => setNorm (key, fromX (ev.clientX));
        const end = () => { track.removeEventListener ('pointermove', mv); track.removeEventListener ('pointerup', end); track.removeEventListener ('pointercancel', end); };
        track.addEventListener ('pointermove', mv);
        track.addEventListener ('pointerup', end);
        track.addEventListener ('pointercancel', end);
    });
    track.addEventListener ('dblclick', () => setNorm (key, defaultNorm (key)));
    track.addEventListener ('contextmenu', (e) => { if (routesFor (key).length) { e.preventDefault(); openRoutes (key, label, track); } });
    track.addEventListener ('keydown', (e) =>
    {
        const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
        if (! d) return;
        e.preventDefault();
        e.stopPropagation();
        setNorm (key, norm + d * (e.shiftKey ? 0.001 : 0.01));
    });
    valueBox (val, key, fmt, opts.parse);
    return {
        root,
        setLabel (t) { lab.textContent = t; },
        setTip (t) { lab.title = t; track.title = t; },
        setDim (d) { root.classList.toggle ('dim', d); },
        refresh () { show (value (key)); },
    };
}

// ---------------------------------------------------------------- menu (paramètre à choix)
export function combo (key, label, opts = {})
{
    const p = param (key);
    const root = el ('div', 'ctl combo');
    const lab = el ('label', 'lbl', label);
    const wrap = el ('span', 'select');
    const sel = el ('select');
    sel.id = `c_${key}`;
    lab.htmlFor = sel.id;
    lab.title = sel.title = opts.tip ?? p.name;
    p.choices.forEach ((c, i) => sel.append (new Option (opts.labels?.[i] ?? choiceLabel (c), i)));
    wrap.append (sel);
    root.append (lab, wrap);
    sel.addEventListener ('change', () => setNorm (key, p.choices.length > 1 ? +sel.value / (p.choices.length - 1) : 0));
    on (key, (v) => { sel.value = String (Math.round (v.real)); });
    return { root, select: sel, setDim (d) { root.classList.toggle ('dim', d); } };
}

// ---------------------------------------------------------------- case à cocher (paramètre booléen)
export function toggle (key, label, opts = {})
{
    const p = param (key);
    const root = el ('label', 'ctl toggle');
    const box = el ('input');
    box.type = 'checkbox';
    root.title = opts.tip ?? p.name;
    root.append (box, el ('span', '', label));
    box.addEventListener ('change', () => setNorm (key, box.checked ? 1 : 0));
    on (key, (v) => { box.checked = v.real > 0.5; });
    return { root, box };
}

// ---------------------------------------------------------------- routes de modulation (fenêtre d'édition)
// Petit bouton « ~ » posé sur un contrôle modulé : ouvre la liste de ses routes (profondeur, bipolaire, retrait), comme le
// clic droit du plugin. Le clic droit marche aussi sur ordinateur.
function modBadge (key, label)
{
    const b = el ('button', 'mod-badge', '~');
    b.type = 'button';
    b.title = 'Modulation routes of this parameter';
    b.setAttribute ('aria-label', `Modulation routes: ${label}`);
    b.addEventListener ('click', (e) => { e.stopPropagation(); openRoutes (key, label, b); });
    return b;
}

let pop = null;

export function openRoutes (key, label, anchor)
{
    closeRoutes();
    pop = el ('div', 'route-pop');
    pop.setAttribute ('role', 'dialog');
    pop.setAttribute ('aria-label', `Modulation: ${label}`);
    const build = () =>
    {
        pop.replaceChildren (el ('h4', '', `Modulation: ${label}`));
        const list = routesFor (key);
        if (! list.length) { pop.append (el ('p', 'note', 'No route.')); return; }
        for (const r of list) pop.append (routeRow (r, build));
    };
    build();
    document.body.append (pop);
    const b = anchor.getBoundingClientRect();
    const w = Math.min (330, document.documentElement.clientWidth - 32);
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max (16, Math.min (b.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - w - 16))}px`;
    pop.style.top = `${b.bottom + window.scrollY + 6}px`;
    setTimeout (() => document.addEventListener ('pointerdown', outside, true));
    document.addEventListener ('keydown', esc, true);
}

// une ligne : source, profondeur (-1..1), bipolaire, retirer -- partagée avec la liste ROUTES de l'onglet Mod
export function routeRow (r, rebuild, showTarget = false)
{
    const src = sourceInfo (r.source);
    const row = el ('div', 'route-row');
    const name = el ('span', 'route-src', src?.name ?? `Source ${r.source}`);
    if (showTarget)
        name.textContent = `${src?.name ?? r.source} → ${targetLabel (r.target)}`;
    const depth = el ('input');
    depth.type = 'range'; depth.min = -1; depth.max = 1; depth.step = 0.01; depth.value = r.depth;
    depth.setAttribute ('aria-label', `Depth ${src?.name ?? ''}`);
    const out = el ('output', '', r.depth.toFixed (2));
    depth.addEventListener ('input', () => { out.textContent = (+depth.value).toFixed (2); });
    depth.addEventListener ('change', () => updateRoute (r.source, r.target, { depth: +depth.value }));
    const bip = el ('label', 'toggle small');
    const cb = el ('input');
    cb.type = 'checkbox';
    cb.checked = src?.bipolar || r.bipolar;
    cb.disabled = !! src?.bipolar;
    bip.title = src?.bipolar ? 'LFO/Chaos are already bipolar -- has no effect on them.' : 'Bipolar: centres the source (0.5 = no effect).';
    cb.addEventListener ('change', () => updateRoute (r.source, r.target, { bipolar: cb.checked }));
    bip.append (cb, el ('span', '', 'Bipolar'));
    const del = el ('button', 'route-del', 'x');
    del.type = 'button';
    del.title = 'Remove this route';
    del.setAttribute ('aria-label', 'Remove this route');
    del.addEventListener ('click', () => { removeRoute (r.source, r.target); rebuild?.(); });
    row.append (name, depth, out, bip, del);
    return row;
}

// libellé d'une cible de route : celui de son contrôle dans l'interface, sinon le nom du Core
export const controlLabels = new Map();
export const targetLabel = (key) => controlLabels.get (key) ?? param (key)?.name ?? key;

function outside (e) { if (pop && ! pop.contains (e.target)) closeRoutes(); }
function esc (e) { if (e.key === 'Escape') closeRoutes(); }
export function closeRoutes()
{
    pop?.remove();
    pop = null;
    document.removeEventListener ('pointerdown', outside, true);
    document.removeEventListener ('keydown', esc, true);
}

export { fromNorm, store };
