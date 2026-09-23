import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACK_KEY } from '../game/track/catalog.js';
import {
    getDailyChallengeCardStatus,
    getDailyChallengeSnapshotIdsToFetch,
    isCachedActiveChallengeStillCurrent,
    isDailyChallengeStoredResultForChallenge,
    normalizeDailyChallenge,
    resolveDailyPlaylistCacheExpiresAt,
    resolveMockDailyTrackKey,
    toCachedActiveChallenge,
} from '../game/daily-challenge/service.js';
import {
    formatDailyChallengeRemainingDuration,
    formatDailyChallengeResultLabel,
    formatDailyChallengeStatusDate,
    getDailyChallengeRequiredLaps,
} from '../game/daily-challenge/labels.js';
import {
    CONTACT_EPSILON,
    getCollisionCandidates,
    resolveWallScrape,
    suppressInwardContactMotion,
} from '../game/race/simulation.js';
import { CONFIG } from '../game/config.js';
import { KPH_PER_WORLD_UNIT } from '../game/car/handling.js';

describe('exported daily-challenge helpers — mutation kills', () => {
    it('toCachedActiveChallenge requires id + known track and coerces optional fields', () => {
        expect(toCachedActiveChallenge(null)).toBeNull();
        expect(toCachedActiveChallenge('x')).toBeNull();
        expect(toCachedActiveChallenge({ id: '', trackKey: DEFAULT_TRACK_KEY })).toBeNull();
        expect(toCachedActiveChallenge({ id: 'daily-gp-2026-07-01', trackKey: 'missing' })).toBeNull();

        expect(toCachedActiveChallenge({
            id: 'daily-gp-2026-07-01',
            trackKey: DEFAULT_TRACK_KEY,
            objectiveType: 7,
            endsAt: 12,
            availableUntil: false,
            skin: '   ',
        })).toEqual({
            id: 'daily-gp-2026-07-01',
            trackKey: DEFAULT_TRACK_KEY,
            rulesRevision: 0,
            objectiveType: 'single_lap_fastest',
            objectiveParams: { lapCount: 1 },
            endsAt: null,
            availableUntil: null,
            skin: 'default',
        });

        expect(toCachedActiveChallenge({
            id: 'daily-gp-2026-07-01',
            trackKey: DEFAULT_TRACK_KEY,
            objectiveType: 'single_lap_fastest',
            rulesRevision: 0,
            objectiveParams: { lapCount: 1 },
            endsAt: '2026-07-02T00:00:00.000Z',
            availableUntil: '2026-07-08T00:00:00.000Z',
            skin: '  neon  ',
        })).toEqual({
            id: 'daily-gp-2026-07-01',
            trackKey: DEFAULT_TRACK_KEY,
            rulesRevision: 0,
            objectiveType: 'single_lap_fastest',
            objectiveParams: { lapCount: 1 },
            endsAt: '2026-07-02T00:00:00.000Z',
            availableUntil: '2026-07-08T00:00:00.000Z',
            skin: 'neon',
        });
    });

    it('resolveMockDailyTrackKey prefers mockDaily track keys over mockTrack', () => {
        expect(resolveMockDailyTrackKey(null)).toBeNull();
        expect(resolveMockDailyTrackKey(new URLSearchParams('mockDaily=true'))).toBeNull();
        expect(resolveMockDailyTrackKey(new URLSearchParams(`mockDaily=${DEFAULT_TRACK_KEY}`)))
            .toBe(DEFAULT_TRACK_KEY);
        expect(resolveMockDailyTrackKey(new URLSearchParams('mockDaily=missing-track'))).toBeNull();
        expect(resolveMockDailyTrackKey(new URLSearchParams(`mockTrack=${DEFAULT_TRACK_KEY}`)))
            .toBe(DEFAULT_TRACK_KEY);
        expect(resolveMockDailyTrackKey(new URLSearchParams(
            `mockDaily=true&mockTrack=${DEFAULT_TRACK_KEY}`,
        ))).toBe(DEFAULT_TRACK_KEY);
    });

    it('normalizeDailyChallenge rejects incomplete payloads and keeps valid ones', () => {
        expect(normalizeDailyChallenge(null)).toBeNull();
        expect(normalizeDailyChallenge({ id: 'x' })).toBeNull();
        expect(normalizeDailyChallenge({
            id: 'daily-gp-2026-07-01',
            trackKey: DEFAULT_TRACK_KEY,
        })).toMatchObject({
            id: 'daily-gp-2026-07-01',
            trackKey: DEFAULT_TRACK_KEY,
            challengeDate: null,
            startsAt: null,
            endsAt: null,
            availableUntil: null,
        });
        expect(normalizeDailyChallenge({
            id: 'daily-gp-2026-07-01',
            trackKey: 'missing-track',
        })).toBeNull();
        expect(normalizeDailyChallenge({
            id: 'daily-gp-2026-07-01',
            trackKey: DEFAULT_TRACK_KEY,
            challengeDate: '',
            startsAt: '',
            endsAt: '',
            availableUntil: '',
            status: '',
            objectiveType: 'unknown',
            objectiveParams: null,
            skin: '   ',
        })).toEqual({
            id: 'daily-gp-2026-07-01',
            challengeDate: '',
            trackKey: DEFAULT_TRACK_KEY,
            startsAt: '',
            endsAt: '',
            availableUntil: '',
            status: '',
            rulesRevision: 0,
            objectiveType: 'single_lap_fastest',
            objectiveParams: { lapCount: 1 },
            skin: 'default',
        });
        const valid = normalizeDailyChallenge({
            id: 'daily-gp-2026-07-01',
            challengeDate: '2026-07-01',
            trackKey: DEFAULT_TRACK_KEY,
            startsAt: '2026-07-01T00:00:00.000Z',
            endsAt: '2026-07-02T00:00:00.000Z',
            availableUntil: '2026-07-08T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            objectiveParams: { requiredLaps: 1 },
            skin: 'default',
        });
        expect(valid?.id).toBe('daily-gp-2026-07-01');
        expect(valid?.trackKey).toBe(DEFAULT_TRACK_KEY);
        expect(valid?.objectiveParams).toEqual({ lapCount: 1 });
    });

    it('isCachedActiveChallengeStillCurrent requires a future endsAt string', () => {
        expect(isCachedActiveChallengeStillCurrent(null)).toBe(false);
        expect(isCachedActiveChallengeStillCurrent({ endsAt: 12 })).toBe(false);
        expect(isCachedActiveChallengeStillCurrent({ endsAt: '' })).toBe(false);
        expect(isCachedActiveChallengeStillCurrent({ endsAt: 'not-a-date' })).toBe(false);
        expect(isCachedActiveChallengeStillCurrent({
            endsAt: new Date(Date.now() - 60_000).toISOString(),
        })).toBe(false);
        expect(isCachedActiveChallengeStillCurrent({
            endsAt: new Date(Date.now() + 60_000).toISOString(),
        })).toBe(true);
    });

    it('getDailyChallengeRequiredLaps accepts only supported persisted lap counts', () => {
        expect(getDailyChallengeRequiredLaps(null)).toBe(1);
        expect(getDailyChallengeRequiredLaps({ objectiveType: 'single_lap_fastest' })).toBe(1);
        expect(getDailyChallengeRequiredLaps({ objectiveType: 'multi_lap_total' })).toBe(1);
        expect(getDailyChallengeRequiredLaps({
            objectiveType: 'multi_lap_total',
            objectiveParams: {},
        })).toBe(1);
        expect(getDailyChallengeRequiredLaps({
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 0 },
        })).toBe(1);
        expect(getDailyChallengeRequiredLaps({
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 1 },
        })).toBe(1);
        expect(getDailyChallengeRequiredLaps({
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 3.9 },
        })).toBe(1);
        expect(getDailyChallengeRequiredLaps({
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 5 },
        })).toBe(1);
    });

    it('formatDailyChallengeRemainingDuration uses compact time labels', () => {
        expect(formatDailyChallengeRemainingDuration(0)).toBe('');
        expect(formatDailyChallengeRemainingDuration(-1)).toBe('');
        expect(formatDailyChallengeRemainingDuration(NaN)).toBe('');
        expect(formatDailyChallengeRemainingDuration(1)).toBe('1m');
        expect(formatDailyChallengeRemainingDuration(59_999)).toBe('1m');
        expect(formatDailyChallengeRemainingDuration(60_000)).toBe('1m');
        expect(formatDailyChallengeRemainingDuration(3_599_999)).toBe('1h');
        expect(formatDailyChallengeRemainingDuration(3_600_000)).toBe('1h');
        expect(formatDailyChallengeRemainingDuration(3_600_000 + 120_000)).toBe('1h 2m');
        expect(formatDailyChallengeRemainingDuration(23 * 3_600_000)).toBe('23h');
        expect(formatDailyChallengeRemainingDuration(86_400_000)).toBe('1d');
        expect(formatDailyChallengeRemainingDuration(86_400_000 + 3_600_000)).toBe('1d 1h');
    });

    it('formatDailyChallengeStatusDate returns empty for invalid inputs', () => {
        expect(formatDailyChallengeStatusDate(null)).toBe('');
        expect(formatDailyChallengeStatusDate('')).toBe('');
        expect(formatDailyChallengeStatusDate('not-a-date')).toBe('');
        expect(formatDailyChallengeStatusDate('2026-07-01T12:00:00.000Z')).toMatch(/Jul|2026|1/);
    });

    it('resolveDailyPlaylistCacheExpiresAt picks the next known change or next UTC day', () => {
        const nowMs = Date.parse('2026-07-01T12:00:00.000Z');
        const challenges = [{
            startsAt: '2026-07-01T00:00:00.000Z',
            endsAt: '2026-07-02T00:00:00.000Z',
            availableUntil: '2026-07-08T00:00:00.000Z',
        }];
        expect(resolveDailyPlaylistCacheExpiresAt(challenges, nowMs))
            .toBe(Date.parse('2026-07-02T00:00:00.000Z'));
        expect(resolveDailyPlaylistCacheExpiresAt([], nowMs))
            .toBe(Date.parse('2026-07-02T00:00:00.000Z'));
    });

    it('isDailyChallengeStoredResultForChallenge rejects mismatched track and objective metadata', () => {
        const challenge = {
            trackKey: DEFAULT_TRACK_KEY,
            objectiveType: 'single_lap_fastest',
        };
        expect(isDailyChallengeStoredResultForChallenge(null, { bestTime: 12 })).toBe(false);
        expect(isDailyChallengeStoredResultForChallenge(challenge, null)).toBe(false);
        expect(isDailyChallengeStoredResultForChallenge(challenge, { bestTime: 'fast' })).toBe(false);
        expect(isDailyChallengeStoredResultForChallenge(challenge, { bestTime: 12.3 })).toBe(true);
        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 12.3,
            trackKey: 'other-track',
        })).toBe(false);
        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 12.3,
            trackKey: '',
        })).toBe(true);
        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 12.3,
            objectiveType: 'multi_lap_total',
        })).toBe(false);
    });

    it('formatDailyChallengeResultLabel returns dashes for missing or non-finite results', () => {
        expect(formatDailyChallengeResultLabel(null)).toBe('--');
        expect(formatDailyChallengeResultLabel({ bestTime: 'x' })).toBe('--');
        expect(formatDailyChallengeResultLabel({ bestTime: 12.345 })).toBe('12.345s');
    });

    it('getDailyChallengeCardStatus switches between featured, available, and expired labels', () => {
        const nowMs = Date.parse('2026-07-01T12:00:00.000Z');
        const featured = getDailyChallengeCardStatus({
            endsAt: '2026-07-02T00:00:00.000Z',
            availableUntil: '2026-07-08T00:00:00.000Z',
        }, nowMs);
        expect(featured).toEqual({ key: 'featured', label: 'Featured' });

        const expiresSoon = getDailyChallengeCardStatus({
            endsAt: '2026-07-01T00:00:00.000Z',
            availableUntil: '2026-07-01T18:00:00.000Z',
        }, nowMs);
        expect(expiresSoon.key).toBe('available');
        expect(expiresSoon.label).toMatch(/^Expires in /);

        const expiresLater = getDailyChallengeCardStatus({
            endsAt: '2026-07-01T00:00:00.000Z',
            availableUntil: '2026-07-08T00:00:00.000Z',
        }, nowMs);
        expect(expiresLater.key).toBe('available');
        expect(expiresLater.label).toMatch(/^Expires on /);

        const expired = getDailyChallengeCardStatus({
            endsAt: '2026-06-30T00:00:00.000Z',
            availableUntil: '2026-06-30T12:00:00.000Z',
        }, nowMs);
        expect(expired).toEqual({ key: 'expired', label: 'Expired' });
    });

    it('getDailyChallengeSnapshotIdsToFetch filters non-strings and empty ids', () => {
        expect(getDailyChallengeSnapshotIdsToFetch(['a', '', 1, null, 'b'])).toEqual(['a', 'b']);
        expect(getDailyChallengeSnapshotIdsToFetch(['a', 'a'])).toEqual(['a']);
    });
});

