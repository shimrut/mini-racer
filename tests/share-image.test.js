import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDevvitConfig } = vi.hoisted(() => ({
    mockGetDevvitConfig: vi.fn(),
}));

vi.mock('@devvit/shared-types/server/get-devvit-config.js', () => ({
    getDevvitConfig: mockGetDevvitConfig,
}));

const {
    getShareImageAssetPath,
    resolveDailyShareImageUrl,
} = await import('../src/server/posts/share-image.ts');

describe('share-image', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('builds the assets-relative share path', () => {
        expect(getShareImageAssetPath('kettleRun')).toBe('share/kettleRun.jpg');
    });

    it('returns https asset URLs from the Devvit asset map', () => {
        mockGetDevvitConfig.mockReturnValue({
            assets: {
                'share/circuit.jpg': 'https://i.redd.it/circuit-share.jpg',
            },
        });
        expect(resolveDailyShareImageUrl('circuit')).toBe('https://i.redd.it/circuit-share.jpg');
    });

    it('prefixes bare media ids as i.redd.it URLs', () => {
        mockGetDevvitConfig.mockReturnValue({
            assets: {
                'share/circuit.jpg': 'abc123.jpg',
            },
        });
        expect(resolveDailyShareImageUrl('circuit')).toBe('https://i.redd.it/abc123.jpg');
    });

    it('returns null when the asset or config is missing', () => {
        mockGetDevvitConfig.mockReturnValue({ assets: {} });
        expect(resolveDailyShareImageUrl('circuit')).toBeNull();

        mockGetDevvitConfig.mockImplementation(() => {
            throw new Error('not initialized');
        });
        expect(resolveDailyShareImageUrl('circuit')).toBeNull();
        expect(resolveDailyShareImageUrl('')).toBeNull();
    });
});
