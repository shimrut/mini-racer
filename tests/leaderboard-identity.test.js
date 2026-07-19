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

    it('strips only a leading u/ prefix from reddit usernames', () => {
        expect(sanitizeRedditUsername('U/CapsUser')).toBe('CapsUser');
        expect(sanitizeRedditUsername('midu/name')).toBe('midu/name');
        expect(sanitizeRedditUsername('   ')).toBeNull();
    });

    it('uses the FNV-style hash formula for constructed adjective and noun picks', () => {
        // Deterministic fixture: hash of "a" with the exported algorithm.
        let hash = 0x811c9dc5;
        hash ^= 'a'.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193);
        hash = hash >>> 0;
        const adjectives = [
            'Arctic', 'Blazing', 'Crimson', 'Electric', 'Flying', 'Golden', 'Hidden', 'Iron',
            'Jade', 'Lucky', 'Midnight', 'Neon', 'Phantom', 'Quantum', 'Rapid', 'Rocket',
            'Shadow', 'Silver', 'Turbo', 'Velvet', 'Wild', 'Winter', 'Zenith', 'Zero',
        ];
        const nouns = [
            'Badger', 'Cobra', 'Falcon', 'Gecko', 'Jaguar', 'Koala', 'Lynx', 'Manta',
            'Mustang', 'Orca', 'Otter', 'Panther', 'Pigeon', 'Raven', 'Shark', 'Sparrow',
            'Tiger', 'Viper', 'Wolf', 'Wombat', 'Yak', 'Zebra', 'Comet', 'Meteor',
        ];
        const adjective = adjectives[hash % adjectives.length];
        const noun = nouns[Math.floor(hash / adjectives.length) % nouns.length];
        const suffixSeed = hash >>> 16;
        const suffix = suffixSeed % 4 === 0 ? '' : ` ${2 + (suffixSeed % 98)}`;
        expect(getConstructedLeaderboardName('a')).toBe(`${adjective} ${noun}${suffix}`);
    });

    it('rejects empty string player ids before hashing', () => {
        expect(getConstructedLeaderboardName('')).toBe('Anonymous Racer');
        expect(getConstructedLeaderboardName(undefined)).toBe('Anonymous Racer');
        expect(getConstructedLeaderboardName(0)).toBe('Anonymous Racer');
    });

    it('keeps constructed names when reddit preference lacks a usable username', () => {
        expect(resolveLeaderboardDisplayName({
            playerId: 'player-1',
            preference: LEADERBOARD_IDENTITY_REDDIT,
            redditUsername: '   ',
        })).toBe(getConstructedLeaderboardName('player-1'));
    });
});
