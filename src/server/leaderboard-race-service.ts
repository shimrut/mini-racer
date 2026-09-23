import { prepareServerCampaignLeaderboardRace } from './campaign-store.js';
import { prepareServerDailyLeaderboardRace } from './daily-gp-store.js';
import { checkFixedWindowRateLimit } from './rate-limit.js';

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
    return checkFixedWindowRateLimit(
        `leaderboard-race:prepare-rate-limit:${competitionId}:${identity}`,
        PREPARE_RATE_LIMIT_MAX_REQUESTS,
        PREPARE_RATE_LIMIT_WINDOW_SECONDS,
    );
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
    if (rateLimit.allowed === false) {
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
