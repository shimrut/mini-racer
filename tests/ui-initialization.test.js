import { describe, expect, it, vi } from 'vitest';
import { assignGameUiDomRefs } from '../game/race/engine-methods.js';
import { initializeGameUiState } from '../game/race/engine-methods.js';

describe('GameUi initialization helpers', () => {
    it('assigns the expected DOM references onto the ui instance', () => {
        const originalDocument = global.document;
        const createdNodes = new Map();
        const ui = {};

        const getNode = (key) => {
            if (!createdNodes.has(key)) {
                createdNodes.set(key, {
                    key,
                    style: {},
                    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: vi.fn(() => false) },
                    setAttribute: vi.fn(),
                    getAttribute: vi.fn(),
                    addEventListener: vi.fn(),
                    removeEventListener: vi.fn(),
                    querySelector: vi.fn(() => null),
                    closest: vi.fn(() => null)
                });
            }
            return createdNodes.get(key);
        };

        const timeVal = getNode('time-val');
        const timeDisplay = getNode('.hud-stat');
        const timeLabel = getNode('.hud-label');
        timeVal.closest = vi.fn(() => timeDisplay);
        timeDisplay.querySelector = vi.fn(() => timeLabel);

        global.document = {
            querySelector: vi.fn((selector) => getNode(selector)),
            getElementById: vi.fn((id) => getNode(id))
        };

        assignGameUiDomRefs(ui);

        expect(ui.header).toBe(getNode('header'));
        expect(ui.hudBar).toBe(getNode('.hud-bar'));
        expect(ui.timeVal).toBe(timeVal);
        expect(ui.timeDisplay).toBe(timeDisplay);
        expect(ui.timeLabel).toBe(timeLabel);
        expect(ui.modal).toBe(getNode('modal'));
        expect(ui.dailyChallengeHudInline).toBe(getNode('daily-challenge-hud-inline'));
        expect(ui.countdownLights).toEqual([
            getNode('light-1'),
            getNode('light-2'),
            getNode('light-3')
        ]);

        global.document = originalDocument;
    });

    it('initializes callback, cache, and runtime state onto the ui instance', () => {
        const ui = {};
        const callbacks = {
            onPreviewTrack: vi.fn(),
            onPreviewPresentation: vi.fn(),
            onStart: vi.fn(),
            onStartDailyChallenge: vi.fn(),
            onModeSelected: vi.fn(),
            onReset: vi.fn(),
            onSupportClick: vi.fn(),
            onHeaderMenuOpen: vi.fn()
        };

        initializeGameUiState(ui, {
            ...callbacks,
            previewQualityLevel: 2,
            previewFrameSkip: 1,
            readTrackCardRankSnapshots: () => new Map([['circuit:daily:local', { rankLabel: '#3' }]])
        });

        expect(ui._modalPrimaryAction).toBe(callbacks.onReset);
        expect(ui._defaultModalPrimaryAction).toBe(callbacks.onReset);
        expect(ui._returningTrackCards).toBeInstanceOf(Map);
        expect(ui._returningTrackPreviewCanvases).toBeInstanceOf(Map);
        expect(ui._renderedTrackPreviewKeys).toBeInstanceOf(Set);
        expect(ui._returningTrackRankSnapshots).toEqual(new Map([['circuit:daily:local', { rankLabel: '#3' }]]));
        expect(ui._currentTrackKey).toBe('circuit');
        expect(ui._leaderboardRequestId).toBe(0);
        expect(ui._previewQualityLevel).toBe(2);
        expect(ui._previewFrameSkip).toBe(1);
        expect(ui._onPreviewTrack).toBe(callbacks.onPreviewTrack);
        expect(ui._onHeaderMenuOpen).toBe(callbacks.onHeaderMenuOpen);
    });
});
