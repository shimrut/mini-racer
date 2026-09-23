import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
    bindPodiumPlayNow,
    bindPodiumReplay,
    hydrateMissingRedditAvatars,
    normalizePodium,
    podiumPostHasPackedReplays,
    readPodiumPostData,
    renderPodium,
} from '../pages/podium.js';
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
                    </li>
                `).join('')}
            </ol>
            <div class="podium-footer__view" hidden>
                <button id="podium-view-replays" type="button" hidden>View Replays</button>
                <progress id="podium-view-replays-progress" hidden></progress>
            </div>
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

    it('counts Play Now taps for moderator analytics', () => {
        const document = createDocument();
        const reportAnalytics = vi.fn();
        const button = bindPodiumPlayNow(document, vi.fn(), reportAnalytics);

        button.click();

        expect(reportAnalytics).toHaveBeenCalledWith('play');
    });

    it('featured open path stores the featured-start override before expanding', async () => {
        const { openFeaturedGameFromPodium } = await import('../pages/podium.js');
        const { requestExpandedMode } = await import('@devvit/web/client');
        requestFeaturedDailyChallengeStart.mockClear();
        requestExpandedMode.mockClear();

        await openFeaturedGameFromPodium({ type: 'click' });

        expect(requestFeaturedDailyChallengeStart).toHaveBeenCalledOnce();
        expect(requestExpandedMode).toHaveBeenCalledWith({ type: 'click' }, 'game');
    });

    it('treats a replay hash on the post as packed recordings', () => {
        expect(podiumPostHasPackedReplays({
            devvit: { context: { postData: { replayDataHash: 'abc' } } },
        })).toBe(true);
        expect(podiumPostHasPackedReplays({
            devvit: { context: { postData: { podium: {} } } },
        })).toBe(false);
    });

    it('shows View Replays immediately and loads recordings only after tap', async () => {
        const document = createDocument();
        const podium = {
            trackName: 'Circuit ProMax',
            positions: [
                { rank: 1, displayName: 'RaceFan', identityType: 'reddit', formattedTime: '0:10.193' },
                { rank: 2, displayName: 'Neon Viper', identityType: 'private', formattedTime: '0:10.199' },
            ],
        };
        globalThis.devvit = { context: { postData: { podium, replayDataHash: 'abc' } } };
        renderPodium(document, podium);
        let release;
        const fetchReplays = vi.fn(() => new Promise((resolve) => { release = resolve; }));
        const reportAnalytics = vi.fn();
        const replay = bindPodiumReplay(document, { fetchReplays, reportAnalytics });
        const button = document.getElementById('podium-view-replays');
        const progress = document.getElementById('podium-view-replays-progress');
        const wrap = document.querySelector('.podium-footer__view');

        expect(button.hidden).toBe(false);
        expect(wrap.hidden).toBe(false);
        expect(progress.hidden).toBe(true);
        expect(fetchReplays).not.toHaveBeenCalled();
        expect(document.getElementById('podium-play').textContent).toBe('Play Now');

        button.click();
        expect(button.textContent).toBe('Loading');
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(button.disabled).toBe(true);
        expect(progress.hidden).toBe(false);
        expect(replay.mode).toBe('podium');
        expect(fetchReplays).toHaveBeenCalledOnce();
        expect(reportAnalytics).not.toHaveBeenCalled();

        release({
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
        });
        await vi.waitFor(() => expect(replay.mode).toBe('replay'));
        expect(reportAnalytics).toHaveBeenCalledWith('replay');
        expect(document.getElementById('podium-play').hidden).toBe(true);
        expect(button.hidden).toBe(true);
        expect(wrap.hidden).toBe(true);
        expect(document.getElementById('podium-replay-back').hidden).toBe(false);

        document.getElementById('podium-replay-back').click();
        expect(replay.mode).toBe('podium');
        expect(document.getElementById('podium-play').hidden).toBe(false);
        expect(document.querySelector('[data-rank="1"] .podium-row__name').textContent).toBe('RaceFan');
        expect(button.hidden).toBe(false);
        expect(button.textContent).toBe('View Replays');
        expect(progress.hidden).toBe(true);
        delete globalThis.devvit;
    });

    it('keeps View Replays hidden when the post has no packed recordings', () => {
        const document = createDocument();
        const fetchReplays = vi.fn();
        bindPodiumReplay(document, { fetchReplays, replaysAvailable: false });
        expect(document.getElementById('podium-view-replays').hidden).toBe(true);
        expect(fetchReplays).not.toHaveBeenCalled();
    });
});
