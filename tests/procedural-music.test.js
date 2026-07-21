import { describe, expect, it, vi } from 'vitest';
import { createProceduralMusic } from '../game/audio/procedural-music.js';

function createMockAudioContext() {
    const mockGainNode = {
        gain: {
            value: 0,
            setValueAtTime: vi.fn(),
            setTargetAtTime: vi.fn(),
            cancelScheduledValues: vi.fn()
        },
        connect: vi.fn()
    };
    const mockFilterNode = {
        frequency: {
            setValueAtTime: vi.fn(),
            setTargetAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn()
        },
        Q: {
            setValueAtTime: vi.fn(),
            setTargetAtTime: vi.fn()
        },
        connect: vi.fn()
    };
    const mockDelayNode = {
        delayTime: {
            setValueAtTime: vi.fn()
        },
        connect: vi.fn()
    };

    return {
        currentTime: 0.1,
        sampleRate: 44100,
        state: 'running',
        createGain: vi.fn(() => mockGainNode),
        createBiquadFilter: vi.fn(() => mockFilterNode),
        createDelay: vi.fn(() => mockDelayNode),
        createOscillator: vi.fn(() => ({
            frequency: {
                setValueAtTime: vi.fn(),
                exponentialRampToValueAtTime: vi.fn()
            },
            detune: {
                setValueAtTime: vi.fn()
            },
            connect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn()
        })),
        createBuffer: vi.fn(() => ({
            getChannelData: vi.fn(() => new Float32Array(100))
        })),
        createBufferSource: vi.fn(() => ({
            connect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn()
        })),
        resume: vi.fn(() => Promise.resolve())
    };
}

describe('procedural music engine', () => {
    it('creates and returns api with expected methods', () => {
        const mockCtx = createMockAudioContext();
        const mockOutput = {};

        const music = createProceduralMusic(mockCtx, mockOutput);
        expect(music).toBeDefined();
        expect(typeof music.syncFrame).toBe('function');
        expect(typeof music.setTabHidden).toBe('function');
        expect(typeof music.prepareOnUserGesture).toBe('function');
        expect(typeof music.stop).toBe('function');

        // Clean up interval
        music.stop();
    });

    it('does not keep the scheduler running outside active racing', () => {
        const setIntervalSpy = vi
            .spyOn(globalThis, 'setInterval')
            .mockReturnValue(123);
        const clearIntervalSpy = vi
            .spyOn(globalThis, 'clearInterval')
            .mockImplementation(() => {});
        const mockCtx = createMockAudioContext();
        const music = createProceduralMusic(mockCtx, {});

        music.prepareOnUserGesture();
        music.syncFrame({ status: 'ready', speed: 0, maxSpeedKph: 220 });
        expect(setIntervalSpy).not.toHaveBeenCalled();

        music.syncFrame({ status: 'playing', speed: 10, maxSpeedKph: 220 });
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);

        music.syncFrame({ status: 'paused', speed: 0, maxSpeedKph: 220 });
        expect(clearIntervalSpy).toHaveBeenCalledWith(123);

        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
    });

    it('starts scheduler after resume when context is suspended during play', async () => {
        const setIntervalSpy = vi
            .spyOn(globalThis, 'setInterval')
            .mockReturnValue(456);
        const clearIntervalSpy = vi
            .spyOn(globalThis, 'clearInterval')
            .mockImplementation(() => {});
        const mockCtx = createMockAudioContext();
        mockCtx.state = 'suspended';
        mockCtx.resume = vi.fn(() => {
            mockCtx.state = 'running';
            return Promise.resolve();
        });
        const music = createProceduralMusic(mockCtx, {});

        // Unlock the graph so syncFrame can run (graphBuilt gate).
        music.prepareOnUserGesture();
        await mockCtx.resume.mock.results[0].value;
        expect(setIntervalSpy).not.toHaveBeenCalled();

        mockCtx.state = 'suspended';
        music.syncFrame({ status: 'playing', speed: 10, maxSpeedKph: 220 });
        expect(setIntervalSpy).not.toHaveBeenCalled();
        expect(mockCtx.resume).toHaveBeenCalled();

        await mockCtx.resume.mock.results[mockCtx.resume.mock.results.length - 1].value;
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);

        music.stop();
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
    });
});
