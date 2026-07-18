import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    enqueueDailyChallengeVerification,
    getDailyChallengeVerificationEntry,
    getVerificationSnapshotFromQueueEntry,
    isDailyChallengeVerificationExpired,
    markDailyChallengeVerificationRejected,
    resetVerificationQueueForTests,
} from '../game/scoreboard/verification-queue.js';

const STORAGE_KEY = 'VectorGpVerificationQueue';
const REPLAY = { inputs: [{ frames: 1, left: false, right: false }] };

function installLocalStorage(seed = null) {
    const map = new Map();
    if (seed) {
        Object.entries(seed).forEach(([key, value]) => map.set(key, value));
    }
    globalThis.window = {
        localStorage: {
            getItem: (key) => (map.has(key) ? map.get(key) : null),
            setItem: (key, value) => map.set(key, value),
            removeItem: (key) => map.delete(key),
        },
    };
}

describe('verification queue wave 2', () => {
    beforeEach(() => {
        installLocalStorage();
        resetVerificationQueueForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.window;
    });

    it('builds rejected verification snapshots with the fixed rejected label', () => {
        enqueueDailyChallengeVerification({
            challengeId: 'reject-snapshot',
            bestTime: 18,
            replay: REPLAY,
        });
        markDailyChallengeVerificationRejected('reject-snapshot');

        const entry = getDailyChallengeVerificationEntry('reject-snapshot');
        expect(getVerificationSnapshotFromQueueEntry(entry)).toMatchObject({
            verificationState: 'rejected',
            submissionStage: 'rejected',
            statusText: 'Rejected',
            isLoading: false,
        });
    });

    it('purges expired entries on read after reporting them as expired', () => {
        const past = Date.now() - 1000;
        const entry = {
            challengeId: 'expired-entry',
            bestTime: 22,
            replay: REPLAY,
            verificationState: 'pending',
            nextAttemptAt: Date.now() + 60_000,
            expiresAt: new Date(past).toISOString(),
        };

        expect(isDailyChallengeVerificationExpired(entry, Date.now())).toBe(true);

        installLocalStorage({
            [STORAGE_KEY]: JSON.stringify({ daily: { 'expired-entry': entry } }),
        });

        expect(getDailyChallengeVerificationEntry('expired-entry')).toBeNull();
    });

    it('ignores queue entries stored under non-string challenge ids', () => {
        installLocalStorage({
            [STORAGE_KEY]: JSON.stringify({
                daily: {
                    42: {
                        challengeId: 42,
                        bestTime: 20,
                        replay: REPLAY,
                        verificationState: 'pending',
                        nextAttemptAt: Date.now() + 60_000,
                    },
                },
            }),
        });

        expect(getDailyChallengeVerificationEntry('42')).toBeNull();
    });
});
