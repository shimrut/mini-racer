import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { normalizePodium, readPodiumPostData, renderPodium } from '../podium.js';

function createDocument() {
    return new JSDOM(`
        <h1 id="podium-title"></h1>
        <p id="challenge-date"></p>
        <ol>
            ${[1, 2, 3].map((rank) => `
                <li data-rank="${rank}">
                    <img class="podium-row__avatar podium-row__avatar--generic" src="assets/generic-snoo.svg" alt="">
                    <span class="podium-row__name"></span>
                    <span class="podium-row__time"></span>
                </li>
            `).join('')}
        </ol>
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
            { rank: 1, displayName: 'u/RaceFan', identityType: 'reddit', formattedTime: '18.42', avatarUrl: 'assets/generic-snoo.svg' },
            { rank: 2, displayName: 'Turbo Otter 42', identityType: 'private', formattedTime: '18.76', avatarUrl: 'assets/generic-snoo.svg' },
            { rank: 3, displayName: 'No verified finish', identityType: 'empty', formattedTime: '—', avatarUrl: 'assets/generic-snoo.svg' },
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
        expect(document.querySelectorAll('[data-rank]')).toHaveLength(3);
        expect(Array.from(document.querySelectorAll('.podium-row__name'), (node) => node.textContent)).toEqual([
            'u/Winner',
            'No verified finish',
            'No verified finish',
        ]);
        expect(document.querySelector('[data-rank="1"] .podium-row__avatar').getAttribute('src')).toBe(
            'https://i.redd.it/frozen-avatar.png',
        );
        expect(document.querySelector('[data-rank="1"] .podium-row__avatar').alt).toBe(
            'u/Winner Reddit avatar',
        );
        expect(document.querySelector('[data-rank="2"] .podium-row__avatar').getAttribute('src')).toBe(
            'assets/generic-snoo.svg',
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
        expect(result.positions[2].displayName).toBe('u/Driver');
    });

    it('never renders an unsafe avatar URL and labels private generic Snoos', () => {
        const document = createDocument();
        renderPodium(document, {
            positions: [
                { rank: 1, displayName: 'RaceFan', identityType: 'reddit', formattedTime: '18.42', avatarUrl: 'javascript:alert(1)' },
                { rank: 2, displayName: 'Turbo Otter 42', identityType: 'private', formattedTime: '18.76', avatarUrl: 'https://example.com/leak.png' },
            ],
        });

        const avatars = document.querySelectorAll('.podium-row__avatar');
        expect(avatars[0].getAttribute('src')).toBe('assets/generic-snoo.svg');
        expect(avatars[1].getAttribute('src')).toBe('assets/generic-snoo.svg');
        expect(avatars[1].alt).toBe('Generic Snoo avatar');
    });
});
