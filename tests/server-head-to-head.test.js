import { beforeEach, describe, expect, it, vi } from 'vitest';

const strings = new Map();
const hashes = new Map();
const redis = {
    get: vi.fn(async (key) => strings.get(key) ?? null),
    set: vi.fn(async (key, value, options = {}) => {
        if (options.nx && strings.has(key)) return '';
        strings.set(key, value);
        return 'OK';
    }),
    del: vi.fn(async (key) => strings.delete(key)),
    expire: vi.fn(async () => true),
    expireTime: vi.fn(async () => Math.floor(Date.now() / 1000) + 60),
    incrBy: vi.fn(async (key, amount) => {
        const next = Number(strings.get(key) || 0) + amount;
        strings.set(key, String(next));
        return next;
    }),
    hGetAll: vi.fn(async (key) => Object.fromEntries(hashes.get(key) ?? [])),
    hSet: vi.fn(async (key, entries) => {
        const hash = hashes.get(key) ?? new Map();
        for (const [field, value] of Object.entries(entries)) hash.set(field, value);
        hashes.set(key, hash);
        return Object.keys(entries).length;
    }),
    hSetNX: vi.fn(async (key, field, value) => {
        const hash = hashes.get(key) ?? new Map();
        if (hash.has(field)) return 0;
        hash.set(field, value);
        hashes.set(key, hash);
        return 1;
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
            body: input.textFallback?.text || '',
            getPostData: vi.fn(async () => input.postData),
        };
        activePosts.set(post.id, post);
        return post;
    }),
};

vi.mock('@devvit/redis', () => ({ redis }));
vi.mock('@devvit/web/server', () => ({
    reddit,
    cache: vi.fn(),
    context: undefined,
}));

