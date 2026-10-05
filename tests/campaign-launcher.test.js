import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    bindCampaignRaceButton,
    formatCampaignOrdinalSuffix,
    formatCampaignPlaceFigure,
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

function createPoster() {
    const elements = new Map();
    const getElement = (id) => {
        if (!elements.has(id)) {
            const classes = new Set();
            elements.set(id, {
                hidden: true,
                classList: {
                    add: (name) => classes.add(name),
                    toggle: (name, on) => { classes[on ? 'add' : 'delete'](name); },
                    contains: (name) => classes.has(name),
                },
                setAttribute: vi.fn(),
                replaceChildren: vi.fn(),
            });
        }
        return elements.get(id);
    };
    const launcher = getElement('launcher');
    getElement('campaign-medals').querySelector = getElement;
    const documentRef = { getElementById: getElement, querySelector: () => launcher };
    return {
        getElement,
        render: (postData) => renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot(postData))),
    };
}

function placeText(getElement) {
    return ['prefix', 'number', 'suffix', 'total']
        .map((part) => getElement(`campaign-place-${part}`).textContent);
}

describe('campaign launcher custom post', () => {
    it('names the Campaign series The Numbers', () => {
        const markup = readFileSync(new URL('../pages/campaign.html', import.meta.url), 'utf8');

        expect(markup).toContain('class="campaign-eyebrow">The Numbers</p>');
        expect(markup).toContain('id="campaign-place"');
        expect(markup).not.toContain('Permanent series');
    });

    it('stacks the poster as place, player, eyebrow, series name, then medals', () => {
        const markup = readFileSync(new URL('../pages/campaign.html', import.meta.url), 'utf8');
        const order = ['campaign-place"', 'campaign-player"', 'campaign-eyebrow"', 'campaign-title"', 'campaign-medals"']
            .map((id) => markup.indexOf(`id="${id}`));

        expect(order).not.toContain(-1);
        expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('uses the podium tier colors for the first three places', () => {
        const css = readFileSync(new URL('../pages/campaign.css', import.meta.url), 'utf8');
        const podiumCss = readFileSync(new URL('../pages/podium.css', import.meta.url), 'utf8');

        for (const tier of ['gold', 'silver', 'bronze']) {
            const color = podiumCss.match(new RegExp(`--${tier}: (#[0-9a-f]{6});`))[1];
            expect(css).toContain(`--${tier}: ${color};`);
            expect(css).toMatch(new RegExp(`\\.campaign-hero--${tier}\\s*\\{\\s*--tier: var\\(--${tier}\\);`));
        }
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
        const { getElement, render } = createPoster();

        render(FINISHED_POST);

        expect(getElement('launcher').classList.contains('campaign-launcher--finished')).toBe(true);
        expect(getElement('campaign-player').hidden).toBe(false);
        expect(getElement('campaign-player-name').textContent).toBe('RaceFan');
        expect(getElement('campaign-player-avatar').src).toBe(FINISHED_POST.playerAvatarUrl);
        expect(getElement('campaign-eyebrow').textContent).toBe('Campaign complete');
        expect(getElement('campaign-title').textContent).toBe('Night Races');
        expect(getElement('campaign-description').textContent).toBe('I finished the Night Races campaign.');
        expect(getElement('campaign-medals').hidden).toBe(false);
        for (const [tier, count] of Object.entries(FINISHED_POST.medalDistribution)) {
            expect(getElement(`[data-campaign-medal="${tier}"]`).setAttribute).toHaveBeenCalledWith(
                'aria-label', `${count} ${tier} ${count === 1 ? 'medal' : 'medals'}`,
            );
            expect(getElement(`[data-campaign-medal="${tier}"]`).replaceChildren)
                .toHaveBeenCalledWith(expect.objectContaining({ tier, centerText: String(count) }));
        }
        expect(getElement('campaign-race-btn').textContent).toBe('Play Campaign');
        expect(getElement('campaign-race-btn').disabled).toBe(false);

        render({ ...FINISHED_POST, seriesId: null, playerAvatarUrl: 'https://example.com/avatar.png' });
        expect(getElement('campaign-player-avatar').src).toBe(GENERIC_SNOO_URL);
        expect(getElement('campaign-race-btn').disabled).toBe(true);
    });

    it('never reads or shows the total time', () => {
        const finished = readCampaignFinishedPostData(finishedRoot({ ...FINISHED_POST, totalTimeMs: 187654 }));

        expect(finished).not.toHaveProperty('totalTimeMs');
    });

    it('writes the ordinal suffix for every kind of rank', () => {
        const suffixes = [1, 2, 3, 4, 10, 11, 12, 13, 21, 22, 23, 100, 101, 111, 112, 113]
            .map(formatCampaignOrdinalSuffix);

        expect(suffixes).toEqual([
            'ST', 'ND', 'RD', 'TH', 'TH', 'TH', 'TH', 'TH', 'ST', 'ND', 'RD', 'TH', 'ST', 'TH', 'TH', 'TH',
        ]);
    });

    it('shows ranks 1 to 100 as ordinals and later ranks as a top percent', () => {
        expect(formatCampaignPlaceFigure({ rank: 4, total: 128 })).toEqual({ prefix: '', number: '4', suffix: 'TH' });
        expect(formatCampaignPlaceFigure({ rank: 100, total: 5000 })).toEqual({ prefix: '', number: '100', suffix: 'TH' });
        expect(formatCampaignPlaceFigure({ rank: 101, total: 1000 })).toEqual({ prefix: 'TOP', number: '11%', suffix: '' });
        expect(formatCampaignPlaceFigure({ rank: 342, total: 2850 })).toEqual({ prefix: 'TOP', number: '12%', suffix: '' });
        expect(formatCampaignPlaceFigure({ rank: 101, total: 101 })).toEqual({ prefix: 'TOP', number: '100%', suffix: '' });
    });

    it('renders the overall place figure, its total and the tier color', () => {
        const { getElement, render } = createPoster();
        const hero = getElement('campaign-hero');
        const tiers = () => ['gold', 'silver', 'bronze'].filter((tier) => hero.classList.contains(`campaign-hero--${tier}`));

        render({ ...FINISHED_POST, place: { rank: 1, total: 40 } });
        expect(getElement('campaign-place').hidden).toBe(false);
        expect(placeText(getElement)).toEqual(['', '1', 'ST', 'of 40']);
        expect(getElement('campaign-place').setAttribute).toHaveBeenCalledWith('aria-label', 'Overall place 1 of 40');
        expect(tiers()).toEqual(['gold']);

        render({ ...FINISHED_POST, place: { rank: 2, total: 12 } });
        expect(placeText(getElement)).toEqual(['', '2', 'ND', 'of 12']);
        expect(tiers()).toEqual(['silver']);

        render({ ...FINISHED_POST, place: { rank: 3, total: 12 } });
        expect(placeText(getElement)).toEqual(['', '3', 'RD', 'of 12']);
        expect(tiers()).toEqual(['bronze']);

        for (const [rank, suffix] of [[4, 'TH'], [11, 'TH'], [12, 'TH'], [13, 'TH'], [21, 'ST'], [100, 'TH']]) {
            render({ ...FINISHED_POST, place: { rank, total: 500 } });
            expect(placeText(getElement)).toEqual(['', String(rank), suffix, 'of 500']);
            expect(tiers()).toEqual([]);
        }
    });

    it('shows a top percent past the 100th place with thousands separators', () => {
        const { getElement, render } = createPoster();

        render({ ...FINISHED_POST, place: { rank: 101, total: 1000 } });
        expect(placeText(getElement)).toEqual(['TOP', '11%', '', 'of 1,000']);

        render({ ...FINISHED_POST, place: { rank: 342, total: 2850 } });
        expect(placeText(getElement)).toEqual(['TOP', '12%', '', 'of 2,850']);
        expect(getElement('campaign-place').setAttribute).toHaveBeenCalledWith('aria-label', 'Overall place 342 of 2850');
        expect(getElement('campaign-hero').classList.contains('campaign-hero--gold')).toBe(false);
    });

    it('hides the place block and keeps the player and medals when there is no place', () => {
        const { getElement, render } = createPoster();

        render({ ...FINISHED_POST, place: { rank: 1, total: 40 } });
        render(FINISHED_POST);
        expect(getElement('campaign-place').hidden).toBe(true);
        expect(getElement('campaign-hero').classList.contains('campaign-hero--gold')).toBe(false);
        expect(getElement('campaign-player').hidden).toBe(false);
        expect(getElement('campaign-medals').hidden).toBe(false);

        render({ ...FINISHED_POST, place: { rank: 4, total: 3 } });
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
