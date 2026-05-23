import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearDailyChallengeVerification,
    clearScoreboardVerification,
    enqueueDailyChallengeVerification,
    enqueueScoreboardVerification,
    getDailyChallengeVerificationEntry,
    getDailyChallengeVerificationState,
    getDueDailyChallengeVerifications,
    getDueScoreboardVerifications,
    getNextVerificationAttemptAt,
    getScoreboardVerificationEntry,
    getScoreboardVerificationState,
    getVerificationRetryDelayMs,
    markDailyChallengeVerificationPending,
    markDailyChallengeVerificationRejected,
    markScoreboardVerificationPending,
    markScoreboardVerificationRejected,
    resetVerificationQueueForTests
} from '../game/scoreboard/verification-queue.js';

const STORAGE_KEY = 'VectorGpVerificationQueue';

function installLocalStorage(seed = null) {
    const map = new Map();
    if (seed) {
        Object.entries(seed).forEach(([key, value]) => {
            map.set(key, value);
        });
    }
    globalThis.window = {
        localStorage: {
            getItem: (key) => (map.has(key) ? map.get(key) : null),
            setItem: (key, value) => map.set(key, value),
            removeItem: (key) => map.delete(key),
            _map: map
        }
    };
}

function readStoredQueue() {
    return JSON.parse(globalThis.window.localStorage.getItem(STORAGE_KEY));
}

const REPLAY = { inputs: [{ frames: 1, left: false, right: false }] };

