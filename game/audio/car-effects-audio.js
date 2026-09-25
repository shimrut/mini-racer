import { KPH_PER_WORLD_UNIT } from '../car/handling.js';
import { clamp } from '../shared/clamp.js';
import { getCarProceduralAudioEnabled } from '../settings/car-audio-preference.js';
import { registerAudioPrepareOnFirstUserGesture } from './first-user-gesture-unlock.js';

let registeredApi = null;
const PARAMETER_SYNC_INTERVAL_SEC = 1 / 30;
// The volume of the high engine whine (the sixth harmonic) on tarmac.
const ORDER_GAIN = 0.15;
const IDLE_AUDIO_SUSPEND_MS = 250;

export function userGesturePrepareCarEffects() {
    registeredApi?.prepareOnUserGesture?.();
}

function createLoopingNoiseBuffer(audioCtx, seconds = 2) {
    const bufferLength = Math.floor(audioCtx.sampleRate * seconds);
    const buffer = audioCtx.createBuffer(1, bufferLength, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferLength; i++) {
        data[i] = Math.random() * 2 - 1;
    }
    return buffer;
}

// Sparse clicks over a quiet hiss: stones hitting the car body.
function createGravelNoiseBuffer(audioCtx, seconds = 2) {
    const bufferLength = Math.floor(audioCtx.sampleRate * seconds);
    const buffer = audioCtx.createBuffer(1, bufferLength, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferLength; i++) {
        const click = Math.random() < 0.004 ? Math.random() * 2 - 1 : 0;
        data[i] = click + (Math.random() * 2 - 1) * 0.08;
    }
    return buffer;
}

// Each ground has its own sound. Tarmac values are the original sound.
const GROUND_SOUND_PROFILES = Object.freeze({
    tarmac: Object.freeze({
        shaperAmount: 10,
        barkBoostDb: 0,
        motorLowpassScale: 1,
        pitchScale: 1,
        whineScale: 1,
        gravelVol: 0,
        gravelFreq: 1800,
        rumbleVol: 0,
        slipMax: 0.18,
        slipScale: 0.5,
        slipQBase: 5.0,
        slipQPerSlip: 8.0,
        slipFreqBase: 1000,
        slipFreqPerSlip: 3000,
        slipFreqPerSpeed: 1200,
        shiftCrackVol: 0,
    }),
    // Rally: a lower, barkier four-cylinder, gravel that stays quiet on a
    // straight and louder in a slide, a wide gravel spray instead of a tyre
    // squeal, a hard bang and a big rev drop at each gear change, and exhaust
    // pops when the car slows down.
    dirt: Object.freeze({
        shaperAmount: 34,
        barkBoostDb: 5.5,
        barkFreqScale: 0.62,
        motorLowpassScale: 0.82,
        pitchScale: 0.78,
        whineScale: 0.32,
        thrumScale: 2,
        pulseScale: 1.8,
        rpmFloor: 0.16,
        level: 1.3,
        gravelVol: 0.07,
        gravelCruise: 0.35,
        gravelSlip: 1.6,
        gravelFreq: 520,
        gravelQ: 1.5,
        gravelRate: 0.55,
        rumbleVol: 0.07,
        rumbleSlip: 2.2,
        slipMax: 0.3,
        slipScale: 0.85,
        slipQBase: 0.9,
        slipQPerSlip: 0.3,
        slipFreqBase: 280,
        slipFreqPerSlip: 260,
        slipFreqPerSpeed: 140,
        slipHighpass: 140,
        shiftCrackVol: 0.32,
        overrunPopVol: 0.1,
    }),
    // Snow soaks up sound: a softer, muffled engine, a low soft crunch under
    // the tyres, and a breathy hiss instead of a squeal in a slide.
    snow: Object.freeze({
        shaperAmount: 7,
        barkBoostDb: -2,
        motorLowpassScale: 0.7,
        pitchScale: 1,
        whineScale: 1,
        gravelVol: 0.06,
        gravelFreq: 850,
        rumbleVol: 0.03,
        slipMax: 0.16,
        slipScale: 0.6,
        slipQBase: 0.7,
        slipQPerSlip: 0.3,
        slipFreqBase: 2400,
        slipFreqPerSlip: 1400,
        slipFreqPerSpeed: 700,
        shiftCrackVol: 0,
    }),
    // A race circuit: an engine that turns faster. The note is a little
    // higher, brighter and cleaner, with more high whine. The tyres squeal
    // as on tarmac.
    grip: Object.freeze({
        shaperAmount: 8,
        barkBoostDb: 1,
        motorLowpassScale: 1.2,
        pitchScale: 1.1,
        whineScale: 1.5,
        gravelVol: 0,
        gravelFreq: 1800,
        rumbleVol: 0,
        slipMax: 0.18,
        slipScale: 0.5,
        slipQBase: 5.0,
        slipQPerSlip: 8.0,
        slipFreqBase: 1000,
        slipFreqPerSlip: 3000,
        slipFreqPerSpeed: 1200,
        shiftCrackVol: 0,
    }),
});

