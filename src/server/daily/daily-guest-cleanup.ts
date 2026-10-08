import { redis } from '@devvit/redis';
import {
    createRedisChallengeEntryHashKey,
    createRedisChallengeLeaderboardKey,
    createRedisChallengeStandingsRevisionKey,
} from './daily-gp-model.js';
import { challengeCollectionKey } from '../competition/pb-ghost-store.js';
import { competitionHoldsPlayerRows } from '../competition/competition-leaderboard.js';
import {
    guestProgressSelectionPendingKey,
    isGuestProgressSelectionPending,
} from '../player/guest-retirement.js';
import { DAILY_GUEST_EXPIRY_KEY, racedListKey } from '../player/raced-list.js';
import { playerFieldHash } from '../redis/redis-names.js';
import { isRedisTransactionConflict } from '../redis/redis-transaction-conflict.js';

// Deletes the Daily rows of a guest idle for a year, day by day from the raced list; racing again keeps the rest.
const DAILY_GUEST_CLEANUP_LIMIT = 10;
const DAILY_GUEST_CLEANUP_THROTTLE_SECONDS = 60;
const DAILY_GUEST_CLEANUP_THROTTLE_KEY = `${DAILY_GUEST_EXPIRY_KEY}:cleanup-throttle`;
// Each day queues 4 commands, so 5 days stay under 24 commands.
const DAILY_GUEST_DAYS_PER_WRITE = 5;

function dailyBoard(challengeId: string) {
    return {
        entryHashKey: createRedisChallengeEntryHashKey(challengeId),
        leaderboardKey: createRedisChallengeLeaderboardKey(challengeId),
        pbHashKey: challengeCollectionKey(challengeId),
        standingsRevisionKey: createRedisChallengeStandingsRevisionKey(challengeId),
    };
}

// Runs `mutate` only while the guest is expired and no transfer owns them; false when either changed or a write got in.
// Watches the expiry list, raced list and transfer mark, because a transfer copies rows it read after setting its mark.
async function writeWhileExpired(
    guestPlayerId: string,
    nowMs: number,
    mutate: (transaction: Awaited<ReturnType<typeof redis.watch>>) => Promise<void>,
): Promise<boolean> {
    const pendingKey = guestProgressSelectionPendingKey(guestPlayerId);
    const transaction = await redis.watch(DAILY_GUEST_EXPIRY_KEY, racedListKey(guestPlayerId), pendingKey);
    try {
        // Transaction-client reads queue; read the base client.
        const [score, pending] = await Promise.all([
            redis.zScore(DAILY_GUEST_EXPIRY_KEY, guestPlayerId),
            redis.get(pendingKey),
        ]);
        if (pending || !Number.isFinite(Number(score)) || Number(score) > nowMs) {
            await transaction.unwatch();
            return false;
        }
        await transaction.multi();
        await mutate(transaction);
        const results = await transaction.exec();
        return Array.isArray(results) && results.length > 0;
    } catch (error) {
        try {
            await transaction.discard();
        } catch (_discardError) {
        }
        if (isRedisTransactionConflict(error)) return false;
        throw error;
    }
}

async function cleanupExpiredDailyGuest(guestPlayerId: string, nowMs: number): Promise<boolean> {
    // A transfer owns the guest's rows until it ends.
    if (await isGuestProgressSelectionPending(guestPlayerId)) return false;
    const fields = await redis.hKeys(racedListKey(guestPlayerId));
    const challengeIds = fields
        .filter((field) => field.startsWith('daily:'))
        .map((field) => field.slice('daily:'.length));
    const held = (await Promise.all(challengeIds.map(async (challengeId) => (
        await competitionHoldsPlayerRows(dailyBoard(challengeId), guestPlayerId) ? challengeId : null
    )))).filter((challengeId): challengeId is string => challengeId !== null);

    for (let index = 0; index < held.length; index += DAILY_GUEST_DAYS_PER_WRITE) {
        const group = held.slice(index, index + DAILY_GUEST_DAYS_PER_WRITE);
        const written = await writeWhileExpired(guestPlayerId, nowMs, async (transaction) => {
            for (const challengeId of group) {
                const board = dailyBoard(challengeId);
                await transaction.hDel(board.entryHashKey, [guestPlayerId]);
                await transaction.zRem(board.leaderboardKey, [guestPlayerId]);
                await transaction.hDel(board.pbHashKey, [playerFieldHash(guestPlayerId)]);
                await transaction.incrBy(board.standingsRevisionKey, 1);
            }
        });
        if (!written) return false;
    }
    // The raced list goes too; the Campaign clean-up handles its Campaign stages.
    return writeWhileExpired(guestPlayerId, nowMs, async (transaction) => {
        await transaction.zRem(DAILY_GUEST_EXPIRY_KEY, [guestPlayerId]);
        await transaction.del(racedListKey(guestPlayerId));
    });
}

export async function cleanupExpiredDailyGuests(nowMs = Date.now()): Promise<number> {
    const candidates = await redis.zRange(DAILY_GUEST_EXPIRY_KEY, 0, nowMs, {
        by: 'score',
        limit: { offset: 0, count: DAILY_GUEST_CLEANUP_LIMIT },
    });
    if (!candidates.length) return 0;
    const throttle = await redis.set(DAILY_GUEST_CLEANUP_THROTTLE_KEY, '1', {
        nx: true,
        expiration: new Date(nowMs + DAILY_GUEST_CLEANUP_THROTTLE_SECONDS * 1000),
    });
    if (!throttle) return 0;
    let cleaned = 0;
    for (const candidate of candidates) {
        if (await cleanupExpiredDailyGuest(candidate.member, nowMs)) cleaned += 1;
    }
    return cleaned;
}

export async function cleanupExpiredDailyGuestsBestEffort(): Promise<void> {
    try {
        await cleanupExpiredDailyGuests();
    } catch (error) {
        console.error('Daily guest cleanup failed:', error);
    }
}
