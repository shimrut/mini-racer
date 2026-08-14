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

describe('promoted guest startup selection', () => {
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        vi.doUnmock('../game/scoreboard/verification-queue.js');
    });

    it('hands off the loader before asking and uses the POST bootstrap without another GET', async () => {
        const dom = new JSDOM('<body class="loading-active"></body>', {
            url: 'https://example.devvit.net/game.html',
        });
        dom.window.localStorage.setItem(PLAYER_ID_KEY, 'promoted-guest');
        dom.window.localStorage.setItem(GUEST_TOKEN_KEY, 'guest-token');
        vi.stubGlobal('window', dom.window);
        vi.stubGlobal('document', dom.window.document);
        vi.stubGlobal('localStorage', dom.window.localStorage);
        vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'new-guest') });

        const selectedState = {
            hasAnyData: true,
            isReturningPlayer: true,
            redditUsername: 'RaceFan',
            playerId: 'reddit:racefan',
            guestToken: null,
            leaderboardIdentity: 'reddit',
            playerPreferences: { carSkin: 'assets/cars/mr_extra_crimson.webp' },
            progressSelection: { required: false },
        };
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response(200, {
                ...selectedState,
                playerId: 'reddit:racefan',
                guestToken: 'guest-token',
                progressSelection: {
                    required: true,
                    guestHasProgress: true,
                    accountHasProgress: true,
                    guestSummary: { hasDailyResults: true, campaignResults: 1, unlocks: true },
                    accountSummary: { hasDailyResults: true, campaignResults: 2, unlocks: true },
                },
            }))
            .mockResolvedValueOnce(response(200, selectedState));
        vi.stubGlobal('fetch', fetchMock);

        const { getPlayerProgressState } = await import('../game/storage.js');
        const statePromise = getPlayerProgressState({
            onProgressSelectionRequired: async () => {
                document.body.classList.remove('loading-active');
            },
        });
        await vi.waitFor(() => {
            expect(document.querySelector('.guest-progress-selection')).not.toBeNull();
        });

        expect(document.body.classList.contains('loading-active')).toBe(false);
        document.querySelector('[data-choice="guest"]').click();
        const state = await statePromise;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' });
        expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
            playerId: 'promoted-guest',
            guestToken: 'guest-token',
            choice: 'guest',
        });
        expect(state).toMatchObject({
            authoritative: true,
            redditUsername: 'RaceFan',
            leaderboardPlayerId: 'reddit:racefan',
        });
    });

    it('never asks a signed-out guest to resolve account progress because of a queued guest run', async () => {
        const requestGuestProgressSelection = vi.fn();
        vi.doMock('../game/player/guest-progress-selection.js', () => ({
            requestGuestProgressSelection,
        }));
        vi.doMock('../game/scoreboard/verification-queue.js', async () => {
            const actual = await vi.importActual('../game/scoreboard/verification-queue.js');
            return {
                ...actual,
                hasVerificationEntriesForOwner: vi.fn(() => true),
            };
        });
        const localStorage = new Map([
            [PLAYER_ID_KEY, 'guest-player'],
            [GUEST_TOKEN_KEY, 'guest-token'],
        ]);
        vi.stubGlobal('window', {
            location: {
                hostname: 'example.devvit.net',
                origin: 'https://example.devvit.net',
                protocol: 'https:',
            },
            localStorage: {
                getItem: (key) => localStorage.get(key) ?? null,
                setItem: (key, value) => localStorage.set(key, String(value)),
                removeItem: (key) => localStorage.delete(key),
            },
        });
        vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'new-guest') });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, {
            playerId: 'guest:guest-player',
            guestToken: 'guest-token',
            redditUsername: null,
            hasAnyData: true,
        })));

        const { getPlayerProgressState } = await import('../game/storage.js');
        const state = await getPlayerProgressState();

        expect(state.authoritative).toBe(true);
        expect(requestGuestProgressSelection).not.toHaveBeenCalled();
    });
});
