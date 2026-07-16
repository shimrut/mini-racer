import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    getDailyChallengeData,
    saveDailyChallengeBestTime,
    setDailyChallengeBestTime,
    clearDailyChallengeBestTime,
    restoreDailyChallengeBestAfterFailedSubmission,
    rollbackDailyChallengeBestIfMatchesFailedSubmission
} from '../game/daily-challenge/storage.js';

const CHALLENGE_ID = '550e8400-e29b-41d4-a716-446655440000';

function installLocalStorage(seed = null) {
    const map = new Map();
    if (seed) {
        Object.entries(seed).forEach(([key, value]) => {
            map.set(key, value);
        });
    }
    globalThis.window = {
        localStorage: {
            getItem: (k) => (map.has(k) ? map.get(k) : null),
            setItem: (k, v) => {
                map.set(k, v);
            },
            removeItem: (k) => {
                map.delete(k);
            },
            _map: map
        }
    };
}

function readStoredChallengeMap() {
    return JSON.parse(globalThis.window.localStorage.getItem('VectorGpDailyChallengeData'));
}

describe('daily-challenge-storage', () => {
    beforeEach(() => {
        installLocalStorage();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.window;
    });

    it('returns null when no data for challenge', () => {
        expect(getDailyChallengeData(CHALLENGE_ID)).toBe(null);
        expect(getDailyChallengeData(null)).toBe(null);
    });

    it('ignores corrupt stored JSON and invalid saves', () => {
        delete globalThis.window;
        installLocalStorage({
            VectorGpDailyChallengeData: '{bad json'
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(getDailyChallengeData(CHALLENGE_ID)).toBe(null);
        expect(saveDailyChallengeBestTime({ id: CHALLENGE_ID }, Number.NaN)).toBe(null);
        expect(setDailyChallengeBestTime(null, 42)).toBe(null);

        expect(console.error).toHaveBeenCalledWith(
            'Error reading daily challenge storage:',
            expect.any(SyntaxError)
        );
    });

    it('treats empty and null storage payloads as empty maps without logging', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        delete globalThis.window;
        installLocalStorage({
            VectorGpDailyChallengeData: ''
        });

        expect(getDailyChallengeData(CHALLENGE_ID)).toBe(null);
        expect(consoleError).not.toHaveBeenCalled();

        globalThis.window.localStorage.setItem('VectorGpDailyChallengeData', 'null');
        const challenge = {
            id: CHALLENGE_ID,
            challengeDate: '2026-04-14',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        };

        expect(saveDailyChallengeBestTime(challenge, 42)).toMatchObject({
            bestTime: 42,
            completedLaps: null
        });
        expect(consoleError).not.toHaveBeenCalled();
    });

    it('treats scalar storage payloads as empty maps', () => {
        delete globalThis.window;
        installLocalStorage({
            VectorGpDailyChallengeData: JSON.stringify('not-a-map')
        });
        const challenge = {
            id: CHALLENGE_ID,
            challengeDate: '2026-04-14',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        };

        expect(saveDailyChallengeBestTime(challenge, 42)).toMatchObject({
            bestTime: 42,
            completedLaps: null
        });
        expect(Object.keys(getDailyChallengeData(CHALLENGE_ID))).not.toContain('0');
    });

    it('persists checkpoint split times with a stored personal best', () => {
        const challenge = {
            id: CHALLENGE_ID,
            challengeDate: '2026-04-14',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        };

        const saved = saveDailyChallengeBestTime(
            challenge,
            42.5,
            null,
            [10.2, 22.4, 35.1]
        );

        expect(saved.checkpointTimesSec).toEqual([10.2, 22.4, 35.1]);
        expect(getDailyChallengeData(CHALLENGE_ID).checkpointTimesSec).toEqual([
            10.2,
            22.4,
            35.1
        ]);
    });

    it('returns isolated copies and ignores non-object stored entries', () => {
        const stored = {
            [CHALLENGE_ID]: {
                challengeDate: '2026-04-14',
                trackKey: 'circuit',
                objectiveType: 'single_lap_fastest',
                bestTime: 44
            },
            invalid: 7
        };
        delete globalThis.window;
        installLocalStorage({
            VectorGpDailyChallengeData: JSON.stringify(stored)
        });

        const data = getDailyChallengeData(CHALLENGE_ID);
        data.bestTime = 10;

        expect(getDailyChallengeData(CHALLENGE_ID).bestTime).toBe(44);
        expect(getDailyChallengeData('invalid')).toBe(null);
    });

    it('does not use falsy challenge ids as storage keys', () => {
        delete globalThis.window;
        installLocalStorage({
            VectorGpDailyChallengeData: JSON.stringify({
                null: { bestTime: 10 },
                '': { bestTime: 11 }
            })
        });

        expect(getDailyChallengeData(null)).toBe(null);
        expect(getDailyChallengeData('')).toBe(null);
    });

    it('persists best time and keeps minimum', () => {
        const challenge = {
            id: CHALLENGE_ID,
            challengeDate: '2026-04-14',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        };
        saveDailyChallengeBestTime(challenge, 45.2);
        expect(getDailyChallengeData(CHALLENGE_ID).bestTime).toBe(45.2);

        saveDailyChallengeBestTime(challenge, 50);
        expect(getDailyChallengeData(CHALLENGE_ID).bestTime).toBe(45.2);

        saveDailyChallengeBestTime(challenge, 40);
        expect(getDailyChallengeData(CHALLENGE_ID).bestTime).toBe(40);
    });

    it('keeps existing non-crash lap metadata while improving time', () => {
        const challenge = {
            id: CHALLENGE_ID,
            challengeDate: '2026-04-14',
            trackKey: 'circuit',
            objectiveType: 'multi_lap_total'
        };

        setDailyChallengeBestTime(challenge, 60, 3);
        saveDailyChallengeBestTime(challenge, 55);

        expect(getDailyChallengeData(CHALLENGE_ID)).toMatchObject({
            bestTime: 55,
            completedLaps: 3
        });
    });

    it('preserves previous metadata when saving a challenge with partial details', () => {
        const fullChallenge = {
            id: CHALLENGE_ID,
            challengeDate: '2026-04-14',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        };

        saveDailyChallengeBestTime(fullChallenge, 45);
        saveDailyChallengeBestTime({ id: CHALLENGE_ID }, 44);

        expect(getDailyChallengeData(CHALLENGE_ID)).toMatchObject({
            challengeDate: '2026-04-14',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest',
            bestTime: 44
        });
    });

    it('prunes old entries when many challenges stored', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-20T00:00:00.000Z'));
        const base = {
            challengeDate: '2026-04-01',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        };
        for (let i = 0; i < 12; i++) {
            vi.setSystemTime(new Date(`2026-04-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`));
            const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
            saveDailyChallengeBestTime({ ...base, id }, 10 + i);
        }
        const raw = globalThis.window.localStorage.getItem('VectorGpDailyChallengeData');
        const parsed = JSON.parse(raw);
        expect(Object.keys(parsed).length).toBeLessThanOrEqual(7);
        expect(parsed['00000000-0000-4000-8000-000000000011']).toBeTruthy();
        expect(parsed['00000000-0000-4000-8000-000000000000']).toBeUndefined();
        vi.useRealTimers();
    });

    it('prunes by updatedAt first and challengeDate second when timestamps are mixed', () => {
        const seed = {};
        for (let i = 0; i < 7; i++) {
            seed[`old-${i}`] = {
                challengeDate: `2026-04-0${i + 1}`,
                bestTime: 50 + i
            };
        }
        seed.dateOnlyRecent = {
            challengeDate: '2026-04-20',
            bestTime: 20
        };
        seed.updatedRecent = {
            challengeDate: '2026-04-01',
            updatedAt: '2026-04-21T00:00:00.000Z',
            bestTime: 19
        };
        delete globalThis.window;
        installLocalStorage({
            VectorGpDailyChallengeData: JSON.stringify(seed)
        });

        saveDailyChallengeBestTime({
            id: CHALLENGE_ID,
            challengeDate: '2026-04-22',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        }, 18);

        const parsed = readStoredChallengeMap();
        expect(Object.keys(parsed)).toHaveLength(7);
        expect(parsed[CHALLENGE_ID]).toBeTruthy();
        expect(parsed.updatedRecent).toBeTruthy();
        expect(parsed.dateOnlyRecent).toBeTruthy();
        expect(parsed['old-0']).toBeUndefined();
    });

    it('prunes safely when stored entries are null or lack dates', () => {
        const seed = {
            nullEntry: null,
            undatedEntry: { bestTime: 90 },
            invalidDateEntry: { challengeDate: 'not-a-date', bestTime: 80 }
        };
        for (let i = 0; i < 6; i++) {
            seed[`dated-${i}`] = {
                challengeDate: `2026-04-${String(i + 1).padStart(2, '0')}`,
                bestTime: 60 + i
            };
        }
        delete globalThis.window;
        installLocalStorage({
            VectorGpDailyChallengeData: JSON.stringify(seed)
        });

        saveDailyChallengeBestTime({
            id: CHALLENGE_ID,
            challengeDate: '2026-04-20',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        }, 18);

        const parsed = readStoredChallengeMap();
        expect(Object.keys(parsed)).toHaveLength(7);
        expect(parsed[CHALLENGE_ID]).toBeTruthy();
        expect(parsed['dated-5']).toBeTruthy();
        expect(parsed.nullEntry).toBeUndefined();
        expect(parsed.undatedEntry).toBeUndefined();
        expect(parsed.invalidDateEntry).toBeUndefined();
    });

    it('does not reorder storage when updating exactly seven entries', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-30T00:00:00.000Z'));
        const seed = {};
        for (let i = 0; i < 7; i++) {
            seed[`entry-${i}`] = {
                challengeDate: `2026-04-${String(20 - i).padStart(2, '0')}`,
                bestTime: 50 + i
            };
        }
        delete globalThis.window;
        installLocalStorage({
            VectorGpDailyChallengeData: JSON.stringify(seed)
        });

        saveDailyChallengeBestTime({
            id: 'entry-3',
            challengeDate: '2026-04-17',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        }, 40);

        expect(Object.keys(readStoredChallengeMap())).toEqual([
            'entry-0',
            'entry-1',
            'entry-2',
            'entry-3',
            'entry-4',
            'entry-5',
            'entry-6'
        ]);
        vi.useRealTimers();
    });

    it('prunes safely when several stored entries are null', () => {
        const seed = {
            nullA: null,
            nullB: null,
            nullC: null,
            recentA: {
                challengeDate: '2026-04-20',
                bestTime: 20
            },
            recentB: {
                updatedAt: '2026-04-21T00:00:00.000Z',
                bestTime: 19
            },
            olderA: {
                challengeDate: '2026-04-01',
                bestTime: 80
            },
            olderB: {
                challengeDate: '2026-04-02',
                bestTime: 81
            }
        };
        delete globalThis.window;
        installLocalStorage({
            VectorGpDailyChallengeData: JSON.stringify(seed)
        });

        expect(() => saveDailyChallengeBestTime({
            id: CHALLENGE_ID,
            challengeDate: '2026-04-22',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        }, 18)).not.toThrow();

        const parsed = readStoredChallengeMap();
        expect(Object.keys(parsed)).toHaveLength(7);
        expect(parsed[CHALLENGE_ID]).toBeTruthy();
        expect(parsed.recentA).toBeTruthy();
        expect(parsed.recentB).toBeTruthy();
    });

    it('setDailyChallengeBestTime overwrites with canonical server values', () => {
        const challenge = {
            id: CHALLENGE_ID,
            challengeDate: '2026-04-14',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        };

        saveDailyChallengeBestTime(challenge, 45.2);
        expect(getDailyChallengeData(CHALLENGE_ID).bestTime).toBe(45.2);

        setDailyChallengeBestTime(challenge, 46.5);
        expect(getDailyChallengeData(CHALLENGE_ID)).toMatchObject({
            bestTime: 46.5,
            completedLaps: null
        });
    });

    it('setDailyChallengeBestTime preserves metadata from earlier partial saves and normalizes laps', () => {
        const challenge = {
            id: CHALLENGE_ID,
            challengeDate: '2026-04-14',
            trackKey: 'circuit',
            objectiveType: 'multi_lap_total'
        };

        saveDailyChallengeBestTime(challenge, 45, 3);
        setDailyChallengeBestTime({ id: CHALLENGE_ID }, 44, 2.8);

        expect(getDailyChallengeData(CHALLENGE_ID)).toMatchObject({
            challengeDate: '2026-04-14',
            trackKey: 'circuit',
            objectiveType: 'multi_lap_total',
            bestTime: 44,
            completedLaps: 2
        });
    });

    it('replaces malformed previous entries and logs write failures', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        delete globalThis.window;
        installLocalStorage({
            VectorGpDailyChallengeData: JSON.stringify({
                [CHALLENGE_ID]: 7
            })
        });

        const challenge = {
            id: CHALLENGE_ID,
            challengeDate: '2026-04-14',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        };

        expect(saveDailyChallengeBestTime(challenge, 42)).toMatchObject({
            bestTime: 42,
            completedLaps: null
        });

        globalThis.window.localStorage.setItem = () => {
            throw new Error('storage full');
        };
        expect(setDailyChallengeBestTime(challenge, 41)).toEqual({
            challengeDate: '2026-04-14',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest',
            bestTime: 42,
            completedLaps: null,
            checkpointTimesSec: null,
            updatedAt: expect.any(String)
        });
        expect(consoleError).toHaveBeenCalledWith(
            'Error writing daily challenge storage:',
            expect.any(Error)
        );
    });

    it('does not throw when localStorage is unavailable', () => {
        delete globalThis.window;
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const challenge = {
            id: CHALLENGE_ID,
            challengeDate: '2026-04-14',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        };

        expect(getDailyChallengeData(CHALLENGE_ID)).toBe(null);
        expect(saveDailyChallengeBestTime(challenge, 42)).toBe(null);
        expect(setDailyChallengeBestTime(challenge, 41)).toBe(null);
        expect(consoleError).not.toHaveBeenCalled();
    });

    it('rejects missing challenge objects before reading ids', () => {
        expect(saveDailyChallengeBestTime(null, 42)).toBe(null);
        expect(setDailyChallengeBestTime(undefined, 42)).toBe(null);
    });

    it('clears and restores local bests after failed submissions', () => {
        const challenge = {
            id: CHALLENGE_ID,
            challengeDate: '2026-04-14',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        };
        saveDailyChallengeBestTime(challenge, 12.5, 1, [4, 8, 12.5]);
        saveDailyChallengeBestTime(challenge, 10, 1, [3, 7, 10]);

        expect(rollbackDailyChallengeBestIfMatchesFailedSubmission(
            challenge,
            10,
            {
                bestTime: 12.5,
                completedLaps: 1,
                checkpointTimesSec: [4, 8, 12.5]
            }
        )).toMatchObject({
            bestTime: 12.5,
            completedLaps: 1
        });

        saveDailyChallengeBestTime(challenge, 9.5, 1);
        expect(rollbackDailyChallengeBestIfMatchesFailedSubmission(
            challenge,
            9.5,
            null
        )).toBe(null);
        expect(getDailyChallengeData(CHALLENGE_ID)).toBe(null);
        expect(clearDailyChallengeBestTime(CHALLENGE_ID)).toBe(null);
        expect(restoreDailyChallengeBestAfterFailedSubmission(challenge, {
            bestTime: 11,
            completedLaps: 2
        })).toMatchObject({
            bestTime: 11,
            completedLaps: 2
        });
    });

    it('does not copy string properties from malformed stored entries', () => {
        delete globalThis.window;
        installLocalStorage({
            VectorGpDailyChallengeData: JSON.stringify({
                [CHALLENGE_ID]: 'bad'
            })
        });
        const challenge = {
            id: CHALLENGE_ID,
            challengeDate: '2026-04-14',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        };

        saveDailyChallengeBestTime(challenge, 42);
        expect(Object.keys(getDailyChallengeData(CHALLENGE_ID))).not.toContain('0');

        delete globalThis.window;
        installLocalStorage({
            VectorGpDailyChallengeData: JSON.stringify({
                [CHALLENGE_ID]: 'bad'
            })
        });

        setDailyChallengeBestTime(challenge, 41);
        expect(Object.keys(getDailyChallengeData(CHALLENGE_ID))).not.toContain('0');
    });
});
