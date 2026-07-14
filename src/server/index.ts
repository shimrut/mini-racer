import express from 'express';
import { context, createServer, getServerPort, reddit, redis } from '@devvit/web/server';
import type { MenuItemRequest } from '@devvit/web/shared';
import { TRACKS } from '../../game/track/tracks.js';
import { type DailyGpChallenge, isDailyGpChallengePlayable } from './daily-gp-model.js';
import {
    getServerDailyGpChallenge,
    getServerDailyGpChallengeById,
    getServerDailyGpPlaylist,
    getServerDailyGpSnapshot,
    getServerPlayerBootstrap,
    persistServerDailyGpChallenge,
    submitServerDailyGpRun,
    updateServerPlayerIdentity,
    updateServerPlayerPreferences,
} from './daily-gp-store.js';
import {
    confirmDailyGpShare,
    ensureDailyGpScoreThread,
    previewDailyGpShare,
    registerDailyGpPostWithScoreThread,
    resolveDailyGpPostRecord,
} from './daily-gp-share.js';
import {
    acquireDailyGpPostCreationLock,
    releaseDailyGpPostCreationLock,
} from './daily-gp-post-store.js';
import {
    getServerAnalyticsSummary,
    submitServerAnalyticsEvent,
} from './analytics-store.js';
import {
    formatDailyMiniRacerPostTitle,
    formatDailyMiniRacerTextFallback,
} from './reddit-post-title.js';
import { getCommunityMemberCount } from './community-member-count.js';

const app = express();
app.use(express.json({ limit: '256kb' }));

const DAILY_AUTPOST_SUBREDDITS_KEY = 'dailygp:autopost:subreddits';
const MOD_ANALYTICS_POSTS_KEY = 'dailygp:mod-analytics:posts';

type DailyAutopostSubscription = {
    subredditName: string;
    enabled: boolean;
    enabledAt: string | null;
    updatedAt: string;
    lastPostedChallengeId: string | null;
    lastPostedAt: string | null;
    lastPostUrl: string | null;
};

type ModAnalyticsPostRecord = {
    subredditName: string;
    postId: `t3_${string}` | null;
    postUrl: string | null;
    updatedAt: string;
};

function getRequestUsername(): string | null {
    return typeof context.username === 'string' && context.username.trim()
        ? context.username.trim()
        : null;
}

function getRequestAppSlug(): string | null {
    const appSlug = (context as { appSlug?: unknown }).appSlug;
    return typeof appSlug === 'string' && appSlug.trim() ? appSlug.trim() : null;
}

function hasPlayerCredential(value: unknown): boolean {
    return typeof value === 'string' && Boolean(value.trim());
}

function sendPlayerAuthorizationFailure(
    res: express.Response,
    { playerId, guestToken }: { playerId?: unknown; guestToken?: unknown },
): void {
    if (hasPlayerCredential(playerId) || hasPlayerCredential(guestToken)) {
        res.status(401).json({ error: 'Guest token is required for this player.' });
        return;
    }
    res.status(400).json({ error: 'Invalid player identity.' });
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

function readContextPostData(): Record<string, unknown> | null {
    const postData = (context as { postData?: unknown }).postData;
    return postData && typeof postData === 'object'
        ? postData as Record<string, unknown>
        : null;
}

function setAnalyticsCorsHeaders(res: express.Response): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function normalizePostBoundDailyGpChallenge(value: unknown): DailyGpChallenge | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const record = value as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const challengeDate = typeof record.challengeDate === 'string' ? record.challengeDate : '';
    const trackKey = typeof record.trackKey === 'string' ? record.trackKey : '';
    const startsAt = typeof record.startsAt === 'string' ? record.startsAt : '';
    const endsAt = typeof record.endsAt === 'string' ? record.endsAt : '';
    const availableUntil = typeof record.availableUntil === 'string' ? record.availableUntil : '';

    if (
        !/^daily-gp-\d{4}-\d{2}-\d{2}$/.test(id)
        || !challengeDate
        || !trackKey
        || !TRACKS[trackKey]
        || !startsAt
        || !endsAt
        || !availableUntil
    ) {
        return null;
    }

    return {
        id,
        challengeDate,
        trackKey,
        startsAt,
        endsAt,
        availableUntil,
        status: 'active',
        objectiveType: 'single_lap_fastest',
        objectiveParams: {},
        skin: 'default',
    };
}

