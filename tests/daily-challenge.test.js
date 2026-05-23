import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    formatDailyChallengeBestLabel,
    formatDailyChallengeResultLabel,
    getActiveDailyChallenge,
    getDailyChallengeCopyLabels,
    getDailyChallengeModeSelectObjectiveLine,
    getDailyChallengeModifierBadges,
    getDailyChallengeModifierLabel,
    getDailyChallengeMaxCrashes,
    getDailyChallengeObjectiveLabel,
    getDailyChallengeRequiredLaps,
    getDailyChallengeSnapshot,
    getDailyChallengeTrackName,
    isCrashBudgetDailyChallenge,
    submitDailyChallengeBestTime
} from '../game/daily-challenge/service.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const MINIMAL_REPLAY = { inputs: [] };

function createJsonResponse(body, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        json: async () => body
    };
}

function createMemoryLocalStorage() {
    const data = new Map();
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => {
            data.set(k, v);
        },
        removeItem: (k) => {
            data.delete(k);
        },
        _clear: () => data.clear()
    };
}

describe('daily-challenge service', () => {
    let memoryLocalStorage;

    beforeEach(() => {
        memoryLocalStorage = createMemoryLocalStorage();
        globalThis.window = {
            localStorage: memoryLocalStorage
        };
        globalThis.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        memoryLocalStorage?._clear();
        delete globalThis.window;
        delete globalThis.fetch;
    });

    it('getDailyChallengeTrackName falls back for missing track', () => {
        expect(getDailyChallengeTrackName(null)).toBe('Unknown Track');
        expect(getDailyChallengeTrackName({ trackKey: 'nope' })).toBe('Unknown Track');
        expect(getDailyChallengeTrackName({ trackKey: 'circuit' })).toBeTruthy();
    });

    it('getDailyChallengeObjectiveLabel covers objective types', () => {
        expect(getDailyChallengeObjectiveLabel(null)).toBe('Daily Challenge');
        expect(
            getDailyChallengeObjectiveLabel({
                objectiveType: 'multi_lap_total',
                objectiveParams: { lapCount: 1 }
            })
        ).toBe('2 laps');
        expect(
            getDailyChallengeObjectiveLabel({
                objectiveType: 'finish_with_crash_budget',
                objectiveParams: { maxCrashes: 1 }
            })
        ).toBe('Most laps before 1 crash');
        expect(
            getDailyChallengeObjectiveLabel({ objectiveType: 'single_lap_fastest' })
        ).toBe('1 lap');
    });

    it('getDailyChallengeModeSelectObjectiveLine matches mode-select blurbs', () => {
        expect(getDailyChallengeModeSelectObjectiveLine(null)).toBe('Best lap time');
        expect(getDailyChallengeModeSelectObjectiveLine({ objectiveType: 'single_lap_fastest' })).toBe(
            'Best lap time'
        );
        expect(getDailyChallengeModeSelectObjectiveLine({ objectiveType: 'multi_lap_total' })).toBe(
            'Best race time'
        );
        expect(
            getDailyChallengeModeSelectObjectiveLine({
                objectiveType: 'finish_with_crash_budget',
                objectiveParams: { maxCrashes: 2 }
            })
        ).toBe('Most laps');
    });

    it('getDailyChallengeCopyLabels centralizes daily challenge metric copy', () => {
        expect(getDailyChallengeCopyLabels({ objectiveType: 'single_lap_fastest' })).toEqual({
            hudPrimaryLabel: 'LAP',
            primaryStatLabel: 'Lap Time',
            bestSummaryLabel: 'Best Lap',
            modeSelectLine: 'Best lap time'
        });
    });

    it('formatDailyChallengeResultLabel covers crash-budget and time-trial results', () => {
        expect(formatDailyChallengeResultLabel(null, null)).toBe('--');
        expect(
            formatDailyChallengeResultLabel(
                { objectiveType: 'finish_with_crash_budget' },
                { completedLaps: 1, bestTime: 42.25 }
            )
        ).toBe('1 lap');
        expect(
            formatDailyChallengeResultLabel(
                { objectiveType: 'single_lap_fastest' },
                { bestTime: 19.5 }
            )
        ).toBe('19.50s');
    });

    it('formatDailyChallengeBestLabel formats daily challenge best values for ui surfaces', () => {
        expect(formatDailyChallengeBestLabel('finish_with_crash_budget', 42.25, 1)).toBe('1 lap');
        expect(formatDailyChallengeBestLabel('single_lap_fastest', 19.5)).toBe('19.50s');
    });

    it('does not expose car tuning as daily challenge modifiers', () => {
        expect(getDailyChallengeModifierBadges(null)).toEqual([]);
        expect(getDailyChallengeModifierBadges({
            physicsOverrides: {
                accel: 58,
                brakePower: 90,
                maxSpeed: 320,
                turnRate: 5.75,
                grip: 2.5
            }
        })).toEqual([]);
        expect(getDailyChallengeModifierLabel({ physicsOverrides: { accel: 58 } })).toBe('');
    });

    it('submitDailyChallengeBestTime returns null without calling fetch when invalid', async () => {
        await expect(submitDailyChallengeBestTime({})).resolves.toBe(null);
        await expect(
            submitDailyChallengeBestTime({
                challengeId: VALID_UUID,
                bestTime: 1.5,
                replay: MINIMAL_REPLAY
            })
        ).resolves.toBe(null);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('submitDailyChallengeBestTime accepts configured time boundaries and handles non-json responses', async () => {
        fetch
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => {
                    throw new Error('not json');
                }
            })
            .mockResolvedValueOnce(createJsonResponse({ accepted: true }));

        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            bestTime: 2,
            replay: MINIMAL_REPLAY
        })).resolves.toEqual({
            ok: true,
            status: 200,
            body: null
        });
        expect(fetch.mock.calls[0][0]).toBe('/api/daily/submit');

        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            bestTime: 3600,
            replay: MINIMAL_REPLAY
        })).resolves.toMatchObject({
            ok: true,
            body: { accepted: true }
        });
    });

    it('getActiveDailyChallenge normalizes response', async () => {
        const endsAt = new Date(Date.now() + 3600_000).toISOString();
        fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                id: VALID_UUID,
                trackKey: 'circuit',
                challengeDate: '2026-04-14',
                startsAt: '2026-04-14T00:00:00.000Z',
                endsAt,
                status: 'active',
                objectiveType: 'multi_lap_total',
                objectiveParams: { lapCount: 2 },
                physicsOverrides: { accel: 31 },
                skin: 'space'
            })
        });

        const challenge = await getActiveDailyChallenge();
        expect(challenge.id).toBe(VALID_UUID);
        expect(challenge.trackKey).toBe('circuit');
        expect(challenge.objectiveType).toBe('multi_lap_total');
        expect(challenge.physicsOverrides).toBeUndefined();
    });

    it('getDailyChallengeSnapshot always fetches fresh leaderboard data', async () => {
        fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                topRows: [],
                nearbyRows: [],
                currentPlayerRow: null,
                totalCount: 3,
                objectiveType: 'single_lap_fastest',
                playerRank: 2,
                playerRankLabel: '2 / 3'
            })
        });

        const snap = await getDailyChallengeSnapshot({ challengeId: VALID_UUID });
        expect(snap.playerRank).toBe(2);
        expect(snap.playerRankLabel).toBe('2 / 3');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toContain('/api/daily/snapshot');
    });
});
