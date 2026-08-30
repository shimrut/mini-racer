import { describe, expect, it } from 'vitest';
import {
    formatDailyPreviewTimeLabel,
    getDailyPreviewChallengeOptions,
    isCurrentDailyLauncherPost,
} from '../preview.js';

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

    it('frames the target as laps followed by time to beat', () => {
        expect(formatDailyPreviewTimeLabel(1)).toBe('1 LAP · TIME TO BEAT');
        expect(formatDailyPreviewTimeLabel(2)).toBe('2 LAPS · TIME TO BEAT');
    });
});
