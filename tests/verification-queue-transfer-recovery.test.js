import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    claimVerificationEntriesForOwner,
    clearVerificationQueueTransferBlock,
    enqueueDailyChallengeVerification,
    getDueDailyChallengeVerifications,
    getNextVerificationAttemptAt,
    isVerificationQueueSubmissionBlocked,
    prepareVerificationQueueGuestProgressReconciliation,
    readVerificationQueueTransferBlock,
    recordVerificationQueueTransferBlock,
    resetVerificationQueueForTests,
    resolveVerificationQueueAfterGuestProgressSelection,
} from '../game/scoreboard/verification-queue.js';
import {
    clearActivePlayerOwnerId,
    setActivePlayerOwnerId,
} from '../game/player/active-owner.js';

const GUEST = 'guest:transferring';
const ACCOUNT = 'reddit:transferring';
const OTHER_ACCOUNT = 'reddit:somebody-else';
const STORAGE_KEY = 'VectorGpVerificationQueue';
const REPLAY = { inputs: [{ frames: 1, left: false, right: false }] };

function installLocalStorage() {
    const map = new Map();
    globalThis.window = {
        localStorage: {
            getItem: (key) => (map.has(key) ? map.get(key) : null),
            setItem: (key, value) => map.set(key, value),
            removeItem: (key) => map.delete(key),
            _map: map,
        },
    };
    return map;
}

function readStoredQueue() {
    return JSON.parse(globalThis.window.localStorage.getItem(STORAGE_KEY));
}

/** Rewrites storage the way another tab would, behind this module's back. */
function writeStoredQueue(queueState) {
    globalThis.window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queueState));
}

/** Reads one queued entry by owner, without depending on who is active right now. */
function storedEntry(ownerPlayerId, challengeId) {
    return readStoredQueue().daily[`${ownerPlayerId}::${challengeId}`] ?? null;
}

function queueRun(ownerPlayerId, challengeId, bestTime) {
    setActivePlayerOwnerId(ownerPlayerId);
    enqueueDailyChallengeVerification({ challengeId, bestTime, replay: REPLAY });
}

describe('transfer blocking is durable and scoped to its owners', () => {
    beforeEach(() => {
        installLocalStorage();
        resetVerificationQueueForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        clearActivePlayerOwnerId();
        delete globalThis.window;
    });

    it('survives a reload, because it lives in storage and not in memory', () => {
        setActivePlayerOwnerId(ACCOUNT);
        recordVerificationQueueTransferBlock({
            transferId: 'guest-transfer:abc',
            guestPlayerId: GUEST,
            accountPlayerId: ACCOUNT,
            state: 'resume_required',
        });
        const persisted = readStoredQueue();

        // A reload keeps the storage and loses every module variable.
        vi.resetModules();
        writeStoredQueue(persisted);

        expect(isVerificationQueueSubmissionBlocked()).toBe(true);
        expect(readVerificationQueueTransferBlock(ACCOUNT)).toMatchObject({
            guestPlayerId: GUEST,
            state: 'resume_required',
        });
    });

    it('blocks the account and the source guest, and nobody else', () => {
        recordVerificationQueueTransferBlock({
            transferId: 'guest-transfer:abc',
            guestPlayerId: GUEST,
            accountPlayerId: ACCOUNT,
        });

        expect(isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);
        expect(isVerificationQueueSubmissionBlocked(GUEST)).toBe(true);
        expect(isVerificationQueueSubmissionBlocked(OTHER_ACCOUNT)).toBe(false);
    });

    it('does not let another account inherit the first account\'s transfer', () => {
        recordVerificationQueueTransferBlock({
            guestPlayerId: GUEST,
            accountPlayerId: ACCOUNT,
        });
        queueRun(OTHER_ACCOUNT, 'unrelated-race', 12);

        setActivePlayerOwnerId(OTHER_ACCOUNT);
        expect(isVerificationQueueSubmissionBlocked()).toBe(false);
        expect(getDueDailyChallengeVerifications().map((entry) => entry.challengeId))
            .toEqual(['unrelated-race']);
    });

    it('holds the queue while the block stands, and releases it when cleared', () => {
        queueRun(ACCOUNT, 'blocked-race', 12);
        recordVerificationQueueTransferBlock({
            guestPlayerId: GUEST,
            accountPlayerId: ACCOUNT,
        });

        expect(getDueDailyChallengeVerifications()).toEqual([]);
        expect(getNextVerificationAttemptAt()).toBe(null);

        clearVerificationQueueTransferBlock(ACCOUNT);

        expect(getDueDailyChallengeVerifications().map((entry) => entry.challengeId))
            .toEqual(['blocked-race']);
    });

    it('sees a block another tab wrote after this tab last read storage', () => {
        queueRun(ACCOUNT, 'in-flight-race', 12);
        expect(getDueDailyChallengeVerifications()).toHaveLength(1);

        const queueState = readStoredQueue();
        queueState.transferBlocks = {
            [ACCOUNT]: { accountPlayerId: ACCOUNT, guestPlayerId: GUEST, state: 'resume_required' },
        };
        writeStoredQueue(queueState);

        expect(getDueDailyChallengeVerifications()).toEqual([]);
    });

    it('waits when it does not yet know who this browser is', () => {
        recordVerificationQueueTransferBlock({
            guestPlayerId: GUEST,
            accountPlayerId: ACCOUNT,
        });

        expect(isVerificationQueueSubmissionBlocked(null)).toBe(true);
    });
});

