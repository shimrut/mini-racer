import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getHeadToHead,
    submitHeadToHeadRun,
} from '../game/head-to-head/service.js';

describe('head to head client service', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.useRealTimers();
    });

    it('binds Head to Head reads and submissions to the current Reddit post', async () => {
        const originalLocation = globalThis.location;
        const originalDevvit = globalThis.devvit;
        globalThis.location = { origin: 'https://miniracer.example' };
        globalThis.devvit = { context: { postId: 't3_challenge1' } };
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ status: 'ready' }),
        }));

        try {
            await getHeadToHead('challenge-1');
            const getUrl = new URL(globalThis.fetch.mock.calls[0][0]);
            expect(getUrl.searchParams.get('postId')).toBe('t3_challenge1');

            await submitHeadToHeadRun({
                challengeId: 'challenge-1',
                replay: { inputs: [] },
            });
            const submitBody = JSON.parse(globalThis.fetch.mock.calls[1][1].body);
            expect(submitBody.postId).toBe('t3_challenge1');
        } finally {
            globalThis.location = originalLocation;
            globalThis.devvit = originalDevvit;
        }
    });

    it('aborts a challenge read after the shared request timeout', async () => {
        vi.useFakeTimers();
        let aborted = false;
        globalThis.fetch = vi.fn(async (_url, options) => new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => {
                aborted = true;
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
        }));

        const request = getHeadToHead('challenge-1');
        const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(20_000);

        await rejection;
        expect(aborted).toBe(true);
    });
});
