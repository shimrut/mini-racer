import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    LAUNCH_TARGET_KEY,
    requestGameLaunchTarget,
    resolveGameLaunchTarget,
} from '../game/modes/launch-target.js';

function createRoot({ search = '', postData = null } = {}) {
    const values = new Map();
    return {
        location: { search },
        localStorage: {
            getItem: (key) => values.get(key) ?? null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: (key) => values.delete(key),
        },
        devvit: postData ? { context: { postData } } : undefined,
    };
}

describe('game launch target', () => {
    beforeEach(() => vi.useRealTimers());

    it('defaults standalone games to Home and supports explicit mode URLs', () => {
        expect(resolveGameLaunchTarget(createRoot())).toEqual({ mode: 'home', challengeId: null });
        expect(resolveGameLaunchTarget(createRoot({ search: '?mode=campaign' })))
            .toEqual({ mode: 'campaign', challengeId: null });
    });

    it('opens Daily post data directly in Daily mode', () => {
        expect(resolveGameLaunchTarget(createRoot({ postData: { challengeId: 'daily-1' } })))
            .toEqual({ mode: 'daily', challengeId: null });
    });

    it('gives immutable challenge post data precedence over a stale stored target', () => {
        const root = createRoot({
            postData: { postType: 'campaign-challenge', challengeId: 'challenge-1' },
        });
        requestGameLaunchTarget('daily', { root });
        expect(resolveGameLaunchTarget(root))
            .toEqual({ mode: 'challenge', challengeId: 'challenge-1' });
    });

    it('lets an explicit stored campaign target override a challenge post', () => {
        const root = createRoot({
            postData: { postType: 'campaign-challenge', challengeId: 'challenge-1' },
        });
        requestGameLaunchTarget('campaign', { root });
        expect(resolveGameLaunchTarget(root))
            .toEqual({ mode: 'campaign', challengeId: null });
        expect(root.localStorage.getItem(LAUNCH_TARGET_KEY)).toBeNull();
    });

    it('consumes a valid one-use launch target', () => {
        const root = createRoot();
        expect(requestGameLaunchTarget('daily', { root })).toBe(true);
        expect(resolveGameLaunchTarget(root)).toEqual({ mode: 'daily', challengeId: null });
        expect(root.localStorage.getItem(LAUNCH_TARGET_KEY)).toBeNull();
        expect(resolveGameLaunchTarget(root)).toEqual({ mode: 'home', challengeId: null });
    });
});
