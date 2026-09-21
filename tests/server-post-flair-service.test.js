import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReddit } = vi.hoisted(() => ({
    mockReddit: {
        getPostFlairTemplates: vi.fn(),
    },
}));

vi.mock('@devvit/web/server', () => ({ reddit: mockReddit }));

const { resolveMiniRacerPostFlairId } = await import('../src/server/post-flair-service.ts');

describe('Mini Racer post flair service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockReddit.getPostFlairTemplates.mockResolvedValue([
            { id: 'daily-template', text: 'Daily' },
            { id: 'challenge-template', text: 'Challenge' },
            { id: 'podium-template', text: 'Podiums' },
        ]);
    });

    it.each([
        ['daily-race', 'daily-template'],
        ['head-to-head', 'challenge-template'],
        ['daily-podium', 'podium-template'],
    ])('maps %s to the configured Reddit flair template', async (postType, flairId) => {
        await expect(
            resolveMiniRacerPostFlairId('MiniRacer', postType),
        ).resolves.toBe(flairId);
        expect(mockReddit.getPostFlairTemplates).toHaveBeenCalledWith('MiniRacer');
    });

    it('matches template text without depending on capitalization or surrounding spaces', async () => {
        mockReddit.getPostFlairTemplates.mockResolvedValue([
            { id: 'challenge-template', text: '  challenge ' },
        ]);

        await expect(
            resolveMiniRacerPostFlairId('MiniRacer', 'head-to-head'),
        ).resolves.toBe('challenge-template');
    });

    it('fails before post creation when the required template is missing', async () => {
        mockReddit.getPostFlairTemplates.mockResolvedValue([
            { id: 'daily-template', text: 'Daily' },
        ]);

        await expect(
            resolveMiniRacerPostFlairId('MiniRacer', 'daily-podium'),
        ).rejects.toThrow(
            'Mini Racer requires the "Podiums" post flair template in r/MiniRacer',
        );
    });
});
