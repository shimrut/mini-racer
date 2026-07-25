import { beforeEach, describe, expect, it, vi } from 'vitest';

const strings = new Map();
const redis = {
    get: vi.fn(async (key) => strings.get(key) ?? null),
    set: vi.fn(async (key, value, options = {}) => {
        if (options.nx && strings.has(key)) return '';
        strings.set(key, value);
        return 'OK';
    }),
    del: vi.fn(async (key) => strings.delete(key)),
    expire: vi.fn(async () => true),
    incrBy: vi.fn(async (key, amount) => {
        const next = Number(strings.get(key) || 0) + amount;
        strings.set(key, String(next));
        return next;
    }),
    watch: vi.fn(async () => {
        const commands = [];
        return {
            multi: vi.fn(async () => undefined),
            unwatch: vi.fn(async () => undefined),
            del: vi.fn(async (...args) => commands.push(() => redis.del(...args))),
            expire: vi.fn(async (...args) => commands.push(() => redis.expire(...args))),
            exec: vi.fn(async () => {
                const output = [];
                for (const command of commands) output.push(await command());
                return output;
            }),
            discard: vi.fn(async () => undefined),
        };
    }),
};

let postNumber = 0;
const activePosts = new Map();
const reddit = {
    getPostById: vi.fn(async (id) => {
        const post = activePosts.get(id);
        if (!post) throw new Error('missing');
        return post;
    }),
    getPostsByUser: vi.fn(async () => ({ all: async () => [] })),
    getSnoovatarUrl: vi.fn(async (username) => `https://i.redd.it/${username}.png`),
    submitCustomPost: vi.fn(async (input) => {
        postNumber += 1;
        const post = {
            id: `t3_challenge${postNumber}`,
            url: `https://reddit.com/r/miniracer/challenge${postNumber}`,
            subredditName: input.subredditName,
            removed: false,
        };
        activePosts.set(post.id, post);
        return post;
    }),
};

vi.mock('@devvit/redis', () => ({ redis }));
vi.mock('@devvit/web/server', () => ({ reddit }));

const {
    createCampaignChallengeService,
    formatCampaignChallengeTitle,
} = await import('../src/server/campaign-challenge-service.ts');
const {
    readCampaignChallenge,
} = await import('../src/server/campaign-challenge-store.ts');

const context = {
    username: 'RaceFan',
    subredditName: 'MiniRacer',
    appSlug: 'mini-racer',
};

function source(bestTimeMs = 25_640, sourceKind = 'campaign') {
    return {
        sourceKind,
        sourceId: sourceKind === 'campaign' ? 'numbered-v1-03' : 'duel-result-1',
        campaignId: 'numbered-v1',
        raceId: 'numbered-v1-03',
        trackKey: 'numberThree',
        lapCount: 2,
        bestTimeMs,
        medal: 'gold',
        rulesRevision: 1,
        trackFingerprint: 'track-fingerprint',
        ghost: { schemaVersion: 2, samples: ['frozen'] },
    };
}

function makeService({
    bestTimeMs = 25_640,
    validatedTimeMs = 25_000,
    sourceKind = 'campaign',
} = {}) {
    let nextId = 0;
    return createCampaignChallengeService({
        resolveSource: vi.fn(async () => source(bestTimeMs, sourceKind)),
        validateReplay: vi.fn(async () => ({
            ok: true,
            bestTimeMs: validatedTimeMs,
            medal: 'gold',
            ghost: { schemaVersion: 2, samples: ['viewer'] },
        })),
        now: () => new Date('2026-07-23T12:00:00.000Z'),
        createId: () => `generated-${++nextId}`,
    });
}

async function createChallenge(service) {
    const preview = await service.preview({ sourceKind: 'campaign' }, context);
    return service.create({ challengeToken: preview.body.challengeToken }, context);
}

