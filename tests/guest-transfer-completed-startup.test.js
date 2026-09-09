import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const PLAYER_ID_KEY = 'VectorGpScoreboardPlayerId';
const GUEST_TOKEN_KEY = 'VectorGpGuestPlayerToken';
const QUEUE_KEY = 'VectorGpVerificationQueue';
const BLOCKS_KEY = 'VectorGpTransferBlocks';
const DAILY_DATA_KEY = 'VectorGpDailyChallengeData';

const ACCOUNT = 'reddit:racefan';
const GUEST = 'guest:transferred-away';
const TRANSFER_ID = 'guest-transfer:completed-elsewhere';

function response(status, payload) {
    return { ok: status >= 200 && status < 300, status, json: vi.fn(async () => payload) };
}

/** What bootstrap returns to a browser whose transfer finished while it was not looking. */
function completedBootstrap() {
    return {
        hasAnyData: true,
        isReturningPlayer: true,
        redditUsername: 'RaceFan',
        playerId: ACCOUNT,
        guestToken: null,
        leaderboardIdentity: 'reddit',
        playerPreferences: { carSkin: 'assets/cars/mr_extra_crimson.webp' },
        carUnlocks: null,
        retireGuestIdentity: false,
        progressSelection: {
            required: true,
            state: 'completed',
            choice: 'account',
            transferId: TRANSFER_ID,
            sourceGuestPlayerId: GUEST,
            completedAt: new Date().toISOString(),
        },
    };
}

function installDom() {
    const dom = new JSDOM('<body></body>', { url: 'https://example.devvit.net/game.html' });
    dom.window.localStorage.setItem(PLAYER_ID_KEY, 'transferred-away');
    dom.window.localStorage.setItem(GUEST_TOKEN_KEY, 'guest-token');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('localStorage', dom.window.localStorage);
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'fresh-guest') });
    return dom;
}

describe('a completed transfer reported at startup', () => {
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('reconciles once, keeps the account authoritative, and lifts the block', async () => {
        const dom = installDom();
        vi.stubGlobal('fetch', vi.fn(async () => response(200, completedBootstrap())));

        const { getPlayerProgressState } = await import('../game/storage.js');
        const state = await getPlayerProgressState();

        // The account must survive the completed path. Nulling it here is what silently skipped
        // reconciliation, stranded the block, and left the player with no profile.
        expect(state.leaderboardPlayerId).toBe(ACCOUNT);
        expect(state.authoritative).toBe(true);
        expect(dom.window.localStorage.getItem(BLOCKS_KEY) || '{}').not.toContain(ACCOUNT);

        const { isVerificationQueueSubmissionBlocked } = await import(
            '../game/scoreboard/verification-queue.js'
        );
        expect(isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(false);
    });

    it('does not wipe local Daily data again on the next launch', async () => {
        const dom = installDom();
        vi.stubGlobal('fetch', vi.fn(async () => response(200, completedBootstrap())));

        const { getPlayerProgressState } = await import('../game/storage.js');
        await getPlayerProgressState();

        // The player races again. The server keeps reporting the same completion.
        dom.window.localStorage.setItem(DAILY_DATA_KEY, JSON.stringify({ kept: true }));
        await getPlayerProgressState();

        expect(dom.window.localStorage.getItem(DAILY_DATA_KEY)).toBe(JSON.stringify({ kept: true }));
    });

    it('quarantines rather than deletes a queued run it cannot prove belongs to the transfer', async () => {
        const dom = installDom();
        dom.window.localStorage.setItem(QUEUE_KEY, JSON.stringify({
            daily: {
                [`${GUEST}::unprovable-race`]: {
                    challengeId: 'unprovable-race',
                    ownerPlayerId: GUEST,
                    bestTime: 12,
                    replay: { inputs: [] },
                    verificationState: 'pending',
                    nextAttemptAt: Date.now(),
                    updatedAt: new Date(Date.now() - 60_000).toISOString(),
                    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
                },
            },
            campaign: {},
        }));
        vi.stubGlobal('fetch', vi.fn(async () => response(200, completedBootstrap())));

        const { getPlayerProgressState } = await import('../game/storage.js');
        await getPlayerProgressState();

        const queue = JSON.parse(dom.window.localStorage.getItem(QUEUE_KEY));
        const entry = queue.daily[`${GUEST}::unprovable-race`];
        expect(entry).toBeTruthy();
        expect(entry.transferRecoveryRequired).toBe(true);
    });
});
