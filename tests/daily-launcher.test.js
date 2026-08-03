import { describe, expect, it } from 'vitest';
import {
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
});
