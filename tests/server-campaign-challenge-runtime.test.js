import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACKS } from '../game/track/tracks.js';
import { createTrackFingerprint } from '../src/server/pb-ghost-trace.ts';

const mockDailyChallenge = vi.hoisted(() => vi.fn());
const mockValidateReplay = vi.hoisted(() => vi.fn());

vi.mock('../src/server/campaign-store.js', () => ({
    getServerCampaignChallengeSource: vi.fn(),
}));
vi.mock('../src/server/daily-gp-store.js', () => ({
    getServerDailyGpPlayableChallenge: mockDailyChallenge,
}));
vi.mock('../src/server/campaign-challenge-post.js', () => ({
    resolveCampaignChallengeRecord: vi.fn(),
}));
vi.mock('../src/server/campaign-challenge-store.js', () => ({
    readCampaignChallengeResult: vi.fn(),
}));
vi.mock('../src/server/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: mockValidateReplay,
}));

const {
    resolveCampaignChallengeSource,
    validateCampaignChallengeReplay,
} = await import('../src/server/campaign-challenge-runtime.ts');

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

describe('campaign challenge runtime', () => {
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
        const source = await resolveCampaignChallengeSource({
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
            postType: 'campaign-challenge',
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

        const result = validateCampaignChallengeReplay(challenge, {
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
