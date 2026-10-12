// store.js -- état de l'interface : le « modèle » (une copie du moteur sur le thread principal, qui ne rend aucun son),
// les abonnements des contrôles et la modulation en direct.
//
// Pourquoi une copie du moteur dans la page : la table des paramètres, les valeurs d'un preset, les conversions
// réel <-> normalisé et les routes sont alors disponibles AVANT de démarrer le son (et sans aller-retour avec le thread
// audio). Chaque réglage est appliqué au modèle, puis envoyé tel quel au worklet (message 'set') : les deux moteurs
// reçoivent exactement les mêmes nombres. Le worklet ne renvoie que ce qui vit pendant le jeu (voir worklet.js).

import { Rezo, applyMobileLimits } from './rezo.js';

export const store =
{
    model: null,          // Rezo (thread principal)
    params: [],           // table du Core : { id, key, name, kind, min, max, default, machine, choices }
    byKey: {},
    mobile: false,        // limites mobile (8 voix, 2 cordes)
    routes: [],           // [{ source, target, depth, bipolar }]
    live: null,           // dernières valeurs du worklet : { sources[12], mods: Map clé -> norm, velIn, pitchIn }
    pluck: null,          // « photo » du dernier pincement (worklet) : { serial, columns, windowMs, data }
    send: () => {},       // message vers le worklet (remplacé quand le son démarre)
};

const listeners = new Map();      // clé -> Set de fonctions (v) => …   v = { real, norm }
const routeListeners = new Set();  // () => …  (routes changées)
const liveListeners = new Set();   // () => …  (valeurs en direct reçues)
const editListeners = new Set();   // () => …  (l'utilisateur a changé le son : paramètre ou route)

// Prévenu à chaque réglage ou route modifiés à la main (pas au chargement d'un preset) : sert à signaler « à enregistrer ».
export const onEdit = (fn) => editListeners.add (fn);
const edited = () => { for (const fn of editListeners) fn(); };

export async function initStore (wasmBytes)
{
    store.model = await Rezo.create (wasmBytes, 48000, true);
    store.params = store.model.params;
    store.byKey = store.model.byKey;
}

// ---------------------------------------------------------------- lecture
export const param = (key) => store.byKey[key];
export const value = (key) => ({ real: store.model.get (key), norm: store.model.getNormalized (key) });
export const real = (key) => store.model.get (key);
export const toNorm = (key, r) => store.model.toNormalized (key, r);
export const fromNorm = (key, n) => store.model.fromNormalized (key, n);
export const defaultNorm = (key) => store.model.toNormalized (key, store.byKey[key].default);

// ---------------------------------------------------------------- écriture
// Valeur normalisée (0..1), comme un geste sur un contrôle ou une automation du plugin.
export function setNorm (key, norm)
{
    if (! Number.isFinite (norm)) return;   // un geste mal calculé ne doit jamais envoyer NaN au moteur
    norm = Math.min (1, Math.max (0, norm));
    store.model.setNormalized (key, norm);
    store.send ({ type: 'set', key, norm });
    if (store.mobile && (key === 'numStrings' || key === 'maxVoices'))
    {
        applyMobileLimits (store.model);   // le worklet fait de même de son côté
        notify ('numStrings');
        notify ('maxVoices');
    }
    notify (key);
    edited();
}

// Valeur réelle (saisie au clavier dans une case de valeur) : convertie en normalisée, même chemin que setNorm.
export const setReal = (key, r) => setNorm (key, toNorm (key, r));

// ---------------------------------------------------------------- abonnements
export function on (key, fn)
{
    if (! listeners.has (key)) listeners.set (key, new Set());
    listeners.get (key).add (fn);
    fn (value (key));
}

export function notify (key)
{
    const set = listeners.get (key);
    if (! set) return;
    const v = value (key);
    for (const fn of set) fn (v);
}

export function notifyAll()
{
    for (const key of listeners.keys()) notify (key);
}

// ---------------------------------------------------------------- presets
// Applique un preset (texte JSON du Core) au modèle ; renvoie { error, limits }. Le worklet reçoit le même texte.
export function applyPresetText (text)
{
    const error = store.model.applyPreset (text);
    const limits = (! error && store.mobile) ? applyMobileLimits (store.model) : [];
    store.send ({ type: 'preset', text });
    store.routes = store.model.routes();
    notifyAll();
    for (const fn of routeListeners) fn();
    return { error, limits };
}

// État complet pour le worklet au démarrage du son : valeurs réelles (hors réglages de machine) et routes.
export function fullState()
{
    return {
        values: store.params.filter (p => ! p.machine).map (p => [p.key, store.model.get (p.key)]),
        routes: store.routes,
    };
}

// ---------------------------------------------------------------- routes de modulation
export const routesFor = (key) => store.routes.filter (r => r.target === key);
export const onRoutes = (fn) => { routeListeners.add (fn); fn(); };

export function setRoutes (list)
{
    store.model.setRoutes (list);
    store.routes = store.model.routes();   // relues : le moteur ignore les routes invalides
    store.send ({ type: 'routes', routes: store.routes });
    for (const fn of routeListeners) fn();
    edited();
}

export function addRoute (source, target, depth = 0.5)
{
    if (store.routes.some (r => r.source === source && r.target === target)) return;
    setRoutes ([...store.routes, { source, target, depth, bipolar: false }]);
}

