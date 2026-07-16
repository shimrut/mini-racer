import { getTrackName } from '../../game/track/catalog.js';
import medalTimes from '../../game/medals/medal-times.json' with { type: 'json' };
import type { DailyGpChallenge } from './daily-gp-model.js';

const DEFAULT_DAILY_POST_TITLE_FORMAT = 'Mini Racer, {displayDate}: {trackName}';
const SHORT_MONTH_NAMES = Object.freeze([
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

type DailyPostTitleTokens = {
    authorMedalTime: string;
    bronzeMedalTime: string;
    challengeDate: string;
    challengeId: string;
    date: string;
    displayDate: string;
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

function formatChallengeDate(value: string, includeYear = false): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return value;

    const [, year, monthText, dayText] = match;
    const month = Number(monthText);
    const day = Number(dayText);
    const monthName = SHORT_MONTH_NAMES[month - 1];
    if (!monthName || day < 1 || day > 31) return value;

    return `${day} ${monthName}${includeYear ? ` ${year}` : ''}`;
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
    return template.replace(/\{(authorMedalTime|bronzeMedalTime|challengeDate|challengeId|date|displayDate|goldMedalTime|medalTimes|personalBest|personalBestTime|silverMedalTime|trackName)\}/g, (_match, key: keyof DailyPostTitleTokens) => {
        return tokens[key];
    });
}

export function formatDailyMiniRacerPostTitle(
    challenge: DailyGpChallenge,
    options: DailyPostTitleOptions = {},
): string {
    const trackName = getTrackName(challenge.trackKey, 'Featured Track');
    const personalBestTime = formatSeconds(options.personalBestSec);
    return applyTitleTemplate(getDailyPostTitleFormat(), {
        challengeDate: challenge.challengeDate,
        challengeId: challenge.id,
        date: challenge.challengeDate,
        displayDate: formatChallengeDate(challenge.challengeDate),
        personalBest: personalBestTime,
        personalBestTime,
        trackName,
        ...getMedalTimeTokens(challenge.trackKey),
    });
}

export function formatDailyMiniRacerTextFallback(challenge: DailyGpChallenge): string {
    const trackName = getTrackName(challenge.trackKey, challenge.trackKey);
    const medalTimeTokens = getMedalTimeTokens(challenge.trackKey);

    return [
        '# Mini Racer Track of the Day',
        '',
        `Today's track: **${trackName}**`,
        `Date: ${formatChallengeDate(challenge.challengeDate, true)}`,
        '',
        'Mini Racer is a free, one-lap daily racing game played directly on Reddit. Race today\'s track, improve your personal best, earn medals, and compete on the live leaderboard.',
        '',
        '## How to play',
        '',
        '- Desktop: use Left/Right Arrow or A/D to steer.',
        '- Mobile: use the on-screen left and right controls.',
        '- There is no separate brake control. The car slows as you turn, so timing and a clean racing line matter.',
        '- Every wall collision slows the car but lets the attempt continue.',
        '- Your fastest verified lap appears on the daily leaderboard.',
        '',
        '## Today\'s medal times',
        '',
        `- Gold: ${medalTimeTokens.goldMedalTime}`,
        `- Silver: ${medalTimeTokens.silverMedalTime}`,
        `- Bronze: ${medalTimeTokens.bronzeMedalTime}`,
        '',
        'Open this post on Reddit and select **Race Now** to play.',
        '',
        'A new track is featured every day, and recent tracks remain playable for seven days.',
    ].join('\n');
}
