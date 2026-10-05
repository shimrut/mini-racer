import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    bindCampaignRaceButton,
    campaignPosterTheme,
    campaignPosterPlace,
    campaignPosterTime,
    openCampaignGame,
    prepareCampaignPoster,
    readCampaignFinishedPostData,
    renderCampaignFinishedPoster,
    renderCampaignPosterTrack,
} from '../pages/campaign.js';
import { GENERIC_SNOO_URL } from '../game/ui/avatar.js';
import { renderTrackPreviewCanvas } from '../game/track/preview-renderer.js';

vi.mock('../game/track/preview-renderer.js', () => ({ renderTrackPreviewCanvas: vi.fn() }));

const FINISHED_POST = {
    postType: 'campaign-finished',
    seriesId: 'night-v1',
    seriesName: 'Night Races',
    playerUsername: 'u/RaceFan',
    playerAvatarUrl: 'https://i.redd.it/racefan.png',
    medalDistribution: { author: 2, gold: 3, silver: 1, bronze: 0 },
    stageCount: 6,
    totalTimeMs: 268_123,
    trackKey: 'numberThree',
    ground: 'tarmac',
    grounds: ['tarmac'],
};

function finishedRoot(postData = FINISHED_POST) {
    return { devvit: { context: { postData } } };
}