describe('campaign challenge service', () => {
    beforeEach(() => {
        strings.clear();
        activePosts.clear();
        postNumber = 0;
        vi.clearAllMocks();
    });

    it('derives immutable public post data from the verified source and freezes the ghost server-side', async () => {
        const service = makeService();
        const preview = await service.preview({ bestTimeMs: 1, ghost: 'forged' }, context);

        expect(preview.status).toBe(200);
        expect(preview.body.title).toBe('u/RaceFan · Head to Head: beat 25.640 on Number Three');
        expect(preview.body.preview).not.toHaveProperty('ghost');
        expect(preview.body.preview).not.toHaveProperty('sourceId');
        expect(preview.body.preview.challengerAvatarUrl).toBe('https://i.redd.it/RaceFan.png');

        const created = await service.create(
            { challengeToken: preview.body.challengeToken },
            context,
        );
        expect(created.body.status).toBe('created');
        expect(reddit.submitCustomPost).toHaveBeenCalledWith(expect.objectContaining({
            entry: 'campaign-challenge',
            postData: expect.objectContaining({
                postType: 'campaign-challenge',
                targetTimeMs: 25_640,
                challengerUsername: 'RaceFan',
                challengerAvatarUrl: 'https://i.redd.it/RaceFan.png',
            }),
        }));
        expect(reddit.submitCustomPost.mock.calls[0][0].postData).not.toHaveProperty('ghost');
        const stored = await readCampaignChallenge(created.body.challengeId);
        expect(stored.frozenGhost).toEqual(source().ghost);
        expect(stored.challengerAvatarUrl).toBe('https://i.redd.it/RaceFan.png');
    });

    it('returns challenger and viewer avatars when loading a Head to Head', async () => {
        const service = makeService();
        const created = await createChallenge(service);
        const loaded = await service.get(created.body.challengeId, {
            ...context,
            username: 'OtherRacer',
        });
        expect(loaded.status).toBe(200);
        expect(loaded.body).toMatchObject({
            status: 'ready',
            viewerUsername: 'OtherRacer',
            viewerAvatarUrl: 'https://i.redd.it/OtherRacer.png',
            challenge: {
                challengerUsername: 'RaceFan',
                challengerAvatarUrl: 'https://i.redd.it/RaceFan.png',
            },
        });
    });

    it('requires a signed-in Reddit user and current subreddit', async () => {
        const service = makeService();
        expect((await service.preview({}, { subredditName: 'MiniRacer' })).status).toBe(401);
        expect((await service.get('missing', { username: 'RaceFan' })).status).toBe(401);
        expect((await service.submit({ challengeId: 'missing' }, { username: 'RaceFan' })).status).toBe(401);
    });

    it('reuses the same live post for the same user, race, and exact time', async () => {
        const service = makeService();
        const first = await createChallenge(service);
        const second = await createChallenge(service);

        expect(first.body.status).toBe('created');
        expect(second.body).toEqual({
            status: 'already_created',
            challengeId: first.body.challengeId,
            postUrl: first.body.postUrl,
        });
        expect(reddit.submitCustomPost).toHaveBeenCalledTimes(1);
    });

    it('allows only three distinct new posts per user, subreddit, and UTC day', async () => {
        for (const time of [20_001, 20_002, 20_003]) {
            const created = await createChallenge(makeService({ bestTimeMs: time }));
            expect(created.body.status).toBe('created');
        }
        const blocked = await createChallenge(makeService({ bestTimeMs: 20_004 }));
        expect(blocked.status).toBe(429);
        expect(blocked.body.status).toBe('daily_limit_reached');
        expect(reddit.submitCustomPost).toHaveBeenCalledTimes(3);
    });

    it('stores only the viewer best duel and reports win, tie, and loss precisely', async () => {
        const service = makeService({ bestTimeMs: 25_640, validatedTimeMs: 25_000 });
        const created = await createChallenge(service);
        const challengeId = created.body.challengeId;
        const acceptor = { ...context, username: 'ChallengerAce' };

        const win = await service.submit({ challengeId, replay: {} }, acceptor);
        expect(win.body).toMatchObject({
            accepted: true,
            improved: true,
            outcome: 'won',
            resultLabel: 'Challenge Won',
            differenceMs: -640,
        });

        const slowerService = makeService({ validatedTimeMs: 26_000 });
        const loss = await slowerService.submit({ challengeId, replay: {} }, acceptor);
        expect(loss.body).toMatchObject({
            improved: false,
            outcome: 'lost',
            resultLabel: 'Challenge Lost',
            differenceMs: 360,
        });
        expect(loss.body.bestResult.bestTimeMs).toBe(25_000);

        const tieService = makeService({ validatedTimeMs: 25_640 });
        const tie = await tieService.submit(
            { challengeId, replay: {} },
            { ...context, username: 'OtherRacer' },
        );
        expect(tie.body).toMatchObject({
            improved: true,
            outcome: 'tie',
            resultLabel: 'Tie',
            differenceMs: 0,
        });
    });

    it('rejects get and submit when the viewer created the challenge', async () => {
        const service = makeService();
        const created = await createChallenge(service);
        const challengeId = created.body.challengeId;

        const ownGet = await service.get(challengeId, context);
        expect(ownGet.status).toBe(403);
        expect(ownGet.body).toEqual({
            status: 'own_challenge',
            error: "You can't accept your own Head to Head.",
            viewerUsername: 'RaceFan',
            viewerAvatarUrl: 'https://i.redd.it/RaceFan.png',
            challengerAvatarUrl: 'https://i.redd.it/RaceFan.png',
        });

        const ownSubmit = await service.submit({ challengeId, replay: {} }, context);
        expect(ownSubmit.status).toBe(403);
        expect(ownSubmit.body.status).toBe('own_challenge');

        const otherGet = await service.get(challengeId, { ...context, username: 'OtherRacer' });
        expect(otherGet.status).toBe(200);
        expect(otherGet.body.status).toBe('ready');
    });

    it('keeps challenge results isolated from campaign writes and supports duel-result chaining', async () => {
        const service = makeService({ sourceKind: 'duel' });
        const created = await createChallenge(service);
        const loaded = await service.get(
            created.body.challengeId,
            { ...context, username: 'OtherRacer' },
        );

        expect(loaded.body.challenge).toMatchObject({
            raceId: 'numbered-v1-03',
            targetTimeMs: 25_640,
        });
        expect(loaded.body.opponentGhost).toEqual(source(25_640, 'duel').ghost);
        expect(loaded.body.bestResult).toBeNull();
    });
});
describe('campaign challenge formatting', () => {
    it('formats exact verified milliseconds', () => {
        expect(formatCampaignChallengeTitle('RaceFan', 9_005, 'numberZero'))
            .toBe('u/RaceFan · Head to Head: beat 9.005 on Number Zero');
    });
});
