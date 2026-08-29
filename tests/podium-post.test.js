import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
    bindPodiumPlayNow,
    bindPodiumReplay,
    hydrateMissingRedditAvatars,
    normalizePodium,
    readPodiumPostData,
    renderPodium,
} from '../podium.js';
import { requestFeaturedDailyChallengeStart } from '../game/daily-challenge/service.js';

vi.mock('../game/daily-challenge/service.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        requestFeaturedDailyChallengeStart: vi.fn(),
    };
});

vi.mock('@devvit/web/client', () => ({
    requestExpandedMode: vi.fn(async () => undefined),
}));

const OFFICIAL_REDDIT_SNOO_URL =
    'https://www.redditstatic.com/avatars/defaults/v2/avatar_default_0.png';

function createDocument() {
    return new JSDOM(`
        <main id="podium-shell" data-mode="podium">
            <h1 id="podium-title"></h1>
            <p id="challenge-date"></p>
            <ol id="podium-list">
                ${[1, 2, 3].map((rank) => `
                    <li data-rank="${rank}">
                        <img class="podium-row__avatar podium-row__avatar--generic" src="${OFFICIAL_REDDIT_SNOO_URL}" alt="">
                        <span class="podium-row__name"></span>
                        <span class="podium-row__time"></span>
                        <button class="podium-row__replay" type="button" data-rank="${rank}" hidden>Replay</button>
                    </li>
                `).join('')}
            </ol>
            <button id="podium-play" type="button">Play Now</button>
            <button id="podium-replay-back" type="button" hidden>Back</button>
        </main>
    `).window.document;
}

