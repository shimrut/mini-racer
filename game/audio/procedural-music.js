import { getMusicEnabled } from '../settings/music-preference.js';
import { registerAudioPrepareOnFirstUserGesture } from './first-user-gesture-unlock.js';
import { clamp } from '../shared/clamp.js';

function midiToFreq(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
}

const RACE_CHORDS = [
    {
        name: 'A minor',
        root: 33,
        notes: [45, 57, 60, 64, 69, 72, 76, 81]
    },
    {
        name: 'F Major',
        root: 29,
        notes: [41, 53, 57, 60, 65, 69, 72, 77]
    },
    {
        name: 'G Major',
        root: 31,
        notes: [43, 55, 59, 62, 67, 71, 74, 79]
    },
    {
        name: 'E minor',
        root: 28,
        notes: [40, 52, 55, 59, 64, 67, 71, 76]
    }
];

const LOBBY_CHORDS = [
    {
        name: 'C Major 7th',
        root: 36,
        notes: [60, 62, 64, 67, 71, 72, 76, 79]
    },
    {
        name: 'F Major 7th',
        root: 41,
        notes: [57, 60, 64, 65, 69, 72, 76, 77]
    },
    {
        name: 'G Major 6th',
        root: 43,
        notes: [59, 62, 64, 67, 71, 74, 76, 79]
    },
    {
        name: 'A minor 7th',
        root: 45,
        notes: [57, 60, 64, 67, 69, 72, 76, 79]
    }
];

// Dirt song: D minor rally-rock over D, C, B flat, A; each chord has a bass root and riff scale.
const DIRT_CHORDS = [
    { name: 'D minor', root: 38, notes: [62, 65, 67, 69, 72, 74] },
    { name: 'C Major', root: 36, notes: [60, 62, 64, 67, 69, 72] },
    { name: 'B flat Major', root: 34, notes: [58, 62, 65, 67, 70, 74] },
    { name: 'A minor', root: 33, notes: [57, 60, 62, 64, 67, 69] }
];

// Snow song: cold B minor synth (Bm9, Gmaj7, Em9, F#sus4); each chord has a bass root and pluck/pad notes.
const SNOW_CHORDS = [
    { name: 'B minor 9', root: 35, notes: [59, 62, 66, 69, 73, 74] },
    { name: 'G Major 7', root: 31, notes: [55, 59, 62, 66, 69, 71] },
    { name: 'E minor 9', root: 28, notes: [55, 59, 62, 64, 66, 71] },
    { name: 'F sharp sus 4', root: 30, notes: [54, 59, 61, 66, 71, 73] }
];

// Space song: low synth drive over F# minor, D, A, E; each chord has a bass root and arp notes.
const SPACE_CHORDS = [
    { name: 'F sharp minor', root: 30, notes: [54, 57, 61, 66, 69] },
    { name: 'D Major', root: 26, notes: [54, 57, 62, 66, 69] },
    { name: 'A Major', root: 33, notes: [52, 57, 61, 64, 69] },
    { name: 'E Major', root: 28, notes: [52, 56, 59, 64, 68] }
];

// Water song: bright D major synth over D, B minor, G, A; each chord has a bass root and pluck notes.
const WATER_CHORDS = [
    { name: 'D Major', root: 38, notes: [62, 66, 69, 71, 74, 78] },
    { name: 'B minor', root: 35, notes: [59, 62, 66, 69, 71, 74] },
    { name: 'G Major', root: 31, notes: [59, 62, 66, 67, 71, 74] },
    { name: 'A Major', root: 33, notes: [57, 61, 64, 66, 69, 73] }
];

// Grip: the tarmac synth drive with its own E minor, G, D, A progression and melody.
const GRIP_CHORDS = [
    { name: 'E minor', root: 28, notes: [52, 55, 59, 62, 64, 67, 71, 74] },
    { name: 'G Major', root: 31, notes: [55, 59, 62, 64, 67, 71, 74, 79] },
    { name: 'D Major', root: 38, notes: [50, 54, 57, 62, 66, 69, 74, 78] },
    { name: 'A Major', root: 33, notes: [52, 57, 61, 64, 69, 73, 76, 81] }
];

const RACE_SONGS = Object.freeze({
    tarmac: Object.freeze({ key: 'tarmac', bpm: 122 }),
    dirt: Object.freeze({ key: 'dirt', bpm: 134 }),
    snow: Object.freeze({ key: 'snow', bpm: 120 }),
    space: Object.freeze({ key: 'space', bpm: 126 }),
    water: Object.freeze({ key: 'water', bpm: 124 }),
    grip: Object.freeze({ key: 'grip', bpm: 128 })
});

