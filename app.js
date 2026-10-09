// app.js -- page de la démo : chargement, presets, onglets façon plugin, son (AudioWorklet), morceau, clavier,
// « Tous les paramètres », banc CPU. Le son est dans worklet.js ; l'état de l'interface dans store.js.

import { store, initStore, param, on, real, setNorm, applyPresetText, fullState, setLive, addRoute } from './store.js';
import { el, formatValue, controlLabels, closeRoutes } from './widgets.js';
import { modPanel } from './views.js';
import { watchTheme, invalidateAll } from './sketch.js';
import { TABS, exposed } from './tabs.js';
import * as community from './community.js';

const $ = (id) => document.getElementById (id);
const isMobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test (navigator.userAgent);
$('mobile').checked = isMobile;
store.mobile = isMobile;

let wasm, presets, song, ctx, node, presetText = '', playing = false;

// ---------------------------------------------------------------- thème (clair / sombre / auto), mémorisé si possible
// Par défaut, le papier du plugin (clair), même si le système est en sombre : le plugin n'a qu'un thème. Le sombre
// « encre de nuit » et le suivi du système restent au choix (bouton en bas de page).
const THEMES = ['light', 'dark', 'auto'];
const THEME_LABEL = { auto: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' };
function applyTheme (t)
{
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    $('theme').textContent = THEME_LABEL[t];
}
let theme = 'light';
try { theme = localStorage.getItem ('rezo-theme') ?? 'light'; } catch { /* stockage indisponible : papier du plugin */ }
if (! THEMES.includes (theme)) theme = 'light';
applyTheme (theme);
$('theme').onclick = () =>
{
    theme = THEMES[(THEMES.indexOf (theme) + 1) % THEMES.length];
    applyTheme (theme);
    try { localStorage.setItem ('rezo-theme', theme); } catch { /* sans importance */ }
};
watchTheme();

// ---------------------------------------------------------------- chargement : moteur (modèle), presets, morceau
const ready = (async () =>
{
    const [w, list, mid] = await Promise.all ([
        fetch ('rezo.wasm').then (r => r.arrayBuffer()),
        fetch ('presets/index.json').then (r => r.json()),
        fetch ('songs/le_luth.json').then (r => r.json()),   // événements de LE LUTH.mid, lus au build par midi.js
    ]);
    wasm = w; presets = list; song = mid;
    await initStore (wasm);

    $('tempo').value = Math.round (song.bpm);
    $('tempoOut').textContent = `${Math.round (song.bpm)} BPM`;
    for (const [group, label] of [['factory', 'Factory presets'], ['user', 'User presets']])
    {
        const og = document.createElement ('optgroup');
        og.label = label;
        for (const p of presets.filter (p => p.group === group))
            og.append (new Option (p.name, p.file));
        $('preset').append (og);
    }
    buildInstrument();
    buildAllParams();
    const start = presets.find (p => p.name === 'Old Luth') ?? presets[0];
    $('preset').value = start.file;
    $('preset').disabled = false;   // choisir un preset (et le mesurer) ne demande pas de démarrer le son
    $('bench').disabled = false;
    $('start').disabled = false;
    await loadPreset();
    $('loading').remove();
}) ();
ready.catch ((err) => { $('loading').textContent = `Loading failed: ${err.message}`; });

// ---------------------------------------------------------------- l'instrument : en-tête, onglets, panneau de modulation
function buildInstrument()
{
    const tabbar = $('tabs');
    const pages = $('pages');
    TABS.forEach ((t, i) =>
    {
        const b = el ('button', 'tab');
        b.textContent = t.label;
        b.type = 'button';
        b.id = `tab-${t.id}`;
        b.setAttribute ('role', 'tab');
        b.setAttribute ('aria-controls', `page-${t.id}`);
        const page = el ('div', 'page');
        page.id = `page-${t.id}`;
        page.setAttribute ('role', 'tabpanel');
        page.setAttribute ('aria-labelledby', b.id);
        page.append (...t.build());
        tabbar.append (b);
        pages.append (page);
        b.onclick = () => selectTab (i);
    });
    tabbar.addEventListener ('keydown', (e) =>
    {
        const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (! d) return;
        const i = (current + d + TABS.length) % TABS.length;
        selectTab (i);
        tabbar.children[i].focus();
    });
    let current = 0;
    try { current = Math.max (0, TABS.findIndex (t => t.id === sessionStorage.getItem ('rezo-tab'))); } catch { /* onglet par défaut */ }
    function selectTab (i)
    {
        current = i;
        [...tabbar.children].forEach ((b, j) => { b.setAttribute ('aria-selected', String (i === j)); b.tabIndex = i === j ? 0 : -1; });
        pages.querySelectorAll ('.page').forEach ((p, j) => { p.hidden = i !== j; });
        try { sessionStorage.setItem ('rezo-tab', TABS[i].id); } catch { /* sans importance */ }
        closeRoutes();
        headerGap();
    }
    // trait de l'en-tête interrompu sous l'onglet actif (comme RezonathorAudioProcessorEditor::paint)
    const head = tabbar.closest ('.whead');
    function headerGap()
    {
        const t = tabbar.children[current], h = head.getBoundingClientRect(), r = t.getBoundingClientRect();
        head.style.setProperty ('--gap-l', `${r.left - h.left + 1}px`);
        head.style.setProperty ('--gap-r', `${r.right - h.left - 1}px`);
    }
    new ResizeObserver (headerGap).observe (head);
    // traits entre familles : début de rangée (.rs) et première rangée (.fr), recalculés quand la mise en page change
    const markRows = (box) =>
    {
        const items = [...box.children].filter (e => e.matches ('.family, .stack') && ! e.hidden);
        let prev = null, first = null;
        for (const e of items)
        {
            const top = e.offsetTop;
            first ??= top;
            e.classList.toggle ('rs', prev === null || Math.abs (top - prev) > 4);
            e.classList.toggle ('fr', Math.abs (top - first) <= 4);
            prev = top;
        }
    };
    const rowsObserver = new ResizeObserver ((entries) => { for (const en of entries) markRows (en.target); });
    pages.querySelectorAll ('.page, .stack').forEach (b => rowsObserver.observe (b));
    document.fonts?.ready.then (headerGap);
    selectTab (current < 0 ? 0 : current);

    $('modpanel').replaceWith (modPanel (arm));

    // voix actives / voix max (comme l'en-tête du plugin)
    on ('maxVoices', () => showVoices());
}

let voices = 0;
function showVoices()
{
    const p = param ('maxVoices');
    $('voicesHead').textContent = `voices ${voices} / ${p.choices[Math.round (real ('maxVoices'))]}`;
}

// ---------------------------------------------------------------- mode « armé » (écran tactile) : toucher une source, puis un réglage
let armed = null;
function arm (src)
{
    armed = armed?.id === src.id ? null : src;
    document.body.classList.toggle ('arming', !! armed);
    document.querySelectorAll ('.tile').forEach (t => t.classList.toggle ('armed', +t.dataset.source === armed?.id));
    $('armBar').hidden = ! armed;
    if (armed) $('armText').textContent = `Touch a parameter to modulate it with ${armed.name}.`;
}
document.addEventListener ('pointerdown', (e) =>
{
    if (! armed || e.target.closest ('.tile, #armBar')) return;
    const t = e.target.closest ('[data-mod-key]');
    if (t)
    {
        e.preventDefault();
        e.stopPropagation();
        addRoute (armed.id, t.dataset.modKey);
    }
    arm (armed);   // un seul réglage par toucher : on désarme
}, true);
$('armCancel').onclick = () => armed && arm (armed);
addEventListener ('keydown', (e) => { if (e.key === 'Escape' && armed) arm (armed); });

// ---------------------------------------------------------------- tous les paramètres (générés depuis la table du Core)
// Repli pour tout ce que les onglets n'exposent pas : un paramètre ajouté au Core apparaît ici sans rien changer.
const SECTIONS = [
    ['decay', 'Resonator'], ['release', 'Voices and strings'], ['granularB', 'Granular'], ['gateMs', 'Gate, gains, distortion'],
    ['filterMix', 'Filters'], ['combFeedback', 'Input comb and output'], ['modRetrigger', 'Modulation'],
    ['exciterMix', 'Exciter and polyphony'], ['exciterAttackCurve', 'Envelope curves'], ['modLfoEnabled3', 'LFO 3 and 4, modulation settings'],
];

function buildAllParams()
{
    const box = $('params');
    const hidden = store.params.filter (p => ! p.machine && ! exposed.has (p.key));
    $('hiddenNote').textContent = hidden.length
        ? `Not shown in the tabs (effect only, or internal setting): ${hidden.map (p => p.name).join (', ')}.`
        : '';
    for (const p of store.params)
    {
        const s = SECTIONS.find (([k]) => k === p.key);
        if (s) box.append (el ('h3', 'psec', s[1]));
        if (p.machine) continue;   // oversampling, exciterMix : réglages de machine, fixés par la démo
        box.append (paramRow (p));
    }
    $('filter').oninput = () =>
    {
        const q = $('filter').value.trim().toLowerCase();
        for (const row of box.querySelectorAll ('.prow'))
            row.style.display = ! q || row.dataset.search.includes (q) ? '' : 'none';
    };
}

function paramRow (p)
{
    const row = el ('div', 'prow');
    const label = controlLabels.get (p.key);
    row.dataset.search = `${p.key} ${p.name} ${label ?? ''}`.toLowerCase();
    const name = el ('label', 'pname', p.name);
    name.title = p.key + (label ? ` (tabs: ${label})` : '');
    const id = `p_${p.key}`;
    name.htmlFor = id;
    const out = el ('output', 'pval');
    let input;
    if (p.kind === 'choice')
    {
        input = el ('select');
        p.choices.forEach ((c, i) => input.append (new Option (c, i)));
        input.onchange = () => setNorm (p.key, p.choices.length > 1 ? +input.value / (p.choices.length - 1) : 0);
    }
    else if (p.kind === 'bool')
    {
        input = el ('input');
        input.type = 'checkbox';
        input.onchange = () => setNorm (p.key, input.checked ? 1 : 0);
    }
    else
    {
        input = el ('input');
        input.type = 'range'; input.min = 0; input.max = 1; input.step = p.kind === 'int' ? 1 / (p.max - p.min) : 0.001;
        input.oninput = () => setNorm (p.key, +input.value);
    }
    input.id = id;
    row.append (name, input, out);
    on (p.key, (v) =>
    {
        if (p.kind === 'choice') input.value = Math.round (v.real);
        else if (p.kind === 'bool') input.checked = v.real > 0.5;
        else if (document.activeElement !== input) input.value = v.norm;
        out.textContent = formatValue (p, v.real);
    });
    return row;
}

// ---------------------------------------------------------------- presets
async function loadPreset()
{
    const v = $('preset').value;
    presetText = v.startsWith ('community:') ? JSON.stringify (communityPresets.get (v)?.preset ?? {})
                                             : await fetch (v).then (r => r.text());
    const { error, limits } = applyPresetText (presetText);
    $('status').classList.toggle ('warn', !! error);
    $('status').textContent = error ? `Preset rejected: ${error}`
        : limits.length ? `Preset loaded (limited on mobile: ${limits.join (', ')}).` : 'Preset loaded.';
}
$('preset').onchange = loadPreset;

$('mobile').onchange = () =>
{
    store.mobile = $('mobile').checked;
    if (! node) loadPreset();   // avant le son : le preset est rechargé avec ou sans les limites
};

// ---------------------------------------------------------------- son
$('start').onclick = async () =>
{
    $('start').disabled = true;
    try
    {
        await ready;
        ctx = new AudioContext ({ latencyHint: 'interactive' });
        await ctx.audioWorklet.addModule ('worklet.js');
        node = new AudioWorkletNode (ctx, 'rezo', { numberOfInputs: 0, outputChannelCount: [2],
                                                    processorOptions: { wasm, mobile: $('mobile').checked } });
        node.connect (ctx.destination);
        node.port.onmessage = onWorkletMessage;
        await ctx.resume();
        store.sampleRate = ctx.sampleRate;
        invalidateAll();
        $('rate').textContent = `${(ctx.sampleRate / 1000).toFixed (1)} kHz`;
        $('start').textContent = 'Sound on';
        $('mobile').disabled = true;
    }
    catch (err)
    {
        $('status').textContent = `Sound unavailable: ${err.message}. Sound needs https or localhost.`;
        $('status').classList.add ('warn');
        $('start').disabled = false;
    }
};

function onWorkletMessage (e)
{
    const m = e.data;
    if (m.type === 'ready')
    {
        // le worklet reprend l'état de la page : preset, réglages faits avant le son, routes
        node.port.postMessage ({ type: 'state', text: presetText, ...fullState() });
        store.send = (msg) => node.port.postMessage (msg);
        store.send ({ type: 'song', events: song.events, bpm: song.bpm });
        store.send ({ type: 'bpm', bpm: +$('tempo').value });
        for (const id of ['play', 'tempo']) $(id).disabled = false;
    }
    else if (m.type === 'meter')
    {
        voices = m.voices;
        $('voices').textContent = m.voices;
        showVoices();
        $('level').textContent = m.peak > 0 ? `${(20 * Math.log10 (m.peak)).toFixed (1)} dB` : '−∞';
    }
    else if (m.type === 'mod')
        setLive (m);
}

$('play').onclick = () =>
{
    playing = ! playing;
    store.send ({ type: 'play', on: playing });
    $('play').textContent = playing ? 'Stop' : 'Play LE LUTH';
    $('play').classList.toggle ('playing', playing);
};
$('tempo').oninput = () =>
{
    $('tempoOut').textContent = `${$('tempo').value} BPM`;
    store.send ({ type: 'bpm', bpm: +$('tempo').value });
};

// ---------------------------------------------------------------- clavier (deux octaves, do3 à si4)
{
    const first = 60, count = 24, whites = [0, 2, 4, 5, 7, 9, 11];
    const kb = $('keyboard');
    const whiteKeys = [];
    for (let n = first; n < first + count; ++n)
        if (whites.includes (n % 12)) whiteKeys.push (n);
    const keyEl = new Map();
    whiteKeys.forEach ((n) =>
    {
        const k = el ('div', 'key');
        k.dataset.note = n;
        if (n % 12 === 0) k.textContent = `C${Math.floor (n / 12) - 2}`;
        kb.append (k); keyEl.set (n, k);
    });
    for (let n = first; n < first + count; ++n)
    {
        if (whites.includes (n % 12)) continue;
        const left = whiteKeys.indexOf (n - 1);
        const k = el ('div', 'key black');
        k.dataset.note = n;
        k.style.left = `calc(${(left + 1) / whiteKeys.length * 100}% - ${100 / whiteKeys.length * 0.31}%)`;
        kb.append (k); keyEl.set (n, k);
    }

    const held = new Set();
    const down = (n, velocity = 0.8) => { if (held.has (n)) return; held.add (n); keyEl.get (n)?.classList.add ('down'); store.send ({ type: 'noteOn', note: n, velocity }); };
    const up   = (n) => { if (! held.delete (n)) return; keyEl.get (n)?.classList.remove ('down'); store.send ({ type: 'noteOff', note: n }); };

    const pointerNote = new Map();
    kb.addEventListener ('pointerdown', (e) =>
    {
        const n = +e.target.dataset.note;
        if (! n) return;
        kb.setPointerCapture (e.pointerId);
        pointerNote.set (e.pointerId, n);
        const rect = e.target.getBoundingClientRect();
        down (n, Math.min (1, 0.35 + 0.65 * (e.clientY - rect.top) / rect.height));   // plus bas sur la touche = plus fort
    });
    const release = (e) => { const n = pointerNote.get (e.pointerId); if (n) up (n); pointerNote.delete (e.pointerId); };
    kb.addEventListener ('pointerup', release);
    kb.addEventListener ('pointercancel', release);

    // position physique des touches (e.code) : même placement en AZERTY et en QWERTY
    const codes = { KeyA: 60, KeyW: 61, KeyS: 62, KeyE: 63, KeyD: 64, KeyF: 65, KeyT: 66, KeyG: 67, KeyY: 68, KeyH: 69,
                    KeyU: 70, KeyJ: 71, KeyK: 72, KeyO: 73, KeyL: 74, KeyP: 75, Semicolon: 76 };
    const typing = (t) => t instanceof Element && t.matches ('input:not([type=checkbox]):not([type=range]), select, textarea, [contenteditable]');
    addEventListener ('keydown', (e) =>
    {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing (e.target) || ! (e.code in codes)) return;
        down (codes[e.code]);
    });
    addEventListener ('keyup', (e) => { if (e.code in codes) up (codes[e.code]); });
    addEventListener ('blur', () => { for (const n of [...held]) up (n); });
}

