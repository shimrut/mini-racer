import { describe, it, expect, afterEach, vi } from 'vitest';
import { getActiveDailyChallenge } from '../game/daily-challenge/service.js';

// Fresh module graph for start-override storage reads.

function createJsonResponse(body) {
    return { ok: true, status: 200, json: async () => body };
}

function createMemoryLocalStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => { data.set(k, v); },
        removeItem: (k) => { data.delete(k); },
    };
}

describe('daily-challenge start override boundaries', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.window;
        delete globalThis.fetch;
        delete globalThis.devvit;
    });

    it('keeps a non-featured override at the exact expiry timestamp but removes one millisecond past it', async () => {
        const now = Date.parse('2026-07-18T12:00:00.000Z');
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const storage = createMemoryLocalStorage({
            VectorGpDailyStartOverride: JSON.stringify({
                mode: 'other',
                expiresAt: now,
            }),
        });
        globalThis.window = {
            localStorage: storage,
            location: {
                hostname: 'example.devvit.net',
                pathname: '/index.html',
                protocol: 'https:',
                search: '',
            },
        };
        globalThis.fetch = vi.fn().mockResolvedValue(createJsonResponse({
            id: 'override-boundary',
            trackKey: 'circuit',
            startsAt: '2026-07-18T00:00:00.000Z',
            endsAt: '2026-07-19T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        }));

        await getActiveDailyChallenge();
        expect(JSON.parse(storage.getItem('VectorGpDailyStartOverride')).expiresAt).toBe(now);

        storage.setItem('VectorGpDailyStartOverride', JSON.stringify({
            mode: 'other',
            expiresAt: now - 1,
        }));

        await getActiveDailyChallenge();
        expect(storage.getItem('VectorGpDailyStartOverride')).toBeNull();
    });
});
