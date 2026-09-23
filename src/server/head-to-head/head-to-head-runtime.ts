import { getCampaignStage, isCampaignStageUnlocked } from '../../../game/campaign/manifest.js';
import { getMedalForRaceTime } from '../../../game/medals/medal-timing.js';
import { objectiveTypeForLapCount } from '../../../game/race/race-spec.js';
import { TRACKS } from '../../../game/track/tracks.js';
import {
    getCampaignProgressForSelection,
    repairCampaignStandingsFromEntries,
    submitServerCampaignRun,
} from '../campaign/campaign-store.js';
import {
    getServerDailyGpPlayableChallenge,
    submitServerDailyGpRun,
} from '../daily/daily-gp-store.js';
import { readEntryByPlayerId, readPlayerRank } from '../competition/competition-leaderboard.js';
import { validateCompetitionReplay } from '../competition/competition-submit.js';
import {
    toCampaignCompetition,
    toDailyCompetition,
    type Competition,
} from '../competition/competition.js';
import {
    CAMPAIGN_ID,
    getHeadToHeadOrigin,
    type HeadToHeadRecord,
    type HeadToHeadSource,
} from './head-to-head-model.js';
import type {
    HeadToHeadBestContext,
    HeadToHeadBestUpdate,
    HeadToHeadViewerBest,
} from './head-to-head-service.js';
import { createTrackFingerprint } from '../competition/pb-ghost-trace.js';
import { validateDailyGpReplayDetailed } from '../competition/replay-validator.js';

export async function resolveHeadToHeadSource(
    input: Record<string, unknown>,
): Promise<HeadToHeadSource | null> {
    const stage = input.source === 'campaign' ? getCampaignStage(input.raceId) : null;
    const daily = input.source === 'daily' && typeof input.challengeId === 'string'
        ? await getServerDailyGpPlayableChallenge(input.challengeId)
        : null;
    const race = stage
        ? {
            competition: toCampaignCompetition(CAMPAIGN_ID, stage),
            id: { sourceKind: 'campaign' as const, sourceId: stage.raceId, campaignId: CAMPAIGN_ID, raceId: stage.raceId },
        }
        : daily
            ? {
                competition: toDailyCompetition(daily),
                id: { sourceKind: 'daily' as const, sourceId: daily.id, origin: { mode: 'daily' as const, challengeId: daily.id } },
            }
            : null;
    const track = race ? TRACKS[race.competition.trackKey] : null;
    if (!race || !track || input.replay == null) return null;
    const { competition } = race;
    const validation = validateCompetitionReplay(competition, input.replay);
    if (!validation.ok || !validation.run.ghost) return null;
    return {
        ...race.id,
        trackKey: competition.trackKey,
        lapCount: competition.lapCount,
        bestTimeMs: validation.run.bestTimeMs,
        medal: getMedalForRaceTime(competition.trackKey, validation.run.bestTimeSec, competition.lapCount),
        rulesRevision: competition.rulesRevision,
        trackFingerprint: createTrackFingerprint(track),
        ghost: validation.run.ghost,
    };
}

export function validateHeadToHeadReplay(
    challenge: HeadToHeadRecord,
    replay: unknown,
) {
    const origin = getHeadToHeadOrigin(challenge);
    const track = TRACKS[challenge.trackKey];
    const stage = origin?.mode === 'campaign'
        ? getCampaignStage(origin.raceId)
        : null;
    if (!origin || !track || createTrackFingerprint(track) !== challenge.trackFingerprint) {
        return { ok: false as const, reason: 'challenge_contract_mismatch' };
    }
    if (origin.mode === 'campaign' && (
        !stage
        || stage.trackKey !== challenge.trackKey
        || stage.lapCount !== challenge.lapCount
        || stage.rulesRevision !== challenge.rulesRevision
    )) {
        return { ok: false as const, reason: 'challenge_contract_mismatch' };
    }
    const validation = validateDailyGpReplayDetailed({
        challenge: {
            id: challenge.challengeId,
            challengeDate: origin.mode === 'campaign'
                ? origin.campaignId
                : origin.challengeId,
            trackKey: challenge.trackKey,
            startsAt: '1970-01-01T00:00:00.000Z',
            endsAt: '9999-12-31T23:59:59.999Z',
            availableUntil: '9999-12-31T23:59:59.999Z',
            status: 'active' as const,
            rulesRevision: challenge.rulesRevision as 1,
            objectiveType: objectiveTypeForLapCount(challenge.lapCount) as
                'single_lap_fastest' | 'multi_lap_total',
            objectiveParams: { lapCount: challenge.lapCount },
            skin: 'default' as const,
        },
        replay,
    });
    if (validation.ok === false) {
        return {
            ok: false as const,
            reason: validation.failure.reason,
        };
    }
    if (validation.run.completedLaps !== challenge.lapCount || !validation.run.ghost) {
        return {
            ok: false as const,
            reason: 'lap_count_mismatch',
        };
    }
    return {
        ok: true as const,
        bestTimeMs: validation.run.bestTimeMs,
        medal: getMedalForRaceTime(
            challenge.trackKey,
            validation.run.bestTimeSec,
            challenge.lapCount,
        ),
        ghost: validation.run.ghost,
        run: validation.run,
        judgedContract: {
            trackKey: challenge.trackKey,
            lapCount: challenge.lapCount,
            rulesRevision: challenge.rulesRevision,
            objectiveType: objectiveTypeForLapCount(challenge.lapCount),
        },
    };
}

async function readBestEffortRank(
    competition: Competition,
    playerId: string | null | undefined,
): Promise<number | null> {
    if (!playerId) return null;
    try {
        return await readPlayerRank(competition, playerId);
    } catch (error) {
        console.error('Head to Head rank read failed:', error);
        return null;
    }
}

