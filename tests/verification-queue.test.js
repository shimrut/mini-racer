import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearCampaignVerification,
    getCampaignVerificationEntriesForOwner,
    clearDailyChallengeVerification,
    createVerificationSnapshot,
    enqueueCampaignVerification,
    enqueueDailyChallengeVerification,
    getCampaignVerificationEntry,
    getDueCampaignVerifications,
    isRetryableVerificationFailure,
    markCampaignVerificationPending,
    getDailyChallengeVerificationEntry,
    getDailyChallengeVerificationState,
    getDueDailyChallengeVerifications,
    getNextVerificationAttemptAt,
    getVerificationRetryDelayMs,
    getVerificationSnapshotFromQueueEntry,
    isDailyChallengeVerificationExpired,
    markDailyChallengeVerificationError,
    markDailyChallengeVerificationPending,
    markDailyChallengeVerificationRejected,
    resetVerificationQueueForTests,
    claimVerificationEntriesForOwner,
    prepareVerificationQueueGuestProgressReconciliation,
    resolveVerificationQueueAfterGuestProgressSelection
} from '../game/scoreboard/verification-queue.js';
import {
    clearActivePlayerOwnerId,
    getPlayerSessionId,
    setActivePlayerOwnerId
} from '../game/player/active-owner.js';
import { getPhoneGuestOwnerId } from '../game/scoreboard/player-identity.js';
import { writeCachedPlayerProfile } from '../game/player/profile-cache.js';