async function getPostBoundDailyGpChallenge() {
    const contextPostData = readContextPostData();
    const contextChallenge = normalizePostBoundDailyGpChallenge(contextPostData?.challenge);
    if (contextChallenge) {
        return persistServerDailyGpChallenge(contextChallenge);
    }

    const contextChallengeId = contextPostData?.challengeId;
    if (typeof contextChallengeId === 'string' && contextChallengeId) {
        return getServerDailyGpChallengeById(contextChallengeId);
    }

    const postId = readContextPostId();
    if (!postId) {
        return null;
    }

    try {
        const post = await reddit.getPostById(postId as `t3_${string}`);
        const postData = await post.getPostData();
        const challenge = normalizePostBoundDailyGpChallenge(postData?.challenge);
        if (challenge) {
            return persistServerDailyGpChallenge(challenge);
        }
        const challengeId = typeof postData?.challengeId === 'string' && postData.challengeId
            ? postData.challengeId
            : null;
        return challengeId ? getServerDailyGpChallengeById(challengeId) : null;
    } catch (error) {
        console.error('Failed to resolve post-bound Mini Racer challenge:', error);
        return null;
    }
}

function parseDailyAutopostSubscription(
    subredditName: string,
    raw: string | null | undefined,
): DailyAutopostSubscription | null {
    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        return {
            subredditName,
            enabled: parsed.enabled !== false,
            enabledAt: typeof parsed.enabledAt === 'string' && parsed.enabledAt ? parsed.enabledAt : null,
            updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt
                ? parsed.updatedAt
                : new Date(0).toISOString(),
            lastPostedChallengeId: typeof parsed.lastPostedChallengeId === 'string' && parsed.lastPostedChallengeId
                ? parsed.lastPostedChallengeId
                : null,
            lastPostedAt: typeof parsed.lastPostedAt === 'string' && parsed.lastPostedAt
                ? parsed.lastPostedAt
                : null,
            lastPostUrl: typeof parsed.lastPostUrl === 'string' && parsed.lastPostUrl
                ? parsed.lastPostUrl
                : null,
        };
    } catch (_error) {
        return null;
    }
}

async function readDailyAutopostSubscription(
    subredditName: string,
): Promise<DailyAutopostSubscription | null> {
    const raw = await redis.hGet(DAILY_AUTPOST_SUBREDDITS_KEY, subredditName);
    return parseDailyAutopostSubscription(subredditName, raw);
}

async function readAllDailyAutopostSubscriptions(): Promise<DailyAutopostSubscription[]> {
    const rawMap = await redis.hGetAll(DAILY_AUTPOST_SUBREDDITS_KEY);
    return Object.entries(rawMap)
        .map(([subredditName, raw]) => parseDailyAutopostSubscription(subredditName, raw))
        .filter((entry): entry is DailyAutopostSubscription => Boolean(entry));
}

async function writeDailyAutopostSubscription(
    subscription: DailyAutopostSubscription,
): Promise<void> {
    await redis.hSet(
        DAILY_AUTPOST_SUBREDDITS_KEY,
        { [subscription.subredditName]: JSON.stringify(subscription) },
    );
}

async function deleteDailyAutopostSubscription(subredditName: string): Promise<void> {
    await redis.hDel(DAILY_AUTPOST_SUBREDDITS_KEY, [subredditName]);
}

async function upsertDailyAutopostSubscription(
    subredditName: string,
    updater: (previous: DailyAutopostSubscription | null) => DailyAutopostSubscription,
): Promise<DailyAutopostSubscription> {
    const previous = await readDailyAutopostSubscription(subredditName);
    const next = updater(previous);
    await writeDailyAutopostSubscription(next);
    return next;
}

function parseModAnalyticsPostRecord(
    subredditName: string,
    raw: string | null | undefined,
): ModAnalyticsPostRecord | null {
    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        const postId = typeof parsed.postId === 'string' && parsed.postId.startsWith('t3_')
            ? parsed.postId as `t3_${string}`
            : null;
        const postUrl = typeof parsed.postUrl === 'string' && parsed.postUrl.trim()
            ? parsed.postUrl.trim()
            : null;

        return {
            subredditName,
            postId,
            postUrl,
            updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt
                ? parsed.updatedAt
                : new Date(0).toISOString(),
        };
    } catch (_error) {
        return null;
    }
}