describe('campaign launcher custom post', () => {
    it('names the Campaign series The Numbers', () => {
        const markup = readFileSync(new URL('../pages/campaign.html', import.meta.url), 'utf8');

        expect(markup).toContain('class="campaign-eyebrow">The Numbers</p>');
        expect(markup).toContain('id="campaign-place"');
        expect(markup).not.toContain('id="campaign-medals"');
        expect(markup).not.toContain('data-campaign-medal');
        expect(markup).not.toContain('Permanent series');
        expect(markup.indexOf('id="campaign-player-name"')).toBeLessThan(markup.indexOf('id="campaign-player-avatar"'));
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

    it('renders the player, finished track count, medal total and specific Campaign action', () => {
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
        getElement('campaign-title').append = (...nodes) => {
            getElement('campaign-title').textContent = nodes.map((node) => node.textContent).join(' ');
        };
        const documentRef = {
            getElementById: getElement, querySelector: () => launcher,
            createElement: () => ({ append(...children) { this.children = children; } }), body: { setAttribute: vi.fn() },
        };

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot()));

        expect(getElement('campaign-player').hidden).toBe(false);
        expect(getElement('campaign-player-name').textContent).toBe('RaceFan');
        expect(getElement('campaign-player-avatar').src).toBe(FINISHED_POST.playerAvatarUrl);
        expect(getElement('campaign-title').textContent).toBe('Campaign Complete!');
        expect(getElement('campaign-eyebrow').textContent).toBe('Night Races');
        expect(getElement('campaign-tracks-value').textContent).toBe('6');
        expect(getElement('campaign-medal-total-value').textContent).toBe('19 / 24');
        expect(getElement('campaign-total-time-value').textContent).toBe('4:28');
        expect(getElement('campaign-total-time').setAttribute).toHaveBeenCalledWith('aria-label', 'Total best time 4:28.123');
        expect(getElement('campaign-description').textContent).toBe('I finished the Night Races campaign.');
        expect(getElement('campaign-place').hidden).toBe(true);
        expect(getElement('campaign-race-btn').textContent).toBe('Play Campaign');
        expect(getElement('campaign-race-btn').disabled).toBe(false);

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot({
            ...FINISHED_POST, seriesId: null, playerAvatarUrl: 'https://example.com/avatar.png',
            place: { rank: 2, total: 12 },
        })));
        expect(getElement('campaign-player-avatar').src).toBe(GENERIC_SNOO_URL);
        expect(getElement('campaign-race-btn').disabled).toBe(true);
        expect(getElement('campaign-place').hidden).toBe(false);
        expect(getElement('campaign-place-value').textContent).toBe('#2');
        expect(getElement('campaign-place-caption').textContent).toBe('out of 12');
        expect(getElement('campaign-place').setAttribute).toHaveBeenCalledWith('aria-label', 'Overall place 2 of 12');

        renderCampaignFinishedPoster(documentRef, readCampaignFinishedPostData(finishedRoot({
            ...FINISHED_POST, place: { rank: 4, total: 3 },
        })));
        expect(getElement('campaign-place').hidden).toBe(true);
    });

    it.each([
        [268123, '4:28'], [4328999, '1:12:08'], [null, ''], [0, ''], [-1, ''],
    ])('formats poster time %s as a compact clock', (time, expected) => {
        expect(campaignPosterTime(time)).toBe(expected);
    });

    it.each([
        [{ rank: 2, total: 24 }, '#2', 'out of 24'],
        [{ rank: 999, total: 1000 }, '#999', 'out of 1000'],
        [{ rank: 2, total: 1001 }, '#2', 'out of 1K'],
        [{ rank: 12, total: 1500 }, '#12', 'out of 1.5K'],
        [{ rank: 12, total: 3000 }, '#12', 'out of 3K'],
        [{ rank: 1235, total: 50431 }, 'Top 3%', 'out of 50.4K'],
        [{ rank: 1000, total: 1000000 }, 'Top 1%', 'out of 1000K'],
        [{ rank: 1000, total: 1000 }, 'Top 100%', 'out of 1000'],
    ])('formats poster place %j without a long fraction', (place, headline, caption) => {
        expect(campaignPosterPlace(place)).toEqual({ headline, caption });
    });

    it('omits invalid places', () => {
        expect(campaignPosterPlace(null)).toBeNull();
        expect(campaignPosterPlace({ rank: 4, total: 3 })).toBeNull();
    });

    it('keeps legacy posts accurate without fabricating time or a Creator track', () => {
        const legacy = readCampaignFinishedPostData(finishedRoot({
            ...FINISHED_POST, stageCount: undefined, totalTimeMs: undefined, trackKey: undefined,
        }));
        expect(legacy).toMatchObject({ stageCount: 6, completedTracks: 6, medalCount: 19, totalTimeMs: null, trackKey: '' });
        expect(readCampaignFinishedPostData(finishedRoot({ ...FINISHED_POST, totalTimeMs: '268123' })).totalTimeMs).toBeNull();
        expect(readCampaignFinishedPostData(finishedRoot({ ...FINISHED_POST, seriesId: 'numbered-v1', trackKey: undefined })).trackKey).toBe('endlessLoop');
    });

    it('uses published surfaces for every campaign, including Numbers and Mixed', () => {
        expect(campaignPosterTheme('numbered-v1', 'tarmac')).toBe('street');
        expect(campaignPosterTheme('night-v1', 'tarmac')).toBe('street');
        expect(campaignPosterTheme('grip-v1', 'grip')).toBe('grip');
        expect(campaignPosterTheme('dirt-v1', 'dirt')).toBe('dirt');
        expect(campaignPosterTheme('snow-v1', 'snow')).toBe('snow');
        expect(campaignPosterTheme('night-v1', 'tarmac', ['dirt'])).toBe('dirt');
        expect(campaignPosterTheme('numbered-v1', 'tarmac', ['tarmac', 'dirt'])).toBe('mixed');
        expect(campaignPosterTheme('night-v1', 'grip', ['grip', 'grip'])).toBe('grip');
    });

    it('recovers a legacy Creator final track and Mixed surfaces without changing shared results', async () => {
        const value = readCampaignFinishedPostData(finishedRoot({
            ...FINISHED_POST, seriesId: 'hahah-v1', trackKey: undefined, ground: undefined,
            grounds: undefined, totalTimeMs: undefined,
        }));
        const requestMetadata = vi.fn(async () => ({ ok: true, body: {
            seriesId: 'hahah-v1', trackKey: 'nightCircuit', ground: 'tarmac',
            grounds: ['tarmac', 'dirt'], storedTracks: [{ key: 'nightCircuit' }],
        } }));
        const registerTracks = vi.fn();
        const ensureTracks = vi.fn(async () => {});
        const prepared = await prepareCampaignPoster(value, { requestMetadata, registerTracks, ensureTracks });
        expect(requestMetadata).toHaveBeenCalledWith('hahah-v1');
        expect(registerTracks).toHaveBeenCalledWith([{ key: 'nightCircuit' }]);
        expect(ensureTracks).toHaveBeenCalledWith(['nightCircuit'], { includeBuiltIn: true });
        expect(prepared).toMatchObject({
            seriesId: 'hahah-v1', trackKey: 'nightCircuit', grounds: ['tarmac', 'dirt'],
            medalDistribution: FINISHED_POST.medalDistribution, totalTimeMs: null,
        });
        expect(campaignPosterTheme(prepared.seriesId, prepared.ground, prepared.grounds)).toBe('mixed');
    });

    it('keeps new post artwork pinned and does not fetch a catalog for complete metadata', async () => {
        const value = readCampaignFinishedPostData(finishedRoot());
        const requestMetadata = vi.fn();
        const ensureTracks = vi.fn(async () => {});
        await expect(prepareCampaignPoster(value, { requestMetadata, ensureTracks })).resolves.toBe(value);
        expect(requestMetadata).not.toHaveBeenCalled();
        expect(ensureTracks).toHaveBeenCalledWith(['numberThree'], { includeBuiltIn: true });
    });

    it('keeps metrics and the exact series when recovery fails or returns another series', async () => {
        const value = readCampaignFinishedPostData(finishedRoot({ ...FINISHED_POST, trackKey: undefined, grounds: undefined }));
        for (const response of [{ ok: false, body: null }, { ok: true, body: { seriesId: 'other-v1', trackKey: 'numberThree' } }]) {
            const ensureTracks = vi.fn();
            const registerTracks = vi.fn();
            await expect(prepareCampaignPoster(value, {
                requestMetadata: async () => response, ensureTracks, registerTracks,
            })).resolves.toBe(value);
            expect(ensureTracks).not.toHaveBeenCalled();
            expect(registerTracks).not.toHaveBeenCalled();
        }
    });

    it('renders the real track with the H2H car slot and hides unavailable artwork', () => {
        const canvas = { getBoundingClientRect: () => ({ width: 320, height: 200 }) };
        const documentRef = { getElementById: () => canvas };
        const car = { image: { width: 8, height: 8 }, travel: 0.5 };
        renderCampaignPosterTrack(documentRef, FINISHED_POST, car);
        expect(canvas.hidden).toBe(false);
        expect(renderTrackPreviewCanvas).toHaveBeenLastCalledWith(canvas, expect.objectContaining({
            previewRenderMode: 'schematic', schematicCarImage: car.image,
            schematicCarTravel: 0.5, schematicReserveCarSlot: true,
            hideSchematicStartArrow: true, showSchematicCarTrail: true,
        }));
        renderCampaignPosterTrack(documentRef, { trackKey: 'missingTrack' });
        expect(canvas.hidden).toBe(true);
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
