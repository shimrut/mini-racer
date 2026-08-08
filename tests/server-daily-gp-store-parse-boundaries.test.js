import { describe, expect, it, vi } from 'vitest';

vi.mock('@devvit/redis', () => ({
    redis: {
        get: vi.fn(),
        mGet: vi.fn(),
        set: vi.fn(),
        del: vi.fn(),
        incrBy: vi.fn(),
        hGet: vi.fn(),
        hMGet: vi.fn(),
        hSet: vi.fn(),
        hSetNX: vi.fn(),
        hGetAll: vi.fn(),
        hScan: vi.fn(),
        hDel: vi.fn(),
        expire: vi.fn(),
        expireTime: vi.fn(),
        zAdd: vi.fn(),
        zCard: vi.fn(),
        zRange: vi.fn(),
        zRank: vi.fn(),
        watch: vi.fn(),
    },
    redisCompressed: {},
}));
vi.mock('../src/server/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: vi.fn(),
}));

const {
    parseStoredChallenge,
    parseStoredEntry,
    parseStoredPlayerProfile,
} = await import('../src/server/daily-gp-store.ts');

const VALID_CHALLENGE = {
    id: 'daily-gp-2026-07-11',
    challengeDate: '2026-07-11',
    trackKey: 'circuit',
    startsAt: '2026-07-11T00:00:00.000Z',
    endsAt: '2026-07-12T00:00:00.000Z',
    availableUntil: '2026-07-18T00:00:00.000Z',
};

describe('daily-gp-store parse boundaries', () => {
    describe('parseStoredChallenge', () => {
        it('rejects null JSON, arrays, and non-objects', () => {
            expect(parseStoredChallenge('null')).toBeNull();
            expect(parseStoredChallenge('[]')).toBeNull();
            expect(parseStoredChallenge('"daily-gp-2026-07-11"')).toBeNull();
            expect(parseStoredChallenge('')).toBeNull();
            expect(parseStoredChallenge(null)).toBeNull();
        });

        it('requires an id that is anchored as daily-gp-YYYY-MM-DD', () => {
            expect(parseStoredChallenge(JSON.stringify({
                ...VALID_CHALLENGE,
                id: 'xdaily-gp-2026-07-11',
            }))).toBeNull();
            expect(parseStoredChallenge(JSON.stringify({
                ...VALID_CHALLENGE,
                id: 'daily-gp-2026-07-11x',
            }))).toBeNull();
            expect(parseStoredChallenge(JSON.stringify(VALID_CHALLENGE))).toMatchObject({
                id: 'daily-gp-2026-07-11',
                trackKey: 'circuit',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                skin: 'default',
            });
        });

        it('rejects missing or non-string schedule fields', () => {
            expect(parseStoredChallenge(JSON.stringify({
                ...VALID_CHALLENGE,
                trackKey: 12,
            }))).toBeNull();
            expect(parseStoredChallenge(JSON.stringify({
                ...VALID_CHALLENGE,
                startsAt: 12,
            }))).toBeNull();
            expect(parseStoredChallenge(JSON.stringify({
                ...VALID_CHALLENGE,
                endsAt: null,
            }))).toBeNull();
            expect(parseStoredChallenge(JSON.stringify({
                ...VALID_CHALLENGE,
                availableUntil: undefined,
            }))).toBeNull();
        });
    });

    describe('parseStoredEntry', () => {
        const baseEntry = {
            playerId: 'reddit:racer',
            trackKey: 'circuit',
            bestTimeMs: 12345,
            updatedAt: '2026-07-11T00:00:00.000Z',
        };

        it('rejects missing playerId, non-finite times, and empty updatedAt', () => {
            expect(parseStoredEntry(JSON.stringify({ ...baseEntry, playerId: '' }))).toBeNull();
            expect(parseStoredEntry(JSON.stringify({ ...baseEntry, playerId: 12 }))).toBeNull();
            expect(parseStoredEntry(JSON.stringify({ ...baseEntry, bestTimeMs: 'fast' }))).toBeNull();
            expect(parseStoredEntry(JSON.stringify({ ...baseEntry, updatedAt: '' }))).toBeNull();
            expect(parseStoredEntry('null')).toBeNull();
        });

        it('drops entries whose trackKey disagrees with the expected track', () => {
            expect(parseStoredEntry(JSON.stringify({
                ...baseEntry,
                trackKey: 'desertBridge',
            }), 'circuit')).toBeNull();
        });

        it('keeps string strictReplayFailureReason and nulls non-strings', () => {
            expect(parseStoredEntry(JSON.stringify({
                ...baseEntry,
                strictReplayFailureReason: 'no_finish',
            }))).toMatchObject({
                strictReplayFailureReason: 'no_finish',
                bestTimeMs: 12345,
            });
            expect(parseStoredEntry(JSON.stringify({
                ...baseEntry,
                strictReplayFailureReason: 42,
            })).strictReplayFailureReason).toBeNull();
        });

        it('defaults trackKey from the expected track when the entry omits it', () => {
            const { trackKey, ...withoutTrack } = baseEntry;
            expect(parseStoredEntry(JSON.stringify(withoutTrack), 'circuit')).toMatchObject({
                trackKey: 'circuit',
                playerId: 'reddit:racer',
            });
        });
    });

    describe('parseStoredPlayerProfile', () => {
        it('rejects non-objects and empty playerId', () => {
            expect(parseStoredPlayerProfile('null')).toBeNull();
            expect(parseStoredPlayerProfile('[]')).toBeNull();
            expect(parseStoredPlayerProfile(JSON.stringify({ playerId: '' }))).toBeNull();
            expect(parseStoredPlayerProfile(JSON.stringify({ playerId: 12 }))).toBeNull();
        });

        it('treats missing hasSeenGame as true and explicit false as false', () => {
            expect(parseStoredPlayerProfile(JSON.stringify({
                playerId: 'reddit:a',
            })).hasSeenGame).toBe(true);
            expect(parseStoredPlayerProfile(JSON.stringify({
                playerId: 'reddit:a',
                hasSeenGame: false,
            })).hasSeenGame).toBe(false);
        });

        it('preserves ISO timestamps and falls back to epoch for non-strings', () => {
            const epoch = new Date(0).toISOString();
            const preserved = parseStoredPlayerProfile(JSON.stringify({
                playerId: 'reddit:a',
                firstSeenAt: '2020-01-01T00:00:00.000Z',
                lastSeenAt: '2021-01-01T00:00:00.000Z',
                updatedAt: '2022-01-01T00:00:00.000Z',
            }));
            expect(preserved).toMatchObject({
                firstSeenAt: '2020-01-01T00:00:00.000Z',
                lastSeenAt: '2021-01-01T00:00:00.000Z',
                updatedAt: '2022-01-01T00:00:00.000Z',
            });

            const fallback = parseStoredPlayerProfile(JSON.stringify({
                playerId: 'reddit:a',
                firstSeenAt: 12345,
                lastSeenAt: true,
                updatedAt: { iso: 'nope' },
            }));
            expect(fallback).toMatchObject({
                firstSeenAt: epoch,
                lastSeenAt: epoch,
                updatedAt: epoch,
            });
        });
    });

});
