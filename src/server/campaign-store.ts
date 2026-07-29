/**
 * Campaign: a fixed, permanent ladder of races whose stages unlock on medals.
 *
 * The racing itself — validating a replay, ranking the time, keeping a personal
 * best and its ghost, picking an opponent — is the shared competition pipeline.
 * What lives here is the part that is genuinely Campaign's own: per-player
 * progress, and the medal gate that decides which stage a player may enter.
 */
import { redis } from '@devvit/redis';
import { createHash } from 'node:crypto';
import {
    CAMPAIGN_ID,
    CAMPAIGN_STAGES,
    getCampaignStage,
    getCampaignUnlockedRaceIds,
    isCampaignStageUnlocked,
} from '../../game/campaign/manifest.js';
import { getMedalForRaceTime } from '../../game/medals/medal-timing.js';
import { TRACKS } from '../../game/track/tracks.js';
import { toCampaignCompetition, type Competition } from './competition.js';
import {
    readEntryByPlayerId,
    readPlayerRank,
    readSnapshot,
} from './competition-leaderboard.js';
import { prepareCompetitionOpponentRace } from './competition-opponent-race.js';
import { resolveAuthorizedPlayerIdentity } from './competition-identity.js';
import { submitCompetitionRun } from './competition-submit.js';
import { getPlayerTrackPbRecord } from './pb-ghost-store.js';
import { redisCompressed } from '@devvit/redis';

type CampaignMedal = 'bronze' | 'silver' | 'gold' | 'author';

export type CampaignBestResult = {
    raceId: string;
    trackKey: string;
    lapCount: 1 | 2 | 3;
    rulesRevision: number;
    bestTimeMs: number;
    medal: CampaignMedal | null;
    checkpointTimesSec: number[] | null;
    updatedAt: string;
};

type CampaignProgress = {
    campaignId: typeof CAMPAIGN_ID;
    startedAt: string | null;
    resultsByRaceId: Record<string, CampaignBestResult>;
    updatedAt: string | null;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function playerField(playerId: string): string {
    return createHash('sha256').update(playerId, 'utf8').digest('base64url');
}

/**
 * Progress is per player and permanent, so it gets its own key rather than a
 * field in one campaign-wide hash that would grow without bound.
 */
function progressKey(playerId: string): string {
    return `campaign:${CAMPAIGN_ID}:progress:${playerField(playerId)}`;
}

function competitionFor(stage: { raceId: string; trackKey: string; lapCount: number; rulesRevision: number }, playerId: string | null): Competition {
    return toCampaignCompetition(CAMPAIGN_ID, stage, { playerId });
}

function emptyProgress(): CampaignProgress {
    return {
        campaignId: CAMPAIGN_ID,
        startedAt: null,
        resultsByRaceId: {},
        updatedAt: null,
    };
}

function parseBestResult(value: unknown, expectedRaceId?: string): CampaignBestResult | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Partial<CampaignBestResult>;
    const stage = getCampaignStage(row.raceId);
    if (
        !stage
        || (expectedRaceId && row.raceId !== expectedRaceId)
        || row.trackKey !== stage.trackKey
        || row.lapCount !== stage.lapCount
        || row.rulesRevision !== stage.rulesRevision
        || !Number.isSafeInteger(row.bestTimeMs)
        || Number(row.bestTimeMs) <= 0
        || typeof row.updatedAt !== 'string'
    ) {
        return null;
    }
    const medal = row.medal === 'bronze'
        || row.medal === 'silver'
        || row.medal === 'gold'
        || row.medal === 'author'
        ? row.medal
        : null;
    return {
        raceId: stage.raceId,
        trackKey: stage.trackKey,
        lapCount: stage.lapCount,
        rulesRevision: stage.rulesRevision,
        bestTimeMs: Math.round(Number(row.bestTimeMs)),
        medal,
        checkpointTimesSec: Array.isArray(row.checkpointTimesSec)
            ? row.checkpointTimesSec.map(Number).filter(Number.isFinite)
            : null,
        updatedAt: row.updatedAt,
    };
}

export function parseCampaignProgress(raw: string | null | undefined): CampaignProgress {
    if (!raw) return emptyProgress();
    try {
        const value = JSON.parse(raw) as Partial<CampaignProgress>;
        if (value.campaignId !== CAMPAIGN_ID) return emptyProgress();
        const resultsByRaceId: Record<string, CampaignBestResult> = {};
        if (value.resultsByRaceId && typeof value.resultsByRaceId === 'object') {
            for (const [raceId, candidate] of Object.entries(value.resultsByRaceId)) {
                const result = parseBestResult(candidate, raceId);
                if (result) resultsByRaceId[raceId] = result;
            }
        }
        return {
            campaignId: CAMPAIGN_ID,
            startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
            resultsByRaceId,
            updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
        };
    } catch (_error) {
        return emptyProgress();
    }
}