function getRaceSong(ground) {
    return Object.hasOwn(RACE_SONGS, ground) ? RACE_SONGS[ground] : RACE_SONGS.tarmac;
}

// Scale steps of the dirt riff, one per sixteenth; null is a rest.
const DIRT_RIFF_PATTERN = [0, null, 1, 2, null, 2, 1, null, 0, null, 3, null, 2, 1, null, 0];

// Snow plucks per sixteenth (null rests), every three steps across the beat.
const SNOW_PLUCK_PATTERN = [0, null, null, 3, null, null, 5, null, 4, null, null, 2, null, null, 1, null];

// Two alternating grip melodies across every sixteenth, unlike the tarmac arp.
const GRIP_ARP_A = [0, 2, 4, 6, 4, 2, 5, 3, 1, 3, 5, 7, 5, 3, 2, 4];
const GRIP_ARP_B = [2, 4, 6, 4, 3, 5, 7, 5, 2, 4, 6, 5, 4, 3, 1, 0];

// Water plucks per sixteenth (null rests), skipping like drops.
const WATER_PLUCK_PATTERN = [0, null, 2, null, 4, null, 3, 2, null, 1, null, 3, 5, null, 4, null];

// Arp notes of the space song, one per sixteenth, as for the tarmac arp.
const SPACE_ARP_PATTERN = [0, 1, 2, 1, 3, 2, 1, 2, 0, 2, 3, 2, 4, 3, 2, 1];

const CHORD_PROGRESSION_LENGTH = RACE_CHORDS.length;

let registeredApi = null;
const FRAME_SYNC_INTERVAL_SEC = 0.1;
// Outlast the echo before suspend.
const IDLE_AUDIO_SUSPEND_MS = 1500;

export function userGesturePrepareMusic() {
    registeredApi?.prepareOnUserGesture?.();
}

