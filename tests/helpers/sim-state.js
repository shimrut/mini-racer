import { CONFIG } from '../../game/config.js';
import { RingBuffer } from '../../game/race/ring-buffer.js';
import { createRunPolicy } from '../../game/race/run-policy.js';

/** Minimal track: horizontal finish line y = 0 from (0,0) to (10,0). No checkpoints. */
export const TEST_TRACK = {
    startLine: {
        p1: { x: 0, y: 0 },
        p2: { x: 10, y: 0 }
    },
    checkpoints: []
};

export function createTestSimState(overrides = {}) {
    const baseState = {
        status: 'playing',
        relaunchDelayRemaining: 0,
        wallImpactCooldownRemaining: 0,
        wallContactActive: false,
        wallContactReleaseRemaining: 0,
        currentTime: 2,
        keys: { left: false, right: false },
        angle: Math.PI / 2,
        velocity: { x: 0, y: 20 },
        pos: { x: 5, y: -0.2 },
        prevPos: { x: 5, y: -0.2 },
        cachedSpeed: 0,
        angularVelocity: 0,
        nextCheckpointIndex: 0,
        currentTrackKey: 'circuit',
        activeRunId: '00000000-0000-4000-8000-000000000001',
        currentModeKey: 'daily',
        currentChallengeRun: null,
        frameSkip: 0,
        qualityLevel: 0,
        collisionHash: null,
        particles: [],
        trailTimer: 0,
        runHistoryTimer: 0,
        skidMarks: new RingBuffer(16, () => ({ x: 0, y: 0, cos: 0, sin: 0 })),
        routeTrace: new RingBuffer(16, () => ({ x: 0, y: 0 })),
        runHistory: new RingBuffer(256, () => ({ x: 0, y: 0 }))
    };

    const state = {
        ...baseState,
        ...overrides
    };
    state.currentRunPolicy = overrides.currentRunPolicy || createRunPolicy({
        modeKey: state.currentModeKey,
        challengeRun: state.currentChallengeRun
    });
    return state;
}
