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

    it('muffles the engine and adds a soft crunch and a high slide hiss on snow', () => {
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
        const { gravel } = groundGains(snow.nodes);
        expect(gravel.gain.last).toBeGreaterThan(0);
        const gravelBand = snow.nodes.filters.find((filter) => filter.frequency.value === 1800);
        expect(gravelBand.frequency.last).toBeLessThan(1800);
        const slipBand = snow.nodes.filters.find((filter) => filter.type === 'bandpass' && filter.frequency.value === 2200);
        expect(slipBand.Q.last).toBeLessThan(2);
        expect(slipBand.frequency.last).toBeGreaterThan(2400);
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

    it('plays a gear crack on dirt when the car shifts up, and not on tarmac or snow', () => {
        for (const [ground, expectCrack] of [['dirt', true], ['tarmac', false], ['snow', false]]) {
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
});
