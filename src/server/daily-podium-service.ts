import { reddit } from '@devvit/web/server';
import type {
    DailyGpPodiumPostData,
    FinalDailyGpPodium,
    FinalDailyGpPodiumPosition,
} from './daily-podium-model.js';
import {
    readDailyPodiumAutopostSubscription,
    upsertDailyPodiumAutopostSubscription,
} from './daily-podium-autopost-store.js';
import {
    acquireDailyGpPodiumPostCreationLock,
    deleteDailyGpPodiumPendingSnapshot,
    readDailyGpPodiumPendingSnapshot,
    readDailyGpPodiumPostRecord,
    releaseDailyGpPodiumPostCreationLock,
    writeDailyGpPodiumPostRecordIfAbsent,
    writeDailyGpPodiumPendingSnapshot,
} from './daily-podium-post-store.js';
import { getRequestAppSlug } from './request-context.js';

const EMPTY_FINISH_LABEL = 'No verified finish';
const PODIUM_RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;
const SHORT_MONTH_NAMES = Object.freeze([
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

export type DailyPodiumPostResult = {
    created: boolean;
    postUrl: string | null;
};

export function getDailyGpPodiumPublicationDeadline(podium: FinalDailyGpPodium): Date | null {
    const challengeStartMs = Date.parse(`${podium.challengeDate}T00:00:00.000Z`);
    if (!Number.isFinite(challengeStartMs)) return null;
    return new Date(challengeStartMs + (7 * 24 * 60 * 60 * 1000) + PODIUM_RETRY_WINDOW_MS);
}

export function isDailyGpPodiumPublicationOpen(
    podium: FinalDailyGpPodium,
    now = new Date(Date.now()),
): boolean {
    const deadline = getDailyGpPodiumPublicationDeadline(podium);
    const availableUntilMs = deadline ? deadline.getTime() - PODIUM_RETRY_WINDOW_MS : Number.NaN;
    return Boolean(
        deadline
        && availableUntilMs <= now.getTime()
        && now.getTime() < deadline.getTime()
    );
}

function normalizeName(value: string): string {
    return value.trim().toLowerCase();
}

function formatChallengeDate(value: string, includeYear = false): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return value;

    const [, year, monthText, dayText] = match;
    const monthName = SHORT_MONTH_NAMES[Number(monthText) - 1];
    const day = Number(dayText);
    if (!monthName || day < 1 || day > 31) return value;
    return `${day} ${monthName}${includeYear ? ` ${year}` : ''}`;
}

function emptyPosition(rank: 1 | 2 | 3): FinalDailyGpPodiumPosition {
    return {
        rank,
        displayName: EMPTY_FINISH_LABEL,
        identityType: 'empty',
        formattedTime: null,
    };
}

export function isRedditAvatarUrl(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();
        return url.protocol === 'https:' && (
            hostname === 'redd.it'
            || hostname.endsWith('.redd.it')
            || hostname === 'redditmedia.com'
            || hostname.endsWith('.redditmedia.com')
            || hostname === 'redditstatic.com'
            || hostname.endsWith('.redditstatic.com')
        );
    } catch {
        return false;
    }
}

function sanitizePosition(
    position: FinalDailyGpPodiumPosition | undefined,
    rank: 1 | 2 | 3,
): FinalDailyGpPodiumPosition {
    const identityType = position?.identityType;
    const displayName = position?.displayName?.trim();
    const formattedTime = position?.formattedTime?.trim();
    if (
        (identityType !== 'reddit' && identityType !== 'private')
        || !displayName
        || !formattedTime
    ) {
        return emptyPosition(rank);
    }

    return {
        rank,
        displayName,
        identityType,
        formattedTime,
    };
}

export function sanitizeDailyGpPodiumForPost(
    podium: FinalDailyGpPodium,
): DailyGpPodiumPostData {
    const positions = [
        sanitizePosition(podium.positions[0], 1),
        sanitizePosition(podium.positions[1], 2),
        sanitizePosition(podium.positions[2], 3),
    ] as const;
    return {
        challengeId: podium.challengeId,
        challengeDate: podium.challengeDate,
        trackName: podium.trackName,
        positions: positions.map((position) => ({
            ...position,
            avatarUrl: null,
        })) as DailyGpPodiumPostData['positions'],
    };
}

