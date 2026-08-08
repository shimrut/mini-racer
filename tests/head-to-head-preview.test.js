import { describe, expect, it, vi } from 'vitest';
import {
    applyHeadToHeadAccessState,
    bindAcceptChallenge,
    ensureChallengePlayerIdentity,
    formatHeadToHeadPreviewTime,
    normalizeHeadToHeadPostData,
    openCampaignAsRedirect,
    openHomeAsRedirect,
    OWN_CHALLENGE_MESSAGE,
    readHeadToHeadPostData,
    resolveHeadToHeadAccess,
    showOwnChallengeMessage,
} from '../head-to-head.js';
import { getGuestPlayerToken, setGuestPlayerToken } from '../game/scoreboard/player-identity.js';
import { LAUNCH_TARGET_KEY } from '../game/modes/launch-target.js';

describe('head-to-head custom-post preview', () => {
    it('reads only the dedicated immutable post type', () => {
        const postData = { postType: 'head-to-head', challengeId: 'challenge-1' };
        expect(readHeadToHeadPostData({ devvit: { context: { postData } } })).toBe(postData);
        expect(readHeadToHeadPostData({
            devvit: { context: { postData: { postType: 'daily-podium' } } },
        })).toBeNull();
    });

    it('normalizes public data without accepting unknown tracks or invalid times', () => {
        expect(normalizeHeadToHeadPostData({
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
        expect(normalizeHeadToHeadPostData({
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
        expect(formatHeadToHeadPreviewTime(25_640)).toBe('25.640');
        expect(formatHeadToHeadPreviewTime(9_005)).toBe('9.005');
        expect(formatHeadToHeadPreviewTime(null)).toBe('—');
    });

    it('blocks guests when the signed-in challenge endpoint rejects them', async () => {
        const guest = await resolveHeadToHeadAccess({
            fetch: vi.fn(async () => ({
                ok: false,
                status: 401,
                json: async () => ({ status: 'signed_in_required' }),
            })),
        });
        expect(guest).toEqual({
            signedIn: false,
            canRace: false,
            ownChallenge: false,
            body: { status: 'signed_in_required' },
        });
    });

    it('treats own_challenge as signed-in but blocked', async () => {
        const access = await resolveHeadToHeadAccess({
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
            canRace: false,
            ownChallenge: true,
            body: {
                status: 'own_challenge',
                error: "You can't accept your own challenge.",
            },
        });
    });

    it('lets a guest with a bootstrapped identity race a ready challenge', async () => {
        const fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                status: 'ready',
                viewerType: 'guest',
                challenge: { challengeId: 'challenge-1' },
            }),
        }));
        const access = await resolveHeadToHeadAccess({
            fetch,
            devvit: { context: { postId: 't3_challenge1' } },
            location: { origin: 'https://miniracer.example' },
        }, 'challenge-1');
        expect(access).toMatchObject({
            signedIn: false,
            canRace: true,
            ownChallenge: false,
            body: { viewerType: 'guest' },
        });
        const requestedUrl = new URL(fetch.mock.calls[0][0]);
        expect(requestedUrl.searchParams.get('challengeId')).toBe('challenge-1');
        expect(requestedUrl.searchParams.get('postId')).toBe('t3_challenge1');
    });

    it('keeps a public ready challenge raceable before the viewer type is known', async () => {
        const access = await resolveHeadToHeadAccess({
            fetch: vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => ({
                    status: 'ready',
                    viewerType: 'anonymous',
                    challenge: { challengeId: 'challenge-1' },
                }),
            })),
        }, 'challenge-1');
        expect(access).toMatchObject({
            signedIn: false,
            canRace: true,
            ownChallenge: false,
        });
    });

    it('rotates a stale guest identity once and keeps the refreshed token', async () => {
        setGuestPlayerToken('stale-token');
        const fetch = vi.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 401,
                json: async () => ({ error: 'Guest token is required for this player.' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    playerId: 'guest:refreshed',
                    guestToken: 'refreshed-token',
                }),
            });

        try {
            await expect(ensureChallengePlayerIdentity({
                fetch,
                location: { origin: 'https://miniracer.example' },
            })).resolves.toBe(true);
            expect(fetch).toHaveBeenCalledTimes(2);
            expect(new URL(fetch.mock.calls[0][0]).searchParams.get('guestToken'))
                .toBe('stale-token');
            expect(new URL(fetch.mock.calls[1][0]).searchParams.get('guestToken'))
                .toBeNull();
            expect(getGuestPlayerToken()).toBe('refreshed-token');
        } finally {
            setGuestPlayerToken(null);
        }
    });

    it('never labels an unavailable or guest-ready challenge as sign-in gated', () => {
        const button = { disabled: true, textContent: '' };
        const message = { textContent: '' };
        applyHeadToHeadAccessState(button, message, {
            signedIn: false,
            canRace: true,
            ownChallenge: false,
        });
        expect(button).toEqual({ disabled: false, textContent: 'Accept Challenge' });
        expect(message.textContent).toBe('');

        applyHeadToHeadAccessState(button, message, {
            signedIn: false,
            canRace: false,
            ownChallenge: false,
            body: { error: 'This challenge is unavailable.' },
        });
        expect(button).toEqual({ disabled: true, textContent: 'Challenge Unavailable' });
        expect(message.textContent).toBe('This challenge is unavailable.');
    });

    it('labels own challenge button as Open Mini Racer', () => {
        const button = { disabled: true, textContent: '' };
        const message = { textContent: '' };
        applyHeadToHeadAccessState(button, message, {
            signedIn: true,
            canRace: false,
            ownChallenge: true,
        });
        expect(button).toEqual({ disabled: false, textContent: 'Open Mini Racer' });
        expect(message.textContent).toBe(OWN_CHALLENGE_MESSAGE);
    });

    it('shows an own-challenge overlay and opens Mini Racer lobby on OK', async () => {
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
        const openLobby = vi.fn(async () => undefined);
        showOwnChallengeMessage(documentRef, openLobby);
        expect(messageEl.textContent).toBe(OWN_CHALLENGE_MESSAGE);
        expect(appended).toContain(overlay);
        await okButton._handler({ type: 'click' });
        expect(openLobby).toHaveBeenCalledTimes(1);
    });

    it('stores a home launch target when redirecting from an own challenge to Mini Racer lobby', async () => {
        const values = new Map();
        const previousStorage = globalThis.localStorage;
        globalThis.localStorage = {
            getItem: (key) => values.get(key) ?? null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: (key) => values.delete(key),
        };
        try {
            await openHomeAsRedirect({ type: 'click' });
            expect(JSON.parse(values.get(LAUNCH_TARGET_KEY)).mode).toBe('home');
        } finally {
            if (previousStorage === undefined) delete globalThis.localStorage;
            else globalThis.localStorage = previousStorage;
        }
    });

    it('binds Accept Challenge once and routes own challenges directly to openOwnChallenge', async () => {
        const listeners = [];
        const button = {
            dataset: {},
            addEventListener: vi.fn((type, handler) => listeners.push([type, handler])),
        };
        const documentRef = {
            getElementById: vi.fn((id) => (id === 'accept-challenge' ? button : null)),
            body: { append: vi.fn() },
        };
        const openGame = vi.fn();
        const openOwnChallenge = vi.fn(async () => undefined);
        bindAcceptChallenge(documentRef, openGame, { ownChallenge: true, openOwnChallenge });
        bindAcceptChallenge(documentRef, openGame, { ownChallenge: true, openOwnChallenge });
        expect(button.addEventListener).toHaveBeenCalledTimes(1);
        expect(listeners[0][0]).toBe('click');
        await listeners[0][1]({ preventDefault: vi.fn() });
        expect(openGame).not.toHaveBeenCalled();
        expect(openOwnChallenge).toHaveBeenCalledTimes(1);
        expect(documentRef.body.append).not.toHaveBeenCalled();
    });
});
