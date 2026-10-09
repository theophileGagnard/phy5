// tabs.js -- les cinq onglets du plugin (Source/PluginEditor.cpp, cible SYNTH), famille par famille, dans le même ordre :
//   Exciter : EXCITER | GAIN | Input Filter | COMB
//   Gran    : GRAIN | TEXTURE | FEEDBACK | Feedback Filter
//   Reso    : RESONANCE | BUILD | Loop Filter | POLYCHORD | PITCH | MIDI
//   Output  : Output Filter | SAT | GAIN, puis Oversampling / Max Voices
//   Mod     : LFO | ENVELOPE | MIDI (+ ROUTES : la liste des routes de modulation, propre à la page)
// Le synth n'a ni entrée audio ni Dry/Wet : comme dans le plugin (kIsSynth), pas de GATE, pas de MIX.
// Contrôles primaires (grands) et secondaires (petits), comme dans le plugin. Libellés : EXACTEMENT ceux du plugin
// (titres de famille sans le « : » final, comme styleFamilyTitle) ; info-bulles du plugin, en anglais (quand le plugin
// n'en a pas, une phrase anglaise courte, ou le nom du paramètre).

import { store, param, on, real, value, routesFor, onRoutes } from './store.js';
import { el, knob, hslider, combo, toggle, controlLabels, routeRow, formatValue } from './widgets.js';
import { XYPad, EnvelopeView, StringSchematic, SaturationView, LfoView, MappingView } from './views.js';

// clés des paramètres qui ont un contrôle dans les onglets (le reste n'est que dans « Tous les paramètres »)
export const exposed = new Set();

const tip = (key, text) => text ?? param (key).name;   // info-bulle du plugin, sinon le nom du paramètre (comme un hôte)

function K (key, label, size = 'sec', opts = {})
{
    exposed.add (key);
    controlLabels.set (key, label);
    return knob (key, label, { size, ...opts, tip: tip (key, opts.tip) });
}
function H (key, label, opts = {})
{
    exposed.add (key);
    controlLabels.set (key, label);
    return hslider (key, label, { ...opts, tip: tip (key, opts.tip) });
}
function C (key, label, opts = {})
{
    exposed.add (key);
    return combo (key, label, { ...opts, tip: tip (key, opts.tip) });
}
function T (key, label, opts = {})
{
    exposed.add (key);
    return toggle (key, label, { ...opts, tip: tip (key, opts.tip) });
}

const R = (w) => w.root ?? w;
function family (title, cls = '')
{
    const f = el ('section', `family ${cls}`);
    if (title) f.append (el ('h3', 'ftitle', title));
    return f;
}
function row (cls, ...items)
{
    const r = el ('div', `row ${cls}`);
    r.append (...items.map (R));
    return r;
}
function sub (title)   // titre de section de l'onglet Mod (LFO 1, Envelope 2…), en rouge sépia comme dans le plugin
{
    return el ('h4', 'stitle', title);
}

// ---------------------------------------------------------------- bloc filtre (Mix, mode, pad XY, Freq / Width)
function filterBlock (title, prefix, opts = {})
{
    const keys = { mix: `${prefix}Mix`, mode: `${prefix}Mode`, freq: `${prefix}Freq`, width: `${prefix}Width` };
    const f = family (title, 'filter');
    const caption = el ('p', 'caption', opts.caption ?? '');
    caption.hidden = true;
    const mix = H (keys.mix, 'Mix', { format: opts.mixFormat, parse: opts.mixParse, tip: 'Filter dry/wet (0 = no effect).' });
    const mode = C (keys.mode, '', { tip: 'Filter mode: Bandpass, Allpass or Disperser.' });
    mode.root.querySelector ('.lbl').remove();
    const pad = new XYPad (keys);
    const fq = K (keys.freq, 'Freq', 'sec', { tip: 'Centre frequency of the filter.' });
    const wd = K (keys.width, 'Width', 'sec', { tip: 'Width of the band.' });
    f.append (caption, R (mix), R (mode), pad.root, row ('pair', fq, wd));
    return { root: f, caption, mix, mode, pad, freq: fq, width: wd };
}

