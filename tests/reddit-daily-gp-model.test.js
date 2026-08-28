import { describe, expect, it } from 'vitest';
import {
    hasTrack,
    TRACK_CATALOG,
    TRACK_SCHEDULE_KEYS,
} from '../game/track/catalog.js';
import { CAMPAIGN_STAGES } from '../game/campaign/manifest.js';
import { PUBLISHED_DAILY_GP_TRACKS_BY_DATE } from '../game/shared/daily-gp-history-backfill.js';
import { getBackfilledDailyGpChallenge } from '../src/server/daily-gp-history-backfill.ts';
import { CAMPAIGN_GUEST_TTL_SECONDS } from '../src/server/competition.ts';
import {
    buildDailyGpChallengeForDayIndexWithTrack,
    createDailyChallengeId,
    createRedisChallengeEntryHashKey,
    createRedisChallengeLeaderboardKey,
    DAY_MS,
    DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS,
    DAILY_GP_DEFAULT_LIMIT,
    DAILY_GP_GUEST_PROFILE_TTL_SECONDS,
    DAILY_GP_LEGACY_RULES_REVISION,
    DAILY_GP_MAX_TIME_SECONDS,
    DAILY_GP_MIN_TIME_SECONDS,
    DAILY_GP_NEARBY_RADIUS,
    DAILY_GP_PLAYLIST_DAYS,
    DAILY_GP_REDIS_TTL_SECONDS,
    DAILY_GP_SIGNED_IN_PROFILE_TTL_SECONDS,
    encodeDailyGpLeaderboardScore,
    formatRankLabel,
    getDailyGpCompetitionDeadlineMs,
    getDailyGpCompetitionTtlSeconds,
    getDailyGpEligibleLapCounts,
    getUtcDayIndex,
    isDailyGpChallengePlayable,
    isValidDailyGpTime,
    normalizeDailyGpRaceContract,
    selectDailyGpLapCount,
    toBestTimeMs,
} from '../src/server/daily-gp-model.ts';

