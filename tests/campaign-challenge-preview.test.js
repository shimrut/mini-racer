import { describe, expect, it, vi } from 'vitest';
import {
    bindAcceptChallenge,
    formatCampaignChallengePreviewTime,
    normalizeCampaignChallengePostData,
    openCampaignAsRedirect,
    OWN_CHALLENGE_MESSAGE,
    readCampaignChallengePostData,
    resolveCampaignChallengeAccess,
    showOwnChallengeMessage,
} from '../campaign-challenge.js';
import { LAUNCH_TARGET_KEY } from '../game/modes/launch-target.js';

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
            challengerAvatarUrl: 'https://i.redd.it/avatar.png',
            trackKey: 'numberThree',
            lapCount: 2,
            targetTimeMs: 25_640,
        })).toMatchObject({
            campaignId: 'numbered-v1',
            challengerUsername: 'RaceFan',
            challengerAvatarUrl: 'https://i.redd.it/avatar.png',
            trackKey: 'numberThree',
            lapCount: 2,
            targetTimeMs: 25_640,
        });
        expect(normalizeCampaignChallengePostData({
            trackKey: 'forged',
            targetTimeMs: -1,
            challengerAvatarUrl: 'https://evil.com/avatar.png',
        })).toMatchObject({
            trackKey: '',
            targetTimeMs: null,
            challengerAvatarUrl: null,
        });
    });

    it('renders millisecond-precise challenge times', () => {
        expect(formatCampaignChallengePreviewTime(25_640)).toBe('25.640');
        expect(formatCampaignChallengePreviewTime(9_005)).toBe('9.005');
        expect(formatCampaignChallengePreviewTime(null)).toBe('—');
    });

    it('blocks guests when the signed-in challenge endpoint rejects them', async () => {
        const guest = await resolveCampaignChallengeAccess({
            fetch: vi.fn(async () => ({
                ok: false,
                status: 401,
                json: async () => ({ status: 'signed_in_required' }),
            })),
        });
        expect(guest).toEqual({
            signedIn: false,
            ownChallenge: false,
            body: { status: 'signed_in_required' },
        });
    });

    it('treats own_challenge as signed-in but blocked', async () => {
        const access = await resolveCampaignChallengeAccess({
            fetch: vi.fn(async () => ({
                ok: false,
                status: 403,
                json: async () => ({
                    status: 'own_challenge',
                    error: "You can't accept your own challenge.",
                }),
            })),
        });
        expect(access).toEqual({
            signedIn: true,
            ownChallenge: true,
            body: {
                status: 'own_challenge',
                error: "You can't accept your own challenge.",
            },
        });
    });

    it('shows an own-challenge overlay and opens Campaign on OK', async () => {
        const appended = [];
        const okButton = {
            textContent: '',
            focus: vi.fn(),
            addEventListener: vi.fn((type, handler) => {
                okButton._handler = handler;
            }),
            className: '',
            type: '',
        };
        const messageEl = { textContent: '', className: '' };
        const overlay = {
            id: '',
            className: '',
            setAttribute: vi.fn(),
            append: vi.fn(),
        };
        const documentRef = {
            getElementById: vi.fn(() => null),
            createElement: vi.fn((tag) => {
                if (tag === 'div') return overlay;
                if (tag === 'p') return messageEl;
                return okButton;
            }),
            body: {
                append: (node) => appended.push(node),
            },
        };
        const openCampaign = vi.fn(async () => undefined);
        showOwnChallengeMessage(documentRef, openCampaign);
        expect(messageEl.textContent).toBe(OWN_CHALLENGE_MESSAGE);
        expect(appended).toContain(overlay);
        await okButton._handler({ type: 'click' });
        expect(openCampaign).toHaveBeenCalledTimes(1);
    });

    it('stores a campaign launch target when redirecting from an own challenge', async () => {
        const values = new Map();
        const previousStorage = globalThis.localStorage;
        globalThis.localStorage = {
            getItem: (key) => values.get(key) ?? null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: (key) => values.delete(key),
        };
        try {
            await openCampaignAsRedirect({ type: 'click' });
            expect(JSON.parse(values.get(LAUNCH_TARGET_KEY)).mode).toBe('campaign');
        } finally {
            if (previousStorage === undefined) delete globalThis.localStorage;
            else globalThis.localStorage = previousStorage;
        }
    });    it('binds Accept Challenge once and routes own challenges to the overlay', async () => {
        const listeners = [];
        const button = {
            dataset: {},
            addEventListener: vi.fn((type, handler) => listeners.push([type, handler])),
        };
        const documentRef = {
            getElementById: vi.fn((id) => (id === 'accept-challenge' ? button : null)),
            createElement: vi.fn(() => ({
                className: '',
                type: '',
                textContent: '',
                focus: vi.fn(),
                addEventListener: vi.fn(),
                setAttribute: vi.fn(),
                append: vi.fn(),
                id: '',
            })),
            body: { append: vi.fn() },
        };
        const openGame = vi.fn();
        bindAcceptChallenge(documentRef, openGame, { ownChallenge: true });
        bindAcceptChallenge(documentRef, openGame, { ownChallenge: true });
        expect(button.addEventListener).toHaveBeenCalledTimes(1);
        expect(listeners[0][0]).toBe('click');
        await listeners[0][1]({ preventDefault: vi.fn() });
        expect(openGame).not.toHaveBeenCalled();
        expect(documentRef.body.append).toHaveBeenCalled();
    });
});