async function readModAnalyticsPostRecord(
    subredditName: string,
): Promise<ModAnalyticsPostRecord | null> {
    const raw = await redis.hGet(MOD_ANALYTICS_POSTS_KEY, subredditName);
    return parseModAnalyticsPostRecord(subredditName, raw);
}

async function writeModAnalyticsPostRecord(record: ModAnalyticsPostRecord): Promise<void> {
    await redis.hSet(
        MOD_ANALYTICS_POSTS_KEY,
        { [record.subredditName]: JSON.stringify(record) },
    );
}

async function submitDailyMiniRacerPost(
    subredditName: string,
    challenge: DailyGpChallenge,
    appSlug: string,
) {
    const post = await reddit.submitCustomPost({
        subredditName,
        title: formatDailyMiniRacerPostTitle(challenge),
        entry: 'default',
        postData: {
            challengeId: challenge.id,
            challenge,
        },
        textFallback: {
            text: formatDailyMiniRacerTextFallback(challenge),
        },
    });
    if (typeof post.id !== 'string' || !post.id.startsWith('t3_') || typeof post.url !== 'string') {
        throw new Error('Reddit did not return the daily post identity.');
    }
    await registerDailyGpPostWithScoreThread({
        subredditName,
        challengeId: challenge.id,
        postId: post.id as `t3_${string}`,
        postUrl: post.url,
        appSlug,
    });
    return post;
}

async function submitModeratorAnalyticsPost(subredditName: string) {
    const post = await reddit.submitCustomPost({
        subredditName,
        title: 'Mini Racer Moderator Analytics',
        entry: 'mod-analytics',
        sendreplies: false,
        postData: {
            tool: 'mod-analytics',
            subredditName,
        },
        textFallback: {
            text: [
                '# Mini Racer Moderator Analytics',
                '',
                `Subreddit: r/${subredditName}`,
                '',
                'This custom post hosts the moderator-only analytics tool for Mini Racer.',
                'Open it from the subreddit moderator menu to review and export analytics.',
            ].join('\n'),
        },
    });

    try {
        await post.lock();
    } catch (error) {
        console.error(`Failed to lock moderator analytics post for r/${subredditName}:`, error);
    }

    try {
        await post.remove(false);
    } catch (error) {
        console.error(`Failed to remove moderator analytics post for r/${subredditName}:`, error);
    }

    return post;
}

async function ensureDailyMiniRacerPostForSubreddit(
    subredditName: string,
    challenge: DailyGpChallenge,
) {
    const current = await readDailyAutopostSubscription(subredditName);
    const appSlug = getRequestAppSlug();
    if (!appSlug) {
        throw new Error('Reddit did not provide the Mini Racer app identity.');
    }
    const existing = await resolveDailyGpPostRecord({
        subredditName,
        challengeId: challenge.id,
        appSlug,
        preferredPostUrl: current?.lastPostedChallengeId === challenge.id ? current.lastPostUrl : null,
    });
    if (existing) {
        await ensureDailyGpScoreThread(existing, appSlug);
        await upsertDailyAutopostSubscription(subredditName, (previous) => ({
            subredditName,
            enabled: previous?.enabled ?? false,
            enabledAt: previous?.enabledAt ?? null,
            updatedAt: new Date().toISOString(),
            lastPostedChallengeId: challenge.id,
            lastPostedAt: previous?.lastPostedChallengeId === challenge.id
                ? previous.lastPostedAt
                : existing.createdAt,
            lastPostUrl: existing.postUrl,
        }));
        return {
            created: false,
            postUrl: existing.postUrl,
        };
    }

    const lock = await acquireDailyGpPostCreationLock(subredditName, challenge.id);
    if (!lock) {
        const raced = await resolveDailyGpPostRecord({ subredditName, challengeId: challenge.id, appSlug });
        if (raced) {
            const prepared = await ensureDailyGpScoreThread(raced, appSlug);
            return { created: false, postUrl: prepared.postUrl };
        }
        throw new Error('Today\'s Mini Racer post is already being created.');
    }
    try {
        const raced = await resolveDailyGpPostRecord({ subredditName, challengeId: challenge.id, appSlug });
        if (raced) {
            const prepared = await ensureDailyGpScoreThread(raced, appSlug);
            return { created: false, postUrl: prepared.postUrl };
        }
        const post = await submitDailyMiniRacerPost(subredditName, challenge, appSlug);
        await upsertDailyAutopostSubscription(subredditName, (previous) => ({
            subredditName,
            enabled: previous?.enabled ?? false,
            enabledAt: previous?.enabledAt ?? null,
            updatedAt: new Date().toISOString(),
            lastPostedChallengeId: challenge.id,
            lastPostedAt: new Date().toISOString(),
            lastPostUrl: post.url,
        }));
        return { created: true, postUrl: post.url };
    } finally {
        await releaseDailyGpPostCreationLock(lock);
    }
}