// ================================================================ Exciter
function exciterTab()
{
    const page = [];

    const exc = family ('EXCITER', 'exciter');
    const noise = C ('exciterNoise', 'NOISE', { tip: 'Colour of the internal noise burst that excites the strings: White (bright) or Pink (softer).' });
    noise.root.classList.add ('primary');
    const env = new EnvelopeView ({ a: 'exciterAttack', d: 'exciterDecay', s: 'exciterSustain', r: 'exciterRelease',
                                    ac: 'exciterAttackCurve', dc: 'exciterDecayCurve', rc: 'exciterReleaseCurve' });
    ['exciterAttackCurve', 'exciterDecayCurve', 'exciterReleaseCurve'].forEach (k => exposed.add (k));
    exc.append (row ('top', noise, env.root),
                row ('', K ('exciterAttack', 'Attack'), K ('exciterDecay', 'Decay'),
                         K ('exciterSustain', 'Sustain', 'sec', { tip: 'Default 0: a plucked burst that dies away over Decay. Above 0: the Exciter stays active while the key is held.' }),
                         K ('exciterRelease', 'Release')));
    page.push (exc);

    const gain = family ('GAIN');
    gain.append (R (K ('inputGain', 'GAIN', 'prim', { tip: 'Level of the Exciter. Modulatable: drop Velocity here for velocity-sensitive plucks.' })));
    page.push (gain);

    page.push (filterBlock ('Input Filter', 'filter').root);

    const comb = family ('COMB');
    comb.append (R (K ('combDelaySamples', 'DELAY', 'prim', { tip: 'Comb filter delay length: tunes the comb resonance applied to the excitation.' })),
                 R (K ('combFeedback', 'Feedback', 'sec', { tip: 'Comb filter feedback amount.' })));
    page.push (comb);
    return page;
}

// ================================================================ Gran
function granTab()
{
    const page = [];
    const grain = family ('GRAIN');
    const latency = el ('p', 'caption strong');
    latency.title = 'Excitation latency at the start of a grain (average Blur): Blur x Window / 2, plus (ratio - 1) x Window when pitched up.';
    grain.append (row ('', K ('granularB', 'AMOUNT', 'prim', { tip: 'Dry/wet of the granular stage: 0 = no grains, 1 = grains only.' }),
                           K ('granularWindowMs', 'WINDOW', 'prim', { tip: 'Grain window length. One grain per window: grains scroll even at Pitch 0, and Blur is redrawn for every grain.' }),
                           K ('granularPitchSemis', 'PITCH', 'prim', { tip: 'Pitch shift of the grains, in semitones.' })),
                  latency);
    const upd = () =>
    {
        const ms = store.model.granLatencyMs (real ('granularWindowMs'), real ('granularF'), real ('granularPitchSemis'));
        latency.textContent = `latency ~ ${ms.toFixed (ms < 10 ? 1 : 0)} ms`;
    };
    for (const k of ['granularWindowMs', 'granularF', 'granularPitchSemis']) on (k, upd);
    page.push (grain);

    const tex = family ('TEXTURE');
    tex.append (row ('', K ('granularC', 'Reverse', 'prim', { ends: ['Fwd', 'Rev'], tip: 'Probability that a grain plays backwards: 0 = always forward, 1 = always reversed.' }),
                         K ('granularF', 'Blur', 'prim', { tip: 'Blur of the grains.' }),
                         K ('granularSpread', 'Spread', 'prim', { tip: 'Stereo spread of the grains.' })));
    page.push (tex);

    const fb = family ('FEEDBACK');
    fb.append (row ('', K ('granularG', 'Delay', 'sec', { tip: 'Delay of the granular feedback loop.' }),
                        K ('granularH', 'Feedback', 'sec', { tip: 'Amount of granular output fed back into the granular stage.' })));
    page.push (fb);

    page.push (filterBlock ('Feedback Filter', 'granFilter').root);
    return page;
}

