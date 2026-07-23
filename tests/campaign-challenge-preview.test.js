import { describe, expect, it, vi } from 'vitest';
import {
    bindAcceptChallenge,
    formatCampaignChallengePreviewTime,
    normalizeCampaignChallengePostData,
    readCampaignChallengePostData,
    resolveCampaignChallengeAccess,
} from '../campaign-challenge.js';

describe('campaign challenge custom-post preview', () => {
    it('reads only the dedicated immutable post type', () => {
        const postData = { postType: 'campaign-challenge', challengeId: 'challenge-1' };
        expect(readCampaignChallengePostData({ devvit: { context: { postData } } })).toBe(postData);
        expect(readCampaignChallengePostData({
            devvit: { context: { postData: { postType: 'daily-podium' } } },
        })).toBeNull();
    });

    it('normalizes public data without accepting unknown tracks or invalid times', () => {
        expect(normalizeCampaignChallengePostData({
            campaignId: 'numbered-v1',
            challengerUsername: 'RaceFan',
            trackKey: 'numberThree',
            lapCount: 2,
            targetTimeMs: 25_640,
        })).toMatchObject({
            campaignId: 'numbered-v1',
            challengerUsername: 'RaceFan',
            trackKey: 'numberThree',
            lapCount: 2,
            targetTimeMs: 25_640,
        });
        expect(normalizeCampaignChallengePostData({
            trackKey: 'forged',
            targetTimeMs: -1,
        })).toMatchObject({ trackKey: '', targetTimeMs: null });
    });

    it('renders millisecond-precise challenge times', () => {
        expect(formatCampaignChallengePreviewTime(25_640)).toBe('25.640');
        expect(formatCampaignChallengePreviewTime(9_005)).toBe('9.005');
        expect(formatCampaignChallengePreviewTime(null)).toBe('—');
    });

    it('blocks guests when the signed-in challenge endpoint rejects them', async () => {
        const guest = await resolveCampaignChallengeAccess({
            fetch: vi.fn(async () => ({ ok: false, status: 401 })),
        });
        expect(guest).toEqual({ signedIn: false });
    });

    it('binds Accept Challenge once', () => {
        const listeners = [];
        const button = {
            dataset: {},
            addEventListener: vi.fn((type, handler) => listeners.push([type, handler])),
        };
        const documentRef = { getElementById: vi.fn(() => button) };
        bindAcceptChallenge(documentRef, vi.fn());
        bindAcceptChallenge(documentRef, vi.fn());
        expect(button.addEventListener).toHaveBeenCalledTimes(1);
        expect(listeners[0][0]).toBe('click');
    });
});