describe('reddit daily gp model', () => {
    it('pins retention and window constants to exact second/ms budgets', () => {
        expect(DAY_MS).toBe(86_400_000);
        expect(DAILY_GP_MIN_TIME_SECONDS).toBe(2);
        expect(DAILY_GP_MAX_TIME_SECONDS).toBe(3_600);
        expect(DAILY_GP_NEARBY_RADIUS).toBe(2);
        expect(DAILY_GP_DEFAULT_LIMIT).toBe(10);
        expect(DAILY_GP_REDIS_TTL_SECONDS).toBe(3_888_000);
        expect(DAILY_GP_GUEST_PROFILE_TTL_SECONDS).toBe(7_776_000);
        expect(DAILY_GP_SIGNED_IN_PROFILE_TTL_SECONDS).toBe(null);
        expect(DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS).toBe(3_888_000);
        expect(DAILY_GP_PLAYLIST_DAYS).toBe(7);
    });

    it('keeps a profile alive at least as long as the data it names', () => {
        expect(DAILY_GP_GUEST_PROFILE_TTL_SECONDS)
            .toBeGreaterThanOrEqual(CAMPAIGN_GUEST_TTL_SECONDS);
        expect(DAILY_GP_SIGNED_IN_PROFILE_TTL_SECONDS).toBe(null);
    });

    it('builds a deterministic UTC-scoped challenge payload', () => {
        const date = new Date('2026-05-06T12:34:56.000Z');
        const challenge = buildDailyGpChallengeForDayIndexWithTrack(
            getUtcDayIndex(date),
            'circuit',
        );

        expect(challenge.id).toBe('daily-gp-2026-05-06');
        expect(challenge.challengeDate).toBe('2026-05-06');
        expect(challenge.startsAt).toBe('2026-05-06T00:00:00.000Z');
        expect(challenge.endsAt).toBe('2026-05-07T00:00:00.000Z');
        expect(challenge.availableUntil).toBe('2026-05-13T00:00:00.000Z');
        expect(challenge.status).toBe('active');
        expect(challenge.rulesRevision).toBe(1);
        expect(challenge.objectiveParams.lapCount).toBeGreaterThanOrEqual(1);
        expect(challenge.objectiveParams.lapCount).toBeLessThanOrEqual(2);
        expect(challenge.objectiveType).toBe(
            challenge.objectiveParams.lapCount === 1 ? 'single_lap_fastest' : 'multi_lap_total',
        );
        expect(challenge.trackKey).toBe('circuit');
        expect(challenge.physicsOverrides).toBeUndefined();
    });

    it('selects a new daily track without reusing the previous 30 days', () => {
        const scheduledTrackKeys = Object.values(PUBLISHED_DAILY_GP_TRACKS_BY_DATE);
        expect(new Set(scheduledTrackKeys).size).toBe(scheduledTrackKeys.length);
        for (const trackKey of scheduledTrackKeys) {
            expect(hasTrack(trackKey)).toBe(true);
        }
    });

    it('returns the playable 7-day playlist window', () => {
        const endDate = new Date('2026-06-11T12:00:00.000Z');
        const endIndex = getUtcDayIndex(endDate);
        const playlist = [];
        for (let offset = 0; offset < DAILY_GP_PLAYLIST_DAYS; offset += 1) {
            const dayStart = new Date((endIndex - offset) * DAY_MS);
            const challengeDate = dayStart.toISOString().slice(0, 10);
            const challenge = getBackfilledDailyGpChallenge(createDailyChallengeId(challengeDate));
            if (challenge) {
                playlist.push(challenge);
            }
        }

        expect(playlist).toHaveLength(7);
        expect(playlist[0].challengeDate).toBe('2026-06-11');
        expect(playlist[6].challengeDate).toBe('2026-06-05');
        expect(new Set(playlist.map((challenge) => challenge.trackKey)).size).toBe(7);
    });

    it('keeps history backfills on the legacy one-lap contract', () => {
        const challenge = getBackfilledDailyGpChallenge('daily-gp-2026-06-02');

        expect(challenge?.rulesRevision).toBe(DAILY_GP_LEGACY_RULES_REVISION);
        expect(challenge?.objectiveType).toBe('single_lap_fastest');
        expect(challenge?.objectiveParams).toEqual({ lapCount: 1 });
    });

    it('returns null for unknown or malformed backfill challenge ids', () => {
        expect(getBackfilledDailyGpChallenge('daily-gp-not-a-date')).toBeNull();
        expect(getBackfilledDailyGpChallenge('weekly-gp-2026-06-02')).toBeNull();
        expect(getBackfilledDailyGpChallenge('daily-gp-2099-01-01')).toBeNull();
    });

    it('uses every playable track key as the generation pool', () => {
        const scheduledTrackKeys = Object.values(PUBLISHED_DAILY_GP_TRACKS_BY_DATE);
        const pool = TRACK_SCHEDULE_KEYS;

        expect(scheduledTrackKeys.every((key) => pool.includes(key))).toBe(true);
    });

    it('uses an explicit Daily schedule drawn from the complete track catalog', () => {
        expect(TRACK_SCHEDULE_KEYS.every((trackKey) => (
            Object.hasOwn(TRACK_CATALOG, trackKey)
        ))).toBe(true);
        const campaignTrackKeys = CAMPAIGN_STAGES.map((stage) => stage.trackKey);
        expect(TRACK_SCHEDULE_KEYS.filter((trackKey) => (
            campaignTrackKeys.includes(trackKey)
        ))).toEqual([]);
    });

    it('keeps day indexing stable within the same UTC day', () => {
        const morning = new Date('2026-05-06T01:00:00.000Z');
        const evening = new Date('2026-05-06T23:59:59.000Z');

        expect(getUtcDayIndex(morning)).toBe(getUtcDayIndex(evening));
        expect(buildDailyGpChallengeForDayIndexWithTrack(getUtcDayIndex(morning), 'circuit')).toEqual(
            buildDailyGpChallengeForDayIndexWithTrack(getUtcDayIndex(evening), 'circuit'),
        );
    });

    it('selects one or two laps only for Daily tracks under 10s author time', () => {
        expect(getDailyGpEligibleLapCounts('circuit')).toEqual([1, 2]);
        expect(getDailyGpEligibleLapCounts('goldenMarsh')).toEqual([1, 2]);
        expect(getDailyGpEligibleLapCounts('speedAltar')).toEqual([1]);
        expect(getDailyGpEligibleLapCounts('moebiusStrip')).toEqual([1]);
        expect(getDailyGpEligibleLapCounts('cedarRidgeCircuit')).toEqual([1]);
        expect(getDailyGpEligibleLapCounts('not-a-track')).toEqual([1]);

        const challengeId = 'daily-gp-2026-05-06';
        expect(selectDailyGpLapCount(challengeId, 'circuit')).toBe(
            selectDailyGpLapCount(challengeId, 'circuit'),
        );
        const shortTrackOutcomes = new Set(
            Array.from({ length: 90 }, (_, day) => selectDailyGpLapCount(
                `daily-gp-2026-08-${String(day + 1).padStart(2, '0')}`,
                'circuit',
            )),
        );
        expect(shortTrackOutcomes).toEqual(new Set([1, 2]));
        const longTrackOutcomes = new Set(
            Array.from({ length: 90 }, (_, day) => selectDailyGpLapCount(
                `daily-gp-2026-08-${String(day + 1).padStart(2, '0')}`,
                'moebiusStrip',
            )),
        );
        expect(longTrackOutcomes).toEqual(new Set([1]));
    });

    it('keeps persisted three-lap contracts valid for historical Daily races', () => {
        expect(normalizeDailyGpRaceContract({
            rulesRevision: 1,
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 3 },
        })).toEqual({
            rulesRevision: 1,
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 3 },
        });
    });

    it('formats ids, redis keys, ranks, and submission times consistently', () => {
        expect(createDailyChallengeId('2026-05-06')).toBe('daily-gp-2026-05-06');
        expect(createRedisChallengeLeaderboardKey('daily-gp-2026-05-06')).toBe(
            'dailygp:leaderboard:daily-gp-2026-05-06'
        );
        expect(createRedisChallengeEntryHashKey('daily-gp-2026-05-06')).toBe(
            'dailygp:leaderboard:daily-gp-2026-05-06:entries'
        );
        expect(formatRankLabel(3)).toBe('#3');
        expect(formatRankLabel(3.9)).toBe('#3');
        expect(formatRankLabel(0)).toBe(null);
        expect(formatRankLabel(-1)).toBe(null);
        expect(formatRankLabel(null)).toBe(null);
        expect(formatRankLabel(undefined)).toBe(null);
        expect(formatRankLabel(Number.NaN)).toBe(null);
        expect(isValidDailyGpTime(2)).toBe(true);
        expect(isValidDailyGpTime(1.999)).toBe(false);
        expect(isValidDailyGpTime(3600)).toBe(true);
        expect(isValidDailyGpTime(3600.001)).toBe(false);
        expect(isValidDailyGpTime(7200)).toBe(false);
        expect(isValidDailyGpTime('12')).toBe(false);
        expect(toBestTimeMs(12.345)).toBe(12345);
    });

    it('marks challenges playable only inside the availability window', () => {
        const challenge = buildDailyGpChallengeForDayIndexWithTrack(
            getUtcDayIndex(new Date('2026-05-06T00:00:00.000Z')),
            'circuit',
        );
        expect(isDailyGpChallengePlayable(challenge, new Date('2026-05-05T23:59:59.999Z'))).toBe(false);
        expect(isDailyGpChallengePlayable(challenge, new Date('2026-05-06T00:00:00.000Z'))).toBe(true);
        expect(isDailyGpChallengePlayable(challenge, new Date('2026-05-12T23:59:59.999Z'))).toBe(true);
        expect(isDailyGpChallengePlayable(challenge, new Date('2026-05-13T00:00:00.000Z'))).toBe(false);
        expect(isDailyGpChallengePlayable({
            ...challenge,
            startsAt: 'bad',
            availableUntil: challenge.availableUntil,
        }, new Date('2026-05-07T00:00:00.000Z'))).toBe(false);
    });

    it('computes competition deadlines and remaining TTL seconds', () => {
        const challenge = buildDailyGpChallengeForDayIndexWithTrack(
            getUtcDayIndex(new Date('2026-05-06T00:00:00.000Z')),
            'circuit',
        );
        expect(getDailyGpCompetitionDeadlineMs(challenge)).toBe(
            Date.parse('2026-06-20T00:00:00.000Z'),
        );
        expect(getDailyGpCompetitionTtlSeconds(
            challenge,
            new Date('2026-06-19T23:59:01.000Z'),
        )).toBe(59);
        expect(getDailyGpCompetitionTtlSeconds(
            challenge,
            new Date('2026-06-20T00:00:00.000Z'),
        )).toBe(0);
        expect(getDailyGpCompetitionTtlSeconds(
            challenge,
            new Date('2026-06-21T00:00:00.000Z'),
        )).toBe(0);
        expect(getDailyGpCompetitionTtlSeconds({
            ...challenge,
            startsAt: 'bad',
        })).toBe(0);
        expect(getDailyGpCompetitionTtlSeconds(
            challenge,
            new Date('2026-05-06T00:00:00.000Z'),
        )).toBeGreaterThan(0);
        expect(encodeDailyGpLeaderboardScore(12345)).toBe(12345);
    });

    it('rejects invalid race times and unplayable challenge windows', () => {
        const challenge = buildDailyGpChallengeForDayIndexWithTrack(
            getUtcDayIndex(new Date('2026-05-06T00:00:00.000Z')),
            'circuit',
        );

        expect(isValidDailyGpTime(0)).toBe(false);
        expect(isValidDailyGpTime(-1)).toBe(false);
        expect(isValidDailyGpTime(Number.POSITIVE_INFINITY)).toBe(false);
        expect(isValidDailyGpTime(null)).toBe(false);
        expect(formatRankLabel(Number.POSITIVE_INFINITY)).toBe(null);

        expect(isDailyGpChallengePlayable({
            ...challenge,
            availableUntil: 'bad',
        }, new Date('2026-05-07T00:00:00.000Z'))).toBe(false);
        expect(isDailyGpChallengePlayable(challenge, new Date('2026-05-13T00:00:00.000Z')))
            .toBe(false);
        expect(getDailyGpCompetitionDeadlineMs({
            ...challenge,
            startsAt: 'not-a-date',
        })).toBeNaN();
    });
});
