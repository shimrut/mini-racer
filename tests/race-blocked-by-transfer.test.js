import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { campaignEngineMethods } from '../game/campaign/engine-methods.js';
import { dailyChallengeEngineMethods } from '../game/daily-challenge/engine-methods.js';
import { headToHeadEngineMethods } from '../game/head-to-head/engine-methods.js';
import { modeRouterEngineMethods } from '../game/modes/engine-methods.js';
import { raceEngineMethods } from '../game/race/engine-methods.js';
import {
    clearVerificationQueueTransferBlock,
    recordVerificationQueueTransferBlock,
    resetVerificationQueueForTests,
} from '../game/scoreboard/verification-queue.js';
import {
    clearActivePlayerOwnerId,
    setActivePlayerOwnerId,
} from '../game/player/active-owner.js';

const GUEST = 'guest:mid-transfer';
const ACCOUNT = 'reddit:mid-transfer';

function installLocalStorage() {
    const map = new Map();
    globalThis.window = {
        localStorage: {
            getItem: (key) => (map.has(key) ? map.get(key) : null),
            setItem: (key, value) => map.set(key, value),
            removeItem: (key) => map.delete(key),
        },
    };
}

function blockTransfer() {
    recordVerificationQueueTransferBlock({
        transferId: 'guest-transfer:abc',
        guestPlayerId: GUEST,
        accountPlayerId: ACCOUNT,
        state: 'resume_required',
    });
}

describe('an open transfer stops every way into a race', () => {
    beforeEach(() => {
        installLocalStorage();
        resetVerificationQueueForTests();
        setActivePlayerOwnerId(ACCOUNT);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        clearActivePlayerOwnerId();
        delete globalThis.window;
    });

    it('stops the Campaign stage start', async () => {
        const engine = {
            ...campaignEngineMethods,
            startButtonPending: false,
            lobbyUi: { clearRaceStartError: vi.fn() },
            clearRaceComparisonTarget: vi.fn(),
        };
        blockTransfer();

        await expect(engine.startCampaignStage('numbered-v1-00')).resolves.toBe(null);
        expect(engine.lobbyUi.clearRaceStartError).not.toHaveBeenCalled();
    });

    it('stops the Daily start', async () => {
        const engine = {
            ...dailyChallengeEngineMethods,
            lobbyUi: { clearRaceStartError: vi.fn() },
            clearRaceComparisonTarget: vi.fn(),
        };
        blockTransfer();

        await expect(engine.handleStartDailyChallenge()).resolves.toBe(null);
        expect(engine.lobbyUi.clearRaceStartError).not.toHaveBeenCalled();
    });

    it('stops the Head to Head start', async () => {
        const engine = {
            ...headToHeadEngineMethods,
            activeHeadToHead: { challengeId: 'challenge-1' },
            startButtonPending: false,
        };
        blockTransfer();

        await expect(engine.startHeadToHead()).resolves.toBe(null);
        expect(engine.startButtonPending).toBe(false);
    });

    it('stops a retry of the active race', () => {
        const engine = {
            ...modeRouterEngineMethods,
            activeRaceMode: 'daily',
            restartDailyChallenge: vi.fn(),
        };
        blockTransfer();

        engine.restartActiveRace();

        expect(engine.restartDailyChallenge).not.toHaveBeenCalled();
    });

    it('stops the simulation itself, which is the last gate before a race runs', () => {
        const engine = {
            ...raceEngineMethods,
            status: 'ready',
            beginPbGhostSizeRun: vi.fn(),
        };
        blockTransfer();

        engine.startSequence();

        expect(engine.beginPbGhostSizeRun).not.toHaveBeenCalled();
        expect(engine.status).toBe('ready');
    });

    it('lets the simulation start again once the transfer is resolved', () => {
        const engine = {
            ...raceEngineMethods,
            status: 'ready',
            beginPbGhostSizeRun: vi.fn(),
        };
        blockTransfer();
        engine.startSequence();
        expect(engine.beginPbGhostSizeRun).not.toHaveBeenCalled();

        clearVerificationQueueTransferBlock(ACCOUNT);
        // The gate is the first thing startSequence does. Past it, this bare stub runs out of
        // engine, which is exactly the proof that the gate no longer stopped it.
        try {
            engine.startSequence();
        } catch {
            // Not the gate's doing.
        }

        expect(engine.beginPbGhostSizeRun).toHaveBeenCalled();
    });

    it('does not stop a different account that has no transfer', () => {
        const engine = {
            ...raceEngineMethods,
            status: 'ready',
            beginPbGhostSizeRun: vi.fn(),
        };
        blockTransfer();
        setActivePlayerOwnerId('reddit:unaffected');

        try {
            engine.startSequence();
        } catch {
            // Past the gate, and past what this stub can answer.
        }

        expect(engine.beginPbGhostSizeRun).toHaveBeenCalled();
    });
});
