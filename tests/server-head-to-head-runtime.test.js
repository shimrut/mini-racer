import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACKS } from '../game/track/tracks.js';
import { CAMPAIGN_STAGES } from '../game/campaign/manifest.js';
import { createTrackFingerprint } from '../src/server/pb-ghost-trace.ts';

const mockDailyChallenge = vi.hoisted(() => vi.fn());
const mockValidateReplay = vi.hoisted(() => vi.fn());
const mockSubmitCampaignRun = vi.hoisted(() => vi.fn());
const mockSubmitDailyRun = vi.hoisted(() => vi.fn());
const mockReadPlayerRank = vi.hoisted(() => vi.fn());
const mockReadEntry = vi.hoisted(() => vi.fn());

const mockGetCampaignProgress = vi.hoisted(() => vi.fn());
const mockRepairStandings = vi.hoisted(() => vi.fn());

vi.mock('../src/server/campaign-store.js', () => ({
    getServerHeadToHeadSource: vi.fn(),
    submitServerCampaignRun: mockSubmitCampaignRun,
    getCampaignProgressForSelection: mockGetCampaignProgress,
    repairCampaignStandingsFromEntries: mockRepairStandings,
}));
vi.mock('../src/server/daily-gp-store.js', () => ({
    getServerDailyGpPlayableChallenge: mockDailyChallenge,
    submitServerDailyGpRun: mockSubmitDailyRun,
}));
vi.mock('../src/server/competition-leaderboard.js', () => ({
    readPlayerRank: mockReadPlayerRank,
    readEntryByPlayerId: mockReadEntry,
}));
vi.mock('../src/server/head-to-head-post.js', () => ({
    resolveHeadToHeadRecord: vi.fn(),
}));
vi.mock('../src/server/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: mockValidateReplay,
}));

const {
    readHeadToHeadViewerBest,
    recordHeadToHeadBest,
    resolveHeadToHeadSource,
    validateHeadToHeadReplay,
} = await import('../src/server/head-to-head-runtime.ts');

const trackKey = 'numberZero';
const trackFingerprint = createTrackFingerprint(TRACKS[trackKey]);
const dailyChallenge = {
    id: 'daily-gp-2026-07-23',
    challengeDate: '2026-07-23',
    trackKey,
    startsAt: '2026-07-23T00:00:00.000Z',
    endsAt: '2026-07-24T00:00:00.000Z',
    availableUntil: '2026-07-30T00:00:00.000Z',
    status: 'active',
    rulesRevision: 1,
    objectiveType: 'single_lap_fastest',
    objectiveParams: { lapCount: 1 },
    skin: 'default',
};

describe('head-to-head runtime', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockDailyChallenge.mockResolvedValue(dailyChallenge);
        mockValidateReplay.mockReturnValue({
            ok: true,
            run: {
                bestTimeSec: 12.345,
                bestTimeMs: 12_345,
                completedLaps: 1,
                ghost: { schemaVersion: 2, finishTimeMs: 12_345 },
            },
        });
    });

    it('builds a Daily challenge source from the exact submitted finish', async () => {
        const replay = {
            rulesRevision: 1,
            targetLapNumber: 1,
            inputs: [{ frames: 240, left: false, right: false, relaunchDelay: false }],
        };
        const source = await resolveHeadToHeadSource({
            source: 'daily',
            challengeId: dailyChallenge.id,
            replay,
        }, 'RaceFan');

        expect(source).toMatchObject({
            sourceKind: 'daily',
            sourceId: dailyChallenge.id,
            origin: { mode: 'daily', challengeId: dailyChallenge.id },
            trackKey,
            bestTimeMs: 12_345,
            ghost: { finishTimeMs: 12_345 },
        });
        expect(mockDailyChallenge).toHaveBeenCalledWith(dailyChallenge.id);
        expect(mockValidateReplay).toHaveBeenCalledWith({
            challenge: dailyChallenge,
            replay,
        });
    });

    it('validates an embedded Daily challenge after its normal window expires', () => {
        const challenge = {
            postType: 'head-to-head',
            challengeId: 'daily-challenge-post',
            origin: { mode: 'daily', challengeId: dailyChallenge.id },
            challengerUsername: 'RaceFan',
            challengerAvatarUrl: null,
            trackKey,
            lapCount: 1,
            targetTimeMs: 20_000,
            medal: 'gold',
            rulesRevision: 1,
            trackFingerprint,
            createdAt: '2026-07-23T12:00:00.000Z',
            subredditName: 'MiniRacer',
            sourceKind: 'daily',
            sourceId: dailyChallenge.id,
            frozenGhost: { schemaVersion: 2, finishTimeMs: 20_000 },
            postId: 't3_challenge-post',
            postUrl: 'https://reddit.com/r/miniracer/challenge-post',
        };

        const result = validateHeadToHeadReplay(challenge, {
            rulesRevision: 1,
            targetLapNumber: 1,
            inputs: [{ frames: 240, left: false, right: false, relaunchDelay: false }],
        });

        expect(result).toMatchObject({
            ok: true,
            bestTimeMs: 12_345,
            ghost: { finishTimeMs: 12_345 },
        });
        expect(mockValidateReplay.mock.calls[0][0].challenge).toMatchObject({
            id: challenge.challengeId,
            availableUntil: '9999-12-31T23:59:59.999Z',
        });
    });
});

