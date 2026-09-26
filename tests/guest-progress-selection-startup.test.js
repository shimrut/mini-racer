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
        vi.doUnmock('../game/scoreboard/verification-queue-transfer.js');
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
                    guestSummary: {
                        hasDailyResults: true,
                        campaignResults: 1,
                        campaignUnlockedTracks: 2,
                        campaignTotalStages: 16,
                        dailySavedResults: 1,
                        dailyPlaylistSize: 7,
                        carsUnlocked: 15,
                        carsTotal: 23,
                        unlocks: true,
                    },
                    accountSummary: {
                        hasDailyResults: true,
                        campaignResults: 2,
                        campaignUnlockedTracks: 3,
                        campaignTotalStages: 16,
                        dailySavedResults: 2,
                        dailyPlaylistSize: 7,
                        carsUnlocked: 16,
                        carsTotal: 23,
                        unlocks: true,
                    },
                },
            }))
            .mockResolvedValueOnce(response(200, selectedState));
        vi.stubGlobal('fetch', fetchMock);

        const { getPlayerProgressState } = await import('../game/player/progress-state.js');
        const statePromise = getPlayerProgressState({
            onProgressSelectionRequired: async () => {
                document.body.classList.remove('loading-active');
            },
        });
        await vi.waitFor(() => {
            expect(document.querySelector('.guest-progress-selection')).not.toBeNull();
        });

        expect(document.body.classList.contains('loading-active')).toBe(false);
        expect(document.querySelectorAll('.guest-progress-selection__source-input')).toHaveLength(3);
        const sourcesText = document.querySelector('.guest-progress-selection__sources').textContent;
        expect(sourcesText).toContain('Daily2/7');
        expect(sourcesText).toContain('Campaign3/16');
        expect(sourcesText).toContain('Garage16/23');
        expect(sourcesText).not.toContain('Daily results saved');
        expect(sourcesText).not.toContain('Car unlock progress saved');
        expect(sourcesText).not.toContain(' · Daily · Unlocks');
        expect(sourcesText).not.toContain('replaces saved account progress');
        expect(sourcesText).not.toContain('discards guest progress');
        expect(document.querySelector('.guest-progress-selection__message').textContent)
            .toBe('Keep one save, or merge both.');
        expect(document.querySelector('[data-choice="account"]')?.parentElement?.textContent)
            .toContain('Account');
        const continueButton = document.querySelector('.guest-progress-selection__button');
        expect(document.querySelectorAll('.guest-progress-selection__button')).toHaveLength(1);
        expect(continueButton.disabled).toBe(false);
        expect(document.querySelector('.guest-progress-selection__source.is-selected'))
            .toBe(document.querySelector('[data-choice="guest"]')?.parentElement);
        expect(continueButton.textContent).toBe('CONTINUE WITH GUEST');
        document.querySelector('[data-choice="account"]').click();
        expect(continueButton.disabled).toBe(false);
        expect(continueButton.textContent).toBe('CONTINUE WITH ACCOUNT');
        document.querySelector('[data-choice="merge"]').click();
        expect(continueButton.textContent).toBe('MERGE BEST TIMES');
        expect(document.querySelector('[data-choice="merge"]')?.parentElement?.textContent)
            .toContain('Best time on each track');
        document.querySelector('[data-choice="guest"]').click();
        expect(continueButton.textContent).toBe('CONTINUE WITH GUEST');
        continueButton.click();
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

    it('resumes the same transfer at once when the server asks it to continue', async () => {
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
            playerPreferences: null,
            progressSelection: { required: false },
        };
        const continueAnswer = response(503, {
            error: 'Moving your progress. Continuing…',
            reason: 'progress_selection_continue',
            transferId: 'transfer-1',
        });
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response(200, {
                ...selectedState,
                guestToken: 'guest-token',
                progressSelection: {
                    required: true,
                    guestHasProgress: true,
                    accountHasProgress: true,
                    guestSummary: {
                        hasDailyResults: true,
                        campaignResults: 1,
                        campaignUnlockedTracks: 2,
                        campaignTotalStages: 16,
                        dailySavedResults: 1,
                        dailyPlaylistSize: 7,
                        carsUnlocked: 15,
                        carsTotal: 23,
                        unlocks: true,
                    },
                    accountSummary: {
                        hasDailyResults: true,
                        campaignResults: 2,
                        campaignUnlockedTracks: 3,
                        campaignTotalStages: 16,
                        dailySavedResults: 2,
                        dailyPlaylistSize: 7,
                        carsUnlocked: 16,
                        carsTotal: 23,
                        unlocks: true,
                    },
                },
            }))
            .mockResolvedValueOnce(continueAnswer)
            .mockResolvedValueOnce(continueAnswer)
            .mockResolvedValueOnce(response(200, selectedState));
        vi.stubGlobal('fetch', fetchMock);

        const { getPlayerProgressState } = await import('../game/player/progress-state.js');
        const statePromise = getPlayerProgressState({ onProgressSelectionRequired: async () => {} });
        await vi.waitFor(() => {
            expect(document.querySelector('.guest-progress-selection__button')).not.toBeNull();
        });
        document.querySelector('.guest-progress-selection__button').click();
        await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
        const state = await statePromise;

        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ choice: 'guest' });
        for (const call of fetchMock.mock.calls.slice(2)) {
            expect(JSON.parse(call[1].body)).toEqual({ action: 'resume', transferId: 'transfer-1' });
        }
        expect(state).toMatchObject({ redditUsername: 'RaceFan' });
    });

    it('includes an account Campaign result that is still saving locally', async () => {
        const dom = new JSDOM('<body class="loading-active"></body>', {
            url: 'https://example.devvit.net/game.html',
        });
        dom.window.localStorage.setItem(PLAYER_ID_KEY, 'promoted-guest-pending');
        dom.window.localStorage.setItem(GUEST_TOKEN_KEY, 'guest-token');
        dom.window.localStorage.setItem('VectorGpVerificationQueue', JSON.stringify({
            daily: {},
            campaign: {
                'reddit:racefan::numbered-v1-02': {
                    raceId: 'numbered-v1-02',
                    ownerPlayerId: 'reddit:racefan',
                    bestTime: 12.345,
                    verificationState: 'pending',
                    nextAttemptAt: Date.now(),
                    expiresAt: new Date(Date.now() + 86400000).toISOString(),
                    replay: { inputs: [] },
                },
            },
        }));
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
        vi.stubGlobal('fetch', vi.fn()
            .mockResolvedValueOnce(response(200, {
                ...selectedState,
                guestToken: 'guest-token',
                progressSelection: {
                    required: true,
                    guestHasProgress: true,
                    accountHasProgress: true,
                    guestSummary: {
                        hasDailyResults: true,
                        campaignResults: 0,
                        campaignUnlockedTracks: 1,
                        campaignTotalStages: 16,
                        dailySavedResults: 0,
                        dailyPlaylistSize: 7,
                        carsUnlocked: 14,
                        carsTotal: 23,
                        unlocks: true,
                    },
                    accountSummary: {
                        hasDailyResults: true,
                        campaignResults: 2,
                        campaignUnlockedTracks: 3,
                        campaignTotalStages: 16,
                        dailySavedResults: 2,
                        dailyPlaylistSize: 7,
                        carsUnlocked: 16,
                        carsTotal: 23,
                        unlocks: true,
                    },
                },
            }))
            .mockResolvedValueOnce(response(200, selectedState)));

        const { getPlayerProgressState } = await import('../game/player/progress-state.js');
        const statePromise = getPlayerProgressState();
        await vi.waitFor(() => {
            expect(document.querySelector('.guest-progress-selection')).not.toBeNull();
        });

        expect(document.querySelector('.guest-progress-selection__sources').textContent)
            .toContain('Campaign3/16');
        expect(document.querySelector('.guest-progress-selection__sources').textContent)
            .not.toContain('Campaign result pending');
        document.querySelector('[data-choice="account"]').click();
        document.querySelector('.guest-progress-selection__button').click();
        await statePromise;
    });

    it('never asks a signed-out guest to resolve account progress because of a queued guest run', async () => {
        const requestGuestProgressSelection = vi.fn();
        vi.doMock('../game/player/guest-progress-selection.js', () => ({
            requestGuestProgressSelection,
        }));
        vi.doMock('../game/scoreboard/verification-queue-transfer.js', async () => {
            const actual = await vi.importActual('../game/scoreboard/verification-queue-transfer.js');
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

        const { getPlayerProgressState } = await import('../game/player/progress-state.js');
        const state = await getPlayerProgressState();

        expect(state.authoritative).toBe(true);
        expect(requestGuestProgressSelection).not.toHaveBeenCalled();
    });
});
