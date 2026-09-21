import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    applyHeadToHeadAccessState,
    bindAcceptChallenge,
    formatHeadToHeadPreviewTime,
    normalizeHeadToHeadPostData,
    openHomeAsRedirect,
    OWN_CHALLENGE_MESSAGE,
    posterMedalForChallenge,
    readHeadToHeadPostData,
    readHeadToHeadViewerIdentity,
    renderHeadToHead,
    resolveHeadToHeadPosterAccess,
    showOwnChallengeMessage,
} from '../head-to-head.js';
import { LAUNCH_TARGET_KEY } from '../game/modes/launch-target.js';

afterEach(() => {
    vi.useRealTimers();
});

const PLAYABLE_POST = {
    postType: 'head-to-head',
    challengeId: 'challenge-1',
    challengerUsername: 'RaceFan',
    challengerAvatarUrl: 'https://i.redd.it/avatar.png',
    trackKey: 'numberThree',
    lapCount: 2,
    targetTimeMs: 25_640,
};

describe('head-to-head custom-post preview', () => {
    it('ships an enabled Accept Challenge CTA', () => {
        const html = readFileSync(new URL('../head-to-head.html', import.meta.url), 'utf8');
        expect(html).toMatch(
            /<button id="accept-challenge" type="button">Accept Challenge<\/button>/,
        );
        expect(html).not.toMatch(/Checking Challenge/);
    });

    it('does not fetch challenge access or player bootstrap from the poster', () => {
        const source = readFileSync(new URL('../head-to-head.js', import.meta.url), 'utf8');
        expect(source).not.toMatch(/\/api\/head-to-head/);
        expect(source).not.toMatch(/\/api\/player\/bootstrap/);
    });

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

    it('maps challenge time to the same medal bands the game uses', () => {
        const onNumberThree = (targetTimeMs, lapCount = 1) => posterMedalForChallenge({
            trackKey: 'numberThree',
            lapCount,
            targetTimeMs,
        });
        expect(onNumberThree(15_000)).toBeNull();
        expect(onNumberThree(14_000)).toBe('bronze');
        expect(onNumberThree(13_400)).toBe('silver');
        expect(onNumberThree(12_950)).toBe('gold');
        expect(onNumberThree(12_600)).toBe('author');
        expect(onNumberThree(26_500, 2)).toBe('silver');
        expect(posterMedalForChallenge({ trackKey: '', targetTimeMs: 12_000 })).toBeNull();
    });

    it('stamps the poster medal on the document for the glow and challenger ring', () => {
        const body = {
            attributes: {},
            setAttribute(name, value) { this.attributes[name] = value; },
            removeAttribute(name) { delete this.attributes[name]; },
        };
        const documentRef = {
            body,
            getElementById: vi.fn(() => null),
        };
        renderHeadToHead(documentRef, { ...PLAYABLE_POST, lapCount: 1, targetTimeMs: 12_600 });
        expect(body.attributes['data-medal']).toBe('author');
        renderHeadToHead(documentRef, { ...PLAYABLE_POST, lapCount: 1, targetTimeMs: 20_000 });
        expect(body.attributes['data-medal']).toBeUndefined();
    });

    it('tints only the challenger ring from the same glow token as the corner wash', () => {
        const css = readFileSync(new URL('../head-to-head.css', import.meta.url), 'utf8');
        expect(css).toMatch(/#challenger-avatar\s*\{[^}]*var\(--glow\)/s);
        expect(css).toMatch(/body\[data-medal="author"\]/);
        expect(css).not.toMatch(/#viewer-avatar\s*\{[^}]*var\(--glow\)/s);
    });

    it('reads the viewer name and snoovatar from client context when present', () => {
        expect(readHeadToHeadViewerIdentity({
            devvit: {
                context: {
                    username: '  RaceFan  ',
                    snoovatar: 'https://i.redd.it/me.png',
                },
            },
        })).toEqual({
            username: 'RaceFan',
            avatarUrl: 'https://i.redd.it/me.png',
        });
        expect(readHeadToHeadViewerIdentity({
            devvit: { context: { username: 'RaceFan', snoovatar: 'https://evil.com/me.png' } },
        })).toEqual({
            username: 'RaceFan',
            avatarUrl: null,
        });
        expect(readHeadToHeadViewerIdentity({})).toEqual({
            username: '',
            avatarUrl: null,
        });
    });

    it('enables Accept from post data without a server check', () => {
        expect(resolveHeadToHeadPosterAccess(PLAYABLE_POST, {})).toMatchObject({
            signedIn: false,
            canRace: true,
            ownChallenge: false,
        });
    });

    it('treats a matching client username as the poster\'s own challenge', () => {
        expect(resolveHeadToHeadPosterAccess(PLAYABLE_POST, {
            devvit: { context: { username: 'RaceFan' } },
        })).toMatchObject({
            signedIn: true,
            canRace: false,
            ownChallenge: true,
        });
        expect(resolveHeadToHeadPosterAccess(PLAYABLE_POST, {
            devvit: { context: { username: '  racefan  ' } },
        })).toMatchObject({
            ownChallenge: true,
        });
    });

    it('keeps Accept live when client username is missing', () => {
        expect(resolveHeadToHeadPosterAccess(PLAYABLE_POST, {
            devvit: { context: {} },
        })).toMatchObject({
            canRace: true,
            ownChallenge: false,
        });
    });

    it('disables Accept when the post has no challenge id', () => {
        expect(resolveHeadToHeadPosterAccess({ postType: 'head-to-head' }, {
            devvit: { context: { username: 'RaceFan' } },
        })).toMatchObject({
            canRace: false,
            ownChallenge: false,
        });
        expect(resolveHeadToHeadPosterAccess(null, {})).toMatchObject({
            canRace: false,
            ownChallenge: false,
        });
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