const {
    createHeadToHeadService,
    formatHeadToHeadTitle,
    HEAD_TO_HEAD_SUBMISSION_RATE_LIMIT_MAX_REQUESTS,
} = await import('../src/server/head-to-head-service.ts');
const {
    resolveHeadToHeadRecordResult,
} = await import('../src/server/head-to-head-post.ts');
const context = {
    username: 'RaceFan',
    subredditName: 'MiniRacer',
    appSlug: 'mini-racer',
    postId: 't3_challenge1',
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

function dailySource(bestTimeMs = 18_240) {
    return {
        sourceKind: 'daily',
        sourceId: 'daily-gp-2026-07-23',
        origin: {
            mode: 'daily',
            challengeId: 'daily-gp-2026-07-23',
        },
        trackKey: 'numberThree',
        lapCount: 2,
        bestTimeMs,
        medal: 'gold',
        rulesRevision: 1,
        trackFingerprint: 'track-fingerprint',
        ghost: { schemaVersion: 2, samples: ['daily-frozen'] },
    };
}

function makeService({
    bestTimeMs = 25_640,
    validatedTimeMs = 25_000,
    sourceKind = 'campaign',
    validateReplay = null,
} = {}) {
    let nextId = 0;
    return createHeadToHeadService({
        resolveSource: vi.fn(async () => source(bestTimeMs, sourceKind)),
        validateReplay: validateReplay || vi.fn(async () => ({
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

describe('head-to-head service', () => {
    beforeEach(() => {
        strings.clear();
        hashes.clear();
        activePosts.clear();
        postNumber = 0;
        vi.clearAllMocks();
    });

    it('puts the verified target and ghost in the post body without storing the replay in Redis', async () => {
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
            entry: 'head-to-head',
            postData: expect.objectContaining({
                postType: 'head-to-head',
                targetTimeMs: 25_640,
                challengerUsername: 'RaceFan',
                challengerAvatarUrl: 'https://i.redd.it/RaceFan.png',
            }),
        }));
        expect(reddit.submitCustomPost.mock.calls[0][0].postData).not.toHaveProperty('ghost');
        const submitted = reddit.submitCustomPost.mock.calls[0][0];
        expect(submitted.postData.replayDataHash).toMatch(/^[a-f0-9]{64}$/);
        expect(submitted.textFallback.text).toContain('Beat **25.640** on **Number Three** (2 laps).');
        expect(submitted.textFallback.text).toContain('Challenge replay data:');
        expect(submitted.textFallback.text).toContain('MINIRACER-HEAD-TO-HEAD-REPLAY-V1');
        expect([...strings.values()].join('\n')).not.toContain('frozen');
    });

    it('embeds a Daily origin and rechecks the exact finish when creating a challenge', async () => {
        const resolveSource = vi.fn(async (input) => {
            expect(input).toMatchObject({
                source: 'daily',
                challengeId: 'daily-gp-2026-07-23',
            });
            return dailySource();
        });
        const replay = {
            rulesRevision: 1,
            targetLapNumber: 2,
            inputs: [{ frames: 12, left: false, right: false, relaunchDelay: false }],
        };
        const service = createHeadToHeadService({
            resolveSource,
            validateReplay: vi.fn(),
            now: () => new Date('2026-07-23T12:00:00.000Z'),
            createId: () => 'daily-challenge-post',
        });
        const preview = await service.preview({
            source: 'daily',
            challengeId: 'daily-gp-2026-07-23',
            replay,
        }, context);
        const created = await service.create({
            challengeToken: preview.body.challengeToken,
            replay,
        }, context);

        expect(created.body.status).toBe('created');
        expect(reddit.submitCustomPost.mock.calls[0][0].postData).toMatchObject({
            origin: {
                mode: 'daily',
                challengeId: 'daily-gp-2026-07-23',
            },
        });
        expect(resolveSource).toHaveBeenCalledTimes(2);
        expect(resolveSource.mock.calls[1][0]).toMatchObject({ replay });
    });

    it('loads a newly created Daily challenge when the viewer request has no post context', async () => {
        const { mintGuestPlayerToken } = await import('../src/server/player-token.ts');
        const service = createHeadToHeadService({
            resolveSource: vi.fn(async () => dailySource()),
            validateReplay: vi.fn(),
            now: () => new Date('2026-07-23T12:00:00.000Z'),
            createId: () => 'daily-challenge-post',
        });
        const replay = { inputs: [{ frames: 12 }] };
        const preview = await service.preview({
            source: 'daily',
            challengeId: 'daily-gp-2026-07-23',
            replay,
        }, context);
        const created = await service.create({
            challengeToken: preview.body.challengeToken,
            replay,
        }, context);
        const guestPlayerId = 'daily-h2h-racer';

        const loaded = await service.get(created.body.challengeId, {
            subredditName: context.subredditName,
            playerId: guestPlayerId,
            guestToken: await mintGuestPlayerToken(guestPlayerId),
        });

        expect(loaded).toMatchObject({
            status: 200,
            body: {
                status: 'ready',
                viewerType: 'guest',
                opponentGhost: dailySource().ghost,
            },
        });
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
            opponentGhost: source().ghost,
        });
    });

    it('uses the request post data when Reddit returns an incomplete post-data copy', async () => {
        const service = makeService();
        const created = await createChallenge(service);
        const post = activePosts.get('t3_challenge1');
        const postData = await post.getPostData();
        post.getPostData = vi.fn(async () => ({}));

        const loaded = await service.get(created.body.challengeId, {
            ...context,
            postData,
            username: 'OtherRacer',
        });

        expect(loaded).toMatchObject({
            status: 200,
            body: {
                status: 'ready',
                opponentGhost: source().ghost,
            },
        });
    });

    it('loads the frozen ghost from a nested Devvit richtext fallback shape', async () => {
        const service = makeService();
        const created = await createChallenge(service);
        const post = activePosts.get('t3_challenge1');
        const submittedFallback = reddit.submitCustomPost.mock.calls[0][0].textFallback.text;
        post.body = undefined;
        post.richtextFallback = {
            text: submittedFallback.replace(/\n/g, '\r\n'),
        };

        const loaded = await service.get(created.body.challengeId, {
            ...context,
            username: 'OtherRacer',
        });

        expect(loaded).toMatchObject({
            status: 200,
            body: {
                status: 'ready',
                opponentGhost: source().ghost,
            },
        });
    });

    it('loads the frozen ghost from a JSON-serialized toJSON selftext shape', async () => {
        const service = makeService();
        const created = await createChallenge(service);
        const post = activePosts.get('t3_challenge1');
        const submittedFallback = reddit.submitCustomPost.mock.calls[0][0].textFallback.text;
        post.body = undefined;
        post.toJSON = () => ({
            selftext: JSON.stringify({ text: submittedFallback }),
        });

        const resolved = await resolveHeadToHeadRecordResult(
            created.body.challengeId,
            context,
        );

        expect(resolved).toMatchObject({
            ok: true,
            record: { frozenGhost: source().ghost },
        });
    });

    it('returns a typed diagnostic when the fallback hash does not validate', async () => {
        const service = makeService();
        const created = await createChallenge(service);
        const post = activePosts.get('t3_challenge1');
        const postData = await post.getPostData();
        post.getPostData = vi.fn(async () => ({
            ...postData,
            replayDataHash: '0'.repeat(64),
        }));

        const resolved = await resolveHeadToHeadRecordResult(
            created.body.challengeId,
            context,
        );

        expect(resolved).toEqual({
            ok: false,
            reason: 'replay_hash_mismatch',
        });
    });

    it('distinguishes a missing fallback from invalid replay data', async () => {
        const service = makeService();
        const created = await createChallenge(service);
        const post = activePosts.get('t3_challenge1');
        post.body = undefined;

        const resolved = await resolveHeadToHeadRecordResult(
            created.body.challengeId,
            context,
        );

        expect(resolved).toEqual({
            ok: false,
            reason: 'replay_fallback_missing',
        });
    });

    it('does not revive a challenge when its replay body is missing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const service = makeService();
        const created = await createChallenge(service);
        activePosts.get('t3_challenge1').body = '# Head to Head · RaceFan\n\nThe replay was removed.';

        const loaded = await service.get(created.body.challengeId, {
            ...context,
            username: 'OtherRacer',
        });
        expect(loaded.status).toBe(404);
        expect(loaded.body.status).toBe('challenge_unavailable');
        expect(warn).toHaveBeenCalledWith('Head to Head resolution failed.', {
            challengeId: created.body.challengeId,
            postId: 't3_challenge1',
            reason: 'replay_token_not_found',
        });
        expect(JSON.stringify(warn.mock.calls)).not.toContain('MINIRACER-HEAD-TO-HEAD-REPLAY-V1');
        warn.mockRestore();
    });

    it('uses the stored Reddit post identity when an older client omits post context', async () => {
        const service = makeService();
        const created = await createChallenge(service);

        const loaded = await service.get(created.body.challengeId, {
            username: 'OtherRacer',
            subredditName: context.subredditName,
        });

        expect(loaded).toMatchObject({
            status: 200,
            body: {
                status: 'ready',
                opponentGhost: source().ghost,
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
        expect(second.body).toMatchObject({
            status: 'already_created',
            challengeId: first.body.challengeId,
            postUrl: first.body.postUrl,
            carUnlocks: {
                progress: {
                    headToHeadTracksPosted: 1,
                },
            },
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
            outcome: 'won',
            resultLabel: 'Challenge Won',
            differenceMs: -640,
        });
        expect(typeof win.body.acceptToken).toBe('string');

        const slowerService = makeService({ validatedTimeMs: 26_000 });
        const loss = await slowerService.submit({ challengeId, replay: {} }, acceptor);
        expect(loss.body).toMatchObject({
            outcome: 'lost',
            resultLabel: 'Challenge Lost',
            differenceMs: 360,
            acceptToken: null,
        });

        const tieService = makeService({ validatedTimeMs: 25_640 });
        const tie = await tieService.submit(
            { challengeId, replay: {} },
            { ...context, username: 'OtherRacer' },
        );
        expect(tie.body).toMatchObject({
            outcome: 'tie',
            resultLabel: 'Tie',
            differenceMs: 0,
            acceptToken: null,
        });
    });

    it('lets a guest load and submit a challenge result', async () => {
        const { mintGuestPlayerToken } = await import('../src/server/player-token.ts');
        const service = makeService({ validatedTimeMs: 25_000 });
        const created = await createChallenge(service);
        const guestPlayerId = 'guest:h2h-racer';
        const guestContext = {
            subredditName: context.subredditName,
            postId: created.body.postUrl ? 't3_challenge1' : null,
            playerId: guestPlayerId.slice('guest:'.length),
            guestToken: await mintGuestPlayerToken(guestPlayerId.slice('guest:'.length)),
        };

        const loaded = await service.get(created.body.challengeId, guestContext);
        expect(loaded).toMatchObject({
            status: 200,
            body: {
                viewerType: 'guest',
                viewerUsername: 'Guest racer',
            },
        });

        const submitted = await service.submit(
            { challengeId: created.body.challengeId, replay: {} },
            guestContext,
        );
        expect(submitted).toMatchObject({
            status: 200,
            body: {
                accepted: true,
                acceptToken: expect.any(String),
            },
        });
    });

    it('limits signed-in Head to Head submissions globally before post lookup and replay validation', async () => {
        const validateReplay = vi.fn(async () => ({
            ok: true,
            bestTimeMs: 26_000,
            medal: 'gold',
            ghost: { schemaVersion: 2, samples: ['viewer'] },
        }));
        const service = makeService({ validateReplay });
        const created = await createChallenge(service);
        const submitContext = {
            ...context,
            username: 'RateRacer',
            requestRateLimitIdentity: 'ignored-for-signed-in-player',
        };

        for (let attempt = 0; attempt < HEAD_TO_HEAD_SUBMISSION_RATE_LIMIT_MAX_REQUESTS; attempt += 1) {
            await expect(service.submit({
                challengeId: created.body.challengeId,
                replay: {},
            }, submitContext)).resolves.toMatchObject({ status: 200 });
        }

        reddit.getPostById.mockClear();
        validateReplay.mockClear();
        const blocked = await service.submit({
            challengeId: created.body.challengeId,
            replay: {},
        }, submitContext);

        expect(blocked).toMatchObject({
            status: 429,
            body: {
                accepted: false,
                status: 'rate_limited',
                retryAfterSeconds: expect.any(Number),
            },
        });
        expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
        expect(reddit.getPostById).not.toHaveBeenCalled();
        expect(validateReplay).not.toHaveBeenCalled();
        expect(strings.get(
            'miniracer:head-to-head:submit-rate-limit:reddit%3Arateracer',
        )).toBe(String(HEAD_TO_HEAD_SUBMISSION_RATE_LIMIT_MAX_REQUESTS + 1));
    });

    it('uses the server-derived request identity so rotating guest IDs cannot reset the limit', async () => {
        const { mintGuestPlayerToken } = await import('../src/server/player-token.ts');
        const validateReplay = vi.fn(async () => ({
            ok: true,
            bestTimeMs: 26_000,
            medal: 'gold',
            ghost: { schemaVersion: 2, samples: ['viewer'] },
        }));
        const service = makeService({ validateReplay });
        const created = await createChallenge(service);
        const guestIds = ['guest:h2h-rate-a', 'guest:h2h-rate-b'];
        const guestTokens = await Promise.all(guestIds.map((playerId) => (
            mintGuestPlayerToken(playerId.slice('guest:'.length))
        )));
        const submitContext = (index) => ({
            subredditName: context.subredditName,
            postId: context.postId,
            playerId: guestIds[index].slice('guest:'.length),
            guestToken: guestTokens[index],
            requestRateLimitIdentity: 'stable-guest-request',
        });

        for (let attempt = 0; attempt < HEAD_TO_HEAD_SUBMISSION_RATE_LIMIT_MAX_REQUESTS; attempt += 1) {
            await expect(service.submit({
                challengeId: created.body.challengeId,
                replay: {},
            }, submitContext(attempt % 2))).resolves.toMatchObject({ status: 200 });
        }

        reddit.getPostById.mockClear();
        validateReplay.mockClear();
        const blocked = await service.submit({
            challengeId: created.body.challengeId,
            replay: {},
        }, submitContext(1));

        expect(blocked.status).toBe(429);
        expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
        expect(reddit.getPostById).not.toHaveBeenCalled();
        expect(validateReplay).not.toHaveBeenCalled();
        expect(strings.get(
            'miniracer:head-to-head:submit-rate-limit:request%3Astable-guest-request',
        )).toBe(String(HEAD_TO_HEAD_SUBMISSION_RATE_LIMIT_MAX_REQUESTS + 1));
    });

    it('reports missing guest identity without telling the player to sign in', async () => {
        const service = makeService();
        const created = await createChallenge(service);
        const submitted = await service.submit(
            { challengeId: created.body.challengeId, replay: {} },
            { subredditName: context.subredditName, postId: 't3_challenge1' },
        );
        expect(submitted).toEqual({
            status: 401,
            body: {
                status: 'player_identity_required',
                error: 'Guest identity unavailable. Reload the challenge to continue.',
            },
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

    it('keeps challenge results isolated from campaign writes', async () => {
        const service = makeService();
        const created = await createChallenge(service);
        const loaded = await service.get(
            created.body.challengeId,
            { ...context, username: 'OtherRacer' },
        );

        expect(loaded.body.challenge).toMatchObject({
            raceId: 'numbered-v1-03',
            targetTimeMs: 25_640,
        });
        expect(loaded.body.opponentGhost).toEqual(source(25_640, 'campaign').ghost);
        expect(loaded.body.bestResult).toBeUndefined();
    });
});
describe('head-to-head formatting', () => {
    it('formats exact verified milliseconds', () => {
        expect(formatHeadToHeadTitle('RaceFan', 9_005, 'numberZero'))
            .toBe('u/RaceFan · Head to Head: beat 9.005 on Number Zero');
    });
});
