import { redis } from '@devvit/web/server';

const DAILY_AUTPOST_SUBREDDITS_KEY = 'dailygp:autopost:subreddits';

export type DailyAutopostSubscription = {
    subredditName: string;
    enabled: boolean;
    enabledAt: string | null;
    updatedAt: string;
    lastPostedChallengeId: string | null;
    lastPostedAt: string | null;
    lastPostUrl: string | null;
};

export function parseDailyAutopostSubscription(
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

export async function readDailyAutopostSubscription(
    subredditName: string,
): Promise<DailyAutopostSubscription | null> {
    const raw = await redis.hGet(DAILY_AUTPOST_SUBREDDITS_KEY, subredditName);
    return parseDailyAutopostSubscription(subredditName, raw);
}

export async function readAllDailyAutopostSubscriptions(): Promise<DailyAutopostSubscription[]> {
    const rawMap = await redis.hGetAll(DAILY_AUTPOST_SUBREDDITS_KEY);
    return Object.entries(rawMap)
        .map(([subredditName, raw]) => parseDailyAutopostSubscription(subredditName, raw))
        .filter((entry): entry is DailyAutopostSubscription => Boolean(entry));
}

export async function writeDailyAutopostSubscription(
    subscription: DailyAutopostSubscription,
): Promise<void> {
    await redis.hSet(
        DAILY_AUTPOST_SUBREDDITS_KEY,
        { [subscription.subredditName]: JSON.stringify(subscription) },
    );
}

export async function deleteDailyAutopostSubscription(subredditName: string): Promise<void> {
    await redis.hDel(DAILY_AUTPOST_SUBREDDITS_KEY, [subredditName]);
}

export async function upsertDailyAutopostSubscription(
    subredditName: string,
    updater: (previous: DailyAutopostSubscription | null) => DailyAutopostSubscription,
): Promise<DailyAutopostSubscription> {
    const previous = await readDailyAutopostSubscription(subredditName);
    const next = updater(previous);
    await writeDailyAutopostSubscription(next);
    return next;
}
