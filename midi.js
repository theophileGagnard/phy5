// midi.js -- lecture minimale d'un fichier MIDI (formats 0 et 1) en événements datés en secondes.
// Gère les changements de tempo ; sans tempo dans le fichier, 120 BPM (comme les lecteurs MIDI).
// Événements : { t, kind, note, value }  kind : 0 note on (value = vélocité 0..1), 1 note off, 2 pitch bend (value = -1..1),
// 4 contrôleur (note = numéro, value = 0..127). Tous les canaux sont fusionnés.
// Renvoie { events, bpm } : bpm = tempo de départ du fichier (référence du curseur Tempo de la page).

export function parseMidi (buffer)
{
    const d = new Uint8Array (buffer);
    let i = 0;
    const u32 = () => (d[i++] << 24 | d[i++] << 16 | d[i++] << 8 | d[i++]) >>> 0;
    const u16 = () => d[i++] << 8 | d[i++];
    const vlq = () => { let v = 0, b; do { b = d[i++]; v = v * 128 + (b & 0x7f); } while (b & 0x80); return v; };
    const tag = () => String.fromCharCode (d[i++], d[i++], d[i++], d[i++]);

    if (tag() !== 'MThd') throw new Error ('pas un fichier MIDI');
    const headerLen = u32();
    const headerEnd = i + headerLen;
    u16();                                  // format
    const numTracks = u16();
    const division = u16();
    if (division & 0x8000) throw new Error ('division SMPTE non gérée');
    i = headerEnd;

    const raw = [], tempos = [{ tick: 0, usPerQuarter: 500000 }];
    for (let t = 0; t < numTracks; ++t)
    {
        if (tag() !== 'MTrk') throw new Error ('piste MIDI invalide');
        const trackLen = u32();
        const trackEnd = i + trackLen;
        let tick = 0, status = 0;
        while (i < trackEnd)
        {
            tick += vlq();
            let b = d[i];
            if (b === 0xff)
            {
                const type = d[i + 1]; i += 2;
                const len = vlq();
                if (type === 0x51) tempos.push ({ tick, usPerQuarter: d[i] << 16 | d[i + 1] << 8 | d[i + 2] });
                i += len;
                continue;
            }
            if (b === 0xf0 || b === 0xf7) { ++i; i += vlq(); continue; }
            if (b & 0x80) { status = b; ++i; }
            const type = status & 0xf0;
            const a = d[i++];
            const b2 = (type === 0xc0 || type === 0xd0) ? 0 : d[i++];
            if (type === 0x90 && b2 > 0) raw.push ({ tick, kind: 0, note: a, value: b2 / 127 });
            else if (type === 0x80 || (type === 0x90 && b2 === 0)) raw.push ({ tick, kind: 1, note: a, value: 0 });
            else if (type === 0xe0) raw.push ({ tick, kind: 2, note: 0, value: ((b2 << 7 | a) - 8192) / 8192 });
            else if (type === 0xb0) raw.push ({ tick, kind: 4, note: a, value: b2 });
        }
        i = trackEnd;
    }

    // ticks -> secondes, en suivant la carte des tempos
    tempos.sort ((x, y) => x.tick - y.tick);
    const toSeconds = (tick) =>
    {
        let sec = 0, prevTick = 0, us = 500000;
        for (const tp of tempos)
        {
            if (tp.tick >= tick) break;
            sec += (tp.tick - prevTick) * us / division / 1e6;
            prevTick = tp.tick; us = tp.usPerQuarter;
        }
        return sec + (tick - prevTick) * us / division / 1e6;
    };
    raw.sort ((x, y) => x.tick - y.tick);
    const events = raw.map (e => ({ t: toSeconds (e.tick), kind: e.kind, note: e.note, value: e.value }));
    return { events, bpm: 60e6 / tempos.filter (tp => tp.tick === 0).at (-1).usPerQuarter };
}
