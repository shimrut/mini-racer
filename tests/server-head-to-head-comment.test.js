import { beforeEach, describe, expect, it, vi } from 'vitest';

const strings = new Map();
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
        return 1;
    }),
    expire: vi.fn(async () => true),
    watch: vi.fn(async () => ({
        multi: vi.fn(async () => undefined),
        del: vi.fn(async (key) => {
            strings.delete(key);
            return 1;
        }),
        expire: vi.fn(async () => true),
        exec: vi.fn(async () => [1]),
        unwatch: vi.fn(async () => undefined),
        discard: vi.fn(async () => undefined),
    })),
};
const reddit = {
    getPostById: vi.fn(async () => challengePost),
    submitComment: vi.fn(async () => ({
        id: 't1_comment1',
        url: 'https://reddit.com/r/miniracer/challenge1/comment1',
        authorName: 'OtherRacer',
        delete: vi.fn(async () => undefined),
    })),
};

vi.mock('@devvit/redis', () => ({ redis }));
vi.mock('@devvit/web/server', () => ({ reddit }));

const {
    challengeCommentTier,
    formatChallengeComment,
    previewHeadToHeadComment,
    confirmHeadToHeadComment,
} = await import('../src/server/head-to-head-comment.ts');
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

const context = {
    username: 'OtherRacer',
    subredditName: 'MiniRacer',
    postId: 't3_challenge1',
};

describe('head-to-head comments', () => {
    beforeEach(() => {
        strings.clear();
        installChallengePost();
        vi.clearAllMocks();
    });

    it.each([
        [0, 'tie'],
        [1, 'blink'],
        [100, 'blink'],
        [101, 'chase'],
        [500, 'chase'],
        [501, 'got_away'],
    ])('selects the %s Comment tier at %ims', (differenceMs, expected) => {
        expect(challengeCommentTier(differenceMs)).toBe(expected);
    });

    it.each([
        [0, [
            '10.000s. Same time. That’s worse than losing.',
            'I tried so hard and all I got was a tie 🙄',
        ]],
        [1, [
            '10.001s - Lost by 0.001s on Number One. I was sure I had this 😤',
            '10.001s on Number One. Can’t believe I lost by 0.001s 🫠',
        ]],
        [100, [
            '10.100s - Lost by 0.100s on Number One. I was sure I had this 😤',
            '10.100s on Number One. Can’t believe I lost by 0.100s 🫠',
        ]],
        [101, [
            '10.101s - Not enough pace on Number One.',
            'Definitely not my best run on Number One - 10.101s.',
        ]],
        [500, [
            '10.500s - Not enough pace on Number One.',
            'Definitely not my best run on Number One - 10.500s.',
        ]],
        [501, [
            '10.501s - I have some improvements to do on Number One.',
            'Need more practice on Number One - 10.501s 🏎️',
        ]],
    ])('picks one of the two Comment lines at %ims', (differenceMs, lines) => {
        const reportedTimeMs = 10_000 + differenceMs;
        expect(formatChallengeComment(reportedTimeMs, differenceMs, 'Number One', () => 0)).toBe(lines[0]);
        expect(formatChallengeComment(reportedTimeMs, differenceMs, 'Number One', () => 1)).toBe(lines[1]);
    });

    it('previews and confirms a self-reported loss as text', async () => {
        const preview = await previewHeadToHeadComment(
            {
                challengeId: challenge.challengeId,
                reportedTimeMs: 10_011,
            },
            context,
        );
        expect(preview.status).toBe(200);
        expect(preview.body).toMatchObject({ status: 'ready' });
        expect([
            '10.011s - Lost by 0.011s on Number One. I was sure I had this 😤',
            '10.011s on Number One. Can’t believe I lost by 0.011s 🫠',
        ]).toContain(preview.body.commentText);

        const confirmed = await confirmHeadToHeadComment(
            {
                shareToken: preview.body.shareToken,
            },
            context,
        );
        expect(confirmed.status).toBe(200);
        expect(confirmed.body).toMatchObject({ status: 'commented' });
        expect(reddit.submitComment).toHaveBeenCalledWith(expect.objectContaining({
            id: challenge.postId,
            runAs: 'USER',
            text: preview.body.commentText,
        }));
    });

    it('answers a repeated result with the comment it already posted', async () => {
        const first = await previewHeadToHeadComment(
            { challengeId: challenge.challengeId, reportedTimeMs: 10_000 },
            context,
        );
        const posted = await confirmHeadToHeadComment(
            { shareToken: first.body.shareToken },
            context,
        );
        expect(posted.body).toMatchObject({ status: 'commented' });
        expect(reddit.submitComment).toHaveBeenCalledTimes(1);

        const repeat = await previewHeadToHeadComment(
            { challengeId: challenge.challengeId, reportedTimeMs: 10_000 },
            context,
        );
        expect(repeat.status).toBe(200);
        expect(repeat.body).toEqual({
            status: 'already_commented',
            username: 'OtherRacer',
            commentText: first.body.commentText,
            commentUrl: 'https://reddit.com/r/miniracer/challenge1/comment1',
        });
        expect(reddit.submitComment).toHaveBeenCalledTimes(1);

        const other = await previewHeadToHeadComment(
            { challengeId: challenge.challengeId, reportedTimeMs: 10_400 },
            context,
        );
        expect(other.body).toMatchObject({ status: 'ready' });
    });

    it('confirms a tie as text', async () => {
        const preview = await previewHeadToHeadComment(
            { challengeId: challenge.challengeId, reportedTimeMs: 10_000 },
            context,
        );
        const confirmed = await confirmHeadToHeadComment(
            { shareToken: preview.body.shareToken },
            context,
        );

        expect(confirmed.status).toBe(200);
        expect(confirmed.body.status).toBe('commented');
        expect(reddit.submitComment).toHaveBeenCalledWith(expect.objectContaining({
            text: preview.body.commentText,
        }));
    });

    it('rejects faster finishes because wins use the existing Brag flow', async () => {
        const preview = await previewHeadToHeadComment(
            { challengeId: challenge.challengeId, reportedTimeMs: 9_999 },
            context,
        );
        expect(preview.status).toBe(409);
        expect(preview.body.status).toBe('win_uses_brag');
    });

});
