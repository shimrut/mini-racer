import { describe, expect, it, vi } from 'vitest';
import {
    buildDailyCarouselCards,
    formatDailyCarouselDayLabel,
    getDailyChallengeDateKey,
} from '../game/daily-challenge/carousel-model.js';
import { findCarouselIndex, TrackCarousel } from '../game/ui/track-carousel.js';
import { LobbyUi } from '../game/lobby/ui.js';

const NOW = Date.parse('2026-07-27T09:00:00.000Z');

function challenge(overrides = {}) {
    return {
        id: 'daily-2026-07-27',
        trackKey: 'circuit',
        challengeDate: '2026-07-27',
        startsAt: '2026-07-27T00:00:00.000Z',
        objectiveType: 'single_lap_fastest',
        skin: 'default',
        ...overrides,
    };
}

describe('daily carousel card model', () => {
    it('labels the run of days as Today, Yesterday, then a date', () => {
        expect(formatDailyCarouselDayLabel(challenge(), NOW)).toBe('Today');
        expect(formatDailyCarouselDayLabel(
            challenge({ challengeDate: '2026-07-26', startsAt: '2026-07-26T00:00:00.000Z' }),
            NOW,
        )).toBe('Yesterday');
        expect(formatDailyCarouselDayLabel(
            challenge({ challengeDate: '2026-07-24', startsAt: '2026-07-24T00:00:00.000Z' }),
            NOW,
        )).toBe('Fri, Jul 24');
        expect(formatDailyCarouselDayLabel({ id: 'no-date' }, NOW)).toBe('Daily');
    });

    it('falls back to startsAt when the challenge has no date key', () => {
        expect(getDailyChallengeDateKey({ startsAt: '2026-07-25T00:00:00.000Z' }))
            .toBe('2026-07-25');
        expect(getDailyChallengeDateKey({ challengeDate: 'not-a-date' })).toBe(null);
    });

    it('drops challenges without a playable track and de-duplicates ids', () => {
        const cards = buildDailyCarouselCards([
            challenge(),
            challenge(),
            challenge({ id: 'missing-track', trackKey: 'not-a-real-track' }),
            challenge({ id: 'no-track-key', trackKey: '' }),
            null,
        ], { nowMs: NOW });

        expect(cards.map((card) => card.challengeId)).toEqual(['daily-2026-07-27']);
    });

    it('keeps the playlist order it is given so the newest day leads', () => {
        const cards = buildDailyCarouselCards([
            challenge({ id: 'd0', challengeDate: '2026-07-27' }),
            challenge({ id: 'd1', trackKey: 'sunlitTemple', challengeDate: '2026-07-26' }),
            challenge({ id: 'd2', trackKey: 'royalPlateau', challengeDate: '2026-07-25' }),
        ], { nowMs: NOW });

        expect(cards.map((card) => card.challengeId)).toEqual(['d0', 'd1', 'd2']);
        expect(cards.map((card) => card.isCurrent)).toEqual([true, false, false]);
    });

    it('separates a rank still loading from a track never raced', () => {
        const snapshots = {
            ranked: { playerRankLabel: '#4' },
            unranked: { playerRankLabel: null },
            placeholder: { playerRankLabel: '--' },
        };
        const cards = buildDailyCarouselCards([
            challenge({ id: 'ranked' }),
            challenge({ id: 'unranked', trackKey: 'sunlitTemple' }),
            challenge({ id: 'placeholder', trackKey: 'royalPlateau' }),
            challenge({ id: 'pending', trackKey: 'mistwoodSerpent' }),
        ], {
            nowMs: NOW,
            getSnapshot: (id) => snapshots[id] || null,
        });

        expect(cards.map((card) => [card.rankLabel, card.rankPending])).toEqual([
            ['#4', false],
            [null, false],
            [null, false],
            [null, true],
        ]);
    });

    it('reports laps and the personal best, and no medal without a time', () => {
        const [multiLap, noBest] = buildDailyCarouselCards([
            challenge({
                id: 'multi',
                objectiveType: 'multi_lap_total',
                objectiveParams: { lapCount: 3 },
                trackPersonalBest: { bestTime: 42.5 },
            }),
            challenge({ id: 'none', trackKey: 'sunlitTemple', trackPersonalBest: null }),
        ], { nowMs: NOW });

        expect(multiLap.laps).toBe(3);
        expect(multiLap.lapsLabel).toBe('3 Laps');
        expect(multiLap.modeLabel).toBe('Daily');
        expect(multiLap.billingLabel).toBe('Today');
        expect(multiLap.bestLabel).toBe('42.500');
        expect(multiLap.metaLabel).toBe('3 Laps · PB 42.500');
        expect(noBest.lapsLabel).toBe('1 Lap');
        expect(noBest.bestLabel).toBe(null);
        expect(noBest.medal).toBe(null);
    });

    it('lists every medal tier the track offers, marking the ones earned', () => {
        const [earned, none] = buildDailyCarouselCards([
            challenge({ id: 'earned', trackPersonalBest: { bestTime: 1 } }),
            challenge({ id: 'none', trackKey: 'sunlitTemple', trackPersonalBest: null }),
        ], { nowMs: NOW });

        expect(earned.medalTiers.map((slot) => slot.tier))
            .toEqual(['bronze', 'silver', 'gold', 'author']);
        expect(earned.medalTiers.every((slot) => slot.filled)).toBe(true);

        expect(none.medal).toBe(null);
        expect(none.medalTiers.length).toBeGreaterThan(0);
        expect(none.medalTiers.some((slot) => slot.filled)).toBe(false);
    });

    it('finds a challenge index and reports a miss', () => {
        const cards = buildDailyCarouselCards([
            challenge({ id: 'a' }),
            challenge({ id: 'b', trackKey: 'sunlitTemple' }),
        ], { nowMs: NOW });

        expect(findCarouselIndex(cards, 'b')).toBe(1);
        expect(findCarouselIndex(cards, 'gone')).toBe(-1);
        expect(findCarouselIndex(cards, null)).toBe(-1);
    });
});

