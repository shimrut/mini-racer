import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const registry = vi.hoisted(() => ({ tracks: new Map(), load: vi.fn() }));
vi.mock('../game/track/client-registry.js', () => ({
    getLoadedClientTrack: (key) => registry.tracks.get(key) || null,
    loadClientTrack: (key) => registry.load(key),
}));
import { TrackCarousel } from '../game/ui/track-carousel.js';
import { LobbyUi } from '../game/lobby/ui.js';

const tiers = ['bronze', 'silver', 'gold', 'author'].map((tier) => ({ tier, filled: tier === 'bronze' }));
const card = (overrides = {}) => ({
    challengeId: 'a', challenge: { id: 'a' }, trackKey: 'circuit',
    trackName: 'Classic Circuit', laps: 2, rankLabel: '#12', medalTiers: tiers,
    ...overrides,
});

describe('selected track caption', () => {
    let dom;
    let originals;
    let carousel;
    let onSelect;
    let onOpenLeaderboard;
    beforeEach(() => {
        originals = { document: global.document, window: global.window };
        dom = new JSDOM(readFileSync(new URL('../pages/game.html', import.meta.url), 'utf8'));
        global.document = dom.window.document;
        global.window = dom.window;
        registry.tracks.clear();
        registry.tracks.set('circuit', { ground: 'dirt' });
        registry.load.mockReset().mockResolvedValue(null);
        onSelect = vi.fn();
        onOpenLeaderboard = vi.fn();
        carousel = new TrackCarousel({ onSelect, onOpenLeaderboard });
        carousel.renderPreview = vi.fn();
        carousel.fitPreviews = vi.fn();
        carousel.bind();
    });
    afterEach(() => {
        clearTimeout(carousel._settleTimer);
        carousel.cancelProgrammaticScroll();
        global.document = originals.document;
        global.window = originals.window;
        dom.window.close();
    });

    it('shows identity, laps/surface, rank and medals once, with a single-line action', () => {
        carousel.render([card()]);
        const parts = carousel._footParts;
        expect(parts.name.textContent).toBe('Classic Circuit');
        expect(parts.name.title).toBe('Classic Circuit');
        expect(parts.detail.textContent).toBe('2 Laps\u2002·\u2002Dirt');
        expect(parts.rankValue.textContent).toBe('#12');
        expect(parts.medal.children).toHaveLength(4);
        expect(document.getElementById('daily-challenge-start-btn').textContent.trim()).toBe('Start Race');
        expect(document.querySelector('#daily-carousel .track-carousel__meta')).toBeNull();
        expect(document.getElementById('daily-carousel-count')).toBeNull();
        expect(document.getElementById('daily-carousel-expiry')).toBeNull();
        const lobby = new LobbyUi();
        lobby.mode = 'daily';
        lobby.setDailySelectedChallenge(card().challenge, card());
        expect(document.querySelector('[data-lobby-mode-selection]').hidden).toBe(true);
        expect(document.querySelector('[data-lobby-subhead-rule]').hidden).toBe(true);
    });

    it('refreshes the caption and pending rank when the selected ID stays the same', () => {
        carousel.render([card()]);
        onSelect.mockClear();
        carousel.render([card({ trackName: 'Updated Circuit', rankPending: true, laps: 1 })]);
        expect(onSelect).not.toHaveBeenCalled();
        expect(carousel._footParts.name.textContent).toBe('Updated Circuit');
        expect(carousel._footParts.detail.textContent).toBe('1 Lap\u2002·\u2002Dirt');
        expect(carousel._footParts.rankValue.textContent).toBe('···');
        expect(carousel._footParts.rank.getAttribute('aria-label')).toContain('loading');
    });

    it('opens standings for the newly selected card from the same rank button', () => {
        const selected = card({ challengeId: 'b', challenge: { id: 'b' }, trackName: 'Second Track', rankLabel: '#8' });
        carousel.render([card(), selected]);
        const rank = carousel._footParts.rank;
        carousel.step(1);
        rank.click();
        expect(onOpenLeaderboard).toHaveBeenCalledWith(selected.challenge, selected);
        expect(carousel._footParts.name.textContent).toBe('Second Track');
        expect(carousel._footParts.rankValue.textContent).toBe('#8');
    });

    it('keeps outgoing and incoming artwork paintable while selection changes', () => {
        const style = document.createElement('style');
        style.textContent = readFileSync(new URL('../styles/track-carousel.css', import.meta.url), 'utf8');
        document.head.append(style);
        carousel.render([card(), card({ challengeId: 'b', challenge: { id: 'b' } })]);
        for (const index of [0, 1, 0]) {
            carousel.select(index);
            for (const element of carousel._elements) {
                expect(element.isConnected).toBe(true);
                expect(dom.window.getComputedStyle(element).visibility).toBe('visible');
                expect(dom.window.getComputedStyle(element).display).not.toBe('none');
            }
        }
    });

    it('preserves scroll position on height-only resizes and recentres after width changes', () => {
        const originalObserver = global.ResizeObserver;
        let resize;
        global.ResizeObserver = class {
            constructor(callback) { resize = callback; }
            observe() {}
        };
        try {
            const campaign = new TrackCarousel({ idPrefix: 'campaign-carousel' });
            let width = 320;
            Object.defineProperty(campaign.viewport, 'clientWidth', { get: () => width });
            campaign.fitPreviews = vi.fn();
            campaign.scrollToSelected = vi.fn();
            campaign.bind();
            campaign.syncCardWidth();
            resize();
            expect(campaign.fitPreviews).toHaveBeenCalledOnce();
            expect(campaign.scrollToSelected).not.toHaveBeenCalled();
            width = 390;
            resize();
            expect(campaign.scrollToSelected).toHaveBeenCalledWith({ animate: false });
        } finally { global.ResizeObserver = originalObserver; }
    });

    it('restores controls after locked, placeholder, error and empty states', () => {
        carousel.render([card({ locked: true, unlockRequirements: [
            { id: 'previous-stage', copy: 'Bronze on previous stage', satisfied: true },
            { id: 'medal-total', copy: 'Two more medals', satisfied: false },
        ] })]);
        const parts = carousel._footParts;
        expect(parts.requirementList.children).toHaveLength(2);
        expect(parts.rank.hidden).toBe(true);
        expect(parts.medal.hidden).toBe(true);
        carousel.render([card({ placeholder: true, trackName: 'In design' })]);
        expect(parts.detail.hidden).toBe(true);
        expect(parts.rank.disabled).toBe(true);
        expect(parts.requirement.hidden).toBe(true);
        carousel.render([card({ verificationError: 'Replay could not be verified' })]);
        expect(parts.verificationError.textContent).toBe('Replay could not be verified');
        expect(parts.rank.hidden).toBe(true);
        parts.rank.click();
        expect(onOpenLeaderboard).not.toHaveBeenCalled();
        carousel.render([]);
        expect(parts.foot.hidden).toBe(true);
        expect(parts.name.textContent).toBe('');
        carousel.render([card({ rankLabel: null })]);
        expect(parts.foot.hidden).toBe(false);
        expect(parts.rank.hidden).toBe(false);
        expect(parts.rank.disabled).toBe(false);
        expect(parts.rankValue.textContent).toBe('—');
        expect(parts.medal.hidden).toBe(false);
        expect(parts.medal.disabled).toBe(false);
        expect(parts.verificationError.hidden).toBe(true);
    });

    it('hydrates the current surface without restoring a previously selected track', async () => {
        let finishOld;
        let finishCurrent;
        registry.load.mockImplementation((key) => new Promise((resolve) => {
            const finish = (track) => { registry.tracks.set(key, track); resolve(track); };
            if (key === 'old') finishOld = finish;
            if (key === 'current') finishCurrent = finish;
        }));
        carousel.render([card({ trackKey: 'old', laps: 1 })]);
        carousel.render([card({ trackKey: 'current', laps: 3 })]);
        finishOld({ ground: 'dirt' });
        await Promise.resolve();
        expect(carousel._footParts.detail.textContent).toBe('3 Laps');
        finishCurrent({ ground: 'snow' });
        await Promise.resolve();
        expect(carousel._footParts.detail.textContent).toBe('3 Laps\u2002·\u2002Snow');
        registry.tracks.set('street', { ground: 'tarmac' });
        carousel.render([card({ trackKey: 'street', laps: 1 })]);
        expect(carousel._footParts.detail.textContent).toBe('1 Lap\u2002·\u2002Street');
        registry.tracks.set('legacy', {});
        carousel.render([card({ trackKey: 'legacy', laps: 2 })]);
        expect(carousel._footParts.detail.textContent).toBe('2 Laps\u2002·\u2002Street');
    });
});