async function resolveMenuTargetSubredditName(targetId: string): Promise<string | null> {
    const subredditInfo = targetId.startsWith('t5_')
        ? await reddit.getSubredditInfoById(targetId as `t5_${string}`)
        : null;
    const subredditName = subredditInfo?.name || context.subredditName || null;
    return typeof subredditName === 'string' && subredditName.trim()
        ? subredditName.trim()
        : null;
}

async function isModeratorForSubreddit(
    subredditName: string,
    username: string,
): Promise<boolean> {
    try {
        const subreddit = await reddit.getSubredditByName(subredditName);
        const moderators = await subreddit.getModerators({ limit: 1000, pageSize: 100 }).all();
        return moderators.some((moderator) => (
            typeof moderator?.username === 'string'
            && moderator.username.trim().toLowerCase() === username.trim().toLowerCase()
        ));
    } catch (error) {
        console.error(`Failed to verify moderator access for r/${subredditName}:`, error);
        return false;
    }
}

async function assertModeratorForSubreddit(subredditName: string): Promise<string> {
    const username = getRequestUsername();
    if (!username) {
        throw new Error('Reddit did not provide the acting username.');
    }

    const isModerator = await isModeratorForSubreddit(subredditName, username);
    if (!isModerator) {
        throw new Error(`Moderator access required for r/${subredditName}.`);
    }

    return username;
}

async function resolveAnalyticsToolSubredditName(): Promise<string | null> {
    const contextName = readContextSubredditName();
    if (contextName) {
        return contextName;
    }

    const postDataName = readContextPostData()?.subredditName;
    if (typeof postDataName === 'string' && postDataName.trim()) {
        return postDataName.trim();
    }

    const postContext = await getPostSubredditContext();
    return postContext?.name || null;
}

