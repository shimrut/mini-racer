import { describe, expect, it } from 'vitest';
import { permanentRaceChallenge } from '../game/race/race-spec.js';

const FOREVER = {
    startsAt: '1970-01-01T00:00:00.000Z',
    endsAt: '9999-12-31T23:59:59.999Z',
    availableUntil: '9999-12-31T23:59:59.999Z',
    status: 'active',
    skin: 'default',
};

describe('permanent race challenge', () => {
    it('makes a Campaign stage a challenge that never ends', () => {
        expect(permanentRaceChallenge({
            raceId: 'numbered-v1-03',
            trackKey: 'numberThree',
            lapCount: 2,
            rulesRevision: 4,
        }, { mode: 'campaign', fallbackDate: 'Campaign' })).toEqual({
            ...FOREVER,
            id: 'numbered-v1-03',
            challengeDate: 'Campaign',
            trackKey: 'numberThree',
            rulesRevision: 4,
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 2 },
            mode: 'campaign',
        });
    });

    it('keeps the date of a Head to Head race from a Daily', () => {
        expect(permanentRaceChallenge({
            raceId: 'daily-gp-2026-07-23',
            challengeDate: 'daily-gp-2026-07-23',
            trackKey: 'circuit',
            lapCount: 1,
            rulesRevision: 1,
        }, { mode: 'challenge', fallbackDate: 'Head to Head' })).toEqual({
            ...FOREVER,
            id: 'daily-gp-2026-07-23',
            challengeDate: 'daily-gp-2026-07-23',
            trackKey: 'circuit',
            rulesRevision: 1,
            objectiveType: 'single_lap_fastest',
            objectiveParams: { lapCount: 1 },
            mode: 'challenge',
        });
    });

    it('uses the fallback date only for a missing or empty date', () => {
        const options = { mode: 'challenge', fallbackDate: 'Head to Head' };
        expect(permanentRaceChallenge({ raceId: 'a', lapCount: 3 }, options).challengeDate).toBe('Head to Head');
        expect(permanentRaceChallenge({ raceId: 'a', lapCount: 3, challengeDate: '' }, options).challengeDate)
            .toBe('Head to Head');
        expect(permanentRaceChallenge({ raceId: 'a', lapCount: 3, challengeDate: 'Campaign' }, options).challengeDate)
            .toBe('Campaign');
    });

    it('gives each call its own lap settings', () => {
        const stage = { raceId: 'a', trackKey: 'circuit', lapCount: 3, rulesRevision: 2 };
        const first = permanentRaceChallenge(stage, { mode: 'campaign', fallbackDate: 'Campaign' });
        const second = permanentRaceChallenge(stage, { mode: 'campaign', fallbackDate: 'Campaign' });
        expect(first.objectiveType).toBe('multi_lap_total');
        expect(first.objectiveParams).toEqual({ lapCount: 3 });
        expect(first.objectiveParams).not.toBe(second.objectiveParams);
        expect(first).not.toBe(second);
    });
});
