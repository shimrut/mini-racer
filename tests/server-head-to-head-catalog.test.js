import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACKS } from '../game/track/tracks.js';

const strings = new Map();
const hashes = new Map();
const zsets = new Map();

function hashFor(key) {
    const hash = hashes.get(key) ?? new Map();
    hashes.set(key, hash);
    return hash;
}

function zsetFor(key) {
    const set = zsets.get(key) ?? [];
    zsets.set(key, set);
    return set;
}

const redis = {
    get: vi.fn(async (key) => strings.get(key) ?? null),
    set: vi.fn(async (key, value, options = {}) => {
        if (options.nx && strings.has(key)) return '';
        strings.set(key, value);
        return 'OK';
    }),
    del: vi.fn(async (key) => strings.delete(key)),
    hGet: vi.fn(async (key, field) => hashFor(key).get(field) ?? null),
    hSet: vi.fn(async (key, entries) => {
        const hash = hashFor(key);
        for (const [field, value] of Object.entries(entries)) hash.set(field, value);
        return Object.keys(entries).length;
    }),
    hDel: vi.fn(async (key, fields) => {
        const hash = hashFor(key);
        for (const field of fields) hash.delete(field);
        return fields.length;
    }),
    zAdd: vi.fn(async (key, member) => {
        const set = zsetFor(key).filter((row) => row.member !== member.member);
        set.push({ member: member.member, score: member.score });
        zsets.set(key, set);
        return 1;
    }),
    zRem: vi.fn(async (key, members) => {
        zsets.set(key, zsetFor(key).filter((row) => !members.includes(row.member)));
        return members.length;
    }),
    zCard: vi.fn(async (key) => zsetFor(key).length),
    zRange: vi.fn(async (key, start, stop, options = {}) => {
        let rows = [...zsetFor(key)].sort((left, right) => left.score - right.score);
        if (options.by === 'score') {
            const low = Math.min(start, stop);
            const high = Math.max(start, stop);
            rows = rows.filter((row) => row.score >= low && row.score <= high);
        } else {
            rows = rows.slice(start, stop + 1);
        }
        if (options.reverse) rows.reverse();
        if (options.limit) {
            const offset = options.limit.offset ?? 0;
            const count = options.limit.count ?? rows.length;
            rows = rows.slice(offset, offset + count);
        }
        return rows;
    }),
    watch: vi.fn(async () => {
        const commands = [];
        return {
            multi: vi.fn(async () => undefined),
            unwatch: vi.fn(async () => undefined),
            del: vi.fn(async (...args) => commands.push(() => redis.del(...args))),
            exec: vi.fn(async () => {
                const output = [];
                for (const command of commands) output.push(await command());
                return output;
            }),
            discard: vi.fn(async () => undefined),
        };
    }),
};

const reddit = {
    getPostById: vi.fn(async () => ({ removed: false })),
    searchPosts: vi.fn(),
    getNewPosts: vi.fn(),
};

vi.mock('@devvit/redis', () => ({ redis }));
vi.mock('@devvit/web/server', () => ({ reddit }));

const {
    upsertHeadToHeadCatalogCard,
    pickNextHeadToHeadChallenge,
    sweepHeadToHeadCatalog,
    catalogHeadToHeadSize,
} = await import('../src/server/head-to-head-catalog.ts');
const { createTrackFingerprint } = await import('../src/server/pb-ghost-trace.ts');

const TRACK_KEY = Object.keys(TRACKS)[0];
const OTHER_TRACK_KEY = Object.keys(TRACKS)[1];

