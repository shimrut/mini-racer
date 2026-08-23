import { getCampaignStage } from '../../game/campaign/manifest.js';
import { getMedalForRaceTime } from '../../game/medals/medal-timing.js';
import { objectiveTypeForLapCount } from '../../game/race/race-spec.js';
import { TRACKS } from '../../game/track/tracks.js';
import {
    getServerHeadToHeadSource,
    submitServerCampaignRun,
} from './campaign-store.js';
import {
    getServerDailyGpPlayableChallenge,
    submitServerDailyGpRun,
} from './daily-gp-store.js';
import { readEntryByPlayerId, readPlayerRank } from './competition-leaderboard.js';
import {
    toCampaignCompetition,
    toDailyCompetition,
    type Competition,
} from './competition.js';
import {
    CAMPAIGN_ID,
    getHeadToHeadOrigin,
    type HeadToHeadRecord,
    type HeadToHeadSource,
} from './head-to-head-model.js';
import type { HeadToHeadPostContext } from './head-to-head-post.js';
import type {
    HeadToHeadBestContext,
    HeadToHeadBestUpdate,
    HeadToHeadViewerBest,
} from './head-to-head-service.js';
import { createTrackFingerprint } from './pb-ghost-trace.js';
import { validateDailyGpReplayDetailed } from './replay-validator.js';

export async function resolveHeadToHeadSource(
    input: Record<string, unknown>,
    username: string,
    context: HeadToHeadPostContext = {},
): Promise<HeadToHeadSource | null> {
    if (input.source === 'campaign' && typeof input.raceId === 'string') {
        return getServerHeadToHeadSource({
            raceId: input.raceId,
            redditUsername: username,
        });
    }
    if (input.source === 'daily' && typeof input.challengeId === 'string') {
        const challenge = await getServerDailyGpPlayableChallenge(input.challengeId);
        const track = challenge ? TRACKS[challenge.trackKey] : null;
        if (!challenge || !track || input.replay == null) return null;
        const validation = validateDailyGpReplayDetailed({
            challenge,
            replay: input.replay,
        });
        if (!validation.ok || !validation.run.ghost) return null;
        return {
            sourceKind: 'daily',
            sourceId: challenge.id,
            origin: {
                mode: 'daily',
                challengeId: challenge.id,
            },
            trackKey: challenge.trackKey,
            lapCount: challenge.objectiveParams.lapCount,
            bestTimeMs: validation.run.bestTimeMs,
            medal: getMedalForRaceTime(
                challenge.trackKey,
                validation.run.bestTimeSec,
                challenge.objectiveParams.lapCount,
            ),
            rulesRevision: challenge.rulesRevision,
            trackFingerprint: createTrackFingerprint(track),
            ghost: validation.run.ghost,
        };
    }
    // A Head to Head is only ever issued from a Campaign stage or a Daily run: nothing about one outlives its post.
    return null;
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
        // The rank is decoration on a result that is already stored.
        console.error('Head to Head rank read failed:', error);
        return null;
    }
}

/** Only an accepted run with a real stored time is worth reporting back to the challenge screen. */
function acceptedBest(
    outcome: { status: number; body: unknown },
): { improved: boolean; bestTimeMs: number } | null {
    const body = outcome.body as { accepted?: boolean; improved?: boolean; bestTimeMs?: unknown };
    if (outcome.status !== 200 || body.accepted !== true) return null;
    const bestTimeMs = Number(body.bestTimeMs);
    if (!Number.isFinite(bestTimeMs) || bestTimeMs <= 0) return null;
    return { improved: body.improved === true, bestTimeMs };
}

/**
 * A verified challenge run is a verified run on the stage or Daily it was minted from: same track,
 * same laps, same rules, same validator. So it earns the board entry, the personal best and the
 * progress a normal run earns. Whatever the mode refuses — a locked stage, a Daily that has closed —
 * stays unwritten, because the refusal is the rule.
 */
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

    if (origin.mode === 'campaign') {
        const stage = getCampaignStage(origin.raceId);
        if (!stage) return null;
        const best = acceptedBest(await submitServerCampaignRun({
            ...identity,
            raceId: stage.raceId,
            trackKey: challenge.trackKey,
            replay,
        }));
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
    }));
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

/** The board entry is the number the submit compares against, so it is the number worth showing. */
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

/**
 * What this player already holds on the stage or Daily behind the challenge. Null when they hold
 * nothing there, or when the Daily has closed and no run could be written to it anyway.
 */
export async function readHeadToHeadViewerBest(
    challenge: HeadToHeadRecord,
    playerId: string | null,
): Promise<HeadToHeadViewerBest | null> {
    if (!playerId) return null;
    const target = await challengeCompetition(challenge);
    if (!target) return null;
    const entry = await readEntryByPlayerId(target.competition, playerId);
    const bestTimeMs = Number(entry?.bestTimeMs);
    if (!Number.isFinite(bestTimeMs) || bestTimeMs <= 0) return null;
    return {
        bestTimeMs,
        medal: getMedalForRaceTime(target.trackKey, bestTimeMs / 1000, target.lapCount),
    };
}
