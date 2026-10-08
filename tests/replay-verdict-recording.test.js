import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateDailyGpReplayDetailed } from '../src/server/competition/replay-validator.ts';
import { TRACKS } from '../game/track/tracks.js';
import { driveAutopilot } from './helpers/autopilot.js';

// Records the server's full verdict for accepted and rejected tarmac runs; race or replay code changes must keep it.
// To record again on purpose, run this file with -u and read the diff first.

function challengeFor(trackKey, laps) {
    return {
        id: `recorded-${trackKey}-${laps}`,
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

function fingerprint(value) {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

// The answer with the ghost as a fingerprint, so the recording stays short.
function verdict(trackKey, laps, replay) {
    const outcome = validateDailyGpReplayDetailed({ challenge: challengeFor(trackKey, laps), replay });
    if (!outcome.ok) return outcome;
    const { ghost, ...run } = outcome.run;
    return { ok: true, run: { ...run, ghost: ghost ? fingerprint(ghost) : null } };
}

function withInputs(replay, change) {
    return { ...replay, inputs: change(replay.inputs.map((segment) => ({ ...segment }))) };
}

const RUNS = [
    ['circuit', 1],
    ['circuit', 3],
    ['alloyRing', 1],
    ['carbonBend', 1],
];

describe('replay verdict recordings', () => {
    for (const [trackKey, laps] of RUNS) {
        it(`${trackKey} over ${laps} lap(s): the finished run`, () => {
            const run = driveAutopilot(TRACKS[trackKey], { laps });
            expect(verdict(trackKey, laps, run.replay)).toMatchSnapshot();
        });
    }

    it('circuit: the runs it rejects, and input after the finish', () => {
        const { replay } = driveAutopilot(TRACKS.circuit, { laps: 1 });
        const answers = {
            'another rules revision': verdict('circuit', 1, { ...replay, rulesRevision: 0 }),
            'another lap count': verdict('circuit', 1, { ...replay, targetLapNumber: 2 }),
            'no inputs': verdict('circuit', 1, { ...replay, inputs: [] }),
            'stops before the finish': verdict('circuit', 1, withInputs(replay, (inputs) => inputs.slice(0, -3))),
            'input after the finish is ignored': verdict('circuit', 1, withInputs(replay, (inputs) => [
                ...inputs,
                { frames: 30, left: false, right: false, relaunchDelay: false },
            ])),
            'too long for one lap': verdict('circuit', 1, withInputs(replay, (inputs) => [
                { frames: 5000, left: false, right: false, relaunchDelay: false },
                ...inputs,
            ])),
            'a broken segment': verdict('circuit', 1, withInputs(replay, (inputs) => [
                { frames: -1, left: false, right: false },
                ...inputs,
            ])),
            'an unknown track': validateDailyGpReplayDetailed({
                challenge: challengeFor('noSuchTrack', 1),
                replay,
            }),
        };
        expect(answers).toMatchSnapshot();
    });

    it('circuit: a changed steering input gives another answer', () => {
        const { replay } = driveAutopilot(TRACKS.circuit, { laps: 1 });
        const changed = withInputs(replay, (inputs) => {
            const index = Math.floor(inputs.length / 2);
            inputs[index] = { ...inputs[index], left: !inputs[index].left, right: !inputs[index].right };
            return inputs;
        });
        expect(verdict('circuit', 1, changed)).toMatchSnapshot();
    });
});
