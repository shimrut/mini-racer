import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import saved from './fixtures/replay-posts-2026-09-27.json';

// Replay posts saved 2026-09-27, in the live envelopes since 2026-08-08 (podium 08-29); a new reader must read them.
// Posts before 2026-08-08 used MINIRACER-CHALLENGE-REPLAY-V1, which the reader refuses.

const { reddit } = vi.hoisted(() => ({ reddit: { getPostById: vi.fn() } }));

// A second series is made live here as the Creator would.
vi.mock('../game/campaign/series-rules.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isAppCampaignSeriesLive: (series) => ['numbered-v1', 'dirt-v1'].includes(series?.id),
}));
vi.mock('@devvit/web/server', () => ({
    reddit,
    cache: vi.fn(),
    context: undefined,
}));

// Mini Rally is held back from players; the saved stage post needs it live.
vi.mock('../game/track/live-grounds.js', () => import('./helpers/live-grounds-with-dirt.js'));

const { decodeHeadToHeadReplay } = await import('../src/server/head-to-head/head-to-head-replay.ts');
const { resolveHeadToHeadRecordResult } = await import('../src/server/head-to-head/head-to-head-post.ts');
const { decodeDailyPodiumReplay, resolveDailyPodiumReplayFromPost } = await import('../src/server/podium/daily-podium-replay.ts');

function fingerprint(value) {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

// The ways a post can bring its text back.
const TRANSPORTS = {
    'the post body': (text) => ({ body: text }),
    'the text fallback': (text) => ({ textFallback: { text } }),
    'Windows line ends': (text) => ({ body: text.replace(/\n/g, '\r\n') }),
};

describe('saved Head to Head replay posts', () => {
    beforeEach(() => {
        reddit.getPostById.mockReset();
    });

    for (const post of saved.headToHead) {
        it(`reads "${post.name}" with the stored fingerprint`, () => {
            const { decoded, reason } = decodeHeadToHeadReplay(post.text, post.postData);

            expect(reason).toBeUndefined();
            expect(decoded.hash).toBe(post.postData.replayDataHash);
            expect({ ...decoded.envelope, ghost: fingerprint(decoded.envelope.ghost) }).toEqual(post.envelope);
        });

        for (const [transport, shape] of Object.entries(TRANSPORTS)) {
            it(`resolves "${post.name}" from ${transport}`, async () => {
                reddit.getPostById.mockResolvedValue({
                    id: 't3_saved',
                    url: 'https://www.reddit.com/r/MiniRacerGame/comments/saved/',
                    subredditName: 'MiniRacerGame',
                    authorName: post.postData.challengerUsername,
                    getPostData: async () => post.postData,
                    ...shape(post.text),
                });

                const result = await resolveHeadToHeadRecordResult(post.postData.challengeId, {
                    postId: 't3_saved',
                    postData: post.postData,
                });

                expect(result.ok).toBe(true);
                expect(fingerprint(result.record.frozenGhost)).toBe(post.envelope.ghost);
                expect(result.record).toMatchObject({
                    challengeId: post.postData.challengeId,
                    targetTimeMs: post.postData.targetTimeMs,
                    replayDataHash: post.postData.replayDataHash,
                    postId: 't3_saved',
                });
            });
        }
    }
});

describe('saved podium replay posts', () => {
    for (const post of saved.podium) {
        it(`reads "${post.name}" with the stored fingerprint`, () => {
            const { decoded, reason } = decodeDailyPodiumReplay(post.text, {
                challengeId: post.postData.challengeId,
                lapCount: post.postData.podium.lapCount,
                replayDataHash: post.postData.replayDataHash,
            });

            expect(reason).toBeUndefined();
            expect(decoded.hash).toBe(post.postData.replayDataHash);
            expect({
                ...decoded.envelope,
                ghosts: decoded.envelope.ghosts.map((slot) => ({
                    rank: slot.rank,
                    ghost: slot.ghost ? fingerprint(slot.ghost) : null,
                })),
            }).toEqual(post.envelope);
        });

        for (const [transport, shape] of Object.entries(TRANSPORTS)) {
            it(`resolves "${post.name}" from ${transport}`, () => {
                const envelope = resolveDailyPodiumReplayFromPost(shape(post.text), post.postData);

                expect(envelope?.challengeId).toBe(post.postData.challengeId);
                expect(envelope.ghosts.map((slot) => (slot.ghost ? fingerprint(slot.ghost) : null)))
                    .toEqual(post.envelope.ghosts.map((slot) => slot.ghost));
            });
        }
    }
});