// ================================================================ Reso
function resoTab()
{
    const page = [];

    // -- RESONANCE : DECAY, DAMP + Damp Mode. En mode Physical, DAMP devient un rapport de T60 (en %).
    let physical = false;
    const res = family ('RESONANCE');
    const damp = K ('damp', 'DAMP', 'prim', {
        format: (v) => physical ? `${(store.model.dampRatio (v) * 100).toFixed (1)} %` : formatValue (param ('damp'), v),
        parse: (t) => physical ? store.model.dampFromRatio (parseFloat (t.replace (',', '.')) / 100) : parseFloat (t.replace (',', '.')),
    });
    res.append (row ('', K ('decay', 'DECAY', 'prim', { tip: 'Ring time of the string, in seconds.' }), damp,
                         C ('dampMode', 'Damp Mode', { tip: 'Legacy: Damp is a loss per pass of the string (higher notes lose more per second). Physical: Damp sets how fast the high frequencies (around 4 kHz) die compared to Decay, in seconds and the same for every note: 0 = bright (as long as Decay), maximum = dark (1 % of Decay).' })));
    on ('dampMode', (v) =>
    {
        physical = Math.round (v.real) === 1;
        damp.setLabel (physical ? 'DAMP (T60)' : 'DAMP');
        damp.setTip (physical ? 'Physical mode: Damp is a ratio of decay times. It sets how long the high frequencies (around 4 kHz) ring compared to Decay, the same for every note: 0 = bright (100 %), maximum = dark (1 % of Decay). The box shows that percentage. Velocity > Damp and Pitch > Damp routes add to this setting.'
                              : 'Legacy mode: Damp is a loss per pass of the string, so higher notes lose more highs per second. Switch Damp Mode to Physical for a note-independent ratio of decay times.');
        damp.refresh();
    });
    page.push (res);

    // -- BUILD : TYPE (String / CHAOS / Tube) + Smooth / Rate, schéma de la corde, micro (Pickup), Inharmonicity
    const build = family ('BUILD', 'build');
    const type = K ('blend', 'TYPE', 'prim', { mid: 'CHAOS', ends: ['String', 'Tube'], tip: 'Type of resonator: 0 = String, 0.5 = CHAOS (random polarity flips), 1 = Tube.' });
    const schem = new StringSchematic();
    const side = el ('div', 'schem');
    side.append (schem.root, R (T ('outputTap', 'Out tap after delay', { tip: 'Output tap. On (default): the string is read at the end of the delay, one period of latency. Off: it is read where the loop is written, no latency.' })));
    const depth = K ('square', 'Pickup depth', 'sec', { tip: 'Pickup depth: how deeply the pickup-position comb notches the string\'s sound. 0 = off (plain string), 1 = full notches. Fully modulatable.' });
    const pos = K ('dephasage', 'Pickup position', 'sec', { tip: 'Pickup position along the string, as a fraction of its length (right = middle, left = near the bridge). At the middle, even harmonics are cancelled (hollow, square-wave-like tone); near the bridge, the tone gets thin and bright. Only audible when Pickup depth > 0.' });
    const spread = K ('pickupSpread', 'Pickup spread', 'sec', { tip: 'Moves the pickup to different positions on the left and right channels: a decorrelated stereo image at almost no cost. 0 = same position (mono-identical). Only audible when Pickup depth > 0.' });
    const inh = K ('inharmonicity', 'Inharmonicity', 'sec', {
        tip: 'Stiffness of the string: 0 = perfectly harmonic. Higher values push the upper partials sharp (f_n = n f0 sqrt((1 + B n^2) / (1 + B))) without detuning the fundamental: piano, bell, metallic tones. Log scale. At very high values on high notes the effect is reduced automatically. Fully modulatable.',
        format: (v) => v < 1e-6 ? 'Off' : Number (v.toPrecision (2)).toString(),
        parse: (t) => /^\s*(non|off)?\s*$/i.test (t) ? 0 : parseFloat (t.replace (',', '.')),
    });
    build.append (row ('tert', H ('blendSmooth', 'Smooth', { small: true, tip: 'Smooth: softens the random polarity flips of TYPE (0 = hard flips, as before; higher = flips glide, darker and less noisy). Fully modulatable.' }),
                               H ('blendRate', 'Rate', { small: true, tip: 'Rate: slows the random flips of TYPE like a sample & hold (0 = a new draw every sample, as before; higher = each draw is held longer, up to one pitch period). Fully modulatable.' })),
                  row ('type', type, side),
                  row ('', depth, pos, spread, inh));
    page.push (build);

    // -- Loop Filter (+ Keytrack, Filter Scale). En échelle T60 + Bandpass, Mix devient un rapport (Out-of-band decay ratio).
    let ratio = false;
    const loop = filterBlock ('Loop Filter', 'resoFilter', {
        caption: 'Out-of-band decay ratio',
        mixFormat: (v) => ratio ? store.model.loopRatioFromMix (v).toFixed (2) : formatValue (param ('resoFilterMix'), v),
        mixParse: (t) => ratio ? store.model.loopMixFromRatio (parseFloat (t.replace (',', '.'))) : parseFloat (t.replace (',', '.')),
    });
    loop.root.append (row ('pair', T ('resoFilterKeytrack', 'Keytrack', { tip: 'Loop Filter keytrack: on = the filter centre follows the played note, locked to the pitch of the note (the Freq setting is ignored), so the filter is always in tune with the string. Off = fixed Freq.' }),
                                   C ('loopFilterScale', 'Filter Scale', { tip: 'Legacy: Loop Filter Mix is a plain dry/wet. T60: Mix becomes the Out-of-band decay ratio (Bandpass mode; how much faster the frequencies outside the band die, in seconds, whatever the note).' })));
    const refreshLoop = () =>
    {
        ratio = Math.round (real ('loopFilterScale')) === 1 && Math.round (real ('resoFilterMode')) === 0;
        loop.caption.hidden = ! ratio;
        loop.mix.root.classList.toggle ('nolabel', ratio);
        loop.mix.setTip (ratio
            ? 'Out-of-band decay ratio: how much faster the frequencies outside the band die, as a ratio of Decay, the same for every note. 0 = no effect (1.00), 1 = they decay in 2 % of Decay (0.02). The box shows the ratio.'
            : 'Loop Filter dry/wet. With Filter Scale = T60 and Bandpass, this knob becomes the Out-of-band decay ratio.');
        loop.mix.refresh();
    };
    on ('loopFilterScale', refreshLoop);
    on ('resoFilterMode', refreshLoop);
    on ('resoFilterKeytrack', (v) =>
    {
        loop.freq.setDim (v.real > 0.5);
        loop.freq.setTip (v.real > 0.5 ? 'Ignored while Keytrack is on: the filter is centred on the note being played.' : 'Centre frequency of the Loop Filter.');
    });
    page.push (loop.root);

    // -- POLYCHORD
    const poly = family ('POLYCHORD');
    const bridge = K ('bridgeCoupling', 'Bridge', 'sec', { tip: 'Bridge coupling between the strings of a note (needs NUM > 1): the in-phase motion, which carries the attack, dies faster, while the out-of-phase motion keeps ringing with beating. This gives the double decay of a piano: a short bright attack, then a long aftersound. Same decay time for every note. Fully modulatable.' });
    poly.append (row ('', K ('numStrings', 'NUM', 'prim', { tip: 'Number of strings per note.' }), K ('detuneCents', 'DETUNE', 'prim', { tip: 'Detuning between the strings of a note, in cents.' })),
                 row ('', K ('stringSpread', 'Spread', 'sec', { tip: 'Stereo spread of the strings: 0 = all centred, 1 = fully panned.' }), bridge));
    on ('numStrings', (v) => bridge.setDim (Math.round (v.real) <= 1));
    const pickupDim = () =>
    {
        const off = real ('square') <= 0.0005 && ! routesFor ('square').length;
        pos.setDim (off);
        spread.setDim (off);
    };
    on ('square', pickupDim);
    onRoutes (pickupDim);
    page.push (poly);

    // -- PITCH : trois colonnes (VIBRATO / Speed, PORTAMENTO, BEND / Bend Range)
    const pitch = family ('PITCH', 'pitch');
    const col = (...w) => { const c = el ('div', 'col'); c.append (...w.map (R)); return c; };
    pitch.append (row ('cols',
        col (K ('vibratoDepth', 'VIBRATO', 'prim', { tip: 'Vibrato depth.' }), K ('vibratoFreq', 'Speed', 'sec', { tip: 'Vibrato speed.' })),
        col (K ('slideTime', 'PORTAMENTO', 'prim', { tip: 'Glide time between two notes.' })),
        col (K ('bend', 'BEND', 'prim', { tip: 'Fixed pitch bend, in semitones.' }), K ('bendRange', 'Bend Range', 'sec', { tip: 'Range of the pitch wheel, in semitones.' }))));
    page.push (pitch);

    // -- MIDI
    const midi = family ('MIDI', 'midi');
    midi.append (row ('', K ('release', 'Release', 'sec', { tip: 'Release time of the string after note-off.' }),
                          K ('velBrightness', 'Vel Bright', 'sec', { tip: 'Velocity brightness: soft notes get a darker attack, hard notes a brighter one. Filters the excitation only, so the sustain is unchanged (unlike Vel > Damp, which acts inside the loop and changes how long the highs ring). 0 = off (bit-exact bypass).' }),
                          T ('exciterLegacySharedBus', 'Sympathetic', { tip: 'On: a new note also re-excites the notes already held (sympathetic resonance). Off: each note only excites its own string.' }),
                          C ('retriggerMode', 'Note Mode', { tip: 'How a note behaves when it is played again, or while another is held. Strike (default): playing a note that is still sounding strikes the SAME string again, like a real string: no cut, the new hit adds to the vibration. One voice per note, lightest on CPU. Legato: classic mono legato. A note played while another is held does not re-attack: the held voice glides to the new pitch at the Portamento speed. Releasing it while an earlier key is still held glides back. Retrigger: a note that is still sounding fades out (50 ms) while a fresh string starts, so every hit sounds identical. Uses up to two voices per note. Infinite (CPU): every new hit of a ringing note takes a NEW voice and the previous tails keep ringing on top of each other until voices run out (the behaviour of earlier versions). Heaviest on CPU.' })));
    // comme dans le plugin : MIDI sous POLYCHORD et PITCH, à droite du Loop Filter
    const stack = el ('div', 'stack');
    stack.append (...page.splice (page.indexOf (poly)), midi);
    page.push (stack);
    return page;
}