describe('Daily Start Race race brief', () => {
    it('puts a bold track name, separator, and labelled lap count below Start Race', () => {
        const originalDocument = global.document;
        const track = { hidden: true, textContent: '' };
        const separator = { hidden: true, textContent: '·' };
        const laps = {
            hidden: true,
            textContent: '',
            setAttribute: vi.fn(),
            removeAttribute: vi.fn(),
        };
        const brief = {
            hidden: true,
            textContent: '',
            setAttribute: vi.fn(),
            querySelector: (selector) => ({
                '.main-menu__race-brief-track': track,
                '.main-menu__race-brief-separator': separator,
                '.main-menu__race-brief-laps': laps,
            }[selector] || null),
        };
        const button = {
            querySelector: (selector) => selector === '.main-menu__race-brief' ? brief : null,
        };
        global.document = {
            getElementById: (id) => id === 'daily-challenge-start-btn' ? button : null,
        };

        try {
            const lobby = new LobbyUi();
            lobby.setDailySelectedChallenge(
                { id: 'multi-lap-day' },
                { trackName: 'Classic Circuit', laps: 3 },
            );
            expect(track.textContent).toBe('Classic Circuit');
            expect(track.hidden).toBe(false);
            expect(separator.hidden).toBe(false);
            expect(laps.textContent).toBe('3 Laps');
            expect(laps.hidden).toBe(false);
            expect(laps.setAttribute).toHaveBeenCalledWith('aria-label', '3 Laps');
            expect(brief.hidden).toBe(false);

            lobby.setDailySelectedChallenge(
                { id: 'single-lap-day' },
                { trackName: 'Sunlit Temple', laps: 1 },
            );
            expect(track.textContent).toBe('Sunlit Temple');
            expect(separator.hidden).toBe(false);
            expect(laps.textContent).toBe('1 Lap');
            expect(laps.setAttribute).toHaveBeenLastCalledWith('aria-label', '1 Lap');
        } finally {
            global.document = originalDocument;
        }
    });
});

