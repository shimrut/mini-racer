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
            { rank: 1, displayName: 'u/RaceFan', identityType: 'reddit', formattedTime: '18.42' },
            { rank: 2, displayName: 'Turbo Otter 42', identityType: 'private', formattedTime: '18.76' },
            { rank: 3, displayName: 'No verified finish', identityType: 'empty', formattedTime: '—' },
        ]);
    });

    it('renders text safely and preserves exactly three DOM rows', () => {
        const document = createDocument();
        renderPodium(document, {
            challengeDate: '2026-07-10',
            trackName: '<img src=x onerror=alert(1)>',
            positions: [
                { rank: 1, displayName: 'u/Winner', identityType: 'reddit', formattedTime: '18.42' },
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
});
