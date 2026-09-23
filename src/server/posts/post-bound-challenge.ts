import { reddit } from '@devvit/web/server';
import { hasTrack } from '../../../game/track/catalog.js';
import {
    normalizeDailyGpRaceContract,
    type DailyGpChallenge,
} from '../daily/daily-gp-model.js';
import {
    getServerDailyGpChallengeById,
    persistServerDailyGpChallenge,
} from '../daily/daily-gp-store.js';
import {
    readContextPostData,
    readContextPostId,
} from '../request/request-context.js';

export function normalizePostBoundDailyGpChallenge(value: unknown): DailyGpChallenge | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const record = value as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const challengeDate = typeof record.challengeDate === 'string' ? record.challengeDate : '';
    const trackKey = typeof record.trackKey === 'string' ? record.trackKey : '';
    const startsAt = typeof record.startsAt === 'string' ? record.startsAt : '';
    const endsAt = typeof record.endsAt === 'string' ? record.endsAt : '';
    const availableUntil = typeof record.availableUntil === 'string' ? record.availableUntil : '';

    if (
        !/^daily-gp-\d{4}-\d{2}-\d{2}$/.test(id)
        || !challengeDate
        || !trackKey
        || !hasTrack(trackKey)
        || !startsAt
        || !endsAt
        || !availableUntil
    ) {
        return null;
    }

    const raceContract = normalizeDailyGpRaceContract(record);
    if (!raceContract) return null;

    return {
        id,
        challengeDate,
        trackKey,
        startsAt,
        endsAt,
        availableUntil,
        status: 'active',
        ...raceContract,
        skin: 'default',
    };
}

export async function getPostBoundDailyGpChallenge(): Promise<DailyGpChallenge | null> {
    const contextPostData = readContextPostData();
    const contextChallenge = normalizePostBoundDailyGpChallenge(contextPostData?.challenge);
    if (contextChallenge) {
        return persistServerDailyGpChallenge(contextChallenge);
    }

    const contextChallengeId = contextPostData?.challengeId;
    if (typeof contextChallengeId === 'string' && contextChallengeId) {
        return getServerDailyGpChallengeById(contextChallengeId);
    }

    const postId = readContextPostId();
    if (!postId) {
        return null;
    }

    try {
        const post = await reddit.getPostById(postId as `t3_${string}`);
        const postData = await post.getPostData();
        const challenge = normalizePostBoundDailyGpChallenge(postData?.challenge);
        if (challenge) {
            return persistServerDailyGpChallenge(challenge);
        }
        const challengeId = typeof postData?.challengeId === 'string' && postData.challengeId
            ? postData.challengeId
            : null;
        return challengeId ? getServerDailyGpChallengeById(challengeId) : null;
    } catch (error) {
        console.error('Failed to resolve post-bound Mini Racer challenge:', error);
        return null;
    }
}
