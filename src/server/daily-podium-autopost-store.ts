import { redis } from '@devvit/web/server';

const DAILY_PODIUM_AUTOPOST_SUBREDDITS_KEY = 'dailygp:podium-autopost:subreddits';

export type DailyPodiumAutopostSubscription = {
    subredditName: string;
    enabled: boolean;
    enabledAt: string | null;
    updatedAt: string;
    lastPostedChallengeId: string | null;
    lastPostedAt: string | null;
    lastPostUrl: string | null;
};

export function parseDailyPodiumAutopostSubscription(
    subredditName: string,
    raw: string | null | undefined,
): DailyPodiumAutopostSubscription | null {
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;

        return {
            subredditName,
            enabled: parsed.enabled !== false,
            enabledAt: typeof parsed.enabledAt === 'string' && parsed.enabledAt
                ? parsed.enabledAt
                : null,
            updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt
                ? parsed.updatedAt
                : new Date(0).toISOString(),
            lastPostedChallengeId: typeof parsed.lastPostedChallengeId === 'string'
                && parsed.lastPostedChallengeId
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

export async function readDailyPodiumAutopostSubscription(
    subredditName: string,
): Promise<DailyPodiumAutopostSubscription | null> {
    const raw = await redis.hGet(DAILY_PODIUM_AUTOPOST_SUBREDDITS_KEY, subredditName);
    return parseDailyPodiumAutopostSubscription(subredditName, raw);
}

export async function readAllDailyPodiumAutopostSubscriptions(): Promise<
    DailyPodiumAutopostSubscription[]
> {
    const rawMap = await redis.hGetAll(DAILY_PODIUM_AUTOPOST_SUBREDDITS_KEY);
    return Object.entries(rawMap)
        .map(([subredditName, raw]) => parseDailyPodiumAutopostSubscription(subredditName, raw))
        .filter((entry): entry is DailyPodiumAutopostSubscription => Boolean(entry));
}

export async function writeDailyPodiumAutopostSubscription(
    subscription: DailyPodiumAutopostSubscription,
): Promise<void> {
    await redis.hSet(DAILY_PODIUM_AUTOPOST_SUBREDDITS_KEY, {
        [subscription.subredditName]: JSON.stringify(subscription),
    });
}

export async function deleteDailyPodiumAutopostSubscription(
    subredditName: string,
): Promise<void> {
    await redis.hDel(DAILY_PODIUM_AUTOPOST_SUBREDDITS_KEY, [subredditName]);
}

export async function upsertDailyPodiumAutopostSubscription(
    subredditName: string,
    updater: (
        previous: DailyPodiumAutopostSubscription | null,
    ) => DailyPodiumAutopostSubscription,
): Promise<DailyPodiumAutopostSubscription> {
    const previous = await readDailyPodiumAutopostSubscription(subredditName);
    const next = updater(previous);
    await writeDailyPodiumAutopostSubscription(next);
    return next;
}
