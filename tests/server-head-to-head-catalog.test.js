import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRaceMedalThresholds } from '../game/medals/medal-timing.js';
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
    hMGet: vi.fn(async (key, fields) => fields.map((field) => hashFor(key).get(field) ?? null)),
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
    readHeadToHeadCatalogCard,
} = await import('../src/server/head-to-head-catalog.ts');
const { createTrackFingerprint } = await import('../src/server/pb-ghost-trace.ts');

const TRACK_KEY = Object.keys(TRACKS)[0];
const OTHER_TRACK_KEY = Object.keys(TRACKS)[1];

function timeInBand(trackKey, band) {
    const thresholds = getRaceMedalThresholds(trackKey, 1);
    if (band === 'gold') return Math.floor(thresholds.gold * 1000);
    if (band === 'silver') return Math.floor(((thresholds.gold + thresholds.silver) / 2) * 1000);
    return Math.floor(thresholds.bronze * 1000) + 1000;
}

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

    it('opens the quietest challenge in the same medal band', async () => {
        const current = timeInBand(TRACK_KEY, 'gold');
        await upsertHeadToHeadCatalogCard(card({ targetTimeMs: current, createdAt: '2026-09-10T00:00:00.000Z' }));
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'loud',
            postId: 't3_loud',
            postUrl: 'https://reddit.com/r/miniracer/loud',
            challengerUsername: 'Other',
            trackKey: OTHER_TRACK_KEY,
            targetTimeMs: timeInBand(OTHER_TRACK_KEY, 'gold'),
            commentCount: 4,
            upvoteCount: 20,
            createdAt: '2026-09-01T00:00:00.000Z',
        }));
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'quiet',
            postId: 't3_quiet',
            postUrl: 'https://reddit.com/r/miniracer/quiet',
            challengerUsername: 'Other',
            trackKey: OTHER_TRACK_KEY,
            targetTimeMs: timeInBand(OTHER_TRACK_KEY, 'gold'),
            commentCount: 0,
            upvoteCount: 1,
            createdAt: '2026-09-02T00:00:00.000Z',
        }));
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'other-band',
            postId: 't3_silver',
            postUrl: 'https://reddit.com/r/miniracer/silver',
            challengerUsername: 'Other',
            trackKey: OTHER_TRACK_KEY,
            targetTimeMs: timeInBand(OTHER_TRACK_KEY, 'silver'),
            commentCount: 0,
            upvoteCount: 99,
            createdAt: '2026-08-01T00:00:00.000Z',
        }));

        const picked = await pickNextHeadToHeadChallenge({
            subredditName: 'MiniRacer',
            excludeChallengeId: 'challenge-1',
            excludeUsername: 'Racer',
            trackKey: TRACK_KEY,
            lapCount: 1,
            targetTimeMs: current,
            createdAt: '2026-09-10T00:00:00.000Z',
        });

        expect(picked).toMatchObject({ challengeId: 'quiet' });
        expect(reddit.getPostById).not.toHaveBeenCalled();
    });

    it('uses more upvotes when the comment count matches', async () => {
        const current = timeInBand(TRACK_KEY, 'gold');
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'few-votes',
            postId: 't3_few',
            postUrl: 'https://reddit.com/r/miniracer/few',
            challengerUsername: 'Other',
            targetTimeMs: current,
            commentCount: 0,
            upvoteCount: 1,
            createdAt: '2026-08-01T00:00:00.000Z',
        }));
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'more-votes',
            postId: 't3_more',
            postUrl: 'https://reddit.com/r/miniracer/more',
            challengerUsername: 'Other',
            targetTimeMs: current,
            commentCount: 0,
            upvoteCount: 8,
            createdAt: '2026-09-01T00:00:00.000Z',
        }));

        const picked = await pickNextHeadToHeadChallenge({
            subredditName: 'MiniRacer',
            excludeChallengeId: 'challenge-1',
            excludeUsername: 'Racer',
            trackKey: TRACK_KEY,
            lapCount: 1,
            targetTimeMs: current,
            createdAt: '2026-09-10T00:00:00.000Z',
        });

        expect(picked).toMatchObject({ challengeId: 'more-votes' });
    });

    it('uses an older challenge when comments and upvotes match, otherwise a newer one', async () => {
        const current = timeInBand(TRACK_KEY, 'gold');
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'older',
            postId: 't3_older',
            postUrl: 'https://reddit.com/r/miniracer/older',
            challengerUsername: 'Other',
            targetTimeMs: current,
            createdAt: '2026-08-01T00:00:00.000Z',
        }));
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'newer',
            postId: 't3_newer',
            postUrl: 'https://reddit.com/r/miniracer/newer',
            challengerUsername: 'Other',
            targetTimeMs: current,
            createdAt: '2026-09-20T00:00:00.000Z',
        }));

        const picked = await pickNextHeadToHeadChallenge({
            subredditName: 'MiniRacer',
            excludeChallengeId: 'challenge-1',
            excludeUsername: 'Racer',
            trackKey: TRACK_KEY,
            lapCount: 1,
            targetTimeMs: current,
            createdAt: '2026-09-10T00:00:00.000Z',
        });
        expect(picked).toMatchObject({ challengeId: 'older' });

        hashes.clear();
        zsets.clear();
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'only-newer',
            postId: 't3_only_newer',
            postUrl: 'https://reddit.com/r/miniracer/only-newer',
            challengerUsername: 'Other',
            targetTimeMs: current,
            createdAt: '2026-09-20T00:00:00.000Z',
        }));
        const later = await pickNextHeadToHeadChallenge({
            subredditName: 'MiniRacer',
            excludeChallengeId: 'challenge-1',
            excludeUsername: 'Racer',
            trackKey: TRACK_KEY,
            lapCount: 1,
            targetTimeMs: current,
            createdAt: '2026-09-10T00:00:00.000Z',
        });
        expect(later).toMatchObject({ challengeId: 'only-newer' });
    });

    it('skips the player’s own posts and a target slower than bronze', async () => {
        const current = timeInBand(TRACK_KEY, 'gold');
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'own',
            postId: 't3_own',
            postUrl: 'https://reddit.com/r/miniracer/own',
            challengerUsername: 'Racer',
            targetTimeMs: current,
            commentCount: 0,
        }));
        await upsertHeadToHeadCatalogCard(card({
            challengeId: 'other',
            postId: 't3_other',
            postUrl: 'https://reddit.com/r/miniracer/other',
            challengerUsername: 'Other',
            targetTimeMs: current,
            commentCount: 2,
        }));

        await expect(pickNextHeadToHeadChallenge({
            subredditName: 'MiniRacer',
            excludeChallengeId: 'challenge-1',
            excludeUsername: 'Racer',
            trackKey: TRACK_KEY,
            lapCount: 1,
            targetTimeMs: current,
            createdAt: '2026-09-10T00:00:00.000Z',
        })).resolves.toMatchObject({ challengeId: 'other' });

        await expect(pickNextHeadToHeadChallenge({
            subredditName: 'MiniRacer',
            excludeChallengeId: 'challenge-1',
            excludeUsername: 'Racer',
            trackKey: TRACK_KEY,
            lapCount: 1,
            targetTimeMs: timeInBand(TRACK_KEY, 'slow'),
            createdAt: '2026-09-10T00:00:00.000Z',
        })).resolves.toBeNull();
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
                    numberOfComments: 3,
                    score: 7,
                    flair: { text: 'Challenge' },
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
        await expect(readHeadToHeadCatalogCard('MiniRacer', 'swept-1')).resolves.toMatchObject({
            commentCount: 3,
            upvoteCount: 7,
        });
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
