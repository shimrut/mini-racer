import { redis } from '@devvit/redis';
import { context } from '@devvit/web/server';
import { getTrackName } from '../../../game/track/catalog.js';
import { HEAD_TO_HEAD_POST_TYPE } from '../head-to-head/head-to-head-model.js';
import {
    getRequestAnalyticsViewerIdentity,
    getRequestUserId,
    readContextPostData,
    readContextPostId,
    readContextSubredditName,
} from '../request/request-context.js';
import { playerFieldHash, redisKeyPart } from '../redis/redis-names.js';
import { loadStoredTracks } from '../tracks/stored-catalog.js';
import { TRACK_KEY_RE } from '../tracks/track-store.js';
import { migrateLegacyChallengeAnalytics } from './challenge-analytics-migration.js';

const LEGACY_PREFIX = 'miniracer:challenge-analytics:v1';
const PREFIX = 'miniracer:challenge-analytics:v2';
const DAY_MS = 24 * 60 * 60 * 1000;
export const CHALLENGE_ANALYTICS_PAGE_SIZE = 25;
// The page sorts every indexed track by views, so it reads them all; the
// catalog has a few hundred tracks at most.
const MAX_INDEXED_TRACKS = 5_000;
const VIEW_READ_BATCH = 100;

export type ChallengeAnalyticsPeriod = 'today' | 'lifetime';
export const CHALLENGE_TRACK_ANALYTICS_DAILY_RETENTION_DAYS = 2;

export type ChallengeAnalyticsMetrics = {
    views: number;
    uniqueViewers: number;
    clicks: number;
    acceptClicks: number;
    ownOpens: number;
};

export type ChallengeAnalyticsRow = {
    trackKey: string;
    trackName: string;
    trackingStartedAt: string | null;
    today: ChallengeAnalyticsMetrics;
    lifetime: ChallengeAnalyticsMetrics;
};

// Keep the previous per-post families intact for an explicit migration.
export function challengeAnalyticsCountsKey(subredditName: string): string {
    return `${LEGACY_PREFIX}:${redisKeyPart(subredditName)}:counts`;
}

export function challengeAnalyticsViewersKey(subredditName: string, postId: string): string {
    return `${LEGACY_PREFIX}:${redisKeyPart(subredditName)}:${redisKeyPart(postId)}:viewers`;
}

export function challengeAnalyticsCounterFields(postId: string) {
    return { views: `views:${postId}`, clicks: `clicks:${postId}`, trackingStartedAt: `started:${postId}` };
}

export function challengeTrackAnalyticsIndexKey(subredditName: string): string {
    return `${PREFIX}:${redisKeyPart(subredditName)}:tracks`;
}

export function challengeTrackAnalyticsCountsKey(subredditName: string, date: string | null = null): string {
    return `${PREFIX}:${redisKeyPart(subredditName)}:${date ? `d:${date}` : 'lifetime'}:counts`;
}

export function challengeTrackAnalyticsViewersKey(subredditName: string, trackKey: string, date: string | null = null): string {
    return `${PREFIX}:${redisKeyPart(subredditName)}:${date ? `d:${date}` : 'lifetime'}:${redisKeyPart(trackKey)}:viewers`;
}

export function challengeTrackAnalyticsCounterFields(trackKey: string) {
    return {
        views: `views:${trackKey}`,
        acceptClicks: `accept-clicks:${trackKey}`,
        ownOpens: `own-opens:${trackKey}`,
        trackingStartedAt: `started:${trackKey}`,
    };
}

export function challengeTrackAnalyticsDayExpiry(date: string): Date {
    return new Date(Date.parse(`${date}T00:00:00.000Z`) + CHALLENGE_TRACK_ANALYTICS_DAILY_RETENTION_DAYS * DAY_MS);
}

export function challengeTrackAnalyticsRetentionDates(now: Date): string[] {
    return Array.from({ length: CHALLENGE_TRACK_ANALYTICS_DAILY_RETENTION_DAYS }, (_unused, index) => (
        new Date(now.getTime() - index * DAY_MS).toISOString().slice(0, 10)
    ));
}