describe('head-to-head result written back to its own mode', () => {
    const campaignChallenge = {
        challengeId: 'challenge-post',
        origin: { mode: 'campaign', campaignId: 'numbered-v1', raceId: 'numbered-v1-03' },
        trackKey: 'numberThree',
        lapCount: 1,
        targetTimeMs: 25_640,
    };
    const dailyOriginChallenge = {
        challengeId: 'challenge-post',
        origin: { mode: 'daily', challengeId: dailyChallenge.id },
        trackKey,
        lapCount: 1,
        targetTimeMs: 20_000,
    };
    const viewer = {
        playerId: 'raw-player',
        username: 'ChallengerAce',
        guestToken: 'guest-token',
        canonicalPlayerId: 'reddit:challengerace',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockDailyChallenge.mockResolvedValue(dailyChallenge);
        mockReadPlayerRank.mockResolvedValue(4);
    });

    it('sends a campaign challenge run to its own stage', async () => {
        mockSubmitCampaignRun.mockResolvedValue({
            status: 200,
            body: { accepted: true, improved: true, bestTimeMs: 24_000 },
        });

        const update = await recordHeadToHeadBest(campaignChallenge, { frames: [] }, viewer);

        expect(mockSubmitCampaignRun).toHaveBeenCalledWith(expect.objectContaining({
            raceId: 'numbered-v1-03',
            trackKey: 'numberThree',
            replay: { frames: [] },
            playerId: 'raw-player',
            redditUsername: 'ChallengerAce',
            guestToken: 'guest-token',
        }));
        expect(update).toMatchObject({ mode: 'campaign', improved: true, bestTimeMs: 24_000, rank: 4 });
    });

    it('writes nothing when the campaign stage is locked', async () => {
        mockSubmitCampaignRun.mockResolvedValue({
            status: 403,
            body: { accepted: false, error: 'Campaign race is locked.' },
        });

        expect(await recordHeadToHeadBest(campaignChallenge, { frames: [] }, viewer)).toBeNull();
    });

    it('sends a Daily challenge run to its own Daily', async () => {
        mockSubmitDailyRun.mockResolvedValue({
            status: 200,
            body: { accepted: true, improved: false, bestTimeMs: 19_000 },
        });

        const update = await recordHeadToHeadBest(dailyOriginChallenge, { frames: [] }, viewer);

        expect(mockSubmitDailyRun).toHaveBeenCalledWith(expect.objectContaining({
            challengeId: dailyChallenge.id,
            trackKey,
            replay: { frames: [] },
        }));
        expect(update).toMatchObject({ mode: 'daily', improved: false, bestTimeMs: 19_000 });
    });

    it('writes nothing once the Daily behind the challenge has closed', async () => {
        mockDailyChallenge.mockResolvedValue(null);

        expect(await recordHeadToHeadBest(dailyOriginChallenge, { frames: [] }, viewer)).toBeNull();
        expect(mockSubmitDailyRun).not.toHaveBeenCalled();
    });

    it('keeps the result when the rank cannot be read', async () => {
        mockSubmitCampaignRun.mockResolvedValue({
            status: 200,
            body: { accepted: true, improved: true, bestTimeMs: 24_000 },
        });
        mockReadPlayerRank.mockRejectedValue(new Error('redis unavailable'));

        const update = await recordHeadToHeadBest(campaignChallenge, { frames: [] }, viewer);

        expect(update).toMatchObject({ mode: 'campaign', bestTimeMs: 24_000, rank: null });
    });
});