async function ensureModeratorAnalyticsPostForSubreddit(
    subredditName: string,
): Promise<{ created: boolean; postUrl: string | null }> {
    const current = await readModAnalyticsPostRecord(subredditName);
    if (current?.postId) {
        try {
            const post = await reddit.getPostById(current.postId);
            const postUrl = typeof post?.url === 'string' && post.url.trim()
                ? post.url.trim()
                : current.postUrl;
            if (postUrl) {
                if (postUrl !== current.postUrl) {
                    await writeModAnalyticsPostRecord({
                        subredditName,
                        postId: current.postId,
                        postUrl,
                        updatedAt: new Date().toISOString(),
                    });
                }
                return { created: false, postUrl };
            }
        } catch (error) {
            console.error(`Stored moderator analytics post lookup failed for r/${subredditName}:`, error);
        }
    }

    const post = await submitModeratorAnalyticsPost(subredditName);
    const postId = typeof post.id === 'string' && post.id.startsWith('t3_')
        ? post.id as `t3_${string}`
        : null;
    const postUrl = typeof post.url === 'string' && post.url.trim()
        ? post.url.trim()
        : null;

    await writeModAnalyticsPostRecord({
        subredditName,
        postId,
        postUrl,
        updatedAt: new Date().toISOString(),
    });

    return {
        created: true,
        postUrl,
    };
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

/**
 * Member count for "rank out of N" and open leaderboard slots.
 * Use Reddit's public subscriber count; leaderboard entries remain the store fallback.
 */
async function getCommunityMemberTotalForLeaderboard(): Promise<number | undefined> {
    let subredditId = readContextSubredditId();
    let subredditName = readContextSubredditName();
    if (!subredditId && !subredditName) {
        const postSubreddit = await getPostSubredditContext();
        subredditId = postSubreddit?.id || null;
        subredditName = postSubreddit?.name || null;
    }
    return getCommunityMemberCount({ subredditId, subredditName });
}

app.get('/api/player/bootstrap', async (req, res) => {
    try {
        const { playerId, guestToken } = req.query ?? {};
        const payload = await getServerPlayerBootstrap({
            playerId: playerId as string,
            guestToken: guestToken as string,
            redditUsername: getRequestUsername(),
        });
        if (!payload.playerId) {
            sendPlayerAuthorizationFailure(res, { playerId, guestToken });
            return;
        }
        res.status(200).json(payload);
    } catch (error) {
        console.error('Failed to load Reddit Mini Racer player bootstrap:', error);
        res.status(500).json({ error: 'Player bootstrap failed' });
    }
});

app.post('/api/player/identity', async (req, res) => {
    try {
        const { playerId, guestToken, leaderboardIdentity } = req.body ?? {};
        const payload = await updateServerPlayerIdentity({
            playerId,
            guestToken,
            leaderboardIdentity,
            redditUsername: getRequestUsername(),
        });
        if (!payload.playerId) {
            sendPlayerAuthorizationFailure(res, { playerId, guestToken });
            return;
        }
        res.status(200).json(payload);
    } catch (error) {
        console.error('Failed to update Reddit Mini Racer player identity:', error);
        res.status(500).json({ error: 'Player identity update failed' });
    }
});

app.post('/api/player/preferences', async (req, res) => {
    try {
        const { playerId, guestToken, playerPreferences } = req.body ?? {};
        const payload = await updateServerPlayerPreferences({
            playerId,
            guestToken,
            playerPreferences,
            redditUsername: getRequestUsername(),
        });
        if (!payload.playerId) {
            sendPlayerAuthorizationFailure(res, { playerId, guestToken });
            return;
        }
        if (!payload.playerPreferences) {
            res.status(400).json({ error: 'Invalid player preferences' });
            return;
        }
        res.status(200).json(payload);
    } catch (error) {
        console.error('Failed to update Reddit Mini Racer player preferences:', error);
        res.status(500).json({ error: 'Player preferences update failed' });
    }
});

app.get('/api/scoreboard/snapshot', async (req, res) => {
    try {
        const { trackKey, playerId, guestToken, limit, offset } = req.query ?? {};
        const activeChallenge = await getServerDailyGpChallenge();
        const challenge = trackKey === activeChallenge.trackKey
            ? activeChallenge
            : (await getServerDailyGpPlaylist()).find((entry) => entry.trackKey === trackKey) || null;
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
                pageOffset: 0,
                pageLimit: 0,
                hasMore: false,
                nextOffset: null,
            });
            return;
        }

        const communityMemberTotal = await getCommunityMemberTotalForLeaderboard();
        const snapshot = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            playerId: playerId as string,
            guestToken: guestToken as string,
            redditUsername: getRequestUsername(),
            limit: limit ? parseInt(limit as string, 10) : undefined,
            offset: offset ? parseInt(offset as string, 10) : undefined,
            communityMemberTotal,
        });
        res.status(200).json(snapshot);
    } catch (error) {
        console.error('Failed to load Reddit Mini Racer scoreboard snapshot:', error);
        res.status(500).json({ error: 'Scoreboard snapshot failed' });
    }
});

app.get('/api/daily/active', async (_req, res) => {
    try {
        const postBound = await getPostBoundDailyGpChallenge();
        const challenge = postBound && isDailyGpChallengePlayable(postBound)
            ? postBound
            : await getServerDailyGpChallenge();
        res.status(200).json(challenge);
    } catch (error) {
        console.error('Failed to load Reddit Mini Racer active challenge:', error);
        res.status(500).json({ error: 'Active challenge lookup failed' });
    }
});

app.get('/api/daily/playlist', async (_req, res) => {
    try {
        res.status(200).json({
            challenges: await getServerDailyGpPlaylist(),
        });
    } catch (error) {
        console.error('Failed to load Reddit Mini Racer daily playlist:', error);
        res.status(500).json({ error: 'Daily playlist lookup failed' });
    }
});

