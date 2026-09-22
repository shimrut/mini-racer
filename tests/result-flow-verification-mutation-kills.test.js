import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildLapRecord,
    buildModalDeltaDisplay,
    buildModalRunsPayload,
    buildScoreboardRankDisplay,
    isNewBestResult,
    pushRecentLap,
} from '../game/race/result-flow.js';
import {
    clearDailyChallengeVerification,
    createVerificationSnapshot,
    enqueueDailyChallengeVerification,
    getDailyChallengeVerificationEntry,
    getDueDailyChallengeVerifications,
    getVerificationSnapshotFromQueueEntry,
    isDailyChallengeVerificationExpired,
    markDailyChallengeVerificationError,
    markDailyChallengeVerificationPending,
    markDailyChallengeVerificationRejected,
    resetVerificationQueueForTests,
} from '../game/scoreboard/verification-queue.js';
import {
    clearActivePlayerOwnerId,
    setActivePlayerOwnerId,
} from '../game/player/active-owner.js';

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

describe('result-flow mutation kills', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('distinguishes finite, null, undefined, and NaN previous-best values', () => {
        expect(buildLapRecord(1, 10, null).deltaVsBest).toBeNull();
        expect(buildLapRecord(1, 10, undefined).deltaVsBest).toBeNull();
        expect(buildLapRecord(1, 10, Number.NaN).deltaVsBest).toBeNull();
        expect(buildLapRecord(1, 10, 0).deltaVsBest).toBe(10);
        expect(buildLapRecord(1, 10, 9).deltaVsBest).toBe(1);
    });

    it('keeps recent laps at the max-length boundary without trimming early', () => {
        const atMax = [{ lapNumber: 1 }, { lapNumber: 2 }, { lapNumber: 3 }];
        pushRecentLap(atMax, { lapNumber: 4 }, 4);
        expect(atMax).toHaveLength(4);
        expect(atMax.map((lap) => lap.lapNumber)).toEqual([1, 2, 3, 4]);

        const overMax = [{ lapNumber: 1 }, { lapNumber: 2 }, { lapNumber: 3 }, { lapNumber: 4 }];
        pushRecentLap(overMax, { lapNumber: 5 }, 4);
        expect(overMax).toHaveLength(4);
        expect(overMax.map((lap) => lap.lapNumber)).toEqual([2, 3, 4, 5]);
    });

    it('treats undefined delta as empty while zero delta formats as zero seconds', () => {
        expect(buildModalDeltaDisplay({ deltaToBest: undefined })).toEqual({
            text: '--',
            valueClass: '',
        });
        expect(buildModalDeltaDisplay({ deltaToBest: 0 })).toEqual({
            text: '0.000s',
            valueClass: '',
        });
    });

    it('labels rank errors when either verification or submission stage is error', () => {
        expect(buildScoreboardRankDisplay({
            verificationState: 'error',
            submissionStage: 'pending',
        }).labelText).toBe('Rank error');
        expect(buildScoreboardRankDisplay({
            verificationState: 'pending',
            submissionStage: 'error',
        }).labelText).toBe('Rank error');
        expect(buildScoreboardRankDisplay({
            verificationState: 'verified',
            submissionStage: 'complete',
        }).labelText).toBe('Rank');
    });

    it('normalizes mixed-case verification stages and strips trailing status dots', () => {
        expect(buildScoreboardRankDisplay({
            verificationState: ' REJECTED ',
            submissionStage: ' rejected ',
        }).labelText).toBe('Rank rejected');
        expect(buildScoreboardRankDisplay({
            statusText: 'Rejected...',
        }).labelText).toBe('Rank rejected');
        expect(buildScoreboardRankDisplay({
            statusText: 'Verifying....',
        }).labelText).toBe('Verifying rank');
        expect(buildScoreboardRankDisplay({
            submissionStage: ' VERIFYING ',
        }).labelText).toBe('Verifying rank');
    });

    it('labels retrying rank when any retry signal is present alone', () => {
        expect(buildScoreboardRankDisplay({
            submissionStage: 'retrying',
            statusText: 'Uploading replay',
        }).labelText).toBe('Retrying rank');
        expect(buildScoreboardRankDisplay({
            statusText: 'retrying',
        }).labelText).toBe('Retrying rank');
        expect(buildScoreboardRankDisplay({
            statusText: 'queued for retry',
        }).labelText).toBe('Retrying rank');
        expect(buildScoreboardRankDisplay({
            statusText: 'retrying soon',
        }).labelText).toBe('Retrying rank');
        expect(buildScoreboardRankDisplay({
            submissionStage: 'pending',
            statusText: 'Pending',
        }).labelText).toBe('Rank pending');
    });

    it('rejects null sources and only applies own update properties', () => {
        expect(buildModalRunsPayload(null)).toBeNull();
        expect(buildModalRunsPayload('bad')).toBeNull();

        const base = {
            bestTime: 20,
            currentTime: 21,
            lapTimesArray: [20],
            scoreboardSnapshot: { playerRank: 1 },
        };
        const inherited = Object.create({ bestTime: 99 });
        inherited.currentTime = 22;

        expect(buildModalRunsPayload(base, { updates: inherited })).toMatchObject({
            bestTime: 20,
            currentTime: 22,
        });

        expect(buildModalRunsPayload(base, {
            updates: {
                bestTime: 19,
                lapTimesArray: [19],
                scoreboardSnapshot: { playerRank: 2 },
            },
        })).toMatchObject({
            bestTime: 19,
            lapTimesArray: [19],
            scoreboardSnapshot: { playerRank: 2 },
        });

        expect(buildModalRunsPayload(base, {
            updates: Object.defineProperty({}, 'scoreboardSnapshot', {
                value: null,
                enumerable: true,
            }),
        })).toMatchObject({
            scoreboardSnapshot: null,
            bestTime: 20,
        });
    });

    it('rejects equal-time bests and missing policy or candidate objects', () => {
        const policy = { bestResultComparator: 'time' };
        expect(isNewBestResult(null, { bestTime: 20 }, null)).toBe(false);
        expect(isNewBestResult(policy, null, null)).toBe(false);
        expect(isNewBestResult(policy, { bestTime: 20 }, { bestTime: 20 })).toBe(false);
        expect(isNewBestResult(policy, { bestTime: 19.9 }, { bestTime: 20 })).toBe(true);
    });
});