// ================================================================ Output
function outputTab()
{
    const page = [];
    page.push (filterBlock ('Output Filter', 'outputFilter').root);

    const sat = family ('SAT', 'satf');
    const view = new SaturationView();
    // comme le plugin : DRIVE puis Curve en colonne, la courbe de transfert à droite
    const left = el ('div', 'col');
    left.append (R (K ('drive', 'DRIVE', 'prim', { tip: 'Saturation drive in dB. Has no effect when Curve is Linear.' })),
                 R (C ('distortionCurve', 'Curve', { tip: 'Linear = no distortion (Drive has no effect)' })));
    sat.append (row ('top', left, view.root));
    page.push (sat);

    const gain = family ('GAIN');
    // Limiter : forcé à On dans le web (web_api.cpp) ; la case est affichée cochée et grisée, Ceiling reste réglable
    const lim = T ('limiter', 'Limiter', { tip: 'Output peak limiter, after GAIN: no sample goes above Ceiling. Instant attack, smooth release, '
                                              + 'no added latency. While the signal stays below Ceiling the sound is untouched. Always on in the web demo.' });
    lim.box.disabled = true;
    gain.append (R (K ('outputGain', 'GAIN', 'prim', { tip: 'Final output level.' })), R (lim),
                 R (K ('limiterCeiling', 'Ceiling', 'sec', { tip: 'Limiter ceiling in dB: the highest level a sample can reach when Limiter is on.' })));
    page.push (gain);

    const machine = family ('', 'machine');
    const mv = C ('maxVoices', 'Max Voices', { tip: 'Maximum number of simultaneous notes (1 / 4 / 8 / 16). Fewer voices = less CPU and memory. 1 = classic monophonic: the last note wins, and releasing it brings back the previous held note. Beyond the limit, the oldest note is stolen.' });
    // Oversampling : réglage de machine, fixé à Off par la démo (coût CPU des téléphones) ; menu affiché mais grisé
    const os = el ('div', 'ctl combo');
    const osWrap = el ('span', 'select'), osSel = el ('select');
    osSel.append (new Option ('Off', 0));
    osSel.disabled = true;
    osWrap.append (osSel);
    os.append (el ('span', 'lbl', 'Oversampling'), osWrap);
    os.title = 'Internal oversampling factor (Off / 2x / 4x). Fixed to Off in the web demo (CPU cost on phones).';
    machine.append (row ('', os, mv));
    page.push (machine);
    return page;
}

