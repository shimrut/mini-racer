import { describe, expect, it } from 'vitest';
import {
    LEADERBOARD_IDENTITY_CONSTRUCTED,
    LEADERBOARD_IDENTITY_REDDIT,
    getConstructedLeaderboardName,
    normalizeLeaderboardIdentityPreference,
    resolveLeaderboardDisplayName,
    sanitizeRedditUsername,
} from '../game/shared/leaderboard-identity.js';

describe('leaderboard identity', () => {
    it('normalizes unknown preferences to constructed aliases', () => {
        expect(normalizeLeaderboardIdentityPreference('reddit')).toBe(LEADERBOARD_IDENTITY_REDDIT);
        expect(normalizeLeaderboardIdentityPreference('constructed')).toBe(LEADERBOARD_IDENTITY_CONSTRUCTED);
        expect(normalizeLeaderboardIdentityPreference('anything-else')).toBe(LEADERBOARD_IDENTITY_CONSTRUCTED);
    });

    it('sanitizes reddit usernames and removes any u/ prefix', () => {
        expect(sanitizeRedditUsername('u/test_driver')).toBe('test_driver');
        expect(sanitizeRedditUsername('  pace-setter  ')).toBe('pace-setter');
        expect(sanitizeRedditUsername('')).toBe(null);
    });

    it('returns reddit usernames only when that preference is selected and available', () => {
        expect(resolveLeaderboardDisplayName({
            playerId: 'player-1',
            preference: LEADERBOARD_IDENTITY_REDDIT,
            redditUsername: 'u/track_fan',
        })).toBe('track_fan');

        expect(resolveLeaderboardDisplayName({
            playerId: 'player-1',
            preference: LEADERBOARD_IDENTITY_REDDIT,
            redditUsername: null,
        })).toBe(getConstructedLeaderboardName('player-1'));
    });

    it('falls back to anonymous constructed names for missing player ids', () => {
        expect(getConstructedLeaderboardName('')).toBe('Anonymous Racer');
        expect(getConstructedLeaderboardName(null)).toBe('Anonymous Racer');
        expect(sanitizeRedditUsername(42)).toBeNull();
    });

    it('builds stable constructed aliases for the same player id', () => {
        const first = getConstructedLeaderboardName('player-stable');
        const second = getConstructedLeaderboardName('player-stable');
        expect(first).toBe(second);
        expect(first).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+( \d+)?$/);
    });
});
