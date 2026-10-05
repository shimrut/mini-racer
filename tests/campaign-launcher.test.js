import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
const { renderPosterTrack, carImage } = vi.hoisted(() => ({ renderPosterTrack: vi.fn(), carImage: { width: 8, height: 8 } }));

vi.mock('../game/track/poster-track.js', () => ({ renderPosterTrack }));
vi.mock('../game/track/stored-track-service.js', () => ({ ensureStoredTracks: vi.fn(async () => {}) }));
vi.mock('../game/track/poster-car.js', async () => ({
    ...await vi.importActual('../game/track/poster-car.js'),
    loadPosterCar: () => Promise.resolve(carImage),
}));

import {
    bindCampaignRaceButton,
    formatCampaignOverallPlace,
    openCampaignGame,
    readCampaignFinishedPostData,
    renderCampaignFinishedPoster,
    showFinishedTrack,
} from '../pages/campaign.js';
import { GENERIC_SNOO_URL } from '../game/ui/avatar.js';

const FINISHED_POST = {
    postType: 'campaign-finished',
    seriesId: 'night-v1',
    seriesName: 'Night Races',
    playerUsername: 'u/RaceFan',
    playerAvatarUrl: 'https://i.redd.it/racefan.png',
    medalDistribution: { author: 2, gold: 3, silver: 1, bronze: 0 },
    stageCount: 6,
};

function finishedRoot(postData = FINISHED_POST) {
    return { devvit: { context: { postData } } };
}

function createPoster() {
    const elements = new Map();
    const getElement = (id) => {
        if (!elements.has(id)) elements.set(id, { hidden: true, setAttribute: vi.fn() });
        return elements.get(id);
    };
    return {
        getElement,
        render: (postData) => renderCampaignFinishedPoster(
            { getElementById: getElement },
            readCampaignFinishedPostData(finishedRoot(postData)),
        ),
    };
}

function stat(getElement, name) {
    const block = getElement(`campaign-finished-${name}`);
    return block.hidden ? null : getElement(`campaign-finished-${name}-value`).textContent;
}

describe('campaign launcher custom post', () => {
    it('names the Campaign series The Numbers', () => {
        const markup = readFileSync(new URL('../pages/campaign.html', import.meta.url), 'utf8');

        expect(markup).toContain('class="campaign-eyebrow">The Numbers</p>');
        expect(markup).not.toContain('Permanent series');
    });

    it('stacks the finished poster as player, Campaign Complete, track, stats and action', () => {
        const markup = readFileSync(new URL('../pages/campaign.html', import.meta.url), 'utf8');
        const order = ['campaign-finished-avatar', 'campaign-finished-series', 'campaign-finished-title',
            'campaign-finished-track', 'campaign-finished-place', 'campaign-finished-medals',
            'campaign-finished-time', 'campaign-finished-race-btn']
            .map((id) => markup.indexOf(`id="${id}"`));

        expect(order).not.toContain(-1);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(markup).toMatch(/finished-title__first">Campaign<[\s\S]*finished-title__second">Complete</);
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

    it('binds the finished poster action when the poster is shown', () => {
        const button = { dataset: {}, addEventListener: vi.fn() };
        const ids = [];
        const documentRef = {
            getElementById: (id) => {
                ids.push(id);
                return id === 'campaign-finished-poster' ? { hidden: false } : button;
            },
        };

        bindCampaignRaceButton(documentRef, vi.fn());

        expect(ids).toContain('campaign-finished-race-btn');
        expect(ids).not.toContain('campaign-race-btn');
    });

    it('keeps normal launchers separate from finished campaign posts', () => {
        expect(readCampaignFinishedPostData(finishedRoot({ postType: 'campaign-launcher' }))).toBeNull();
        expect(readCampaignFinishedPostData(finishedRoot({
            ...FINISHED_POST, totalTimeMs: 187654, bestTrackKey: 'numberThree',
        }))).toMatchObject({
            seriesId: 'night-v1',
            seriesName: 'Night Races',
            playerUsername: 'RaceFan',
            playerAvatarUrl: FINISHED_POST.playerAvatarUrl,
            medalDistribution: FINISHED_POST.medalDistribution,
            stageCount: 6,
            totalTimeMs: 187654,
            bestTrackKey: 'numberThree',
        });
    });

    it('renders the player, series, place, medal score, total time and Campaign action', () => {
        const { getElement, render } = createPoster();

        render({ ...FINISHED_POST, place: { rank: 4, total: 128 }, totalTimeMs: 187654 });

        expect(getElement('campaign-launcher').hidden).toBe(true);
        expect(getElement('campaign-finished-poster').hidden).toBe(false);
        expect(getElement('campaign-finished-name').textContent).toBe('RaceFan');
        expect(getElement('campaign-finished-avatar').src).toBe(FINISHED_POST.playerAvatarUrl);
        expect(getElement('campaign-finished-series').textContent).toBe('Night Races');
        expect(stat(getElement, 'place')).toBe('#4 / 128');
        expect(stat(getElement, 'medals')).toBe('19/24');
        expect(stat(getElement, 'time')).toBe('3:07.654');
        expect(getElement('campaign-finished-race-btn').disabled).toBe(false);

        render({ ...FINISHED_POST, seriesId: null, playerAvatarUrl: 'https://example.com/avatar.png' });
        expect(getElement('campaign-finished-avatar').src).toBe(GENERIC_SNOO_URL);
        expect(getElement('campaign-finished-race-btn').disabled).toBe(true);
    });

    it('hides each stat the post does not carry', () => {
        const { getElement, render } = createPoster();

        render({ ...FINISHED_POST, stageCount: undefined, totalTimeMs: 0, place: { rank: 4, total: 3 } });

        expect(stat(getElement, 'place')).toBeNull();
        expect(stat(getElement, 'medals')).toBeNull();
        expect(stat(getElement, 'time')).toBeNull();
    });

    it('draws the best-placed track with the poster car, and leaves it hidden when the track is unknown', async () => {
        globalThis.requestAnimationFrame = () => 1;
        globalThis.cancelAnimationFrame = () => {};
        const canvas = { hidden: true };
        const documentRef = { getElementById: (id) => (id === 'campaign-finished-track' ? canvas : null) };

        await showFinishedTrack(documentRef, 'no-such-track');
        expect(canvas.hidden).toBe(true);
        expect(renderPosterTrack).not.toHaveBeenCalled();

        await showFinishedTrack(documentRef, 'numberThree');
        expect(canvas.hidden).toBe(false);
        expect(renderPosterTrack).toHaveBeenCalledWith(canvas, 'numberThree', null, 1);
        expect(renderPosterTrack).toHaveBeenLastCalledWith(canvas, 'numberThree', carImage, expect.any(Number));
    });

    it('lists places up to 100th and shows a top percent after that', () => {
        expect(formatCampaignOverallPlace({ rank: 1, total: 40 })).toBe('#1 / 40');
        expect(formatCampaignOverallPlace({ rank: 100, total: 5000 })).toBe('#100 / 5000');
        expect(formatCampaignOverallPlace({ rank: 101, total: 1000 })).toBe('TOP 11%');
        expect(formatCampaignOverallPlace({ rank: 342, total: 2850 })).toBe('TOP 12%');
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