function createStubbedCarousel(count = 5, { cardWidth = 240, viewportWidth = 320 } = {}) {
    const onSelect = vi.fn();
    const onOpenLeaderboard = vi.fn();
    const carousel = new TrackCarousel({ onSelect, onOpenLeaderboard });
    const gap = 10;
    const prevBtn = { disabled: false, hidden: false };
    const nextBtn = { disabled: false, hidden: false };
    const navigation = { hidden: false };
    const countLabel = {
        textContent: '',
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
    };
    const railWidth = 80 + (count * cardWidth) + ((count - 1) * gap);
    const viewport = { clientWidth: viewportWidth, scrollLeft: 0, scrollWidth: railWidth };
    const railStyleValues = new Map();
    const rail = {
        style: {
            setProperty: vi.fn((name, value) => railStyleValues.set(name, value)),
            getPropertyValue: vi.fn((name) => railStyleValues.get(name) || ''),
        },
    };

    carousel._cards = Array.from({ length: count }, (_, index) => ({
        challengeId: `c${index}`,
        challenge: { id: `c${index}` },
        trackName: `Track ${index}`,
    }));
    carousel._elements = carousel._cards.map((_, index) => {
        const custom = new Map();
        return {
            offsetLeft: 40 + index * (cardWidth + gap),
            offsetWidth: cardWidth,
            classList: { toggle: vi.fn() },
            setAttribute: vi.fn(),
            style: {
                setProperty: (name, value) => custom.set(name, value),
                getPropertyValue: (name) => custom.get(name) || '',
            },
            _parts: { rank: { tabIndex: 0 } },
        };
    });
    carousel._selectedIndex = 0;

    Object.defineProperty(carousel, 'viewport', { get: () => viewport });
    Object.defineProperty(carousel, 'rail', { get: () => rail });
    Object.defineProperty(carousel, 'prevBtn', { get: () => prevBtn });
    Object.defineProperty(carousel, 'nextBtn', { get: () => nextBtn });
    Object.defineProperty(carousel, 'navigation', { get: () => navigation });
    Object.defineProperty(carousel, 'countLabel', { get: () => countLabel });

    return {
        carousel,
        onSelect,
        onOpenLeaderboard,
        viewport,
        rail,
        prevBtn,
        nextBtn,
        navigation,
        countLabel,
        cardWidth,
        gap,
    };
}