describe('verification-queue mutation kills', () => {
    beforeEach(() => {
        installLocalStorage();
        resetVerificationQueueForTests();
        setActivePlayerOwnerId('reddit:racer');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        clearActivePlayerOwnerId();
        delete globalThis.window;
    });

    it('derives legacy expiry only from anchored daily-gp date ids', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        const playlistMs = 7 * 24 * 60 * 60 * 1000;
        const bufferMs = 6 * 60 * 60 * 1000;
        const startsAt = Date.parse('2026-07-18T00:00:00.000Z');
        const expectedExpiry = new Date(startsAt + playlistMs + bufferMs).toISOString();
        const future = Date.now() + 120_000;

        installLocalStorage({
            [STORAGE_KEY]: JSON.stringify({
                daily: {
                    'daily-gp-2026-07-18': {
                        challengeId: 'daily-gp-2026-07-18',
                        bestTime: 20,
                        replay: REPLAY,
                        verificationState: 'pending',
                        nextAttemptAt: Date.now() + 60_000,
                    },
                    'prefix-daily-gp-2026-07-18': {
                        challengeId: 'prefix-daily-gp-2026-07-18',
                        bestTime: 21,
                        replay: REPLAY,
                        verificationState: 'pending',
                        nextAttemptAt: Date.now() + 60_000,
                        expiresAt: new Date(future).toISOString(),
                    },
                    'daily-gp-2026-07-18-suffix': {
                        challengeId: 'daily-gp-2026-07-18-suffix',
                        bestTime: 22,
                        replay: REPLAY,
                        verificationState: 'pending',
                        nextAttemptAt: Date.now() + 60_000,
                        expiresAt: new Date(future).toISOString(),
                    },
                },
            }),
        });

        expect(getDailyChallengeVerificationEntry('daily-gp-2026-07-18')?.expiresAt).toBe(expectedExpiry);
        expect(getDailyChallengeVerificationEntry('prefix-daily-gp-2026-07-18')?.expiresAt)
            .toBe(new Date(future).toISOString());
        expect(getDailyChallengeVerificationEntry('daily-gp-2026-07-18-suffix')?.expiresAt)
            .toBe(new Date(future).toISOString());
    });

    it('treats expiry at exactly now as expired on both read and enqueue', () => {
        const now = Date.parse('2026-07-18T12:00:00.000Z');
        vi.spyOn(Date, 'now').mockReturnValue(now);

        expect(isDailyChallengeVerificationExpired({ expiresAt: '2026-07-18T12:00:00.000Z' }, now)).toBe(true);
        expect(isDailyChallengeVerificationExpired({ expiresAt: '2026-07-18T12:00:01.000Z' }, now)).toBe(false);

        installLocalStorage({
            [STORAGE_KEY]: JSON.stringify({
                daily: {
                    'expires-now': {
                        challengeId: 'expires-now',
                        bestTime: 20,
                        replay: REPLAY,
                        verificationState: 'pending',
                        nextAttemptAt: now + 60_000,
                        expiresAt: '2026-07-18T12:00:00.000Z',
                    },
                },
            }),
        });
        expect(getDailyChallengeVerificationEntry('expires-now')).toBeNull();

        expect(enqueueDailyChallengeVerification({
            challengeId: 'enqueue-at-now',
            bestTime: 20,
            replay: REPLAY,
            expiresAt: '2026-07-18T12:00:00.000Z',
        })).toEqual({ enqueued: false, entry: null });
    });

    it('returns empty queue state when window or localStorage is unavailable', () => {
        delete globalThis.window;
        expect(getDailyChallengeVerificationEntry('missing')).toBeNull();
        expect(getDueDailyChallengeVerifications()).toEqual([]);

        installLocalStorage({ [STORAGE_KEY]: 'not-json' });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(getDailyChallengeVerificationEntry('missing')).toBeNull();
        expect(consoleError).toHaveBeenCalled();
    });

    it('normalizes unknown stages to pending and maps terminal states from verificationState', () => {
        expect(createVerificationSnapshot({
            submissionStage: 'bogus',
            verificationState: 'bogus',
        })).toMatchObject({
            verificationState: 'pending',
            submissionStage: 'pending',
            statusText: 'Pending',
        });

        expect(createVerificationSnapshot({
            verificationState: 'rejected',
            submissionStage: 'bogus',
        })).toMatchObject({
            verificationState: 'rejected',
            submissionStage: 'rejected',
            statusText: 'Rejected',
        });

        expect(createVerificationSnapshot({
            verificationState: 'error',
            submissionStage: 'bogus',
        })).toMatchObject({
            verificationState: 'error',
            submissionStage: 'error',
            statusText: 'Submission failed',
        });
    });

    it('prefers trimmed fallback status text over stage defaults', () => {
        expect(createVerificationSnapshot({
            submissionStage: 'submitting',
            statusText: '  Uploading replay  ',
        })).toMatchObject({
            statusText: 'Uploading replay',
            submissionStage: 'submitting',
        });
        expect(createVerificationSnapshot({
            submissionStage: 'verifying',
            statusText: '   ',
        })).toMatchObject({
            statusText: 'Verifying...',
        });
    });

    it('clones replay objects and rejects non-object entries on read', () => {
        enqueueDailyChallengeVerification({
            challengeId: 'clone-replay',
            bestTime: 20,
            replay: REPLAY,
        });
        const entry = getDailyChallengeVerificationEntry('clone-replay');
        entry.replay.inputs[0].frames = 99;
        expect(getDailyChallengeVerificationEntry('clone-replay').replay.inputs[0].frames).toBe(1);

        installLocalStorage({
            [STORAGE_KEY]: JSON.stringify({
                daily: {
                    'bad-replay': {
                        challengeId: 'bad-replay',
                        bestTime: 20,
                        replay: 'not-an-object',
                        verificationState: 'pending',
                        submissionStage: 'pending',
                        nextAttemptAt: Date.now() + 60_000,
                        expiresAt: '2099-01-01T00:00:00.000Z',
                    },
                },
            }),
        });
        expect(getDailyChallengeVerificationEntry('bad-replay').replay).toBeNull();
    });

    it('rejects invalid enqueue input and clamps negative completed laps to zero', () => {
        expect(enqueueDailyChallengeVerification({
            challengeId: '',
            bestTime: 20,
            replay: REPLAY,
        })).toEqual({ enqueued: false, entry: null });
        expect(enqueueDailyChallengeVerification({
            challengeId: 'valid',
            bestTime: Number.NaN,
            replay: REPLAY,
        })).toEqual({ enqueued: false, entry: null });

        enqueueDailyChallengeVerification({
            challengeId: 'clamp-laps',
            bestTime: 20,
            completedLaps: -3,
            replay: REPLAY,
            objectiveType: 7,
            challengeDate: 7,
            trackKey: 7,
        });
        expect(getDailyChallengeVerificationEntry('clamp-laps')).toMatchObject({
            completedLaps: 0,
            objectiveType: null,
            challengeDate: null,
            trackKey: null,
            verificationState: 'pending',
            submissionStage: 'submitting',
            statusText: 'Submitting...',
        });
    });

    it('filters due entries by pending state and finite nextAttemptAt', () => {
        const now = Date.now();
        enqueueDailyChallengeVerification({ challengeId: 'due-1', bestTime: 20, replay: REPLAY });
        enqueueDailyChallengeVerification({ challengeId: 'due-2', bestTime: 21, replay: REPLAY });
        markDailyChallengeVerificationPending('due-1', now - 1);
        markDailyChallengeVerificationPending('due-2', now + 60_000);
        markDailyChallengeVerificationRejected('due-2');

        expect(getDueDailyChallengeVerifications(now)).toHaveLength(1);
        expect(getDueDailyChallengeVerifications(now)[0].challengeId).toBe('due-1');
    });

    it('exposes fixed stage labels for submitting and verifying snapshots', () => {
        enqueueDailyChallengeVerification({ challengeId: 'stage-labels', bestTime: 20, replay: REPLAY });
        expect(getVerificationSnapshotFromQueueEntry(getDailyChallengeVerificationEntry('stage-labels'))).toMatchObject({
            submissionStage: 'submitting',
            statusText: 'Submitting...',
            isLoading: true,
        });

        markDailyChallengeVerificationPending('stage-labels', Date.now() + 60_000, { submissionStage: 'verifying' });
        expect(getVerificationSnapshotFromQueueEntry(getDailyChallengeVerificationEntry('stage-labels'))).toMatchObject({
            submissionStage: 'verifying',
            statusText: 'Verifying...',
        });
    });

    it('clears expired enqueue attempts and preserves custom error text', () => {
        enqueueDailyChallengeVerification({ challengeId: 'to-clear', bestTime: 20, replay: REPLAY });
        clearDailyChallengeVerification('to-clear');
        expect(getDailyChallengeVerificationEntry('to-clear')).toBeNull();

        enqueueDailyChallengeVerification({ challengeId: 'error-copy', bestTime: 20, replay: REPLAY });
        markDailyChallengeVerificationError('error-copy', '  Network timeout  ');
        expect(getDailyChallengeVerificationEntry('error-copy')).toMatchObject({
            verificationState: 'error',
            statusText: 'Network timeout',
        });
        expect(getVerificationSnapshotFromQueueEntry(getDailyChallengeVerificationEntry('error-copy'))).toMatchObject({
            isLoading: false,
        });
        expect(getVerificationSnapshotFromQueueEntry(null)).toBeNull();
    });
});
