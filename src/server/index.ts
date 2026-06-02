import express from 'express';
import { createServer, getServerPort } from '@devvit/server';
import { context, reddit } from '@devvit/web/server';
import type { MenuItemRequest } from '@devvit/shared/types/menu-item.js';
import {
    buildDailyGpChallengeById,
    buildDailyGpPlaylist,
} from './daily-gp-model.js';
import {
    getServerDailyGpChallenge,
    getServerDailyGpSnapshot,
    getServerPlayerBootstrap,
    submitServerDailyGpRun,
    updateServerPlayerIdentity,
} from './daily-gp-store.js';

const app = express();
app.use(express.json({ limit: '4mb' }));

function getRequestUsername(): string | null {
    return typeof context.username === 'string' && context.username.trim()
        ? context.username.trim()
        : null;
}

function readContextSubredditId(): string | null {
    const id = (context as { subredditId?: unknown }).subredditId;
    return typeof id === 'string' && id.startsWith('t5_') ? id : null;
}

function readContextSubredditName(): string | null {
    const name = (context as { subredditName?: unknown }).subredditName;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function readContextPostId(): string | null {
    const id = (context as { postId?: unknown }).postId;
    return typeof id === 'string' && id.startsWith('t3_') ? id : null;
}

async function getPostBoundDailyGpChallenge() {
    const postId = readContextPostId();
    if (!postId) {
        return null;
    }

    try {
        const post = await reddit.getPostById(postId as `t3_${string}`);
        const postData = await post.getPostData();
        const challengeId = typeof postData?.challengeId === 'string' && postData.challengeId
            ? postData.challengeId
            : null;
        return challengeId ? buildDailyGpChallengeById(challengeId) : null;
    } catch (error) {
        console.error('Failed to resolve post-bound Mini Racer challenge:', error);
        return null;
    }
}

/** Reddit sometimes returns counts as strings; treat any finite number ≥ 1 as valid. */
function coercePositiveSubscriberCount(raw: unknown): number | undefined {
    if (raw == null) {
        return undefined;
    }
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || n < 1) {
        return undefined;
    }
    return Math.min(Math.trunc(n), 1_000_000);
}

function pickSubredditInfoSubscriberCount(info: object | null | undefined): number | undefined {
    if (!info) {
        return undefined;
    }
    const record = info as Record<string, unknown>;
    return coercePositiveSubscriberCount(
        record.subscribersCount
        ?? record.subscribers
        ?? record.subscriberCount,
    );
}

async function getPostSubredditContext(): Promise<{ id?: `t5_${string}`; name?: string } | null> {
    const postId = readContextPostId();
    if (!postId) {
        return null;
    }

    try {
        const post = await reddit.getPostById(postId as `t3_${string}`);
        return {
            id: typeof post?.subredditId === 'string' && post.subredditId.startsWith('t5_')
                ? post.subredditId as `t5_${string}`
                : undefined,
            name: typeof post?.subredditName === 'string' && post.subredditName.trim()
                ? post.subredditName.trim()
                : undefined,
        };
    } catch (error) {
        console.error('getPostById failed for leaderboard community context:', error);
        return null;
    }
}

async function countListingUsernames(listing: { all(): Promise<Array<{ username?: string }>> }): Promise<Set<string>> {
    const users = await listing.all();
    return new Set(
        users
            .map((user) => typeof user?.username === 'string' ? user.username.trim().toLowerCase() : '')
            .filter(Boolean),
    );
}

async function getListedCommunityUserCount(subredditName: string): Promise<number | undefined> {
    try {
        const subreddit = await reddit.getSubredditByName(subredditName);
        const [approvedUsers, moderators] = await Promise.all([
            countListingUsernames(subreddit.getApprovedUsers({ limit: 1000, pageSize: 100 })),
            countListingUsernames(subreddit.getModerators({ limit: 1000, pageSize: 100 })),
        ]);
        const users = new Set([...approvedUsers, ...moderators]);
        return users.size > 0 ? users.size : undefined;
    } catch (error) {
        console.error('Failed to list approved users/moderators for leaderboard community size:', error);
        return undefined;
    }
}

