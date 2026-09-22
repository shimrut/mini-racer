import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    concedesHeadToHead,
    getHeadToHead,
    previewHeadToHeadComment,
    confirmHeadToHeadComment,
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
                bestTimeMs: 7_500,
            });
            const submitBody = JSON.parse(globalThis.fetch.mock.calls[1][1].body);
            expect(submitBody.postId).toBe('t3_challenge1');
            expect(submitBody.bestTimeMs).toBe(7_500);
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

    it('sends a text-only challenge comment preview and confirmation', async () => {
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
            await previewHeadToHeadComment({
                challengeId: 'challenge-1',
                reportedTimeMs: 10_011,
                outcome: 'lost',
            });
            const previewBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
            expect(previewBody).toMatchObject({
                challengeId: 'challenge-1',
                reportedTimeMs: 10_011,
                postId: 't3_challenge1',
            });
            expect(previewBody).not.toHaveProperty('outcome');

            await confirmHeadToHeadComment('share-1');
            expect(JSON.parse(globalThis.fetch.mock.calls[1][1].body)).toEqual({
                shareToken: 'share-1',
            });
        } finally {
            globalThis.location = originalLocation;
            globalThis.devvit = originalDevvit;
        }
    });
});

describe('concedesHeadToHead', () => {
    const lost = { kind: 'challenge-comment', outcome: 'lost' };

    it.each([
        'commented',
        'already_commented',
        'posted_without_link',
        'user_action_unavailable',
        'comment_unconfirmed',
    ])('ends the concession on %s', (status) => {
        expect(concedesHeadToHead(lost, { status })).toBe(true);
    });

    it.each([
        ['a preview that has not posted yet', lost, { status: 'ready' }],
        ['a failure', lost, { status: 'challenge_failed' }],
        ['no answer at all', lost, undefined],
        ['a tie', { kind: 'challenge-comment', outcome: 'tie' }, { status: 'commented' }],
        ['a brag', { kind: 'challenge-brag' }, { status: 'shared' }],
        ['a finish with no verdict', { kind: 'challenge-comment' }, { status: 'commented' }],
    ])('leaves the count alone for %s', (_case, request, body) => {
        expect(concedesHeadToHead(request, body)).toBe(false);
    });
});
