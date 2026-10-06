import { describe, expect, it } from 'vitest';
import {
    dailyPosterCarTravelAt,
    formatDailyPreviewTimeLabel,
    getDailyPreviewChallengeOptions,
    isCurrentDailyLauncherPost,
} from '../pages/preview.js';

describe('current Daily launcher preview', () => {
    it('marks only the dedicated launcher post as current-only', () => {
        expect(isCurrentDailyLauncherPost({
            devvit: { context: { postData: { postType: 'daily-launcher' } } },
        })).toBe(true);
        expect(isCurrentDailyLauncherPost({
            devvit: { context: { postData: { challengeId: 'frozen-day' } } },
        })).toBe(false);
    });

    it('keeps frozen Daily posts post-bound while bypassing them for the launcher', () => {
        expect(getDailyPreviewChallengeOptions({
            devvit: { context: { postData: { challengeId: 'frozen-day' } } },
        })).toEqual({ allowExpiredPost: true, ignorePostData: false });
        expect(getDailyPreviewChallengeOptions({
            devvit: { context: { postData: { postType: 'daily-launcher' } } },
        })).toEqual({ allowExpiredPost: true, ignorePostData: true });
    });

    it('drives the poster car from the back of the dash to its parking spot', () => {
        expect(dailyPosterCarTravelAt(0)).toBe(0);
        expect(dailyPosterCarTravelAt(240)).toBeGreaterThan(0.5);
        expect(dailyPosterCarTravelAt(480)).toBe(1);
        expect(dailyPosterCarTravelAt(0, { reduceMotion: true })).toBe(1);
    });

    it('omits the lap count on a one-lap Daily and keeps it when more laps are required', () => {
        expect(formatDailyPreviewTimeLabel(1)).toBe('TIME TO BEAT');
        expect(formatDailyPreviewTimeLabel(2)).toBe('2 LAPS · TIME TO BEAT');
    });
});
