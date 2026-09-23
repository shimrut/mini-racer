import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUpdateSimulation } = vi.hoisted(() => ({
    mockUpdateSimulation: vi.fn(),
}));

vi.mock('../game/race/simulation.js', () => ({
    updateSimulation: mockUpdateSimulation,
}));

vi.mock('../game/config.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        CONFIG: {
            ...actual.CONFIG,
            fixedDt: 0,
        },
    };
});

import { validateDailyGpReplayDetailed } from '../src/server/competition/replay-validator.ts';

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

    it('rejects a run that stops early with rounded failure details', () => {
        mockUpdateSimulation.mockImplementation((state) => {
            state.status = 'paused';
            state.currentTime = 1.23456;
            state.nextCheckpointIndex = 2.9;
            state.pos = { x: 1.23456, y: -9.87654 };
            state.cachedSpeed = 12.3456;
            return { winTriggered: false };
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
                reason: 'ended_before_replay_finished',
                frameCount: 3,
                simulatedTimeSec: 1.235,
                checkpointIndex: 2,
                status: 'paused',
                position: { x: 1.235, y: -9.877 },
                speed: 12.346,
            },
        });
        expect(mockUpdateSimulation).toHaveBeenCalledTimes(1);
        expect(mockUpdateSimulation.mock.calls[0][0].keys).toEqual({ left: true, right: false });
        expect(mockUpdateSimulation.mock.calls[0][0]).toMatchObject({
            wallContactActive: false,
            activeRunId: 'server-replay-validation',
            currentModeKey: 'daily',
            velocity: { x: 0, y: 0 },
            currentChallengeRun: {
                objectiveType: 'single_lap_fastest',
                requiredLaps: 1,
                completedLaps: 0,
                lastLapAt: 0,
            },
        });
        expect(mockUpdateSimulation.mock.calls[0][0].currentRunPolicy).toMatchObject({
            requiredLaps: 1,
            objectiveType: 'single_lap_fastest',
        });
        expect(typeof mockUpdateSimulation.mock.calls[0][0].runHistory.last).toBe('function');
        expect(mockUpdateSimulation.mock.calls[0][0].runHistory.last()).toBe(null);
        const history = mockUpdateSimulation.mock.calls[0][0].runHistory;
        const slot = history.write();
        slot.x = 1;
        expect(history.last()).toBe(slot);
        history.clear();
        expect(history.last()).toBe(null);
    });

    it('omits non-finite failure details instead of inventing values', () => {
        mockUpdateSimulation.mockImplementation((state) => {
            state.status = 99;
            state.currentTime = Number.NaN;
            state.nextCheckpointIndex = Number.NaN;
            state.pos = { x: Number.NaN, y: 5.5 };
            state.cachedSpeed = Number.POSITIVE_INFINITY;
            return { winTriggered: false };
        });

        const outcome = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: TRACK,
            replay: {
                inputs: [{ frames: 2, left: false, right: false, relaunchDelay: false }],
            },
        });

        expect(outcome).toEqual({
            ok: false,
            failure: {
                reason: 'ended_before_replay_finished',
                frameCount: 2,
            },
        });
    });

    it('rejects when the run ends before all replay frames are consumed', () => {
        mockUpdateSimulation.mockImplementation((state) => {
            state.status = 'paused';
            state.currentTime = 0.05;
            state.pos = { x: 5, y: -34 };
            state.cachedSpeed = 0;
            return { winTriggered: false };
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

    it('rejects wins that omit winData entirely', () => {
        mockUpdateSimulation.mockImplementation((state) => {
            state.currentTime = 2;
            state.status = 'won';
            return {
                winTriggered: true,
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
    });

    it('truncates completed laps and copies checkpoint times on a successful finish', () => {
        mockUpdateSimulation.mockImplementation((state) => {
            state.currentTime = 3.4567;
            state.pos = { x: 5.5, y: -0.2 };
            state.angle = 1.6;
            state.lapCheckpointTimesSec = [1.25, 2.5];
            state.status = 'won';
            return {
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
        expect(mockUpdateSimulation.mock.calls[0][1]).toBeCloseTo(1 / 60);
    });

    it('falls back to 1/60 when fixedDt is missing or zero', () => {
        mockUpdateSimulation.mockImplementation((state, dt) => {
            state.currentTime = dt;
            state.pos = { x: 6, y: -1 };
            state.angle = 1.5;
            state.status = 'won';
            return {
                winTriggered: true,
                winData: { lapTime: dt, completedLaps: 1 },
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
        expect(mockUpdateSimulation.mock.calls[0][1]).toBeCloseTo(1 / 60);
        expect(outcome.run.bestTimeSec).toBeCloseTo(1 / 60);
    });

    it('returns null checkpoint times when the finishing state has none', () => {
        mockUpdateSimulation.mockImplementation((state) => {
            state.currentTime = 2.5;
            state.lapCheckpointTimesSec = [];
            state.status = 'won';
            return {
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

    it.each([1, 2, 3])(
      'captures exact cumulative lap boundaries for a %i-lap verified replay',
      (lapCount) => {
        let frame = 0;
        mockUpdateSimulation.mockImplementation((state) => {
            frame += 1;
            state.currentTime = frame * 2;
            state.lapCheckpointTimesSec.push(frame);
            state.currentChallengeRun.completedLaps = frame;
            state.currentChallengeRun.lastLapAt = state.currentTime;
            if (frame < lapCount) {
                return {
                    challengeLapCompleted: true,
                    challengeElapsedTime: state.currentTime,
                    winTriggered: false,
                };
            }
            state.status = 'won';
            return {
                challengeLapCompleted: true,
                challengeElapsedTime: state.currentTime,
                winTriggered: true,
                winData: { lapTime: state.currentTime, completedLaps: lapCount },
            };
        });

        const outcome = validateDailyGpReplayDetailed({
            challenge: {
                ...CHALLENGE,
                rulesRevision: 1,
                objectiveType: lapCount === 1 ? 'single_lap_fastest' : 'multi_lap_total',
                objectiveParams: { lapCount },
            },
            track: TRACK,
            replay: {
                rulesRevision: 1,
                targetLapNumber: lapCount,
                inputs: [{ frames: lapCount, left: false, right: false, relaunchDelay: false }],
            },
        });

        const boundaries = Array.from({ length: lapCount }, (_, index) => (index + 1) * 2);
        expect(outcome.ok).toBe(true);
        expect(outcome.run).toMatchObject({
            bestTimeSec: lapCount * 2,
            completedLaps: lapCount,
            checkpointTimesSec: Array.from({ length: lapCount }, (_, index) => index + 1),
            lapCompletionTimesSec: boundaries,
        });
        expect(mockUpdateSimulation.mock.calls[0][0].currentRunPolicy).toMatchObject({
            requiredLaps: lapCount,
            rulesRevision: 1,
        });
      },
    );
});
