import { getMusicEnabled } from '../settings/music-preference.js';
import { registerAudioPrepareOnFirstUserGesture } from './first-user-gesture-unlock.js';
import { clamp } from '../shared/clamp.js';

function midiToFreq(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
}

// 1. High-energy dark-synthwave chord progression in A minor (for racing)
const RACE_CHORDS = [
    {
        name: 'A minor',
        root: 33, // A1
        notes: [45, 57, 60, 64, 69, 72, 76, 81] // A2, A3, C4, E4, A4, C5, E5, A5
    },
    {
        name: 'F Major',
        root: 29, // F1
        notes: [41, 53, 57, 60, 65, 69, 72, 77] // F2, F3, A3, C4, F4, A4, C5, F5
    },
    {
        name: 'G Major',
        root: 31, // G1
        notes: [43, 55, 59, 62, 67, 71, 74, 79] // G2, G3, B3, D4, G4, B4, D5, G5
    },
    {
        name: 'E minor',
        root: 28, // E1
        notes: [40, 52, 55, 59, 64, 67, 71, 76] // E2, E3, G3, B3, E4, G4, B4, E5
    }
];

// 2. Luxurious, warm ambient chill-out progression in C Major (for lobby)
const LOBBY_CHORDS = [
    {
        name: 'C Major 7th',
        root: 36, // C2
        notes: [60, 62, 64, 67, 71, 72, 76, 79] // C4, D4, E4, G4, B4, C5, E5, G5
    },
    {
        name: 'F Major 7th',
        root: 41, // F2
        notes: [57, 60, 64, 65, 69, 72, 76, 77] // A3, C4, E4, F4, A4, C5, E5, F5
    },
    {
        name: 'G Major 6th',
        root: 43, // G2
        notes: [59, 62, 64, 67, 71, 74, 76, 79] // B3, D4, E4, G4, B4, D5, E5, G5
    },
    {
        name: 'A minor 7th',
        root: 45, // A2
        notes: [57, 60, 64, 67, 69, 72, 76, 79] // A3, C4, E4, G4, A4, C5, E5, G5
    }
];

/** Both progressions use the same length so the shared measure counter stays in sync. */
const CHORD_PROGRESSION_LENGTH = RACE_CHORDS.length;