function acceptedBest(
    outcome: { status: number; body: unknown },
): { improved: boolean; bestTimeMs: number } | null {
    const body = outcome.body as { accepted?: boolean; improved?: boolean; bestTimeMs?: unknown };
    if (outcome.status !== 200 || body.accepted !== true) return null;
    const bestTimeMs = Number(body.bestTimeMs);
    if (!Number.isFinite(bestTimeMs) || bestTimeMs <= 0) return null;
    return { improved: body.improved === true, bestTimeMs };
}

export async function recordHeadToHeadBest(
    challenge: HeadToHeadRecord,
    replay: unknown,
    context: HeadToHeadBestContext = {},
): Promise<HeadToHeadBestUpdate | null> {
    const origin = getHeadToHeadOrigin(challenge);
    if (!origin || replay == null) return null;
    const identity = {
        playerId: context.playerId ?? undefined,
        redditUsername: context.username ?? undefined,
        guestToken: context.guestToken ?? undefined,
        requestRateLimitIdentity: context.requestRateLimitIdentity ?? undefined,
    };
    const reuse = {
        countTowardRateLimit: false as const,
        ...(context.verifiedRun != null && context.judgedContract
            ? {
                verifiedRun: context.verifiedRun,
                judgedContract: context.judgedContract,
            }
            : {}),
    };

    if (origin.mode === 'campaign') {
        const stage = getCampaignStage(origin.raceId);
        if (!stage) return null;
        const best = acceptedBest(await submitServerCampaignRun({
            ...identity,
            raceId: stage.raceId,
            trackKey: challenge.trackKey,
            replay,
        }, reuse));
        if (!best) return null;
        return {
            ...best,
            mode: 'campaign',
            medal: getMedalForRaceTime(stage.trackKey, best.bestTimeMs / 1000, stage.lapCount),
            rank: await readBestEffortRank(
                toCampaignCompetition(CAMPAIGN_ID, stage),
                context.canonicalPlayerId,
            ),
        };
    }

    const dailyChallenge = await getServerDailyGpPlayableChallenge(origin.challengeId);
    if (!dailyChallenge) return null;
    const best = acceptedBest(await submitServerDailyGpRun({
        ...identity,
        challengeId: dailyChallenge.id,
        trackKey: challenge.trackKey,
        replay,
    }, reuse));
    if (!best) return null;
    return {
        ...best,
        mode: 'daily',
        medal: getMedalForRaceTime(
            dailyChallenge.trackKey,
            best.bestTimeMs / 1000,
            challenge.lapCount,
        ),
        rank: await readBestEffortRank(
            toDailyCompetition(dailyChallenge),
            context.canonicalPlayerId,
        ),
    };
}

async function challengeCompetition(
    challenge: HeadToHeadRecord,
): Promise<{ competition: Competition; trackKey: string; lapCount: number } | null> {
    const origin = getHeadToHeadOrigin(challenge);
    if (!origin) return null;
    if (origin.mode === 'campaign') {
        const stage = getCampaignStage(origin.raceId);
        return stage
            ? {
                competition: toCampaignCompetition(CAMPAIGN_ID, stage),
                trackKey: stage.trackKey,
                lapCount: stage.lapCount,
            }
            : null;
    }
    const dailyChallenge = await getServerDailyGpPlayableChallenge(origin.challengeId);
    return dailyChallenge
        ? {
            competition: toDailyCompetition(dailyChallenge),
            trackKey: dailyChallenge.trackKey,
            lapCount: challenge.lapCount,
        }
        : null;
}

function toViewerRank(rank: number | null): number | null {
    return Number.isInteger(rank) && Number(rank) > 0 ? Number(rank) : null;
}

export async function readHeadToHeadViewerBest(
    challenge: HeadToHeadRecord,
    playerId: string | null,
): Promise<HeadToHeadViewerBest | null> {
    if (!playerId) return null;
    const origin = getHeadToHeadOrigin(challenge);
    let progressBestTimeMs: number | null = null;
    if (origin?.mode === 'campaign') {
        try {
            const progress = await getCampaignProgressForSelection(playerId);
            if (!isCampaignStageUnlocked(origin.raceId, progress.resultsByRaceId)) {
                return {
                    bestTimeMs: null,
                    medal: null,
                    rank: null,
                    trackLocked: true,
                };
            }
            const storedMs = Number(progress.resultsByRaceId?.[origin.raceId]?.bestTimeMs);
            if (Number.isFinite(storedMs) && storedMs > 0) progressBestTimeMs = Math.round(storedMs);
        } catch {
        }
    }
    const target = await challengeCompetition(challenge);
    if (!target) return null;
    if (origin?.mode === 'campaign') {
        try {
            await repairCampaignStandingsFromEntries(playerId);
        } catch (error) {
            console.error('Head to Head campaign standings repair failed:', error);
        }
    }
    const entry = await readEntryByPlayerId(target.competition, playerId);
    const entryMs = Number(entry?.bestTimeMs);
    const bestTimeMs = [entryMs, progressBestTimeMs]
        .filter((ms) => Number.isFinite(ms) && ms > 0)
        .reduce((fastest, ms) => Math.min(fastest, Math.round(ms)), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(bestTimeMs) || bestTimeMs === Number.POSITIVE_INFINITY) return null;
    return {
        bestTimeMs,
        medal: getMedalForRaceTime(target.trackKey, bestTimeMs / 1000, target.lapCount),
        rank: toViewerRank(await readBestEffortRank(target.competition, playerId)),
        trackLocked: false,
    };
}
