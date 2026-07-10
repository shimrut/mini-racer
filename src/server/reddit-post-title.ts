import { TRACKS } from '../../game/track/tracks.js';
import medalTimes from '../../game/medals/medal-times.json' with { type: 'json' };
import type { DailyGpChallenge } from './daily-gp-model.js';

const DEFAULT_DAILY_POST_TITLE_FORMAT = 'Mini Racer TOTD - {trackName}';

type DailyPostTitleTokens = {
    authorMedalTime: string;
    bronzeMedalTime: string;
    challengeDate: string;
    challengeId: string;
    date: string;
    goldMedalTime: string;
    medalTimes: string;
    personalBest: string;
    personalBestTime: string;
    silverMedalTime: string;
    trackName: string;
};

type DailyPostTitleOptions = {
    personalBestSec?: number | null;
};

function getDailyPostTitleFormat(): string {
    const configured = process.env.MINI_RACER_DAILY_POST_TITLE_FORMAT;
    return typeof configured === 'string' && configured.trim()
        ? configured.trim()
        : DEFAULT_DAILY_POST_TITLE_FORMAT;
}

function formatSeconds(value: unknown): string {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0
        ? `${seconds.toFixed(2)}s`
        : '--';
}

function getMedalTimeTokens(trackKey: string) {
    const row = (medalTimes as Record<string, Record<string, unknown>>)[trackKey] || {};
    const authorMedalTime = formatSeconds(row.author);
    const goldMedalTime = formatSeconds(row.gold);
    const silverMedalTime = formatSeconds(row.silver);
    const bronzeMedalTime = formatSeconds(row.bronze);
    const medalParts = [
        authorMedalTime !== '--' ? `Author ${authorMedalTime}` : null,
        goldMedalTime !== '--' ? `Gold ${goldMedalTime}` : null,
        silverMedalTime !== '--' ? `Silver ${silverMedalTime}` : null,
        bronzeMedalTime !== '--' ? `Bronze ${bronzeMedalTime}` : null,
    ].filter(Boolean);

    return {
        authorMedalTime,
        bronzeMedalTime,
        goldMedalTime,
        medalTimes: medalParts.length ? medalParts.join(' · ') : '--',
        silverMedalTime,
    };
}

function applyTitleTemplate(template: string, tokens: DailyPostTitleTokens): string {
    return template.replace(/\{(authorMedalTime|bronzeMedalTime|challengeDate|challengeId|date|goldMedalTime|medalTimes|personalBest|personalBestTime|silverMedalTime|trackName)\}/g, (_match, key: keyof DailyPostTitleTokens) => {
        return tokens[key];
    });
}

export function formatDailyMiniRacerPostTitle(
    challenge: DailyGpChallenge,
    options: DailyPostTitleOptions = {},
): string {
    const trackName = TRACKS[challenge.trackKey]?.name || 'Featured Track';
    const personalBestTime = formatSeconds(options.personalBestSec);
    return applyTitleTemplate(getDailyPostTitleFormat(), {
        challengeDate: challenge.challengeDate,
        challengeId: challenge.id,
        date: challenge.challengeDate,
        personalBest: personalBestTime,
        personalBestTime,
        trackName,
        ...getMedalTimeTokens(challenge.trackKey),
    });
}

export function formatDailyMiniRacerTextFallback(challenge: DailyGpChallenge): string {
    return [
        '# Mini Racer TOTD',
        '',
        `Track: ${TRACKS[challenge.trackKey]?.name || challenge.trackKey}`,
        `Date: ${challenge.challengeDate}`,
        '',
        'Playable Reddit racing challenge.',
        '',
        '- One featured track per day',
        '- Fast retries',
        '- Personal best plus live leaderboard',
    ].join('\n');
}
