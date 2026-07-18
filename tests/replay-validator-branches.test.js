import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUpdateSimulation } = vi.hoisted(() => ({
    mockUpdateSimulation: vi.fn(),
}));

vi.mock('../game/race/simulation.js', () => ({
    updateSimulation: mockUpdateSimulation,
}));

import { validateDailyGpReplayDetailed } from '../src/server/replay-validator.ts';

const CHALLENGE = {
    id: 'daily-gp-2026-05-06',
    challengeDate: '2026-05-06',
    trackKey: 'validatorStraight',
    startsAt: '2026-05-06T00:00:00.000Z',
    endsAt: '2026-05-07T00:00:00.000Z',
    availableUntil: '2026-05-13T00:00:00.000Z',
    status: 'active',
    objectiveType: 'single_lap_fastest',
    objectiveParams: {},
    skin: 'default',
};

const TRACK = {
    startPos: { x: 5, y: -35 },
    startAngle: Math.PI / 2,
    startLine: {
        p1: { x: 0, y: 0 },
        p2: { x: 10, y: 0 },
    },
    checkpoints: [],
    outer: [
        { x: -100, y: -100 },
        { x: 100, y: -100 },
        { x: 100, y: 100 },
        { x: -100, y: 100 },
    ],
    inner: [
        { x: 200, y: 200 },
        { x: 201, y: 200 },
        { x: 201, y: 201 },
        { x: 200, y: 201 },
    ],
};

describe('server replay validator branch coverage', () => {
    beforeEach(() => {
        mockUpdateSimulation.mockReset();
    });

    it('rejects crashed simulations with rounded failure details', () => {
        mockUpdateSimulation.mockImplementation((state) => {
            state.status = 'crashed';
            state.currentTime = 1.23456;
            state.nextCheckpointIndex = 2.9;
            state.pos = { x: 1.23456, y: -9.87654 };
            state.cachedSpeed = 12.3456;
            return { crashEndedRun: true, winTriggered: false };
        });

        const outcome = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: TRACK,
            replay: {
                inputs: [{ frames: 3, left: true, right: false, relaunchDelay: false }],
            },
        });

        expect(outcome).toEqual({
            ok: false,
            failure: {
                reason: 'crashed',
                frameCount: 3,
                simulatedTimeSec: 1.235,
                checkpointIndex: 2,
                status: 'crashed',
                position: { x: 1.235, y: -9.877 },
                speed: 12.346,
            },
        });
        expect(mockUpdateSimulation).toHaveBeenCalledTimes(1);
        expect(mockUpdateSimulation.mock.calls[0][0].keys).toEqual({ left: true, right: false });
    });

    it('rejects when the run ends before all replay frames are consumed', () => {
        mockUpdateSimulation.mockImplementation((state) => {
            state.status = 'paused';
            state.currentTime = 0.05;
            state.pos = { x: 5, y: -34 };
            state.cachedSpeed = 0;
            return { crashEndedRun: false, winTriggered: false };
        });

        const outcome = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: TRACK,
            replay: {
                inputs: [{ frames: 2, left: false, right: false, relaunchDelay: false }],
            },
        });

        expect(outcome.ok).toBe(false);
        expect(outcome.failure.reason).toBe('ended_before_replay_finished');
        expect(outcome.failure.frameCount).toBe(2);
        expect(outcome.failure.status).toBe('paused');
        expect(mockUpdateSimulation).toHaveBeenCalledTimes(1);
    });

    it('rejects wins that do not include a finite lap time', () => {
        mockUpdateSimulation.mockImplementation((state) => {
            state.currentTime = 2;
            state.status = 'won';
            return {
                crashEndedRun: false,
                winTriggered: true,
                winData: { lapTime: Number.NaN, completedLaps: 1 },
            };
        });

        const outcome = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: TRACK,
            replay: {
                inputs: [{ frames: 1, left: false, right: false, relaunchDelay: false }],
            },
        });

        expect(outcome.ok).toBe(false);
        expect(outcome.failure.reason).toBe('missing_win_time');
        expect(outcome.failure.frameCount).toBe(1);
    });

    it('truncates completed laps and copies checkpoint times on a successful finish', () => {
        mockUpdateSimulation.mockImplementation((state) => {
            state.currentTime = 3.4567;
            state.pos = { x: 5.5, y: -0.2 };
            state.angle = 1.6;
            state.lapCheckpointTimesSec = [1.25, 2.5];
            state.status = 'won';
            return {
                crashEndedRun: false,
                winTriggered: true,
                winData: { lapTime: 3.4567, completedLaps: 1.9 },
            };
        });

        const outcome = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: TRACK,
            replay: {
                inputs: [{ frames: 1, left: false, right: true, relaunchDelay: true }],
            },
        });

        expect(outcome.ok).toBe(true);
        expect(outcome.run).toMatchObject({
            bestTimeSec: 3.4567,
            bestTimeMs: 3457,
            completedLaps: 1,
            checkpointTimesSec: [1.25, 2.5],
            method: 'finish',
        });

        outcome.run.checkpointTimesSec[0] = 99;
        expect(mockUpdateSimulation.mock.calls[0][0].lapCheckpointTimesSec[0]).toBe(1.25);
        expect(mockUpdateSimulation.mock.calls[0][0].keys).toEqual({ left: false, right: true });
        expect(mockUpdateSimulation.mock.calls[0][0].relaunchDelayRemaining).toBeCloseTo(1 / 60);
    });

    it('returns null checkpoint times when the finishing state has none', () => {
        mockUpdateSimulation.mockImplementation((state) => {
            state.currentTime = 2.5;
            state.lapCheckpointTimesSec = [];
            state.status = 'won';
            return {
                crashEndedRun: false,
                winTriggered: true,
                winData: { lapTime: 2.5, completedLaps: 1 },
            };
        });

        const outcome = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: TRACK,
            replay: {
                inputs: [{ frames: 1, left: false, right: false, relaunchDelay: false }],
            },
        });

        expect(outcome.ok).toBe(true);
        expect(outcome.run.checkpointTimesSec).toBe(null);
        expect(outcome.run.completedLaps).toBe(1);
    });

    it('returns null completed laps when win data omits a finite lap count', () => {
        mockUpdateSimulation.mockImplementation((state) => {
            state.currentTime = 2.5;
            state.status = 'won';
            return {
                crashEndedRun: false,
                winTriggered: true,
                winData: { lapTime: 2.5 },
            };
        });

        const outcome = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: TRACK,
            replay: {
                inputs: [{ frames: 1, left: false, right: false, relaunchDelay: false }],
            },
        });

        expect(outcome.ok).toBe(true);
        expect(outcome.run.completedLaps).toBe(null);
    });
});
