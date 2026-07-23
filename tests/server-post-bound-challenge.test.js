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
    rulesRevision: 0,
    objectiveType: 'single_lap_fastest',
    objectiveParams: { lapCount: 1 },
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

    it('upgrades missing race fields on old post payloads to the legacy one-lap contract', () => {
        const legacy = { ...challenge };
        delete legacy.rulesRevision;
        delete legacy.objectiveParams;

        expect(normalizePostBoundDailyGpChallenge(legacy)).toMatchObject({
            rulesRevision: 0,
            objectiveType: 'single_lap_fastest',
            objectiveParams: { lapCount: 1 },
        });
    });

    it('keeps revision-one multi-lap post payloads only when their contract agrees', () => {
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            rulesRevision: 1,
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 2 },
        })).toMatchObject({
            rulesRevision: 1,
            objectiveParams: { lapCount: 2 },
        });
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            rulesRevision: 1,
            objectiveType: 'single_lap_fastest',
            objectiveParams: { lapCount: 2 },
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

    it('rejects non-object payloads and incomplete string fields during normalization', () => {
        expect(normalizePostBoundDailyGpChallenge(null)).toBeNull();
        expect(normalizePostBoundDailyGpChallenge(undefined)).toBeNull();
        expect(normalizePostBoundDailyGpChallenge('daily-gp-2026-07-16')).toBeNull();
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            id: 42,
        })).toBeNull();
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            challengeDate: 20260716,
        })).toBeNull();
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            trackKey: 7,
        })).toBeNull();
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            startsAt: 0,
        })).toBeNull();
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            endsAt: false,
        })).toBeNull();
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            availableUntil: null,
        })).toBeNull();
    });

    it('returns null when request context has no post id to resolve', async () => {
        mockContext.readContextPostData.mockReturnValue({});
        mockContext.readContextPostId.mockReturnValue(null);

        await expect(getPostBoundDailyGpChallenge()).resolves.toBeNull();
        expect(mockStore.getServerDailyGpChallengeById).not.toHaveBeenCalled();
    });

    it('loads a challenge id from Reddit post data when the embedded challenge is incomplete', async () => {
        mockContext.readContextPostId.mockReturnValue('t3_daily');
        mockReddit.getPostById.mockResolvedValue({
            getPostData: vi.fn(async () => ({
                challenge: { id: challenge.id, trackKey: 'missing-track' },
                challengeId: challenge.id,
            })),
        });
        mockStore.getServerDailyGpChallengeById.mockResolvedValue(challenge);

        await expect(getPostBoundDailyGpChallenge()).resolves.toEqual(challenge);
        expect(mockStore.getServerDailyGpChallengeById).toHaveBeenCalledWith(challenge.id);
        expect(mockStore.persistServerDailyGpChallenge).not.toHaveBeenCalled();
    });

    it('ignores a whitespace-only challenge id embedded in Reddit post data', async () => {
        mockContext.readContextPostId.mockReturnValue('t3_daily');
        mockReddit.getPostById.mockResolvedValue({
            getPostData: vi.fn(async () => ({
                challengeId: '   ',
            })),
        });
        mockStore.getServerDailyGpChallengeById.mockResolvedValue(null);

        await expect(getPostBoundDailyGpChallenge()).resolves.toBeNull();
        expect(mockStore.getServerDailyGpChallengeById).toHaveBeenCalledWith('   ');
    });

    it('rejects challenge ids that are not fully anchored to daily-gp-YYYY-MM-DD', () => {
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            id: 'xdaily-gp-2026-07-16',
        })).toBeNull();
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            id: 'daily-gp-2026-07-16x',
        })).toBeNull();
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            id: '',
        })).toBeNull();
        expect(normalizePostBoundDailyGpChallenge(null)).toBeNull();
        expect(normalizePostBoundDailyGpChallenge('daily-gp-2026-07-16')).toBeNull();
    });

    it('rejects incomplete schedule strings even when the id looks valid', () => {
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            startsAt: '',
        })).toBeNull();
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            endsAt: 12,
        })).toBeNull();
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            availableUntil: null,
        })).toBeNull();
        expect(normalizePostBoundDailyGpChallenge({
            ...challenge,
            challengeDate: '',
        })).toBeNull();
    });

    it('ignores a non-string challengeId from context and continues to Reddit', async () => {
        mockContext.readContextPostData.mockReturnValue({ challengeId: 12 });
        mockContext.readContextPostId.mockReturnValue('t3_daily');
        mockReddit.getPostById.mockResolvedValue({
            getPostData: vi.fn(async () => ({ challenge })),
        });

        await expect(getPostBoundDailyGpChallenge()).resolves.toEqual(challenge);
        expect(mockStore.getServerDailyGpChallengeById).not.toHaveBeenCalled();
        expect(mockStore.persistServerDailyGpChallenge).toHaveBeenCalledWith(challenge);
    });

    it('resolves a string challengeId from Reddit post data without persisting', async () => {
        mockContext.readContextPostId.mockReturnValue('t3_daily');
        mockReddit.getPostById.mockResolvedValue({
            getPostData: vi.fn(async () => ({ challengeId: challenge.id })),
        });
        mockStore.getServerDailyGpChallengeById.mockResolvedValue(challenge);

        await expect(getPostBoundDailyGpChallenge()).resolves.toEqual(challenge);
        expect(mockStore.getServerDailyGpChallengeById).toHaveBeenCalledWith(challenge.id);
        expect(mockStore.persistServerDailyGpChallenge).not.toHaveBeenCalled();
    });

    it('ignores empty-string challengeId from context and continues to Reddit', async () => {
        mockContext.readContextPostData.mockReturnValue({ challengeId: '' });
        mockContext.readContextPostId.mockReturnValue('t3_daily');
        mockReddit.getPostById.mockResolvedValue({
            getPostData: vi.fn(async () => ({ challenge })),
        });

        await expect(getPostBoundDailyGpChallenge()).resolves.toEqual(challenge);
        expect(mockStore.getServerDailyGpChallengeById).not.toHaveBeenCalled();
        expect(mockStore.persistServerDailyGpChallenge).toHaveBeenCalledWith(challenge);
    });

    it('returns null when Reddit post data has neither challenge nor challengeId', async () => {
        mockContext.readContextPostId.mockReturnValue('t3_daily');
        mockReddit.getPostById.mockResolvedValue({
            getPostData: vi.fn(async () => ({})),
        });

        await expect(getPostBoundDailyGpChallenge()).resolves.toBeNull();
        expect(mockStore.getServerDailyGpChallengeById).not.toHaveBeenCalled();
    });

    it('ignores non-string challengeId on Reddit post data', async () => {
        mockContext.readContextPostId.mockReturnValue('t3_daily');
        mockReddit.getPostById.mockResolvedValue({
            getPostData: vi.fn(async () => ({ challengeId: 99 })),
        });

        await expect(getPostBoundDailyGpChallenge()).resolves.toBeNull();
        expect(mockStore.getServerDailyGpChallengeById).not.toHaveBeenCalled();
    });

    it('rejects missing individual schedule fields one at a time', () => {
        for (const key of ['challengeDate', 'trackKey', 'startsAt', 'endsAt', 'availableUntil']) {
            expect(normalizePostBoundDailyGpChallenge({
                ...challenge,
                [key]: undefined,
            })).toBeNull();
        }
    });

    it('logs and returns null when getPostData throws after post lookup', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockContext.readContextPostId.mockReturnValue('t3_daily');
        mockReddit.getPostById.mockResolvedValue({
            getPostData: vi.fn(async () => {
                throw new Error('post-data-unavailable');
            }),
        });

        await expect(getPostBoundDailyGpChallenge()).resolves.toBeNull();
        expect(errorSpy).toHaveBeenCalledWith(
            'Failed to resolve post-bound Mini Racer challenge:',
            expect.any(Error),
        );
        errorSpy.mockRestore();
    });
});
