import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PbGhostService } from '../game/ghost/pb-ghost-service.js';

const serviceMocks = vi.hoisted(() => ({
    getCampaignPbGhost: vi.fn(),
}));

vi.mock('../game/campaign/service.js', async (importOriginal) => ({
    ...(await importOriginal()),
    getCampaignPbGhost: serviceMocks.getCampaignPbGhost,
}));

const { campaignEngineMethods } = await import('../game/campaign/engine-methods.js');

const stage = { raceId: 'race-1', trackKey: 'circuit' };
const ghost = { finishTimeMs: 100 };

function pbAnswer(personalBest) {
    return { ok: true, body: { personalBest } };
}

function campaignEngine() {
    return {
        activeCampaignStage: stage,
        applyCampaignPersonalBest: vi.fn(),
        loadInitialCampaignPersonalBest: campaignEngineMethods.loadInitialCampaignPersonalBest,
    };
}

describe('Campaign PB cache with moved ghosts', () => {
    beforeEach(() => {
        serviceMocks.getCampaignPbGhost.mockReset();
    });

    it('applies an unavailable ghost answer but does not cache it, so the next start asks again', async () => {
        const engine = campaignEngine();
        const unavailable = { bestTimeMs: 100, ghost: null, ghostUnavailable: true };
        serviceMocks.getCampaignPbGhost.mockResolvedValueOnce(pbAnswer(unavailable));
        await engine.loadInitialCampaignPersonalBest(stage);
        expect(engine.applyCampaignPersonalBest).toHaveBeenCalledWith(stage, unavailable);
        expect(engine.campaignPbGhostByRaceId).not.toHaveProperty(stage.raceId);

        const available = { bestTimeMs: 100, ghost };
        serviceMocks.getCampaignPbGhost.mockResolvedValueOnce(pbAnswer(available));
        await engine.loadInitialCampaignPersonalBest(stage);
        expect(engine.campaignPbGhostByRaceId[stage.raceId]).toBe(available);
    });

    it('ignores an older answer that arrives after a newer one', async () => {
        const engine = campaignEngine();
        let answerOlder;
        serviceMocks.getCampaignPbGhost
            .mockImplementationOnce(() => new Promise((resolve) => { answerOlder = resolve; }))
            .mockResolvedValueOnce(pbAnswer({ bestTimeMs: 90, ghost }));
        const older = engine.loadInitialCampaignPersonalBest(stage);
        await engine.loadInitialCampaignPersonalBest(stage);
        answerOlder(pbAnswer({ bestTimeMs: 120, ghost }));
        await older;

        expect(engine.applyCampaignPersonalBest).toHaveBeenCalledTimes(1);
        expect(engine.applyCampaignPersonalBest).toHaveBeenCalledWith(stage, { bestTimeMs: 90, ghost });
        expect(engine.campaignPbGhostByRaceId[stage.raceId]).toEqual({ bestTimeMs: 90, ghost });
    });
});

describe('Daily PB ghost cache with moved ghosts', () => {
    let originalLocation;

    beforeEach(() => {
        originalLocation = globalThis.location;
        globalThis.location = { origin: 'https://example.test' };
    });

    afterEach(() => {
        globalThis.location = originalLocation;
    });

    function service(answers) {
        const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ personalBest: answers.shift() }) }));
        return {
            fetchImpl,
            service: new PbGhostService({
                routes: { playerTrackPbsUrl: '/api/player/track-pbs', playerPbGhostUrl: '/api/player/pb-ghost' },
                fetchImpl,
            }),
        };
    }

    it('does not cache an unavailable answer from a request or from a submit install', async () => {
        const unavailable = { bestTimeMs: 100, ghost: null, ghostUnavailable: true };
        const { service: pbGhosts, fetchImpl } = service([unavailable, { bestTimeMs: 100, ghost }]);

        await expect(pbGhosts.getForChallenge('daily-1')).resolves.toEqual(unavailable);
        await expect(pbGhosts.getForChallenge('daily-1')).resolves.toEqual({ bestTimeMs: 100, ghost });
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        pbGhosts.installForChallenge('daily-1', unavailable);
        expect(pbGhosts.recordCache.has('daily-1')).toBe(false);
        pbGhosts.installForChallenge('daily-1', { bestTimeMs: 100, ghost });
        expect(pbGhosts.recordCache.get('daily-1')).toEqual({ bestTimeMs: 100, ghost });
    });
});
