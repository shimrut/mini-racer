import { KPH_PER_WORLD_UNIT } from '../car/handling.js?v=1.91';
import { getCarProceduralAudioEnabled } from '../settings/car-audio-preference.js?v=1.91';
import { registerAudioPrepareOnFirstUserGesture } from './first-user-gesture-unlock.js?v=1.97';

let registeredApi = null;
const PARAMETER_SYNC_INTERVAL_SEC = 1 / 30;
const IDLE_AUDIO_SUSPEND_MS = 250;

export function userGesturePrepareCarEffects() {
    registeredApi?.prepareOnUserGesture?.();
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
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

/**
 * Procedural motor: high-speed racing synth-engine, drivetrain whine, tire noise,
 * slip screech, and light bus compression. Ducked when disabled / paused / hidden tab.
 */
export function createCarEffectsAudio(externalCtx, externalOutput) {
    let ctx = null;
    let masterGain = null;
    let compressor = null;

    let sawA = null;
    let sawB = null;
    let sawC = null;
    let orderOsc = null;
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
        throttleBlocked: false
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
        const orderGain = ctx.createGain();
        orderGain.gain.value = 0.15;
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

        // Subtle arcade drivetrain shimmer.
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

        scheduleCrash(impact) {
            if (!enabledCache || tabHidden) return;
            buildGraph();
            if (!ctx || !masterGain) return;
            resumeContextIfNeeded();
            const intensity = clamp(Number(impact) || 0, 0, 2000);
            if (intensity < 1) return;

            const t = ctx.currentTime;

            // Light thud/clink for minor bumps
            if (intensity < 35) {
                const thud = ctx.createOscillator();
                thud.type = 'sine';
                thud.frequency.setValueAtTime(150, t);
                thud.frequency.exponentialRampToValueAtTime(80, t + 0.08);
                const thudG = ctx.createGain();
                thudG.gain.setValueAtTime(0, t);
                thudG.gain.linearRampToValueAtTime(0.12, t + 0.005);
                thudG.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
                thud.connect(thudG);
                thudG.connect(masterGain);
                thud.start(t);
                thud.stop(t + 0.12);
                return;
            }

            // Hard crash sequence - Massive Low-Frequency Explosion (BOOM)
            const peak = clamp(intensity * 0.00085, 0.2, 0.95);

            // 1. THE INITIAL PUNCH (The shockwave kick)
            const kick = ctx.createOscillator();
            kick.type = 'sine';
            kick.frequency.setValueAtTime(150, t);
            kick.frequency.exponentialRampToValueAtTime(30, t + 0.18);
            const kickG = ctx.createGain();
            kickG.gain.setValueAtTime(0, t);
            kickG.gain.linearRampToValueAtTime(peak * 1.8, t + 0.005);
            kickG.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
            kick.connect(kickG);
            kickG.connect(masterGain);
            kick.start(t);
            kick.stop(t + 0.5);

            // 2. THE EXPLOSION CORE (Distorted Low Rumble)
            const noiseLen = Math.floor(ctx.sampleRate * 1.2);
            const explosionBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
            const ch = explosionBuf.getChannelData(0);
            for (let i = 0; i < noiseLen; i++) {
                ch[i] = Math.random() * 2 - 1;
            }
            const rumbleSrc = ctx.createBufferSource();
            rumbleSrc.buffer = explosionBuf;

            const lowpass = ctx.createBiquadFilter();
            lowpass.type = 'lowpass';
            lowpass.frequency.setValueAtTime(650, t);
            lowpass.frequency.exponentialRampToValueAtTime(80, t + 0.7);
            lowpass.Q.value = 6.0; // Resonant peak for more boom

            const distortion = ctx.createWaveShaper();
            distortion.curve = makeDistortionCurve(120);

            const rumbleG = ctx.createGain();
            rumbleG.gain.setValueAtTime(0, t);
            rumbleG.gain.linearRampToValueAtTime(peak * 1.4, t + 0.02);
            rumbleG.gain.exponentialRampToValueAtTime(0.001, t + 0.9);

            rumbleSrc.connect(lowpass);
            lowpass.connect(distortion);
            distortion.connect(rumbleG);
            rumbleG.connect(masterGain);
            rumbleSrc.start(t);
            rumbleSrc.stop(t + 1.0);

            // 3. THE INFRA-SUB (Room shaker tail)
            const infra = ctx.createOscillator();
            infra.type = 'sine';
            infra.frequency.setValueAtTime(65, t);
            infra.frequency.exponentialRampToValueAtTime(20, t + 0.6);
            const infraG = ctx.createGain();
            infraG.gain.setValueAtTime(0, t);
            infraG.gain.linearRampToValueAtTime(peak * 1.5, t + 0.06);
            infraG.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
            infra.connect(infraG);
            infraG.connect(masterGain);
            infra.start(t);
            infra.stop(t + 1.0);
        },

        scheduleCountdownLight(index) {
            if (!enabledCache || tabHidden) return;
            buildGraph();
            if (!ctx || !masterGain) return;
            resumeContextIfNeeded();

            const t = ctx.currentTime;
            const osc = ctx.createOscillator();
            const g = ctx.createGain();

            osc.type = 'sine';
            // Low beep for the three red lights
            osc.frequency.setValueAtTime(600, t);

            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.3, t + 0.01);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

            osc.connect(g);
            g.connect(masterGain);

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
            // High beep for GO
            osc.frequency.setValueAtTime(1200, t);

            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.4, t + 0.01);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);

            osc.connect(g);
            g.connect(masterGain);

            osc.start(t);
            osc.stop(t + 0.5);
        },

        syncFrame({
            status,
            speed,
            maxSpeedKph,
            slipRatio,
            throttleBlocked,
        }) {
            lastFrame = { status, speed, maxSpeedKph, slipRatio, throttleBlocked };
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
            const rpmNorm = 0.34 + gearProgress * 0.66;
            const powerCurve = clamp(0.16 + rpmNorm * 0.60 + speedNorm * 0.24, 0, 1);
            const shimmer = 1 + Math.sin(t * 94) * 0.004 + Math.sin(t * 151) * 0.003;
            const f0 = (32 + (rpmNorm ** 1.3) * 105 + speedNorm * 18) * shimmer;

            sawA.frequency.setTargetAtTime(f0, t, smooth);
            sawB.frequency.setTargetAtTime(f0 * 2.0, t, smooth);
            sawC.frequency.setTargetAtTime(f0 * 3.0, t, smooth);
            orderOsc.frequency.setTargetAtTime(f0 * 6.0, t, smooth);
            subOsc.frequency.setTargetAtTime(f0 * 0.5, t, smooth);
            combustionPulseOsc.frequency.setTargetAtTime(35 + rpmNorm * 90, t, smooth);

            motorPulseMod.gain.setTargetAtTime(0.015 + rpmNorm * 0.025, t, smooth);
            exhaustPulseMod.gain.setTargetAtTime((0.012 + rpmNorm * 0.028) * load, t, smooth);

            thrumLFO.frequency.setTargetAtTime(4 + rpmNorm * 8, t, smooth);
            thrumLFOMod.gain.setTargetAtTime(0.5 + rpmNorm * 3.0, t, smooth);

            const filterBase = 450 + (powerCurve ** 1.3) * 1850;
            motorLowpass.frequency.setTargetAtTime(filterBase, t, smooth);
            motorLowpass.Q.setTargetAtTime(0.8 + powerCurve * 0.4, t, smooth);

            const barkDb = clamp(1.5 + rpmNorm * 5.5 + speedNorm * 2.0, 1.5, 9.0);
            motorPeaking.gain.setTargetAtTime(barkDb, t, smooth);
            motorPeaking.frequency.setTargetAtTime(400 + rpmNorm * 1600, t, smooth);

            const driveAmount = 0.55 + load * 0.25 + rpmNorm * 0.35;
            motorDrive.gain.setTargetAtTime(driveAmount, t, smooth);

            const engineVol = (0.065 + rpmNorm * 0.082 + speedNorm * 0.055) * (0.58 + load * 0.42);
            motorGain.gain.setTargetAtTime(engineVol, t, smooth);

            // Slip / Screech - Higher Q makes it a 'screech' instead of 'rustle' (foșnit)
            const slipDrive = slip * slip;
            const slipVol = Math.min(0.18, slipDrive * 0.5) * (0.3 + speedNorm * 0.7);
            slipGain.gain.setTargetAtTime(slipVol, t, smooth);
            slipBandpass.Q.setTargetAtTime(5.0 + slip * 8.0, t, smooth);
            slipBandpass.frequency.setTargetAtTime(1000 + slip * 3000 + speedNorm * 1200, t, smooth);

            const exh = (0.012 + rpmNorm * 0.012 + speedNorm * 0.012) * (0.60 + load * 0.40);
            exhaustGain.gain.setTargetAtTime(exh, t, smooth);
            exhaustLowpass.frequency.setTargetAtTime(120 + rpmNorm * 280 + speedNorm * 320, t, smooth);

            const intk = (0.006 + speedNorm * 0.012 + rpmNorm * 0.010) * (0.45 + load * 0.55);
            intakeGain.gain.setTargetAtTime(intk, t, smooth);
            intakeBandpass.Q.setTargetAtTime(1.8, t, smooth);
            intakeBandpass.frequency.setTargetAtTime(800 + rpmNorm * 1800 + speedNorm * 500, t, smooth);

            masterGain.gain.setTargetAtTime(0.42, t, smooth);
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