function isOwnChallenge(postData: Record<string, unknown>): boolean {
    const userId = getRequestUserId();
    if (!userId) return false;
    const storedId = typeof postData.challengerUserId === 'string' && postData.challengerUserId.startsWith('t2_')
        ? postData.challengerUserId
        : null;
    const postAuthorId = (context as { postAuthorId?: unknown }).postAuthorId;
    return userId === (storedId || postAuthorId);
}

export async function recordChallengeAnalyticsEvent(
    { action }: { action: unknown },
    { now = () => new Date() }: { now?: () => Date } = {},
): Promise<void> {
    if (action !== 'view' && action !== 'click' && action !== 'own_open') return;
    const subredditName = readContextSubredditName();
    const postData = readContextPostData();
    const trackKey = postData?.trackKey;
    if (!subredditName || !readContextPostId() || postData?.postType !== HEAD_TO_HEAD_POST_TYPE
        || typeof postData.challengeId !== 'string' || !postData.challengeId.trim()
        || typeof trackKey !== 'string' || !TRACK_KEY_RE.test(trackKey)) {
        return;
    }
    const ownChallenge = isOwnChallenge(postData);
    if (action === 'own_open' && !ownChallenge) return;
    const eventTime = now();
    const date = eventTime.toISOString().slice(0, 10);
    const fields = challengeTrackAnalyticsCounterFields(trackKey);
    const field = action === 'view' ? fields.views : ownChallenge ? fields.ownOpens : fields.acceptClicks;
    const lifetimeKey = challengeTrackAnalyticsCountsKey(subredditName);
    const dailyKey = challengeTrackAnalyticsCountsKey(subredditName, date);
    const identity = action === 'view' ? getRequestAnalyticsViewerIdentity() : null;
    const viewerField = identity ? playerFieldHash(identity) : null;

    // Lifetime includes Today as events arrive. Write totals before membership;
    // uniques are exact hash lengths, never sums of per-post or per-day counts.
    await redis.hIncrBy(lifetimeKey, field, 1);
    await redis.hSetNX(lifetimeKey, fields.trackingStartedAt, eventTime.toISOString());
    // Equal scores give a stable alphabetical track order without a catalog read.
    await redis.zAdd(challengeTrackAnalyticsIndexKey(subredditName), { member: trackKey, score: 0 });
    if (viewerField) {
        await redis.hSetNX(challengeTrackAnalyticsViewersKey(subredditName, trackKey), viewerField, '1');
    }
    await redis.hIncrBy(dailyKey, field, 1);
    const dailyViewersKey = challengeTrackAnalyticsViewersKey(subredditName, trackKey, date);
    if (viewerField) await redis.hSetNX(dailyViewersKey, viewerField, '1');
    const expireDaily = async (key: string) => {
        // Later events use the same absolute deadline, rather than extending TTL.
        const ttl = Math.max(1, Math.ceil((challengeTrackAnalyticsDayExpiry(date).getTime() - now().getTime()) / 1000));
        await redis.expire(key, ttl);
    };
    await Promise.all([expireDaily(dailyKey), ...(viewerField ? [expireDaily(dailyViewersKey)] : [])]);
}

