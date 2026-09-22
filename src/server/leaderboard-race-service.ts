import { redis } from '@devvit/redis';
import { prepareServerCampaignLeaderboardRace } from './campaign-store.js';
import { prepareServerDailyLeaderboardRace } from './daily-gp-store.js';

const PREPARE_RATE_LIMIT_WINDOW_SECONDS = 60;
const PREPARE_RATE_LIMIT_MAX_REQUESTS = 12;

type ServiceResult = {
    status: number;
    body: unknown;
};

function competitionIdForInput(input: Record<string, unknown>): string | null {
    if (input.mode === 'daily' && typeof input.challengeId === 'string' && input.challengeId) {
        return input.challengeId;
    }
    if (input.mode === 'campaign' && typeof input.raceId === 'string' && input.raceId) {
        return input.raceId;
    }
    return null;
}

async function checkPrepareRateLimit(competitionId: string, identity: string) {
    const key = `leaderboard-race:prepare-rate-limit:${competitionId}:${identity}`;
    const count = await redis.incrBy(key, 1);
    if (count === 1) await redis.expire(key, PREPARE_RATE_LIMIT_WINDOW_SECONDS);
    if (count <= PREPARE_RATE_LIMIT_MAX_REQUESTS) return { allowed: true as const };
    const expiresAt = await redis.expireTime(key);
    if (Number.isFinite(expiresAt) && expiresAt > 0) {
        return {
            allowed: false as const,
            retryAfterSeconds: Math.max(1, expiresAt - Math.floor(Date.now() / 1000)),
        };
    }
    await redis.expire(key, PREPARE_RATE_LIMIT_WINDOW_SECONDS);
    return { allowed: false as const, retryAfterSeconds: PREPARE_RATE_LIMIT_WINDOW_SECONDS };
}

export async function prepareServerLeaderboardRace(
    input: Record<string, unknown> = {},
): Promise<ServiceResult> {
    const competitionId = competitionIdForInput(input);
    if (!competitionId) {
        return {
            status: 400,
            body: { error: 'Leaderboard race mode and competition are required.', reason: 'invalid_competition' },
        };
    }
    const requestIdentity = typeof input.requestRateLimitIdentity === 'string'
        ? input.requestRateLimitIdentity.trim()
        : '';
    if (!requestIdentity) {
        return {
            status: 401,
            body: { error: 'Trusted request identity is required.', reason: 'identity_required' },
        };
    }
    const rateLimit = await checkPrepareRateLimit(competitionId, requestIdentity);
    if (!rateLimit.allowed) {
        return {
            status: 429,
            body: {
                error: 'Too many opponent race requests. Try again soon.',
                reason: 'rate_limited',
                retryAfterSeconds: rateLimit.retryAfterSeconds,
            },
        };
    }
    if (input.mode === 'daily') {
        return prepareServerDailyLeaderboardRace(input);
    }
    return prepareServerCampaignLeaderboardRace(input);
}