describe('exported simulation helpers — scrape and collision hash', () => {
    it('resolveWallScrape returns null when inwardSpeed is not positive', () => {
        const state = {
            velocity: { x: 5, y: 0 },
            angularVelocity: 0,
            cachedSpeed: 5,
            wallImpactCooldownRemaining: 0,
        };
        expect(resolveWallScrape(state, {
            inwardSpeed: 0,
            penetration: 0.2,
            normal: { x: -1, y: 0 },
            bodyOffset: { x: 0, y: 0 },
        }, CONFIG)).toBeNull();
        expect(resolveWallScrape(state, {
            inwardSpeed: -1,
            penetration: 0.2,
            normal: { x: -1, y: 0 },
            bodyOffset: { x: 0, y: 0 },
        }, CONFIG)).toBeNull();
    });

    it('resolveWallScrape computes severity from weighted speed and depth', () => {
        const state = {
            velocity: { x: 10, y: 0 },
            angularVelocity: 0,
            cachedSpeed: 10,
            wallImpactCooldownRemaining: 0,
        };
        const contact = {
            inwardSpeed: 10,
            penetration: 0.2,
            normal: { x: -1, y: 0 },
            bodyOffset: { x: 0, y: 0 },
        };
        const config = {
            ...CONFIG,
            carRadius: 0.4,
            wallScrapeReferenceImpactKph: 150,
            wallScrapeSpeedSeverityWeight: 0.8,
            wallScrapeDepthSeverityWeight: 0.2,
            wallScrapeMaxTangentialRetention: 0.85,
            wallScrapeMinTangentialRetention: 0.35,
            wallScrapeMinBounce: 0.05,
            wallScrapeMaxBounce: 0.15,
            wallImpactCooldownSec: 0.12,
        };
        const scrape = resolveWallScrape(state, contact, config);
        const impactKph = 10 * KPH_PER_WORLD_UNIT;
        const speedSeverity = Math.min(1, Math.max(0, impactKph / 150));
        const depthSeverity = Math.min(1, Math.max(0, 0.2 / 0.4));
        const expected = Math.min(1, Math.max(0,
            (speedSeverity * 0.8 + depthSeverity * 0.2) / 1,
        ));
        expect(scrape.impactKph).toBeCloseTo(impactKph, 10);
        expect(scrape.severity).toBeCloseTo(expected, 10);
        expect(state.wallImpactCooldownRemaining).toBeCloseTo(0.12, 10);
        expect(state.velocity.x).toBeLessThan(10);
    });

    it('suppressInwardContactMotion clears only inward velocity and angular components', () => {
        const state = {
            velocity: { x: -4, y: 2 },
            angularVelocity: -3,
            cachedSpeed: 0,
        };
        suppressInwardContactMotion(state, [{
            normal: { x: 1, y: 0 },
            bodyOffset: { x: 0, y: 1 },
        }]);
        expect(state.velocity.x).toBeGreaterThanOrEqual(0);
        const spinning = {
            velocity: { x: 0, y: 0 },
            angularVelocity: 2,
            cachedSpeed: 0,
        };
        suppressInwardContactMotion(spinning, [{
            normal: { x: 1, y: 0 },
            bodyOffset: { x: 0, y: 1 },
        }]);
        expect(spinning.angularVelocity).toBe(0);
    });

    it('getCollisionCandidates returns arrays as-is and empty for missing data', () => {
        const segments = [{ id: 1 }];
        expect(getCollisionCandidates({ x: 0, y: 0 }, { x: 1, y: 0 }, null, 1)).toEqual([]);
        expect(getCollisionCandidates({ x: 0, y: 0 }, { x: 1, y: 0 }, segments, 1)).toBe(segments);
        expect(getCollisionCandidates({ x: 0, y: 0 }, { x: 1, y: 0 }, { cells: null, segments }, 1)).toEqual([]);
    });

    it('getCollisionCandidates queries hash cells with extent padding', () => {
        const segment = { queryStamp: 0 };
        const collisionData = {
            cellSize: 2,
            cells: new Map([['0,0', [segment]]]),
            segments: [segment],
            candidateSegments: [],
            queryStamp: 0,
        };
        const result = getCollisionCandidates(
            { x: 0.5, y: 0.5 },
            { x: 0.6, y: 0.5 },
            collisionData,
            0.25,
        );
        expect(result).toContain(segment);
        expect(collisionData.queryStamp).toBe(1);
        expect(segment.queryStamp).toBe(1);
        expect(CONTACT_EPSILON).toBeGreaterThan(0);
    });
});
