import { CAMPAIGN_ID, getCampaignStage } from '../../game/campaign/manifest.js';
import { getMedalForRaceTime } from '../../game/medals/medal-timing.js';
import { objectiveTypeForLapCount } from '../../game/race/race-spec.js';
import { TRACKS } from '../../game/track/tracks.js';
import { getServerCampaignChallengeSource } from './campaign-store.js';
import {
    type CampaignChallengeRecord,
    type CampaignChallengeSource,
} from './campaign-challenge-model.js';
import {
    readCampaignChallenge,
    readCampaignChallengeResult,
} from './campaign-challenge-store.js';
import { createTrackFingerprint } from './pb-ghost-trace.js';
import { validateDailyGpReplayDetailed } from './replay-validator.js';

export async function resolveCampaignChallengeSource(
    input: Record<string, unknown>,
    username: string,
): Promise<CampaignChallengeSource | null> {
    if (input.source === 'campaign' && typeof input.raceId === 'string') {
        return getServerCampaignChallengeSource({
            raceId: input.raceId,
            redditUsername: username,
        });
    }
    if (input.source !== 'duel' || typeof input.challengeId !== 'string') return null;
    const [challenge, result] = await Promise.all([
        readCampaignChallenge(input.challengeId),
        readCampaignChallengeResult(input.challengeId, username),
    ]);
    if (!challenge || !result?.ghost) return null;
    return {
        sourceKind: 'duel',
        sourceId: challenge.challengeId,
        campaignId: CAMPAIGN_ID,
        raceId: challenge.raceId,
        trackKey: challenge.trackKey,
        lapCount: challenge.lapCount,
        bestTimeMs: result.bestTimeMs,
        medal: result.medal,
        rulesRevision: challenge.rulesRevision,
        trackFingerprint: challenge.trackFingerprint,
        ghost: result.ghost,
    };
}

export function validateCampaignChallengeReplay(
    challenge: CampaignChallengeRecord,
    replay: unknown,
) {
    const stage = getCampaignStage(challenge.raceId);
    const track = TRACKS[challenge.trackKey];
    if (
        !stage
        || !track
        || challenge.campaignId !== CAMPAIGN_ID
        || stage.trackKey !== challenge.trackKey
        || stage.lapCount !== challenge.lapCount
        || stage.rulesRevision !== challenge.rulesRevision
        || createTrackFingerprint(track) !== challenge.trackFingerprint
    ) {
        return { ok: false as const, reason: 'challenge_contract_mismatch' };
    }
    const validation = validateDailyGpReplayDetailed({
        challenge: {
            id: challenge.challengeId,
            challengeDate: CAMPAIGN_ID,
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
    if (!validation.ok || validation.run.completedLaps !== challenge.lapCount || !validation.run.ghost) {
        return {
            ok: false as const,
            reason: validation.ok ? 'lap_count_mismatch' : validation.failure.reason,
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
