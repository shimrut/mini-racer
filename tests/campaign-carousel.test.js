import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
    buildCampaignCarouselCards,
    formatCampaignStageLabel,
} from '../game/campaign/carousel-model.js';
import { normalizeCampaignLobbyState } from '../game/lobby/service.js';
import { campaignEngineMethods } from '../game/campaign/engine-methods.js';
import { clearStoredSeriesForTests, registerStoredSeries } from '../game/campaign/stored-series.js';
import { TrackCarousel } from '../game/ui/track-carousel.js';

function campaignState(stageOverrides = [], stateOverrides = {}) {
    const trackKeys = ['circuit', 'sunlitTemple', 'royalPlateau', 'mistwoodSerpent'];
    const stages = trackKeys.map((trackKey, index) => ({
        id: `numbered-v1-0${index}`,
        index,
        numberLabel: String(index).padStart(2, '0'),
        trackKey,
        trackName: `Number ${index}`,
        laps: 1,
        unlocked: index === 0,
        bestTimeMs: null,
        medal: null,
        standingsResolved: true,
        ...(stageOverrides[index] || {}),
    }));
    return normalizeCampaignLobbyState({ stages, resolved: true, ...stateOverrides });
}

describe('campaign carousel card model', () => {
    it('numbers the stages instead of dating them', () => {
        expect(formatCampaignStageLabel({ numberLabel: '03' })).toBe('Stage 03');
        expect(formatCampaignStageLabel({ numberLabel: '  ' })).toBe('Stage');
        expect(formatCampaignStageLabel(null)).toBe('Stage');
    });

    it('keeps every stage in campaign order, locked ones included', () => {
        const cards = buildCampaignCarouselCards(campaignState());

        expect(cards.map((card) => card.challengeId)).toEqual([
            'numbered-v1-00',
            'numbered-v1-01',
            'numbered-v1-02',
            'numbered-v1-03',
        ]);
        expect(cards.map((card) => card.locked)).toEqual([false, true, true, true]);
    });

    it('marks the stage the campaign is asking for next', () => {
        const cards = buildCampaignCarouselCards(campaignState([
            { unlocked: true, medal: 'gold', bestTimeMs: 18_400 },
            { unlocked: true },
        ]));

        expect(cards.map((card) => card.isCurrent)).toEqual([false, true, false, false]);
    });

    it('marks no stage current once the campaign is finished', () => {
        const cards = buildCampaignCarouselCards(campaignState([
            { unlocked: true, medal: 'gold', bestTimeMs: 18_400 },
            { unlocked: true, medal: 'gold', bestTimeMs: 21_100 },
            { unlocked: true, medal: 'author', bestTimeMs: 24_000 },
            { unlocked: true, medal: 'gold', bestTimeMs: 26_500 },
        ]));

        expect(cards.map((card) => card.isCurrent)).toEqual([false, false, false, false]);
    });

    it('states the gate on a locked stage', () => {
        const cards = buildCampaignCarouselCards(campaignState());

        expect(cards[1].locked).toBe(true);
        expect(cards[1].lockedLabel).toContain('Earn any medal on');
    });

    it('carries both unlock requirements to the card', () => {
        const cards = buildCampaignCarouselCards(campaignState([
            { unlocked: true, medal: null },
            {
                unlocked: false,
                unlock: { type: 'medal_total', requiredMedals: 3, previousRaceId: 'numbered-v1-00' },
            },
        ]));

        expect(cards[1].unlockRequirements).toEqual([
            {
                id: 'previous-medal',
                copy: 'Earn any medal on Number 0',
                satisfied: false,
            },
            {
                id: 'medal-total',
                copy: 'Additional medals needed',
                satisfied: false,
                medalTotal: 0,
                requiredMedals: 3,
                remainingMedals: 3,
            },
        ]);
    });

    it('hands the medal count to the card', () => {
        const cards = buildCampaignCarouselCards(campaignState([
            { unlocked: true, medal: 'gold' },
            {
                unlocked: false,
                laps: 3,
                unlock: { type: 'medal_total', requiredMedals: 12, previousRaceId: 'numbered-v1-00' },
            },
        ]));

        expect(cards[1].lockMeter).toEqual({ label: 'Medals', remainingMedals: 9, ratio: 0.25 });
        expect(cards[1].lockedLabel).toBe('9 more medals needed');
    });

    it('shows the full medal need while the run before is unmedalled', () => {
        const cards = buildCampaignCarouselCards(campaignState([
            { unlocked: true, medal: null },
            {
                unlocked: false,
                unlock: { type: 'medal_total', requiredMedals: 12, previousRaceId: 'numbered-v1-00' },
            },
        ]));

        expect(cards[1].lockMeter).toEqual({ label: 'Medals', remainingMedals: 12, ratio: 0 });
    });

    it('leaves an unlocked card without a meter and never overflows the bar', () => {
        const cards = buildCampaignCarouselCards(campaignState([
            { unlocked: true, medal: 'author' },
            { unlocked: true, medal: 'author' },
            {
                unlocked: false,
                unlock: { type: 'medal_total', requiredMedals: 3, previousRaceId: 'numbered-v1-02' },
            },
        ]));

        expect(cards[0].lockMeter).toBeNull();
        expect(cards[2].lockMeter).toBeNull();
        expect(cards[2].lockedLabel).toBe('Complete the previous stage first');
        expect(cards[3].lockMeter).toBeNull();
    });

    it('carries the banked time and medal onto the card', () => {
        const cards = buildCampaignCarouselCards(campaignState([
            { unlocked: true, bestTimeMs: 18_400, medal: 'silver', laps: 3 },
        ]));

        expect(cards[0].laps).toBe(3);
        expect(cards[0].bestLabel).toBe('0:18.400');
        expect(cards[0].medal).toBe('silver');
    });

    it('lists every medal tier the stage offers, marking the ones earned', () => {
        const [silver, none] = buildCampaignCarouselCards(campaignState([
            { unlocked: true, medal: 'silver', bestTimeMs: 20_000 },
            { unlocked: true, medal: null, bestTimeMs: null },
        ]));

        expect(silver.medalTiers.map((slot) => slot.tier))
            .toEqual(['bronze', 'silver', 'gold', 'author']);
        expect(silver.medalTiers.map((slot) => slot.filled))
            .toEqual([true, true, false, false]);
        expect(none.medalTiers.some((slot) => slot.filled)).toBe(false);
    });

    it('separates a rank still loading from a stage never raced', () => {
        const [ranked, unranked] = buildCampaignCarouselCards(campaignState([
            { unlocked: true, playerRank: 4 },
            { unlocked: true, playerRank: null },
        ]));
        const [pending] = buildCampaignCarouselCards(campaignState([
            { unlocked: true, playerRank: null, standingsResolved: false },
        ]));

        expect([ranked.rankLabel, ranked.rankPending]).toEqual(['#4', false]);
        expect([unranked.rankLabel, unranked.rankPending]).toEqual([null, false]);
        expect([pending.rankLabel, pending.rankPending]).toEqual([null, true]);
    });

    it('drops a stage whose track is not in the build', () => {
        const cards = buildCampaignCarouselCards(campaignState([
            { trackKey: 'not-a-real-track' },
        ]));

        expect(cards.map((card) => card.challengeId)).not.toContain('numbered-v1-00');
        expect(cards).toHaveLength(3);
    });

    it('has nothing to show without a campaign state', () => {
        expect(buildCampaignCarouselCards()).toEqual([]);
        expect(buildCampaignCarouselCards({ stages: null })).toEqual([]);
    });
});

