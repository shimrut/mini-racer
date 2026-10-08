import { describe, expect, it } from 'vitest';
import { validateDailyGpReplayDetailed } from '../src/server/competition/replay-validator.ts';
import { TRACKS } from '../game/track/tracks.js';
import { driveAutopilot } from './helpers/autopilot.js';

// Pinned before grounds existed; tarmac must keep these exact values or saved replays drive differently.
const GOLDEN_RUNS = [
    {
        trackKey: 'circuit', laps: 1, lapTime: 6.468003737943669, frames: 389, wallImpacts: 1,
        x: 10.225206480327078, y: 3.4984042180843193, angle: 6.41812260014063,
    },
    {
        trackKey: 'kettleRun', laps: 1, lapTime: 16.264224038459226, frames: 976, wallImpacts: 2,
        x: 24.125285208235105, y: 15.132332952744026, angle: 5.871830710213495,
    },
    {
        trackKey: 'carbonBend', laps: 1, lapTime: 9.362160664678404, frames: 562, wallImpacts: 8,
        x: 14.001027125361297, y: 21.237318042073078, angle: 3.1240205607136184,
    },
    {
        trackKey: 'alloyRing', laps: 1, lapTime: 14.85572262563468, frames: 892, wallImpacts: 1,
        x: 11.160603781336588, y: 14.327170491441711, angle: -4.350687176444697,
    },
    {
        trackKey: 'blueSector', laps: 1, lapTime: 13.480143851257877, frames: 809, wallImpacts: 0,
        x: 35.69570621088032, y: 7.514853397240245, angle: 18.427551161246733,
    },
    {
        trackKey: 'circuit', laps: 3, lapTime: 18.508889010248502, frames: 1111, wallImpacts: 6,
        x: 10.130654734692838, y: 3.753080690424951, angle: 18.901693648391326,
    },
    {
        trackKey: 'cedarRidgeCircuit', laps: 2, lapTime: 25.171176066525337, frames: 1511, wallImpacts: 4,
        x: 39.07996500405925, y: 7.097043819878677, angle: 12.584625520985462,
    },
];

function createChallenge(trackKey, laps) {
    return {
        id: `golden-${trackKey}-${laps}`,
        challengeDate: '2026-09-24',
        trackKey,
        startsAt: '2026-09-24T00:00:00.000Z',
        endsAt: '2026-09-25T00:00:00.000Z',
        availableUntil: '2026-10-01T00:00:00.000Z',
        status: 'active',
        rulesRevision: 1,
        objectiveType: laps > 1 ? 'multi_lap_total' : 'single_lap_fastest',
        objectiveParams: { lapCount: laps },
        skin: 'default',
    };
}

describe('tarmac golden times', () => {
    it.each(GOLDEN_RUNS)('keeps $trackKey over $laps lap(s) exact', (golden) => {
        const run = driveAutopilot(TRACKS[golden.trackKey], { laps: golden.laps });

        expect(run.winData?.lapTime).toBe(golden.lapTime);
        expect(run.frames).toBe(golden.frames);
        expect(run.wallImpacts).toBe(golden.wallImpacts);
        expect(run.state.pos.x).toBe(golden.x);
        expect(run.state.pos.y).toBe(golden.y);
        expect(run.state.angle).toBe(golden.angle);
    });

    it.each(GOLDEN_RUNS)('gets the same $trackKey time from the server replay check', (golden) => {
        const run = driveAutopilot(TRACKS[golden.trackKey], { laps: golden.laps });
        const outcome = validateDailyGpReplayDetailed({
            challenge: createChallenge(golden.trackKey, golden.laps),
            replay: run.replay,
        });

        expect(outcome.ok).toBe(true);
        expect(outcome.run.bestTimeSec).toBe(golden.lapTime);
        expect(outcome.run.completedLaps).toBe(golden.laps);
    });
});
