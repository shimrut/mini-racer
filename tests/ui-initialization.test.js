import { describe, expect, it, vi } from 'vitest';
import { RaceHud } from '../game/race/ui-hud.js';
import { DailyChallengeUi } from '../game/daily-challenge/ui.js';

describe('GameUi initialization helpers', () => {
    it('assigns the expected DOM references onto the ui instance', () => {
        const originalDocument = global.document;
        const originalResizeObserver = global.ResizeObserver;
        const createdNodes = new Map();

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
                    appendChild: vi.fn(),
                    querySelector: vi.fn(() => null),
                    closest: vi.fn(() => null),
                    offsetHeight: 0,
                    innerHTML: ''
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
            getElementById: vi.fn((id) => getNode(id)),
            createElement: vi.fn(() => getNode('created'))
        };
        global.ResizeObserver = class ResizeObserver {
            observe() {}
            disconnect() {}
        };

        const hud = new RaceHud();

        expect(hud.header).toBe(getNode('header'));
        expect(hud.hudBar).toBe(getNode('.hud-bar'));
        expect(hud.timeVal).toBe(timeVal);
        expect(hud.timeDisplay).toBe(timeDisplay);
        expect(hud.timeLabel).toBe(timeLabel);
        expect(hud.countdownLights).toEqual([
            getNode('light-1'),
            getNode('light-2'),
            getNode('light-3')
        ]);

        global.document = originalDocument;
        global.ResizeObserver = originalResizeObserver;
    });

    it('initializes callback, cache, and runtime state onto the ui instance', () => {
        const onSummaryUpdated = vi.fn();
        const ui = new DailyChallengeUi({
            previewQualityLevel: 2,
            previewFrameSkip: 1,
            onSummaryUpdated
        });

        expect(ui.previewQualityLevel).toBe(2);
        expect(ui.previewFrameSkip).toBe(1);
        expect(ui.onSummaryUpdated).toBe(onSummaryUpdated);
        expect(ui._dailyChallengeSummary).toBe(null);
        expect(ui._dailyChallengeCountdownInterval).toBe(null);
        expect(ui._dailyPreviewKey).toBe('');
    });
});
