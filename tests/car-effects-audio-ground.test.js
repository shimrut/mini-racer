import { describe, expect, it, vi } from 'vitest';

vi.mock('../game/settings/car-audio-preference.js', () => ({
    getCarProceduralAudioEnabled: () => true,
}));
vi.mock('../game/audio/first-user-gesture-unlock.js', () => ({
    registerAudioPrepareOnFirstUserGesture: () => {},
}));

const { createCarEffectsAudio } = await import('../game/audio/car-effects-audio.js');

function createParam(value = 0) {
    const param = {
        value,
        last: value,
        setValueAtTime: vi.fn((next) => { param.last = next; }),
        setTargetAtTime: vi.fn((next) => { param.last = next; }),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
    };
    return param;
}

function createNode(extra = {}) {
    return { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), ...extra };
}

function createMockContext() {
    const nodes = { gains: [], filters: [], sources: [], shapers: [], oscillators: [] };
    const ctx = {
        currentTime: 0,
        sampleRate: 8000,
        state: 'running',
        destination: {},
        resume: vi.fn(() => Promise.resolve()),
        suspend: vi.fn(() => Promise.resolve()),
        createGain: vi.fn(() => {
            const node = createNode({ gain: createParam() });
            nodes.gains.push(node);
            return node;
        }),
        createBiquadFilter: vi.fn(() => {
            const node = createNode({ type: '', frequency: createParam(), Q: createParam(), gain: createParam() });
            nodes.filters.push(node);
            return node;
        }),
        createOscillator: vi.fn(() => {
            const node = createNode({ type: '', frequency: createParam(), detune: createParam() });
            nodes.oscillators.push(node);
            return node;
        }),
        createWaveShaper: vi.fn(() => {
            const node = createNode({ curve: null, oversampling: 'none' });
            nodes.shapers.push(node);
            return node;
        }),
        createDynamicsCompressor: vi.fn(() => createNode({
            threshold: createParam(), knee: createParam(), ratio: createParam(),
            attack: createParam(), release: createParam(),
        })),
        createBuffer: vi.fn((channels, length) => ({ getChannelData: () => new Float32Array(length) })),
        createBufferSource: vi.fn(() => {
            const node = createNode({ buffer: null, loop: false, playbackRate: createParam(1) });
            nodes.sources.push(node);
            return node;
        }),
    };
    return { ctx, nodes };
}

function driveFrame(audio, ctx, ground, { slipRatio = 0.6 } = {}) {
    ctx.currentTime += 1;
    audio.syncFrame({
        status: 'playing',
        speed: 12,
        maxSpeedKph: 310,
        slipRatio,
        throttleBlocked: false,
        ground,
    });
}

// Graph order: the gravel and rumble gains are the last two gains built.
function groundGains(nodes) {
    return { gravel: nodes.gains.at(-2), rumble: nodes.gains.at(-1) };
}