const OWNER = 'reddit:racer';

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
        setActivePlayerOwnerId(OWNER);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        clearActivePlayerOwnerId();
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

    it('moves only the selected guest queue into the signed-in owner', () => {
        setActivePlayerOwnerId('guest:guest-choice');
        enqueueDailyChallengeVerification({
            challengeId: 'guest-race',
            bestTime: 12,
            replay: REPLAY,
        });
        setActivePlayerOwnerId(OWNER);
        enqueueDailyChallengeVerification({
            challengeId: 'account-race',
            bestTime: 11,
            replay: REPLAY,
        });

        // Reconciliation acts on the receipt captured before the choice was sent. Without one it
        // cannot prove which entries the selection covered, and quarantines them instead.
        prepareVerificationQueueGuestProgressReconciliation({
            transferId: 'guest-transfer:selected',
            guestPlayerId: 'guest:guest-choice',
            accountPlayerId: OWNER,
            choice: 'guest',
        });
        const result = resolveVerificationQueueAfterGuestProgressSelection({
            transferId: 'guest-transfer:selected',
            guestPlayerId: 'guest:guest-choice',
            accountPlayerId: OWNER,
            choice: 'guest',
        });

        expect(result.moved).toBe(1);
        expect(result.removed).toBe(1);
        expect(getDailyChallengeVerificationEntry('guest-race')).toMatchObject({
            ownerPlayerId: OWNER,
            bestTime: 12,
        });
        expect(getDailyChallengeVerificationEntry('account-race')).toBeNull();
    });

    it('derives legacy expiry from challengeDate or daily-gp challenge ids', () => {
        // Pinned: the derived expiry below is a fixed date, so a real clock would prune the entries under test.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        const playlistMs = 7 * 24 * 60 * 60 * 1000;
        const bufferMs = 6 * 60 * 60 * 1000;
        const startsAt = Date.parse('2026-07-18T00:00:00.000Z');
        const expectedExpiry = new Date(startsAt + playlistMs + bufferMs).toISOString();

        installLocalStorage({
            [STORAGE_KEY]: JSON.stringify({
                daily: {
                    'legacy-date': {
                        challengeId: 'legacy-date',
                        bestTime: 20,
                        replay: REPLAY,
                        verificationState: 'pending',
                        nextAttemptAt: Date.now() + 60_000,
                        challengeDate: '2026-07-18'
                    },
                    'daily-gp-2026-07-18': {
                        challengeId: 'daily-gp-2026-07-18',
                        bestTime: 21,
                        replay: REPLAY,
                        verificationState: 'pending',
                        nextAttemptAt: Date.now() + 60_000
                    },
                    'expired-legacy': {
                        challengeId: 'expired-legacy',
                        bestTime: 22,
                        replay: REPLAY,
                        verificationState: 'pending',
                        nextAttemptAt: Date.now() + 60_000,
                        challengeDate: '2020-01-01'
                    },
                    'no-expiry': {
                        challengeId: 'no-expiry',
                        bestTime: 23,
                        replay: REPLAY,
                        verificationState: 'pending',
                        nextAttemptAt: Date.now() + 60_000
                    }
                }
            })
        });

        expect(getDailyChallengeVerificationEntry('legacy-date')?.expiresAt).toBe(expectedExpiry);
        expect(getDailyChallengeVerificationEntry('daily-gp-2026-07-18')?.expiresAt).toBe(expectedExpiry);
        expect(getDailyChallengeVerificationEntry('expired-legacy')).toBe(null);
        expect(getDailyChallengeVerificationEntry('no-expiry')).toBe(null);
        expect(readStoredQueue().daily['expired-legacy']).toBeUndefined();
        expect(readStoredQueue().daily['no-expiry']).toBeUndefined();
    });

    it('detects expired entries and rejects enqueue past expiry', () => {
        const now = Date.parse('2026-07-18T12:00:00.000Z');
        expect(isDailyChallengeVerificationExpired(null, now)).toBe(true);
        expect(isDailyChallengeVerificationExpired({}, now)).toBe(true);
        expect(isDailyChallengeVerificationExpired({
            expiresAt: '2026-07-18T11:00:00.000Z'
        }, now)).toBe(true);
        expect(isDailyChallengeVerificationExpired({
            expiresAt: '2026-07-18T13:00:00.000Z'
        }, now)).toBe(false);
        expect(isDailyChallengeVerificationExpired({
            challengeDate: '2026-07-18'
        }, now)).toBe(false);

        expect(enqueueDailyChallengeVerification({
            challengeId: 'already-expired',
            bestTime: 20,
            replay: REPLAY,
            expiresAt: '2020-01-01T00:00:00.000Z'
        })).toEqual({ enqueued: false, entry: null });
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
            enqueued: false,
            entry: expect.objectContaining({ bestTime: 21.2 })
        });
        expect(consoleError).toHaveBeenCalledWith('Error writing verification queue:', expect.any(Error));
    });

    it('treats a non-object daily section as empty when reading storage', () => {
        installLocalStorage({
            [STORAGE_KEY]: JSON.stringify({ daily: 42 }),
        });

        expect(getDailyChallengeVerificationEntry('missing')).toBe(null);
        expect(enqueueDailyChallengeVerification({
            challengeId: 'fresh-entry',
            bestTime: 20,
            replay: REPLAY,
        })).toMatchObject({
            enqueued: true,
            entry: expect.objectContaining({ challengeId: 'fresh-entry' }),
        });
        expect(readStoredQueue().daily[`${OWNER}::fresh-entry`]).toBeTruthy();
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
                        nextAttemptAt: 10,
                        expiresAt: '2099-01-01T00:00:00.000Z'
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
        expect(readStoredQueue().daily[`${OWNER}::challenge-2`]).toBeTruthy();
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
            previousCheckpointTimesSec: [10, 20, 50.5],
            expiresAt: '2099-01-01T00:00:00.000Z'
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

    it('does not replace an equal daily best time with a slower duplicate enqueue', () => {
        enqueueDailyChallengeVerification({
            challengeId: 'challenge-equal',
            bestTime: 40,
            replay: REPLAY,
            checkpointTimesSec: [10, 20, 40],
            previousCheckpointTimesSec: [11, 21, 41]
        });

        const result = enqueueDailyChallengeVerification({
            challengeId: 'challenge-equal',
            bestTime: 40,
            replay: { inputs: [{ frames: 2, left: true, right: false }] },
            checkpointTimesSec: [9, 19, 39]
        });

        expect(result).toMatchObject({ enqueued: false });
        expect(getDailyChallengeVerificationEntry('challenge-equal')).toMatchObject({
            bestTime: 40,
            checkpointTimesSec: [10, 20, 40],
            previousCheckpointTimesSec: [11, 21, 41]
        });
    });

    it('copies checkpoint arrays and preserves custom pending status text', () => {
        enqueueDailyChallengeVerification({
            challengeId: 'challenge-checkpoints',
            bestTime: 30,
            replay: REPLAY,
            checkpointTimesSec: [5, 15, 30]
        });

        const entry = getDailyChallengeVerificationEntry('challenge-checkpoints');
        entry.checkpointTimesSec[0] = 99;
        expect(getDailyChallengeVerificationEntry('challenge-checkpoints').checkpointTimesSec)
            .toEqual([5, 15, 30]);

        markDailyChallengeVerificationPending('challenge-checkpoints', Date.now() + 1_000, {
            submissionStage: 'pending',
            statusText: '  Waiting in queue  '
        });
        expect(getDailyChallengeVerificationEntry('challenge-checkpoints')).toMatchObject({
            submissionStage: 'pending',
            statusText: 'Waiting in queue'
        });
    });

    it('normalizes invalid stored stages and exposes terminal snapshot states', () => {
        delete globalThis.window;
        installLocalStorage({
            [STORAGE_KEY]: JSON.stringify({
                daily: {
                    'challenge-stages': {
                        challengeId: 'challenge-stages',
                        bestTime: 44,
                        replay: REPLAY,
                        verificationState: 'bogus',
                        submissionStage: 'bogus',
                        statusText: 'Custom pending copy',
                        nextAttemptAt: Date.now() + 60_000,
                        expiresAt: '2099-01-01T00:00:00.000Z'
                    }
                }
            })
        });

        expect(getDailyChallengeVerificationEntry('challenge-stages')).toMatchObject({
            verificationState: 'pending',
            submissionStage: 'pending',
            statusText: 'Custom pending copy'
        });

        markDailyChallengeVerificationRejected('challenge-stages');
        expect(getDailyChallengeVerificationEntry('challenge-stages')).toMatchObject({
            verificationState: 'rejected',
            submissionStage: 'rejected',
            statusText: 'Rejected',
            nextAttemptAt: null
        });
        expect(getVerificationSnapshotFromQueueEntry(
            getDailyChallengeVerificationEntry('challenge-stages')
        )).toMatchObject({
            verificationState: 'rejected',
            submissionStage: 'rejected',
            statusText: 'Rejected',
            isLoading: false
        });

        enqueueDailyChallengeVerification({
            challengeId: 'challenge-error-text',
            bestTime: 41,
            replay: REPLAY
        });
        markDailyChallengeVerificationError('challenge-error-text');
        expect(getDailyChallengeVerificationEntry('challenge-error-text').statusText)
            .toBe('Submission failed');
        markDailyChallengeVerificationError('challenge-error-text', '  Network timeout  ');
        expect(getDailyChallengeVerificationEntry('challenge-error-text').statusText)
            .toBe('Network timeout');
        expect(getVerificationSnapshotFromQueueEntry(null)).toBe(null);
    });

    it('accepts numeric expiry timestamps and normalizes stored ISO values on read', () => {
        const futureMs = Date.now() + 60_000;
        enqueueDailyChallengeVerification({
            challengeId: 'challenge-numeric-expiry',
            bestTime: 33,
            replay: REPLAY,
            expiresAt: futureMs
        });
        expect(getDailyChallengeVerificationEntry('challenge-numeric-expiry').expiresAt)
            .toBe(new Date(futureMs).toISOString());

        delete globalThis.window;
        installLocalStorage({
            [STORAGE_KEY]: JSON.stringify({
                daily: {
                    'challenge-normalize-expiry': {
                        challengeId: 'challenge-normalize-expiry',
                        bestTime: 30,
                        replay: REPLAY,
                        verificationState: 'pending',
                        nextAttemptAt: Date.now() + 60_000,
                        expiresAt: futureMs
                    }
                }
            })
        });

        expect(getDailyChallengeVerificationEntry('challenge-normalize-expiry').expiresAt)
            .toBe(new Date(futureMs).toISOString());
        expect(readStoredQueue().daily['challenge-normalize-expiry'].expiresAt)
            .toBe(new Date(futureMs).toISOString());
    });

    it('builds verification snapshots directly and preserves explicit submitting stages', () => {
        expect(createVerificationSnapshot({
            submissionStage: 'submitting',
            verificationState: 'pending',
            statusText: '  Uploading replay  ',
        })).toEqual({
            isLoading: true,
            verificationState: 'pending',
            submissionStage: 'submitting',
            statusText: 'Uploading replay',
        });

        expect(createVerificationSnapshot({
            verificationState: 'rejected',
            submissionStage: 'rejected',
            isLoading: false,
        })).toMatchObject({
            verificationState: 'rejected',
            submissionStage: 'rejected',
            statusText: 'Rejected',
            isLoading: false,
        });
    });

    it('treats malformed daily sections as empty and coerces invalid next attempt times', () => {
        delete globalThis.window;
        installLocalStorage({
            [STORAGE_KEY]: JSON.stringify({
                daily: null
            })
        });

        expect(getDueDailyChallengeVerifications()).toEqual([]);

        enqueueDailyChallengeVerification({
            challengeId: 'challenge-invalid-next',
            bestTime: 25,
            replay: REPLAY
        });
        const past = Date.now() - 1;
        markDailyChallengeVerificationPending('challenge-invalid-next', 'soon');
        const due = getDueDailyChallengeVerifications(past + 60_000);
        expect(due).toHaveLength(1);
        expect(Number.isFinite(due[0].nextAttemptAt)).toBe(true);
    });

    it('purges entries whose expiry is exactly now and normalizes numeric expiresAt on read', () => {
        const now = Date.parse('2026-07-18T12:00:00.000Z');
        vi.spyOn(Date, 'now').mockReturnValue(now);
        installLocalStorage({
            [STORAGE_KEY]: JSON.stringify({
                daily: {
                    'expires-exactly-now': {
                        challengeId: 'expires-exactly-now',
                        bestTime: 20,
                        replay: REPLAY,
                        verificationState: 'pending',
                        nextAttemptAt: now + 60_000,
                        expiresAt: '2026-07-18T12:00:00.000Z',
                    },
                    'numeric-expiry-normalize': {
                        challengeId: 'numeric-expiry-normalize',
                        bestTime: 21,
                        replay: REPLAY,
                        verificationState: 'pending',
                        nextAttemptAt: now + 60_000,
                        expiresAt: now + 120_000,
                    },
                },
            }),
        });

        expect(getDailyChallengeVerificationEntry('expires-exactly-now')).toBe(null);
        expect(getDailyChallengeVerificationEntry('numeric-expiry-normalize')?.expiresAt)
            .toBe(new Date(now + 120_000).toISOString());
        expect(readStoredQueue().daily['numeric-expiry-normalize'].expiresAt)
            .toBe(new Date(now + 120_000).toISOString());
    });

    it('turns an expired Campaign result into a persistent race-again error', () => {
        const now = Date.parse('2026-07-18T12:00:00.000Z');
        vi.spyOn(Date, 'now').mockReturnValue(now);
        installLocalStorage({
            [STORAGE_KEY]: JSON.stringify({
                daily: {},
                campaign: {
                    'numbered-v1-00': {
                        raceId: 'numbered-v1-00',
                        bestTime: 8.25,
                        replay: REPLAY,
                        verificationState: 'pending',
                        nextAttemptAt: now,
                        expiresAt: new Date(now).toISOString(),
                    },
                },
            }),
        });

        expect(getCampaignVerificationEntry('numbered-v1-00')).toMatchObject({
            verificationState: 'error',
            submissionStage: 'error',
            statusText: 'Result expired — race again.',
            replay: null,
        });
        expect(getDueCampaignVerifications()).toEqual([]);
        expect(enqueueCampaignVerification({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            bestTime: 9,
            lapCount: 1,
            rulesRevision: 1,
            replay: REPLAY,
        }).enqueued).toBe(true);
        expect(getCampaignVerificationEntry('numbered-v1-00')).toMatchObject({
            verificationState: 'pending',
            bestTime: 9,
        });
    });

    it('ignores malformed daily-gp ids when deriving legacy expiry', () => {
        const future = Date.now() + 60_000;
        enqueueDailyChallengeVerification({
            challengeId: 'daily-gp-not-a-date',
            bestTime: 30,
            replay: REPLAY,
            expiresAt: future,
        });

        expect(getDailyChallengeVerificationEntry('daily-gp-not-a-date')).toMatchObject({
            challengeId: 'daily-gp-not-a-date',
        });
    });

    it('adds a fixed expiry and purges expired or unsafe legacy entries', () => {
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-17T00:01:00.000Z'));
        expect(enqueueDailyChallengeVerification({
            challengeId: 'daily-gp-2026-07-10',
            challengeDate: '2026-07-10',
            bestTime: 40,
            replay: REPLAY,
            expiresAt: '2026-07-17T06:00:00.000Z'
        }).entry).toMatchObject({
            expiresAt: '2026-07-17T06:00:00.000Z'
        });

        delete globalThis.window;
        installLocalStorage({
            [STORAGE_KEY]: JSON.stringify({
                daily: {
                    expired: {
                        challengeId: 'daily-gp-2026-07-09',
                        challengeDate: '2026-07-09',
                        verificationState: 'pending',
                        nextAttemptAt: 1
                    },
                    unsafe: {
                        challengeId: 'legacy-without-date',
                        verificationState: 'pending',
                        nextAttemptAt: 1
                    }
                }
            })
        });

        expect(getDueDailyChallengeVerifications()).toEqual([]);
        expect(readStoredQueue()).toEqual({ daily: {}, campaign: {} });
    });

    it('keeps Campaign entries queued for retry and isolated from Daily', () => {
        installLocalStorage();

        expect(enqueueCampaignVerification({
            raceId: 'numbered-v1-03',
            trackKey: 'numberThree',
            bestTime: 24.5,
            lapCount: 2,
            rulesRevision: 1,
            replay: { targetLapNumber: 2, inputs: [] },
        }).enqueued).toBe(true);

        expect(getDueDailyChallengeVerifications()).toEqual([]);
        expect(getDueCampaignVerifications()).toMatchObject([
            { raceId: 'numbered-v1-03', bestTime: 24.5, lapCount: 2 },
        ]);

        expect(enqueueCampaignVerification({
            raceId: 'numbered-v1-03',
            trackKey: 'numberThree',
            bestTime: 25.9,
            lapCount: 2,
            rulesRevision: 1,
            replay: { targetLapNumber: 2, inputs: [] },
        }).enqueued).toBe(false);
        expect(getCampaignVerificationEntry('numbered-v1-03').bestTime).toBe(24.5);

        markCampaignVerificationPending('numbered-v1-03', Date.now() + 60_000, {
            submissionStage: 'retrying',
        });
        expect(getDueCampaignVerifications()).toEqual([]);
        expect(getCampaignVerificationEntry('numbered-v1-03')).toMatchObject({
            verificationState: 'pending',
            submissionStage: 'retrying',
        });

        clearCampaignVerification('numbered-v1-03');
        expect(getCampaignVerificationEntry('numbered-v1-03')).toBeNull();
    });

    function queueDailyRun(challengeId = 'daily-gp-2031-05-01', bestTime = 30) {
        return enqueueDailyChallengeVerification({
            challengeId,
            challengeDate: challengeId.slice('daily-gp-'.length),
            trackKey: 'circuit',
            bestTime,
            replay: REPLAY,
        });
    }

    function queueCampaignRun(raceId = 'numbered-v1-02', bestTime = 12.345) {
        return enqueueCampaignVerification({
            raceId,
            trackKey: 'numberTwo',
            bestTime,
            lapCount: 1,
            rulesRevision: 1,
            replay: REPLAY,
        });
    }

    it('stamps queued results with the account that raced them', () => {
        queueDailyRun();

        expect(readStoredQueue().daily[`${OWNER}::daily-gp-2031-05-01`]).toMatchObject({
            ownerPlayerId: OWNER,
            sessionId: getPlayerSessionId(),
        });
    });

    it('reads queued Campaign results by their stamped owner while selection is open', () => {
        queueCampaignRun('numbered-v1-02');

        expect(getCampaignVerificationEntriesForOwner(OWNER)).toMatchObject({
            'numbered-v1-02': {
                ownerPlayerId: OWNER,
                verificationState: 'pending',
            },
        });
        setActivePlayerOwnerId('reddit:someone-else');
        expect(getCampaignVerificationEntriesForOwner(OWNER)).toHaveProperty('numbered-v1-02');
        expect(getCampaignVerificationEntriesForOwner('reddit:someone-else')).toEqual({});
    });

    it('holds another account\'s queued result instead of submitting it', () => {
        queueDailyRun();
        setActivePlayerOwnerId('reddit:someone-else');

        expect(getDueDailyChallengeVerifications()).toEqual([]);
        expect(getDailyChallengeVerificationEntry('daily-gp-2031-05-01')).toBeNull();
        expect(readStoredQueue().daily[`${OWNER}::daily-gp-2031-05-01`]).toBeTruthy();
    });

    it('resumes the original account\'s result when it comes back', () => {
        queueDailyRun();
        setActivePlayerOwnerId('reddit:someone-else');
        setActivePlayerOwnerId(OWNER);

        expect(getDueDailyChallengeVerifications()).toMatchObject([
            { challengeId: 'daily-gp-2031-05-01', ownerPlayerId: OWNER },
        ]);
    });

    it('queues each account\'s run for the same race side by side', () => {
        queueDailyRun('daily-gp-2031-05-01', 30);
        setActivePlayerOwnerId('reddit:someone-else');
        queueDailyRun('daily-gp-2031-05-01', 45);

        expect(getDueDailyChallengeVerifications()).toMatchObject([{ bestTime: 45 }]);
        setActivePlayerOwnerId(OWNER);
        expect(getDueDailyChallengeVerifications()).toMatchObject([{ bestTime: 30 }]);
    });

    it('stamps an unsigned finish with this phone\'s guest id', () => {
        clearActivePlayerOwnerId();
        queueDailyRun();

        const guestOwner = getPhoneGuestOwnerId();
        expect(readStoredQueue().daily[`${guestOwner}::daily-gp-2031-05-01`]).toMatchObject({
            ownerPlayerId: guestOwner,
        });
        expect(getDueDailyChallengeVerifications()).toEqual([]);
    });

    it('stamps an unsigned finish with the last confirmed player on this phone', () => {
        writeCachedPlayerProfile(OWNER, { hasAnyData: true });
        clearActivePlayerOwnerId();
        queueDailyRun();

        expect(readStoredQueue().daily[`${OWNER}::daily-gp-2031-05-01`]).toMatchObject({
            ownerPlayerId: OWNER,
        });
        setActivePlayerOwnerId(OWNER);
        expect(getDueDailyChallengeVerifications()).toMatchObject([{ ownerPlayerId: OWNER }]);
        expect(claimVerificationEntriesForOwner(OWNER).claimed).toEqual([]);
    });

    it('does not give a last-confirmed unsigned run to a later sign-in', () => {
        writeCachedPlayerProfile(OWNER, { hasAnyData: true });
        clearActivePlayerOwnerId();
        queueDailyRun();
        setActivePlayerOwnerId('reddit:someone-else');

        expect(getDueDailyChallengeVerifications()).toEqual([]);
        expect(claimVerificationEntriesForOwner('reddit:someone-else').claimed).toEqual([]);
        expect(readStoredQueue().daily[`${OWNER}::daily-gp-2031-05-01`]).toMatchObject({
            ownerPlayerId: OWNER,
        });
    });

    it('never submits a result queued before any account was known', () => {
        clearActivePlayerOwnerId();
        queueDailyRun();

        setActivePlayerOwnerId(OWNER);

        expect(getDueDailyChallengeVerifications()).toEqual([]);
    });

    it('claims this session\'s unsigned results for the account the server names', () => {
        clearActivePlayerOwnerId();
        queueDailyRun();
        setActivePlayerOwnerId(OWNER);

        const { claimed } = claimVerificationEntriesForOwner(OWNER);

        expect(claimed).toMatchObject([{ bucket: 'daily', entryId: 'daily-gp-2031-05-01' }]);
        expect(getDueDailyChallengeVerifications()).toMatchObject([{ ownerPlayerId: OWNER }]);
    });

    it('keeps last visit\'s unsigned result on the phone guest instead of giving it to a later sign-in', () => {
        clearActivePlayerOwnerId();
        queueDailyRun();
        const guestOwner = getPhoneGuestOwnerId();
        const guestKey = `${guestOwner}::daily-gp-2031-05-01`;
        const queueState = readStoredQueue();
        queueState.daily[guestKey].sessionId = 'session-from-a-previous-load';
        globalThis.window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queueState));
        setActivePlayerOwnerId(OWNER);

        const { claimed } = claimVerificationEntriesForOwner(OWNER);

        expect(claimed).toEqual([]);
        expect(getDueDailyChallengeVerifications()).toEqual([]);
        expect(readStoredQueue().daily[guestKey]).toMatchObject({ ownerPlayerId: guestOwner });
        expect(readStoredQueue().daily[`${OWNER}::daily-gp-2031-05-01`]).toBeUndefined();

        setActivePlayerOwnerId(guestOwner);
        expect(getDueDailyChallengeVerifications()).toMatchObject([{ ownerPlayerId: guestOwner }]);
    });

    it('adopts a leftover unnamed run onto the phone guest instead of a later sign-in', () => {
        clearActivePlayerOwnerId();
        queueDailyRun();
        const guestOwner = getPhoneGuestOwnerId();
        const guestKey = `${guestOwner}::daily-gp-2031-05-01`;
        const queueState = readStoredQueue();
        const entry = queueState.daily[guestKey];
        delete queueState.daily[guestKey];
        entry.ownerPlayerId = null;
        entry.sessionId = 'session-from-a-previous-load';
        queueState.daily['daily-gp-2031-05-01'] = entry;
        globalThis.window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queueState));
        setActivePlayerOwnerId(OWNER);

        const { claimed } = claimVerificationEntriesForOwner(OWNER);

        expect(claimed).toEqual([]);
        expect(getDueDailyChallengeVerifications()).toEqual([]);
        expect(readStoredQueue().daily[guestKey]).toMatchObject({ ownerPlayerId: guestOwner });
        expect(readStoredQueue().daily[`${OWNER}::daily-gp-2031-05-01`]).toBeUndefined();
    });

    it('classifies transient submission failures as retryable', () => {
        expect(isRetryableVerificationFailure(null)).toBe(true);
        expect(isRetryableVerificationFailure({ status: 503 })).toBe(true);
        expect(isRetryableVerificationFailure({ status: 429 })).toBe(true);
        expect(isRetryableVerificationFailure({ status: 422 })).toBe(false);
        expect(isRetryableVerificationFailure({ status: 403 })).toBe(false);
    });
});