describe('TrackCarousel selection', () => {
    it('steps with A/D and arrows and stops at both ends', () => {
        const { carousel, onSelect } = createStubbedCarousel(3);

        expect(carousel.handleNavDirection('left')).toBe(true);
        expect(carousel.getSelectedChallengeId()).toBe('c0');

        carousel.handleNavDirection('right');
        carousel.handleNavDirection('right');
        carousel.handleNavDirection('right');
        expect(carousel.getSelectedChallengeId()).toBe('c2');
        expect(onSelect).toHaveBeenCalledTimes(2);
    });

    it('leaves the vertical axis to the lobby menu', () => {
        const { carousel } = createStubbedCarousel(3);
        expect(carousel.handleNavDirection('up')).toBe(false);
        expect(carousel.handleNavDirection('down')).toBe(false);
    });

    it('consumes horizontal keys even at the ends so focus does not jump away', () => {
        const { carousel } = createStubbedCarousel(2);
        carousel.select(1);
        expect(carousel.handleNavDirection('right')).toBe(true);
        expect(carousel.getSelectedChallengeId()).toBe('c1');
    });

    it('disables the chevron that has nowhere to go', () => {
        const { carousel, prevBtn, nextBtn } = createStubbedCarousel(3);

        carousel.syncNavButtons();
        expect(prevBtn.disabled).toBe(true);
        expect(nextBtn.disabled).toBe(false);

        carousel.select(2);
        expect(prevBtn.disabled).toBe(false);
        expect(nextBtn.disabled).toBe(true);
    });

    it('shows the selected track position between the navigation controls', () => {
        const { carousel, countLabel, navigation } = createStubbedCarousel(3);

        carousel.syncNavButtons();
        expect(navigation.hidden).toBe(false);
        expect(countLabel.textContent).toBe('1 / 3');
        expect(countLabel.setAttribute).toHaveBeenLastCalledWith(
            'aria-label',
            'Track 1 of 3',
        );

        carousel.select(2);
        expect(countLabel.textContent).toBe('3 / 3');
        expect(countLabel.setAttribute).toHaveBeenLastCalledWith(
            'aria-label',
            'Track 3 of 3',
        );
    });

    it('hides both chevrons when there is only one day to show', () => {
        const { carousel, prevBtn, nextBtn } = createStubbedCarousel(1);
        carousel.syncNavButtons();
        expect(prevBtn.hidden).toBe(true);
        expect(nextBtn.hidden).toBe(true);
    });

    it('adopts the card nearest the viewport centre after a swipe', () => {
        const { carousel, onSelect, viewport, cardWidth, gap } = createStubbedCarousel(5);
        const centreOn = (index) => {
            const element = carousel._elements[index];
            viewport.scrollLeft = element.offsetLeft
                - ((viewport.clientWidth - element.offsetWidth) / 2);
        };

        centreOn(3);
        carousel.syncSelectionFromScroll();
        expect(carousel.getSelectedChallengeId()).toBe('c3');
        expect(onSelect).toHaveBeenCalledWith({ id: 'c3' }, expect.objectContaining({
            challengeId: 'c3',
        }));

        centreOn(2);
        viewport.scrollLeft += (cardWidth + gap) * 0.4;
        carousel.syncSelectionFromScroll();
        expect(carousel.getSelectedChallengeId()).toBe('c2');
    });

    it('ignores zero-width hidden-pane geometry instead of changing the active track', () => {
        const { carousel, onSelect, viewport } = createStubbedCarousel(4);
        carousel._selectedIndex = 2;
        viewport.clientWidth = 0;
        viewport.scrollLeft = 0;

        carousel.syncSelectionFromScroll();

        expect(carousel.getSelectedChallengeId()).toBe('c2');
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('lets a swipe interrupt programmatic centring and update the Start target', () => {
        const { carousel, onSelect, viewport } = createStubbedCarousel(4);
        carousel.beginProgrammaticScroll();
        expect(carousel._suppressScrollSync).toBe(true);

        carousel.handleUserScrollIntent();
        const element = carousel._elements[3];
        viewport.scrollLeft = element.offsetLeft
            - ((viewport.clientWidth - element.offsetWidth) / 2);
        carousel.handleScroll();

        expect(carousel._suppressScrollSync).toBe(false);
        return new Promise((resolve) => {
            setTimeout(() => {
                expect(carousel.getSelectedChallengeId()).toBe('c3');
                expect(onSelect).toHaveBeenCalledWith(
                    { id: 'c3' },
                    expect.objectContaining({ challengeId: 'c3' }),
                );
                resolve();
            }, 25);
        });
    });

    it('uses measured edge spacing so the final card can reach the centre', () => {
        const { carousel, rail } = createStubbedCarousel(5, {
            cardWidth: 240,
            viewportWidth: 320,
        });

        expect(carousel.syncEdgeSpacing(carousel._elements[4])).toBe(true);
        expect(rail.style.setProperty).toHaveBeenCalledWith(
            '--track-carousel-edge-space',
            '40px',
        );
    });

    it('tops the tail up by however far the rail falls short of centring the last card', () => {
        const { carousel, viewport, rail } = createStubbedCarousel(5, {
            cardWidth: 240,
            viewportWidth: 320,
        });
        const last = carousel._elements[4];
        const needed = last.offsetLeft + (last.offsetWidth / 2) - (viewport.clientWidth / 2);
        viewport.scrollWidth = needed + viewport.clientWidth - 40;

        carousel.syncEdgeSpacing(last);

        expect(rail.style.setProperty).toHaveBeenCalledWith(
            '--track-carousel-tail-shortfall',
            '40px',
        );
    });

    it('leaves the tail alone on an engine that already lays the rail out long enough', () => {
        const { carousel, rail } = createStubbedCarousel(5, {
            cardWidth: 240,
            viewportWidth: 320,
        });

        carousel.syncEdgeSpacing(carousel._elements[4]);

        expect(rail.style.setProperty).not.toHaveBeenCalledWith(
            '--track-carousel-tail-shortfall',
            expect.anything(),
        );
    });

    it('publishes how close each card is to the centre, not just which one holds it', () => {
        const { carousel, viewport, cardWidth, gap } = createStubbedCarousel(5, {
            cardWidth: 240,
            viewportWidth: 320,
        });
        const proximityOf = (index) => Number(
            carousel._elements[index].style.getPropertyValue('--card-proximity'),
        );

        const centred = carousel._elements[1];
        const centredScroll = centred.offsetLeft + (cardWidth / 2) - (viewport.clientWidth / 2);
        carousel._selectedIndex = 1;
        viewport.scrollLeft = centredScroll;
        carousel.updateProximity();
        expect(proximityOf(1)).toBe(1);
        expect(proximityOf(2)).toBe(0);

        viewport.scrollLeft = centredScroll + ((cardWidth + gap) / 2);
        carousel.updateProximity();
        expect(proximityOf(1)).toBeGreaterThan(0);
        expect(proximityOf(1)).toBeLessThan(1);
        expect(proximityOf(2)).toBeCloseTo(proximityOf(1), 2);
    });

    it('keeps a card visible before the pane has any geometry to measure', () => {
        const { carousel, viewport } = createStubbedCarousel(3);
        viewport.clientWidth = 0;
        carousel._selectedIndex = 2;

        carousel.updateProximity();

        expect(carousel._elements[2].style.getPropertyValue('--card-proximity')).toBe('1.000');
        expect(carousel._elements[0].style.getPropertyValue('--card-proximity')).toBe('0.000');
    });

    it('jumps to a challenge by id and reports when it is not on the rail', () => {
        const { carousel } = createStubbedCarousel(4);

        expect(carousel.selectChallenge('c2')).toBe(true);
        expect(carousel.getSelectedChallengeId()).toBe('c2');
        expect(carousel.selectChallenge('missing')).toBe(false);
        expect(carousel.getSelectedChallengeId()).toBe('c2');
    });

    it('has nothing selected while the rail is empty', () => {
        const carousel = new TrackCarousel();
        expect(carousel.isEmpty()).toBe(true);
        expect(carousel.getSelectedChallenge()).toBe(null);
        expect(carousel.handleNavDirection('right')).toBe(false);
    });

    it('reports the empty rail as a selection so stale details can be cleared', () => {
        const { carousel, onSelect, rail } = createStubbedCarousel(3);
        rail.replaceChildren = vi.fn();

        carousel.render([]);

        expect(carousel.isEmpty()).toBe(true);
        expect(onSelect).toHaveBeenCalledWith(null, null);
    });

    it('repaints every existing preview without rebuilding or moving the selection', () => {
        const carousel = new TrackCarousel();
        const firstCanvas = {};
        const secondCanvas = {};
        carousel._cards = [
            { challengeId: 'c0' },
            { challengeId: 'c1' },
        ];
        carousel._elements = [
            { dataset: { index: '0' }, _parts: { canvas: firstCanvas } },
            { dataset: { index: '1' }, _parts: { canvas: secondCanvas } },
        ];
        carousel._selectedIndex = 1;
        carousel.renderPreview = vi.fn();

        carousel.refreshPreviews();

        expect(carousel.renderPreview).toHaveBeenCalledTimes(2);
        expect(carousel.renderPreview).toHaveBeenNthCalledWith(
            1,
            firstCanvas,
            carousel._cards[0],
            { force: true },
        );
        expect(carousel.renderPreview).toHaveBeenNthCalledWith(
            2,
            secondCanvas,
            carousel._cards[1],
            { force: true },
        );
        expect(carousel.getSelectedChallengeId()).toBe('c1');
    });

    it('invalidates a schematic preview when the selected Garage car changes', () => {
        const OriginalPath2D = globalThis.Path2D;
        const originalDocument = globalThis.document;
        globalThis.Path2D = class Path2DMock {
            addPath() {}
            moveTo() {}
            lineTo() {}
            quadraticCurveTo() {}
            closePath() {}
        };
        const createContext = () => new Proxy({
            clearRect: vi.fn(),
            drawImage: vi.fn(),
            createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
            createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
        }, {
            get(target, property) {
                if (!(property in target)) target[property] = vi.fn();
                return target[property];
            },
        });
        const offscreenContexts = [];
        globalThis.document = {
            createElement: vi.fn(() => {
                const context = createContext();
                offscreenContexts.push(context);
                return {
                    width: 0,
                    height: 0,
                    getContext: () => context,
                };
            }),
        };
        const mainContext = createContext();
        const canvas = {
            width: 320,
            height: 200,
            dataset: {},
            getContext: () => mainContext,
        };
        const firstCar = { id: 'red-car' };
        const secondCar = { id: 'blue-car' };
        let selectedCar = {
            assetKey: 'assets/cars/red.webp',
            image: firstCar,
            worldSize: { width: 1.3, height: 1.3 },
        };
        const carousel = new TrackCarousel({
            previewCacheNamespace: 'garage-car-preview-test',
            getPreviewCarImage: () => selectedCar.image,
            getPreviewCarAssetKey: () => selectedCar.assetKey,
            getPreviewCarWorldSize: () => selectedCar.worldSize,
        });
        const card = { trackKey: 'circuit', skin: 'default' };

        try {
            carousel.renderPreview(canvas, card);
            expect(canvas.dataset.previewKey).toContain(selectedCar.assetKey);
            expect(offscreenContexts[0].drawImage).toHaveBeenCalledWith(
                firstCar,
                expect.any(Number),
                expect.any(Number),
                expect.closeTo(24.24, 1),
                expect.closeTo(24.24, 1),
            );

            selectedCar = {
                assetKey: 'assets/cars/blue.webp',
                image: secondCar,
                worldSize: { width: 1.3, height: 1.3 },
            };
            carousel.renderPreview(canvas, card);

            expect(globalThis.document.createElement).toHaveBeenCalledTimes(2);
            expect(canvas.dataset.previewKey).toContain(selectedCar.assetKey);
            expect(offscreenContexts[1].drawImage).toHaveBeenCalledWith(
                secondCar,
                expect.any(Number),
                expect.any(Number),
                expect.closeTo(24.24, 1),
                expect.closeTo(24.24, 1),
            );
        } finally {
            globalThis.Path2D = OriginalPath2D;
            if (originalDocument === undefined) {
                delete globalThis.document;
            } else {
                globalThis.document = originalDocument;
            }
        }
    });

    it('brackets the cards with real spacers so both ends can reach the centre', () => {
        const attributes = new WeakMap();
        globalThis.document = {
            createElement: () => {
                const node = { className: '' };
                attributes.set(node, new Map());
                node.setAttribute = (name, value) => attributes.get(node).set(name, value);
                node.getAttribute = (name) => attributes.get(node).get(name) ?? null;
                return node;
            },
        };

        try {
            const carousel = new TrackCarousel();
            const lead = carousel.edgeSpacer('lead');
            const tail = carousel.edgeSpacer('tail');

            expect(lead.className).toContain('track-carousel__edge--lead');
            expect(tail.className).toContain('track-carousel__edge--tail');
            expect(lead.getAttribute('aria-hidden')).toBe('true');
            expect(carousel.edgeSpacer('lead')).toBe(lead);
            expect(lead).not.toBe(tail);
        } finally {
            delete globalThis.document;
        }
    });

    it('keeps the standings value icon-only while preserving the rank action', () => {
        const carousel = new TrackCarousel();
        carousel._footParts = {
            bestCell: { hidden: true, classList: { toggle: vi.fn() } },
            bestValue: { textContent: '' },
            rank: {
                hidden: true,
                disabled: true,
                classList: { toggle: vi.fn() },
                setAttribute: vi.fn(),
            },
            rankIcon: { hidden: true },
            rankValue: { hidden: true, textContent: '' },
            rankMedal: { hidden: true, dataset: {}, setAttribute: vi.fn() },
            medal: { hidden: true, dataset: { medalKey: '' } },
            requirement: { hidden: false },
            requirementList: { replaceChildren: vi.fn() },
            meta: { hidden: true },
        };

        carousel.paintFoot({
            locked: false,
            bestLabel: '12.345',
            rankPending: false,
            rankLabel: '#4',
            trackName: 'Circuit',
            medalTiers: [],
        });

        const parts = carousel._footParts;
        expect(parts.rank.hidden).toBe(false);
        expect(parts.rank.disabled).toBe(false);
        expect(parts.rankIcon.hidden).toBe(false);
        expect(parts.rankValue.hidden).toBe(false);
        expect(parts.rankValue.textContent).toBe('#4');
        expect(parts.rankMedal.hidden).toBe(true);
        expect(parts.rank.setAttribute).toHaveBeenCalledWith(
            'aria-label',
            'Circuit standings. Your rank: #4',
        );
    });
});

describe('lobby keyboard handoff to the carousels', () => {
    function keyEvent(key, overrides = {}) {
        return {
            key,
            target: { tagName: 'BODY' },
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
            ...overrides,
        };
    }

    it('gives A/D and the arrows to whichever picker pane is open', () => {
        const onCarouselNavigate = vi.fn(() => true);
        const lobby = new LobbyUi({ onCarouselNavigate });

        for (const mode of ['daily', 'campaign']) {
            lobby.mode = mode;
            for (const [key, direction] of [
                ['ArrowLeft', 'left'],
                ['a', 'left'],
                ['ArrowRight', 'right'],
                ['d', 'right'],
            ]) {
                const event = keyEvent(key);
                expect(lobby.handleCarouselKeydown(event)).toBe(true);
                expect(onCarouselNavigate).toHaveBeenCalledWith(mode, direction);
                expect(event.preventDefault).toHaveBeenCalled();
            }
        }
    });

    it('leaves the vertical axis and non-picker panes to the menu', () => {
        const onCarouselNavigate = vi.fn(() => true);
        const lobby = new LobbyUi({ onCarouselNavigate });

        lobby.mode = 'daily';
        expect(lobby.handleCarouselKeydown(keyEvent('ArrowDown'))).toBe(false);
        expect(lobby.handleCarouselKeydown(keyEvent('Enter'))).toBe(false);

        lobby.mode = 'challenge';
        expect(lobby.handleCarouselKeydown(keyEvent('ArrowLeft'))).toBe(false);
        lobby.mode = 'home';
        expect(lobby.handleCarouselKeydown(keyEvent('ArrowLeft'))).toBe(false);
        expect(onCarouselNavigate).not.toHaveBeenCalled();
    });

    it('keeps typing and browser shortcuts out of the carousel', () => {
        const onCarouselNavigate = vi.fn(() => true);
        const lobby = new LobbyUi({ onCarouselNavigate });
        lobby.mode = 'daily';

        expect(lobby.handleCarouselKeydown(
            keyEvent('a', { target: { tagName: 'INPUT' } }),
        )).toBe(false);
        expect(lobby.handleCarouselKeydown(
            keyEvent('ArrowRight', { metaKey: true }),
        )).toBe(false);
        expect(onCarouselNavigate).not.toHaveBeenCalled();
    });

    it('hands the key back when the carousel will not take it', () => {
        const lobby = new LobbyUi({ onCarouselNavigate: () => false });
        lobby.mode = 'daily';
        expect(lobby.handleCarouselKeydown(keyEvent('ArrowLeft'))).toBe(false);
    });
});
