import { describe, expect, it, vi } from 'vitest';
import { createProceduralMusic } from '../game/audio/procedural-music.js';

function createParam() {
    return {
        value: 0,
        setValueAtTime: vi.fn(),
        setTargetAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
    };
}

function createMockContext() {
    const oscillators = [];
    const shapers = [];
    const ctx = {
        currentTime: 0,
        sampleRate: 8000,
        state: 'running',
        destination: {},
        resume: vi.fn(() => Promise.resolve()),
        suspend: vi.fn(() => Promise.resolve()),
        createGain: vi.fn(() => ({ gain: createParam(), connect: vi.fn() })),
        createBiquadFilter: vi.fn(() => ({ frequency: createParam(), Q: createParam(), connect: vi.fn() })),
        createDelay: vi.fn(() => ({ delayTime: createParam(), connect: vi.fn() })),
        createOscillator: vi.fn(() => {
            const osc = {
                type: '',
                frequency: createParam(),
                detune: createParam(),
                connect: vi.fn(),
                start: vi.fn(),
                stop: vi.fn(),
            };
            oscillators.push(osc);
            return osc;
        }),
        createBuffer: vi.fn((channels, length) => ({ getChannelData: () => new Float32Array(length) })),
        createBufferSource: vi.fn(() => ({ connect: vi.fn(), start: vi.fn(), stop: vi.fn() })),
        createWaveShaper: vi.fn(() => {
            const shaper = { curve: null, connect: vi.fn() };
            shapers.push(shaper);
            return shaper;
        }),
    };
    return { ctx, oscillators, shapers };
}

// Runs the music scheduler for two seconds and returns the first bass pitch.
function playTwoSeconds(ground) {
    let tick = null;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((fn) => {
        tick = fn;
        return 1;
    });
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    const { ctx, oscillators, shapers } = createMockContext();
    const music = createProceduralMusic(ctx, {});
    music.prepareOnUserGesture();
    music.syncFrame({ status: 'playing', speed: 12, maxSpeedKph: 310, ground });
    for (let time = 0; time <= 2; time += 0.05) {
        ctx.currentTime = time;
        tick?.();
    }
    music.stop();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    const firstBass = oscillators.find((osc) => osc.type === 'sawtooth');
    return {
        bassHz: firstBass.frequency.setValueAtTime.mock.calls[0][0],
        squareCount: oscillators.filter((osc) => osc.type === 'square').length,
        firstSineHz: oscillators.find((osc) => osc.type === 'sine')?.frequency.setValueAtTime.mock.calls[0][0],
        triangleCount: oscillators.filter((osc) => osc.type === 'triangle').length,
        noteStarts: oscillators.map((osc) => osc.start.mock.calls[0][0]),
        noteHz: oscillators.map((osc) => osc.frequency.setValueAtTime.mock.calls[0][0]),
        shaperCount: shapers.length,
    };
}

describe('race song per ground', () => {
    it('plays the A minor synth song on tarmac', () => {
        const tarmac = playTwoSeconds('tarmac');
        expect(tarmac.bassHz).toBeCloseTo(440 * 2 ** ((33 - 69) / 12));
    });

    it('plays the faster D minor rally song on dirt', () => {
        const dirt = playTwoSeconds('dirt');
        const tarmac = playTwoSeconds('tarmac');
        expect(dirt.bassHz).toBeCloseTo(440 * 2 ** ((38 - 69) / 12));
        expect(dirt.squareCount).toBeGreaterThan(0);
        expect(Math.max(...dirt.noteStarts)).toBeGreaterThan(0);
        expect(dirt.noteStarts.length).not.toBe(tarmac.noteStarts.length);
    });

    it('plays the cold B minor synth song on snow, with glassy plucks and no bells', () => {
        const snow = playTwoSeconds('snow');
        expect(snow.firstSineHz).toBeCloseTo(440 * 2 ** ((35 - 69) / 12));
        expect(snow.triangleCount).toBeGreaterThan(0);
        expect(snow.squareCount).toBe(0);
    });

    it('keeps the low F sharp minor space song, with no note above A4', () => {
        const space = playTwoSeconds('space');
        const tarmac = playTwoSeconds('tarmac');
        expect(space.bassHz).toBeCloseTo(440 * 2 ** ((30 - 69) / 12));
        expect(space.triangleCount).toBeGreaterThan(0);
        expect(space.squareCount).toBe(0);
        expect(Math.max(...space.noteHz)).toBeLessThanOrEqual(440);
        expect(Math.max(...tarmac.noteHz)).toBeGreaterThan(440);
    });

    it('plays a distinct E minor grip song with the tarmac arp density', () => {
        const grip = playTwoSeconds('grip');
        const tarmac = playTwoSeconds('tarmac');
        expect(grip.bassHz).toBeCloseTo(440 * 2 ** ((28 - 69) / 12));
        expect(grip.squareCount).toBeGreaterThanOrEqual(tarmac.squareCount * 0.9);
        expect(Math.max(...grip.noteHz)).toBeGreaterThan(440);
    });

    it('plays the tarmac song for a missing or unknown ground', () => {
        const unknown = playTwoSeconds('lava');
        const missing = playTwoSeconds(undefined);
        expect(unknown.bassHz).toBeCloseTo(440 * 2 ** ((33 - 69) / 12));
        expect(missing.bassHz).toBeCloseTo(440 * 2 ** ((33 - 69) / 12));
    });
});
