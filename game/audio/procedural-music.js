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

const CHORD_PROGRESSION_LENGTH = RACE_CHORDS.length;

let registeredApi = null;
const FRAME_SYNC_INTERVAL_SEC = 0.1;
// Suspend freezes the graph mid-echo, so outlast the 0.38-feedback delay line.
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
    };

    let schedulerIntervalId = null;
    let idleSuspendTimer = null;
    let nextStepTime = 0.0;
    const scheduleAheadTime = 0.18;
    const lookaheadInterval = 60;

    const bpm = 122;
    const secondsPerBeat = 60.0 / bpm;
    const secondsPerStep = secondsPerBeat / 4.0;

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

    function scheduleStep(step, time) {
        const status = gameState.status;
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
            // Unity, not a mix level: every voice velocity is already tuned against it.
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
        } else if (status === 'crashed') {
            cutoff = 260;
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
            // Build only when music is actually on: constructing the context starts a
            // real-time audio thread that nothing would later suspend.
            if (!enabledCache) return;
            buildGraph();
            if (!ctx) return;
            // Resume on the gesture even before playback starts so iOS unlocks the context.
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
