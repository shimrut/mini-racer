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

    it.each([
        ['daily-launcher', 'daily'],
        ['campaign-launcher', 'campaign'],
        ['lobby-launcher', 'home'],
    ])('uses the %s post target even when a stale stored target exists', (postType, mode) => {
        const root = createRoot({ postData: { postType, launchMode: mode } });
        requestGameLaunchTarget('daily', { root });
        expect(resolveGameLaunchTarget(root)).toEqual({ mode, challengeId: null });
        expect(root.localStorage.getItem(LAUNCH_TARGET_KEY)).toBeNull();
    });

    it('does not let a consumed Campaign launcher target hijack the next challenge post', () => {
        const root = createRoot({ postData: { postType: 'campaign-launcher' } });
        requestGameLaunchTarget('campaign', { root });

        expect(resolveGameLaunchTarget(root))
            .toEqual({ mode: 'campaign', challengeId: null });
        expect(root.localStorage.getItem(LAUNCH_TARGET_KEY)).toBeNull();

        root.devvit.context.postData = {
            postType: 'head-to-head',
            challengeId: 'challenge-1',
        };
        expect(resolveGameLaunchTarget(root))
            .toEqual({ mode: 'challenge', challengeId: 'challenge-1' });
    });

    it('accepts a generic mode launcher post target', () => {
        expect(resolveGameLaunchTarget(createRoot({
            postData: { postType: 'mode-launcher', launchMode: 'campaign' },
        }))).toEqual({ mode: 'campaign', challengeId: null });
    });

    it('gives immutable challenge post data precedence over a stale stored target', () => {
        const root = createRoot({
            postData: { postType: 'head-to-head', challengeId: 'challenge-1' },
        });
        requestGameLaunchTarget('daily', { root });
        expect(resolveGameLaunchTarget(root))
            .toEqual({ mode: 'challenge', challengeId: 'challenge-1' });
    });

    it('lets an explicit stored campaign or home target override a challenge post', () => {
        const rootCampaign = createRoot({
            postData: { postType: 'head-to-head', challengeId: 'challenge-1' },
        });
        requestGameLaunchTarget('campaign', { root: rootCampaign });
        expect(resolveGameLaunchTarget(rootCampaign))
            .toEqual({ mode: 'campaign', challengeId: null });
        expect(rootCampaign.localStorage.getItem(LAUNCH_TARGET_KEY)).toBeNull();

        const rootHome = createRoot({
            postData: { postType: 'head-to-head', challengeId: 'challenge-1' },
        });
        requestGameLaunchTarget('home', { root: rootHome });
        expect(resolveGameLaunchTarget(rootHome))
            .toEqual({ mode: 'home', challengeId: null });
        expect(rootHome.localStorage.getItem(LAUNCH_TARGET_KEY)).toBeNull();
    });

    it('consumes a valid one-use launch target', () => {
        const root = createRoot();
        expect(requestGameLaunchTarget('daily', { root })).toBe(true);
        expect(resolveGameLaunchTarget(root)).toEqual({ mode: 'daily', challengeId: null });
        expect(root.localStorage.getItem(LAUNCH_TARGET_KEY)).toBeNull();
        expect(resolveGameLaunchTarget(root)).toEqual({ mode: 'home', challengeId: null });
    });
});