async function readProgress(playerId: string): Promise<CampaignProgress> {
    return parseCampaignProgress(await redis.get(progressKey(playerId)));
}

function publicProgress(progress: CampaignProgress) {
    const unlockedRaceIds = getCampaignUnlockedRaceIds(progress.resultsByRaceId);
    return {
        campaignId: CAMPAIGN_ID,
        startedAt: progress.startedAt,
        resultsByRaceId: progress.resultsByRaceId,
        unlockedRaceIds,
        complete: CAMPAIGN_STAGES.every((stage) => {
            const medal = progress.resultsByRaceId[stage.raceId]?.medal;
            return medal === 'gold' || medal === 'author';
        }),
        updatedAt: progress.updatedAt,
    };
}

async function identityFor(input: {
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
}) {
    return resolveAuthorizedPlayerIdentity(input);
}

function identityRequired() {
    return {
        status: 401,
        body: { error: 'Player identity is required for Campaign competition.' },
    };
}

/**
 * Where the player sits on every stage's board, in one pass. The lobby shows a
 * rank per stage, and a zRank each is far cheaper than a snapshot request per
 * stage from the client.
 */
async function readCampaignStandingsByRaceId(playerId: string | null) {
    const entries = await Promise.all(CAMPAIGN_STAGES.map(async (stage) => {
        const competition = competitionFor(stage, playerId);
        const [totalCount, rank] = await Promise.all([
            redis.zCard(competition.leaderboardKey),
            readPlayerRank(competition, playerId),
        ]);
        return [stage.raceId, { rank, totalCount: totalCount || 0 }] as const;
    }));
    return Object.fromEntries(entries);
}

export async function getServerCampaignBootstrap({
    playerId,
    redditUsername,
    guestToken,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
} = {}) {
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    const canonicalPlayerId = identity.canonicalPlayerId;
    const [progress, standingsByRaceId] = await Promise.all([
        canonicalPlayerId ? readProgress(canonicalPlayerId) : Promise.resolve(emptyProgress()),
        readCampaignStandingsByRaceId(canonicalPlayerId),
    ]);
    return {
        status: 200,
        body: {
            campaignId: CAMPAIGN_ID,
            signedIn: Boolean(canonicalPlayerId),
            stages: CAMPAIGN_STAGES,
            progress: publicProgress(progress),
            standingsByRaceId,
        },
    };
}

export async function startServerCampaignRace({
    raceId,
    playerId,
    redditUsername,
    guestToken,
}: {
    raceId?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
} = {}) {
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    if (!identity.canonicalPlayerId) return identityRequired();
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { error: 'Campaign race not found.' } };
    const progress = await readProgress(identity.canonicalPlayerId);
    if (!isCampaignStageUnlocked(stage.raceId, progress.resultsByRaceId)) {
        return { status: 403, body: { error: 'Campaign race is locked.' } };
    }
    let startedProgress = progress;
    if (!progress.startedAt) {
        const nowIso = new Date().toISOString();
        startedProgress = { ...progress, startedAt: nowIso, updatedAt: nowIso };
        await redis.set(progressKey(identity.canonicalPlayerId), JSON.stringify(startedProgress));
    }
    return { status: 200, body: { race: stage, progress: publicProgress(startedProgress) } };
}

function normalizeLimit(value: unknown): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? Math.min(MAX_LIMIT, Math.max(1, parsed)) : DEFAULT_LIMIT;
}

function normalizeOffset(value: unknown): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? Math.max(0, parsed) : 0;
}

export async function getServerCampaignSnapshot({
    raceId,
    playerId,
    redditUsername,
    guestToken,
    limit,
    offset,
}: {
    raceId?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    limit?: unknown;
    offset?: unknown;
} = {}) {
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { error: 'Campaign race not found.' } };
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    const snapshot = await readSnapshot({
        competition: competitionFor(stage, identity.canonicalPlayerId),
        playerId: identity.canonicalPlayerId,
        limit: normalizeLimit(limit),
        offset: normalizeOffset(offset),
    });
    return { status: 200, body: { race: stage, ...snapshot } };
}

