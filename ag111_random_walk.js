
(function () {
    "use strict";

    const NU0 = 5e12;
    const Q_E = 1.6019e-19;
    const K_B = 1.3807e-23;
    const EA = 0.10;
    const SUBSTRATE_ATOM_LIMIT = 100;
    const DI = [0, -1, -1, 0, +1, +1];
    const DJ = [+1, +1, 0, -1, -1, 0];
    const KNOTS = [
        [0, 0, 0],
        [165, 42, 42],
        [255, 0, 0],
        [255, 165, 0],
        [255, 215, 0]
    ];

    function mulberry32(seed) {
        // Expose an independent copy of the generator's *current state*.
        // No extra random numbers are consumed by the music system.
        function next() {
            let t = seed += 0x6D2B79F5;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        }
        next.clone = () => mulberry32(seed);
        return next;
    }

    function makeSeed() {
        const values = new Uint32Array(1);
        crypto.getRandomValues(values);
        return values[0];
    }

    function setSeed(seed) {
        sim.seed = seed >>> 0;
        random = mulberry32(sim.seed);

        const url = new URL(window.location.href);
        url.searchParams.set("seed", String(sim.seed));
        history.replaceState(null, "", url);
    }


    let random = Math.random;

    const canvas = document.getElementById("view");
    const ctx = canvas.getContext("2d");

    const ui = {
        cols: document.getElementById("vCols"),
        rows: document.getElementById("vRows"),
        steps: document.getElementById("vSteps"),
        time: document.getElementById("vTime"),
        temp: document.getElementById("vTemp"),
        seed: document.getElementById("vSeed"),
        rate: document.getElementById("vRate"),
        tau: document.getElementById("vTau"),
        vmax: document.getElementById("vMax"),
        dt: document.getElementById("vDt"),
        msd: document.getElementById("vMsd"),
        msdMax: document.getElementById("vMsdMax"),
        tempIn: document.getElementById("temp"),
        tempLbl: document.getElementById("tempLbl"),
        sizeIn: document.getElementById("size"),
        sizeLbl: document.getElementById("sizeLbl"),
        speedIn: document.getElementById("speed"),
        speedLbl: document.getElementById("speedLbl"),
        musicEnabled: document.getElementById("musicEnabled"),
        musicHint: document.getElementById("musicHint"),
        play: document.getElementById("btnPlay"),
        step: document.getElementById("btnStep"),
        reset: document.getElementById("btnReset"),
        saveSvg: document.getElementById("btnSaveSvg"),
        recordCount: document.getElementById("recordCount"),
        downloadCsv: document.getElementById("btnDownloadCsv"),
        newRun: document.getElementById("btnNewRun")


    };

    // Sonification is deliberately independent of the physical hopping rate.
    // A4 (440 Hz) is visit 1; successive visits advance by one semitone.
    // Visit counts above 9 use the same final note as visit 9.
    const NOTE_DURATION = 0.04; // seconds
    const MUSIC_INTERVAL_MS = 120; // approximately 8.33 hops per wall-clock second
    const SILENT_FRAME_MS = 16; // close to the original 60 Hz animation
    let audioContext = null;
    // The user's Safari plays a full WAV through a normal <audio> element,
    // but both Web Audio tests were silent. Avoid interrupted short WAV clips:
    // use one continuous WAV score containing an exact *predicted* sequence
    // of upcoming visit-count notes. The RNG is cloned, never advanced.
    const useSafariWav = navigator.vendor === "Apple Computer, Inc.";
    const SAFARI_SCORE_HOPS = 250; // 30 seconds of uninterrupted playback
    const SAFARI_SAMPLE_RATE = 44100;
    const SAFARI_NOTE_LENGTH = 0.085; // each note fades inside the 120-ms slot
    let wavPlayer = document.getElementById("chemistryWavPlayer");
    let safariScore = null;
    let wavError = null;
    let wavPlaying = false;
    let lastMusicalHopTime = null;
    let animationTimerId = null;
    // Timer generations prevent a previously scheduled tick from restarting playback.
    let playbackGeneration = 0;
    // Safari may miss a click after its pointerdown; count one press only.
    let safariPointerHandled = false;
    const safariPointerFallback =
        navigator.vendor === "Apple Computer, Inc." &&
        typeof window.PointerEvent !== "undefined";
    const debugPause = new URLSearchParams(window.location.search).get("debugPause") === "1";
    let debugCounter = 0;
    let debugStatus = null;

    function musicIsOn() {
        return Boolean(ui.musicEnabled && ui.musicEnabled.checked &&
            !ui.musicEnabled.disabled);
    }

    function updateMusicHint() {
        if (Number(ui.speedIn.value) !== 1) {
            ui.musicHint.textContent = "Sound is available only when hops per frame = 1.";
        } else if (!musicIsOn()) {
            ui.musicHint.textContent = "Switch on Chemistry plays music to hear individual hops.";
        } else if (useSafariWav) {
            if (wavError) {
                ui.musicHint.textContent = "Safari audio: " + wavError +
                    " · switch music off and on to retry.";
            } else if (!sim.playing) {
                ui.musicHint.textContent = "Safari WAV ready · press Play to hear the notes.";
            } else if (wavPlaying) {
                ui.musicHint.textContent = "Safari WAV playing · about 8.3 hops per second.";
            } else {
                ui.musicHint.textContent = "Safari WAV starting…";
            }
        } else if (!audioContext) {
            ui.musicHint.textContent = "Music selected; waiting for audio activation.";
        } else if (audioContext.state === "running") {
            ui.musicHint.textContent = "Audio ready · about 8.3 musical hops per second.";
        } else {
            ui.musicHint.textContent = "Audio " + audioContext.state +
                " · click the music checkbox off and on to retry.";
        }
    }

    // Predict forthcoming visits without changing the Monte Carlo generator.
    // Both random draws per hop (direction and waiting time) must be mirrored.
    function predictSafariNotes(count) {
        const future = random.clone();
        const visits = sim.visits.map(row => new Int32Array(row));
        let iu = sim.iu;
        let ju = sim.ju;
        const notes = [];
        for (let index = 0; index < count; index++) {
            const direction = Math.floor(future() * 6);
            iu += DI[direction];
            ju += DJ[direction];
            const v = ++visits[wrap(iu, sim.nrows)][wrap(ju, sim.ncols)];
            notes.push(v);
            let u = future();
            while (u === 0) u = future();
        }
        return notes;
    }

    function buildSafariScoreWav(notes) {
        // A single standard 16-bit PCM WAV, just like the successful test C.
        // Short marimba-like *notes* are contained in a long *file*. Safari
        // no longer has to reload/start/pause media for each atomic hop.
        const rate = SAFARI_SAMPLE_RATE;
        const slot = Math.round(rate * MUSIC_INTERVAL_MS / 1000);
        const noteSamples = Math.round(rate * SAFARI_NOTE_LENGTH);
        const totalSamples = (notes.length + 1) * slot;
        const data = new ArrayBuffer(44 + totalSamples * 2);
        const view = new DataView(data);
        function ascii(at, value) {
            for (let j = 0; j < value.length; j++) {
                view.setUint8(at + j, value.charCodeAt(j));
            }
        }
        ascii(0, "RIFF");
        view.setUint32(4, 36 + 2 * totalSamples, true);
        ascii(8, "WAVE"); ascii(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, rate, true);
        view.setUint32(28, rate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        ascii(36, "data");
        view.setUint32(40, 2 * totalSamples, true);

        const waveforms = Array.from({ length: 9 }, (_, pitch) => {
            const frequency = 440 * Math.pow(2, pitch / 12);
            const tone = new Int16Array(noteSamples);
            for (let i = 0; i < noteSamples; i++) {
                const t = i / rate;
                const attack = Math.min(1, t / 0.0015);
                const fade = Math.min(1, Math.max(0, (SAFARI_NOTE_LENGTH - t) / 0.020));
                function partial(mult, amplitude, decay) {
                    const phase = 2 * Math.PI * frequency * mult *
                        (t + 0.0001 * (1 - Math.exp(-t / 0.01)));
                    return amplitude * Math.exp(-t / decay) * Math.sin(phase);
                }
                const sample = attack * fade * (
                    partial(1.0, 0.40, 0.105) +
                    partial(3.9, 0.15, 0.035) +
                    partial(9.2, 0.11, 0.012)
                );
                tone[i] = Math.round(32767 * Math.max(-1, Math.min(1, sample)));
            }
            return tone;
        });
        for (let n = 0; n < notes.length; n++) {
            // First note at 120 ms: exactly when the first displayed hop occurs.
            const offset = (n + 1) * slot;
            const tone = waveforms[Math.max(0, Math.min(8, notes[n] - 1))];
            for (let i = 0; i < tone.length; i++) {
                view.setInt16(44 + (offset + i) * 2, tone[i], true);
            }
        }
        return new Blob([data], { type: "audio/wav" });
    }

    function clearSafariScore() {
        if (!useSafariWav || !wavPlayer) return;
        wavPlayer.pause();
        wavPlaying = false;
        wavPlayer.removeAttribute("src");
        wavPlayer.load();
        if (safariScore) URL.revokeObjectURL(safariScore.url);
        safariScore = null;
    }

    function stopSafariNote() {
        if (useSafariWav && wavPlayer) {
            wavPlayer.pause();
            wavPlaying = false;
        }
    }

    function catchUpSafariScore() {
        if (!safariScore) return;
        const target = Math.min(safariScore.notes.length,
            Math.floor((wavPlayer.currentTime + 0.003) * 1000 / MUSIC_INTERVAL_MS));
        const already = sim.steps - safariScore.startStep;
        for (let i = already; i < target; i++) hop();
    }

    function startSafariScore() {
        if (!useSafariWav || !musicIsOn() || !sim.playing) return;
        if (!wavPlayer) {
            wavError = "WAV player missing from HTML";
            updateMusicHint();
            return;
        }
        if (!safariScore) {
            // This preparation is fast (~250 notes, 9 reusable waveforms) and
            // is performed inside the user's checkbox/Play event handler.
            const notes = predictSafariNotes(SAFARI_SCORE_HOPS);
            const url = URL.createObjectURL(buildSafariScoreWav(notes));
            safariScore = { startStep: sim.steps, notes, url };
            wavPlayer.src = url;
        }
        wavError = null;
        const playback = wavPlayer.play(); // synchronous call in user gesture
        if (playback && typeof playback.then === "function") {
            playback.then(() => {
                wavPlaying = true;
                updateMusicHint();
            }).catch(error => {
                if (error.name === "AbortError") return;
                wavPlaying = false;
                wavError = (error.name || "playback denied");
                updateMusicHint();
                console.warn("Safari WAV could not play:", error);
            });
        }
        updateMusicHint();
    }

    if (wavPlayer) {
        wavPlayer.addEventListener("error", () => {
            wavPlaying = false;
            wavError = "media error " + (wavPlayer.error ? wavPlayer.error.code : "unknown");
            updateMusicHint();
        });
        wavPlayer.addEventListener("ended", () => {
            if (!safariScore) return;
            // Finish all scheduled hops before predicting the next phrase.
            for (let i = sim.steps - safariScore.startStep;
                i < safariScore.notes.length; i++) hop();
            updatePanel();
            draw();
            const old = safariScore.url;
            safariScore = null;
            URL.revokeObjectURL(old);
            wavPlaying = false;
            if (sim.playing && musicIsOn()) {
                // Reuse the same unlocked media element for the next phrase.
                startSafariScore();
            }
        });
    }

    window.addEventListener("pagehide", () => clearSafariScore(), { once: true });

    // Safari is strict about requiring a real user gesture for Web Audio.
    // Call only from the Play, One hop or music-checkbox click handlers,
    // never on page load or from the animation timer.
    function enableAudio(playConfirmation = false) {
        if (!musicIsOn()) return;
        if (useSafariWav) {
            // First .play() happens synchronously in a checkbox/Play gesture.
            // No media start/stop occurs on individual hops.
            startSafariScore();
            return;
        }
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            ui.musicEnabled.checked = false;
            ui.musicEnabled.disabled = true;
            ui.musicHint.textContent = "Web Audio is unavailable in this browser.";
            return;
        }

        try {
            if (!audioContext || audioContext.state === "closed") {
                audioContext = new AudioContextClass();
                audioContext.addEventListener("statechange", updateMusicHint);
            }
            const context = audioContext;

            // Prime Web Audio synchronously within the actual user gesture.
            // A silent source allows WebKit to start its audio pipeline without
            // adding another note to the chemistry sound mapping.
            if (context.state !== "running") {
                const source = context.createOscillator();
                const quiet = context.createGain();
                quiet.gain.value = 0;
                source.connect(quiet);
                quiet.connect(context.destination);
                source.start();
                source.stop(context.currentTime + 0.01);
                source.onended = () => {
                    source.disconnect();
                    quiet.disconnect();
                };
            }

            if (context.state === "running") {
                if (playConfirmation) soundForVisit(1);
            } else {
                const promise = context.resume();
                if (promise && typeof promise.then === "function") {
                    promise.then(() => {
                        if (context === audioContext && playConfirmation && musicIsOn()) {
                            soundForVisit(1);
                        }
                        updateMusicHint();
                    }).catch(error => {
                        console.warn("Web Audio could not be resumed:", error);
                        updateMusicHint();
                    });
                }
            }
            updateMusicHint();
        } catch (error) {
            // Sound must never make Play/Pause unresponsive.
            console.warn("Web Audio activation failed:", error);
            ui.musicHint.textContent =
                "Audio activation failed; simulation remains available.";
        }
    }

    // Bright, struck-bar xylophone-inspired synthesis.
    // A4 = 440 Hz, 40 ms notes, one hop every 120 ms.
    // The short, inharmonic upper partials supply the hard mallet-like attack.
    function soundForVisit(visitCount) {
        if (!musicIsOn()) return;
        if (useSafariWav) {
            // The matching notes were already rendered into the WAV score.
            return;
        }
        if (!audioContext || audioContext.state !== "running") return;
        const semitone = Math.max(0, Math.min(8, visitCount - 1));
        const frequency = 440 * Math.pow(2, semitone / 12);
        const now = audioContext.currentTime;
        const duration = NOTE_DURATION;
        const attack = 0.001; // 1 ms sharp onset

        function partial(multiplier, volume, decayFraction) {
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(frequency * multiplier * 1.01, now);
            osc.frequency.exponentialRampToValueAtTime(
                frequency * multiplier, now + 0.010
            );
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.linearRampToValueAtTime(volume, now + attack);
            gain.gain.exponentialRampToValueAtTime(
                0.0001, now + Math.max(attack + 0.002, duration * decayFraction)
            );
            osc.connect(gain);
            gain.connect(audioContext.destination);
            osc.start(now);
            osc.stop(now + duration + 0.008);
            osc.onended = () => { osc.disconnect(); gain.disconnect(); };
        }

        partial(1.0, 0.14, 1.0);   // pitched body
        partial(3.9, 0.075, 0.48); // bright, inharmonic bar overtone
        partial(9.2, 0.14, 0.20); // very brief mallet click
    }

    function updateMusicControl() {
        const available = Number(ui.speedIn.value) === 1;
        ui.musicEnabled.disabled = !available;
        if (!available) {
            ui.musicEnabled.checked = false;
            lastMusicalHopTime = null;
            clearSafariScore();
        }
        updateMusicHint();
    }

    const sim = {
        seed: 0,
        nrows: 40,
        ncols: 40,
        T: 60,
        i: 20,
        j: 20,
        i0: 20,
        j0: 20,
        iu: 20,
        ju: 20,
        steps: 0,
        time: 0,
        tau: 1,
        rate: 1,
        lastDt: 0,
        vmax: 1,
        r2: 0,
        r2max: 0,
        visits: null,
        playing: false
    };

    const recordedStates = [];

    function wrap(x, n) {
        let r = x % n;
        if (r <= 0) r += n;
        return r;
    }

    function hopRates(T) {
        const ratePerDirection =
            NU0 * Math.exp(-(Q_E * EA) / (K_B * T));

        const totalRate = 6 * ratePerDirection;
        const meanTau = 1 / totalRate;

        return {
            ratePerDirection,
            totalRate,
            meanTau
        };
    }

    function waitingTime(totalRate) {
        let u = random();
        while (u === 0) {
            u = random();
        }

        return -Math.log(u) / totalRate;
    }

    function allocVisits(nr, nc) {
        const v = new Array(nr + 1);
        for (let i = 0; i <= nr; i++) v[i] = new Int32Array(nc + 1);
        return v;
    }

    function resetSim(keepPlaying) {
        clearSafariScore();
        lastMusicalHopTime = null;
        random = mulberry32(sim.seed);
        const n = parseInt(ui.sizeIn.value, 10);
        sim.nrows = n;
        sim.ncols = n;
        sim.T = parseFloat(ui.tempIn.value);
        const rates = hopRates(sim.T);
        sim.rate = rates.totalRate;
        sim.tau = rates.meanTau;
        sim.i0 = Math.round(n / 2);
        sim.j0 = Math.round(n / 2);
        sim.i = sim.i0;
        sim.j = sim.j0;
        sim.iu = sim.i0;
        sim.ju = sim.j0;
        sim.steps = 0;
        sim.time = 0;
        sim.lastDt = 0;
        sim.vmax = 1;
        sim.r2 = 0;
        sim.r2max = 0;
        sim.visits = allocVisits(n, n);
        sim.visits[sim.i0][sim.j0] = 1;
        if (!keepPlaying) {
            sim.playing = false;
            stopScheduledFrame();
        }
        updatePanel();
        draw();
    }

    function hop() {
        // const d = Math.floor(Math.random() * 6);
        const d = Math.floor(random() * 6);
        const iu = sim.iu + DI[d];
        const ju = sim.ju + DJ[d];
        sim.iu = iu;
        sim.ju = ju;
        sim.i = wrap(iu, sim.nrows);
        sim.j = wrap(ju, sim.ncols);
        const v = sim.visits[sim.i][sim.j] + 1;
        sim.visits[sim.i][sim.j] = v;
        if (v > sim.vmax) sim.vmax = v;
        // Audio failures must never abort a physical hop or freeze the controls.
        try {
            soundForVisit(v);
        } catch (error) {
            console.warn("Random walk: sound disabled after a Web Audio error:", error);
            ui.musicEnabled.checked = false;
            ui.musicHint.textContent = "Audio unavailable; animation continues without sound.";
        }
        sim.steps += 1;
        const dt = waitingTime(sim.rate);
        sim.lastDt = dt;
        sim.time += dt;
        const di = sim.iu - sim.i0;
        const dj = sim.ju - sim.j0;
        sim.r2 = di * di + dj * dj + di * dj;
        if (sim.r2 > sim.r2max) sim.r2max = sim.r2;
    }

    function colour(visits, vmax) {
        if (visits <= 0) return [0, 0, 0, 0];
        // Fixed colour scale: 1 visit = black, 9 visits = yellow.
        // Visits above 9 stay at the yellow end of the scale.
        const FIXED_MAX_VISITS = 9;
        const t = Math.min(1, Math.max(0, (visits - 1) / (FIXED_MAX_VISITS - 1)));
        const nseg = 4;
        let x = t * nseg;
        let seg = Math.floor(x);
        if (seg >= nseg) seg = nseg - 1;
        const f = x - seg;
        const a = KNOTS[seg], b = KNOTS[seg + 1];
        return [
            Math.round(a[0] + f * (b[0] - a[0])),
            Math.round(a[1] + f * (b[1] - a[1])),
            Math.round(a[2] + f * (b[2] - a[2])),
            0.75 + 0.25 * t
        ];
    }

    function fmtTime(t) {
        if (t < 1e-9) return (t * 1e12).toPrecision(3) + " ps";
        if (t < 1e-6) return (t * 1e9).toPrecision(3) + " ns";
        if (t < 1e-3) return (t * 1e6).toPrecision(3) + " µs";
        if (t < 1) return (t * 1e3).toPrecision(3) + " ms";
        return t.toPrecision(3) + " s";
    }

    function fmtRate(g) {
        if (g >= 1e9) return (g / 1e9).toPrecision(3) + " GHz";
        if (g >= 1e6) return (g / 1e6).toPrecision(3) + " MHz";
        if (g >= 1e3) return (g / 1e3).toPrecision(3) + " kHz";
        return g.toPrecision(3) + " s⁻¹";
    }

    function updatePanel() {
        ui.cols.textContent = String(sim.ncols);
        ui.rows.textContent = String(sim.nrows);
        ui.steps.textContent = String(sim.steps);
        ui.time.textContent = fmtTime(sim.time);
        ui.dt.textContent = sim.steps === 0 ? "-" : fmtTime(sim.lastDt);
        ui.temp.textContent = sim.T.toFixed(0) + " K";
        ui.rate.textContent = fmtRate(sim.rate);
        ui.tau.textContent = fmtTime(sim.tau);
        ui.vmax.textContent = String(sim.vmax);
        ui.seed.textContent = String(sim.seed);
        ui.msd.textContent = sim.r2.toFixed(1) + " a²";
        ui.msdMax.textContent = sim.r2max.toFixed(1) + " a²";
        ui.play.textContent = sim.playing ? "Pause" : "Play";
        ui.play.dataset.playback = sim.playing ? "playing" : "paused";
        ui.play.setAttribute("aria-pressed", sim.playing ? "true" : "false");
        if (debugStatus) {
            debugStatus.textContent = "Button events: " + debugCounter +
                " | " + (sim.playing ? "running" : "paused") +
                " | steps: " + sim.steps;
        }
    }

    function layout() {
        const nr = sim.nrows;
        const nc = sim.ncols;

        const pad = 10;
        const w = canvas.width;
        const h = canvas.height;

        // Exact bounding dimensions in units of R.
        // Includes layers 0, 1 and 2 and the outer disk radii.
        const extentX = 2 * nc + nr + 1;
        const extentY = (nr - 1) * Math.sqrt(3)
            + 2 / Math.sqrt(3) + 2;

        // Largest disk radius that fits the entire lattice.
        const R = Math.min(
            (w - 2 * pad) / extentX,
            (h - 2 * pad) / extentY
        );

        // Center the complete lattice in the canvas.
        const latticeW = extentX * R;
        const latticeH = extentY * R;

        const ox = (w - latticeW) / 2 + R;
        const oy = (h - latticeH) / 2 + R;

        return {
            R: R,
            ox: ox,
            oy: oy,
            dx: R,
            dy: R * Math.tan(Math.PI / 6)
        };
    }

    function siteXY(L, layer, i, j) {
        const x = L.ox + layer * L.dx + ((j - 1) + (i - 1) / 2) * (2 * L.R);
        const y = L.oy + layer * L.dy + (i - 1) * L.R * Math.sqrt(3);
        return [x, y];
    }

    function disk(x, y, r, fill, stroke, lw) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        if (fill) {
            ctx.fillStyle = fill;
            ctx.fill();
        }
        if (stroke) {
            ctx.strokeStyle = stroke;
            ctx.lineWidth = lw || 0.6;
            ctx.stroke();
        }
    }

    function drawLayer(L, layer, fill, alpha) {
        ctx.globalAlpha = alpha;
        const allAtoms = (sim.ncols <= SUBSTRATE_ATOM_LIMIT &&
            sim.nrows <= SUBSTRATE_ATOM_LIMIT);

        if (!allAtoms) {
            const p00 = siteXY(L, layer, 1, 1);
            const p0n = siteXY(L, layer, 1, sim.ncols);
            const pm0 = siteXY(L, layer, sim.nrows, 1);
            const pmn = siteXY(L, layer, sim.nrows, sim.ncols);
            ctx.beginPath();
            ctx.moveTo(p00[0], p00[1]);
            ctx.lineTo(pm0[0], pm0[1]);
            ctx.lineTo(pmn[0], pmn[1]);
            ctx.lineTo(p0n[0], p0n[1]);
            ctx.closePath();
            ctx.fillStyle = fill;
            ctx.fill();
            ctx.strokeStyle = fill;
            ctx.lineWidth = Math.max(0.4, L.R * 0.15);
            ctx.stroke();
        }

        for (let i = 1; i <= sim.nrows; i++) {
            for (let j = 1; j <= sim.ncols; j++) {
                if (!allAtoms &&
                    i !== 1 && i !== sim.nrows && j !== 1 && j !== sim.ncols)
                    continue;
                const p = siteXY(L, layer, i, j);
                disk(p[0], p[1], L.R, fill, fill, 0.4);
            }
        }
        ctx.globalAlpha = 1;
    }

    function drawLegend() {
        const FIXED_MAX = 9;
        const pad = 6;
        const lineH = 32;
        const r = 8;
        const right = canvas.width - pad;
        const top = pad + 12;

        ctx.save();
        ctx.font = "24px Helvetica, Arial, sans-serif";
        ctx.fillStyle = "#333";
        ctx.textAlign = "right";
        ctx.fillText("visits", right, top);

        for (let v = 1; v <= FIXED_MAX; v++) {
            const y = top + 6 + v * lineH;
            const c = colour(v, FIXED_MAX);
            const cx = right - 28;
            ctx.globalAlpha = c[3];
            disk(cx, y - 3, r,
                "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")",
                "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")", 0.6);
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#111";
            ctx.textAlign = "left";
            ctx.fillText(String(v), cx + r + 9, y + 5);
        }
        ctx.restore();
    }

    function draw() {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const L = layout();
        drawLayer(L, 0, "rgb(64,64,64)", 1);
        drawLayer(L, 1, "rgb(192,192,192)", 0.72);

        for (let i = 1; i <= sim.nrows; i++) {
            for (let j = 1; j <= sim.ncols; j++) {
                const v = sim.visits[i][j];
                if (v <= 0) continue;
                const p = siteXY(L, 2, i, j);
                const c = colour(v, sim.vmax);
                ctx.globalAlpha = c[3];
                disk(p[0], p[1], L.R, "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")",
                    "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")", 0.4);
            }
        }
        ctx.globalAlpha = 1;

        const s = siteXY(L, 2, sim.i0, sim.j0);
        disk(s[0], s[1], L.R, "#fff", "#111", 1.2);
        ctx.beginPath();
        ctx.moveTo(s[0] - L.R, s[1]);
        ctx.lineTo(s[0] + L.R, s[1]);
        ctx.strokeStyle = "#111";
        ctx.lineWidth = 1.2;
        ctx.stroke();

        const a = siteXY(L, 2, sim.i, sim.j);
        disk(a[0], a[1], L.R, "#fff", "#111", 1.2);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1] - L.R);
        ctx.lineTo(a[0], a[1] + L.R);
        ctx.stroke();

        drawLegend();
    }

    function buildSvg() {
        const L = layout();
        const parts = [];

        parts.push(
            `<svg xmlns="http://www.w3.org/2000/svg" ` +
            `width="${canvas.width}" height="${canvas.height}" ` +
            `viewBox="0 0 ${canvas.width} ${canvas.height}">`
        );

        parts.push(`<rect width="100%" height="100%" fill="white"/>`);

        function circle(x, y, r, fill, stroke, strokeWidth, opacity = 1) {
            parts.push(
                `<circle cx="${x}" cy="${y}" r="${r}" ` +
                `fill="${fill}" stroke="${stroke}" ` +
                `stroke-width="${strokeWidth}" opacity="${opacity}"/>`
            );
        }

        function line(x1, y1, x2, y2, stroke, strokeWidth) {
            parts.push(
                `<line x1="${x1}" y1="${y1}" ` +
                `x2="${x2}" y2="${y2}" ` +
                `stroke="${stroke}" stroke-width="${strokeWidth}"/>`
            );
        }

        function drawSvgLayer(layer, fill, opacity) {
            const allAtoms =
                sim.ncols <= SUBSTRATE_ATOM_LIMIT &&
                sim.nrows <= SUBSTRATE_ATOM_LIMIT;

            if (!allAtoms) {
                const p00 = siteXY(L, layer, 1, 1);
                const p0n = siteXY(L, layer, 1, sim.ncols);
                const pm0 = siteXY(L, layer, sim.nrows, 1);
                const pmn = siteXY(L, layer, sim.nrows, sim.ncols);

                const points = [
                    p00.join(","),
                    pm0.join(","),
                    pmn.join(","),
                    p0n.join(",")
                ].join(" ");

                parts.push(
                    `<polygon points="${points}" ` +
                    `fill="${fill}" stroke="${fill}" ` +
                    `stroke-width="${Math.max(0.4, L.R * 0.15)}" ` +
                    `opacity="${opacity}"/>`
                );
            }

            for (let i = 1; i <= sim.nrows; i++) {
                for (let j = 1; j <= sim.ncols; j++) {

                    if (
                        !allAtoms &&
                        i !== 1 &&
                        i !== sim.nrows &&
                        j !== 1 &&
                        j !== sim.ncols
                    ) {
                        continue;
                    }

                    const p = siteXY(L, layer, i, j);

                    circle(
                        p[0],
                        p[1],
                        L.R,
                        fill,
                        fill,
                        0.4,
                        opacity
                    );
                }
            }
        }

        drawSvgLayer(0, "rgb(64,64,64)", 1);
        drawSvgLayer(1, "rgb(192,192,192)", 0.72);

        for (let i = 1; i <= sim.nrows; i++) {
            for (let j = 1; j <= sim.ncols; j++) {

                const v = sim.visits[i][j];

                if (v <= 0) {
                    continue;
                }

                const p = siteXY(L, 2, i, j);
                const c = colour(v, sim.vmax);

                const rgb =
                    `rgb(${c[0]},${c[1]},${c[2]})`;

                circle(
                    p[0],
                    p[1],
                    L.R,
                    rgb,
                    rgb,
                    0.4,
                    c[3]
                );
            }
        }

        const start = siteXY(L, 2, sim.i0, sim.j0);

        circle(
            start[0],
            start[1],
            L.R,
            "#fff",
            "#111",
            1.2
        );

        line(
            start[0] - L.R,
            start[1],
            start[0] + L.R,
            start[1],
            "#111",
            1.2
        );

        const current = siteXY(L, 2, sim.i, sim.j);

        circle(
            current[0],
            current[1],
            L.R,
            "#fff",
            "#111",
            1.2
        );

        line(
            current[0],
            current[1] - L.R,
            current[0],
            current[1] + L.R,
            "#111",
            1.2
        );

        // Colour-code legend (fixed 1–9 visits)
        const FIXED_MAX = 9;
        const legendPad = 14;
        const lineH = 16;
        const legendR = 5;
        const right = canvas.width - legendPad;
        const top = legendPad + 12;

        parts.push(`<g id="legend" font-family="Helvetica,Arial,sans-serif" font-size="11px">`);
        parts.push(`<text x="${right}" y="${top}" text-anchor="end" fill="#333">visits</text>`);

        for (let v = 1; v <= FIXED_MAX; v++) {
            const y = top + 6 + v * lineH;
            const c = colour(v, FIXED_MAX);
            const cx = right - 28;
            const rgb = `rgb(${c[0]},${c[1]},${c[2]})`;
            parts.push(
                `<circle cx="${cx}" cy="${y - 3}" r="${legendR}" ` +
                `fill="${rgb}" stroke="${rgb}" stroke-width="0.6" opacity="${c[3]}"/>`
            );
            parts.push(
                `<text x="${cx + legendR + 6}" y="${y + 1}" fill="#111">${v}</text>`
            );
        }
        parts.push(`</g>`);

        parts.push("</svg>");

        return parts.join("\n");
    }

    function recordCurrentState() {
        const state = {
            seed: sim.seed,
            step: sim.steps,
            time_s: sim.time,
            temperature_K: sim.T,
            terrace_size: sim.nrows,
            hop_rate_s_1: sim.rate,
            mean_waiting_time_s: sim.tau,
            last_dt_s: sim.lastDt,
            max_visits: sim.vmax,
            r2_a2: sim.r2,
            r2max_a2: sim.r2max
        };

        recordedStates.push(state);

        const n = recordedStates.length;

        ui.recordCount.textContent =
            n === 1
                ? "1 state recorded"
                : `${n} states recorded`;
        ui.downloadCsv.disabled = false;
    }

    function downloadCsv() {
        if (recordedStates.length === 0) {
            return;
        }

        const columns = [
            "seed",
            "step",
            "time_s",
            "temperature_K",
            "terrace_size",
            "hop_rate_s_1",
            "mean_waiting_time_s",
            "last_dt_s",
            "max_visits",
            "r2_a2",
            "r2max_a2"
        ];

        const lines = [];

        lines.push(columns.join(","));

        for (const state of recordedStates) {
            const row = columns.map(column => state[column]);
            lines.push(row.join(","));
        }

        const csv = lines.join("\n");

        const blob = new Blob(
            [csv],
            { type: "text/csv;charset=utf-8" }
        );

        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");

        a.href = url;
        a.download = "random_walk_states.csv";

        document.body.appendChild(a);
        a.click();
        a.remove();

        URL.revokeObjectURL(url);
    }



    function saveSvg() {
        const svg = buildSvg();

        const blob = new Blob(
            [svg],
            { type: "image/svg+xml;charset=utf-8" }
        );

        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");

        a.href = url;
        a.download =
            `random_walk_seed-${sim.seed}_step-${sim.steps}.svg`;

        document.body.appendChild(a);
        a.click();
        a.remove();

        URL.revokeObjectURL(url);
    }


    // A single self-scheduling timer yields completely between hop batches.
    // Unlike a continuously rescheduled requestAnimationFrame loop this does not
    // consume Safari's event/render pipeline on frames with no musical hop.
    function scheduleFrame(immediate = false) {
        if (!sim.playing || animationTimerId !== null) return;
        const generation = playbackGeneration;
        const delay = immediate ? 0 : (musicIsOn() ?
            (useSafariWav && safariScore ? 25 : MUSIC_INTERVAL_MS) : SILENT_FRAME_MS);
        animationTimerId = window.setTimeout(() => frame(generation), delay);
    }

    function stopScheduledFrame() {
        playbackGeneration++;
        if (animationTimerId !== null) {
            window.clearTimeout(animationTimerId);
            animationTimerId = null;
        }
    }

    function frame(generation) {
        if (generation !== playbackGeneration) return;
        animationTimerId = null;
        if (!sim.playing) return;
        try {
            const n = parseInt(ui.speedIn.value, 10);
            if (musicIsOn()) {
                if (useSafariWav && safariScore && !wavError) {
                    // The media playback clock is authoritative, preventing
                    // visual and musical hops from drifting apart in Safari.
                    catchUpSafariScore();
                } else {
                    // Keep the random walk usable when Safari blocks audio.
                    hop();
                }
                lastMusicalHopTime = performance.now();
            } else {
                lastMusicalHopTime = null;
                for (let k = 0; k < n; k++) hop();
            }
            updatePanel();
            draw();
        } catch (error) {
            // An unexpected rendering error must not leave Pause looking active.
            sim.playing = false;
            stopScheduledFrame();
            updatePanel();
            console.error("Random walk paused following an animation error:", error);
            return;
        }
        scheduleFrame();
    }

    function togglePlayPause() {
        if (sim.playing) {
            sim.playing = false;
            stopScheduledFrame();
            lastMusicalHopTime = null;
            stopSafariNote();
            updatePanel();
            updateMusicHint();
            return;
        }
        sim.playing = true;
        lastMusicalHopTime = null;
        updatePanel();
        scheduleFrame(true);
        // Audio is optional: activate it only on a deliberate Play action.
        enableAudio();
        updateMusicHint();
    }

    // Safari fallback: handle pointerdown immediately; suppress the following
    // ordinary click so it cannot switch from Pause back to Play accidentally.
    // Native keyboard/assistive clicks (detail = 0) still work.
    if (safariPointerFallback) {
        ui.play.addEventListener("pointerdown", function (event) {
            if (!event.isPrimary || event.button !== 0) return;
            safariPointerHandled = true;
            debugCounter++;
            togglePlayPause();
        });
    }

    ui.play.addEventListener("click", function (event) {
        if (safariPointerHandled && event.detail !== 0) {
            safariPointerHandled = false;
            // The click is not used to toggle Play/Pause twice, but it IS a
            // trusted gesture where Safari may allow AudioContext.resume().
            if (sim.playing) enableAudio();
            return;
        }
        safariPointerHandled = false;
        debugCounter++;
        togglePlayPause();
    });

    ui.step.addEventListener("click", function () {
        if (useSafariWav) clearSafariScore();
        enableAudio();
        hop();
        updatePanel();
        draw();
    });
    ui.musicEnabled.addEventListener("click", function () {
        // The checkbox click is an explicit sound opt-in, unlike a page-load
        // checkbox value or an automatically started simulation.
        lastMusicalHopTime = null;
        if (musicIsOn()) {
            wavError = null;
            enableAudio(true);
        } else {
            clearSafariScore();
        }
        updateMusicHint();
    });
    ui.musicEnabled.addEventListener("change", updateMusicHint);
    ui.reset.addEventListener("click", function () { resetSim(false); });

    ui.newRun.addEventListener("click", function () {
        setSeed(makeSeed());
        resetSim(false);
    });

    ui.tempIn.addEventListener("input", function () {
        ui.tempLbl.textContent = ui.tempIn.value;
        sim.T = parseFloat(ui.tempIn.value);
        const rates = hopRates(sim.T);
        sim.rate = rates.totalRate;
        sim.tau = rates.meanTau;
        updatePanel();
    });
    ui.sizeIn.addEventListener("input", function () {
        ui.sizeLbl.textContent = ui.sizeIn.value;
    });
    ui.sizeIn.addEventListener("change", function () {
        resetSim(sim.playing);
        if (sim.playing && musicIsOn()) enableAudio();
    });
    ui.speedIn.addEventListener("input", function () {
        ui.speedLbl.textContent = ui.speedIn.value;
        updateMusicControl();
    });

    ui.saveSvg.addEventListener("click", function () {
        saveSvg();
        recordCurrentState();
    });

    ui.downloadCsv.addEventListener("click", function () {
        downloadCsv();
    });


    const params = new URLSearchParams(window.location.search);

    const seedParam = params.get("seed");
    const parsedSeed = Number(seedParam);

    if (
        seedParam !== null &&
        Number.isInteger(parsedSeed) &&
        parsedSeed >= 0 &&
        parsedSeed <= 0xffffffff
    ) {
        setSeed(parsedSeed);
    } else {
        setSeed(makeSeed());
    }

    ui.speedIn.value = "1";
    ui.speedLbl.textContent = "1";
    // Default off: Safari must be given an intentional sound-enable gesture.
    ui.musicEnabled.checked = false;
    updateMusicControl();
    resetSim(false);

    // Append a tiny status only when the user opens ?debugPause=1. This makes
    // it possible to diagnose event delivery in Safari without its console.
    if (debugPause) {
        debugStatus = document.createElement("span");
        debugStatus.setAttribute("role", "status");
        debugStatus.style.cssText = "font:12px monospace;color:#004c93;padding:4px";
        ui.play.insertAdjacentElement("afterend", debugStatus);
        updatePanel();
    }

    // Never initialize sound on page load or arbitrary pointerdown events.
    // The explicit checkbox click is the recommended way to enable music,
    // and the working Safari Play/Pause pointer handler stays unchanged.

    if (params.get("autoplay") !== "0") {
        sim.playing = true;
        updatePanel();
        scheduleFrame();
    }



})();