function getGroundSoundProfile(ground) {
    return Object.hasOwn(GROUND_SOUND_PROFILES, ground)
        ? GROUND_SOUND_PROFILES[ground]
        : GROUND_SOUND_PROFILES.tarmac;
}

function makeDistortionCurve(amount) {
    const k = typeof amount === 'number' ? amount : 50;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
        const x = (i * 2) / n_samples - 1;
        curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

export function createCarEffectsAudio(externalCtx, externalOutput) {
    const activeNodes = new Set();
    function keepAlive(node) {
        activeNodes.add(node);
        node.onended = () => activeNodes.delete(node);
    }

    let ctx = null;
    let masterGain = null;
    let compressor = null;

    let sawA = null;
    let sawB = null;
    let sawC = null;
    let orderOsc = null;
    let orderGain = null;
    let subOsc = null;
    let motorBus = null;
    let motorHighpass = null;
    let motorLowpass = null;
    let motorPeaking = null;
    let motorDrive = null;
    let motorShaper = null;
    let motorGain = null;

    let slipSource = null;
    let slipHighpass = null;
    let slipBandpass = null;
    let slipGain = null;

    let exhaustSource = null;
    let exhaustLowpass = null;
    let exhaustGain = null;

    let intakeSource = null;
    let intakeBandpass = null;
    let intakeGain = null;

    let noiseBuffer = null;
    let gravelNoiseBuffer = null;
    let gravelSource = null;
    let gravelBandpass = null;
    let gravelGain = null;
    let rumbleSource = null;
    let rumbleLowpass = null;
    let rumbleGain = null;
    let activeShaperAmount = 10;
    let lastGearIndex = null;
    let lastAudibleSpeed = null;
    let lastOverrunPopAt = -Infinity;

    let combustionPulseOsc = null;
    let motorPulseMod = null;
    let exhaustPulseMod = null;
    let thrumLFO = null;
    let thrumLFOMod = null;

    let graphBuilt = false;
    let tabHidden = false;
    let enabledCache = getCarProceduralAudioEnabled();
    let lastParameterSyncTime = -Infinity;
    let lastImmediateStateKey = '';
    let idleSuspendTimer = null;
    let lastFrame = {
        status: 'ready',
        speed: 0,
        maxSpeedKph: 220,
        slipRatio: 0,
        throttleBlocked: false,
        ground: 'tarmac'
    };

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

        masterGain = ctx.createGain();
        masterGain.gain.value = 0;
        masterGain.connect(externalOutput || ctx.destination);

        compressor = ctx.createDynamicsCompressor();
        compressor.threshold.setValueAtTime(-26, ctx.currentTime);
        compressor.knee.setValueAtTime(20, ctx.currentTime);
        compressor.ratio.setValueAtTime(3.2, ctx.currentTime);
        compressor.attack.setValueAtTime(0.002, ctx.currentTime);
        compressor.release.setValueAtTime(0.18, ctx.currentTime);
        compressor.connect(masterGain);

        motorBus = ctx.createGain();
        motorBus.gain.value = 1;

        motorHighpass = ctx.createBiquadFilter();
        motorHighpass.type = 'highpass';
        motorHighpass.frequency.value = 55;
        motorHighpass.Q.value = 0.7;

        motorLowpass = ctx.createBiquadFilter();
        motorLowpass.type = 'lowpass';
        motorLowpass.frequency.value = 2400;
        motorLowpass.Q.value = 1.6;

        motorPeaking = ctx.createBiquadFilter();
        motorPeaking.type = 'peaking';
        motorPeaking.frequency.value = 900;
        motorPeaking.Q.value = 1.2;
        motorPeaking.gain.value = 0;

        motorDrive = ctx.createGain();
        motorDrive.gain.value = 1;

        motorShaper = ctx.createWaveShaper();
        motorShaper.curve = makeDistortionCurve(10);
        motorShaper.oversampling = '4x';

        motorGain = ctx.createGain();
        motorGain.gain.value = 0;

        sawA = ctx.createOscillator();
        sawA.type = 'sawtooth';
        sawA.detune.value = -8;
        sawB = ctx.createOscillator();
        sawB.type = 'triangle';
        sawB.detune.value = 8;
        sawC = ctx.createOscillator();
        sawC.type = 'triangle';
        sawC.detune.value = 4;
        orderOsc = ctx.createOscillator();
        orderOsc.type = 'triangle';
        subOsc = ctx.createOscillator();
        subOsc.type = 'sine';

        const sawGainA = ctx.createGain();
        sawGainA.gain.value = 0.26;
        const sawGainB = ctx.createGain();
        sawGainB.gain.value = 0.22;
        const sawGainC = ctx.createGain();
        sawGainC.gain.value = 0.18;
        orderGain = ctx.createGain();
        orderGain.gain.value = ORDER_GAIN;
        const subGain = ctx.createGain();
        subGain.gain.value = 0.35;

        sawA.connect(sawGainA);
        sawB.connect(sawGainB);
        sawC.connect(sawGainC);
        orderOsc.connect(orderGain);
        subOsc.connect(subGain);
        sawGainA.connect(motorBus);
        sawGainB.connect(motorBus);
        sawGainC.connect(motorBus);
        orderGain.connect(motorBus);
        subGain.connect(motorBus);

        motorBus.connect(motorHighpass);
        motorHighpass.connect(motorLowpass);
        motorLowpass.connect(motorPeaking);
        motorPeaking.connect(motorDrive);
        motorDrive.connect(motorShaper);
        motorShaper.connect(motorGain);
        motorGain.connect(compressor);

        combustionPulseOsc = ctx.createOscillator();
        combustionPulseOsc.type = 'sine';
        combustionPulseOsc.frequency.value = 95;
        motorPulseMod = ctx.createGain();
        motorPulseMod.gain.value = 0;
        exhaustPulseMod = ctx.createGain();
        exhaustPulseMod.gain.value = 0;
        combustionPulseOsc.connect(motorPulseMod);
        combustionPulseOsc.connect(exhaustPulseMod);
        motorPulseMod.connect(motorGain.gain);

        thrumLFO = ctx.createOscillator();
        thrumLFO.type = 'sine';
        thrumLFO.frequency.value = 4.0;

        thrumLFOMod = ctx.createGain();
        thrumLFOMod.gain.value = 1.0;

        thrumLFO.connect(thrumLFOMod);
        thrumLFOMod.connect(sawA.detune);
        thrumLFOMod.connect(sawB.detune);
        thrumLFOMod.connect(sawC.detune);

        sawA.start();
        sawB.start();
        sawC.start();
        orderOsc.start();
        subOsc.start();
        combustionPulseOsc.start();
        thrumLFO.start();

        const noiseBuf = createLoopingNoiseBuffer(ctx, 2);
        noiseBuffer = noiseBuf;

        slipSource = ctx.createBufferSource();
        slipSource.buffer = noiseBuf;
        slipSource.loop = true;
        slipHighpass = ctx.createBiquadFilter();
        slipHighpass.type = 'highpass';
        slipHighpass.frequency.value = 550;
        slipHighpass.Q.value = 0.7;
        slipBandpass = ctx.createBiquadFilter();
        slipBandpass.type = 'bandpass';
        slipBandpass.frequency.value = 2200;
        slipBandpass.Q.value = 6.0;
        slipGain = ctx.createGain();
        slipGain.gain.value = 0;
        slipSource.connect(slipHighpass);
        slipHighpass.connect(slipBandpass);
        slipBandpass.connect(slipGain);
        slipGain.connect(masterGain);
        slipSource.start();

        exhaustSource = ctx.createBufferSource();
        exhaustSource.buffer = noiseBuf;
        exhaustSource.loop = true;
        exhaustLowpass = ctx.createBiquadFilter();
        exhaustLowpass.type = 'lowpass';
        exhaustLowpass.frequency.value = 360;
        exhaustLowpass.Q.value = 0.6;
        exhaustGain = ctx.createGain();
        exhaustGain.gain.value = 0;
        exhaustSource.connect(exhaustLowpass);
        exhaustLowpass.connect(exhaustGain);
        exhaustGain.connect(compressor);
        exhaustPulseMod.connect(exhaustGain.gain);
        exhaustSource.start();

        intakeSource = ctx.createBufferSource();
        intakeSource.buffer = noiseBuf;
        intakeSource.loop = true;
        intakeBandpass = ctx.createBiquadFilter();
        intakeBandpass.type = 'bandpass';
        intakeBandpass.frequency.value = 1350;
        intakeBandpass.Q.value = 1.1;
        intakeGain = ctx.createGain();
        intakeGain.gain.value = 0;
        intakeSource.connect(intakeBandpass);
        intakeBandpass.connect(intakeGain);
        intakeGain.connect(compressor);
        intakeSource.start();

        graphBuilt = true;
    }

    // The gravel and rumble sounds run only on a ground that uses them, so
    // a tarmac race does not play two silent sounds.
    function startGroundNoise() {
        if (gravelSource || !ctx || !masterGain || !compressor || !noiseBuffer) return;
        if (!gravelNoiseBuffer) gravelNoiseBuffer = createGravelNoiseBuffer(ctx, 2);

        gravelSource = ctx.createBufferSource();
        gravelSource.buffer = gravelNoiseBuffer;
        gravelSource.loop = true;
        gravelBandpass = ctx.createBiquadFilter();
        gravelBandpass.type = 'bandpass';
        gravelBandpass.frequency.value = 1800;
        gravelBandpass.Q.value = 0.9;
        gravelGain = ctx.createGain();
        gravelGain.gain.value = 0;
        gravelSource.connect(gravelBandpass);
        gravelBandpass.connect(gravelGain);
        gravelGain.connect(masterGain);
        gravelSource.start();

        rumbleSource = ctx.createBufferSource();
        rumbleSource.buffer = noiseBuffer;
        rumbleSource.loop = true;
        rumbleLowpass = ctx.createBiquadFilter();
        rumbleLowpass.type = 'lowpass';
        rumbleLowpass.frequency.value = 180;
        rumbleLowpass.Q.value = 0.7;
        rumbleGain = ctx.createGain();
        rumbleGain.gain.value = 0;
        rumbleSource.connect(rumbleLowpass);
        rumbleLowpass.connect(rumbleGain);
        rumbleGain.connect(compressor);
        rumbleSource.start();
    }

    // Call only while the two sounds are silent, as at the start of a
    // tarmac race: the ground noise goes to 0 when a race stops.
    function stopGroundNoise() {
        if (!gravelSource) return;
        for (const source of [gravelSource, rumbleSource]) {
            try {
                source.stop();
            } catch {
                // The source was already stopped.
            }
        }
        gravelGain.disconnect?.();
        rumbleGain.disconnect?.();
        gravelSource = null;
        gravelBandpass = null;
        gravelGain = null;
        rumbleSource = null;
        rumbleLowpass = null;
        rumbleGain = null;
    }

    function clearIdleSuspendTimer() {
        if (idleSuspendTimer === null) return;
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

    function resumeContextIfNeeded() {
        clearIdleSuspendTimer();
        if (ctx && ctx.state === 'suspended') {
            void ctx.resume();
        }
    }

    // A short noise burst. The gear bang uses a longer mid hit. An overrun pop
    // is shorter and higher.
    function scheduleNoiseHit({ volume, freq, q, attack, release, delay = 0 }) {
        if (!ctx || !masterGain || !noiseBuffer || !(volume > 0)) return;
        const t = ctx.currentTime + delay;
        const burst = ctx.createBufferSource();
        burst.buffer = noiseBuffer;
        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        band.frequency.setValueAtTime(freq, t);
        band.Q.setValueAtTime(q, t);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(volume, t + attack);
        gain.gain.exponentialRampToValueAtTime(0.001, t + release);
        burst.connect(band);
        band.connect(gain);
        gain.connect(masterGain);
        keepAlive(burst);
        burst.start(t, Math.random() * 1.5);
        burst.stop(t + release + 0.02);
    }

    function scheduleShiftCrack(volume) {
        scheduleNoiseHit({
            volume,
            freq: 420 + Math.random() * 180,
            q: 1.1,
            attack: 0.004,
            release: 0.11,
        });
    }

    function scheduleOverrunPop(volume, delay = 0) {
        const when = (ctx?.currentTime ?? 0) + delay;
        lastOverrunPopAt = Math.max(lastOverrunPopAt, when);
        scheduleNoiseHit({
            volume: volume * (0.55 + Math.random() * 0.45),
            freq: 980 + Math.random() * 820,
            q: 2.4,
            attack: 0.002,
            release: 0.03 + Math.random() * 0.025,
            delay,
        });
    }

    const api = {
        prepareOnUserGesture() {
            buildGraph();
            if (!ctx) return;
            if (ctx.state === 'suspended') {
                void ctx.resume().then(() => {
                    api.syncFrame(lastFrame);
                });
            } else {
                api.syncFrame(lastFrame);
            }
        },

        setTabHidden(hidden) {
            tabHidden = Boolean(hidden);
            if (hidden && ctx && ctx.state === 'running') {
                clearIdleSuspendTimer();
                void ctx.suspend();
            } else if (!hidden && ctx && ctx.state === 'suspended' && enabledCache) {
                void ctx.resume();
            }
        },

        scheduleScrape(impact, severity = 0) {
            if (!enabledCache || tabHidden) return;
            buildGraph();
            if (!ctx || !masterGain) return;
            resumeContextIfNeeded();

            const intensity = clamp(Number(impact) || 0, 0, 150);
            if (intensity < 1) return;
            const scrapeSeverity = clamp(Number(severity) || 0, 0, 1);
            const t = ctx.currentTime;
            const thud = ctx.createOscillator();
            thud.type = 'triangle';
            thud.frequency.setValueAtTime(180 - scrapeSeverity * 50, t);
            thud.frequency.exponentialRampToValueAtTime(95, t + 0.07);
            const thudG = ctx.createGain();
            thudG.gain.setValueAtTime(0, t);
            thudG.gain.linearRampToValueAtTime(0.05 + scrapeSeverity * 0.08, t + 0.004);
            thudG.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
            thud.connect(thudG);
            thudG.connect(masterGain);
            keepAlive(thud);
            thud.start(t);
            thud.stop(t + 0.1);
        },

        scheduleCountdownLight() {
            if (!enabledCache || tabHidden) return;
            buildGraph();
            if (!ctx || !masterGain) return;
            resumeContextIfNeeded();

            const t = ctx.currentTime;
            const osc = ctx.createOscillator();
            const g = ctx.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(600, t);

            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.3, t + 0.01);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

            osc.connect(g);
            g.connect(masterGain);

            keepAlive(osc);
            osc.start(t);
            osc.stop(t + 0.15);
        },

        scheduleGo() {
            if (!enabledCache || tabHidden) return;
            buildGraph();
            if (!ctx || !masterGain) return;
            resumeContextIfNeeded();

            const t = ctx.currentTime;
            const osc = ctx.createOscillator();
            const g = ctx.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(1200, t);

            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.4, t + 0.01);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);

            osc.connect(g);
            g.connect(masterGain);

            keepAlive(osc);
            osc.start(t);
            osc.stop(t + 0.5);
        },

        syncFrame({
            status,
            speed,
            maxSpeedKph,
            slipRatio,
            throttleBlocked,
            ground = 'tarmac',
        }) {
            lastFrame = { status, speed, maxSpeedKph, slipRatio, throttleBlocked, ground };
            const enabled = enabledCache;
            if (!graphBuilt && !externalCtx) return;
            buildGraph();
            if (
                !ctx
                || !masterGain
                || !sawA
                || !sawB
                || !sawC
                || !orderOsc
                || !orderGain
                || !subOsc
                || !motorGain
                || !motorLowpass
                || !motorPeaking
                || !slipGain
                || !slipBandpass
                || !exhaustGain
                || !intakeGain
                || !combustionPulseOsc
                || !motorPulseMod
                || !exhaustPulseMod
                || !thrumLFO
                || !thrumLFOMod
            ) {
                return;
            }

            const t = ctx.currentTime;
            const smooth = 0.055;

            const isPlaying = status === 'playing' && !tabHidden && enabled;
            const isAudible = !tabHidden && enabled;
            const immediateStateKey = `${status}:${tabHidden}:${enabled}:${throttleBlocked}`;
            const forceImmediateUpdate = immediateStateKey !== lastImmediateStateKey;
            lastImmediateStateKey = immediateStateKey;
            const masterSmooth = isPlaying ? smooth : 0;
            masterGain.gain.setTargetAtTime(isAudible ? 0.42 : 0, t, masterSmooth);

            if (!isPlaying) {
                motorGain.gain.setTargetAtTime(0, t, smooth);
                slipGain.gain.setTargetAtTime(0, t, smooth);
                exhaustGain.gain.setTargetAtTime(0, t, smooth);
                intakeGain.gain.setTargetAtTime(0, t, smooth);
                gravelGain?.gain.setTargetAtTime(0, t, smooth);
                rumbleGain?.gain.setTargetAtTime(0, t, smooth);
                lastGearIndex = null;
                lastAudibleSpeed = null;
                motorPulseMod.gain.setTargetAtTime(0, t, smooth);
                exhaustPulseMod.gain.setTargetAtTime(0, t, smooth);
                lastParameterSyncTime = t;
                scheduleIdleSuspend();
                return;
            }

            if (ctx.state === 'suspended') {
                void ctx.resume();
            }
            clearIdleSuspendTimer();

            if (!forceImmediateUpdate && t - lastParameterSyncTime < PARAMETER_SYNC_INTERVAL_SEC) {
                return;
            }
            lastParameterSyncTime = t;

            const maxWorld = Math.max(0.001, (Number(maxSpeedKph) || 220) / KPH_PER_WORLD_UNIT);
            const speedNorm = clamp(speed / maxWorld, 0, 1);
            const slip = clamp(slipRatio, 0, 1);
            const load = throttleBlocked ? 0.35 : 1.0;

            const gearCount = 6;
            const shiftedSpeed = clamp(speedNorm, 0, 0.995);
            const gearIndex = Math.min(gearCount - 1, Math.floor(shiftedSpeed * gearCount));
            const gearStart = gearIndex / gearCount;
            const gearEnd = (gearIndex + 1) / gearCount;
            const gearProgress = clamp((shiftedSpeed - gearStart) / (gearEnd - gearStart), 0, 1);
            const profile = getGroundSoundProfile(ground);
            if (profile.gravelVol > 0 || profile.rumbleVol > 0) startGroundNoise();
            else stopGroundNoise();
            if (profile.shaperAmount !== activeShaperAmount && motorShaper) {
                motorShaper.curve = makeDistortionCurve(profile.shaperAmount);
                activeShaperAmount = profile.shaperAmount;
            }
            if (lastGearIndex !== null && gearIndex > lastGearIndex) {
                scheduleShiftCrack(profile.shiftCrackVol);
                const pop = profile.overrunPopVol ?? 0;
                if (pop > 0) {
                    scheduleOverrunPop(pop, 0.045);
                    scheduleOverrunPop(pop, 0.12);
                    scheduleOverrunPop(pop, 0.2);
                }
            }
            lastGearIndex = gearIndex;
            const slowing = lastAudibleSpeed !== null
                && speed < lastAudibleSpeed - 0.02
                && speed > 0.5;
            const popVol = profile.overrunPopVol ?? 0;
            if (slowing && popVol > 0 && t >= lastOverrunPopAt + 0.08) {
                scheduleOverrunPop(popVol);
            }
            lastAudibleSpeed = speed;
            const rpmFloor = profile.rpmFloor ?? 0.34;
            const rpmNorm = rpmFloor + gearProgress * (1 - rpmFloor);
            const powerCurve = clamp(0.16 + rpmNorm * 0.60 + speedNorm * 0.24, 0, 1);
            const shimmer = 1 + Math.sin(t * 94) * 0.004 + Math.sin(t * 151) * 0.003;
            const f0 = (32 + (rpmNorm ** 1.3) * 105 + speedNorm * 18) * shimmer * profile.pitchScale;

            sawA.frequency.setTargetAtTime(f0, t, smooth);
            sawB.frequency.setTargetAtTime(f0 * 2.0, t, smooth);
            sawC.frequency.setTargetAtTime(f0 * 3.0, t, smooth);
            orderOsc.frequency.setTargetAtTime(f0 * 6.0, t, smooth);
            orderGain.gain.setTargetAtTime(ORDER_GAIN * profile.whineScale, t, smooth);
            subOsc.frequency.setTargetAtTime(f0 * 0.5, t, smooth);
            combustionPulseOsc.frequency.setTargetAtTime(35 + rpmNorm * 90, t, smooth);

            motorPulseMod.gain.setTargetAtTime((0.015 + rpmNorm * 0.025) * (profile.pulseScale ?? 1), t, smooth);
            exhaustPulseMod.gain.setTargetAtTime((0.012 + rpmNorm * 0.028) * load, t, smooth);

            thrumLFO.frequency.setTargetAtTime(4 + rpmNorm * 8, t, smooth);
            thrumLFOMod.gain.setTargetAtTime((0.5 + rpmNorm * 3.0) * (profile.thrumScale ?? 1), t, smooth);

            const filterBase = (450 + (powerCurve ** 1.3) * 1850) * profile.motorLowpassScale;
            motorLowpass.frequency.setTargetAtTime(filterBase, t, smooth);
            motorLowpass.Q.setTargetAtTime(0.8 + powerCurve * 0.4, t, smooth);

            const barkDb = clamp(1.5 + rpmNorm * 5.5 + speedNorm * 2.0, 1.5, 9.0) + profile.barkBoostDb;
            motorPeaking.gain.setTargetAtTime(barkDb, t, smooth);
            motorPeaking.frequency.setTargetAtTime((400 + rpmNorm * 1600) * (profile.barkFreqScale ?? 1), t, smooth);

            const driveAmount = 0.55 + load * 0.25 + rpmNorm * 0.35;
            motorDrive.gain.setTargetAtTime(driveAmount, t, smooth);

            const engineVol = (0.065 + rpmNorm * 0.082 + speedNorm * 0.055) * (0.58 + load * 0.42);
            motorGain.gain.setTargetAtTime(engineVol, t, smooth);

            const slipDrive = slip * slip;
            const slipVol = Math.min(profile.slipMax, slipDrive * profile.slipScale) * (0.3 + speedNorm * 0.7);
            slipGain.gain.setTargetAtTime(slipVol, t, smooth);
            slipHighpass.frequency.setTargetAtTime(profile.slipHighpass ?? 550, t, smooth);
            slipBandpass.Q.setTargetAtTime(profile.slipQBase + slip * profile.slipQPerSlip, t, smooth);
            slipBandpass.frequency.setTargetAtTime(
                profile.slipFreqBase + slip * profile.slipFreqPerSlip + speedNorm * profile.slipFreqPerSpeed,
                t,
                smooth,
            );

            if (gravelSource) {
                const gravelVol = profile.gravelVol * speedNorm * ((profile.gravelCruise ?? 0.7) + slip * (profile.gravelSlip ?? 0.6));
                gravelGain.gain.setTargetAtTime(gravelVol, t, smooth);
                gravelBandpass.frequency.setTargetAtTime(profile.gravelFreq, t, smooth);
                gravelBandpass.Q.setTargetAtTime(profile.gravelQ ?? 0.9, t, smooth);
                gravelSource.playbackRate?.setTargetAtTime?.((profile.gravelRate ?? 1) * (0.6 + speedNorm * 0.8), t, smooth);
                rumbleGain.gain.setTargetAtTime(
                    profile.rumbleVol * speedNorm * (1 + slip * (profile.rumbleSlip ?? 0)),
                    t,
                    smooth,
                );
            }

            const exh = (0.012 + rpmNorm * 0.012 + speedNorm * 0.012) * (0.60 + load * 0.40);
            exhaustGain.gain.setTargetAtTime(exh, t, smooth);
            exhaustLowpass.frequency.setTargetAtTime(120 + rpmNorm * 280 + speedNorm * 320, t, smooth);

            const intk = (0.006 + speedNorm * 0.012 + rpmNorm * 0.010) * (0.45 + load * 0.55);
            intakeGain.gain.setTargetAtTime(intk, t, smooth);
            intakeBandpass.Q.setTargetAtTime(1.8, t, smooth);
            intakeBandpass.frequency.setTargetAtTime(800 + rpmNorm * 1800 + speedNorm * 500, t, smooth);

            masterGain.gain.setTargetAtTime(0.42 * (profile.level ?? 1), t, smooth);
        },

        setEnabled(enabled) {
            enabledCache = Boolean(enabled);
            api.syncFrame(lastFrame);
            if (!enabledCache) {
                scheduleIdleSuspend(0);
            }
        },
    };

    registeredApi = api;
    registerAudioPrepareOnFirstUserGesture(() => registeredApi?.prepareOnUserGesture?.());
    return api;
}