describe('queue reconciliation acts only on what it can prove', () => {
    beforeEach(() => {
        installLocalStorage();
        resetVerificationQueueForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        clearActivePlayerOwnerId();
        delete globalThis.window;
    });

    function prepare(choice) {
        return prepareVerificationQueueGuestProgressReconciliation({
            transferId: 'guest-transfer:abc',
            guestPlayerId: GUEST,
            accountPlayerId: ACCOUNT,
            choice,
        });
    }

    function resolve(choice, overrides = {}) {
        return resolveVerificationQueueAfterGuestProgressSelection({
            transferId: 'guest-transfer:abc',
            guestPlayerId: GUEST,
            accountPlayerId: ACCOUNT,
            choice,
            ...overrides,
        });
    }

    it('moves the captured guest entries and leaves later ones alone', () => {
        queueRun(GUEST, 'captured-race', 12);
        expect(prepare('guest').prepared).toBe(true);
        // Raced after the choice was captured, so it was never part of the selection.
        queueRun(GUEST, 'later-race', 11);

        const result = resolve('guest');

        expect(result.moved).toBe(1);
        expect(storedEntry(ACCOUNT, 'captured-race')).toMatchObject({ ownerPlayerId: ACCOUNT });
        expect(storedEntry(GUEST, 'later-race')).toMatchObject({ ownerPlayerId: GUEST });
    });

    it('keeps a captured entry that changed before the transfer finished', () => {
        queueRun(GUEST, 'edited-race', 12);
        expect(prepare('guest').prepared).toBe(true);
        // A faster run replaced the captured one under the same key.
        queueRun(GUEST, 'edited-race', 9);

        const result = resolve('guest');

        expect(result.moved).toBe(0);
        expect(result.preserved).toBe(1);
        expect(storedEntry(GUEST, 'edited-race'))
            .toMatchObject({ ownerPlayerId: GUEST, bestTime: 9 });
    });

    it('never touches an unrelated owner\'s queue', () => {
        queueRun(GUEST, 'guest-race', 12);
        queueRun('guest:someone-else', 'stranger-race', 12);
        expect(prepare('account').prepared).toBe(true);

        resolve('account');

        expect(storedEntry('guest:someone-else', 'stranger-race'))
            .toMatchObject({ ownerPlayerId: 'guest:someone-else' });
    });

    it('refuses a second, different choice for the same transfer', () => {
        queueRun(GUEST, 'locked-race', 12);
        expect(prepare('guest')).toMatchObject({ prepared: true });

        expect(prepare('account')).toMatchObject({ prepared: false, choiceLocked: true });
    });

    it('handles a repeated completion without moving anything twice', () => {
        queueRun(GUEST, 'idempotent-race', 12);
        prepare('guest');

        expect(resolve('guest').moved).toBe(1);
        const afterFirst = readStoredQueue();
        expect(resolve('guest')).toMatchObject({ completed: true, moved: 0 });
        expect(readStoredQueue().daily).toEqual(afterFirst.daily);
    });

    it('reports a storage failure as unresolved, not as success', () => {
        queueRun(GUEST, 'unwritable-race', 12);
        prepare('guest');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        globalThis.window.localStorage.setItem = () => {
            throw new Error('quota exceeded');
        };

        expect(resolve('guest')).toMatchObject({ persisted: false });
    });

    it('quarantines ambiguous entries when the receipt is missing, and records that decision', () => {
        // No prepare() ran here: this is another device, or a browser that lost its receipt.
        queueRun(GUEST, 'unprovable-race', 12);

        const result = resolve('guest', { completedAt: new Date(Date.now() + 60_000).toISOString() });

        expect(result).toMatchObject({ missingReceipt: true, quarantined: 1, completed: true });
        expect(storedEntry(GUEST, 'unprovable-race')).toMatchObject({
            verificationState: 'error',
            transferRecoveryRequired: true,
        });
        expect(readStoredQueue().transferReconciliations['guest-transfer:abc'].completedAt)
            .toEqual(expect.any(String));
    });

    it('keeps a quarantined entry out of submission and out of owner claiming', () => {
        queueRun(GUEST, 'quarantined-race', 12);
        resolve('guest', { completedAt: new Date(Date.now() + 60_000).toISOString() });

        setActivePlayerOwnerId(ACCOUNT);
        expect(getDueDailyChallengeVerifications()).toEqual([]);

        claimVerificationEntriesForOwner(ACCOUNT);
        expect(storedEntry(GUEST, 'quarantined-race'))
            .toMatchObject({ ownerPlayerId: GUEST, transferRecoveryRequired: true });
    });

    it('lets a correctly owned new result save once the quarantine decision is durable', () => {
        queueRun(GUEST, 'quarantined-race', 12);
        resolve('guest', { completedAt: new Date(Date.now() + 60_000).toISOString() });
        clearVerificationQueueTransferBlock(ACCOUNT);

        queueRun(ACCOUNT, 'fresh-race', 10);

        expect(getDueDailyChallengeVerifications().map((entry) => entry.challengeId))
            .toEqual(['fresh-race']);
    });

    it('does not claim an entry an unfinished reconciliation still names', () => {
        queueRun(GUEST, 'in-flight-race', 12);
        prepare('guest');

        claimVerificationEntriesForOwner(ACCOUNT);

        expect(storedEntry(GUEST, 'in-flight-race')).toMatchObject({ ownerPlayerId: GUEST });
    });
});
