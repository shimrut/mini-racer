import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const PLAYER_ID_KEY = 'VectorGpScoreboardPlayerId';
const GUEST_TOKEN_KEY = 'VectorGpGuestPlayerToken';
const QUEUE_KEY = 'VectorGpVerificationQueue';
const BLOCKS_KEY = 'VectorGpTransferBlocks';

const ACCOUNT = 'reddit:racefan';
const GUEST = 'guest:chooser';

function response(status, payload) {
    return { ok: status >= 200 && status < 300, status, json: vi.fn(async () => payload) };
}

function chooserBootstrap() {
    return {
        hasAnyData: true,
        isReturningPlayer: true,
        redditUsername: 'RaceFan',
        playerId: ACCOUNT,
        guestToken: 'guest-token',
        leaderboardIdentity: 'reddit',
        playerPreferences: null,
        carUnlocks: null,
        retireGuestIdentity: false,
        progressSelection: {
            required: true,
            transferId: 'guest-transfer:chooser',
            sourceGuestPlayerId: GUEST,
            guestHasProgress: true,
            accountHasProgress: true,
            guestSummary: { campaignUnlockedTracks: 2, campaignTotalStages: 16 },
            accountSummary: { campaignUnlockedTracks: 5, campaignTotalStages: 16 },
        },
    };
}

function installDom({ failWriteKeys = new Set() } = {}) {
    const dom = new JSDOM('<body></body>', { url: 'https://example.devvit.net/game.html' });
    const store = new Map([[PLAYER_ID_KEY, 'chooser'], [GUEST_TOKEN_KEY, 'guest-token']]);
    const storage = {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => {
            if (failWriteKeys.has(key)) throw new Error('quota exceeded');
            store.set(key, String(value));
        },
        removeItem: (key) => { store.delete(key); },
    };
    Object.defineProperty(dom.window, 'localStorage', { configurable: true, get: () => storage });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'fresh-guest') });
    return { dom, store };
}

describe('the Keep Progress chooser when the queue receipt cannot be saved', () => {
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('settles instead of stranding startup behind a dialog with no way forward', async () => {
        const { dom, store } = installDom({ failWriteKeys: new Set([QUEUE_KEY]) });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => response(200, chooserBootstrap())));

        const { getPlayerProgressState } = await import('../game/player/progress-state.js');
        const statePromise = getPlayerProgressState();
        statePromise.catch(() => {});

        await vi.waitFor(() => {
            expect(dom.window.document.querySelector('.guest-progress-selection')).not.toBeNull();
        });
        expect(store.has(BLOCKS_KEY)).toBe(true);

        const continueButton = [...dom.window.document.querySelectorAll('.guest-progress-selection__button')]
            .find((button) => /CONTINUE|MERGE/.test(button.textContent));
        continueButton.click();

        await vi.waitFor(() => {
            expect(dom.window.document.querySelector('.server-sync-failure')).not.toBeNull();
        });
        const actions = [...dom.window.document.querySelectorAll('.server-sync-failure .guest-progress-selection__button')];
        expect(actions).toHaveLength(1);
        expect(actions[0].textContent).toContain('RETRY SYNC');
        expect(store.has(BLOCKS_KEY)).toBe(true);
    });

    it('still opens the chooser when only the block write would fail, and refuses earlier', async () => {
        const { dom } = installDom({ failWriteKeys: new Set([BLOCKS_KEY]) });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => response(200, chooserBootstrap())));

        const { getPlayerProgressState } = await import('../game/player/progress-state.js');
        const statePromise = getPlayerProgressState();
        statePromise.catch(() => {});

        await vi.waitFor(() => {
            expect(dom.window.document.querySelector('.server-sync-failure')).not.toBeNull();
        });
        expect(dom.window.document.querySelector('.guest-progress-selection__sources')).toBeNull();
    });
});
