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

const BRAG_POST = { ...FINISHED_POST, stageCount: 16, totalTimeMs: 187654, place: { rank: 4, total: 128 } };

function finishedRoot(postData = FINISHED_POST) {
    return { devvit: { context: { postData } } };
}

function posterDocument() {
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
    return { getElement, documentRef: { getElementById: getElement, querySelector: () => launcher } };
}

describe('campaign launcher custom post', () => {
    it('names the Campaign series The Numbers', () => {
        const markup = readFileSync(new URL('../pages/campaign.html', import.meta.url), 'utf8');

        expect(markup).toContain('class="campaign-eyebrow">The Numbers</p>');
        expect(markup).toContain('id="campaign-place"');
        expect(markup).not.toContain('Permanent series');
    });

    it('keeps the poster-only elements hidden so the plain launcher is unchanged', () => {
        const markup = readFileSync(new URL('../pages/campaign.html', import.meta.url), 'utf8');

        for (const id of ['campaign-stats', 'campaign-time', 'campaign-place', 'campaign-place-top', 'campaign-hook']) {
            expect(markup).toMatch(new RegExp(`id="${id}"[^>]*\\shidden`));
        }
        expect(markup).toContain('>Race Campaign</button>');
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
            totalTimeMs: null,
            stageCount: null,
        });
        expect(readCampaignFinishedPostData(finishedRoot(BRAG_POST)))
            .toMatchObject({ totalTimeMs: 187654, stageCount: 16 });
    });

    it.each([0, -5, 1.5, '187654', Number.NaN, Number.MAX_SAFE_INTEGER + 1, null])(
        'ignores a total time and stage count of %j',
        (bad) => {
            expect(readCampaignFinishedPostData(finishedRoot({ ...FINISHED_POST, totalTimeMs: bad, stageCount: bad })))
                .toMatchObject({ totalTimeMs: null, stageCount: null });
        },
    );

    it('renders the player, finished series, medal counts and specific Campaign action', () => {
        const { getElement, documentRef } = posterDocument();

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot()));

        expect(getElement('campaign-player').hidden).toBe(false);
        expect(getElement('campaign-player-name').textContent).toBe('u/RaceFan');
        expect(getElement('campaign-player-avatar').src).toBe(FINISHED_POST.playerAvatarUrl);
        expect(getElement('campaign-eyebrow').textContent).toBe('Campaign complete');
        expect(getElement('campaign-title').textContent).toBe('Night Races');
        expect(getElement('campaign-description').textContent).toBe('I finished the Night Races campaign.');
        expect(getElement('campaign-place').hidden).toBe(true);
        expect(getElement('campaign-medals').hidden).toBe(false);
        for (const [tier, count] of Object.entries(FINISHED_POST.medalDistribution)) {
            expect(getElement(`[data-campaign-medal="${tier}"]`).replaceChildren)
                .toHaveBeenCalledWith(expect.objectContaining({ tier, centerText: String(count) }));
        }
        expect(getElement('campaign-race-btn').textContent).toBe('Race the Campaign');
        expect(getElement('campaign-race-btn').disabled).toBe(false);

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot({
            ...FINISHED_POST, seriesId: null, playerAvatarUrl: 'https://example.com/avatar.png',
            place: { rank: 2, total: 12 },
        })));
        expect(getElement('campaign-player-avatar').src).toBe(GENERIC_SNOO_URL);
        expect(getElement('campaign-race-btn').disabled).toBe(true);
        expect(getElement('campaign-place').hidden).toBe(false);
        expect(getElement('campaign-place-value').textContent).toBe('#2 of 12');
        expect(getElement('campaign-place').setAttribute).toHaveBeenCalledWith('aria-label', 'Overall place 2 of 12');

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot({
            ...FINISHED_POST, place: { rank: 4, total: 3 },
        })));
        expect(getElement('campaign-place').hidden).toBe(true);
    });

    it('shows the time to beat, overall place and a Beat My Time action', () => {
        const { getElement, documentRef } = posterDocument();

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot(BRAG_POST)));

        expect(getElement('campaign-eyebrow').textContent).toBe('Campaign complete · 16 stages');
        expect(getElement('campaign-stats').hidden).toBe(false);
        expect(getElement('campaign-time').hidden).toBe(false);
        expect(getElement('campaign-time-value').textContent).toBe('3:07.654');
        expect(getElement('campaign-time').setAttribute).toHaveBeenCalledWith('aria-label', 'Total time 3:07.654');
        expect(getElement('campaign-place-value').textContent).toBe('#4 of 128');
        expect(getElement('campaign-place').setAttribute).toHaveBeenCalledWith('aria-label', 'Overall place 4 of 128');
        expect(getElement('campaign-place-top').hidden).toBe(false);
        expect(getElement('campaign-place-top').textContent).toBe('Top 4%');
        expect(getElement('campaign-hook').hidden).toBe(false);
        expect(getElement('campaign-hook').textContent).toBe("Think you're faster?");
        expect(getElement('campaign-race-btn').textContent).toBe('Beat My Time');
        expect(getElement('campaign-description').textContent).toBe('I finished the Night Races campaign.');
    });

    it.each([
        [{ rank: 3, total: 10 }, 'Top 30%'],
        [{ rank: 1, total: 128 }, 'Top 1%'],
        [{ rank: 5, total: 10 }, 'Top 50%'],
        [{ rank: 6, total: 10 }, ''],
        [{ rank: 2, total: 9 }, ''],
    ])('shows Top percent only for the top half of a board of at least 10: %j', (place, label) => {
        const { getElement, documentRef } = posterDocument();

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot({ ...BRAG_POST, place })));

        expect(getElement('campaign-place-top').textContent).toBe(label);
        expect(getElement('campaign-place-top').hidden).toBe(!label);
    });

    it('hides the tiles whose data is missing and singularizes one stage', () => {
        const { getElement, documentRef } = posterDocument();

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot({
            ...FINISHED_POST, stageCount: 1, place: { rank: 4, total: 128 },
        })));
        expect(getElement('campaign-eyebrow').textContent).toBe('Campaign complete · 1 stage');
        expect(getElement('campaign-stats').hidden).toBe(false);
        expect(getElement('campaign-time').hidden).toBe(true);
        expect(getElement('campaign-place').hidden).toBe(false);
        expect(getElement('campaign-hook').textContent).toBe('Can you finish it?');
        expect(getElement('campaign-race-btn').textContent).toBe('Race the Campaign');

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot({
            ...FINISHED_POST, totalTimeMs: 59_999,
        })));
        expect(getElement('campaign-stats').hidden).toBe(false);
        expect(getElement('campaign-time').hidden).toBe(false);
        expect(getElement('campaign-time-value').textContent).toBe('0:59.999');
        expect(getElement('campaign-place').hidden).toBe(true);
        expect(getElement('campaign-race-btn').textContent).toBe('Beat My Time');

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot()));
        expect(getElement('campaign-stats').hidden).toBe(true);
        expect(getElement('campaign-time').hidden).toBe(true);
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
