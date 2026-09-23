import { getTrackName } from '../../../game/track/catalog.js';
import { getDailyChallengeRequiredLaps } from '../../../game/daily-challenge/labels.js';
import { getRaceMedalThresholds } from '../../../game/medals/medal-timing.js';
import type { DailyGpChallenge } from '../daily/daily-gp-model.js';
import { formatChallengeDate } from '../shared/format-race-time.js';

const DEFAULT_DAILY_POST_TITLE_FORMAT = 'Mini Racer, {displayDate}: {trackName}';

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
        ? `${seconds.toFixed(3)}s`
        : '--';
}

function getMedalTimeTokens(trackKey: string, lapCount = 1) {
    const row = getRaceMedalThresholds(trackKey, lapCount) || {};
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
        ...getMedalTimeTokens(challenge.trackKey, getDailyChallengeRequiredLaps(challenge)),
    });
}

export function formatDailyMiniRacerTextFallback(challenge: DailyGpChallenge): string {
    const trackName = getTrackName(challenge.trackKey, challenge.trackKey);
    const lapCount = getDailyChallengeRequiredLaps(challenge);
    const medalTimeTokens = getMedalTimeTokens(challenge.trackKey, lapCount);
    const raceLabel = lapCount === 1 ? 'one-lap race' : `${lapCount}-lap race`;

    return [
        '# Mini Racer Track of the Day',
        '',
        `Today's track: **${trackName}**`,
        `Date: ${formatChallengeDate(challenge.challengeDate, true)}`,
        `Race format: **${lapCount} ${lapCount === 1 ? 'lap' : 'laps'}**`,
        '',
        `Mini Racer is a free daily racing game played directly on Reddit. Complete today's ${raceLabel}, improve your personal best, earn medals, and compete on the live leaderboard.`,
        '',
        '## How to play',
        '',
        '- Desktop: use Left/Right Arrow or A/D to steer.',
        '- Mobile: use the on-screen left and right controls.',
        '- There is no separate brake control. The car slows as you turn, so timing and a clean racing line matter.',
        '- Every wall collision slows the car but lets the attempt continue.',
        '- Your fastest verified complete race appears on the daily leaderboard.',
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