// ---------------------------------------------------------------- banc CPU
$('bench').onclick = async () =>
{
    await ready;
    $('bench').disabled = true;
    $('benchOut').textContent = 'Measuring…';
    const worker = new Worker ('bench-worker.js', { type: 'module' });
    worker.onmessage = (e) =>
    {
        const { percent, strings } = e.data;
        const name = $('preset').selectedOptions[0].text;
        $('benchOut').textContent = `${name}${$('mobile').checked ? ' (mobile limits)' : ''}, ${strings} string(s): `
            + `${percent.toFixed (1)} % of real time on one core. Below ~60 %, the sound plays without crackles.`;
        $('bench').disabled = false;
        worker.terminate();
    };
    worker.onerror = (e) => { $('benchOut').textContent = `Benchmark failed: ${e.message}`; $('bench').disabled = false; };
    worker.postMessage ({ wasm, presetText, events: song.events, mobile: $('mobile').checked, seconds: 30 });
};

// ---------------------------------------------------------------- presets partagés (comptes, community.js)
// Groupe « Community » du menu : un preset par compte, lisible par tous. « Save » ne demande un compte qu'au moment
// d'enregistrer. Absent quand la base ne répond pas (page claude.ai, hors ligne).
const communityPresets = new Map();   // valeur d'option 'community:<user_id>' -> ligne de la base