describe('verification queue', () => {
    beforeEach(() => {
        installLocalStorage();
        resetVerificationQueueForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.window;
    });

    it('exposes retry delay and safe empty states', () => {
        expect(getVerificationRetryDelayMs()).toBe(30_000);
        expect(getScoreboardVerificationEntry('')).toBe(null);
        expect(getScoreboardVerificationEntry('circuit', '')).toBe(null);
        expect(getDailyChallengeVerificationEntry('')).toBe(null);
        expect(getScoreboardVerificationState('missing')).toBe('none');
        expect(getDailyChallengeVerificationState('missing')).toBe('none');

        delete globalThis.window;

        expect(getScoreboardVerificationEntry('circuit')).toBe(null);
        expect(getDailyChallengeVerificationEntry('challenge-1')).toBe(null);
        expect(getDueScoreboardVerifications()).toEqual([]);
        expect(getDueDailyChallengeVerifications()).toEqual([]);
        expect(getNextVerificationAttemptAt()).toBe(null);
        expect(enqueueScoreboardVerification({
            trackKey: 'circuit',
            mode: 'daily',
            bestTime: 21.2,
            replay: REPLAY
        })).toMatchObject({ enqueued: true });
    });

    it('handles corrupt storage and write failures without throwing', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        delete globalThis.window;
        installLocalStorage({
            [STORAGE_KEY]: '{bad json'
        });

        expect(getScoreboardVerificationEntry('circuit')).toBe(null);
        expect(consoleError).toHaveBeenCalledWith('Error reading verification queue:', expect.any(Error));

        globalThis.window.localStorage.setItem = () => {
            throw new Error('storage full');
        };

        expect(enqueueScoreboardVerification({
            trackKey: 'circuit',
            mode: 'daily',
            bestTime: 21.2,
            replay: REPLAY
        })).toMatchObject({
            enqueued: true,
            entry: expect.objectContaining({ bestTime: 21.2 })
        });
        expect(consoleError).toHaveBeenCalledWith('Error writing verification queue:', expect.any(Error));
    });

    it('normalizes malformed stored queue sections and clones replay payloads', () => {
        delete globalThis.window;
        installLocalStorage({
            [STORAGE_KEY]: JSON.stringify({
                scoreboard: 7,
                daily: {
                    'challenge-1': {
                        challengeId: 'challenge-1',
                        bestTime: 42,
                        replay: { inputs: [{ frames: 1 }] },
                        verificationState: 'pending',
                        nextAttemptAt: 10
                    }
                }
            })
        });

        expect(getScoreboardVerificationEntry('circuit')).toBe(null);
        const dailyEntry = getDailyChallengeVerificationEntry('challenge-1');
        dailyEntry.replay.inputs[0].frames = 99;
        expect(getDailyChallengeVerificationEntry('challenge-1').replay.inputs[0].frames).toBe(1);

        enqueueScoreboardVerification({
            trackKey: 'circuit',
            mode: 'daily',
            bestTime: 20,
            replay: REPLAY
        });

        expect(readStoredQueue().daily['challenge-1']).toBeTruthy();
        expect(readStoredQueue().scoreboard['circuit::daily']).toBeTruthy();
    });

    it('keeps only the best scoreboard candidate per key', () => {
        expect(enqueueScoreboardVerification({
            trackKey: 'circuit',
            mode: 'daily',
            bestTime: 21.2,
            replay: REPLAY
        }).enqueued).toBe(true);

        expect(enqueueScoreboardVerification({
            trackKey: 'circuit',
            mode: 'daily',
            bestTime: 22.4,
            replay: REPLAY
        }).enqueued).toBe(false);

        expect(enqueueScoreboardVerification({
            trackKey: 'circuit',
            mode: 'daily',
            bestTime: 20.8,
            replay: REPLAY
        }).enqueued).toBe(true);

        expect(getScoreboardVerificationEntry('circuit')).toMatchObject({
            bestTime: 20.8,
            verificationState: 'pending'
        });
        expect(getScoreboardVerificationState('circuit')).toBe('pending');
    });

    it('rejects invalid scoreboard enqueue requests', () => {
        expect(enqueueScoreboardVerification()).toEqual({ enqueued: false, entry: null });
        expect(enqueueScoreboardVerification({
            trackKey: 42,
            mode: 'daily',
            bestTime: 21,
            replay: REPLAY
        })).toEqual({ enqueued: false, entry: null });
        expect(enqueueScoreboardVerification({
            trackKey: '',
            mode: 'daily',
            bestTime: 21,
            replay: REPLAY
        })).toEqual({ enqueued: false, entry: null });
        expect(enqueueScoreboardVerification({
            trackKey: 'circuit',
            mode: 'daily',
            bestTime: Number.NaN,
            replay: REPLAY
        })).toEqual({ enqueued: false, entry: null });
        expect(enqueueScoreboardVerification({
            trackKey: 'circuit',
            mode: 'daily',
            bestTime: 21,
            replay: null
        })).toEqual({ enqueued: false, entry: null });
    });

    it('marks scoreboard rejections as terminal until replaced', () => {
        enqueueScoreboardVerification({
            trackKey: 'circuit',
            mode: 'daily',
            bestTime: 19.4,
            replay: REPLAY
        });
        markScoreboardVerificationRejected('circuit');

        expect(getScoreboardVerificationEntry('circuit')).toMatchObject({
            verificationState: 'rejected'
        });

        expect(enqueueScoreboardVerification({
            trackKey: 'circuit',
            mode: 'daily',
            bestTime: 19.9,
            replay: REPLAY
        }).enqueued).toBe(false);

        expect(enqueueScoreboardVerification({
            trackKey: 'circuit',
            mode: 'daily',
            bestTime: 19.1,
            replay: REPLAY
        }).enqueued).toBe(true);

        expect(getScoreboardVerificationEntry('circuit')).toMatchObject({
            bestTime: 19.1,
            verificationState: 'pending'
        });
    });

    it('retains throttled scoreboard entries until retry time', () => {
        enqueueScoreboardVerification({
            trackKey: 'circuit',
            mode: 'daily',
            bestTime: 20.5,
            replay: REPLAY
        });

        const nextAttemptAt = Date.now() + 5_000;
        markScoreboardVerificationPending('circuit', nextAttemptAt);

        expect(getDueScoreboardVerifications(Date.now())).toEqual([]);
        expect(getDueScoreboardVerifications(nextAttemptAt + 1)).toHaveLength(1);
        expect(getNextVerificationAttemptAt()).toBe(nextAttemptAt);
    });

    it('normalizes invalid retry timestamps to now for pending entries', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-22T10:00:00.000Z'));

        enqueueScoreboardVerification({
            trackKey: 'circuit',
            mode: 'daily',
            bestTime: 20.5,
            replay: REPLAY
        });
        markScoreboardVerificationPending('circuit', 'not-a-time');

        expect(getScoreboardVerificationEntry('circuit').nextAttemptAt).toBe(Date.now());
        expect(getDueScoreboardVerifications(Date.now())).toHaveLength(1);

        vi.useRealTimers();
    });

    it('keeps the best daily candidate per challenge using crash-budget rules', () => {
        enqueueDailyChallengeVerification({
            challengeId: 'challenge-1',
            bestTime: 60,
            completedLaps: 2,
            replay: REPLAY,
            objectiveType: 'finish_with_crash_budget'
        });

        expect(enqueueDailyChallengeVerification({
            challengeId: 'challenge-1',
            bestTime: 58,
            completedLaps: 2,
            replay: REPLAY,
            objectiveType: 'finish_with_crash_budget'
        }).enqueued).toBe(false);

        expect(enqueueDailyChallengeVerification({
            challengeId: 'challenge-1',
            bestTime: 65,
            completedLaps: 2,
            replay: REPLAY,
            objectiveType: 'finish_with_crash_budget'
        }).enqueued).toBe(true);

        expect(enqueueDailyChallengeVerification({
            challengeId: 'challenge-1',
            bestTime: 50,
            completedLaps: 3,
            replay: REPLAY,
            objectiveType: 'finish_with_crash_budget'
        }).enqueued).toBe(true);

        expect(getDailyChallengeVerificationEntry('challenge-1')).toMatchObject({
            bestTime: 50,
            completedLaps: 3,
            verificationState: 'pending'
        });
    });

    it('keeps the best daily candidate for time-based challenges and normalizes metadata', () => {
        expect(enqueueDailyChallengeVerification({
            challengeId: 'challenge-time',
            bestTime: 44,
            completedLaps: 2.9,
            replay: REPLAY,
            objectiveType: 'single_lap_fastest',
            challengeDate: '2026-04-22',
            trackKey: 'circuit'
        }).enqueued).toBe(true);

        expect(enqueueDailyChallengeVerification({
            challengeId: 'challenge-time',
            bestTime: 45,
            completedLaps: 3,
            replay: REPLAY,
            objectiveType: 'single_lap_fastest'
        }).enqueued).toBe(false);

        expect(enqueueDailyChallengeVerification({
            challengeId: 'challenge-time',
            bestTime: 43,
            completedLaps: Number.NaN,
            replay: REPLAY,
            objectiveType: 7,
            challengeDate: 7,
            trackKey: 7
        }).enqueued).toBe(true);

        expect(getDailyChallengeVerificationEntry('challenge-time')).toMatchObject({
            bestTime: 43,
            completedLaps: null,
            objectiveType: null,
            challengeDate: null,
            trackKey: null,
            verificationState: 'pending'
        });
    });

    it('rejects invalid daily enqueue requests', () => {
        expect(enqueueDailyChallengeVerification()).toEqual({ enqueued: false, entry: null });
        expect(enqueueDailyChallengeVerification({
            challengeId: 42,
            bestTime: 44,
            replay: REPLAY
        })).toEqual({ enqueued: false, entry: null });
        expect(enqueueDailyChallengeVerification({
            challengeId: '',
            bestTime: 44,
            replay: REPLAY
        })).toEqual({ enqueued: false, entry: null });
        expect(enqueueDailyChallengeVerification({
            challengeId: 'challenge-1',
            bestTime: Infinity,
            replay: REPLAY
        })).toEqual({ enqueued: false, entry: null });
        expect(enqueueDailyChallengeVerification({
            challengeId: 'challenge-1',
            bestTime: 44,
            replay: null
        })).toEqual({ enqueued: false, entry: null });
    });

    it('marks daily verification rejection and supports retry scheduling', () => {
        enqueueDailyChallengeVerification({
            challengeId: 'challenge-2',
            bestTime: 44,
            replay: REPLAY,
            objectiveType: 'single_lap_fastest'
        });

        markDailyChallengeVerificationRejected('challenge-2');
        expect(getDailyChallengeVerificationEntry('challenge-2')).toMatchObject({
            verificationState: 'rejected'
        });

        const nextAttemptAt = Date.now() + 10_000;
        markDailyChallengeVerificationPending('challenge-2', nextAttemptAt);
        expect(getDailyChallengeVerificationEntry('challenge-2')).toMatchObject({
            verificationState: 'pending',
            nextAttemptAt
        });
        expect(getDueDailyChallengeVerifications(nextAttemptAt + 1)).toHaveLength(1);
        expect(getDailyChallengeVerificationState('challenge-2')).toBe('pending');
    });

    it('clears queued items', () => {
        enqueueScoreboardVerification({
            trackKey: 'circuit',
            mode: 'daily',
            bestTime: 20.5,
            replay: REPLAY
        });
        enqueueDailyChallengeVerification({
            challengeId: 'challenge-3',
            bestTime: 40.5,
            replay: REPLAY,
            objectiveType: 'single_lap_fastest'
        });

        clearScoreboardVerification('circuit');
        clearDailyChallengeVerification('challenge-3');

        expect(getScoreboardVerificationEntry('circuit')).toBe(null);
        expect(getDailyChallengeVerificationEntry('challenge-3')).toBe(null);
    });

    it('returns null when marking or clearing missing entries', () => {
        expect(clearScoreboardVerification('missing')).toBe(null);
        expect(clearDailyChallengeVerification('missing')).toBe(null);
        expect(markScoreboardVerificationPending('missing')).toBe(null);
        expect(markDailyChallengeVerificationPending('missing')).toBe(null);
        expect(markScoreboardVerificationRejected('missing')).toBe(null);
        expect(markDailyChallengeVerificationRejected('missing')).toBe(null);
    });

    it('filters due entries and computes the earliest next attempt across both queues', () => {
        const now = Date.now();
        enqueueScoreboardVerification({
            trackKey: 'circuit',
            mode: 'daily',
            bestTime: 20.5,
            replay: REPLAY
        });
        enqueueScoreboardVerification({
            trackKey: 'harborParkLoop',
            mode: 'daily',
            bestTime: 22.5,
            replay: REPLAY
        });
        enqueueDailyChallengeVerification({
            challengeId: 'challenge-4',
            bestTime: 40.5,
            replay: REPLAY,
            objectiveType: 'single_lap_fastest'
        });

        markScoreboardVerificationPending('circuit', now + 2_000);
        markScoreboardVerificationPending('harborParkLoop', now - 1);
        markDailyChallengeVerificationPending('challenge-4', now + 1_000);

        expect(getDueScoreboardVerifications(now).map((entry) => entry.trackKey)).toEqual(['harborParkLoop']);
        expect(getDueDailyChallengeVerifications(now)).toEqual([]);
        expect(getDueDailyChallengeVerifications(now + 1_000)).toHaveLength(1);
        expect(getNextVerificationAttemptAt()).toBe(now - 1);

        markScoreboardVerificationRejected('harborParkLoop');
        expect(getNextVerificationAttemptAt()).toBe(now + 1_000);
        markDailyChallengeVerificationRejected('challenge-4');
        expect(getNextVerificationAttemptAt()).toBe(now + 2_000);
    });
});
