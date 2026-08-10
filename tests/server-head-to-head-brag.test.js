import { beforeEach, describe, expect, it, vi } from 'vitest';

const strings = new Map();
const hashes = new Map();
let challengePost = null;
const redis = {
    get: vi.fn(async (key) => strings.get(key) ?? null),
    set: vi.fn(async (key, value, options = {}) => {
        if (options.nx && strings.has(key)) return '';
        strings.set(key, value);
        return 'OK';
    }),
    del: vi.fn(async (key) => {
        strings.delete(key);
        hashes.delete(key);
        return 1;
    }),
    hGetAll: vi.fn(async (key) => Object.fromEntries(hashes.get(key) ?? [])),
    hSet: vi.fn(async (key, entries) => {
        const hash = hashes.get(key) ?? new Map();
        for (const [field, value] of Object.entries(entries)) hash.set(field, value);
        hashes.set(key, hash);
        return Object.keys(entries).length;
    }),
    expire: vi.fn(async () => true),
    watch: vi.fn(async () => {
        const commands = [];
        return {
            multi: vi.fn(async () => undefined),
            unwatch: vi.fn(async () => undefined),
            get: vi.fn(async (key) => strings.get(key) ?? null),
            set: vi.fn(async (...args) => commands.push(() => redis.set(...args))),
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

const reddit = {
    getPostById: vi.fn(async () => challengePost),
    submitComment: vi.fn(async () => ({
        id: 't1_brag1',
        url: 'https://reddit.com/r/miniracer/challenge1/brag1',
        authorName: 'OtherRacer',
        delete: vi.fn(async () => undefined),
    })),
};

vi.mock('@devvit/redis', () => ({ redis }));
vi.mock('@devvit/web/server', () => ({ reddit }));

const {
    formatChallengeBragComment,
    previewHeadToHeadBrag,
    confirmHeadToHeadBrag,
} = await import('../src/server/head-to-head-brag.ts');
const { writeHeadToHeadAccept } = await import(
    '../src/server/head-to-head-store.ts'
);
const {
    encodeHeadToHeadReplay,
    formatHeadToHeadTextFallback,
} = await import('../src/server/head-to-head-replay.ts');

const challenge = {
    postType: 'head-to-head',
    challengeId: 'challenge-1',
    campaignId: 'numbered-v1',
    raceId: 'numbered-v1-01',
    challengerUsername: 'RaceFan',
    challengerAvatarUrl: null,
    trackKey: 'numberOne',
    lapCount: 1,
    targetTimeMs: 10_000,
    medal: 'gold',
    rulesRevision: 1,
    trackFingerprint: 'fp',
    createdAt: '2026-07-23T12:00:00.000Z',
    subredditName: 'MiniRacer',
    sourceKind: 'campaign',
    sourceId: 'numbered-v1-01',
    frozenGhost: { schemaVersion: 2, samples: [] },
    postId: 't3_challenge1',
    postUrl: 'https://reddit.com/r/miniracer/challenge1',
};

function installChallengePost() {
    const postData = {
        postType: challenge.postType,
        challengeId: challenge.challengeId,
        origin: { mode: 'campaign', campaignId: challenge.campaignId, raceId: challenge.raceId },
        campaignId: challenge.campaignId,
        raceId: challenge.raceId,
        challengerUsername: challenge.challengerUsername,
        challengerAvatarUrl: challenge.challengerAvatarUrl,
        trackKey: challenge.trackKey,
        lapCount: challenge.lapCount,
        targetTimeMs: challenge.targetTimeMs,
        medal: challenge.medal,
        rulesRevision: challenge.rulesRevision,
        trackFingerprint: challenge.trackFingerprint,
        createdAt: challenge.createdAt,
    };
    const replay = encodeHeadToHeadReplay(postData, challenge.frozenGhost);
    const immutablePostData = { ...postData, replayDataHash: replay.hash };
    challengePost = {
        id: challenge.postId,
        url: challenge.postUrl,
        authorName: challenge.challengerUsername,
        subredditName: challenge.subredditName,
        body: formatHeadToHeadTextFallback(immutablePostData, challenge.frozenGhost),
        getPostData: vi.fn(async () => immutablePostData),
    };
}

describe('head-to-head brag', () => {
    beforeEach(() => {
        strings.clear();
        hashes.clear();
        installChallengePost();
        vi.clearAllMocks();
    });

    it('formats a medal-free brag comment', () => {
        expect(formatChallengeBragComment(9_478, 'numberOne')).toBe(
            'I beat this challenge with 0:09.478 on Number One. 🏁',
        );
    });

    it('rejects brag when the viewer has not beaten the challenge', async () => {
        await writeHeadToHeadAccept('token-losing', {
            challengeId: 'challenge-1',
            postId: 't3_challenge1',
            playerId: 'reddit:otherracer',
            username: 'OtherRacer',
            bestTimeMs: 11_000,
            targetTimeMs: 10_000,
            medal: null,
            commentText: formatChallengeBragComment(11_000, 'numberOne'),
        });
        const preview = await previewHeadToHeadBrag(
            { acceptToken: 'token-losing' },
            { username: 'OtherRacer', subredditName: 'MiniRacer', postId: 't3_challenge1' },
        );
        expect(preview.status).toBe(404);
        expect(preview.body.status).toBe('result_unavailable');
    });

    it('rejects brag on your own challenge', async () => {
        await writeHeadToHeadAccept('token-own', {
            challengeId: 'challenge-1',
            postId: 't3_challenge1',
            playerId: 'reddit:racefan',
            username: 'RaceFan',
            bestTimeMs: 9_000,
            targetTimeMs: 10_000,
            medal: 'gold',
            commentText: formatChallengeBragComment(9_000, 'numberOne'),
        });
        const preview = await previewHeadToHeadBrag(
            { acceptToken: 'token-own' },
            { username: 'RaceFan', subredditName: 'MiniRacer', postId: 't3_challenge1' },
        );
        expect(preview.status).toBe(403);
        expect(preview.body.status).toBe('own_challenge');
    });

    it('previews and confirms a brag comment on the challenge post', async () => {
        await writeHeadToHeadAccept('token-winning', {
            challengeId: 'challenge-1',
            postId: 't3_challenge1',
            playerId: 'reddit:otherracer',
            username: 'OtherRacer',
            bestTimeMs: 9_000,
            targetTimeMs: 10_000,
            medal: 'gold',
            commentText: formatChallengeBragComment(9_000, 'numberOne'),
        });

        const preview = await previewHeadToHeadBrag(
            { acceptToken: 'token-winning' },
            { username: 'OtherRacer', subredditName: 'MiniRacer', postId: 't3_challenge1' },
        );
        expect(preview.status).toBe(200);
        expect(preview.body).toMatchObject({
            status: 'ready',
            username: 'OtherRacer',
            commentText: 'I beat this challenge with 0:09.000 on Number One. 🏁',
        });
        expect(typeof preview.body.shareToken).toBe('string');

        const confirmed = await confirmHeadToHeadBrag(
            { shareToken: preview.body.shareToken },
            { username: 'OtherRacer', subredditName: 'MiniRacer', postId: 't3_challenge1' },
        );
        expect(confirmed.status).toBe(200);
        expect(confirmed.body).toMatchObject({
            status: 'shared',
            commentId: 't1_brag1',
            commentText: preview.body.commentText,
        });
        expect(reddit.submitComment).toHaveBeenCalledWith({
            id: 't3_challenge1',
            text: preview.body.commentText,
            runAs: 'USER',
        });

        const again = await previewHeadToHeadBrag(
            { acceptToken: 'token-winning' },
            { username: 'OtherRacer', subredditName: 'MiniRacer', postId: 't3_challenge1' },
        );
        expect(again.status).toBe(200);
        expect(again.body.status).toBe('ready');
    });
});
