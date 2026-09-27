import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import saved from './fixtures/replay-posts-2026-09-27.json';

// Reads replay posts that were saved on 2026-09-27 and are never made again.
// The Head to Head envelope has not changed since 2026-08-08, and the podium
// envelope since 2026-08-29, so these posts have the same form as the live
// posts made since then. Each ghost was made by the game's own recorder. The
// test does not encode anything: a new reader must read these same bytes.
// Posts made before 2026-08-08 used the name MINIRACER-CHALLENGE-REPLAY-V1,
// which the reader does not accept.

const { reddit } = vi.hoisted(() => ({ reddit: { getPostById: vi.fn() } }));

vi.mock('@devvit/web/server', () => ({
    reddit,
    cache: vi.fn(),
    context: undefined,
}));

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