/**
 * Member count for "rank out of N" and open leaderboard slots.
 * Prefer exact accessible users/mods when available; otherwise use public subscriber count.
 */
async function getCommunityMemberTotalForLeaderboard(): Promise<number | undefined> {
    const postSubreddit = await getPostSubredditContext();
    const subredditId = readContextSubredditId() || postSubreddit?.id || null;
    const subredditName = readContextSubredditName() || postSubreddit?.name || null;
    const candidates: number[] = [];

    if (subredditName) {
        const listedCount = await getListedCommunityUserCount(subredditName);
        if (listedCount != null) {
            candidates.push(listedCount);
        }
    }

    if (subredditId) {
        try {
            const info = await reddit.getSubredditInfoById(subredditId as `t5_${string}`);
            const n = pickSubredditInfoSubscriberCount(info);
            if (n != null) {
                candidates.push(n);
            }
        } catch (error) {
            console.error('getSubredditInfoById failed for leaderboard community size:', error);
        }
    }

    if (subredditName) {
        try {
            const info = await reddit.getSubredditInfoByName(subredditName);
            const n = pickSubredditInfoSubscriberCount(info);
            if (n != null) {
                candidates.push(n);
            }
        } catch (error) {
            console.error('getSubredditInfoByName failed for leaderboard community size:', error);
        }
    }

    try {
        const subreddit = await reddit.getCurrentSubreddit();
        const n = coercePositiveSubscriberCount(subreddit?.numberOfSubscribers);
        if (n != null) {
            candidates.push(n);
        }
    } catch (error) {
        console.error('getCurrentSubreddit failed for leaderboard community size:', error);
    }

    return candidates.length ? Math.max(...candidates) : undefined;
}

app.get('/api/player/bootstrap', async (req, res) => {
    try {
        const { playerId } = req.query ?? {};
        const payload = await getServerPlayerBootstrap({
            playerId: playerId as string,
            redditUsername: getRequestUsername(),
        });
        res.status(200).json(payload);
    } catch (error) {
        console.error('Failed to load Reddit Mini Racer player bootstrap:', error);
        res.status(500).json({ error: 'Player bootstrap failed' });
    }
});

app.post('/api/player/identity', async (req, res) => {
    try {
        const { playerId, leaderboardIdentity } = req.body ?? {};
        const payload = await updateServerPlayerIdentity({
            playerId,
            leaderboardIdentity,
            redditUsername: getRequestUsername(),
        });
        res.status(200).json(payload);
    } catch (error) {
        console.error('Failed to update Reddit Mini Racer player identity:', error);
        res.status(500).json({ error: 'Player identity update failed' });
    }
});

app.get('/api/scoreboard/snapshot', async (req, res) => {
    try {
        const { trackKey, playerId, limit } = req.query ?? {};
        const activeChallenge = await getServerDailyGpChallenge();
        const challenge = trackKey === activeChallenge.trackKey
            ? activeChallenge
            : buildDailyGpPlaylist().find((entry) => entry.trackKey === trackKey) || null;
        if (!challenge) {
            res.status(200).json({
                topRows: [],
                nearbyRows: [],
                currentPlayerRow: null,
                totalCount: 0,
                leaderboardEntryCount: 0,
                playerRank: null,
                playerRankLabel: null,
                objectiveType: activeChallenge.objectiveType,
            });
            return;
        }

        const communityMemberTotal = await getCommunityMemberTotalForLeaderboard();
        const snapshot = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            playerId: playerId as string,
            redditUsername: getRequestUsername(),
            limit: limit ? parseInt(limit as string, 10) : undefined,
            communityMemberTotal,
        });
        res.status(200).json(snapshot);
    } catch (error) {
        console.error('Failed to load Reddit Mini Racer scoreboard snapshot:', error);
        res.status(500).json({ error: 'Scoreboard snapshot failed' });
    }
});

