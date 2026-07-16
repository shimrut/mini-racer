import { describe, expect, it } from 'vitest';
import {
    hasTrack,
    TRACK_CATALOG,
    TRACK_SCHEDULE_KEYS,
} from '../game/track/catalog.js';
import { PUBLISHED_DAILY_GP_TRACKS_BY_DATE } from '../game/shared/daily-gp-history-backfill.js';
import { getBackfilledDailyGpChallenge } from '../src/server/daily-gp-history-backfill.ts';
import {
    buildDailyGpChallengeForDayIndexWithTrack,
    createDailyChallengeId,
    createRedisChallengeEntryHashKey,
    createRedisChallengeLeaderboardKey,
    DAY_MS,
    DAILY_GP_PLAYLIST_DAYS,
    formatRankLabel,
    getUtcDayIndex,
    isValidDailyGpTime,
    toBestTimeMs,
} from '../src/server/daily-gp-model.ts';

describe('reddit daily gp model', () => {
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
        expect(challenge.objectiveType).toBe('single_lap_fastest');
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

    it('rebuilds challenge IDs through the current generation model', () => {
        const challenge = getBackfilledDailyGpChallenge('daily-gp-2026-06-02');

        expect(challenge).toEqual(buildDailyGpChallengeForDayIndexWithTrack(
            getUtcDayIndex(new Date('2026-06-02T00:00:00.000Z')),
            'albertGardens',
        ));
    });

    it('uses every playable track key as the generation pool', () => {
        const scheduledTrackKeys = Object.values(PUBLISHED_DAILY_GP_TRACKS_BY_DATE);
        const pool = TRACK_SCHEDULE_KEYS;

        expect(scheduledTrackKeys.every((key) => pool.includes(key))).toBe(true);
    });

    it('uses explicit catalog order for future Daily GP generation', () => {
        expect(TRACK_SCHEDULE_KEYS).toEqual(Object.keys(TRACK_CATALOG));
    });

    it('keeps day indexing stable within the same UTC day', () => {
        const morning = new Date('2026-05-06T01:00:00.000Z');
        const evening = new Date('2026-05-06T23:59:59.000Z');

        expect(getUtcDayIndex(morning)).toBe(getUtcDayIndex(evening));
        expect(buildDailyGpChallengeForDayIndexWithTrack(getUtcDayIndex(morning), 'circuit')).toEqual(
            buildDailyGpChallengeForDayIndexWithTrack(getUtcDayIndex(evening), 'circuit'),
        );
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
        expect(formatRankLabel(null)).toBe(null);
        expect(isValidDailyGpTime(2)).toBe(true);
        expect(isValidDailyGpTime(7200)).toBe(false);
        expect(toBestTimeMs(12.345)).toBe(12345);
    });
});