function card(overrides = {}) {
    return {
        challengeId: 'challenge-1',
        postId: 't3_one',
        postUrl: 'https://reddit.com/r/miniracer/one',
        subredditName: 'MiniRacer',
        challengerUsername: 'Poster',
        trackKey: TRACK_KEY,
        lapCount: 1,
        targetTimeMs: 12_000,
        medal: 'gold',
        createdAt: '2026-09-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('Head to Head catalog', () => {
    beforeEach(() => {
        strings.clear();
        hashes.clear();
        zsets.clear();
        reddit.getPostById.mockResolvedValue({ removed: false });
    });

    it('does not count a second write of the same post as new', async () => {
        await expect(upsertHeadToHeadCatalogCard(card())).resolves.toBe(true);
        await expect(upsertHeadToHeadCatalogCard(card({ targetTimeMs: 11_000 }))).resolves.toBe(false);
        await expect(catalogHeadToHeadSize('MiniRacer')).resolves.toBe(1);
    });

    it('picks a slower time on the same track before a different track', async () => {
        await upsertHeadToHeadCatalogCard(card());
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'challenge-easier',
            postId: 't3_easier',
            postUrl: 'https://reddit.com/r/miniracer/easier',
            challengerUsername: 'Other',
            targetTimeMs: 14_000,
            createdAt: '2026-09-02T00:00:00.000Z',
        }));
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'challenge-other',
            postId: 't3_other',
            postUrl: 'https://reddit.com/r/miniracer/other',
            challengerUsername: 'Other',
            trackKey: OTHER_TRACK_KEY,
            targetTimeMs: 9_000,
            createdAt: '2026-09-03T00:00:00.000Z',
        }));

        const picked = await pickNextHeadToHeadChallenge({
            subredditName: 'MiniRacer',
            excludeChallengeId: 'challenge-1',
            excludeUsername: 'Racer',
            trackKey: TRACK_KEY,
            targetTimeMs: 12_000,
        });

        expect(picked).toMatchObject({ challengeId: 'challenge-easier', postUrl: 'https://reddit.com/r/miniracer/easier' });
    });

    it('skips the player’s own posts and the current challenge', async () => {
        await upsertHeadToHeadCatalogCard(card({
            challengerUsername: 'Racer',
            challengeId: 'own',
            postId: 't3_own',
            postUrl: 'https://reddit.com/r/miniracer/own',
            targetTimeMs: 20_000,
        }));
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'challenge-other',
            postId: 't3_other',
            postUrl: 'https://reddit.com/r/miniracer/other',
            challengerUsername: 'Other',
            trackKey: OTHER_TRACK_KEY,
        }));

        const picked = await pickNextHeadToHeadChallenge({
            subredditName: 'MiniRacer',
            excludeChallengeId: 'challenge-1',
            excludeUsername: 'Racer',
            trackKey: TRACK_KEY,
            targetTimeMs: 12_000,
        });

        expect(picked).toMatchObject({ challengeId: 'challenge-other' });
    });

    it('drops a deleted post and continues', async () => {
        reddit.getPostById
            .mockRejectedValueOnce(new Error('gone'))
            .mockResolvedValueOnce({ removed: false });
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'dead',
            postId: 't3_dead',
            postUrl: 'https://reddit.com/r/miniracer/dead',
            challengerUsername: 'Other',
            targetTimeMs: 18_000,
        }));
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'live',
            postId: 't3_live',
            postUrl: 'https://reddit.com/r/miniracer/live',
            challengerUsername: 'Other',
            trackKey: OTHER_TRACK_KEY,
        }));

        const picked = await pickNextHeadToHeadChallenge({
            subredditName: 'MiniRacer',
            excludeChallengeId: 'challenge-1',
            excludeUsername: 'Racer',
            trackKey: TRACK_KEY,
            targetTimeMs: 12_000,
        });

        expect(picked).toMatchObject({ challengeId: 'live' });
        await expect(catalogHeadToHeadSize('MiniRacer')).resolves.toBe(1);
    });

    it('keeps looking after a full page of removed posts', async () => {
        reddit.getPostById.mockImplementation(async (postId) => {
            if (postId === 't3_live') return { removed: false };
            throw new Error('gone');
        });
        for (let index = 0; index < 12; index += 1) {
            await upsertHeadToHeadCatalogCard(card({
                challengeId: `dead-${index}`,
                postId: `t3_dead_${index}`,
                postUrl: `https://reddit.com/r/miniracer/dead-${index}`,
                challengerUsername: 'Other',
                trackKey: OTHER_TRACK_KEY,
                createdAt: new Date(Date.parse('2026-09-20T00:00:00.000Z') - index * 60_000).toISOString(),
            }));
        }
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'live',
            postId: 't3_live',
            postUrl: 'https://reddit.com/r/miniracer/live',
            challengerUsername: 'Other',
            trackKey: OTHER_TRACK_KEY,
            createdAt: '2026-08-01T00:00:00.000Z',
        }));

        const picked = await pickNextHeadToHeadChallenge({
            subredditName: 'MiniRacer',
            excludeChallengeId: 'challenge-1',
            excludeUsername: 'Racer',
            trackKey: TRACK_KEY,
            targetTimeMs: 12_000,
        });

        expect(picked).toMatchObject({ challengeId: 'live' });
    });

    it('collects valid Challenges posts and skips junk', async () => {
        const fingerprint = createTrackFingerprint(TRACKS[TRACK_KEY]);
        const result = await sweepHeadToHeadCatalog('MiniRacer', {
            listPosts: async () => ([
                {
                    id: 't3_good',
                    url: 'https://reddit.com/r/miniracer/good',
                    authorName: 'Poster',
                    subredditName: 'MiniRacer',
                    removed: false,
                    flair: { text: 'Challenges' },
                    getPostData: async () => ({
                        postType: 'head-to-head',
                        challengeId: 'swept-1',
                        trackKey: TRACK_KEY,
                        lapCount: 1,
                        targetTimeMs: 13_000,
                        medal: 'silver',
                        trackFingerprint: fingerprint,
                        createdAt: '2026-09-10T00:00:00.000Z',
                    }),
                },
                {
                    id: 't3_daily',
                    url: 'https://reddit.com/r/miniracer/daily',
                    authorName: 'Poster',
                    subredditName: 'MiniRacer',
                    removed: false,
                    flair: { text: 'Daily' },
                    getPostData: async () => ({ postType: 'daily' }),
                },
                {
                    id: 't3_removed',
                    url: 'https://reddit.com/r/miniracer/removed',
                    authorName: 'Poster',
                    subredditName: 'MiniRacer',
                    removed: true,
                    getPostData: async () => ({ postType: 'head-to-head' }),
                },
            ]),
        });

        expect(result).toEqual({ scanned: 3, saved: 1, skipped: 2, status: 'done' });
        await expect(catalogHeadToHeadSize('MiniRacer')).resolves.toBe(1);
    });

    it('does not double-count a post already saved', async () => {
        const fingerprint = createTrackFingerprint(TRACKS[TRACK_KEY]);
        const post = {
            id: 't3_good',
            url: 'https://reddit.com/r/miniracer/good',
            authorName: 'Poster',
            subredditName: 'MiniRacer',
            removed: false,
            getPostData: async () => ({
                postType: 'head-to-head',
                challengeId: 'swept-1',
                trackKey: TRACK_KEY,
                lapCount: 1,
                targetTimeMs: 13_000,
                medal: 'bronze',
                trackFingerprint: fingerprint,
                createdAt: '2026-09-10T00:00:00.000Z',
            }),
        };
        await sweepHeadToHeadCatalog('MiniRacer', { listPosts: async () => [post] });
        const again = await sweepHeadToHeadCatalog('MiniRacer', { listPosts: async () => [post] });
        expect(again.saved).toBe(0);
        expect(again.status).toBe('done');
        await expect(catalogHeadToHeadSize('MiniRacer')).resolves.toBe(1);
    });

    it('keeps going past one page until the posts are older than a month', async () => {
        const fingerprint = createTrackFingerprint(TRACKS[TRACK_KEY]);
        const recent = new Date().toISOString();
        const posts = Array.from({ length: 150 }, (_, index) => {
            const id = `t3_${String(index).padStart(4, '0')}`;
            return {
                id,
                url: `https://reddit.com/r/miniracer/${id}`,
                authorName: 'Poster',
                subredditName: 'MiniRacer',
                removed: false,
                createdAt: recent,
                getPostData: async () => ({
                    postType: 'head-to-head',
                    challengeId: id,
                    trackKey: TRACK_KEY,
                    lapCount: 1,
                    targetTimeMs: 13_000,
                    medal: 'silver',
                    trackFingerprint: fingerprint,
                    createdAt: recent,
                }),
            };
        });
        posts.push({
            id: 't3_old',
            url: 'https://reddit.com/r/miniracer/old',
            authorName: 'Poster',
            subredditName: 'MiniRacer',
            removed: false,
            createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
            getPostData: async () => ({ postType: 'head-to-head' }),
        });
        const listPosts = async (_subredditName, after) => {
            const start = after ? posts.findIndex((post) => post.id === after) + 1 : 0;
            return posts.slice(start, start + 100);
        };

        const first = await sweepHeadToHeadCatalog('MiniRacer', { listPosts, maxPosts: 100 });
        const second = await sweepHeadToHeadCatalog('MiniRacer', { listPosts, maxPosts: 100 });

        expect(first).toMatchObject({ saved: 100, status: 'partial' });
        expect(second).toMatchObject({ saved: 50, status: 'done' });
        await expect(catalogHeadToHeadSize('MiniRacer')).resolves.toBe(150);
    });
});