app.post('/api/scoreboard/submit', async (req, res) => {
    try {
        const { trackKey, playerId, leaderboardIdentity, replay, checkpointTimesSec } = req.body ?? {};
        const challenge = await getServerDailyGpChallenge();
        if (trackKey !== challenge.trackKey) {
            res.status(404).json({ accepted: false, error: 'Track is not the active Mini Racer challenge.' });
            return;
        }

        const result = await submitServerDailyGpRun({
            playerId,
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            leaderboardIdentity,
            redditUsername: getRequestUsername(),
            replay,
            checkpointTimesSec,
        });
        res.status(result.status).json(result.body);
    } catch (error) {
        console.error('Failed to submit Reddit Mini Racer scoreboard run:', error);
        res.status(500).json({ accepted: false, error: 'Scoreboard submit failed' });
    }
});

app.get('/api/daily/active', async (_req, res) => {
    try {
        const challenge = await getPostBoundDailyGpChallenge() || await getServerDailyGpChallenge();
        res.status(200).json(challenge);
    } catch (error) {
        console.error('Failed to load Reddit Mini Racer active challenge:', error);
        res.status(500).json({ error: 'Active challenge lookup failed' });
    }
});

app.get('/api/daily/playlist', async (_req, res) => {
    try {
        res.status(200).json({
            challenges: buildDailyGpPlaylist(),
        });
    } catch (error) {
        console.error('Failed to load Reddit Mini Racer daily playlist:', error);
        res.status(500).json({ error: 'Daily playlist lookup failed' });
    }
});

app.get('/api/daily/snapshot', async (req, res) => {
    try {
        const { challengeId, playerId, limit } = req.query ?? {};
        const communityMemberTotal = await getCommunityMemberTotalForLeaderboard();
        const snapshot = await getServerDailyGpSnapshot({
            challengeId: challengeId as string,
            playerId: playerId as string,
            redditUsername: getRequestUsername(),
            limit: limit ? parseInt(limit as string, 10) : undefined,
            communityMemberTotal,
        });
        res.status(200).json(snapshot);
    } catch (error) {
        console.error('Failed to load Reddit Mini Racer snapshot:', error);
        res.status(500).json({ error: 'Daily challenge snapshot failed' });
    }
});

app.post('/api/daily/submit', async (req, res) => {
    try {
        const result = await submitServerDailyGpRun({
            ...(req.body ?? {}),
            redditUsername: getRequestUsername(),
        });
        res.status(result.status).json(result.body);
    } catch (error) {
        console.error('Failed to submit Reddit Mini Racer run:', error);
        res.status(500).json({ accepted: false, error: 'Daily challenge submit failed' });
    }
});

app.post('/internal/menu/post-create', async (req, res) => {
    try {
        const input = (req.body ?? {}) as Partial<MenuItemRequest>;
        const targetId = typeof input.targetId === 'string' ? input.targetId : '';
        const subredditInfo = targetId.startsWith('t5_')
            ? await reddit.getSubredditInfoById(targetId as `t5_${string}`)
            : null;
        const subredditName = subredditInfo?.name || context.subredditName || null;

        if (!subredditName) {
            res.json({
                showToast: {
                    text: 'Reddit did not provide a subreddit context for this install.',
                    appearance: 'neutral'
                }
            });
            return;
        }

        const challenge = await getServerDailyGpChallenge();
        const post = await reddit.submitCustomPost({
            subredditName,
            title: 'Mini Racer',
            entry: 'default',
            postData: {
                challengeId: challenge.id,
            },
            textFallback: {
                text: [
                    '# Mini Racer',
                    '',
                    'Playable Reddit racing challenge.',
                    '',
                    '- One featured event at a time',
                    '- Fast retries',
                    '- Personal best plus live leaderboard'
                ].join('\n')
            }
        });

        res.json({
            navigateTo: post.url
        });
    } catch (error) {
        console.error('Failed to create Mini Racer post:', error);
        const message = error instanceof Error && error.message
            ? error.message
            : 'Unknown error';
        res.json({
            showToast: {
                text: `Could not create the Mini Racer post: ${message}`,
                appearance: 'neutral'
            }
        });
    }
});

createServer(app).listen(getServerPort());
