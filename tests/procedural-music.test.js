import { describe, expect, it, vi } from 'vitest';
import { createProceduralMusic } from '../game/audio/procedural-music.js';

describe('procedural music engine', () => {
    it('creates and returns api with expected methods', () => {
        // Mock AudioContext and nodes
        const mockGainNode = {
            gain: {
                setValueAtTime: vi.fn(),
                setTargetAtTime: vi.fn()
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
        
        const mockCtx = {
            currentTime: 0.1,
            sampleRate: 44100,
            createGain: vi.fn(() => mockGainNode),
            createBiquadFilter: vi.fn(() => mockFilterNode),
            createDelay: vi.fn(() => mockDelayNode),
            createOscillator: vi.fn(() => ({
                frequency: {
                    setValueAtTime: vi.fn(),
                    exponentialRampToValueAtTime: vi.fn()
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
            }))
        };
        
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
});
