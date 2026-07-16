import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearDailyChallengeVerification,
    enqueueDailyChallengeVerification,
    getDailyChallengeVerificationEntry,
    getDailyChallengeVerificationState,
    getDueDailyChallengeVerifications,
    getNextVerificationAttemptAt,
    getVerificationRetryDelayMs,
    getVerificationSnapshotFromQueueEntry,
    markDailyChallengeVerificationError,
    markDailyChallengeVerificationPending,
    markDailyChallengeVerificationRejected,
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
        expect(getDailyChallengeVerificationEntry('')).toBe(null);
        expect(getDailyChallengeVerificationState('missing')).toBe('none');

        delete globalThis.window;

        expect(getDailyChallengeVerificationEntry('challenge-1')).toBe(null);
        expect(getDueDailyChallengeVerifications()).toEqual([]);
        expect(getNextVerificationAttemptAt()).toBe(null);
    });

    it('handles corrupt storage and write failures without throwing', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        delete globalThis.window;
        installLocalStorage({
            [STORAGE_KEY]: '{bad json'
        });

        expect(getDailyChallengeVerificationEntry('challenge-1')).toBe(null);
        expect(consoleError).toHaveBeenCalledWith('Error reading verification queue:', expect.any(Error));

        globalThis.window.localStorage.setItem = () => {
            throw new Error('storage full');
        };

        expect(enqueueDailyChallengeVerification({
            challengeId: 'challenge-1',
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

        const dailyEntry = getDailyChallengeVerificationEntry('challenge-1');
        dailyEntry.replay.inputs[0].frames = 99;
        expect(getDailyChallengeVerificationEntry('challenge-1').replay.inputs[0].frames).toBe(1);

        enqueueDailyChallengeVerification({
            challengeId: 'challenge-2',
            bestTime: 20,
            replay: REPLAY
        });

        expect(readStoredQueue().daily['challenge-1']).toBeTruthy();
        expect(readStoredQueue().daily['challenge-2']).toBeTruthy();
    });

    it('keeps the best daily candidate for time-based challenges and normalizes metadata', () => {
        expect(enqueueDailyChallengeVerification({
            challengeId: 'challenge-time',
            bestTime: 44,
            completedLaps: 2.9,
            replay: REPLAY,
            objectiveType: 'single_lap_fastest',
            challengeDate: '2026-04-22',
            trackKey: 'circuit',
            previousBestTime: 50.5,
            previousCompletedLaps: 1.8,
            previousCheckpointTimesSec: [10, 20, 50.5]
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
            trackKey: 7,
            previousBestTime: 44,
            previousCompletedLaps: 2
        }).enqueued).toBe(true);

        expect(getDailyChallengeVerificationEntry('challenge-time')).toMatchObject({
            bestTime: 43,
            completedLaps: null,
            objectiveType: null,
            challengeDate: null,
            trackKey: null,
            previousBestTime: 44,
            previousCompletedLaps: 2,
            verificationState: 'pending',
            submissionStage: 'submitting',
            statusText: 'Submitting...'
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
            submissionStage: 'pending',
            nextAttemptAt
        });
        expect(getDueDailyChallengeVerifications(nextAttemptAt + 1)).toHaveLength(1);
        expect(getDailyChallengeVerificationState('challenge-2')).toBe('pending');
    });

    it('can update the submission stage without changing queue identity', () => {
        enqueueDailyChallengeVerification({
            challengeId: 'challenge-stage-id',
            bestTime: 44,
            replay: REPLAY,
            objectiveType: 'single_lap_fastest'
        });

        const before = getDailyChallengeVerificationEntry('challenge-stage-id');
        markDailyChallengeVerificationPending('challenge-stage-id', Date.now(), {
            submissionStage: 'verifying',
            preserveUpdatedAt: true
        });
        const after = getDailyChallengeVerificationEntry('challenge-stage-id');

        expect(after).toMatchObject({
            verificationState: 'pending',
            submissionStage: 'verifying',
            updatedAt: before.updatedAt
        });
    });

    it('preserves stage-specific snapshots and terminal errors', () => {
        enqueueDailyChallengeVerification({
            challengeId: 'challenge-stage',
            bestTime: 44,
            replay: REPLAY,
            objectiveType: 'single_lap_fastest'
        });

        expect(getVerificationSnapshotFromQueueEntry(
            getDailyChallengeVerificationEntry('challenge-stage')
        )).toMatchObject({
            verificationState: 'pending',
            submissionStage: 'submitting',
            statusText: 'Submitting...',
            isLoading: true
        });

        markDailyChallengeVerificationPending('challenge-stage', Date.now() + 5_000, {
            submissionStage: 'retrying'
        });
        expect(getVerificationSnapshotFromQueueEntry(
            getDailyChallengeVerificationEntry('challenge-stage')
        )).toMatchObject({
            verificationState: 'pending',
            submissionStage: 'retrying',
            statusText: 'Retrying...',
            isLoading: true
        });

        markDailyChallengeVerificationError('challenge-stage', 'Daily challenge submit failed');
        expect(getVerificationSnapshotFromQueueEntry(
            getDailyChallengeVerificationEntry('challenge-stage')
        )).toMatchObject({
            verificationState: 'error',
            submissionStage: 'error',
            statusText: 'Daily challenge submit failed',
            isLoading: false
        });
    });

    it('clears queued items', () => {
        enqueueDailyChallengeVerification({
            challengeId: 'challenge-3',
            bestTime: 40.5,
            replay: REPLAY,
            objectiveType: 'single_lap_fastest'
        });

        clearDailyChallengeVerification('challenge-3');

        expect(getDailyChallengeVerificationEntry('challenge-3')).toBe(null);
    });

    it('returns null when marking or clearing missing entries', () => {
        expect(clearDailyChallengeVerification('missing')).toBe(null);
        expect(markDailyChallengeVerificationPending('missing')).toBe(null);
        expect(markDailyChallengeVerificationRejected('missing')).toBe(null);
        expect(markDailyChallengeVerificationError('missing')).toBe(null);
    });

    it('filters due entries and computes the earliest next attempt', () => {
        const now = Date.now();
        enqueueDailyChallengeVerification({
            challengeId: 'challenge-4',
            bestTime: 40.5,
            replay: REPLAY,
            objectiveType: 'single_lap_fastest'
        });
        enqueueDailyChallengeVerification({
            challengeId: 'challenge-5',
            bestTime: 22.5,
            replay: REPLAY,
            objectiveType: 'single_lap_fastest'
        });

        markDailyChallengeVerificationPending('challenge-4', now + 1_000);
        markDailyChallengeVerificationPending('challenge-5', now - 1);

        expect(getDueDailyChallengeVerifications(now)).toHaveLength(1);
        expect(getDueDailyChallengeVerifications(now + 1_000)).toHaveLength(2);
        expect(getNextVerificationAttemptAt()).toBe(now - 1);

        markDailyChallengeVerificationRejected('challenge-5');
        expect(getNextVerificationAttemptAt()).toBe(now + 1_000);
        markDailyChallengeVerificationRejected('challenge-4');
        expect(getNextVerificationAttemptAt()).toBe(null);
    });
});