describe('campaign carousel engine wiring', () => {
    const lobbyPaintState = {
        activeRaceMode: 'campaign',
        status: 'ready',
        startButtonPending: false,
        startOverlay: { isStartOverlayVisible: () => true },
        lobbyUi: { getMode: () => 'campaign' },
    };

    it('opens on the stage the campaign is asking for', () => {
        const render = vi.fn();
        const engine = {
            ...lobbyPaintState,
            campaignCarousel: { render },
            campaignLobbyState: campaignState([{ unlocked: true }, { unlocked: true }]),
            _campaignBootstrapReady: true,
        };

        campaignEngineMethods.paintCampaignCarousel.call(engine);

        expect(render.mock.calls[0][0]).toHaveLength(4);
        expect(render.mock.calls[0][1]).toMatchObject({
            selectedChallengeId: 'numbered-v1-00',
            loading: false,
        });
    });

    it('opens a finished campaign on its last stage, not back at Stage 00', () => {
        const render = vi.fn();
        const engine = {
            ...lobbyPaintState,
            campaignCarousel: { render },
            campaignLobbyState: campaignState([
                { unlocked: true, medal: 'gold', bestTimeMs: 18_400 },
                { unlocked: true, medal: 'gold', bestTimeMs: 21_100 },
                { unlocked: true, medal: 'gold', bestTimeMs: 24_000 },
                { unlocked: true, medal: 'gold', bestTimeMs: 26_500 },
            ]),
            _campaignBootstrapReady: true,
        };

        campaignEngineMethods.paintCampaignCarousel.call(engine);

        expect(render.mock.calls[0][1].selectedChallengeId).toBe('numbered-v1-03');
    });

    it('keeps the stage the player picked over the campaign default', () => {
        const render = vi.fn();
        const engine = {
            ...lobbyPaintState,
            campaignCarousel: { render },
            campaignLobbyState: campaignState([{ unlocked: true }, { unlocked: true }]),
            selectedCampaignStageId: 'numbered-v1-01',
            _campaignBootstrapReady: true,
        };

        campaignEngineMethods.paintCampaignCarousel.call(engine);

        expect(render.mock.calls[0][1].selectedChallengeId).toBe('numbered-v1-01');
    });

    it('paints as loading until the bootstrap resolves', () => {
        const render = vi.fn();
        campaignEngineMethods.paintCampaignCarousel.call({
            ...lobbyPaintState,
            campaignCarousel: { render },
            campaignLobbyState: campaignState(),
            _campaignBootstrapReady: false,
        });

        expect(render.mock.calls[0][1].loading).toBe(true);
    });

    it('does not paint the Campaign carousel while a race is running', () => {
        const render = vi.fn();
        campaignEngineMethods.paintCampaignCarousel.call({
            ...lobbyPaintState,
            campaignCarousel: { render },
            campaignLobbyState: campaignState(),
            status: 'playing',
            _campaignBootstrapReady: true,
        });

        expect(render).not.toHaveBeenCalled();
    });

    it('does not paint the Campaign carousel once race start is pending', () => {
        const render = vi.fn();
        campaignEngineMethods.paintCampaignCarousel.call({
            ...lobbyPaintState,
            campaignCarousel: { render },
            campaignLobbyState: campaignState(),
            startButtonPending: true,
            _campaignBootstrapReady: true,
        });

        expect(render).not.toHaveBeenCalled();
    });

    it('points the primary button at whichever stage is centred', () => {
        const setCampaignSelectedStage = vi.fn();
        const engine = { lobbyUi: { setCampaignSelectedStage } };
        const stage = { id: 'numbered-v1-02', unlocked: true };

        campaignEngineMethods.handleCampaignCarouselSelect.call(engine, stage);

        expect(engine.selectedCampaignStageId).toBe('numbered-v1-02');
        expect(setCampaignSelectedStage).toHaveBeenCalledWith(stage);
    });

    it('ignores a selection without a stage behind it', () => {
        const setCampaignSelectedStage = vi.fn();
        const engine = {
            lobbyUi: { setCampaignSelectedStage },
            selectedCampaignStageId: 'numbered-v1-01',
        };

        campaignEngineMethods.handleCampaignCarouselSelect.call(engine, null);

        expect(engine.selectedCampaignStageId).toBe('numbered-v1-01');
        expect(setCampaignSelectedStage).not.toHaveBeenCalled();
    });

    it('never prepares a locked stage, and prepares the stage it stopped on', () => {
        const prepareSelectedRaceTrack = vi.fn();
        const engine = {
            status: 'ready',
            startOverlay: { isStartOverlayVisible: () => true },
            prepareSelectedRaceTrack,
        };

        campaignEngineMethods.handleCampaignCarouselSettled.call(engine, {
            locked: true,
            challenge: { id: 'numbered-v1-01', trackKey: 'circuit' },
        });
        expect(prepareSelectedRaceTrack).not.toHaveBeenCalled();

        campaignEngineMethods.handleCampaignCarouselSettled.call(engine, {
            locked: false,
            challenge: { id: 'numbered-v1-01', trackKey: 'circuit' },
        });
        expect(prepareSelectedRaceTrack).toHaveBeenCalledWith('campaign', expect.objectContaining({
            trackKey: 'circuit',
            challenge: expect.objectContaining({ trackKey: 'circuit', skin: 'default' }),
        }));
    });
});

