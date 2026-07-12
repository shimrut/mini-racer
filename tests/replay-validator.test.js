import { describe, expect, it } from 'vitest';
import { validateDailyGpReplay, validateDailyGpReplayDetailed } from '../src/server/replay-validator.ts';

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

const STRAIGHT_TRACK = {
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

describe('server replay validator', () => {
    it('computes a finish time from replay inputs', () => {
        const result = validateDailyGpReplay({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay: {
                targetLapNumber: 1,
                inputs: [
                    { frames: 240, left: false, right: false, relaunchDelay: false },
                ],
            },
        });

        expect(result).toMatchObject({
            completedLaps: 1,
            checkpointTimesSec: null,
            method: 'finish',
        });
        expect(result.bestTimeSec).toBeGreaterThanOrEqual(2);
        expect(result.bestTimeMs).toBe(Math.round(result.bestTimeSec * 1000));
    });

    it('rejects submissions that do not replay to a valid finish', () => {
        expect(validateDailyGpReplay({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay: {
                targetLapNumber: 1,
                inputs: [
                    { frames: 10, left: false, right: false, relaunchDelay: false },
                ],
            },
        })).toBe(null);

        expect(validateDailyGpReplay({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay: {
                targetLapNumber: 1,
                inputs: [
                    { frames: 1, left: 'no', right: false, relaunchDelay: false },
                ],
            },
        })).toBe(null);
    });

    it('freezes exactly the recorded relaunch-delay frames (no off-by-one input shift)', () => {
        // A run that started from a crash auto-restart or pause-resume arms a
        // relaunch delay, so the replay begins with relaunchDelay=true frames.
        // The validator must freeze the car for exactly those frames and run
        // physics on the very first relaunchDelay=false frame — matching the
        // client. A residual timer (the old fixedDt + EPSILON) froze one extra
        // frame, shifting every later steering input by one frame.
        const physicsFrames = 10;
        const replay = {
            targetLapNumber: 1,
            inputs: [
                { frames: 5, left: false, right: false, relaunchDelay: true },
                { frames: physicsFrames, left: false, right: false, relaunchDelay: false },
            ],
        };

        const outcome = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay,
        });

        expect(outcome.ok).toBe(false);
        expect(outcome.failure.reason).toBe('no_finish');
        // 5 frozen frames + 10 physics frames => currentTime == 10 * (1/60).
        const expected = Math.round((physicsFrames / 60) * 1000) / 1000;
        expect(outcome.failure.simulatedTimeSec).toBe(expected);
    });
});