describe('podium custom post', () => {
    it('reads only the dedicated podium post payload', () => {
        const podium = { trackName: 'Circuit ProMax' };
        expect(readPodiumPostData({ devvit: { context: { postData: { podium } } } })).toBe(podium);
        expect(readPodiumPostData({ devvit: { context: { postData: null } } })).toBeNull();
    });

    it('normalizes results to exactly three ranked positions', () => {
        const result = normalizePodium({
            trackName: 'Circuit ProMax',
            positions: [
                { rank: 2, displayName: 'Turbo Otter 42', identityType: 'private', formattedTime: '18.76' },
                { rank: 1, displayName: 'RaceFan', identityType: 'reddit', formattedTime: '18.42' },
                { rank: 4, displayName: 'Ignored', identityType: 'private', formattedTime: '20.00' },
            ],
        });

        expect(result.positions).toEqual([
            { rank: 1, displayName: 'RaceFan', identityType: 'reddit', formattedTime: '18.42', avatarUrl: OFFICIAL_REDDIT_SNOO_URL },
            { rank: 2, displayName: 'Turbo Otter 42', identityType: 'private', formattedTime: '18.76', avatarUrl: OFFICIAL_REDDIT_SNOO_URL },
            { rank: 3, displayName: 'No verified finish', identityType: 'empty', formattedTime: '—', avatarUrl: OFFICIAL_REDDIT_SNOO_URL },
        ]);
    });

    it('renders text safely and preserves exactly three DOM rows', () => {
        const document = createDocument();
        renderPodium(document, {
            challengeDate: '2026-07-10',
            trackName: '<img src=x onerror=alert(1)>',
            positions: [
                {
                    rank: 1,
                    displayName: 'u/Winner',
                    identityType: 'reddit',
                    formattedTime: '18.42',
                    avatarUrl: 'https://i.redd.it/frozen-avatar.png',
                },
            ],
        });

        expect(document.getElementById('podium-title').textContent).toBe('<img src=x onerror=alert(1)>');
        expect(document.getElementById('podium-title').querySelector('img')).toBeNull();
        expect(document.getElementById('challenge-date').textContent).toBe('JUL 10, 2026');
        expect(document.querySelectorAll('li[data-rank]')).toHaveLength(3);
        expect(Array.from(document.querySelectorAll('.podium-row__name'), (node) => node.textContent)).toEqual([
            'Winner',
            'No verified finish',
            'No verified finish',
        ]);
        expect(document.querySelector('[data-rank="1"] .podium-row__avatar').getAttribute('src')).toBe(
            'https://i.redd.it/frozen-avatar.png',
        );
        expect(document.querySelector('[data-rank="1"] .podium-row__avatar').alt).toBe(
            'Winner Reddit avatar',
        );
        expect(document.querySelector('[data-rank="2"] .podium-row__avatar').getAttribute('src')).toBe(
            OFFICIAL_REDDIT_SNOO_URL,
        );
    });

    it('treats incomplete or unrecognized identities as empty positions', () => {
        const result = normalizePodium({
            positions: [
                { rank: 1, displayName: 'Hidden', identityType: 'unknown', formattedTime: '18.42' },
                { rank: 2, displayName: 'Named', identityType: 'private', formattedTime: '' },
                { rank: 3, displayName: 'u/Driver', identityType: 'reddit', formattedTime: '19.00' },
            ],
        });

        expect(result.positions[0].identityType).toBe('empty');
        expect(result.positions[1].identityType).toBe('empty');
        expect(result.positions[2].displayName).toBe('Driver');
    });

    it('never renders an unsafe avatar URL and labels the official Reddit fallback', () => {
        const document = createDocument();
        renderPodium(document, {
            positions: [
                { rank: 1, displayName: 'RaceFan', identityType: 'reddit', formattedTime: '18.42', avatarUrl: 'javascript:alert(1)' },
                { rank: 2, displayName: 'Turbo Otter 42', identityType: 'private', formattedTime: '18.76', avatarUrl: 'https://example.com/leak.png' },
            ],
        });

        const avatars = document.querySelectorAll('.podium-row__avatar');
        expect(avatars[0].getAttribute('src')).toBe(OFFICIAL_REDDIT_SNOO_URL);
        expect(avatars[1].getAttribute('src')).toBe(OFFICIAL_REDDIT_SNOO_URL);
        expect(avatars[1].alt).toBe('Official Reddit default Snoo avatar');
    });

    it('hydrates public avatars missing from legacy immutable post data', async () => {
        const podium = normalizePodium({
            positions: [
                { rank: 1, displayName: 'u/shimroot', identityType: 'reddit', formattedTime: '0:10.57' },
                { rank: 2, displayName: 'Private Otter', identityType: 'private', formattedTime: '0:10.60' },
            ],
        });
        const fetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                positions: [{ rank: 1, avatarUrl: 'https://styles.redditmedia.com/shimroot.png' }],
            }),
        }));

        const hydrated = await hydrateMissingRedditAvatars({ fetch }, podium);

        expect(fetch).toHaveBeenCalledWith('/api/podium/avatars');
        expect(hydrated.positions[0]).toMatchObject({
            displayName: 'shimroot',
            avatarUrl: 'https://styles.redditmedia.com/shimroot.png',
        });
        expect(hydrated.positions[1].avatarUrl).toBe(OFFICIAL_REDDIT_SNOO_URL);
    });

    it('Play Now requests today\'s featured track and opens the game entry', async () => {
        const document = createDocument();
        const openGame = vi.fn(async () => undefined);
        const button = bindPodiumPlayNow(document, openGame);
        expect(button).toBeTruthy();

        button.click();

        expect(openGame).toHaveBeenCalledOnce();
    });

    it('featured open path stores the featured-start override before expanding', async () => {
        const { openFeaturedGameFromPodium } = await import('../podium.js');
        const { requestExpandedMode } = await import('@devvit/web/client');
        requestFeaturedDailyChallengeStart.mockClear();
        requestExpandedMode.mockClear();

        await openFeaturedGameFromPodium({ type: 'click' });

        expect(requestFeaturedDailyChallengeStart).toHaveBeenCalledOnce();
        expect(requestExpandedMode).toHaveBeenCalledWith({ type: 'click' }, 'game');
    });

    it('enables Replay only for places with a frozen ghost and keeps Play Now on the post', async () => {
        const document = createDocument();
        const podium = {
            trackName: 'Circuit ProMax',
            positions: [
                { rank: 1, displayName: 'RaceFan', identityType: 'reddit', formattedTime: '0:10.193' },
                { rank: 2, displayName: 'Neon Viper', identityType: 'private', formattedTime: '0:10.199' },
            ],
        };
        globalThis.devvit = { context: { postData: { podium } } };
        renderPodium(document, podium);
        const replay = bindPodiumReplay(document, {
            fetchReplays: async () => ({
                trackKey: 'circuit',
                ghosts: [{
                    rank: 1,
                    ghost: {
                        schemaVersion: 2,
                        sampleIntervalMs: 50,
                        finishTimeMs: 50,
                        origin: [0, 0, 0],
                        deltas: [1, 0, 0],
                    },
                }],
            }),
        });

        await replay.prepareFromServer();

        expect(document.querySelector('[data-rank="1"] .podium-row__replay').hidden).toBe(false);
        expect(document.querySelector('[data-rank="2"] .podium-row__replay').hidden).toBe(true);
        expect(document.getElementById('podium-play').textContent).toBe('Play Now');

        document.querySelector('[data-rank="1"] .podium-row__replay').click();
        expect(replay.mode).toBe('replay');
        expect(document.getElementById('podium-play').hidden).toBe(true);
        expect(document.getElementById('podium-replay-back').hidden).toBe(false);

        document.getElementById('podium-replay-back').click();
        expect(replay.mode).toBe('podium');
        expect(document.getElementById('podium-play').hidden).toBe(false);
        expect(document.querySelector('[data-rank="1"] .podium-row__name').textContent).toBe('RaceFan');
        expect(document.querySelector('[data-rank="1"] .podium-row__replay').disabled).toBe(false);
        expect(document.querySelector('[data-rank="2"] .podium-row__replay').hidden).toBe(true);
        delete globalThis.devvit;
    });
});
