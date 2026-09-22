import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const PLAYER_ID_KEY = 'VectorGpScoreboardPlayerId';
const GUEST_TOKEN_KEY = 'VectorGpGuestPlayerToken';
const QUEUE_KEY = 'VectorGpVerificationQueue';

function response(status, payload) {
    return { ok: status >= 200 && status < 300, status, json: vi.fn(async () => payload) };
}

function campaignEntry(ownerPlayerId, bestTime) {
    return {
        raceId: 'numbered-v1-00',
        ownerPlayerId,
        bestTime,
        verificationState: 'pending',
        nextAttemptAt: Date.now(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        replay: { inputs: [] },
    };
}

const JOINED_BOOTSTRAP = {
    hasAnyData: true,
    isReturningPlayer: true,
    redditUsername: 'Veteran',
    playerId: 'reddit:veteran',
    guestToken: 'guest-token',
    leaderboardIdentity: 'reddit',
    playerPreferences: null,
    retireGuestIdentity: true,
    guestJoinedAccount: true,
};

function startWithQueue(campaign) {
    const dom = new JSDOM('<body class="loading-active"></body>', {
        url: 'https://example.devvit.net/game.html',
    });
    dom.window.localStorage.setItem(PLAYER_ID_KEY, 'offline-guest');
    dom.window.localStorage.setItem(GUEST_TOKEN_KEY, 'guest-token');
    dom.window.localStorage.setItem(QUEUE_KEY, JSON.stringify({ daily: {}, campaign }));
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('localStorage', dom.window.localStorage);
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'new-guest') });
    return dom;
}

function readCampaignQueue(dom) {
    return JSON.parse(dom.window.localStorage.getItem(QUEUE_KEY)).campaign;
}

describe('an empty guest joined to the account at sign-in', () => {
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('asks nothing and moves the unsent guest run to the account', async () => {
        const dom = startWithQueue({
            'guest:offline-guest::numbered-v1-00': campaignEntry('guest:offline-guest', 12.3),
        });
        const fetchMock = vi.fn().mockResolvedValue(response(200, JOINED_BOOTSTRAP));
        vi.stubGlobal('fetch', fetchMock);

        const { getPlayerProgressState } = await import('../game/storage.js');
        const state = await getPlayerProgressState();

        expect(document.querySelector('.guest-progress-selection')).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(state).toMatchObject({ authoritative: true, leaderboardPlayerId: 'reddit:veteran' });
        expect(readCampaignQueue(dom)).toEqual({
            'reddit:veteran::numbered-v1-00': expect.objectContaining({
                ownerPlayerId: 'reddit:veteran',
                bestTime: 12.3,
            }),
        });
        expect(dom.window.localStorage.getItem(PLAYER_ID_KEY)).toBe('new-guest');
    });

    for (const [label, guestTime, accountTime, keptTime] of [
        ['keeps the guest run when it is faster', 11.0, 12.5, 11.0],
        ['keeps the account run when it is faster', 13.0, 12.5, 12.5],
    ]) {
        it(`${label} than the account's unsent run for the same race`, async () => {
            const dom = startWithQueue({
                'guest:offline-guest::numbered-v1-00': campaignEntry('guest:offline-guest', guestTime),
                'reddit:veteran::numbered-v1-00': campaignEntry('reddit:veteran', accountTime),
            });
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, JOINED_BOOTSTRAP)));

            const { getPlayerProgressState } = await import('../game/storage.js');
            await getPlayerProgressState();

            const queue = readCampaignQueue(dom);
            expect(Object.keys(queue)).toEqual(['reddit:veteran::numbered-v1-00']);
            expect(queue['reddit:veteran::numbered-v1-00'].bestTime).toBe(keptTime);
        });
    }

    it('asks nothing and leaves the runs alone for a guest joined to another account', async () => {
        const dom = startWithQueue({
            'guest:offline-guest::numbered-v1-00': campaignEntry('guest:offline-guest', 12.3),
        });
        const fetchMock = vi.fn().mockResolvedValue(response(200, {
            ...JOINED_BOOTSTRAP,
            guestJoinedAccount: undefined,
        }));
        vi.stubGlobal('fetch', fetchMock);

        const { getPlayerProgressState } = await import('../game/storage.js');
        const state = await getPlayerProgressState();

        expect(document.querySelector('.guest-progress-selection')).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(state).toMatchObject({ authoritative: true, leaderboardPlayerId: 'reddit:veteran' });
        expect(Object.keys(readCampaignQueue(dom))).toEqual(['guest:offline-guest::numbered-v1-00']);
    });

    it('keeps the guest id when the move cannot be saved, so the next start-up can try again', async () => {
        const dom = startWithQueue({
            'guest:offline-guest::numbered-v1-00': campaignEntry('guest:offline-guest', 12.3),
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, JOINED_BOOTSTRAP)));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const setItem = dom.window.Storage.prototype.setItem;
        vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(function (key, value) {
            if (key === QUEUE_KEY) throw new Error('QuotaExceededError');
            return setItem.call(this, key, value);
        });

        const { getPlayerProgressState } = await import('../game/storage.js');
        await getPlayerProgressState();

        expect(document.querySelector('.guest-progress-selection')).toBeNull();
        expect(Object.keys(readCampaignQueue(dom))).toEqual(['guest:offline-guest::numbered-v1-00']);
        expect(dom.window.localStorage.getItem(PLAYER_ID_KEY)).toBe('offline-guest');
    });
});

describe('the Keep Progress chooser without numbers', () => {
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    it('picks nothing for the player, and sends only the choice the player makes', async () => {
        startWithQueue({});
        const fetchMock = vi.fn().mockResolvedValue(response(200, { playerId: 'reddit:veteran' }));
        vi.stubGlobal('fetch', fetchMock);

        const { requestGuestProgressSelection } = await import('../game/player/guest-progress-selection.js');
        const choice = requestGuestProgressSelection({
            required: true,
            guestHasProgress: true,
            accountHasProgress: true,
            guestSummary: { campaignUnlockedTracks: null },
            accountSummary: { campaignUnlockedTracks: null },
        });

        const button = document.querySelector('.guest-progress-selection__button');
        expect(document.querySelector('input:checked')).toBeNull();
        expect(button.disabled).toBe(true);
        expect(button.textContent).toBe('CHOOSE A SAVE');
        button.click();
        expect(fetchMock).not.toHaveBeenCalled();

        const account = document.querySelector('[data-choice="account"]');
        account.checked = true;
        account.dispatchEvent(new window.Event('change'));
        expect(button.disabled).toBe(false);
        button.click();

        await expect(choice).resolves.toMatchObject({ choice: 'account' });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).choice).toBe('account');
    });

    it('still offers Guest by default when both sides show what they hold', async () => {
        startWithQueue({});
        const { requestGuestProgressSelection } = await import('../game/player/guest-progress-selection.js');
        void requestGuestProgressSelection({
            required: true,
            guestHasProgress: true,
            accountHasProgress: true,
            guestSummary: { campaignUnlockedTracks: 2, campaignTotalStages: 16 },
            accountSummary: { campaignUnlockedTracks: 5, campaignTotalStages: 16 },
        });

        expect(document.querySelector('input:checked')?.value).toBe('guest');
        expect(document.querySelector('.guest-progress-selection__button').disabled).toBe(false);
    });
});