let registeredApi = null;
const FRAME_SYNC_INTERVAL_SEC = 0.1;

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

    // State parameters (only what scheduling / filter use)
    const gameState = {
        status: 'ready',
        speed: 0,
        maxSpeedKph: 220,
    };

    // Scheduler state
    let schedulerIntervalId = null;
    let nextStepTime = 0.0;
    const scheduleAheadTime = 0.18; // Schedule 180ms ahead
    const lookaheadInterval = 60;   // Check every 60ms

    // Musical clock
    const bpm = 122;
    const secondsPerBeat = 60.0 / bpm;
    const secondsPerStep = secondsPerBeat / 4.0; // 16th note steps

    let currentStep = 0;      // 0-15 steps per measure
    let currentMeasure = 0;   // 0-3 measures per chord
    let chordIndex = 0;       // 0-3 chord index in progression
    let lastPluckIndex = 3;   // For smooth melodic random walks

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

        // Interactive master lowpass filter (e.g. for pause menu/crashes)
        musicFilter = ctx.createBiquadFilter();
        musicFilter.type = 'lowpass';
        musicFilter.frequency.setValueAtTime(15000, ctx.currentTime);
        musicFilter.Q.value = 1.0;

        // Connect graph
        musicGain.connect(musicFilter);
        musicFilter.connect(externalOutput || ctx.destination);

        // Feedback Delay line for ambient depth
        delayNode = ctx.createDelay(1.0);
        delayFeedback = ctx.createGain();
        delayVolume = ctx.createGain();

        delayNode.delayTime.setValueAtTime(0.246, ctx.currentTime); // 122 BPM echo
        delayFeedback.gain.setValueAtTime(0.38, ctx.currentTime);   // High echo feedback for lush tail
        delayVolume.gain.setValueAtTime(0.24, ctx.currentTime);     // Soft echo level

        delayNode.connect(delayFeedback);
        delayFeedback.connect(delayNode);
        delayNode.connect(delayVolume);
        delayVolume.connect(musicFilter);

        // Generate a simple reusable noise buffer for snare and hi-hats
        const noiseLength = ctx.sampleRate * 0.15;
        noiseBuffer = ctx.createBuffer(1, noiseLength, ctx.sampleRate);
        const noiseData = noiseBuffer.getChannelData(0);
        for (let i = 0; i < noiseLength; i++) {
            noiseData[i] = Math.random() * 2 - 1;
        }

        graphBuilt = true;
    }

    // 1. Driving Synthwave Octave Bassline
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

    // 2. Punchy Synthwave Kick Drum
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

    // 3. Crisp Synthwave Snare/Clap
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

    // 4. Snappy Upbeat Hi-Hat
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

    // 5. Mesmerizing Detuned Arpeggiator Lead
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

    // Schedule the notes for the given step
    function scheduleStep(step, time) {
        const status = gameState.status;
        const isLobby = status === 'ready';
        const isPlaying = status === 'playing';
        const speedNorm = clamp(gameState.speed / (gameState.maxSpeedKph / 20), 0, 1);

        // Load the appropriate chord progression
        const chordList = isLobby ? LOBBY_CHORDS : RACE_CHORDS;
        const chord = chordList[chordIndex];

        // 1. Bassline (Decoupled Lobby Whole notes vs Race Octave gallops)
        if (isLobby) {
            // Lush, warm, long sustaining whole-note bass roots for the lobby menu
            if (step === 0) {
                const bassPitch = midiToFreq(chord.root);
                playBass(time, bassPitch, 0.22, secondsPerBeat * 3.5);
            }
        } else {
            // High-octane driving galloping octave bassline for the race
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

        // 2. Drums (Decoupled chill lobby rhythm vs racing driving build)
        if (isLobby) {
            // Super soft lo-fi organic tick for the lobby
            if (step === 0) {
                playKick(time, 0.18); // Soft kick pulse on beat 1
            }
            if (step === 8) {
                playHihat(time, 0.035); // Soft ticking upbeat
            }
        } else if (isPlaying) {
            // A. KICK: Four-on-the-floor
            if (step === 0 || step === 4 || step === 8 || step === 12) {
                if (speedNorm > 0.02) {
                    playKick(time, 0.42 + speedNorm * 0.08);
                }
            }
            // B. SNARE: Beats 2 & 4
            if (step === 4 || step === 12) {
                if (speedNorm > 0.25) {
                    playSnare(time, 0.26 + speedNorm * 0.06);
                }
            }
            // C. HI-HAT: Upbeat offbeats
            if (step === 2 || step === 6 || step === 10 || step === 14) {
                if (speedNorm > 0.10) {
                    playHihat(time, 0.08 + speedNorm * 0.04);
                }
            }
        }

        // 3. Lead & Melody (Decoupled slow lobby bell melody vs fast racing arps)
        if (isLobby) {
            // Slow, warm, crystalline drifting pentatonic melody
            const is8thStep = step % 2 === 0;
            if (is8thStep && Math.random() < 0.32) {
                const scale = chord.notes;
                
                // Algorithmic melody walk
                const walkOffset = Math.floor(Math.random() * 3) - 1; // -1, 0, or +1 step
                lastPluckIndex = clamp(lastPluckIndex + walkOffset, 0, scale.length - 1);
                
                const noteMidi = scale[lastPluckIndex];
                const pitch = midiToFreq(noteMidi);
                
                // Plays warm, deeply reverberated soft plucks
                playArp(time, pitch, 0.12, 0.22, 0.14);
            }
        } else if (status !== 'starting') {
            // Fast continuous 16th-note driving synth lead for racing
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

        nextStepTime = ctx.currentTime + 0.05;
        currentStep = 0;
        currentMeasure = 0;
        chordIndex = 0;
        
        schedulerIntervalId = setInterval(schedulerLoop, lookaheadInterval);
    }

    function stop() {
        if (schedulerIntervalId) {
            clearInterval(schedulerIntervalId);
            schedulerIntervalId = null;
        }
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
            const cur = Math.min(0.28, Math.max(0, g.value));
            g.setValueAtTime(cur, time);
            g.setTargetAtTime(0.28, time, 0.06);
        } else {
            g.setValueAtTime(0, time);
        }
    }

    function updateFilter(time, status) {
        if (!musicFilter) return;
        let cutoff = 15000;
        if (status === 'paused') {
            cutoff = 360;
        } else if (status === 'crashed') {
            cutoff = 260;
        } else if (status === 'starting') {
            cutoff = 600;
        } else if (status === 'ready') {
            cutoff = 1600; // Keep the lobby music warm and smooth, not overly buzzy
        } else if (status === 'playing') {
            const speedNorm = clamp(gameState.speed / (gameState.maxSpeedKph / 20), 0, 1);
            cutoff = 2000 + speedNorm * 6500;
        }
        
        musicFilter.frequency.setTargetAtTime(cutoff, time, 0.25);
    }

    const api = {
        syncFrame({ status, speed, maxSpeedKph }) {
            if (!graphBuilt && !externalCtx) return;
            buildGraph();
            if (!ctx) return;

            const enabled = enabledCache;
            const t = ctx.currentTime;

            gameState.status = status;
            gameState.speed = speed;
            gameState.maxSpeedKph = maxSpeedKph || 220;

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
            buildGraph();
            if (!ctx) return;
            if (!enabledCache) return;
            // Resume on the gesture even when not yet starting/playing so iOS
            // unlocks the context; ensureSchedulerRunning starts once eligible.
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
                g.setValueAtTime(0, t);
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
