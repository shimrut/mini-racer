import { describe, expect, it } from 'vitest';
import {
    ReplayRecorder,
    SCOREBOARD_REPLAY_MAX_FRAMES,
} from '../game/race/replay.js';

describe('ReplayRecorder', () => {
    it('defaults the frame cap to SCOREBOARD_REPLAY_MAX_FRAMES', () => {
        expect(SCOREBOARD_REPLAY_MAX_FRAMES).toBe(12000);

        const recorder = new ReplayRecorder();
        for (let i = 0; i < SCOREBOARD_REPLAY_MAX_FRAMES; i += 1) {
            recorder.record(false, false, false);
        }

        expect(recorder.frameCount).toBe(SCOREBOARD_REPLAY_MAX_FRAMES);
        expect(recorder.overflowed).toBe(false);
        expect(recorder.getPayload()).not.toBe(null);

        recorder.record(false, false, false);
        expect(recorder.overflowed).toBe(true);
        expect(recorder.frameCount).toBe(SCOREBOARD_REPLAY_MAX_FRAMES);
        expect(recorder.getPayload()).toBe(null);
    });

    it('returns null payloads until at least one frame is recorded', () => {
        const recorder = new ReplayRecorder();

        expect(recorder.frameCount).toBe(0);
        expect(recorder.overflowed).toBe(false);
        expect(recorder.getPayload()).toBe(null);
        expect(recorder.getPayload(2)).toBe(null);
    });

    it('merges consecutive identical inputs into one segment and copies them in the payload', () => {
        const recorder = new ReplayRecorder();

        recorder.record(true, false, false);
        recorder.record(true, false, false);
        recorder.record(true, false, false);
        recorder.record(false, true, false);
        recorder.record(false, true, true);

        expect(recorder.frameCount).toBe(5);
        expect(recorder.overflowed).toBe(false);

        const payload = recorder.getPayload();
        expect(payload).toEqual({
            targetLapNumber: 1,
            inputs: [
                { frames: 3, left: true, right: false, relaunchDelay: false },
                { frames: 1, left: false, right: true, relaunchDelay: false },
                { frames: 1, left: false, right: true, relaunchDelay: true },
            ],
        });

        payload.inputs[0].frames = 99;
        payload.inputs[0].left = false;
        expect(recorder.getPayload()).toEqual({
            targetLapNumber: 1,
            inputs: [
                { frames: 3, left: true, right: false, relaunchDelay: false },
                { frames: 1, left: false, right: true, relaunchDelay: false },
                { frames: 1, left: false, right: true, relaunchDelay: true },
            ],
        });
    });

    it('uses the requested target lap number in the payload', () => {
        const recorder = new ReplayRecorder();
        recorder.record(false, false, false);

        expect(recorder.getPayload(3)).toEqual({
            targetLapNumber: 3,
            inputs: [{ frames: 1, left: false, right: false, relaunchDelay: false }],
        });
    });

    it('starts a new segment when any input flag changes', () => {
        const recorder = new ReplayRecorder();

        recorder.record(false, false, false);
        recorder.record(true, false, false);
        recorder.record(false, false, false);
        recorder.record(false, true, false);
        recorder.record(false, false, false);
        recorder.record(false, false, true);
        recorder.record(false, false, false);

        expect(recorder.getPayload()).toEqual({
            targetLapNumber: 1,
            inputs: [
                { frames: 1, left: false, right: false, relaunchDelay: false },
                { frames: 1, left: true, right: false, relaunchDelay: false },
                { frames: 1, left: false, right: false, relaunchDelay: false },
                { frames: 1, left: false, right: true, relaunchDelay: false },
                { frames: 1, left: false, right: false, relaunchDelay: false },
                { frames: 1, left: false, right: false, relaunchDelay: true },
                { frames: 1, left: false, right: false, relaunchDelay: false },
            ],
        });
    });

    it('marks overflow without recording the over-cap frame and discards the payload', () => {
        const recorder = new ReplayRecorder(2);

        recorder.record(true, false, false);
        recorder.record(true, false, false);
        expect(recorder.frameCount).toBe(2);
        expect(recorder.overflowed).toBe(false);
        expect(recorder.getPayload()).toEqual({
            targetLapNumber: 1,
            inputs: [{ frames: 2, left: true, right: false, relaunchDelay: false }],
        });

        recorder.record(false, true, true);
        expect(recorder.frameCount).toBe(2);
        expect(recorder.overflowed).toBe(true);
        expect(recorder.getPayload()).toBe(null);
        expect(recorder.getPayload(4)).toBe(null);

        recorder.record(true, true, false);
        expect(recorder.frameCount).toBe(2);
        expect(recorder.overflowed).toBe(true);
        expect(recorder.getPayload()).toBe(null);
    });

    it('overflows immediately when the frame cap is zero', () => {
        const recorder = new ReplayRecorder(0);

        recorder.record(true, false, false);

        expect(recorder.frameCount).toBe(0);
        expect(recorder.overflowed).toBe(true);
        expect(recorder.getPayload()).toBe(null);
    });

    it('clears recorded frames and overflow so a new race can start clean', () => {
        const recorder = new ReplayRecorder(1);

        recorder.record(true, false, false);
        recorder.record(false, true, false);
        expect(recorder.overflowed).toBe(true);
        expect(recorder.getPayload()).toBe(null);

        recorder.reset();

        expect(recorder.frameCount).toBe(0);
        expect(recorder.overflowed).toBe(false);
        expect(recorder.getPayload()).toBe(null);

        recorder.record(false, true, true);
        expect(recorder.frameCount).toBe(1);
        expect(recorder.overflowed).toBe(false);
        expect(recorder.getPayload(2)).toEqual({
            targetLapNumber: 2,
            inputs: [{ frames: 1, left: false, right: true, relaunchDelay: true }],
        });
    });
});
