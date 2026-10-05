import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    bindCampaignRaceButton,
    openCampaignGame,
    readCampaignFinishedPostData,
    renderCampaignFinishedPoster,
} from '../pages/campaign.js';
import { GENERIC_SNOO_URL } from '../game/ui/avatar.js';

vi.mock('../game/medals/medal-icon.js', () => ({
    createMedalIconSvg: (tier, options) => ({ tier, ...options }),
}));

const FINISHED_POST = {
    postType: 'campaign-finished',
    seriesId: 'night-v1',
    seriesName: 'Night Races',
    playerUsername: 'u/RaceFan',
    playerAvatarUrl: 'https://i.redd.it/racefan.png',
    medalDistribution: { author: 2, gold: 3, silver: 1, bronze: 0 },
};

function finishedRoot(postData = FINISHED_POST) {
    return { devvit: { context: { postData } } };
}

describe('campaign launcher custom post', () => {
    it('names the Campaign series The Numbers', () => {
        const markup = readFileSync(new URL('../pages/campaign.html', import.meta.url), 'utf8');

        expect(markup).toContain('class="campaign-eyebrow">The Numbers</p>');
        expect(markup).toContain('id="campaign-place"');
        expect(markup).not.toContain('Permanent series');
    });

    it('stores the Campaign target before expanding the shared game', async () => {
        const requestLaunchTarget = vi.fn();
        const requestExpanded = vi.fn(async () => undefined);
        const event = { type: 'click' };

        await expect(openCampaignGame(event, {
            requestLaunchTarget,
            requestExpanded,
        })).resolves.toBe(true);

        expect(requestLaunchTarget).toHaveBeenCalledWith('campaign');
        expect(requestExpanded).toHaveBeenCalledWith(event, 'game');
    });

    it('binds the Campaign action only once', async () => {
        const listeners = [];
        const button = {
            dataset: {},
            addEventListener: vi.fn((type, handler) => listeners.push([type, handler])),
        };
        const documentRef = {
            getElementById: vi.fn(() => button),
        };
        const openGame = vi.fn(async () => undefined);

        bindCampaignRaceButton(documentRef, openGame);
        bindCampaignRaceButton(documentRef, openGame);

        expect(button.addEventListener).toHaveBeenCalledTimes(1);
        expect(listeners[0][0]).toBe('click');
        await listeners[0][1]({ type: 'click' });
        expect(openGame).toHaveBeenCalledOnce();
    });

    it('keeps normal launchers separate from finished campaign posts', () => {
        expect(readCampaignFinishedPostData(finishedRoot({ postType: 'campaign-launcher' }))).toBeNull();
        expect(readCampaignFinishedPostData(finishedRoot())).toMatchObject({
            seriesId: 'night-v1',
            seriesName: 'Night Races',
            playerUsername: 'RaceFan',
            playerAvatarUrl: FINISHED_POST.playerAvatarUrl,
            medalDistribution: FINISHED_POST.medalDistribution,
        });
    });

    it('renders the player, finished series, medal counts and specific Campaign action', () => {
        const elements = new Map();
        const getElement = (id) => {
            if (!elements.has(id)) elements.set(id, {
                hidden: true,
                classList: { toggle: vi.fn() },
                setAttribute: vi.fn(),
                replaceChildren: vi.fn(),
            });
            return elements.get(id);
        };
        const launcher = { classList: { add: vi.fn() } };
        getElement('campaign-medals').querySelector = getElement;
        const documentRef = { getElementById: getElement, querySelector: () => launcher };

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot()));

        expect(getElement('campaign-player').hidden).toBe(false);
        expect(getElement('campaign-player-name').textContent).toBe('RaceFan');
        expect(getElement('campaign-player-avatar').src).toBe(FINISHED_POST.playerAvatarUrl);
        expect(getElement('campaign-title').textContent).toBe('Night Races');
        expect(getElement('campaign-description').textContent).toBe('I finished the Night Races campaign.');
        expect(getElement('campaign-place').hidden).toBe(true);
        expect(getElement('campaign-medals').hidden).toBe(false);
        for (const [tier, count] of Object.entries(FINISHED_POST.medalDistribution)) {
            expect(getElement(`[data-campaign-medal="${tier}"]`).replaceChildren)
                .toHaveBeenCalledWith(expect.objectContaining({ tier, centerText: String(count) }));
        }
        expect(getElement('campaign-race-btn').textContent).toBe('Play Campaign');
        expect(getElement('campaign-race-btn').disabled).toBe(false);

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot({
            ...FINISHED_POST, seriesId: null, playerAvatarUrl: 'https://example.com/avatar.png',
            place: { rank: 2, total: 12 },
        })));
        expect(getElement('campaign-player-avatar').src).toBe(GENERIC_SNOO_URL);
        expect(getElement('campaign-race-btn').disabled).toBe(true);
        expect(getElement('campaign-place').hidden).toBe(false);
        expect(getElement('campaign-place-value').textContent).toBe('#2 / 12');
        expect(getElement('campaign-place').setAttribute).toHaveBeenCalledWith('aria-label', 'Overall place 2 of 12');

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot({
            ...FINISHED_POST, place: { rank: 4, total: 3 },
        })));
        expect(getElement('campaign-place').hidden).toBe(true);
    });

    it('stores the shared series before expanding, without carrying the finisher progress', async () => {
        const requestLaunchTarget = vi.fn();
        const requestExpanded = vi.fn(async () => undefined);
        const event = { type: 'click' };
        await expect(openCampaignGame(event, {
            root: finishedRoot(), requestLaunchTarget, requestExpanded,
        })).resolves.toBe(true);
        expect(requestLaunchTarget).toHaveBeenCalledWith('campaign', { seriesId: 'night-v1' });
        expect(requestExpanded).toHaveBeenCalledWith(event, 'game');
    });

    it('refuses to launch a malformed completion post without its specific series', async () => {
        const requestLaunchTarget = vi.fn();
        const requestExpanded = vi.fn();
        await expect(openCampaignGame({}, {
            root: finishedRoot({ ...FINISHED_POST, seriesId: null }),
            requestLaunchTarget, requestExpanded,
        })).resolves.toBe(false);
        expect(requestLaunchTarget).not.toHaveBeenCalled();
        expect(requestExpanded).not.toHaveBeenCalled();
    });
});