export function createProceduralMusic(externalCtx, externalOutput) {
    let ctx = null;
    let musicGain = null;
    let musicFilter = null;
    let delayNode = null;
    let delayFeedback = null;
    let delayVolume = null;
    let noiseBuffer = null;
    let graphBuilt = false;
    let tabHidden = false;
    let enabledCache = getMusicEnabled();
    let lastFrameSyncTime = -Infinity;
    let lastFrameStateKey = '';

    const gameState = {
        status: 'ready',
        speed: 0,
        maxSpeedKph: 220,
        ground: 'tarmac',
    };
    let activeSong = RACE_SONGS.tarmac;

    let schedulerIntervalId = null;
    let idleSuspendTimer = null;
    let nextStepTime = 0.0;
    const scheduleAheadTime = 0.18;
    const lookaheadInterval = 60;

    let secondsPerBeat = 60.0 / RACE_SONGS.tarmac.bpm;
    let secondsPerStep = secondsPerBeat / 4.0;

    let currentStep = 0;
    let currentMeasure = 0;
    let chordIndex = 0;
    let lastPluckIndex = 3;

    function buildGraph() {
        if (graphBuilt) return;

        if (externalCtx) {
            ctx = externalCtx;
        } else {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (typeof Ctor !== 'function') {
                graphBuilt = true;
                return;
            }
            ctx = new Ctor();
        }

        musicGain = ctx.createGain();
        musicGain.gain.setValueAtTime(0, ctx.currentTime);

        musicFilter = ctx.createBiquadFilter();
        musicFilter.type = 'lowpass';
        musicFilter.frequency.setValueAtTime(15000, ctx.currentTime);
        musicFilter.Q.value = 1.0;

        musicFilter.connect(musicGain);
        musicGain.connect(externalOutput || ctx.destination);

        delayNode = ctx.createDelay(1.0);
        delayFeedback = ctx.createGain();
        delayVolume = ctx.createGain();

        delayNode.delayTime.setValueAtTime(0.246, ctx.currentTime);
        delayFeedback.gain.setValueAtTime(0.38, ctx.currentTime);
        delayVolume.gain.setValueAtTime(0.24, ctx.currentTime);

        delayNode.connect(delayFeedback);
        delayFeedback.connect(delayNode);
        delayNode.connect(delayVolume);
        delayVolume.connect(musicFilter);

        const noiseLength = ctx.sampleRate * 0.15;
        noiseBuffer = ctx.createBuffer(1, noiseLength, ctx.sampleRate);
        const noiseData = noiseBuffer.getChannelData(0);
        for (let i = 0; i < noiseLength; i++) {
            noiseData[i] = Math.random() * 2 - 1;
        }

        graphBuilt = true;
    }

    function playBass(time, pitch, velocity = 0.28, duration = 0.12) {
        if (!ctx) return;

        const osc = ctx.createOscillator();
        const bGain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(pitch, time);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(650, time);
        filter.frequency.exponentialRampToValueAtTime(180, time + duration);
        filter.Q.setValueAtTime(2.2, time);

        bGain.gain.setValueAtTime(0, time);
        bGain.gain.linearRampToValueAtTime(velocity, time + 0.005);
        bGain.gain.exponentialRampToValueAtTime(0.001, time + duration);

        osc.connect(filter);
        filter.connect(bGain);
        bGain.connect(musicFilter);

        osc.start(time);
        osc.stop(time + duration + 0.05);
    }

    function playKick(time, velocity = 0.42) {
        if (!ctx) return;

        const osc = ctx.createOscillator();
        const kGain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(140, time);
        osc.frequency.exponentialRampToValueAtTime(42, time + 0.08);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(150, time);

        kGain.gain.setValueAtTime(0, time);
        kGain.gain.linearRampToValueAtTime(velocity, time + 0.002);
        kGain.gain.exponentialRampToValueAtTime(0.001, time + 0.11);

        osc.connect(filter);
        filter.connect(kGain);
        kGain.connect(musicFilter);

        osc.start(time);
        osc.stop(time + 0.13);
    }

    function playSnare(time, velocity = 0.28) {
        if (!ctx || !noiseBuffer) return;

        const noiseNode = ctx.createBufferSource();
        noiseNode.buffer = noiseBuffer;

        const noiseFilter = ctx.createBiquadFilter();
        noiseFilter.type = 'bandpass';
        noiseFilter.frequency.setValueAtTime(1200, time);
        noiseFilter.Q.setValueAtTime(1.0, time);

        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0, time);
        noiseGain.gain.linearRampToValueAtTime(velocity, time + 0.003);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, time + 0.14);

        const bodyOsc = ctx.createOscillator();
        const bodyGain = ctx.createGain();

        bodyOsc.type = 'triangle';
        bodyOsc.frequency.setValueAtTime(180, time);

        bodyGain.gain.setValueAtTime(0, time);
        bodyGain.gain.linearRampToValueAtTime(velocity * 0.45, time + 0.005);
        bodyGain.gain.exponentialRampToValueAtTime(0.001, time + 0.09);

        noiseNode.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(musicFilter);

        bodyOsc.connect(bodyGain);
        bodyGain.connect(musicFilter);

        noiseNode.start(time);
        noiseNode.stop(time + 0.16);
        bodyOsc.start(time);
        bodyOsc.stop(time + 0.1);
    }

    function playHihat(time, velocity = 0.09) {
        if (!ctx || !noiseBuffer) return;

        const source = ctx.createBufferSource();
        source.buffer = noiseBuffer;

        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.setValueAtTime(8500, time);

        const hGain = ctx.createGain();
        hGain.gain.setValueAtTime(0, time);
        hGain.gain.linearRampToValueAtTime(velocity, time + 0.001);
        hGain.gain.exponentialRampToValueAtTime(0.001, time + 0.035);

        source.connect(filter);
        filter.connect(hGain);
        hGain.connect(musicFilter);

        source.start(time);
        source.stop(time + 0.05);
    }

    function playArp(time, pitch, velocity = 0.15, duration = 0.1, openFilterAmount = 0.5) {
        if (!ctx) return;

        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const aGain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        osc1.type = 'sawtooth';
        osc1.frequency.setValueAtTime(pitch, time);
        osc1.detune.setValueAtTime(-6, time);

        osc2.type = 'square';
        osc2.frequency.setValueAtTime(pitch, time);
        osc2.detune.setValueAtTime(8, time);

        filter.type = 'lowpass';
        const startCutoff = 400 + openFilterAmount * 2800;
        const endCutoff = 250 + openFilterAmount * 400;

        filter.frequency.setValueAtTime(startCutoff, time);
        filter.frequency.exponentialRampToValueAtTime(endCutoff, time + duration);
        filter.Q.setValueAtTime(3.0, time);

        aGain.gain.setValueAtTime(0, time);
        aGain.gain.linearRampToValueAtTime(velocity, time + 0.003);
        aGain.gain.exponentialRampToValueAtTime(0.001, time + duration);

        osc1.connect(filter);
        osc2.connect(filter);
        filter.connect(aGain);
        
        aGain.connect(musicFilter);
        aGain.connect(delayNode);

        osc1.start(time);
        osc1.stop(time + duration + 0.05);
        osc2.start(time);
        osc2.stop(time + duration + 0.05);
    }

    // Root and fifth together, like a palm-muted guitar chug.
    function playChug(time, pitch, velocity = 0.22, duration = 0.1) {
        if (!ctx) return;

        const root = ctx.createOscillator();
        const fifth = ctx.createOscillator();
        const cGain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        root.type = 'sawtooth';
        root.frequency.setValueAtTime(pitch, time);
        fifth.type = 'square';
        fifth.frequency.setValueAtTime(pitch * 1.5, time);
        fifth.detune.setValueAtTime(6, time);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1100, time);
        filter.frequency.exponentialRampToValueAtTime(260, time + duration);
        filter.Q.setValueAtTime(1.6, time);

        cGain.gain.setValueAtTime(0, time);
        cGain.gain.linearRampToValueAtTime(velocity, time + 0.004);
        cGain.gain.exponentialRampToValueAtTime(0.001, time + duration);

        root.connect(filter);
        fifth.connect(filter);
        filter.connect(cGain);
        cGain.connect(musicFilter);

        root.start(time);
        root.stop(time + duration + 0.05);
        fifth.start(time);
        fifth.stop(time + duration + 0.05);
    }

    // An open power chord (root, fifth, octave) that rings a little.
    function playStab(time, rootMidi, velocity = 0.1, duration = 0.32) {
        if (!ctx) return;

        const sGain = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(2600, time);
        filter.frequency.exponentialRampToValueAtTime(700, time + duration);
        filter.Q.setValueAtTime(1.2, time);

        sGain.gain.setValueAtTime(0, time);
        sGain.gain.linearRampToValueAtTime(velocity, time + 0.006);
        sGain.gain.exponentialRampToValueAtTime(0.001, time + duration);

        for (const [offset, detune] of [[0, -7], [7, 5], [12, 9]]) {
            const osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(midiToFreq(rootMidi + offset), time);
            osc.detune.setValueAtTime(detune, time);
            osc.connect(filter);
            osc.start(time);
            osc.stop(time + duration + 0.05);
        }

        filter.connect(sGain);
        sGain.connect(musicFilter);
        sGain.connect(delayNode);
    }

    function scheduleDirtStep(step, time, status) {
        const isPlaying = status === 'playing';
        const speedNorm = clamp(gameState.speed / (gameState.maxSpeedKph / 20), 0, 1);
        const chord = DIRT_CHORDS[chordIndex];

        if (step % 2 === 0) {
            const bassMidi = chord.root + (step === 14 ? 12 : 0);
            playChug(time, midiToFreq(bassMidi), isPlaying ? 0.17 : 0.12, isPlaying ? 0.1 : 0.2);
        }

        if (isPlaying) {
            if ((step === 0 || step === 6 || step === 8) && speedNorm > 0.02) {
                playKick(time, 0.38 + speedNorm * 0.06);
            }
            if (step === 10 && speedNorm > 0.6) {
                playKick(time, 0.28);
            }
            if ((step === 4 || step === 12) && speedNorm > 0.2) {
                playSnare(time, 0.26 + speedNorm * 0.05);
            }
            if (step % 2 === 0 && speedNorm > 0.1) {
                playHihat(time, (step % 4 === 2 ? 0.1 : 0.06) + speedNorm * 0.03);
            }
            if ((step === 0 || step === 7) && speedNorm > 0.15) {
                playStab(time, chord.root + 24, 0.05 + speedNorm * 0.03);
            }
        }

        // The riff plays in every second measure, so it answers the chords.
        if (status !== 'starting' && currentMeasure % 2 === 1) {
            const scaleStep = DIRT_RIFF_PATTERN[step];
            if (scaleStep !== null) {
                const pitch = midiToFreq(chord.notes[scaleStep]);
                playArp(time, pitch, 0.08 + speedNorm * 0.05, 0.09, 0.35 + speedNorm * 0.5);
            }
        }
    }

    // A deep sine pulse with a little saw edge, pumping like a sidechained bass.
    function playSub(time, pitch, velocity = 0.3, duration = 0.2) {
        if (!ctx) return;

        const sub = ctx.createOscillator();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(pitch, time);
        const edge = ctx.createOscillator();
        edge.type = 'sawtooth';
        edge.frequency.setValueAtTime(pitch, time);

        const edgeFilter = ctx.createBiquadFilter();
        edgeFilter.type = 'lowpass';
        edgeFilter.frequency.setValueAtTime(320, time);
        edgeFilter.Q.setValueAtTime(0.8, time);
        const edgeGain = ctx.createGain();
        edgeGain.gain.setValueAtTime(0.25, time);

        const sGain = ctx.createGain();
        sGain.gain.setValueAtTime(0, time);
        sGain.gain.linearRampToValueAtTime(velocity, time + 0.02);
        sGain.gain.exponentialRampToValueAtTime(0.001, time + duration);

        sub.connect(sGain);
        edge.connect(edgeFilter);
        edgeFilter.connect(edgeGain);
        edgeGain.connect(sGain);
        sGain.connect(musicFilter);

        sub.start(time);
        sub.stop(time + duration + 0.05);
        edge.start(time);
        edge.stop(time + duration + 0.05);
    }

    // A short glassy pluck that rings on in the echo.
    function playGlassPluck(time, pitch, velocity = 0.08, brightness = 0.5) {
        if (!ctx) return;

        const body = ctx.createOscillator();
        body.type = 'triangle';
        body.frequency.setValueAtTime(pitch, time);
        const shine = ctx.createOscillator();
        shine.type = 'sine';
        shine.frequency.setValueAtTime(pitch * 2, time);
        shine.detune.setValueAtTime(7, time);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1800 + brightness * 3200, time);
        filter.frequency.exponentialRampToValueAtTime(700, time + 0.16);
        filter.Q.setValueAtTime(2.0, time);

        const pGain = ctx.createGain();
        pGain.gain.setValueAtTime(0, time);
        pGain.gain.linearRampToValueAtTime(velocity, time + 0.003);
        pGain.gain.exponentialRampToValueAtTime(0.001, time + 0.16);

        body.connect(filter);
        shine.connect(filter);
        filter.connect(pGain);
        pGain.connect(musicFilter);
        pGain.connect(delayNode);

        body.start(time);
        body.stop(time + 0.2);
        shine.start(time);
        shine.stop(time + 0.2);
    }

    // A dark, slow pad that swells in over one bar.
    function playColdPad(time, notes, velocity = 0.03, duration = 2) {
        if (!ctx) return;

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(900, time);
        filter.Q.setValueAtTime(0.7, time);

        const pGain = ctx.createGain();
        pGain.gain.setValueAtTime(0, time);
        pGain.gain.linearRampToValueAtTime(velocity, time + duration * 0.4);
        pGain.gain.linearRampToValueAtTime(0, time + duration);

        for (const [midi, detune] of notes) {
            const osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(midiToFreq(midi), time);
            osc.detune.setValueAtTime(detune, time);
            osc.connect(filter);
            osc.start(time);
            osc.stop(time + duration + 0.05);
        }

        filter.connect(pGain);
        pGain.connect(musicFilter);
    }

    function scheduleSnowStep(step, time, status) {
        const isPlaying = status === 'playing';
        const speedNorm = clamp(gameState.speed / (gameState.maxSpeedKph / 20), 0, 1);
        const chord = SNOW_CHORDS[chordIndex];

        if (step % 2 === 0) {
            const accent = step % 4 === 0 ? 1 : 0.7;
            playSub(time, midiToFreq(chord.root), (isPlaying ? 0.3 : 0.2) * accent, 0.2);
        }

        // Half-time drums: one snare per bar keeps the song wide and cold.
        if (isPlaying) {
            if ((step === 0 || step === 10) && speedNorm > 0.02) {
                playKick(time, 0.4 + speedNorm * 0.06);
            }
            if (step === 6 && speedNorm > 0.6) {
                playKick(time, 0.26);
            }
            if (step === 8 && speedNorm > 0.25) {
                playSnare(time, 0.26 + speedNorm * 0.05);
            }
            if (step % 2 === 0 && speedNorm > 0.1) {
                playHihat(time, (step % 4 === 2 ? 0.07 : 0.04) + speedNorm * 0.02);
            }
        }

        if (step === 0 && currentMeasure % 2 === 0) {
            const [first, , third, , fifth] = chord.notes;
            playColdPad(
                time,
                [[first, -9], [third, 6], [fifth, -4]],
                0.025 + speedNorm * 0.015,
                secondsPerBeat * 8,
            );
        }

        if (status !== 'starting') {
            const noteIndex = SNOW_PLUCK_PATTERN[step];
            // At low speed only the notes on the beat play.
            if (noteIndex !== null && (speedNorm > 0.35 || step % 4 === 0)) {
                const pitch = midiToFreq(chord.notes[noteIndex] + 12);
                playGlassPluck(time, pitch, 0.07 + speedNorm * 0.04, speedNorm);
            }
        }
    }

    // Warm arp note: saw plus a triangle an octave below, through a low round filter.
    function playWarmArp(time, pitch, velocity = 0.12, duration = 0.1, openFilterAmount = 0.5) {
        if (!ctx) return;

        const saw = ctx.createOscillator();
        saw.type = 'sawtooth';
        saw.frequency.setValueAtTime(pitch, time);
        saw.detune.setValueAtTime(-5, time);
        const low = ctx.createOscillator();
        low.type = 'triangle';
        low.frequency.setValueAtTime(pitch / 2, time);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(350 + openFilterAmount * 1500, time);
        filter.frequency.exponentialRampToValueAtTime(220, time + duration);
        filter.Q.setValueAtTime(1, time);

        const aGain = ctx.createGain();
        aGain.gain.setValueAtTime(0, time);
        aGain.gain.linearRampToValueAtTime(velocity, time + 0.004);
        aGain.gain.exponentialRampToValueAtTime(0.001, time + duration);

        saw.connect(filter);
        low.connect(filter);
        filter.connect(aGain);
        aGain.connect(musicFilter);
        aGain.connect(delayNode);

        saw.start(time);
        saw.stop(time + duration + 0.05);
        low.start(time);
        low.stop(time + duration + 0.05);
    }

    function scheduleSpaceStep(step, time, status) {
        const isPlaying = status === 'playing';
        const speedNorm = clamp(gameState.speed / (gameState.maxSpeedKph / 20), 0, 1);
        const chord = SPACE_CHORDS[chordIndex];

        if (step % 2 === 0) {
            const isOctaveStep = step % 4 === 2;
            let bassVol = isPlaying ? 0.34 : 0.22;
            if (isOctaveStep) bassVol *= 0.85;
            playBass(time, midiToFreq(chord.root + (isOctaveStep ? 12 : 0)), bassVol, isPlaying ? 0.12 : 0.25);
        }

        if (isPlaying) {
            if (step % 4 === 0 && speedNorm > 0.02) {
                playKick(time, 0.42 + speedNorm * 0.08);
            }
            if ((step === 4 || step === 12) && speedNorm > 0.25) {
                playSnare(time, 0.26 + speedNorm * 0.06);
            }
            if (step % 4 === 2 && speedNorm > 0.1) {
                playHihat(time, 0.08 + speedNorm * 0.04);
            }
        }

        if (status !== 'starting') {
            const noteIndex = SPACE_ARP_PATTERN[step];
            playWarmArp(
                time,
                midiToFreq(chord.notes[noteIndex]),
                0.1 + speedNorm * 0.06,
                0.09 + (1 - speedNorm) * 0.05,
                speedNorm,
            );
        }
    }

    function scheduleWaterStep(step, time, status) {
        const isPlaying = status === 'playing';
        const speedNorm = clamp(gameState.speed / (gameState.maxSpeedKph / 20), 0, 1);
        const chord = WATER_CHORDS[chordIndex];

        // Bouncing bass: root on the beat, octave on the half beat.
        if (step % 4 === 0) {
            playBass(time, midiToFreq(chord.root), isPlaying ? 0.3 : 0.2, isPlaying ? 0.14 : 0.25);
        } else if (step % 4 === 2) {
            playBass(time, midiToFreq(chord.root + 12), isPlaying ? 0.24 : 0.16, 0.1);
        }

        if (isPlaying) {
            if (step % 4 === 0 && speedNorm > 0.02) {
                playKick(time, 0.4 + speedNorm * 0.08);
            }
            if ((step === 4 || step === 12) && speedNorm > 0.25) {
                playSnare(time, 0.2 + speedNorm * 0.05);
            }
            if (step % 4 === 2 && speedNorm > 0.1) {
                playHihat(time, 0.08 + speedNorm * 0.04);
            } else if (step % 2 === 1 && speedNorm > 0.7) {
                playHihat(time, 0.035);
            }
        }

        if (status !== 'starting') {
            const noteIndex = WATER_PLUCK_PATTERN[step];
            // At low speed only the notes on the beat play.
            if (noteIndex !== null && (speedNorm > 0.35 || step % 4 === 0)) {
                playGlassPluck(time, midiToFreq(chord.notes[noteIndex]), 0.08 + speedNorm * 0.04, 0.3 + speedNorm * 0.5);
            }
        }
    }

    function scheduleGripStep(step, time, status) {
        const isPlaying = status === 'playing';
        const speedNorm = clamp(gameState.speed / (gameState.maxSpeedKph / 20), 0, 1);
        const chord = GRIP_CHORDS[chordIndex];

        // Tarmac eighth-note bass and four-on-the-floor beat give grip its drive.
        if (step % 2 === 0) {
            const octave = step % 4 === 2;
            const velocity = (isPlaying ? 0.32 : 0.22) * (octave ? 0.85 : 1);
            playBass(time, midiToFreq(chord.root + (octave ? 12 : 0)), velocity, isPlaying ? 0.12 : 0.25);
        }

        if (isPlaying) {
            if (step % 4 === 0 && speedNorm > 0.02) {
                playKick(time, 0.42 + speedNorm * 0.08);
            }
            if ((step === 4 || step === 12) && speedNorm > 0.25) {
                playSnare(time, 0.26 + speedNorm * 0.06);
            }
            if (step % 4 === 2 && speedNorm > 0.1) {
                playHihat(time, 0.08 + speedNorm * 0.04);
            }
        }

        if (status === 'starting') return;

        const pattern = currentMeasure % 2 === 0 ? GRIP_ARP_A : GRIP_ARP_B;
        const pitch = midiToFreq(chord.notes[pattern[step]]);
        playArp(time, pitch, 0.09 + speedNorm * 0.06, 0.08 + (1 - speedNorm) * 0.05, speedNorm);
    }

    const SONG_STEPS = {
        dirt: scheduleDirtStep,
        snow: scheduleSnowStep,
        space: scheduleSpaceStep,
        water: scheduleWaterStep,
        grip: scheduleGripStep,
    };

    function scheduleStep(step, time) {
        const status = gameState.status;
        const songStep = SONG_STEPS[activeSong.key];
        if (status !== 'ready' && songStep) {
            songStep(step, time, status);
            return;
        }
        const isLobby = status === 'ready';
        const isPlaying = status === 'playing';
        const speedNorm = clamp(gameState.speed / (gameState.maxSpeedKph / 20), 0, 1);

        const chordList = isLobby ? LOBBY_CHORDS : RACE_CHORDS;
        const chord = chordList[chordIndex];

        if (isLobby) {
            if (step === 0) {
                const bassPitch = midiToFreq(chord.root);
                playBass(time, bassPitch, 0.22, secondsPerBeat * 3.5);
            }
        } else {
            if (step % 2 === 0) {
                const isOctaveStep = step === 2 || step === 6 || step === 10 || step === 14;
                const bassMidi = chord.root + (isOctaveStep ? 12 : 0);
                const bassPitch = midiToFreq(bassMidi);
                
                let bassVol = isPlaying ? 0.32 : 0.22;
                if (isOctaveStep) bassVol *= 0.85;

                const bassDur = isPlaying ? 0.12 : 0.25;
                playBass(time, bassPitch, bassVol, bassDur);
            }
        }

        if (isLobby) {
            if (step === 0) {
                playKick(time, 0.18);
            }
            if (step === 8) {
                playHihat(time, 0.035);
            }
        } else if (isPlaying) {
            if (step === 0 || step === 4 || step === 8 || step === 12) {
                if (speedNorm > 0.02) {
                    playKick(time, 0.42 + speedNorm * 0.08);
                }
            }
            if (step === 4 || step === 12) {
                if (speedNorm > 0.25) {
                    playSnare(time, 0.26 + speedNorm * 0.06);
                }
            }
            if (step === 2 || step === 6 || step === 10 || step === 14) {
                if (speedNorm > 0.10) {
                    playHihat(time, 0.08 + speedNorm * 0.04);
                }
            }
        }

        if (isLobby) {
            const is8thStep = step % 2 === 0;
            if (is8thStep && Math.random() < 0.32) {
                const scale = chord.notes;
                
                const walkOffset = Math.floor(Math.random() * 3) - 1;
                lastPluckIndex = clamp(lastPluckIndex + walkOffset, 0, scale.length - 1);
                
                const noteMidi = scale[lastPluckIndex];
                const pitch = midiToFreq(noteMidi);
                
                playArp(time, pitch, 0.12, 0.22, 0.14);
            }
        } else if (status !== 'starting') {
            const arpIndexPattern = [0, 2, 4, 2, 5, 4, 2, 3, 1, 3, 5, 4, 6, 5, 4, 2];
            const noteIndex = arpIndexPattern[step % arpIndexPattern.length];
            const noteMidi = chord.notes[noteIndex];
            const pitch = midiToFreq(noteMidi);

            const arpVol = 0.09 + speedNorm * 0.06;
            const filterOpen = speedNorm;
            const duration = 0.08 + (1.0 - speedNorm) * 0.05;

            playArp(time, pitch, arpVol, duration, filterOpen);
        }
    }

    function advanceClock() {
        currentStep = (currentStep + 1) % 16;
        if (currentStep === 0) {
            currentMeasure = (currentMeasure + 1) % 4;
            if (currentMeasure === 0) {
                chordIndex = (chordIndex + 1) % CHORD_PROGRESSION_LENGTH;
            }
        }
    }

    function schedulerLoop() {
        if (!ctx) return;
        
        while (nextStepTime < ctx.currentTime + scheduleAheadTime) {
            scheduleStep(currentStep, nextStepTime);
            advanceClock();
            nextStepTime += secondsPerStep;
        }
    }

    function start() {
        if (schedulerIntervalId) return;
        buildGraph();
        if (!ctx) return;
        clearIdleSuspendTimer();

        activeSong = getRaceSong(gameState.ground);
        secondsPerBeat = 60.0 / activeSong.bpm;
        secondsPerStep = secondsPerBeat / 4.0;
        nextStepTime = ctx.currentTime + 0.05;
        currentStep = 0;
        currentMeasure = 0;
        chordIndex = 0;
        
        schedulerIntervalId = setInterval(schedulerLoop, lookaheadInterval);
    }

    function clearIdleSuspendTimer() {
        if (!idleSuspendTimer) return;
        clearTimeout(idleSuspendTimer);
        idleSuspendTimer = null;
    }

    function scheduleIdleSuspend(delayMs = IDLE_AUDIO_SUSPEND_MS) {
        if (!ctx || externalCtx || ctx.state !== 'running') return;
        clearIdleSuspendTimer();
        idleSuspendTimer = setTimeout(() => {
            idleSuspendTimer = null;
            if (ctx && ctx.state === 'running') {
                void ctx.suspend();
            }
        }, Math.max(0, delayMs));
    }

    function stop() {
        if (schedulerIntervalId) {
            clearInterval(schedulerIntervalId);
            schedulerIntervalId = null;
        }
        scheduleIdleSuspend();
    }

    function shouldRunScheduler(status, enabled) {
        return Boolean(enabled) && !tabHidden && (status === 'starting' || status === 'playing');
    }

    function ensureSchedulerRunning() {
        if (!shouldRunScheduler(gameState.status, enabledCache)) return;
        if (!ctx) return;

        if (ctx.state === 'suspended') {
            void ctx.resume().then(() => {
                if (shouldRunScheduler(gameState.status, enabledCache) && !schedulerIntervalId) {
                    start();
                }
            });
            return;
        }

        if (!schedulerIntervalId) {
            start();
        }
    }

    function updateVolume(time, enabled) {
        if (!musicGain) return;
        const g = musicGain.gain;
        g.cancelScheduledValues(time);
        if (enabled) {
            const cur = Math.min(1, Math.max(0, g.value));
            g.setValueAtTime(cur, time);
            g.setTargetAtTime(1, time, 0.06);
        } else {
            g.setTargetAtTime(0, time, 0.02);
        }
    }

    function updateFilter(time, status) {
        if (!musicFilter) return;
        let cutoff = 15000;
        if (status === 'paused') {
            cutoff = 360;
        } else if (status === 'starting') {
            cutoff = 600;
        } else if (status === 'ready') {
            cutoff = 1600;
        } else if (status === 'playing') {
            const speedNorm = clamp(gameState.speed / (gameState.maxSpeedKph / 20), 0, 1);
            cutoff = 2000 + speedNorm * 6500;
        }
        
        musicFilter.frequency.setTargetAtTime(cutoff, time, 0.25);
    }

    const api = {
        syncFrame({ status, speed, maxSpeedKph, ground = 'tarmac' }) {
            if (!graphBuilt && !externalCtx) return;
            buildGraph();
            if (!ctx) return;

            const enabled = enabledCache;
            const t = ctx.currentTime;

            gameState.status = status;
            gameState.speed = speed;
            gameState.maxSpeedKph = maxSpeedKph || 220;
            gameState.ground = ground;

            if (shouldRunScheduler(status, enabled)) {
                ensureSchedulerRunning();
            } else {
                stop();
            }

            const frameStateKey = `${status}:${enabled}:${tabHidden}`;
            const forceFrameUpdate = frameStateKey !== lastFrameStateKey;
            if (!forceFrameUpdate && t - lastFrameSyncTime < FRAME_SYNC_INTERVAL_SEC) {
                return;
            }
            lastFrameStateKey = frameStateKey;
            lastFrameSyncTime = t;

            updateVolume(t, enabled);
            updateFilter(t, status);
        },

        setTabHidden(hidden) {
            tabHidden = Boolean(hidden);
            if (hidden) {
                stop();
            } else {
                ensureSchedulerRunning();
            }
        },

        prepareOnUserGesture() {
            if (!enabledCache) return;
            buildGraph();
            if (!ctx) return;
            // iOS unlocks audio only on a gesture.
            if (ctx.state === 'suspended') {
                void ctx.resume().then(() => {
                    ensureSchedulerRunning();
                });
                return;
            }
            ensureSchedulerRunning();
        },

        stop() {
            stop();
            if (ctx && musicGain) {
                const t = ctx.currentTime;
                const g = musicGain.gain;
                g.cancelScheduledValues(t);
                g.setTargetAtTime(0, t, 0.02);
            }
        },

        setEnabled(enabled) {
            enabledCache = Boolean(enabled);
            if (enabledCache) {
                api.prepareOnUserGesture();
            } else {
                api.stop();
            }
        }
    };

    registeredApi = api;
    registerAudioPrepareOnFirstUserGesture(() => registeredApi?.prepareOnUserGesture?.());
    return api;
}
