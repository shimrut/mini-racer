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
    stageCount: 16,
    totalTimeMs: 187654,
};

function finishedRoot(postData = FINISHED_POST) {
    return { devvit: { context: { postData } } };
}

describe('campaign launcher custom post', () => {
    it('names the Campaign series The Numbers', () => {
        const markup = readFileSync(new URL('../pages/campaign.html', import.meta.url), 'utf8');

        expect(markup).toContain('class="campaign-eyebrow">The Numbers</p>');
        expect(markup).not.toContain('Permanent series');
    });

    it('keeps the finished poster hidden until a finished post shows it', () => {
        const markup = readFileSync(new URL('../pages/campaign.html', import.meta.url), 'utf8');

        expect(markup).toMatch(/<main id="campaign-finished-poster"[^>]*\shidden>/);
        expect(markup).toContain('id="campaign-finished-place"');
        expect(markup).toContain('id="campaign-finished-race-btn" type="button">Play Campaign</button>');
        expect(markup).toContain('id="campaign-race-btn" type="button">Race Campaign</button>');
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

    it('binds the finished poster button instead once the poster is shown', () => {
        const buttons = {
            'campaign-race-btn': { dataset: {}, addEventListener: vi.fn() },
            'campaign-finished-race-btn': { dataset: {}, addEventListener: vi.fn() },
        };
        const poster = { hidden: false };
        const documentRef = {
            getElementById: (id) => (id === 'campaign-finished-poster' ? poster : buttons[id]),
        };

        expect(bindCampaignRaceButton(documentRef, vi.fn())).toBe(buttons['campaign-finished-race-btn']);
        bindCampaignRaceButton(documentRef, vi.fn());
        expect(buttons['campaign-finished-race-btn'].addEventListener).toHaveBeenCalledTimes(1);
        expect(buttons['campaign-race-btn'].addEventListener).not.toHaveBeenCalled();

        poster.hidden = true;
        expect(bindCampaignRaceButton(documentRef, vi.fn())).toBe(buttons['campaign-race-btn']);
    });

    it('keeps normal launchers separate from finished campaign posts', () => {
        expect(readCampaignFinishedPostData(finishedRoot({ postType: 'campaign-launcher' }))).toBeNull();
        expect(readCampaignFinishedPostData(finishedRoot())).toMatchObject({
            seriesId: 'night-v1',
            seriesName: 'Night Races',
            playerUsername: 'RaceFan',
            playerAvatarUrl: FINISHED_POST.playerAvatarUrl,
            medalDistribution: FINISHED_POST.medalDistribution,
            totalTimeMs: 187654,
            stageCount: 16,
        });
    });

    it('reads the total time and stage count only as positive integers', () => {
        expect(readCampaignFinishedPostData(finishedRoot({ ...FINISHED_POST, totalTimeMs: undefined, stageCount: undefined })))
            .toMatchObject({ totalTimeMs: null, stageCount: null });
        for (const bad of [0, -5, 1.5, '12', Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
            expect(readCampaignFinishedPostData(finishedRoot({ ...FINISHED_POST, totalTimeMs: bad, stageCount: bad })))
                .toMatchObject({ totalTimeMs: null, stageCount: null });
        }
    });

    it('renders the player, series, time, stages, medal counts and specific Campaign action', () => {
        const elements = new Map();
        const getElement = (id) => {
            if (!elements.has(id)) elements.set(id, {
                hidden: true,
                classList: { toggle: vi.fn() },
                setAttribute: vi.fn(),
                replaceChildren: vi.fn(),
                style: { setProperty: vi.fn() },
            });
            return elements.get(id);
        };
        getElement('campaign-launcher').hidden = false;
        getElement('campaign-finished-medals').querySelector = getElement;
        const documentRef = { getElementById: getElement };

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot()));

        expect(getElement('campaign-launcher').hidden).toBe(true);
        expect(getElement('campaign-finished-poster').hidden).toBe(false);
        expect(getElement('campaign-finished-name').textContent).toBe('RaceFan');
        expect(getElement('campaign-finished-avatar').src).toBe(FINISHED_POST.playerAvatarUrl);
        expect(getElement('campaign-finished-summary').textContent).toBe('I finished the Night Races campaign.');
        expect(getElement('campaign-finished-title').textContent).toBe('Night Races');
        expect(getElement('campaign-finished-label').hidden).toBe(false);
        expect(getElement('campaign-finished-time').hidden).toBe(false);
        expect(getElement('campaign-finished-time').textContent).toBe('3:07.654');
        expect(getElement('campaign-finished-time').style.setProperty).toHaveBeenCalledWith('--time-chars', '8');
        expect(getElement('campaign-finished-stages').textContent).toBe('16 stages');
        expect(getElement('campaign-finished-place').hidden).toBe(true);
        for (const [tier, count] of Object.entries(FINISHED_POST.medalDistribution)) {
            const slot = getElement(`[data-campaign-medal="${tier}"]`);
            expect(slot.replaceChildren)
                .toHaveBeenCalledWith(expect.objectContaining({ tier, centerText: String(count) }));
            expect(slot.setAttribute).toHaveBeenCalledWith('aria-label', `${count} ${tier} ${count === 1 ? 'medal' : 'medals'}`);
        }
        expect(getElement('campaign-finished-race-btn').disabled).toBe(false);

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot({
            ...FINISHED_POST, seriesId: null, playerAvatarUrl: 'https://example.com/avatar.png',
            place: { rank: 2, total: 12 }, stageCount: 1,
        })));
        expect(getElement('campaign-finished-avatar').src).toBe(GENERIC_SNOO_URL);
        expect(getElement('campaign-finished-race-btn').disabled).toBe(true);
        expect(getElement('campaign-finished-place').hidden).toBe(false);
        expect(getElement('campaign-finished-place-value').textContent).toBe('#2 / 12');
        expect(getElement('campaign-finished-place').setAttribute).toHaveBeenCalledWith('aria-label', 'Overall place 2 of 12');
        expect(getElement('campaign-finished-stages').textContent).toBe('1 stage');

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot({
            ...FINISHED_POST, place: { rank: 4, total: 3 },
        })));
        expect(getElement('campaign-finished-place').hidden).toBe(true);
    });

    it('hides the time and leaves the stage count empty on posts made before they were saved', () => {
        const elements = new Map();
        const getElement = (id) => {
            if (!elements.has(id)) elements.set(id, {
                hidden: false,
                classList: { toggle: vi.fn() },
                setAttribute: vi.fn(),
                replaceChildren: vi.fn(),
                style: { setProperty: vi.fn() },
            });
            return elements.get(id);
        };
        getElement('campaign-finished-medals').querySelector = getElement;

        renderCampaignFinishedPoster({ getElementById: getElement }, readCampaignFinishedPostData(finishedRoot({
            ...FINISHED_POST, totalTimeMs: undefined, stageCount: undefined,
        })));

        expect(getElement('campaign-finished-label').hidden).toBe(true);
        expect(getElement('campaign-finished-time').hidden).toBe(true);
        expect(getElement('campaign-finished-stages').textContent).toBe('');
        expect(getElement('campaign-finished-title').textContent).toBe('Night Races');
        expect(getElement('campaign-finished-place').hidden).toBe(true);
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
