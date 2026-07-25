import { beforeEach, describe, expect, it, vi } from 'vitest';

const strings = new Map();
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
    getPostById: vi.fn(async () => ({
        id: 't3_challenge1',
        url: 'https://reddit.com/r/miniracer/challenge1',
    })),
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
    previewCampaignChallengeBrag,
    confirmCampaignChallengeBrag,
} = await import('../src/server/campaign-challenge-brag.ts');
const { writeCampaignChallenge, writeCampaignChallengeResult } = await import(
    '../src/server/campaign-challenge-store.ts'
);

const challenge = {
    postType: 'campaign-challenge',
    challengeId: 'challenge-1',
    campaignId: 'numbered-v1',
    raceId: 'numbered-v1-01',
    challengerUsername: 'RaceFan',
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

describe('campaign challenge brag', () => {
    beforeEach(() => {
        strings.clear();
        vi.clearAllMocks();
    });

    it('formats a medal-free brag comment', () => {
        expect(formatChallengeBragComment(9_478, 'numberOne')).toBe(
            'I beat this challenge with 0:09.478 on Number One. 🏁',
        );
    });

    it('rejects brag when the viewer has not beaten the challenge', async () => {
        await writeCampaignChallenge(challenge);
        await writeCampaignChallengeResult({
            challengeId: 'challenge-1',
            viewerUsername: 'OtherRacer',
            bestTimeMs: 11_000,
            medal: null,
            ghost: {},
            verifiedAt: '2026-07-23T12:01:00.000Z',
        });
        const preview = await previewCampaignChallengeBrag(
            { challengeId: 'challenge-1' },
            { username: 'OtherRacer', subredditName: 'MiniRacer' },
        );
        expect(preview.status).toBe(404);
        expect(preview.body.status).toBe('result_unavailable');
    });

    it('rejects brag on your own challenge', async () => {
        await writeCampaignChallenge(challenge);
        const preview = await previewCampaignChallengeBrag(
            { challengeId: 'challenge-1' },
            { username: 'RaceFan', subredditName: 'MiniRacer' },
        );
        expect(preview.status).toBe(403);
        expect(preview.body.status).toBe('own_challenge');
    });

    it('previews and confirms a brag comment on the challenge post', async () => {
        await writeCampaignChallenge(challenge);
        await writeCampaignChallengeResult({
            challengeId: 'challenge-1',
            viewerUsername: 'OtherRacer',
            bestTimeMs: 9_000,
            medal: null,
            ghost: {},
            verifiedAt: '2026-07-23T12:01:00.000Z',
        });

        const preview = await previewCampaignChallengeBrag(
            { challengeId: 'challenge-1' },
            { username: 'OtherRacer', subredditName: 'MiniRacer' },
        );
        expect(preview.status).toBe(200);
        expect(preview.body).toMatchObject({
            status: 'ready',
            username: 'OtherRacer',
            commentText: 'I beat this challenge with 0:09.000 on Number One. 🏁',
        });
        expect(typeof preview.body.shareToken).toBe('string');

        const confirmed = await confirmCampaignChallengeBrag(
            { shareToken: preview.body.shareToken },
            { username: 'OtherRacer', subredditName: 'MiniRacer' },
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
        });

        const again = await previewCampaignChallengeBrag(
            { challengeId: 'challenge-1' },
            { username: 'OtherRacer', subredditName: 'MiniRacer' },
        );
        expect(again.body.status).toBe('already_shared');
    });
});