describe('the best a challenge viewer already holds', () => {
    const campaignChallenge = {
        challengeId: 'challenge-post',
        origin: { mode: 'campaign', campaignId: 'numbered-v1', raceId: 'numbered-v1-03' },
        trackKey: 'numberThree',
        lapCount: 1,
        targetTimeMs: 25_640,
    };
    const dailyOriginChallenge = {
        challengeId: 'challenge-post',
        origin: { mode: 'daily', challengeId: dailyChallenge.id },
        trackKey,
        lapCount: 1,
        targetTimeMs: 20_000,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockReadPlayerRank.mockReset();
        mockReadEntry.mockReset();
        mockDailyChallenge.mockResolvedValue(dailyChallenge);
        mockRepairStandings.mockResolvedValue(undefined);
        mockGetCampaignProgress.mockResolvedValue({
            resultsByRaceId: Object.fromEntries(
                CAMPAIGN_STAGES.map((stage) => [stage.raceId, { medal: 'gold' }]),
            ),
        });
    });

    it('reads the stage entry the submit would compare against', async () => {
        mockReadEntry.mockResolvedValue({ bestTimeMs: 26_500 });
        mockReadPlayerRank.mockResolvedValue(4);

        expect(await readHeadToHeadViewerBest(campaignChallenge, 'reddit:racer'))
            .toMatchObject({
                bestTimeMs: 26_500,
                rank: 4,
                trackLocked: false,
            });
        expect(mockReadEntry).toHaveBeenCalledWith(
            expect.objectContaining({ mode: 'campaign', id: 'numbered-v1-03' }),
            'reddit:racer',
        );
        expect(mockRepairStandings).toHaveBeenCalledWith('reddit:racer');
        expect(mockReadPlayerRank).toHaveBeenCalledWith(
            expect.objectContaining({ mode: 'campaign', id: 'numbered-v1-03' }),
            'reddit:racer',
        );
    });

    it('keeps the stored time when the rank read fails', async () => {
        mockReadEntry.mockResolvedValue({ bestTimeMs: 26_500 });
        mockReadPlayerRank.mockRejectedValue(new Error('redis rank missing'));

        expect(await readHeadToHeadViewerBest(campaignChallenge, 'reddit:racer'))
            .toMatchObject({
                bestTimeMs: 26_500,
                rank: null,
                trackLocked: false,
            });
    });

    it('reads the Daily entry for a Daily challenge', async () => {
        mockReadEntry.mockResolvedValue({ bestTimeMs: 19_500 });

        expect(await readHeadToHeadViewerBest(dailyOriginChallenge, 'guest:racer'))
            .toMatchObject({ bestTimeMs: 19_500 });
        expect(mockReadEntry).toHaveBeenCalledWith(
            expect.objectContaining({ mode: 'daily', id: dailyChallenge.id }),
            'guest:racer',
        );
        expect(mockRepairStandings).not.toHaveBeenCalled();
    });

    it('holds nothing for a racer with no time there', async () => {
        mockReadEntry.mockResolvedValue(null);

        expect(await readHeadToHeadViewerBest(campaignChallenge, 'reddit:racer')).toBeNull();
    });

    it('holds nothing without a player', async () => {
        expect(await readHeadToHeadViewerBest(campaignChallenge, null)).toBeNull();
        expect(mockReadEntry).not.toHaveBeenCalled();
    });

    it('holds nothing once the Daily has closed', async () => {
        mockDailyChallenge.mockResolvedValue(null);

        expect(await readHeadToHeadViewerBest(dailyOriginChallenge, 'reddit:racer')).toBeNull();
        expect(mockReadEntry).not.toHaveBeenCalled();
    });

    it('marks a Campaign stage the player has not unlocked as locked', async () => {
        mockGetCampaignProgress.mockResolvedValue({ resultsByRaceId: {} });

        expect(await readHeadToHeadViewerBest(campaignChallenge, 'reddit:racer')).toEqual({
            bestTimeMs: null,
            medal: null,
            rank: null,
            trackLocked: true,
        });
        expect(mockReadEntry).not.toHaveBeenCalled();
    });
});
