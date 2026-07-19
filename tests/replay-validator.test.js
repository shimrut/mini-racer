import { describe, expect, it } from 'vitest';
import {
    MAX_REPLAY_FRAMES,
    validateDailyGpReplay,
    validateDailyGpReplayDetailed,
} from '../src/server/replay-validator.ts';
import { isValidPbGhostTrace } from '../src/server/pb-ghost-trace.ts';

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

const CHECKPOINT_TRACK = {
    ...STRAIGHT_TRACK,
    checkpoints: [
        {
            p1: { x: 0, y: -20 },
            p2: { x: 10, y: -20 },
        },
    ],
};

const SCRAPE_TRACK = {
    ...STRAIGHT_TRACK,
    startPos: { x: 4, y: -35 },
    startAngle: 1.48,
    inner: [
        { x: 5, y: -25 },
        { x: 20, y: -25 },
        { x: 20, y: -10 },
        { x: 5, y: -10 },
    ],
};

const HEAD_ON_WALL_TRACK = {
    ...STRAIGHT_TRACK,
    startPos: { x: 0, y: 0 },
    startAngle: 0,
    startLine: {
        p1: { x: 10, y: -20 },
        p2: { x: 10, y: 20 },
    },
    inner: [
        { x: 5, y: -20 },
        { x: 20, y: -20 },
        { x: 20, y: 20 },
        { x: 5, y: 20 },
    ],
};

const FINISHING_REPLAY = {
    targetLapNumber: 1,
    inputs: [
        { frames: 240, left: false, right: false, relaunchDelay: false },
    ],
};

