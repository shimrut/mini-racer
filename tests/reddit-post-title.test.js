import { afterEach, describe, expect, it } from 'vitest';
import {
    formatDailyMiniRacerPostTitle,
    formatDailyMiniRacerTextFallback,
} from '../src/server/posts/reddit-post-title.ts';

const challenge = {
    id: 'daily-gp-2026-06-03',
    challengeDate: '2026-06-03',
    trackKey: 'mistwoodSerpent',
};

describe('reddit post title formatting', () => {
    afterEach(() => {
        delete process.env.MINI_RACER_DAILY_POST_TITLE_FORMAT;
    });

    it('uses the public Mini Racer date and track format by default', () => {
        expect(formatDailyMiniRacerPostTitle(challenge)).toBe(
            'Mini Racer, 3 Jun: Mistwood Serpent',
        );
    });

    it('provides indexable product, controls, competition, and cadence copy in the fallback', () => {
        expect(formatDailyMiniRacerTextFallback(challenge)).toBe([
            '# Mini Racer Track of the Day',
            '',
            "Today's track: **Mistwood Serpent**",
            'Date: 3 Jun 2026',
            'Race format: **1 lap**',
            '',
            "Mini Racer is a free daily racing game played directly on Reddit. Complete today's one-lap race, improve your personal best, earn medals, and compete on the live leaderboard.",
            '',
            '## How to play',
            '',
            '- Desktop: use Left/Right Arrow or A/D to steer.',
            '- Mobile: use the on-screen left and right controls.',
            '- There is no separate brake control. The car slows as you turn, so timing and a clean racing line matter.',
            '- Every wall collision slows the car but lets the attempt continue.',
            '- Your fastest verified complete race appears on the daily leaderboard.',
            '',
            "## Today's medal times",
            '',
            '- Gold: 8.750s',
            '- Silver: 8.910s',
            '- Bronze: 9.090s',
            '',
            'Open this post on Reddit and select **Race Now** to play.',
            '',
            'A new track is featured every day, and recent tracks remain playable for seven days.',
        ].join('\n'));
    });

    it('supports a configured title template', () => {
        process.env.MINI_RACER_DAILY_POST_TITLE_FORMAT = '{date}: Race {trackName}';

        expect(formatDailyMiniRacerPostTitle(challenge)).toBe(
            '2026-06-03: Race Mistwood Serpent',
        );
    });

    it('supports the human-readable date token in configured title templates', () => {
        process.env.MINI_RACER_DAILY_POST_TITLE_FORMAT = '{displayDate}: Race {trackName}';

        expect(formatDailyMiniRacerPostTitle(challenge)).toBe(
            '3 Jun: Race Mistwood Serpent',
        );
    });

    it('supports medal target and personal best tokens', () => {
        process.env.MINI_RACER_DAILY_POST_TITLE_FORMAT = '{trackName} · PB {personalBestTime} · {medalTimes}';

        expect(formatDailyMiniRacerPostTitle(challenge, { personalBestSec: 8.4 })).toBe(
            'Mistwood Serpent · PB 8.400s · Author 8.450s · Gold 8.750s · Silver 8.910s · Bronze 9.090s',
        );
    });

    it('falls back when no personal best is available', () => {
        process.env.MINI_RACER_DAILY_POST_TITLE_FORMAT = 'PB {personalBest}';

        expect(formatDailyMiniRacerPostTitle(challenge)).toBe('PB --');
    });
});
