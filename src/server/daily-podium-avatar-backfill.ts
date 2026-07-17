import { redis } from '@devvit/web/server';
import { resolveRedditAvatarUrl } from './daily-podium-service.js';

const BACKFILL_CACHE_MS = 24 * 60 * 60 * 1000;

export type DailyGpPodiumAvatarPosition = {
    rank: 1 | 2 | 3;
    avatarUrl: string | null;
};

function createCacheKey(postId: string): string {
    return `dailygp:podium-avatar-backfill:v2:${postId}`;
}

function parseCachedPositions(value: string | undefined): DailyGpPodiumAvatarPosition[] | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed?.positions)) return null;
        return parsed.positions.filter((position: unknown): position is DailyGpPodiumAvatarPosition => {
            if (!position || typeof position !== 'object') return false;
            const candidate = position as Record<string, unknown>;
            return (candidate.rank === 1 || candidate.rank === 2 || candidate.rank === 3)
                && (candidate.avatarUrl === null || typeof candidate.avatarUrl === 'string');
        });
    } catch {
        return null;
    }
}

export async function resolveLegacyDailyGpPodiumAvatars(
    postId: string,
    podium: unknown,
): Promise<DailyGpPodiumAvatarPosition[]> {
    const key = createCacheKey(postId);
    const cached = parseCachedPositions(await redis.get(key));
    if (cached) return cached;

    const positions = podium && typeof podium === 'object'
        && Array.isArray((podium as Record<string, unknown>).positions)
        ? (podium as { positions: unknown[] }).positions
        : [];
    const resolved = await Promise.all(positions.map(async (position) => {
        if (!position || typeof position !== 'object') return null;
        const candidate = position as Record<string, unknown>;
        const rank = candidate.rank;
        const displayName = candidate.displayName;
        if (
            (rank !== 1 && rank !== 2 && rank !== 3)
            || candidate.identityType !== 'reddit'
            || typeof displayName !== 'string'
            || !displayName.trim()
        ) {
            return null;
        }
        return {
            rank,
            avatarUrl: await resolveRedditAvatarUrl(displayName),
        } satisfies DailyGpPodiumAvatarPosition;
    }));
    const safePositions = resolved.filter(
        (position): position is DailyGpPodiumAvatarPosition => position !== null,
    );
    await redis.set(key, JSON.stringify({ positions: safePositions }), {
        expiration: new Date(Date.now() + BACKFILL_CACHE_MS),
    });
    return safePositions;
}
