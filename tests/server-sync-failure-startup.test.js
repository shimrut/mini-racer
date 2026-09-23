import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const PLAYER_ID_KEY = 'VectorGpScoreboardPlayerId';
const GUEST_TOKEN_KEY = 'VectorGpGuestPlayerToken';

function response(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: vi.fn(async () => payload),
    };
}

describe('server synchronization failure at launch', () => {
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    it('lets Continue Offline use the last saved account without another fetch', async () => {
        const dom = new JSDOM('<body class="loading-active"></body>', {
            url: 'https://example.devvit.net/game.html',
        });
        dom.window.localStorage.setItem(PLAYER_ID_KEY, 'phone-guest');
        vi.stubGlobal('window', dom.window);
        vi.stubGlobal('document', dom.window.document);
        vi.stubGlobal('localStorage', dom.window.localStorage);
        const fetchMock = vi.fn().mockResolvedValue(response(500));
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const { getPlayerProgressState } = await import('../game/player/progress-state.js');
        const statePromise = getPlayerProgressState({ promptOnSyncFailure: true });
        await vi.waitFor(() => {
            expect(document.querySelector('.server-sync-failure')).not.toBeNull();
        });
        expect(document.querySelector('#server-sync-failure-title').textContent)
            .toBe('SERVER SYNCHRONIZATION FAILED');

        document.querySelector('[data-choice="offline"]').click();
        const state = await statePromise;

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(state).toMatchObject({
            authoritative: false,
            leaderboardPlayerId: 'phone-guest',
        });
        expect(document.querySelector('.server-sync-failure')).toBeNull();
    });

    it('retries identity from Retry Sync and continues when it answers', async () => {
        const dom = new JSDOM('<body class="loading-active"></body>', {
            url: 'https://example.devvit.net/game.html',
        });
        dom.window.localStorage.setItem(PLAYER_ID_KEY, 'phone-guest');
        vi.stubGlobal('window', dom.window);
        vi.stubGlobal('document', dom.window.document);
        vi.stubGlobal('localStorage', dom.window.localStorage);
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response(500))
            .mockResolvedValueOnce(response(200, {
                playerId: 'reddit:racer',
                redditUsername: 'racer',
                hasAnyData: true,
                isReturningPlayer: true,
            }));
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const { getPlayerProgressState } = await import('../game/player/progress-state.js');
        const statePromise = getPlayerProgressState({ promptOnSyncFailure: true });
        await vi.waitFor(() => {
            expect(document.querySelector('[data-choice="retry"]')).not.toBeNull();
        });

        document.querySelector('[data-choice="retry"]').click();
        const state = await statePromise;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(state).toMatchObject({
            authoritative: true,
            leaderboardPlayerId: 'reddit:racer',
            redditUsername: 'racer',
        });
        expect(document.querySelector('.server-sync-failure')).toBeNull();
    });

    it('keeps the prompt up when Retry Sync still fails', async () => {
        const dom = new JSDOM('<body class="loading-active"></body>', {
            url: 'https://example.devvit.net/game.html',
        });
        vi.stubGlobal('window', dom.window);
        vi.stubGlobal('document', dom.window.document);
        vi.stubGlobal('localStorage', dom.window.localStorage);
        const fetchMock = vi.fn().mockResolvedValue(response(500));
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const { getPlayerProgressState } = await import('../game/player/progress-state.js');
        const statePromise = getPlayerProgressState({ promptOnSyncFailure: true });
        await vi.waitFor(() => {
            expect(document.querySelector('.server-sync-failure')).not.toBeNull();
        });

        document.querySelector('[data-choice="retry"]').click();
        await vi.waitFor(() => {
            expect(document.querySelector('.guest-progress-selection__status').textContent)
                .toMatch(/still could not sync/i);
        });

        expect(statePromise).toBeInstanceOf(Promise);
        document.querySelector('[data-choice="offline"]').click();
        await statePromise;
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
