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
} from '../pages/head-to-head.js';
import { CHALLENGE_UNAVAILABLE_MESSAGE } from '../game/head-to-head/poster-access.js';
import { LAUNCH_TARGET_KEY } from '../game/modes/launch-target.js';

vi.mock('@devvit/web/client', () => ({
    requestExpandedMode: vi.fn(async () => undefined),
}));

afterEach(() => {
    vi.useRealTimers();
});

const PLAYABLE_POST = {
    postType: 'head-to-head',
    challengeId: 'challenge-1',
    challengerUsername: 'RaceFan',
    challengerUserId: 't2_racefan',
    challengerAvatarUrl: 'https://i.redd.it/avatar.png',
    trackKey: 'numberThree',
    lapCount: 2,
    targetTimeMs: 25_640,
};

function accessRoot(postData = PLAYABLE_POST, context = {}) {
    return { devvit: { context: { postData, ...context } } };
}

describe('head-to-head custom-post preview', () => {
    it('ships an enabled Accept Challenge CTA from the early accept entry', () => {
        const html = readFileSync(new URL('../pages/head-to-head.html', import.meta.url), 'utf8');
        expect(html).toMatch(
            /<script type="module" src="head-to-head-accept\.js"><\/script>/,
        );
        expect(html).not.toMatch(/src="head-to-head\.js"/);
        expect(html).toMatch(
            /<button id="accept-challenge" type="button">Accept Challenge<\/button>/,
        );
        expect(html).not.toMatch(/Checking Challenge/);
        const accept = readFileSync(new URL('../pages/head-to-head-accept.js', import.meta.url), 'utf8');
        expect(accept).toMatch(/import\('\.\/head-to-head\.js'\)/);
    });

    it('does not fetch challenge access or player bootstrap from the poster', () => {
        const files = ['pages/head-to-head.js', 'pages/head-to-head-accept.js', 'game/head-to-head/poster-access.js'];
        for (const file of files) {
            const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
            expect(source, file).not.toMatch(/\/api\/head-to-head/);
            expect(source, file).not.toMatch(/\/api\/player\/bootstrap/);
        }
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
        const css = readFileSync(new URL('../pages/head-to-head.css', import.meta.url), 'utf8');
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
        expect(resolveHeadToHeadPosterAccess(accessRoot())).toMatchObject({
            signedIn: false,
            canRace: true,
            ownChallenge: false,
        });
    });

    it('treats a matching stored account ID as the poster\'s own challenge', () => {
        expect(resolveHeadToHeadPosterAccess(accessRoot(PLAYABLE_POST, {
            userId: 't2_racefan',
            username: 'SomeoneElse',
        }))).toMatchObject({
            signedIn: true,
            canRace: false,
            ownChallenge: true,
        });
    });

    it('falls back to postAuthorId when the post carries no account ID', () => {
        const { challengerUserId: _ignored, ...legacy } = PLAYABLE_POST;
        expect(resolveHeadToHeadPosterAccess(accessRoot(legacy, {
            userId: 't2_racefan',
            postAuthorId: 't2_racefan',
        }))).toMatchObject({
            ownChallenge: true,
        });
        expect(resolveHeadToHeadPosterAccess(accessRoot(legacy, {
            userId: 't2_racefan',
        }))).toMatchObject({
            ownChallenge: false,
            canRace: true,
        });
    });

    it('does not treat a matching name as own-post', () => {
        expect(resolveHeadToHeadPosterAccess(accessRoot(PLAYABLE_POST, {
            username: 'RaceFan',
        }))).toMatchObject({
            signedIn: false,
            canRace: true,
            ownChallenge: false,
        });
    });

    it('keeps Accept live when the viewer ID is missing', () => {
        expect(resolveHeadToHeadPosterAccess(accessRoot(PLAYABLE_POST, {
            username: 'RaceFan',
        }))).toMatchObject({
            canRace: true,
            ownChallenge: false,
        });
    });

    it('disables Accept when the post has no challenge id', () => {
        expect(resolveHeadToHeadPosterAccess(accessRoot(
            { postType: 'head-to-head' },
            { userId: 't2_racefan' },
        ))).toMatchObject({
            canRace: false,
            ownChallenge: false,
        });
        expect(resolveHeadToHeadPosterAccess({})).toMatchObject({
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

        applyHeadToHeadAccessState(button, message, resolveHeadToHeadPosterAccess(
            accessRoot({ postType: 'head-to-head' }),
        ));
        expect(button).toEqual({ disabled: true, textContent: 'Challenge Unavailable' });
        expect(message.textContent).toBe(CHALLENGE_UNAVAILABLE_MESSAGE);
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
