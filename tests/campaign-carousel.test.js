import { describe, expect, it, vi } from 'vitest';
import {
    buildCampaignCarouselCards,
    formatCampaignStageLabel,
} from '../game/campaign/carousel-model.js';
import { normalizeCampaignLobbyState } from '../game/lobby/service.js';
import { campaignEngineMethods } from '../game/campaign/engine-methods.js';

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
        expect(cards[0].modeLabel).toBe('Campaign');
        expect(cards[0].billingLabel).toBe('Stage 00');
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

    it('states the gate on a locked stage rather than its lap count', () => {
        const cards = buildCampaignCarouselCards(campaignState());

        expect(cards[0].metaLabel).toBe('1 Lap');
        expect(cards[1].locked).toBe(true);
        expect(cards[1].metaLabel).toContain('Earn any medal on');
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

    it('hands the medal count to the card and stops repeating it in the meta', () => {
        const cards = buildCampaignCarouselCards(campaignState([
            { unlocked: true, medal: 'gold' },
            {
                unlocked: false,
                laps: 3,
                unlock: { type: 'medal_total', requiredMedals: 12, previousRaceId: 'numbered-v1-00' },
            },
        ]));

        expect(cards[1].lockMeter).toEqual({ label: 'Medals', remainingMedals: 9, ratio: 0.25 });
        expect(cards[1].metaLabel).toBe('3 Laps');
        expect(cards[1].lockedLabel).toBe('9 more medals needed');
    });

    it('keeps the sentence on the meta line while the run before is unmedalled', () => {
        const cards = buildCampaignCarouselCards(campaignState([
            { unlocked: true, medal: null },
            {
                unlocked: false,
                unlock: { type: 'medal_total', requiredMedals: 12, previousRaceId: 'numbered-v1-00' },
            },
        ]));

        expect(cards[1].metaLabel).toBe('Earn any medal on Number 0');
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

        expect(cards[0].lapsLabel).toBe('3 Laps');
        expect(cards[0].metaLabel).toBe('3 Laps · PB 0:18.400');
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

    it('never prewarms a locked stage', () => {
        const prewarmDailyPlaylistTracks = vi.fn();
        const engine = {
            status: 'ready',
            startOverlay: { isStartOverlayVisible: () => true },
            prewarmDailyPlaylistTracks,
        };

        campaignEngineMethods.handleCampaignCarouselSettled.call(engine, {
            locked: true,
            challenge: { trackKey: 'circuit' },
        });
        expect(prewarmDailyPlaylistTracks).not.toHaveBeenCalled();

        campaignEngineMethods.handleCampaignCarouselSettled.call(engine, {
            locked: false,
            challenge: { trackKey: 'circuit' },
        });
        expect(prewarmDailyPlaylistTracks).toHaveBeenCalledWith(
            [{ trackKey: 'circuit' }],
            { requireModal: false },
        );
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
