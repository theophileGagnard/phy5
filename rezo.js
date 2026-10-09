// rezo.js -- enveloppe JavaScript du moteur Rezonathor compilé en WebAssembly (rezo.wasm).
// Même code dans l'AudioWorklet, le Web Worker du banc CPU et Node (tests).

// TextDecoder / TextEncoder n'existent pas dans un AudioWorklet : UTF-8 fait à la main dans ce cas
const utf8Decode = typeof TextDecoder !== 'undefined'
    ? (bytes) => new TextDecoder().decode (bytes)
    : (bytes) =>
    {
        let out = '';
        for (let i = 0; i < bytes.length;)
        {
            const b = bytes[i++];
            let cp = b;
            if (b >= 0xf0)      { cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f); }
            else if (b >= 0xe0) { cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f); }
            else if (b >= 0xc0) { cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f); }
            out += String.fromCodePoint (cp);
        }
        return out;
    };

const utf8Encode = typeof TextEncoder !== 'undefined'
    ? (text) => new TextEncoder().encode (text)
    : (text) =>
    {
        const out = [];
        for (const ch of text)
        {
            const cp = ch.codePointAt (0);
            if (cp < 0x80) out.push (cp);
            else if (cp < 0x800) out.push (0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
            else if (cp < 0x10000) out.push (0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
            else out.push (0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        }
        return Uint8Array.from (out);
    };

export class Rezo
{
    // bytes : contenu de rezo.wasm (ou module déjà compilé) ; instanciation synchrone (permise dans un worklet ou un worker).
    // `instance` : instance déjà créée (voir Rezo.create, pour la page).
    constructor (bytes, sampleRate, isSynth = true, instance = null)
    {
        if (! instance)
        {
            const module = bytes instanceof WebAssembly.Module ? bytes : new WebAssembly.Module (bytes);
            instance = new WebAssembly.Instance (module, Rezo.stubImports (module));
        }
        this.ex = instance.exports;
        this.ex._initialize?.();
        this.maxBlock = this.ex.rezo_create (sampleRate, isSynth ? 1 : 0);
        this.params = JSON.parse (this.cString (this.ex.rezo_param_table()));
        this.byKey = Object.fromEntries (this.params.map (p => [p.key, p]));
    }

    // bouchons WASI (le moteur n'en a pas besoin)
    static stubImports (module)
    {
        const imports = {};
        for (const imp of WebAssembly.Module.imports (module))
        {
            imports[imp.module] ??= {};
            if (imp.kind === 'function') imports[imp.module][imp.name] = () => 0;
        }
        return imports;
    }

    // Page (thread principal) : compilation et instanciation ASYNCHRONES (le navigateur y limite la forme synchrone).
    // La page garde ainsi sa propre copie du moteur, qui ne rend aucun son : c'est le « modèle » de l'interface (table et
    // valeurs des paramètres, presets, routes), disponible avant même de démarrer le son.
    static async create (bytes, sampleRate, isSynth = true)
    {
        const module = await WebAssembly.compile (bytes);
        const instance = await WebAssembly.instantiate (module, Rezo.stubImports (module));
        return new Rezo (null, sampleRate, isSynth, instance);
    }

    cString (ptr)
    {
        const mem = new Uint8Array (this.ex.memory.buffer);
        let end = ptr;
        while (mem[end] !== 0) ++end;
        return utf8Decode (mem.subarray (ptr, end));
    }

    // valeur réelle (comme un chargement de preset) ou normalisée 0..1 (comme une automation)
    set (key, value)           { this.ex.rezo_set_param (this.byKey[key].id, value); }
    setNormalized (key, value) { this.ex.rezo_set_param_normalized (this.byKey[key].id, value); }
    get (key)                  { return this.ex.rezo_get_param (this.byKey[key].id); }
    getNormalized (key)        { return this.ex.rezo_get_param_normalized (this.byKey[key].id); }
    toNormalized (key, value)  { return this.ex.rezo_to_normalized (this.byKey[key].id, value); }

    fromNormalized (key, n)    { return this.ex.rezo_from_normalized (this.byKey[key].id, n); }

    // ------------------------------------------------------------ modulation
    // routes : [{ source (numéro ModSourceType), target (clé), depth (-1..1), bipolar }]
    routes()
    {
        const n = this.ex.rezo_mod_route_count();
        const out = [];
        for (let i = 0; i < n; ++i)
        {
            const p = this.params[this.ex.rezo_mod_route_target (i)];
            if (p) out.push ({ source: this.ex.rezo_mod_route_source (i), target: p.key,
                               depth: this.ex.rezo_mod_route_depth (i), bipolar: this.ex.rezo_mod_route_bipolar (i) !== 0 });
        }
        return out;
    }
    setRoutes (list)
    {
        this.ex.rezo_clear_mod_routes();
        for (const r of list)
            if (this.byKey[r.target]) this.ex.rezo_add_mod_route (r.source, this.byKey[r.target].id, r.depth, r.bipolar ? 1 : 0);
    }
    modSourceValue (source)   { return this.ex.rezo_mod_source_value (source); }
    modInputDisplay (which)   { return this.ex.rezo_mod_input_display (which); }   // 0 = vélocité, 1 = hauteur
    modulatedNormalized (key) { return this.ex.rezo_modulated_normalized (this.byKey[key].id); }

    // ------------------------------------------------------------ fonctions d'affichage (formules du DSP)
    dampRatio (damp)          { return this.ex.rezo_damp_ratio (damp); }
    dampFromRatio (r)         { return this.ex.rezo_damp_from_ratio (r); }
    loopRatioFromMix (m)      { return this.ex.rezo_loop_ratio_from_mix (m); }
    loopMixFromRatio (r)      { return this.ex.rezo_loop_mix_from_ratio (r); }
    granLatencyMs (w, b, s)   { return this.ex.rezo_gran_latency_ms (w, b, s); }
    softClip (curve, db, x)   { return this.ex.rezo_soft_clip (curve, db, x); }
    lfoPreview (wave, depth, smooth, perPeriod = 120)
    {
        const ptr = this.ex.rezo_lfo_preview (wave, depth, smooth, perPeriod);
        return new Float32Array (this.ex.memory.buffer, ptr, 2 * perPeriod + 1).slice();
    }

    // preset au format du Core (texte JSON) ; renvoie null si appliqué, sinon le message d'erreur
    applyPreset (text)
    {
        const bytes = utf8Encode (text);
        const ptr = this.ex.rezo_alloc (bytes.length + 1);
        const mem = new Uint8Array (this.ex.memory.buffer, ptr, bytes.length + 1);
        mem.set (bytes); mem[bytes.length] = 0;
        const ok = this.ex.rezo_apply_preset (ptr);
        this.ex.rezo_free (ptr);
        return ok ? null : this.cString (this.ex.rezo_last_error());
    }

    // état courant -> preset JSON du Core (texte), sous le nom donné
    presetJson (name)
    {
        const bytes = utf8Encode (name);
        const ptr = this.ex.rezo_alloc (bytes.length + 1);
        const mem = new Uint8Array (this.ex.memory.buffer, ptr, bytes.length + 1);
        mem.set (bytes); mem[bytes.length] = 0;
        const text = this.cString (this.ex.rezo_preset_json (ptr));
        this.ex.rezo_free (ptr);
        return text;
    }

    beginBlock()            { this.ex.rezo_begin_block(); }
    noteOn (note, velocity) { this.ex.rezo_note_on (note, velocity); }
    noteOff (note)          { this.ex.rezo_note_off (note); }
    pitchWheel (value14)    { this.ex.rezo_pitch_wheel (value14); }
    allNotesOff()           { this.ex.rezo_all_notes_off(); }
    activeVoices()          { return this.ex.rezo_active_voices(); }

    // rend n échantillons à partir de offset ; renvoie les deux tampons de sortie (vues sur la mémoire WASM)
    process (offset, n)
    {
        this.ex.rezo_process (offset, n);
        if (! this.outL || this.outL.buffer !== this.ex.memory.buffer)   // la mémoire a pu grandir
        {
            this.outL = new Float32Array (this.ex.memory.buffer, this.ex.rezo_out_left(), this.maxBlock);
            this.outR = new Float32Array (this.ex.memory.buffer, this.ex.rezo_out_right(), this.maxBlock);
        }
        return [this.outL, this.outR];
    }
}

// Limites « mobile » (décision : pas d'oversampling, 8 voix, 2 cordes au plus) appliquées après un preset.
export function applyMobileLimits (rezo)
{
    const notes = [];
    if (rezo.get ('maxVoices') > 2)   // index du choix : 0 = 1, 1 = 4, 2 = 8, 3 = 16 voix
        { rezo.set ('maxVoices', 2); notes.push ('8 voices'); }
    if (rezo.get ('numStrings') > 2) { rezo.set ('numStrings', 2); notes.push ('2 strings'); }
    return notes;
}