// ================================================================ Mod
function modTab()
{
    const page = [];

    // -- LFO : options globales, puis LFO 1 à 4 (2 à 4 suivent leur tuile « + » / « × »)
    const lfo = family ('LFO', 'wide');
    lfo.append (row ('opts', T ('modRetrigger', 'RETRIG', { tip: 'Resets the LFOs to phase 0 on the first note-on of a phrase.' }),
                             T ('modActiveOnlyWhenPlaying', 'Offline', { tip: 'The LFOs sit at 0 while no voice is active (~8 ms fade).' })));
    const grid = el ('div', 'subgrid');
    for (let i = 1; i <= 4; ++i)
    {
        const sfx = i === 1 ? '' : String (i);
        const s = el ('div', 'subsec');
        s.dataset.source = [0, 6, 10, 11][i - 1];   // LFO, LFO 2, LFO 3, LFO 4 (numéros ModSourceType)
        const view = new LfoView (sfx);
        const wave = C (`modLfoWaveform${sfx}`, '');
        wave.root.querySelector ('.lbl').remove();
        const side = el ('div', 'side');
        side.append (R (wave), view.root);
        s.append (sub (`LFO ${i}`), row ('', K (`modLfoRate${sfx}`, 'Speed', 'sec', { tip: 'LFO rate, in Hz.' }),
                                             K (`modLfoDepth${sfx}`, 'Depth'),
                                             K (`modLfoRandomSmooth${sfx}`, 'Smooth', 'sec', { tip: 'Smooths the LFO output, whatever the waveform. Random: 0 = stepped (S&H), 1 = continuous glide. Other waves: low-pass.' }),
                                             side));
        if (i > 1) { exposed.add (`modLfoEnabled${i}`); on (`modLfoEnabled${i}`, (v) => { s.hidden = v.real < 0.5; }); }
        grid.append (s);
    }
    lfo.append (grid);
    page.push (lfo);

    // -- ENVELOPE : Envelope 1 / 2, Env Follower / Env Follower 2
    const envF = family ('ENVELOPE', 'wide');
    const eg = el ('div', 'subgrid');
    for (const n of ['', '2'])
    {
        const s = el ('div', `subsec env${n || '1'}`);
        s.dataset.source = n ? 8 : 4;   // Envelope 2 / Envelope
        const keys = { a: `modEnvAttack${n}`, d: `modEnvDecay${n}`, s: `modEnvSustain${n}`, r: `modEnvRelease${n}`,
                       ac: `modEnvAttackCurve${n}`, dc: `modEnvDecayCurve${n}`, rc: `modEnvReleaseCurve${n}` };
        [keys.ac, keys.dc, keys.rc].forEach (k => exposed.add (k));
        const view = new EnvelopeView (keys, 56);
        const head = el ('div', 'subhead');
        head.append (sub (`Envelope ${n || '1'}`));
        if (! n) { const m = C ('modEnvMode', '', { labels: ['Mono', 'Multi (coming soon)'], tip: 'Mono: one envelope for all notes. Multi: coming soon.' }); m.root.querySelector ('.lbl').remove(); head.append (R (m)); }
        s.append (head, view.root, row ('', K (keys.a, 'Attack'), K (keys.d, 'Decay'), K (keys.s, 'Sustain'), K (keys.r, 'Release')));
        if (n) { exposed.add ('modEnvEnabled2'); on ('modEnvEnabled2', (v) => { s.hidden = v.real < 0.5; }); }
        eg.append (s);
    }
    for (const n of ['', '2'])
    {
        const s = el ('div', `subsec fol${n || '1'}`);
        s.dataset.source = n ? 9 : 5;   // Env Follower 2 / Env Follower
        s.append (sub (n ? `Env Follower ${n}` : 'Env Follower'),
                  row ('', K (`modEnvFollowerAttack${n}`, 'Rise'), K (`modEnvFollowerRelease${n}`, 'Fall'),
                           K (`modEnvFollowerGain${n}`, 'Gain', 'sec', { tip: 'Gain applied to the followed signal (dB). Raise it when the modulation is too weak.' })));
        if (n) { exposed.add ('modEnvFollowerEnabled2'); on ('modEnvFollowerEnabled2', (v) => { s.hidden = v.real < 0.5; }); }
        eg.append (s);
    }
    envF.append (eg);
    page.push (envF);

    // -- MIDI : Velocity et Pitch (vue de mapping + 5 réglages)
    const midi = family ('MIDI', 'wide');
    for (const [title, prefix, source] of [['Velocity', 'modVelocity', 2], ['Pitch', 'modPitch', 3]])
    {
        const s = el ('div', 'subsec mapping-sec');
        s.dataset.source = source;   // Velocity / Pitch
        const view = new MappingView (prefix, source);
        s.append (sub (title), row ('', view.root, K (`${prefix}InMin`, 'In Min'), K (`${prefix}InMax`, 'In Max'),
                                       K (`${prefix}Min`, 'Out Min'), K (`${prefix}Max`, 'Out Max'), K (`${prefix}Curve`, 'Curve')));
        midi.append (s);
    }
    page.push (midi);

    // -- ROUTES : toutes les routes du preset (et celles ajoutées), modifiables
    const routes = family ('ROUTES', 'wide routes');
    const list = el ('div', 'route-list');
    routes.append (list);
    const rebuild = () =>
    {
        list.replaceChildren();
        if (! store.routes.length) list.append (el ('p', 'note', 'No route yet. Drag a source from the bottom panel onto a parameter to create one.'));
        for (const r of store.routes) list.append (routeRow (r, null, true));
    };
    onRoutes (rebuild);
    page.push (routes);
    return page;
}

export const TABS =
[
    { id: 'exciter', label: 'Exciter', build: exciterTab },
    { id: 'gran',    label: 'Gran',    build: granTab },
    { id: 'reso',    label: 'Reso',    build: resoTab },
    { id: 'output',  label: 'Output',  build: outputTab },
    { id: 'mod',     label: 'Mod',     build: modTab },
];