export function updateRoute (source, target, change)
{
    setRoutes (store.routes.map (r => (r.source === source && r.target === target) ? { ...r, ...change } : r));
}

export function removeRoute (source, target)
{
    setRoutes (store.routes.filter (r => ! (r.source === source && r.target === target)));
}

export function removeRoutesOfSource (source)
{
    setRoutes (store.routes.filter (r => r.source !== source));
}

// ---------------------------------------------------------------- sources de modulation (ModSource.h)
// numéro du moteur -> nom affiché, paramètre d'activation (instances 2..4), bipolaire, liée à la note
export const SOURCES =
[
    { id: 0,  name: 'LFO',          family: 0, rank: 0, bipolar: true },
    { id: 6,  name: 'LFO 2',        family: 0, rank: 1, bipolar: true, enable: 'modLfoEnabled2' },
    { id: 10, name: 'LFO 3',        family: 0, rank: 2, bipolar: true, enable: 'modLfoEnabled3' },
    { id: 11, name: 'LFO 4',        family: 0, rank: 3, bipolar: true, enable: 'modLfoEnabled4' },
    { id: 4,  name: 'Envelope',     family: 1, rank: 4 },
    { id: 8,  name: 'Envelope 2',   family: 1, rank: 5, enable: 'modEnvEnabled2' },
    { id: 5,  name: 'Env Follower', family: 1, rank: 6 },
    { id: 9,  name: 'Env Follower 2', family: 1, rank: 7, enable: 'modEnvFollowerEnabled2' },
    { id: 2,  name: 'Velocity',     family: 2, rank: 8, note: true },
    { id: 3,  name: 'Pitch',        family: 2, rank: 9, note: true },
];
export const sourceInfo = (id) => SOURCES.find (s => s.id === id);

// Plage atteignable par la modulation (somme de toutes les routes du paramètre), comme computeModRange du plugin.
export function modRange (key, baseNorm)
{
    let lo = 0, hi = 0;
    for (const r of routesFor (key))
    {
        const projMin = (sourceInfo (r.source)?.bipolar || r.bipolar) ? -1 : 0;
        const c1 = r.depth * projMin, c2 = r.depth;
        lo += Math.min (c1, c2);
        hi += Math.max (c1, c2);
    }
    return [Math.min (1, Math.max (0, baseNorm + lo)), Math.min (1, Math.max (0, baseNorm + hi))];
}

// ---------------------------------------------------------------- valeurs en direct (worklet, ~30 Hz)
export function setLive (m)
{
    store.live = { sources: m.sources, mods: new Map (m.mods), velIn: m.velIn, pitchIn: m.pitchIn };
    for (const fn of liveListeners) fn();
}
export const onLive = (fn) => liveListeners.add (fn);

// valeur normalisée modulée en direct (null si le son ne tourne pas ou si le paramètre n'est pas modulé)
export const liveMod = (key) => store.live?.mods.get (key) ?? null;

// ---------------------------------------------------------------- énergie des étages (worklet, ~30 Hz)
// Les croquis des onglets et la corde du logo s'allument avec l'énergie de leur étage (0 = Exciter, 1 = Grains, 2 = Body,
// 3 = Output), comme une ampoule derrière un vactrol : niveau affiché g = (dB + 60) / 50 borné à 0..1, montée immédiate,
// retombée exponentielle (constante de temps GLOW_TAU).
// Rien ne tourne en permanence : le calcul se fait à l'arrivée des messages du worklet. Silence et tout éteint : rien à
// faire. Si les messages s'arrêtent alors qu'un étage est encore allumé (son coupé), une minuterie le laisse retomber
// jusqu'à 0, puis s'arrête.
const GLOW_TAU = 250;          // ms
const GLOW_FLOOR = 1 / 64;     // sous le premier pas affiché (1/32) : éteint
const DARK = [0, 0, 0, 0];
const glow = [0, 0, 0, 0];
const glowListeners = new Set();   // (g[4]) => …  (chaque abonné quantifie et ne touche au DOM que si sa valeur change)
let glowTime = 0, glowTimer = 0;

export const onGlow = (fn) => glowListeners.add (fn);

const glowOf = (level) => level > 0 ? Math.min (1, Math.max (0, (20 * Math.log10 (level) + 60) / 50)) : 0;

function glowStep (targets, alone = false)
{
    const now = performance.now();
    const fall = Math.exp (-(now - glowTime) / GLOW_TAU);
    glowTime = now;
    let lit = false;
    for (let i = 0; i < 4; ++i)
    {
        const g = Math.max (targets[i], glow[i] * fall);
        glow[i] = g < GLOW_FLOOR ? 0 : g;
        lit ||= glow[i] > 0;
    }
    for (const fn of glowListeners) fn (glow);
    clearTimeout (glowTimer);
    glowTimer = lit ? setTimeout (() => glowStep (DARK, true), alone ? 33 : 120) : 0;
}

export function setStages (levels)
{
    const targets = levels.map (glowOf);
    if (! glowTimer && ! targets.some (g => g > 0)) return;
    glowStep (targets);
}

// ---------------------------------------------------------------- photo du dernier pincement (worklet, quand elle change)
const pluckListeners = new Set();
export const onPluck = (fn) => pluckListeners.add (fn);
export function setPluck (m)
{
    store.pluck = { serial: m.serial, columns: m.columns, windowMs: m.windowMs, data: m.data };
    for (const fn of pluckListeners) fn();
}