export async function resolveRedditAvatarUrl(displayName: string): Promise<string | null> {
    const username = displayName.replace(/^u\//i, '');
    try {
        const avatarUrl = await reddit.getSnoovatarUrl(username);
        return isRedditAvatarUrl(avatarUrl) ? avatarUrl : null;
    } catch {
        return null;
    }
}

export async function resolveDailyGpPodiumAvatarsForPost(
    podium: DailyGpPodiumPostData,
): Promise<DailyGpPodiumPostData> {
    const positions = await Promise.all(podium.positions.map(async (position) => ({
        ...position,
        avatarUrl: position.identityType === 'reddit'
            ? await resolveRedditAvatarUrl(position.displayName)
            : null,
    })));
    return {
        ...podium,
        positions: positions as unknown as DailyGpPodiumPostData['positions'],
    };
}

function formatPodiumDisplayName(position: FinalDailyGpPodiumPosition): string {
    if (position.identityType !== 'reddit') return position.displayName;
    return position.displayName.replace(/^u\//i, '');
}

export function formatDailyMiniRacerPodiumTitle(podium: DailyGpPodiumPostData): string {
    return `Mini Racer Podium, ${formatChallengeDate(podium.challengeDate)}: ${podium.trackName}`;
}

export function formatDailyMiniRacerPodiumTextFallback(
    podium: DailyGpPodiumPostData,
): string {
    const medalLabels = ['Gold', 'Silver', 'Bronze'];
    return [
        '# Mini Racer Final Podium',
        '',
        `Track: **${podium.trackName}**`,
        `Date: ${formatChallengeDate(podium.challengeDate, true)}`,
        '',
        ...podium.positions.map((position, index) => {
            const time = position.formattedTime ? ` - ${position.formattedTime}` : '';
            return `${index + 1}. ${medalLabels[index]} - ${formatPodiumDisplayName(position)}${time}`;
        }),
        '',
        'These are the final verified results after the track left the seven-day playable window.',
    ].join('\n');
}

export async function enableDailyPodiumAutopost(subredditName: string): Promise<void> {
    const now = new Date().toISOString();
    await upsertDailyPodiumAutopostSubscription(subredditName, (previous) => ({
        subredditName,
        enabled: true,
        enabledAt: previous?.enabledAt || now,
        updatedAt: now,
        lastPostedChallengeId: previous?.lastPostedChallengeId ?? null,
        lastPostedAt: previous?.lastPostedAt ?? null,
        lastPostUrl: previous?.lastPostUrl ?? null,
    }));
}

async function updatePodiumSubscription(
    subredditName: string,
    challengeId: string,
    postUrl: string,
    postedAt: string,
): Promise<void> {
    await upsertDailyPodiumAutopostSubscription(subredditName, (previous) => ({
        subredditName,
        enabled: previous?.enabled ?? false,
        enabledAt: previous?.enabledAt ?? null,
        updatedAt: new Date().toISOString(),
        lastPostedChallengeId: challengeId,
        lastPostedAt: previous?.lastPostedChallengeId === challengeId
            ? previous.lastPostedAt ?? postedAt
            : postedAt,
        lastPostUrl: postUrl,
    }));
}

async function registerDailyGpPodiumPost({
    subredditName,
    challengeId,
    postId,
    postUrl,
}: {
    subredditName: string;
    challengeId: string;
    postId: `t3_${string}`;
    postUrl: string;
}) {
    const existing = await readDailyGpPodiumPostRecord(subredditName, challengeId);
    if (existing) {
        return existing;
    }
    const record = {
        subredditName,
        challengeId,
        postId,
        postUrl,
        createdAt: new Date().toISOString(),
    };
    const wrote = await writeDailyGpPodiumPostRecordIfAbsent(record);
    if (wrote) {
        return record;
    }
    const winner = await readDailyGpPodiumPostRecord(subredditName, challengeId);
    if (!winner) {
        throw new Error('Daily Mini Racer podium post registry race left no canonical record.');
    }
    return winner;
}

async function recoverDailyGpPodiumPost({
    subredditName,
    challengeId,
    appSlug,
    preferredPostUrl,
}: {
    subredditName: string;
    challengeId: string;
    appSlug: string;
    preferredPostUrl: string | null;
}) {
    const listing = await (reddit as any).getPostsByUser({
        username: appSlug,
        sort: 'new',
        timeframe: 'month',
        limit: 100,
        pageSize: 100,
    });
    const posts = typeof listing?.all === 'function' ? await listing.all() : [];
    const matches: any[] = [];
    for (const post of posts) {
        if (normalizeName(post?.subredditName || '') !== normalizeName(subredditName)) continue;
        try {
            const postData = await post.getPostData();
            if (
                postData?.postType === 'daily-podium'
                && postData?.challengeId === challengeId
            ) {
                matches.push(post);
            }
        } catch (_error) {
            // Ignore unrelated or unavailable posts while recovering the canonical podium.
        }
    }
    if (!matches.length) return null;
    const post = matches.find((candidate) => candidate?.url === preferredPostUrl) || matches[0];
    if (
        typeof post?.id !== 'string'
        || !post.id.startsWith('t3_')
        || typeof post?.url !== 'string'
        || !post.url
    ) {
        return null;
    }
    return registerDailyGpPodiumPost({
        subredditName,
        challengeId,
        postId: post.id,
        postUrl: post.url,
    });
}

export async function resolveDailyGpPodiumPostRecord({
    subredditName,
    challengeId,
    appSlug,
    preferredPostUrl = null,
}: {
    subredditName: string;
    challengeId: string;
    appSlug: string;
    preferredPostUrl?: string | null;
}) {
    const stored = await readDailyGpPodiumPostRecord(subredditName, challengeId);
    if (stored) {
        try {
            await reddit.getPostById(stored.postId);
            return stored;
        } catch (_error) {
            // Recover a matching app-authored podium when the stored record is stale.
        }
    }
    return recoverDailyGpPodiumPost({
        subredditName,
        challengeId,
        appSlug,
        preferredPostUrl,
    });
}

export async function ensureDailyMiniRacerPodiumPostForSubreddit(
    subredditName: string,
    finalPodium: FinalDailyGpPodium,
): Promise<DailyPodiumPostResult> {
    const subscription = await readDailyPodiumAutopostSubscription(subredditName);
    const deadline = getDailyGpPodiumPublicationDeadline(finalPodium);
    if (!deadline || !isDailyGpPodiumPublicationOpen(finalPodium)) {
        throw new Error('This Mini Racer podium publication window has closed.');
    }
    let storedSnapshot = await readDailyGpPodiumPendingSnapshot(
        subredditName,
        finalPodium.challengeId,
    );
    if (storedSnapshot && storedSnapshot.expiresAt !== deadline.toISOString()) {
        await deleteDailyGpPodiumPendingSnapshot(subredditName, finalPodium.challengeId);
        storedSnapshot = null;
    }
    const candidatePodium = sanitizeDailyGpPodiumForPost(finalPodium);
    if (!storedSnapshot) {
        await writeDailyGpPodiumPendingSnapshot({
            subredditName,
            challengeId: finalPodium.challengeId,
            expiresAt: deadline.toISOString(),
            podium: candidatePodium,
        });
        storedSnapshot = await readDailyGpPodiumPendingSnapshot(
            subredditName,
            finalPodium.challengeId,
        );
    }
    const frozenPodium = storedSnapshot?.expiresAt === deadline.toISOString()
        ? storedSnapshot.podium
        : candidatePodium;
    const appSlug = getRequestAppSlug();
    if (!appSlug) {
        throw new Error('Reddit did not provide the Mini Racer app identity.');
    }
    const existing = await resolveDailyGpPodiumPostRecord({
        subredditName,
        challengeId: finalPodium.challengeId,
        appSlug,
        preferredPostUrl: subscription?.lastPostedChallengeId === finalPodium.challengeId
            ? subscription.lastPostUrl
            : null,
    });
    if (existing) {
        await deleteDailyGpPodiumPendingSnapshot(subredditName, finalPodium.challengeId);
        await updatePodiumSubscription(
            subredditName,
            finalPodium.challengeId,
            existing.postUrl,
            existing.createdAt,
        );
        return { created: false, postUrl: existing.postUrl };
    }

    const lock = await acquireDailyGpPodiumPostCreationLock(
        subredditName,
        finalPodium.challengeId,
    );
    if (!lock) {
        const raced = await resolveDailyGpPodiumPostRecord({
            subredditName,
            challengeId: finalPodium.challengeId,
            appSlug,
        });
        if (raced) {
            await deleteDailyGpPodiumPendingSnapshot(subredditName, finalPodium.challengeId);
            await updatePodiumSubscription(
                subredditName,
                finalPodium.challengeId,
                raced.postUrl,
                raced.createdAt,
            );
            return { created: false, postUrl: raced.postUrl };
        }
        throw new Error('This Mini Racer podium post is already being created.');
    }

    try {
        const raced = await resolveDailyGpPodiumPostRecord({
            subredditName,
            challengeId: finalPodium.challengeId,
            appSlug,
        });
        if (raced) {
            await deleteDailyGpPodiumPendingSnapshot(subredditName, finalPodium.challengeId);
            await updatePodiumSubscription(
                subredditName,
                finalPodium.challengeId,
                raced.postUrl,
                raced.createdAt,
            );
            return { created: false, postUrl: raced.postUrl };
        }

        if (!isDailyGpPodiumPublicationOpen(finalPodium)) {
            throw new Error('This Mini Racer podium publication window has closed.');
        }
        const podium = await resolveDailyGpPodiumAvatarsForPost(frozenPodium);
        if (!isDailyGpPodiumPublicationOpen(finalPodium)) {
            throw new Error('This Mini Racer podium publication window has closed.');
        }
        const post = await reddit.submitCustomPost({
            subredditName,
            title: formatDailyMiniRacerPodiumTitle(podium),
            entry: 'podium',
            postData: {
                postType: 'daily-podium',
                challengeId: podium.challengeId,
                podium,
            },
            textFallback: {
                text: formatDailyMiniRacerPodiumTextFallback(podium),
            },
        });
        if (
            typeof post.id !== 'string'
            || !post.id.startsWith('t3_')
            || typeof post.url !== 'string'
            || !post.url
        ) {
            throw new Error('Reddit did not return the podium post identity.');
        }

        const record = await registerDailyGpPodiumPost({
            subredditName,
            challengeId: finalPodium.challengeId,
            postId: post.id as `t3_${string}`,
            postUrl: post.url,
        });
        await updatePodiumSubscription(
            subredditName,
            finalPodium.challengeId,
            post.url,
            record.createdAt,
        );
        await deleteDailyGpPodiumPendingSnapshot(subredditName, finalPodium.challengeId);
        return { created: true, postUrl: post.url };
    } finally {
        await releaseDailyGpPodiumPostCreationLock(lock);
    }
}
