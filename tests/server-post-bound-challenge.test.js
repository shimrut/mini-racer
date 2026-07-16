import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReddit, mockContext, mockStore } = vi.hoisted(() => ({
    mockReddit: {
        getPostById: vi.fn(),
    },
    mockContext: {
        readContextPostData: vi.fn(),
        readContextPostId: vi.fn(),
    },
    mockStore: {
        getServerDailyGpChallengeById: vi.fn(),
        persistServerDailyGpChallenge: vi.fn(),
    },
}));

vi.mock('@devvit/web/server', () => ({ reddit: mockReddit }));
vi.mock('../src/server/request-context.js', () => mockContext);
vi.mock('../src/server/daily-gp-store.js', () => mockStore);

const {
    getPostBoundDailyGpChallenge,
    normalizePostBoundDailyGpChallenge,
} = await import('../src/server/post-bound-challenge.ts');

const challenge = {
    id: 'daily-gp-2026-07-16',
    challengeDate: '2026-07-16',
    trackKey: 'circuit',
    startsAt: '2026-07-16T00:00:00.000Z',
    endsAt: '2026-07-17T00:00:00.000Z',
    availableUntil: '2026-07-23T00:00:00.000Z',
    status: 'active',
    objectiveType: 'single_lap_fastest',
    objectiveParams: {},
    skin: 'default',
};

describe('post-bound daily challenge resolution', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockContext.readContextPostData.mockReturnValue(null);
        mockContext.readContextPostId.mockReturnValue(null);
        mockStore.persistServerDailyGpChallenge.mockImplementation(async (value) => value);
        mockStore.getServerDailyGpChallengeById.mockResolvedValue(null);
    });

    it('normalizes only complete challenges with known tracks', () => {
        expect(normalizePostBoundDailyGpChallenge(challenge)).toEqual(challenge);
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            trackKey: 'missing-track',
        })).toBeNull();
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            id: 'not-a-daily-id',
        })).toBeNull();
    });

    it('prefers a complete challenge embedded in request context', async () => {
        mockContext.readContextPostData.mockReturnValue({ challenge });

        await expect(getPostBoundDailyGpChallenge()).resolves.toEqual(challenge);
        expect(mockStore.persistServerDailyGpChallenge).toHaveBeenCalledWith(challenge);
        expect(mockReddit.getPostById).not.toHaveBeenCalled();
    });

    it('resolves a context challenge ID without reading Reddit', async () => {
        mockContext.readContextPostData.mockReturnValue({ challengeId: challenge.id });
        mockStore.getServerDailyGpChallengeById.mockResolvedValue(challenge);

        await expect(getPostBoundDailyGpChallenge()).resolves.toEqual(challenge);
        expect(mockStore.getServerDailyGpChallengeById).toHaveBeenCalledWith(challenge.id);
        expect(mockReddit.getPostById).not.toHaveBeenCalled();
    });

    it('falls back to Reddit post data and persists an embedded challenge', async () => {
        mockContext.readContextPostId.mockReturnValue('t3_daily');
        mockReddit.getPostById.mockResolvedValue({
            getPostData: vi.fn(async () => ({ challenge })),
        });

        await expect(getPostBoundDailyGpChallenge()).resolves.toEqual(challenge);
        expect(mockReddit.getPostById).toHaveBeenCalledWith('t3_daily');
        expect(mockStore.persistServerDailyGpChallenge).toHaveBeenCalledWith(challenge);
    });

    it('returns null when Reddit lookup fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mockContext.readContextPostId.mockReturnValue('t3_daily');
        mockReddit.getPostById.mockRejectedValue(new Error('unavailable'));

        await expect(getPostBoundDailyGpChallenge()).resolves.toBeNull();
    });
});
