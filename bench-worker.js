// bench-worker.js -- banc CPU : rend le morceau avec le preset choisi, aussi vite que possible, dans un Web Worker.
// Fonctionne en http simple (téléphone sur le réseau local), contrairement au son qui exige https ou localhost.
import { Rezo, applyMobileLimits } from './rezo.js';

self.onmessage = (e) =>
{
    const { wasm, presetText, events, mobile, seconds } = e.data;
    const sr = 48000;
    const rezo = new Rezo (wasm, sr, true);
    rezo.applyPreset (presetText);
    if (mobile) applyMobileLimits (rezo);

    const total = Math.round (seconds * sr);
    let next = 0;
    const t0 = performance.now();
    for (let pos = 0; pos < total; pos += 128)
    {
        rezo.beginBlock();
        while (next < events.length && events[next].t * sr < pos + 128)
        {
            const ev = events[next++];
            if (ev.kind === 0) rezo.noteOn (ev.note, ev.value);
            else if (ev.kind === 1) rezo.noteOff (ev.note);
            else if (ev.kind === 2) rezo.pitchWheel (Math.round (ev.value * 8192 + 8192));
        }
        rezo.process (0, 128);
    }
    const elapsed = (performance.now() - t0) / 1000;
    self.postMessage ({ percent: elapsed / seconds * 100, seconds, strings: rezo.get ('numStrings') });
};