describe('car sound per ground', () => {
    it('keeps the tarmac slide squeal and plays no gravel or rumble sound', () => {
        const { ctx, nodes } = createMockContext();
        const audio = createCarEffectsAudio(ctx, {});
        audio.prepareOnUserGesture();
        const sourcesBefore = nodes.sources.length;
        driveFrame(audio, ctx, 'tarmac');

        expect(nodes.sources.length).toBe(sourcesBefore);
        const slipBand = nodes.filters.find((filter) => filter.type === 'bandpass' && filter.frequency.value === 2200);
        expect(slipBand.Q.last).toBeCloseTo(5.0 + 0.6 * 8.0);
    });

    it('adds gravel, rumble and a wide slide spray on dirt', () => {
        const { ctx, nodes } = createMockContext();
        const audio = createCarEffectsAudio(ctx, {});
        audio.prepareOnUserGesture();
        const shaperCurve = nodes.shapers[0].curve;
        driveFrame(audio, ctx, 'dirt');

        const { gravel, rumble } = groundGains(nodes);
        expect(gravel.gain.last).toBeGreaterThan(0);
        expect(rumble.gain.last).toBeGreaterThan(0);
        const slipBand = nodes.filters.find((filter) => filter.type === 'bandpass' && filter.frequency.value === 2200);
        expect(slipBand.Q.last).toBeLessThan(2);
        expect(nodes.shapers[0].curve).not.toBe(shaperCurve);
    });

    it('stops the gravel and rumble sounds when the next race is on tarmac', () => {
        const { ctx, nodes } = createMockContext();
        const audio = createCarEffectsAudio(ctx, {});
        audio.prepareOnUserGesture();
        const sourcesBefore = nodes.sources.length;
        driveFrame(audio, ctx, 'dirt');
        const groundSources = nodes.sources.slice(sourcesBefore);
        expect(groundSources).toHaveLength(2);
        expect(groundSources.every((source) => source.start.mock.calls.length === 1)).toBe(true);

        ctx.currentTime += 1;
        audio.syncFrame({ status: 'won', speed: 0, maxSpeedKph: 310, slipRatio: 0, throttleBlocked: false, ground: 'dirt' });
        driveFrame(audio, ctx, 'tarmac');
        expect(groundSources.every((source) => source.stop.mock.calls.length === 1)).toBe(true);

        driveFrame(audio, ctx, 'dirt');
        expect(nodes.sources.length).toBe(sourcesBefore + 4);
    });

    it('muffles the engine and adds a low crunch and a thick slide whoosh on snow', () => {
        const tarmac = createMockContext();
        const tarmacAudio = createCarEffectsAudio(tarmac.ctx, {});
        tarmacAudio.prepareOnUserGesture();
        driveFrame(tarmacAudio, tarmac.ctx, 'tarmac');

        const snow = createMockContext();
        const snowAudio = createCarEffectsAudio(snow.ctx, {});
        snowAudio.prepareOnUserGesture();
        driveFrame(snowAudio, snow.ctx, 'snow');

        const motorLowpass = (nodes) => nodes.filters.find((filter) => filter.frequency.value === 2400);
        expect(motorLowpass(snow.nodes).frequency.last).toBeLessThan(motorLowpass(tarmac.nodes).frequency.last);
        const enginePitch = (nodes) => nodes.oscillators[0].frequency.last;
        expect(enginePitch(snow.nodes)).toBeLessThan(enginePitch(tarmac.nodes));
        const whine = (nodes) => nodes.gains.find((gain) => gain.gain.value === 0.15);
        expect(whine(snow.nodes).gain.last).toBeLessThan(whine(tarmac.nodes).gain.last);
        expect(snow.nodes.gains[0].gain.last).toBeGreaterThan(tarmac.nodes.gains[0].gain.last);

        const { gravel } = groundGains(snow.nodes);
        expect(gravel.gain.last).toBeGreaterThan(0);
        const gravelBand = snow.nodes.filters.find((filter) => filter.frequency.value === 1800);
        expect(gravelBand.frequency.last).toBeLessThan(600);
        const slipBand = (nodes) => nodes.filters.find((filter) => filter.type === 'bandpass' && filter.frequency.value === 2200);
        expect(slipBand(snow.nodes).Q.last).toBeLessThan(2);
        expect(slipBand(snow.nodes).frequency.last).toBeLessThan(slipBand(tarmac.nodes).frequency.last);
        const slipHigh = snow.nodes.filters.find((filter) => filter.type === 'highpass' && filter.frequency.value === 550);
        expect(slipHigh.frequency.last).toBeLessThan(250);
    });

    it('plays a higher, brighter engine with more whine on grip, and the tarmac squeal', () => {
        const tarmac = createMockContext();
        const tarmacAudio = createCarEffectsAudio(tarmac.ctx, {});
        tarmacAudio.prepareOnUserGesture();
        driveFrame(tarmacAudio, tarmac.ctx, 'tarmac');

        const grip = createMockContext();
        const gripAudio = createCarEffectsAudio(grip.ctx, {});
        gripAudio.prepareOnUserGesture();
        const tarmacCurve = grip.nodes.shapers[0].curve;
        driveFrame(gripAudio, grip.ctx, 'grip');

        // The first oscillator is the engine note.
        const enginePitch = (nodes) => nodes.oscillators[0].frequency.last;
        expect(enginePitch(grip.nodes)).toBeGreaterThan(enginePitch(tarmac.nodes) * 1.05);
        const motorLowpass = (nodes) => nodes.filters.find((filter) => filter.frequency.value === 2400);
        expect(motorLowpass(grip.nodes).frequency.last).toBeGreaterThan(motorLowpass(tarmac.nodes).frequency.last);
        const whine = (nodes) => nodes.gains.find((gain) => gain.gain.value === 0.15);
        expect(whine(grip.nodes).gain.last).toBeGreaterThan(whine(tarmac.nodes).gain.last);
        expect(grip.nodes.shapers[0].curve).not.toBe(tarmacCurve);

        const slipBand = (nodes) => nodes.filters.find((filter) => filter.type === 'bandpass' && filter.frequency.value === 2200);
        expect(slipBand(grip.nodes).Q.last).toBeCloseTo(slipBand(tarmac.nodes).Q.last);
        expect(slipBand(grip.nodes).frequency.last).toBeCloseTo(slipBand(tarmac.nodes).frequency.last);
    });

    it('plays a gear crack on dirt and snow when the car shifts up, and not on tarmac', () => {
        for (const [ground, expectCrack] of [['dirt', true], ['tarmac', false], ['snow', true]]) {
            const { ctx, nodes } = createMockContext();
            const audio = createCarEffectsAudio(ctx, {});
            audio.prepareOnUserGesture();
            ctx.currentTime += 1;
            audio.syncFrame({ status: 'playing', speed: 1, maxSpeedKph: 310, slipRatio: 0, throttleBlocked: false, ground });
            const sourcesBefore = nodes.sources.length;
            ctx.currentTime += 1;
            audio.syncFrame({ status: 'playing', speed: 6, maxSpeedKph: 310, slipRatio: 0, throttleBlocked: false, ground });
            expect(nodes.sources.length > sourcesBefore, ground).toBe(expectCrack);
        }
    });

    it('plays a lower, less whiny engine on dirt than on tarmac', () => {
        const tarmac = createMockContext();
        const tarmacAudio = createCarEffectsAudio(tarmac.ctx, {});
        tarmacAudio.prepareOnUserGesture();
        driveFrame(tarmacAudio, tarmac.ctx, 'tarmac');

        const dirt = createMockContext();
        const dirtAudio = createCarEffectsAudio(dirt.ctx, {});
        dirtAudio.prepareOnUserGesture();
        driveFrame(dirtAudio, dirt.ctx, 'dirt');

        const enginePitch = (nodes) => nodes.oscillators[0].frequency.last;
        expect(enginePitch(dirt.nodes)).toBeLessThan(enginePitch(tarmac.nodes) * 0.9);
        const whine = (nodes) => nodes.gains.find((gain) => gain.gain.value === 0.15);
        expect(whine(dirt.nodes).gain.last).toBeLessThan(whine(tarmac.nodes).gain.last * 0.5);
        const bark = (nodes) => nodes.filters.find((filter) => filter.frequency.value === 900);
        expect(bark(dirt.nodes).gain.last).toBeGreaterThan(bark(tarmac.nodes).gain.last);
        expect(bark(dirt.nodes).frequency.last).toBeLessThan(bark(tarmac.nodes).frequency.last);
    });

    it('makes a dirt slide a low roar, and plays the dirt car louder than tarmac', () => {
        const tarmac = createMockContext();
        const tarmacAudio = createCarEffectsAudio(tarmac.ctx, {});
        tarmacAudio.prepareOnUserGesture();
        driveFrame(tarmacAudio, tarmac.ctx, 'tarmac');

        const dirt = createMockContext();
        const dirtAudio = createCarEffectsAudio(dirt.ctx, {});
        dirtAudio.prepareOnUserGesture();
        driveFrame(dirtAudio, dirt.ctx, 'dirt');

        const slipBand = (nodes) => nodes.filters.find((filter) => filter.type === 'bandpass' && filter.frequency.value === 2200);
        const slipHigh = (nodes) => nodes.filters.find((filter) => filter.type === 'highpass' && filter.frequency.value === 550);
        expect(slipBand(dirt.nodes).frequency.last).toBeLessThan(700);
        expect(slipHigh(dirt.nodes).frequency.last).toBeLessThan(250);
        expect(slipBand(tarmac.nodes).frequency.last).toBeGreaterThan(2000);
        const gravelBand = dirt.nodes.filters.find((filter) => filter.frequency.value === 1800);
        expect(gravelBand.frequency.last).toBeLessThan(800);
        expect(dirt.nodes.gains[0].gain.last).toBeGreaterThan(tarmac.nodes.gains[0].gain.last * 1.15);
    });

    it('keeps gravel quieter on a dirt straight than in a slide', () => {
        const { ctx, nodes } = createMockContext();
        const audio = createCarEffectsAudio(ctx, {});
        audio.prepareOnUserGesture();
        driveFrame(audio, ctx, 'dirt', { slipRatio: 0 });
        const straight = groundGains(nodes).gravel.gain.last;
        driveFrame(audio, ctx, 'dirt', { slipRatio: 1 });
        expect(groundGains(nodes).gravel.gain.last).toBeGreaterThan(straight * 2);
    });

    it('crackles on dirt and snow when the car slows down, and stays quiet on tarmac', () => {
        for (const [ground, expectPops] of [['dirt', true], ['snow', true], ['tarmac', false]]) {
            const { ctx, nodes } = createMockContext();
            const audio = createCarEffectsAudio(ctx, {});
            audio.prepareOnUserGesture();
            ctx.currentTime += 1;
            audio.syncFrame({ status: 'playing', speed: 12, maxSpeedKph: 310, slipRatio: 0, throttleBlocked: false, ground });
            const sourcesBefore = nodes.sources.length;
            ctx.currentTime += 1;
            audio.syncFrame({ status: 'playing', speed: 10, maxSpeedKph: 310, slipRatio: 0, throttleBlocked: false, ground });
            expect(nodes.sources.length > sourcesBefore, ground).toBe(expectPops);
        }
    });
});