export async function prepareServerCampaignLeaderboardRace({
    raceId,
    playerId,
    redditUsername,
    guestToken,
    selection,
}: {
    raceId?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    selection?: unknown;
}) {
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { error: 'Campaign race not found.', reason: 'race_not_found' } };
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    if (identity.canonicalPlayerId) {
        const progress = await readProgress(identity.canonicalPlayerId);
        if (!isCampaignStageUnlocked(stage.raceId, progress.resultsByRaceId)) {
            return { status: 403, body: { error: 'Campaign race is locked.', reason: 'race_locked' } };
        }
    }
    return prepareCompetitionOpponentRace({
        competition: competitionFor(stage, identity.canonicalPlayerId),
        playerId: identity.canonicalPlayerId,
        race: stage,
        selection,
    });
}

export async function submitServerCampaignRun({
    raceId,
    trackKey,
    replay,
    playerId,
    redditUsername,
    guestToken,
    requestRateLimitIdentity,
}: {
    raceId?: unknown;
    trackKey?: unknown;
    replay?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    requestRateLimitIdentity?: unknown;
} = {}) {
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    if (!identity.canonicalPlayerId) {
        return {
            status: 401,
            body: { accepted: false, error: 'Player identity is required to submit Campaign results.' },
        };
    }
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { accepted: false, error: 'Campaign race not found.' } };

    const canonicalPlayerId = identity.canonicalPlayerId;
    const progress = await readProgress(canonicalPlayerId);
    // The medal gate is Campaign's own rule, so it is checked before the run
    // reaches the shared pipeline rather than inside it.
    if (!isCampaignStageUnlocked(stage.raceId, progress.resultsByRaceId)) {
        return { status: 403, body: { accepted: false, error: 'Campaign race is locked.' } };
    }

    const competition = competitionFor(stage, canonicalPlayerId);
    const outcome = await submitCompetitionRun({
        competition,
        playerId: canonicalPlayerId,
        redditUsername,
        trackKey,
        replay,
        requestRateLimitIdentity,
    });
    if (outcome.status !== 200 || !(outcome.body as { accepted?: boolean }).accepted) {
        return outcome;
    }

    const body = outcome.body as {
        accepted: true;
        improved: boolean;
        bestTimeMs: number;
        checkpointTimesSec: number[] | null;
    };
    const nowIso = new Date().toISOString();
    if (body.improved) {
        const result: CampaignBestResult = {
            raceId: stage.raceId,
            trackKey: stage.trackKey,
            lapCount: stage.lapCount,
            rulesRevision: stage.rulesRevision,
            bestTimeMs: body.bestTimeMs,
            medal: getMedalForRaceTime(stage.trackKey, body.bestTimeMs / 1000, stage.lapCount),
            checkpointTimesSec: body.checkpointTimesSec,
            updatedAt: nowIso,
        };
        const freshProgress = await readProgress(canonicalPlayerId);
        const previous = freshProgress.resultsByRaceId[stage.raceId] ?? null;
        if (!previous || previous.bestTimeMs > body.bestTimeMs) {
            await redis.set(progressKey(canonicalPlayerId), JSON.stringify({
                campaignId: CAMPAIGN_ID,
                startedAt: freshProgress.startedAt || nowIso,
                resultsByRaceId: { ...freshProgress.resultsByRaceId, [stage.raceId]: result },
                updatedAt: nowIso,
            } satisfies CampaignProgress));
        }
    }

    return {
        status: 200,
        body: {
            ...outcome.body as Record<string, unknown>,
            progress: publicProgress(await readProgress(canonicalPlayerId)),
        },
    };
}

export async function getServerCampaignPbGhost({
    raceId,
    playerId,
    redditUsername,
    guestToken,
}: {
    raceId?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
} = {}) {
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    if (!identity.canonicalPlayerId) return identityRequired();
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { error: 'Campaign race not found.' } };
    const personalBest = await getPlayerTrackPbRecord({
        playerId: identity.canonicalPlayerId,
        competition: competitionFor(stage, identity.canonicalPlayerId),
        track: TRACKS[stage.trackKey],
    });
    return {
        status: 200,
        body: {
            campaignId: CAMPAIGN_ID,
            raceId: stage.raceId,
            trackKey: stage.trackKey,
            personalBest,
        },
    };
}

