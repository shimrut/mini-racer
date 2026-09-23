import { describe, expect, it, vi } from 'vitest';
import {
    objectiveTypeForLapCount,
    normalizeRaceSpec,
    RACE_MEDAL_SCALE_LINEAR_V1,
    RACE_SCORING_TOTAL_TIME,
} from '../game/race/race-spec.js';
import {
    createRedisChallengeEntryHashKey,
    createRedisChallengeLeaderboardKey,
} from '../src/server/daily/daily-gp-model.ts';

vi.mock('@devvit/redis', () => ({
    redis: {},
    redisCompressed: {},
}));

const {
    CAMPAIGN_GUEST_TTL_SECONDS,
    createSharedStandingsCacheKey,
    toCampaignCompetition,
    toDailyCompetition,
} = await import('../src/server/competition/competition.ts');

function dailyChallenge(overrides = {}) {
    return {
        id: 'daily-gp-2026-07-29',
        challengeDate: '2026-07-29',
        trackKey: 'sunlitTemple',
        startsAt: '2026-07-29T00:00:00.000Z',
        endsAt: '2026-07-30T00:00:00.000Z',
        availableUntil: '2026-08-05T00:00:00.000Z',
        status: 'active',
        rulesRevision: 1,
        objectiveType: 'single_lap_fastest',
        objectiveParams: { lapCount: 1 },
        skin: 'default',
        ...overrides,
    };
}

const campaignStage = {
    raceId: 'numbered-v1-03',
    trackKey: 'numberThree',
    lapCount: 2,
    rulesRevision: 1,
};

describe('objectiveTypeForLapCount', () => {
    it('maps one lap to the single-lap objective and everything else to multi-lap', () => {
        expect(objectiveTypeForLapCount(1)).toBe('single_lap_fastest');
        expect(objectiveTypeForLapCount(2)).toBe('multi_lap_total');
        expect(objectiveTypeForLapCount(3)).toBe('multi_lap_total');
    });

    it('is the objective a normalized race spec reports', () => {
        const spec = normalizeRaceSpec({
            raceId: 'numbered-v1-05',
            mode: 'campaign',
            trackKey: 'numberFive',
            lapCount: 2,
            scoring: RACE_SCORING_TOTAL_TIME,
            medalScale: RACE_MEDAL_SCALE_LINEAR_V1,
            rulesRevision: 1,
        });
        expect(spec.objectiveType).toBe('multi_lap_total');
    });
});

describe('toDailyCompetition', () => {
    it('addresses exactly the keys the live Daily builders produce', () => {
        const challenge = dailyChallenge();
        const competition = toDailyCompetition(challenge);

        expect(competition.leaderboardKey).toBe(
            createRedisChallengeLeaderboardKey(challenge.id),
        );
        expect(competition.entryHashKey).toBe(
            createRedisChallengeEntryHashKey(challenge.id),
        );
        expect(competition.pbHashKey).toBe(`dailygp:challenge-pbs:${challenge.id}`);
    });

    it('carries the challenge lap contract and allows guests', () => {
        const competition = toDailyCompetition(dailyChallenge({
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 3 },
        }));

        expect(competition.mode).toBe('daily');
        expect(competition.lapCount).toBe(3);
        expect(competition.objectiveType).toBe('multi_lap_total');
        expect(competition.allowGuests).toBe(true);
    });

    it('expires with the competition deadline rather than never', () => {
        const competition = toDailyCompetition(
            dailyChallenge(),
            new Date('2026-07-30T00:00:00.000Z'),
        );
        expect(competition.ttlSeconds).toBeGreaterThan(0);
    });
});

describe('toCampaignCompetition', () => {
    it('keeps the campaign key namespace', () => {
        const competition = toCampaignCompetition('numbered-v1', campaignStage);

        expect(competition.leaderboardKey).toBe('campaign:numbered-v1:leaderboard:numbered-v1-03');
        expect(competition.entryHashKey).toBe('campaign:numbered-v1:leaderboard:numbered-v1-03:entries');
        expect(competition.pbHashKey).toBe('campaign:numbered-v1:pbs:numbered-v1-03');
    });

    it('derives the objective from the stage lap count', () => {
        expect(toCampaignCompetition('numbered-v1', campaignStage).objectiveType)
            .toBe('multi_lap_total');
        expect(toCampaignCompetition('numbered-v1', { ...campaignStage, lapCount: 1 }).objectiveType)
            .toBe('single_lap_fastest');
    });

    it('never expires a signed-in player progression', () => {
        const competition = toCampaignCompetition('numbered-v1', campaignStage, {
            playerId: 'reddit:someone',
        });
        expect(competition.ttlSeconds).toBeNull();
    });

    it('keeps shared guest collections permanent and records one-year per-player retention', () => {
        const competition = toCampaignCompetition('numbered-v1', campaignStage, {
            playerId: 'guest:abc123',
        });
        expect(competition.ttlSeconds).toBeNull();
        expect(competition.guestExpiryKey).toBe('campaign:numbered-v1:guest-expiry');
        expect(competition.guestRetentionSeconds).toBe(CAMPAIGN_GUEST_TTL_SECONDS);
        expect(CAMPAIGN_GUEST_TTL_SECONDS).toBe(365 * 24 * 60 * 60);
    });
});

describe('shared standings cache keys', () => {
    it('separates Daily and Campaign pages by immutable race contract and revision', () => {
        const daily = toDailyCompetition(dailyChallenge());
        const campaign = toCampaignCompetition('numbered-v1', campaignStage);

        expect(createSharedStandingsCacheKey(daily, 0, 50, 3)).toBe(
            'mini-racer:standings-page:v1:daily:daily-gp-2026-07-29:sunlitTemple:laps-1:rules-1:offset-0:limit-50:revision-3',
        );
        expect(createSharedStandingsCacheKey(campaign, 0, 50, 3)).not.toBe(
            createSharedStandingsCacheKey(daily, 0, 50, 3),
        );
        expect(createSharedStandingsCacheKey(daily, 50, 50, 3)).not.toBe(
            createSharedStandingsCacheKey(daily, 0, 50, 3),
        );
        expect(createSharedStandingsCacheKey(daily, 0, 50, 4)).not.toBe(
            createSharedStandingsCacheKey(daily, 0, 50, 3),
        );
    });
});
