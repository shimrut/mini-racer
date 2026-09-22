import { describe, expect, it } from 'vitest';
import {
    LEADERBOARD_IDENTITY_CONSTRUCTED,
    LEADERBOARD_IDENTITY_REDDIT,
    LEADERBOARD_NAME_ADJECTIVES,
    LEADERBOARD_NAME_NOUNS,
    getConstructedLeaderboardName,
    hashLeaderboardPlayerId,
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
        expect(first).toBe('Arctic Mustang 33');
    });

    it('strips only a leading u/ prefix from reddit usernames', () => {
        expect(sanitizeRedditUsername('U/CapsUser')).toBe('CapsUser');
        expect(sanitizeRedditUsername('midu/name')).toBe('midu/name');
        expect(sanitizeRedditUsername('   ')).toBeNull();
    });

    it('keeps the adjective and noun catalogs intact for constructed names', () => {
        expect(LEADERBOARD_NAME_ADJECTIVES).toEqual([
            'Arctic', 'Blazing', 'Crimson', 'Electric', 'Flying', 'Golden', 'Hidden', 'Iron',
            'Jade', 'Lucky', 'Midnight', 'Neon', 'Phantom', 'Quantum', 'Rapid', 'Rocket',
            'Shadow', 'Silver', 'Turbo', 'Velvet', 'Wild', 'Winter', 'Zenith', 'Zero',
        ]);
        expect(LEADERBOARD_NAME_NOUNS).toEqual([
            'Badger', 'Cobra', 'Falcon', 'Gecko', 'Jaguar', 'Koala', 'Lynx', 'Manta',
            'Mustang', 'Orca', 'Otter', 'Panther', 'Pigeon', 'Raven', 'Shark', 'Sparrow',
            'Tiger', 'Viper', 'Wolf', 'Wombat', 'Yak', 'Zebra', 'Comet', 'Meteor',
        ]);
    });

    it('hashes player ids with FNV-1a and builds the exact constructed label', () => {
        expect(hashLeaderboardPlayerId('')).toBe(0x811c9dc5 >>> 0);
        expect(hashLeaderboardPlayerId('a')).toBe(
            (Math.imul(0x811c9dc5 ^ 'a'.charCodeAt(0), 0x01000193) >>> 0),
        );
        expect(hashLeaderboardPlayerId('ab')).toBe(
            (Math.imul(
                (Math.imul(0x811c9dc5 ^ 'a'.charCodeAt(0), 0x01000193) >>> 0) ^ 'b'.charCodeAt(0),
                0x01000193,
            ) >>> 0),
        );
        expect(hashLeaderboardPlayerId('a')).toBe(3826002220);
        expect(hashLeaderboardPlayerId('player-stable')).toBe(2558244288);

        expect(getConstructedLeaderboardName('a')).toBe('Flying Meteor');
        expect(getConstructedLeaderboardName('x')).toBe('Rocket Koala');
        expect(getConstructedLeaderboardName('player-stable')).toBe('Arctic Mustang 33');
        expect(getConstructedLeaderboardName('player-1')).toBe('Turbo Mustang 54');
    });

    it('uses a numeric suffix unless the high hash bits are divisible by four', () => {
        const samples = [];
        for (let i = 0; i < 200; i += 1) {
            samples.push(getConstructedLeaderboardName(`player-${i}`));
        }
        expect(samples.some((name) => / \d+$/.test(name))).toBe(true);
        expect(samples.some((name) => !/ \d+$/.test(name))).toBe(true);
        for (const name of samples) {
            const match = name.match(/^([A-Z][a-z]+) ([A-Z][a-z]+)(?: (\d+))?$/);
            expect(match).not.toBeNull();
            expect(LEADERBOARD_NAME_ADJECTIVES).toContain(match[1]);
            expect(LEADERBOARD_NAME_NOUNS).toContain(match[2]);
            if (match[3] !== undefined) {
                const suffix = Number(match[3]);
                expect(suffix).toBeGreaterThanOrEqual(2);
                expect(suffix).toBeLessThanOrEqual(99);
            }
        }
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
