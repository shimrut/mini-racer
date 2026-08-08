import { getCampaignStage } from '../../game/campaign/manifest.js';
import { getMedalForRaceTime } from '../../game/medals/medal-timing.js';
import { objectiveTypeForLapCount } from '../../game/race/race-spec.js';
import { TRACKS } from '../../game/track/tracks.js';
import {
    getServerHeadToHeadSource,
} from './campaign-store.js';
import {
    getServerDailyGpPlayableChallenge,
} from './daily-gp-store.js';
import {
    getHeadToHeadOrigin,
    type HeadToHeadRecord,
    type HeadToHeadSource,
} from './head-to-head-model.js';
import type { HeadToHeadPostContext } from './head-to-head-post.js';
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
    // A Head to Head can only be issued from a Campaign stage or a Daily run.
    // It is never issued from another Head to Head, because that would need a
    // stored result and nothing about a Head to Head outlives its post.
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