function count(value: unknown): number {
    const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : 0;
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function metrics(values: (string | null)[], uniqueViewers: number): ChallengeAnalyticsMetrics {
    const acceptClicks = count(values[1]);
    const ownOpens = count(values[2]);
    return { views: count(values[0]), uniqueViewers: count(uniqueViewers), clicks: acceptClicks + ownOpens, acceptClicks, ownOpens };
}

async function readViewCounts(key: string, fields: readonly string[]): Promise<number[]> {
    const counts: number[] = [];
    for (let index = 0; index < fields.length; index += VIEW_READ_BATCH) {
        const values = await redis.hMGet(key, fields.slice(index, index + VIEW_READ_BATCH));
        counts.push(...values.map(count));
    }
    return counts;
}

// Most viewed first in the chosen period. Ties go to the other period, then
// to the track key, so the order is stable from page to page.
async function rankTracksByViews(
    subredditName: string,
    date: string,
    period: ChallengeAnalyticsPeriod,
): Promise<string[]> {
    const indexed = (await redis.zRange(
        challengeTrackAnalyticsIndexKey(subredditName),
        0,
        MAX_INDEXED_TRACKS - 1,
        { by: 'rank' },
    )).map(({ member }) => member).filter((key) => TRACK_KEY_RE.test(key));
    if (!indexed.length) return [];
    const viewFields = indexed.map((trackKey) => challengeTrackAnalyticsCounterFields(trackKey).views);
    const [todayViews, lifetimeViews] = await Promise.all([
        readViewCounts(challengeTrackAnalyticsCountsKey(subredditName, date), viewFields),
        readViewCounts(challengeTrackAnalyticsCountsKey(subredditName), viewFields),
    ]);
    return indexed
        .map((trackKey, index) => ({
            trackKey,
            first: period === 'today' ? todayViews[index] : lifetimeViews[index],
            second: period === 'today' ? lifetimeViews[index] : todayViews[index],
        }))
        .sort((a, b) => b.first - a.first || b.second - a.second || a.trackKey.localeCompare(b.trackKey))
        .map(({ trackKey }) => trackKey);
}

export async function getChallengeAnalyticsPage(
    subredditName: string,
    offset: number,
    { now = new Date(), period = 'today' }: { now?: Date; period?: ChallengeAnalyticsPeriod } = {},
): Promise<{ date: string; period: ChallengeAnalyticsPeriod; items: ChallengeAnalyticsRow[]; nextOffset: number | null }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - CHALLENGE_ANALYTICS_PAGE_SIZE) {
        throw new Error('Invalid challenge analytics offset.');
    }
    const date = now.toISOString().slice(0, 10);
    await migrateLegacyChallengeAnalytics(subredditName);
    const ranked = await rankTracksByViews(subredditName, date, period);
    const tracks = ranked.slice(offset, offset + CHALLENGE_ANALYTICS_PAGE_SIZE);
    const nextOffset = offset + CHALLENGE_ANALYTICS_PAGE_SIZE < ranked.length
        ? offset + CHALLENGE_ANALYTICS_PAGE_SIZE
        : null;
    if (!tracks.length) return { date, period, items: [], nextOffset };
    // The middleware loads the index, not these stored track records.
    await loadStoredTracks(tracks);
    const fields = tracks.map((trackKey) => challengeTrackAnalyticsCounterFields(trackKey));
    // Read daily membership before lifetime membership, then both totals. A
    // concurrent view cannot make displayed uniques exceed their own totals.
    const dailyUniques = await Promise.all(tracks.map((key) => redis.hLen(challengeTrackAnalyticsViewersKey(subredditName, key, date))));
    const lifetimeUniques = await Promise.all(tracks.map((key) => redis.hLen(challengeTrackAnalyticsViewersKey(subredditName, key))));
    const daily = await redis.hMGet(challengeTrackAnalyticsCountsKey(subredditName, date), fields.flatMap((field) => [field.views, field.acceptClicks, field.ownOpens]));
    // Lifetime writes precede daily writes; read Lifetime last to include the
    // Today values in this response even when new events arrive between reads.
    const lifetime = await redis.hMGet(challengeTrackAnalyticsCountsKey(subredditName), fields.flatMap((field) => [field.views, field.acceptClicks, field.ownOpens, field.trackingStartedAt]));
    return {
        date,
        period,
        items: tracks.map((trackKey, index) => {
            const startedAt = lifetime[index * 4 + 3];
            return {
                trackKey,
                trackName: getTrackName(trackKey, trackKey),
                trackingStartedAt: startedAt && Number.isFinite(Date.parse(startedAt)) ? startedAt : null,
                today: metrics(daily.slice(index * 3, index * 3 + 3), dailyUniques[index]),
                lifetime: metrics(lifetime.slice(index * 4, index * 4 + 3), lifetimeUniques[index]),
            };
        }),
        nextOffset,
    };
}
