import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockReddit,
    mockStore,
    mockContext,
    mockPostFlair,
} = vi.hoisted(() => ({
    mockReddit: { submitCustomPost: vi.fn() },
    mockStore: {
        acquireLauncherPostCreationLock: vi.fn(),
        readLauncherPostRecord: vi.fn(),
        releaseLauncherPostCreationLock: vi.fn(),
        writeLauncherPostRecord: vi.fn(),
    },
    mockContext: { getRequestAppSlug: vi.fn() },
    mockPostFlair: { resolveMiniRacerPostFlairId: vi.fn() },
}));

vi.mock('@devvit/web/server', () => ({ reddit: mockReddit }));
vi.mock('../src/server/launcher-post-store.js', () => mockStore);
vi.mock('../src/server/request-context.js', () => mockContext);
vi.mock('../src/server/post-flair-service.js', () => mockPostFlair);

const {
    ensureMiniRacerLauncherPostForSubreddit,
} = await import('../src/server/launcher-post-service.ts');

describe('launcher post service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockContext.getRequestAppSlug.mockReturnValue('mini-racer');
        mockPostFlair.resolveMiniRacerPostFlairId.mockImplementation(
            async (_subredditName, postType) => `flair-${postType}`,
        );
        mockStore.readLauncherPostRecord.mockResolvedValue(null);
        mockStore.acquireLauncherPostCreationLock.mockResolvedValue({ key: 'lock', value: 'value' });
        mockStore.releaseLauncherPostCreationLock.mockResolvedValue(undefined);
        mockStore.writeLauncherPostRecord.mockResolvedValue(undefined);
    });

    it.each([
        ['daily', 'daily', 'daily-launcher', 'daily'],
        ['campaign', 'campaign', 'campaign-launcher', 'campaign'],
        ['lobby', 'game', 'lobby-launcher', 'home'],
    ])('creates the %s launcher with its fixed entry and target', async (
        kind,
        entry,
        postType,
        launchMode,
    ) => {
        mockReddit.submitCustomPost.mockResolvedValue({
            id: `t3_${kind}`,
            url: `https://reddit.com/${kind}`,
        });

        await expect(
            ensureMiniRacerLauncherPostForSubreddit('MiniRacer', kind),
        ).resolves.toEqual({
            created: true,
            postUrl: `https://reddit.com/${kind}`,
        });

        expect(mockReddit.submitCustomPost).toHaveBeenCalledWith(expect.objectContaining({
            subredditName: 'MiniRacer',
            flairId: `flair-${postType}`,
            entry,
            postData: { postType, launchMode },
        }));
        expect(mockStore.writeLauncherPostRecord).toHaveBeenCalledWith(expect.objectContaining({
            subredditName: 'MiniRacer',
            kind,
            postId: `t3_${kind}`,
            postUrl: `https://reddit.com/${kind}`,
        }));
        expect(mockStore.releaseLauncherPostCreationLock).toHaveBeenCalledWith({
            key: 'lock',
            value: 'value',
        });
    });

    it('reuses the canonical launcher without submitting a duplicate', async () => {
        mockStore.readLauncherPostRecord.mockResolvedValue({
            postUrl: 'https://reddit.com/existing',
        });

        await expect(
            ensureMiniRacerLauncherPostForSubreddit('MiniRacer', 'campaign'),
        ).resolves.toEqual({
            created: false,
            postUrl: 'https://reddit.com/existing',
        });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
        expect(mockStore.acquireLauncherPostCreationLock).not.toHaveBeenCalled();
    });

    it('requires the app identity before creating a launcher', async () => {
        mockContext.getRequestAppSlug.mockReturnValue(null);

        await expect(
            ensureMiniRacerLauncherPostForSubreddit('MiniRacer', 'lobby'),
        ).rejects.toThrow('did not provide the Mini Racer app identity');
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });
});