describe('campaign card medal targets', () => {
    it('leaves the target times off the card entirely', () => {
        const cards = buildCampaignCarouselCards(campaignState([
            { unlocked: true, bestTimeMs: 60_000, medal: 'bronze' },
            { unlocked: true, bestTimeMs: 20_000, medal: 'gold' },
        ]));

        for (const card of cards) expect(card.chase).toBeUndefined();
        expect(cards[0].medalTiers.map(({ tier, filled }) => [tier, filled])).toEqual([
            ['bronze', true], ['silver', false], ['gold', false], ['author', false],
        ]);
    });
});

describe('campaign placeholder after the last stage', () => {
    afterEach(() => clearStoredSeriesForTests());

    const growingStages = [
        { trackKey: 'circuit', laps: 1, requiredMedals: 0 },
        { trackKey: 'sunlitTemple', laps: 1, requiredMedals: 1 },
    ];

    function growingState(stateOverrides = {}) {
        return campaignState([], { seriesId: 'growing-v1', ...stateOverrides });
    }

    it('ends a series without a final stage on a More stages card', () => {
        registerStoredSeries([{ id: 'growing-v1', name: 'Growing', stages: growingStages }]);
        const cards = buildCampaignCarouselCards(growingState());

        expect(cards).toHaveLength(5);
        expect(cards.at(-1)).toEqual({
            challengeId: 'growing-v1-more',
            challenge: { id: 'growing-v1-more', placeholder: true, unlocked: false, trackName: 'More stages' },
            trackName: 'More stages',
            placeholder: true,
            locked: false,
        });
        expect(cards.slice(0, -1).some((card) => card.placeholder)).toBe(false);
    });

    it('adds no placeholder once the Creator publishes the final stage', () => {
        registerStoredSeries([{
            id: 'growing-v1', name: 'Growing', finalStageId: 'growing-v1-01', stages: growingStages,
        }]);

        expect(buildCampaignCarouselCards(growingState()).some((card) => card.placeholder)).toBe(false);
    });

    it('adds no placeholder to Numbers, to an unknown series, or to an empty rail', () => {
        registerStoredSeries([{ id: 'growing-v1', name: 'Growing', stages: growingStages }]);

        expect(buildCampaignCarouselCards(campaignState([], { seriesId: 'numbered-v1' }))
            .some((card) => card.placeholder)).toBe(false);
        expect(buildCampaignCarouselCards(campaignState([], { seriesId: 'missing-v1' }))
            .some((card) => card.placeholder)).toBe(false);
        expect(buildCampaignCarouselCards(growingState({
            stages: [{ id: 'growing-v1-00', trackKey: 'not-a-real-track' }],
        }))).toEqual([]);
    });

    it('never prepares the placeholder as a race track', () => {
        const prepareSelectedRaceTrack = vi.fn();
        campaignEngineMethods.handleCampaignCarouselSettled.call({
            status: 'ready',
            startOverlay: { isStartOverlayVisible: () => true },
            prepareSelectedRaceTrack,
        }, { placeholder: true, locked: false, challenge: { id: 'growing-v1-more', placeholder: true } });

        expect(prepareSelectedRaceTrack).not.toHaveBeenCalled();
    });

    function mountCarousel() {
        const dom = new JSDOM(`<div id="campaign-carousel">
            <div id="campaign-carousel-viewport"><div id="campaign-carousel-rail"></div></div>
            <button id="campaign-carousel-prev"></button><button id="campaign-carousel-next"></button>
            <div id="campaign-carousel-navigation"><span id="campaign-carousel-count"></span></div>
        </div>`);
        const originals = { document: global.document, window: global.window };
        global.document = dom.window.document;
        global.window = dom.window;
        const carousel = new TrackCarousel({ idPrefix: 'campaign-carousel' });
        carousel.bind();
        return {
            carousel,
            document: dom.window.document,
            restore() {
                global.document = originals.document;
                global.window = originals.window;
            },
        };
    }

    it('draws the placeholder as an empty track with no time, rank or medals', () => {
        const { carousel, document, restore } = mountCarousel();
        try {
            carousel.render([
                { challengeId: 'growing-v1-00', challenge: { id: 'growing-v1-00' }, trackName: 'Stage', bestLabel: '0:40.000', medalTiers: [] },
                { challengeId: 'growing-v1-more', challenge: { id: 'growing-v1-more', placeholder: true }, trackName: 'More stages', placeholder: true },
            ], { selectedChallengeId: 'growing-v1-more' });

            const card = document.querySelector('[data-challenge-id="growing-v1-more"]');
            expect(card.classList.contains('is-placeholder')).toBe(true);
            expect(card.getAttribute('aria-label')).toBe('More stages');
            expect(card.querySelector('canvas')).toBeNull();
            expect(card.querySelector('svg.track-carousel__placeholder-art')).not.toBeNull();
            expect(card.querySelector('.track-carousel__gate').hidden).toBe(true);

            const parts = carousel._footParts;
            expect(parts.meta.hidden).toBe(true);
            expect(parts.medal.hidden).toBe(true);
            expect(parts.medal.disabled).toBe(true);
            expect(parts.requirement.hidden).toBe(true);
            expect(parts.verificationError.hidden).toBe(true);
        } finally {
            restore();
        }
    });

    it('counts only the stages, and shows no number on the placeholder', () => {
        const { carousel, document, restore } = mountCarousel();
        try {
            carousel.render([
                { challengeId: 'growing-v1-00', challenge: { id: 'growing-v1-00' }, trackName: 'A', medalTiers: [] },
                { challengeId: 'growing-v1-01', challenge: { id: 'growing-v1-01' }, trackName: 'B', medalTiers: [] },
                { challengeId: 'growing-v1-more', challenge: { id: 'growing-v1-more', placeholder: true }, trackName: 'More stages', placeholder: true },
            ], { selectedChallengeId: 'growing-v1-01' });
            const count = document.getElementById('campaign-carousel-count');
            expect(count.textContent).toBe('2 / 2');
            expect(count.getAttribute('aria-label')).toBe('Track 2 of 2');
            expect(document.getElementById('campaign-carousel-next').disabled).toBe(false);

            carousel.step(1);
            expect(carousel.getSelectedChallenge().placeholder).toBe(true);
            expect(count.textContent).toBe('');
            expect(count.hasAttribute('aria-label')).toBe(false);
            expect(document.getElementById('campaign-carousel-next').disabled).toBe(true);
        } finally {
            restore();
        }
    });
});
