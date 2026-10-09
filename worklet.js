// worklet.js -- le moteur complet de Rezonathor sur le thread audio du navigateur (AudioWorklet).
// Les notes (morceau MIDI et clavier) sont appliquées ICI, à l'échantillon près : le bloc est découpé à chaque événement.
// La page garde sa propre copie du moteur (modèle de l'interface, sans son) et envoie ici les mêmes changements ; ce thread
// lui renvoie seulement ce qui vit pendant le jeu : niveau, voix, et ~30 fois par seconde les valeurs des sources de
// modulation et des paramètres modulés (marqueurs bleu-vert de l'interface).
import { Rezo, applyMobileLimits } from './rezo.js';

class RezoProcessor extends AudioWorkletProcessor
{
    constructor (options)
    {
        super();
        this.rezo = new Rezo (options.processorOptions.wasm, sampleRate, true);
        this.mobile = options.processorOptions.mobile;

        this.playing = false;
        this.song = [];         // événements { t (s), kind, note, value } -- voir midi.js
        this.songBpm = 120;     // tempo du fichier : le curseur Tempo joue le morceau à bpm / songBpm
        this.bpm = 120;
        this.songIndex = 0;
        this.songTime = 0;      // position dans le morceau, en secondes du FICHIER
        this.songFrame = 0;     // échantillon où songTime a été mis à jour
        this.songNotes = new Set();
        this.live = [];         // notes du clavier, appliquées au début du prochain bloc
        this.clock = 0;
        this.reportCountdown = 0;
        this.modCountdown = 0;
        this.modTargets = [];   // identifiants des paramètres visés par une route (relus après preset / routes)
        this.modSources = new Float32Array (12);

        this.port.onmessage = (e) => this.onMessage (e.data);
        this.port.postMessage ({ type: 'ready', params: this.rezo.params, values: this.snapshot() });
    }

    snapshot()
    {
        return this.rezo.params.map (p => ({ real: this.rezo.get (p.key), norm: this.rezo.getNormalized (p.key) }));
    }

    onMessage (m)
    {
        switch (m.type)
        {
            case 'preset':
            {
                this.releaseSong();
                const error = this.rezo.applyPreset (m.text);
                const limits = (! error && this.mobile) ? applyMobileLimits (this.rezo) : [];
                this.readModTargets();
                this.port.postMessage ({ type: 'preset', error, limits });
                break;
            }
            case 'state':   // au démarrage du son : preset de la page, puis ses valeurs réelles et ses routes (réglages déjà faits)
                this.rezo.applyPreset (m.text);
                for (const [key, real] of m.values) this.rezo.set (key, real);
                this.rezo.setRoutes (m.routes);
                if (this.mobile) applyMobileLimits (this.rezo);
                this.readModTargets();
                break;
            case 'set':
                this.rezo.setNormalized (m.key, m.norm);
                if (this.mobile && (m.key === 'numStrings' || m.key === 'maxVoices')) applyMobileLimits (this.rezo);
                break;
            case 'routes':
                this.rezo.setRoutes (m.routes);
                this.readModTargets();
                break;
            case 'song':  this.song = m.events; this.songBpm = m.bpm; break;
            case 'bpm':   this.advanceSong (this.clock); this.bpm = m.bpm; break;
            case 'play':
                this.playing = m.on;
                if (m.on) { this.songIndex = 0; this.songTime = 0; this.songFrame = this.clock; }
                else this.releaseSong();
                break;
            case 'noteOn':  this.live.push (m); break;
            case 'noteOff': this.live.push (m); break;
        }
    }

    readModTargets()
    {
        this.modTargets = [...new Set (this.rezo.routes().map (r => r.target))];
    }

    releaseSong()
    {
        for (const n of this.songNotes) this.rezo.noteOff (n);
        this.songNotes.clear();
        this.rezo.pitchWheel (8192);
    }

    // avance la position du morceau jusqu'à `now` au tempo courant
    advanceSong (now)
    {
        if (now <= this.songFrame) return;
        this.songTime += (now - this.songFrame) / sampleRate * (this.bpm / this.songBpm);
        this.songFrame = now;
    }

    // échantillon (absolu) du prochain événement du morceau, ou Infinity
    nextSongFrame()
    {
        if (! this.playing || this.song.length === 0) return Infinity;
        if (this.songIndex >= this.song.length) return this.songFrame;   // fin : reboucler maintenant
        const dt = (this.song[this.songIndex].t - this.songTime) / (this.bpm / this.songBpm);
        return this.songFrame + Math.max (0, Math.round (dt * sampleRate));
    }

    fireSongEvents (now)
    {
        this.advanceSong (now);
        const eps = 0.5 / sampleRate;
        while (this.songIndex < this.song.length && this.song[this.songIndex].t <= this.songTime + eps)
        {
            const e = this.song[this.songIndex++];
            if (e.kind === 0) { this.rezo.noteOn (e.note, e.value); this.songNotes.add (e.note); }
            else if (e.kind === 1) { this.rezo.noteOff (e.note); this.songNotes.delete (e.note); }
            else if (e.kind === 2) this.rezo.pitchWheel (Math.round (e.value * 8192 + 8192));
        }
        if (this.songIndex >= this.song.length)   // fin du morceau : 2 s de silence puis on reboucle
        {
            this.releaseSong();
            this.songIndex = 0;
            this.songTime = 0;
            this.songFrame = now + Math.round (2 * sampleRate);
        }
    }

    process (inputs, outputs)
    {
        const out = outputs[0];
        const n = out[0].length;
        let pos = 0;

        while (pos < n)
        {
            const now = this.clock + pos;
            this.rezo.beginBlock();

            if (pos === 0)
            {
                for (const m of this.live)
                    m.type === 'noteOn' ? this.rezo.noteOn (m.note, m.velocity) : this.rezo.noteOff (m.note);
                this.live.length = 0;
            }
            if (this.nextSongFrame() <= now)
                this.fireSongEvents (now);

            const until = Math.min (n, this.nextSongFrame() - this.clock);
            const len = Math.max (1, until - pos);
            this.rezo.process (pos, len);
            pos += len;
        }

        const [L, R] = this.rezo.process (n, 0);   // vues à jour (la mémoire WASM a pu grandir)
        out[0].set (L.subarray (0, n));
        if (out[1]) out[1].set (R.subarray (0, n));
        this.clock += n;

        if (--this.reportCountdown <= 0)
        {
            this.reportCountdown = Math.round (sampleRate / n / 4);   // 4 fois par seconde
            let peak = 0;
            for (let i = 0; i < n; ++i) peak = Math.max (peak, Math.abs (L[i]), Math.abs (R[i]));
            this.port.postMessage ({ type: 'meter', voices: this.rezo.activeVoices(), peak });
        }
        if (--this.modCountdown <= 0)
        {
            this.modCountdown = Math.max (1, Math.round (sampleRate / n / 30));   // ~30 fois par seconde
            for (let i = 0; i < 12; ++i) this.modSources[i] = this.rezo.modSourceValue (i);
            const mods = this.modTargets.map (k => [k, this.rezo.modulatedNormalized (k)]);
            this.port.postMessage ({ type: 'mod', sources: Array.from (this.modSources), mods,
                                     velIn: this.rezo.modInputDisplay (0), pitchIn: this.rezo.modInputDisplay (1) });
        }
        return true;
    }
}

registerProcessor ('rezo', RezoProcessor);