async function refreshCommunity (select = null)
{
    const rows = await community.list();
    communityPresets.clear();
    $('preset').querySelector ('optgroup.community')?.remove();
    if (! rows.length) return;
    const og = document.createElement ('optgroup');
    og.label = 'Community';
    og.className = 'community';
    for (const r of rows)
    {
        const key = `community:${r.user_id}`;
        communityPresets.set (key, r);
        og.append (new Option (`${r.name} (${r.username})`, key));
    }
    const current = $('preset').value;
    $('preset').append (og);
    $('preset').value = select ?? current;
}

(async () =>
{
    await ready;
    if (! await community.available()) return;
    $('saveBtn').hidden = false;
    try { await refreshCommunity(); } catch { /* menu sans le groupe Community */ }
}) ();

{
    const dlg = $('saveDlg');
    let mode = 'signup';          // 'signup' | 'login' (sans compte) ; 'save' (connecté)
    let deleteArmed = false;
    const err = (t) => { $('saveError').textContent = t ?? ''; };
    const busy = (b) => { for (const id of ['okBtn', 'cancelBtn', 'logOutBtn', 'deleteBtn', 'switchMode']) $(id).disabled = b; };

    function render()
    {
        const user = community.currentUser();
        if (user) mode = 'save';
        else if (mode === 'save') mode = 'signup';
        $('accountPart').hidden = !! user;
        $('presetPart').hidden = ! user;
        $('logOutBtn').hidden = $('deleteBtn').hidden = ! user;
        $('saveTitle').textContent = user ? 'Save your preset' : mode === 'signup' ? 'Create an account to save' : 'Log in to save';
        $('accountText').textContent = mode === 'signup'
            ? 'Create an account to save one preset that everyone can load and play.'
            : 'Log in to save your preset.';
        $('switchMode').textContent = mode === 'signup' ? 'I already have an account' : 'Create a new account';
        $('userPass').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
        $('okBtn').textContent = user ? 'Save' : mode === 'signup' ? 'Create account' : 'Log in';
        $('signedText').textContent = user ? `Signed in as ${user}.` : '';
        deleteArmed = false;
        $('deleteBtn').textContent = 'Delete my preset';
    }

    async function fillName()
    {
        const sel = $('preset').selectedOptions[0];
        const fallback = sel && ! sel.value.startsWith ('community:') ? sel.text : 'My preset';
        $('presetName').value = fallback;
        try { const m = await community.mine(); if (m) { $('presetName').value = m.name; $('signedText').textContent += ` Your current preset: “${m.name}”.`; } }
        catch { /* nom par défaut */ }
    }

    $('saveBtn').onclick = () =>
    {
        err(); render();
        dlg.showModal();
        if (community.currentUser()) fillName(); else $('userName').focus();
    };
    $('cancelBtn').onclick = () => dlg.close();
    $('switchMode').onclick = () => { mode = mode === 'signup' ? 'login' : 'signup'; err(); render(); };
    $('logOutBtn').onclick = () => { community.logOut(); err(); render(); };
    $('deleteBtn').onclick = async () =>
    {
        if (! deleteArmed) { deleteArmed = true; $('deleteBtn').textContent = 'Click again to delete'; return; }
        busy (true);
        try { await community.remove(); await refreshCommunity(); dlg.close(); $('status').textContent = 'Your shared preset was deleted.'; }
        catch (e) { err (e.message); }
        finally { busy (false); render(); }
    };
    // touches de l'ordinateur : ne pas jouer de notes en tapant dans la fenêtre
    dlg.addEventListener ('keydown', (e) => e.stopPropagation());

    $('saveForm').addEventListener ('submit', async (e) =>
    {
        e.preventDefault();
        err();
        busy (true);
        try
        {
            if (mode !== 'save')
            {
                const name = $('userName').value.trim().toLowerCase();
                const pass = $('userPass').value;
                if (! community.USERNAME_RULE.test (name)) throw new Error ('Username: 3 to 20 characters, letters, digits, - or _.');
                if (pass.length < 6) throw new Error ('The password is too short (6 characters minimum).');
                if (mode === 'signup') await community.signUp (name, pass);
                else await community.logIn (name, pass);
                $('userPass').value = '';
                render();
                await fillName();
                return;
            }
            const name = $('presetName').value.trim();
            if (! name) throw new Error ('Please give your preset a name.');
            const preset = JSON.parse (store.model.presetJson (name));
            await community.save (name, preset);
            const me = community.currentUser();
            const rows = await community.list();
            const mineRow = rows.find (r => r.username === me);
            await refreshCommunity (mineRow ? `community:${mineRow.user_id}` : null);
            dlg.close();
            $('status').classList.remove ('warn');
            $('status').textContent = `Saved “${name}”: everyone can now load it from the preset menu (Community).`;
        }
        catch (ex) { err (ex.message); }
        finally { busy (false); }
    });
}
