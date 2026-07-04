import { TRACKS } from '../../game/track/tracks.js';
import { getBackfilledDailyGpTrackKeyForDate } from '../../game/shared/daily-gp-history-backfill.js';
import {
    createDailyChallengeId,
    DAILY_GP_PLAYLIST_DAYS,
    DAY_MS,
    type DailyGpChallenge,
} from './daily-gp-model.js';

function getUtcDayStart(challengeDate: string): Date | null {
    const date = new Date(`${challengeDate}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) ? date : null;
}

export function getBackfilledDailyGpChallenge(challengeId: string): DailyGpChallenge | null {
    const match = /^daily-gp-(\d{4}-\d{2}-\d{2})$/.exec(challengeId);
    if (!match) return null;

    const challengeDate = match[1];
    const trackKey = getBackfilledDailyGpTrackKeyForDate(challengeDate);
    if (!trackKey || !TRACKS[trackKey]) return null;

    const startsAt = getUtcDayStart(challengeDate);
    if (!startsAt) return null;

    return {
        id: createDailyChallengeId(challengeDate),
        challengeDate,
        trackKey,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + DAY_MS).toISOString(),
        availableUntil: new Date(startsAt.getTime() + DAILY_GP_PLAYLIST_DAYS * DAY_MS).toISOString(),
        status: 'active',
        objectiveType: 'single_lap_fastest',
        objectiveParams: {},
        skin: 'default',
    };
}
