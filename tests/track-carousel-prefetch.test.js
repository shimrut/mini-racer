import { describe, expect, it, vi } from 'vitest';

const loaded = new Set(['alreadyLoaded']);
const loadClientTrack = vi.fn(() => Promise.resolve(null));

vi.mock('../game/track/client-registry.js', () => ({
    getLoadedClientTrack: (trackKey) => (loaded.has(trackKey) ? { outer: [] } : null),
    loadClientTrack: (trackKey) => loadClientTrack(trackKey),
}));

const { TrackCarousel } = await import('../game/ui/track-carousel.js');

describe('track carousel geometry warm-up', () => {
    it('warms every card so a swipe never lands on a blank preview', () => {
        loadClientTrack.mockClear();
        const carousel = new TrackCarousel();

        carousel.render([
            { challengeId: 'a', trackKey: 'albertGardens' },
            { challengeId: 'b', trackKey: 'alloyRing' },
            { challengeId: 'c', trackKey: 'alreadyLoaded' },
            { challengeId: 'd' },
        ]);

        expect(loadClientTrack.mock.calls.map(([key]) => key))
            .toEqual(['albertGardens', 'alloyRing']);
    });

    it('does not let a failed warm-up reject', async () => {
        loadClientTrack.mockClear();
        loadClientTrack.mockImplementationOnce(() => Promise.reject(new Error('offline')));
        const carousel = new TrackCarousel();

        expect(() => carousel.render([{ challengeId: 'a', trackKey: 'albertGardens' }])).not.toThrow();
        await Promise.resolve();
    });
});