app.get('/api/daily/snapshot', async (req, res) => {
    try {
        const { challengeId, playerId, guestToken, limit, offset } = req.query ?? {};
        const communityMemberTotal = await getCommunityMemberTotalForLeaderboard();
        const snapshot = await getServerDailyGpSnapshot({
            challengeId: challengeId as string,
            playerId: playerId as string,
            guestToken: guestToken as string,
            redditUsername: getRequestUsername(),
            limit: limit ? parseInt(limit as string, 10) : undefined,
            offset: offset ? parseInt(offset as string, 10) : undefined,
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

async function getDailyGpShareRequestContext() {
    const subredditName = readContextSubredditName();
    const subscription = subredditName
        ? await readDailyAutopostSubscription(subredditName)
        : null;
    return {
        username: getRequestUsername(),
        subredditName,
        appSlug: getRequestAppSlug(),
        preferredPostUrl: subscription?.lastPostUrl ?? null,
    };
}

app.post('/api/daily/share/preview', async (req, res) => {
    try {
        const result = await previewDailyGpShare(
            req.body ?? {},
            await getDailyGpShareRequestContext(),
        );
        res.status(result.status).json(result.body);
    } catch (error) {
        console.error('Failed to preview Reddit Mini Racer result share:', error);
        res.status(500).json({ status: 'share_failed', error: 'Could not prepare this result for sharing.' });
    }
});

app.post('/api/daily/share/confirm', async (req, res) => {
    try {
        const result = await confirmDailyGpShare(
            req.body ?? {},
            await getDailyGpShareRequestContext(),
        );
        res.status(result.status).json(result.body);
    } catch (error) {
        console.error('Failed to share Reddit Mini Racer result:', error);
        res.status(500).json({ status: 'share_failed', error: 'Could not share this result.' });
    }
});

app.post('/api/analytics/event', async (req, res) => {
    try {
        const result = await submitServerAnalyticsEvent({
            ...(req.body ?? {}),
            context: {
                redditUsername: getRequestUsername(),
                postId: readContextPostId(),
                subredditName: readContextSubredditName(),
            },
        });
        res.status(result.accepted ? 200 : 400).json(result);
    } catch (error) {
        console.error('Failed to record Reddit Mini Racer analytics event:', error);
        res.status(500).json({ accepted: false, error: 'Analytics event failed' });
    }
});

app.options('/api/analytics/summary', (_req, res) => {
    setAnalyticsCorsHeaders(res);
    res.status(204).end();
});

app.get('/api/analytics/summary', async (req, res) => {
    try {
        setAnalyticsCorsHeaders(res);
        const subredditName = await resolveAnalyticsToolSubredditName();
        if (!subredditName) {
            res.status(400).json({ error: 'Missing subreddit context for analytics.' });
            return;
        }

        await assertModeratorForSubreddit(subredditName);
        const { from, to, range } = req.query ?? {};
        const summary = await getServerAnalyticsSummary({ from, to, range });
        res.status(200).json(summary);
    } catch (error) {
        console.error('Failed to load Reddit Mini Racer analytics summary:', error);
        const message = error instanceof Error ? error.message : 'Analytics summary failed';
        const status = message.includes('Moderator access required') ? 403 : 500;
        res.status(status).json({ error: message });
    }
});

type MenuActionOptions = {
    missingContextMessage: string;
    failureLogMessage: string;
    failureToastPrefix: string;
};

type MenuActionHandler = (
    subredditName: string,
    res: express.Response,
) => Promise<void>;

function createMenuToast(text: string, appearance: 'neutral' | 'success' = 'neutral') {
    return {
        showToast: {
            text,
            appearance,
        },
    };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : 'Unknown error';
}

function registerMenuAction(
    path: string,
    options: MenuActionOptions,
    handler: MenuActionHandler,
): void {
    app.post(path, async (req, res) => {
        try {
            const input = (req.body ?? {}) as Partial<MenuItemRequest>;
            const targetId = typeof input.targetId === 'string' ? input.targetId : '';
            const subredditName = await resolveMenuTargetSubredditName(targetId);

            if (!subredditName) {
                res.json(createMenuToast(options.missingContextMessage));
                return;
            }

            await handler(subredditName, res);
        } catch (error) {
            console.error(options.failureLogMessage, error);
            res.json(createMenuToast(
                `${options.failureToastPrefix}: ${getErrorMessage(error)}`,
            ));
        }
    });
}

registerMenuAction(
    '/internal/menu/post-create',
    {
        missingContextMessage: 'Reddit did not provide a subreddit context for this install.',
        failureLogMessage: 'Failed to create Mini Racer post:',
        failureToastPrefix: 'Could not create the Mini Racer post',
    },
    async (subredditName, res) => {
        const challenge = await getServerDailyGpChallenge();
        const result = await ensureDailyMiniRacerPostForSubreddit(subredditName, challenge);

        res.json({
            navigateTo: result.postUrl,
        });
    },
);

registerMenuAction(
    '/internal/menu/post-enable-daily',
    {
        missingContextMessage: 'Reddit did not provide a subreddit context for this install.',
        failureLogMessage: 'Failed to enable daily Mini Racer posts:',
        failureToastPrefix: 'Could not enable daily Mini Racer posts',
    },
    async (subredditName, res) => {
        await upsertDailyAutopostSubscription(subredditName, (previous) => ({
            subredditName,
            enabled: true,
            enabledAt: previous?.enabledAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastPostedChallengeId: previous?.lastPostedChallengeId ?? null,
            lastPostedAt: previous?.lastPostedAt ?? null,
            lastPostUrl: previous?.lastPostUrl ?? null,
        }));

        const challenge = await getServerDailyGpChallenge();
        const result = await ensureDailyMiniRacerPostForSubreddit(subredditName, challenge);

        res.json({
            showToast: {
                text: result.created
                    ? `Daily Mini Racer posts enabled for r/${subredditName}. Today's post is live.`
                    : `Daily Mini Racer posts enabled for r/${subredditName}. Today's post already exists.`,
                appearance: 'success',
            },
            ...(result.created && result.postUrl ? { navigateTo: result.postUrl } : {}),
        });
    },
);

registerMenuAction(
    '/internal/menu/post-disable-daily',
    {
        missingContextMessage: 'Reddit did not provide a subreddit context for this install.',
        failureLogMessage: 'Failed to disable daily Mini Racer posts:',
        failureToastPrefix: 'Could not disable daily Mini Racer posts',
    },
    async (subredditName, res) => {
        await deleteDailyAutopostSubscription(subredditName);
        res.json(createMenuToast(
            `Daily Mini Racer posts disabled for r/${subredditName}.`,
            'success',
        ));
    },
);

registerMenuAction(
    '/internal/menu/mod-analytics-open',
    {
        missingContextMessage: 'Reddit did not provide a subreddit context for this tool.',
        failureLogMessage: 'Failed to open moderator analytics tool:',
        failureToastPrefix: 'Could not open Mini Racer analytics',
    },
    async (subredditName, res) => {
        await assertModeratorForSubreddit(subredditName);
        const result = await ensureModeratorAnalyticsPostForSubreddit(subredditName);

        if (!result.postUrl) {
            res.json({
                showToast: {
                    text: `Mini Racer analytics could not open for r/${subredditName}.`,
                    appearance: 'neutral',
                },
            });
            return;
        }

        res.json({
            showToast: {
                text: result.created
                    ? `Mini Racer analytics is ready for r/${subredditName}.`
                    : `Opening Mini Racer analytics for r/${subredditName}.`,
                appearance: 'success',
            },
            navigateTo: result.postUrl,
        });
    },
);

app.post('/internal/scheduler/daily-posts', async (_req, res) => {
    try {
        const challenge = await getServerDailyGpChallenge();
        const subscriptions = await readAllDailyAutopostSubscriptions();
        let createdCount = 0;

        for (const subscription of subscriptions) {
            if (!subscription.enabled) {
                continue;
            }

            try {
                const result = await ensureDailyMiniRacerPostForSubreddit(
                    subscription.subredditName,
                    challenge,
                );
                if (result.created) {
                    createdCount += 1;
                }
            } catch (error) {
                console.error(
                    `Failed scheduled Mini Racer post for r/${subscription.subredditName}:`,
                    error,
                );
            }
        }

        res.status(200).json({
            ok: true,
            challengeId: challenge.id,
            createdCount,
        });
    } catch (error) {
        console.error('Failed scheduled Mini Racer daily post run:', error);
        res.status(500).json({ ok: false, error: 'Scheduled daily post run failed' });
    }
});

createServer(app).listen(getServerPort());
