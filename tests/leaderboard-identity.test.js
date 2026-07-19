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
        expect(first).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+( \d+)?$/);
    });

    it('strips only a leading u/ prefix from reddit usernames', () => {
        expect(sanitizeRedditUsername('U/CapsUser')).toBe('CapsUser');
        expect(sanitizeRedditUsername('midu/name')).toBe('midu/name');
        expect(sanitizeRedditUsername('   ')).toBeNull();
    });

    it('keeps the adjective and noun catalogs intact for constructed names', () => {
        expect(LEADERBOARD_NAME_ADJECTIVES).toHaveLength(24);
        expect(LEADERBOARD_NAME_NOUNS).toHaveLength(24);
        expect(LEADERBOARD_NAME_ADJECTIVES[0]).toBe('Arctic');
        expect(LEADERBOARD_NAME_ADJECTIVES[2]).toBe('Crimson');
        expect(LEADERBOARD_NAME_ADJECTIVES[3]).toBe('Electric');
        expect(LEADERBOARD_NAME_ADJECTIVES[8]).toBe('Jade');
        expect(LEADERBOARD_NAME_ADJECTIVES[16]).toBe('Shadow');
        expect(LEADERBOARD_NAME_NOUNS[0]).toBe('Badger');
        expect(LEADERBOARD_NAME_NOUNS[1]).toBe('Cobra');
        expect(LEADERBOARD_NAME_NOUNS[2]).toBe('Falcon');
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

        const hash = hashLeaderboardPlayerId('a');
        const adjective = LEADERBOARD_NAME_ADJECTIVES[hash % LEADERBOARD_NAME_ADJECTIVES.length];
        const noun = LEADERBOARD_NAME_NOUNS[
            Math.floor(hash / LEADERBOARD_NAME_ADJECTIVES.length) % LEADERBOARD_NAME_NOUNS.length
        ];
        const suffixSeed = hash >>> 16;
        const suffix = suffixSeed % 4 === 0 ? '' : ` ${2 + (suffixSeed % 98)}`;
        expect(getConstructedLeaderboardName('a')).toBe(`${adjective} ${noun}${suffix}`);
        expect(adjective).not.toBe('');
        expect(noun).not.toBe('');
    });

    it('uses a numeric suffix unless the high hash bits are divisible by four', () => {
        const samples = [];
        for (let i = 0; i < 200; i += 1) {
            samples.push(getConstructedLeaderboardName(`player-${i}`));
        }
        expect(samples.some((name) => / \d+$/.test(name))).toBe(true);
        expect(samples.some((name) => !/ \d+$/.test(name))).toBe(true);
        for (const name of samples) {
            const [adjective, noun] = name.split(' ');
            expect(LEADERBOARD_NAME_ADJECTIVES).toContain(adjective);
            expect(LEADERBOARD_NAME_NOUNS).toContain(noun);
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