describe('server replay validator', () => {
    it('caps accepted replays at MAX_REPLAY_FRAMES', () => {
        expect(MAX_REPLAY_FRAMES).toBe(2700);
    });

    it('computes a finish time, ghost, and millisecond rounding from replay inputs', () => {
        const result = validateDailyGpReplay({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay: FINISHING_REPLAY,
        });

        expect(result).toMatchObject({
            completedLaps: 1,
            checkpointTimesSec: null,
            method: 'finish',
        });
        expect(result.bestTimeSec).toBeGreaterThanOrEqual(2);
        expect(result.bestTimeMs).toBe(Math.round(result.bestTimeSec * 1000));
        expect(isValidPbGhostTrace(result.ghost)).toBe(true);
        expect(result.ghost.finishTimeMs).toBe(result.bestTimeMs);
    });

    it('returns checkpoint split times when the finishing lap crossed checkpoints', () => {
        const outcome = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: CHECKPOINT_TRACK,
            replay: FINISHING_REPLAY,
        });

        expect(outcome.ok).toBe(true);
        expect(outcome.run.checkpointTimesSec).toHaveLength(1);
        expect(outcome.run.checkpointTimesSec[0]).toBeGreaterThan(0);
        expect(outcome.run.checkpointTimesSec[0]).toBeLessThan(outcome.run.bestTimeSec);
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

    it('reports no_finish failure details for short incomplete replays', () => {
        const outcome = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay: {
                inputs: [
                    { frames: 10, left: false, right: false, relaunchDelay: false },
                ],
            },
        });

        expect(outcome).toEqual({
            ok: false,
            failure: {
                reason: 'no_finish',
                frameCount: 10,
                simulatedTimeSec: Math.round((10 / 60) * 1000) / 1000,
                checkpointIndex: 0,
                status: 'playing',
                position: expect.objectContaining({
                    x: expect.any(Number),
                    y: expect.any(Number),
                }),
                speed: expect.any(Number),
            },
        });
        expect(Number.isFinite(outcome.failure.position.x)).toBe(true);
        expect(Number.isFinite(outcome.failure.position.y)).toBe(true);
        expect(outcome.failure.speed).toBeGreaterThan(0);
    });

    it('rejects missing, empty, and malformed replay payloads with specific reasons', () => {
        expect(validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay: null,
        })).toEqual({ ok: false, failure: { reason: 'missing_replay' } });

        expect(validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay: 'nope',
        })).toEqual({ ok: false, failure: { reason: 'missing_replay' } });

        expect(validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay: {},
        })).toEqual({ ok: false, failure: { reason: 'missing_replay_inputs' } });

        expect(validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay: { inputs: [] },
        })).toEqual({ ok: false, failure: { reason: 'missing_replay_inputs' } });

        expect(validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay: { inputs: null },
        })).toEqual({ ok: false, failure: { reason: 'missing_replay_inputs' } });

        const invalidSegments = [
            null,
            'segment',
            { frames: 0, left: false, right: false, relaunchDelay: false },
            { frames: -1, left: false, right: false, relaunchDelay: false },
            { frames: 1.5, left: false, right: false, relaunchDelay: false },
            { frames: NaN, left: false, right: false, relaunchDelay: false },
            { frames: 1, left: 1, right: false, relaunchDelay: false },
            { frames: 1, left: false, right: 'false', relaunchDelay: false },
            { frames: 1, left: false, right: false, relaunchDelay: 0 },
            { frames: 1, left: false, right: false },
        ];

        for (const segment of invalidSegments) {
            expect(validateDailyGpReplayDetailed({
                challenge: CHALLENGE,
                track: STRAIGHT_TRACK,
                replay: { inputs: [segment] },
            })).toEqual({
                ok: false,
                failure: { reason: 'invalid_replay_segment' },
            });
        }
    });

    it('rejects replays that exceed the frame cap and accepts the exact cap for schema', () => {
        const tooLong = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay: {
                inputs: [
                    { frames: MAX_REPLAY_FRAMES, left: false, right: false, relaunchDelay: false },
                    { frames: 1, left: false, right: false, relaunchDelay: false },
                ],
            },
        });
        expect(tooLong).toEqual({
            ok: false,
            failure: {
                reason: 'replay_too_long',
                frameCount: MAX_REPLAY_FRAMES + 1,
            },
        });

        const singleTooLong = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay: {
                inputs: [
                    { frames: MAX_REPLAY_FRAMES + 1, left: false, right: false, relaunchDelay: false },
                ],
            },
        });
        expect(singleTooLong.failure).toEqual({
            reason: 'replay_too_long',
            frameCount: MAX_REPLAY_FRAMES + 1,
        });

        const atCap = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay: {
                inputs: [
                    { frames: MAX_REPLAY_FRAMES, left: false, right: false, relaunchDelay: false },
                ],
            },
        });
        expect(atCap.ok).toBe(true);
        expect(atCap.run.method).toBe('finish');
    });

    it('rejects unknown challenges or tracks before simulating', () => {
        expect(validateDailyGpReplayDetailed({
            challenge: null,
            track: STRAIGHT_TRACK,
            replay: FINISHING_REPLAY,
        })).toEqual({
            ok: false,
            failure: { reason: 'unknown_track' },
        });

        expect(validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: null,
            replay: FINISHING_REPLAY,
        })).toEqual({
            ok: false,
            failure: { reason: 'unknown_track' },
        });

        expect(validateDailyGpReplayDetailed({
            challenge: { ...CHALLENGE, trackKey: 'does-not-exist' },
            replay: FINISHING_REPLAY,
        })).toEqual({
            ok: false,
            failure: { reason: 'unknown_track' },
        });
    });

    it('accepts a finished replay after a momentum-losing wall scrape', () => {
        const clean = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: { ...STRAIGHT_TRACK, startPos: SCRAPE_TRACK.startPos, startAngle: SCRAPE_TRACK.startAngle },
            replay: {
                inputs: [{ frames: 300, left: false, right: false, relaunchDelay: false }],
            },
        });
        const scraped = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: SCRAPE_TRACK,
            replay: {
                inputs: [{ frames: 300, left: false, right: false, relaunchDelay: false }],
            },
        });

        expect(clean.ok).toBe(true);
        expect(scraped.ok).toBe(true);
        expect(scraped.run.bestTimeSec).toBeGreaterThan(clean.run.bestTimeSec);
    });

    it('does not classify a replay with a 150+ KPH wall impact as crashed', () => {
        const outcome = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: HEAD_ON_WALL_TRACK,
            replay: {
                inputs: [{ frames: 300, left: false, right: false, relaunchDelay: false }],
            },
        });

        expect(outcome.ok).toBe(false);
        expect(outcome.failure.reason).not.toBe('crashed');
        expect(outcome.failure.status).toBe('playing');
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

    it('applies left and right steering segments during validation', () => {
        const straight = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay: {
                inputs: [
                    { frames: 120, left: false, right: false, relaunchDelay: false },
                ],
            },
        });
        const turned = validateDailyGpReplayDetailed({
            challenge: CHALLENGE,
            track: STRAIGHT_TRACK,
            replay: {
                inputs: [
                    { frames: 60, left: true, right: false, relaunchDelay: false },
                    { frames: 60, left: false, right: true, relaunchDelay: false },
                ],
            },
        });

        expect(straight.ok).toBe(false);
        expect(turned.ok).toBe(false);
        expect(turned.failure.position).not.toEqual(straight.failure.position);
        expect(turned.failure.reason).toBe('no_finish');
        expect(straight.failure.frameCount).toBe(120);
        expect(turned.failure.frameCount).toBe(120);
    });
});