export async function getServerCampaignChallengeSource({
    raceId,
    playerId,
    redditUsername,
    guestToken,
}: {
    raceId?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
} = {}) {
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    const stage = getCampaignStage(raceId);
    if (!identity.canonicalPlayerId || !stage) return null;
    const competition = competitionFor(stage, identity.canonicalPlayerId);
    const personalBest = await getPlayerTrackPbRecord({
        playerId: identity.canonicalPlayerId,
        competition,
        track: TRACKS[stage.trackKey],
    });
    if (!personalBest?.ghost) return null;
    const result = (await readProgress(identity.canonicalPlayerId))
        .resultsByRaceId[stage.raceId] ?? null;
    return {
        sourceKind: 'campaign' as const,
        sourceId: stage.raceId,
        campaignId: CAMPAIGN_ID,
        raceId: stage.raceId,
        trackKey: stage.trackKey,
        lapCount: stage.lapCount,
        bestTimeMs: personalBest.bestTimeMs,
        medal: result?.medal ?? null,
        rulesRevision: stage.rulesRevision,
        trackFingerprint: personalBest.trackFingerprint,
        ghost: personalBest.ghost,
    };
}

/**
 * Moves a guest's Campaign standing onto their Reddit account at sign-in.
 *
 * Daily can afford to strand a guest's row — a challenge expires in a week.
 * Campaign progress is permanent and gates which stages a player may enter, so
 * losing it at sign-in would cost them the ladder they already climbed.
 *
 * Per stage the better time wins, and everything that describes that time moves
 * with it: the progress entry, the leaderboard row and the PB record with its
 * ghost. Guest keys are dropped afterwards, so a repeated call is a no-op.
 */
export async function mergeGuestCampaignProgress({
    guestPlayerId,
    redditPlayerId,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
}): Promise<{ merged: boolean; mergedRaceIds: string[] }> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) {
        return { merged: false, mergedRaceIds: [] };
    }

    const [guestProgress, redditProgress] = await Promise.all([
        readProgress(guestPlayerId),
        readProgress(redditPlayerId),
    ]);
    const guestResults = Object.values(guestProgress.resultsByRaceId);
    if (!guestResults.length) return { merged: false, mergedRaceIds: [] };

    const mergedResults = { ...redditProgress.resultsByRaceId };
    const mergedRaceIds: string[] = [];
    for (const guestResult of guestResults) {
        const existing = mergedResults[guestResult.raceId];
        if (existing && existing.bestTimeMs <= guestResult.bestTimeMs) continue;
        mergedResults[guestResult.raceId] = guestResult;
        mergedRaceIds.push(guestResult.raceId);
    }

    const nowIso = new Date().toISOString();
    await redis.set(progressKey(redditPlayerId), JSON.stringify({
        campaignId: CAMPAIGN_ID,
        startedAt: redditProgress.startedAt || guestProgress.startedAt || nowIso,
        resultsByRaceId: mergedResults,
        updatedAt: nowIso,
    } satisfies CampaignProgress));

    for (const raceId of mergedRaceIds) {
        const stage = getCampaignStage(raceId);
        if (!stage) continue;
        const guestCompetition = competitionFor(stage, guestPlayerId);
        const redditCompetition = competitionFor(stage, redditPlayerId);
        const guestEntry = await readEntryByPlayerId(guestCompetition, guestPlayerId);
        if (guestEntry) {
            await redis.hSet(redditCompetition.entryHashKey, {
                [redditPlayerId]: JSON.stringify({ ...guestEntry, playerId: redditPlayerId }),
            });
            await redis.zAdd(redditCompetition.leaderboardKey, {
                member: redditPlayerId,
                score: guestEntry.bestTimeMs,
            });
        }
        const guestPb = await redisCompressed.hGet(
            guestCompetition.pbHashKey,
            playerField(guestPlayerId),
        );
        if (guestPb) {
            await redisCompressed.hSet(redditCompetition.pbHashKey, {
                [playerField(redditPlayerId)]: guestPb,
            });
        }
    }

    await Promise.all([
        redis.del(progressKey(guestPlayerId)),
        ...CAMPAIGN_STAGES.map(async (stage) => {
            const guestCompetition = competitionFor(stage, guestPlayerId);
            await redis.hDel(guestCompetition.entryHashKey, [guestPlayerId]);
            await redis.zRem(guestCompetition.leaderboardKey, [guestPlayerId]);
            await redisCompressed.hDel(guestCompetition.pbHashKey, [playerField(guestPlayerId)]);
        }),
    ]);

    return { merged: mergedRaceIds.length > 0, mergedRaceIds };
}
