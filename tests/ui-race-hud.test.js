import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACK_MODE_DAILY_GP } from '../game/config.js';
import { RaceHud } from '../game/race/ui-hud.js';

describe('ui race hud helpers', () => {
    beforeEach(() => {
        const headerNode = { offsetHeight: 48 };
        const hudBarNode = { style: {} };
        vi.stubGlobal('document', {
            getElementById: vi.fn((id) => {
                // Return an object that mimics a DOM element
                return {
                    textContent: '',
                    style: {},
                    classList: {
                        add: vi.fn(),
                        remove: vi.fn(),
                        toggle: vi.fn()
                    },
                    querySelector: vi.fn(() => ({})),
                    closest: vi.fn(() => ({
                        querySelector: vi.fn(() => ({}))
                    })),
                    setAttribute: vi.fn(),
                    replaceChildren: vi.fn()
                };
            }),
            querySelector: vi.fn((selector) => {
                if (selector === 'header') return headerNode;
                if (selector === '.hud-bar') return hudBarNode;
                return {
                    classList: { toggle: vi.fn() },
                    style: {}
                };
            })
        });
        vi.stubGlobal('ResizeObserver', class ResizeObserver {
            constructor() {}
            observe() {}
            disconnect() {}
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('forces the lap timer and speed values onto the HUD', () => {
        const timeVal = { textContent: '' };
        const speedVal = { textContent: '' };
        const mobileSpeedVal = { textContent: '' };

        vi.spyOn(document, 'getElementById').mockImplementation((id) => {
            if (id === 'time-val') return timeVal;
            if (id === 'speed-val') return speedVal;
            if (id === 'mobile-speed-val') return mobileSpeedVal;
            return null;
        });

        const context = {
            _hudPrimaryMetricMode: 'time',
            _lastTimeText: null,
            _lastSpeedText: null,
            _lastHudSpeedWrite: undefined
        };

        const hud = new RaceHud(context);
        hud.syncHud({ time: 12.345, speed: 3.2, force: true });

        expect(timeVal.textContent).toBe('12.35');
        expect(speedVal.textContent).toBe('64');
        expect(mobileSpeedVal.textContent).toBe('64');
        expect(hud._lastTimeText).toBe('12.35');
        expect(hud._lastSpeedText).toBe('64');
    });

    it('persists a best lap to the selected track card and reveals the best metric', () => {
        const persistTrackPersonalBest = vi.fn();
        const bestTimeDisplay = { style: {} };
        const bestTimeVal = { textContent: '' };
        const bestTimeLabel = { textContent: '' };
        const bestTimeDivider = { style: {} };

        vi.spyOn(document, 'getElementById').mockImplementation((id) => ({
            'best-time-display': bestTimeDisplay,
            'best-time-val': bestTimeVal,
            'best-time-label': bestTimeLabel,
            'best-time-divider': bestTimeDivider
        }[id] || null));

        const hud = new RaceHud({
            getCurrentTrackKey: () => 'circuit',
            persistTrackPersonalBest
        });
        vi.spyOn(hud, "setHudBestMetric");
        vi.spyOn(hud, "updateHudStatsButtonState");
        hud.setBestTime(48.35, {
            trackKey: 'circuit',
            mode: TRACK_MODE_DAILY_GP
        });

        expect(persistTrackPersonalBest).toHaveBeenCalledWith({
            trackKey: 'circuit',
            mode: TRACK_MODE_DAILY_GP,
            bestLapTime: 48.35,
            scoreboardSubmitPromise: null
        });
        expect(hud.setHudBestMetric).toHaveBeenCalledWith({
            label: 'BEST',
            value: '48.35',
            visible: true
        });
        expect(hud._hasPersonalBests).toBe(true);
        expect(hud.updateHudStatsButtonState).toHaveBeenCalledTimes(1);
    });

    it('renders a new personal-best lap flash and clears it after the timeout', () => {
        vi.useFakeTimers();

        const lapFlash = {
            classList: {
                add: vi.fn(),
                remove: vi.fn()
            }
        };
        const lapFlashLabel = { textContent: '' };
        const lapFlashTime = { textContent: '' };
        const lapFlashDelta = {
            hidden: true,
            textContent: '',
            classList: {
                add: vi.fn(),
                remove: vi.fn()
            }
        };
        vi.spyOn(document, 'getElementById').mockImplementation((id) => ({
            'lap-flash': lapFlash,
            'lap-flash-label': lapFlashLabel,
            'lap-flash-time': lapFlashTime,
            'lap-flash-delta': lapFlashDelta
        }[id] || null));

        const hud = new RaceHud();
        vi.spyOn(hud, "hideLapFlash");
        hud.showLapFlash({
            lapNumber: 3,
            lapTime: 27.431,
            deltaVsBest: -0.42,
            isBest: true,
            isNewBest: true
        });

        expect(lapFlashLabel.textContent).toBe('Lap 3 Best');
        expect(lapFlashTime.textContent).toBe('27.43s');
        expect(lapFlashDelta.hidden).toBe(false);
        expect(lapFlashDelta.textContent).toBe('New PB');
        expect(lapFlash.classList.add).toHaveBeenCalledWith('visible');

        vi.advanceTimersByTime(1400);

        expect(hud.hideLapFlash).toHaveBeenCalledTimes(1);
        expect(lapFlash.classList.remove).toHaveBeenCalledWith('visible');
    });

    it('shows the best time next to a slower lap delta', () => {
        const lapFlash = { classList: { add: vi.fn(), remove: vi.fn() } };
        const lapFlashLabel = { textContent: '' };
        const lapFlashTime = { textContent: '' };
        const lapFlashDelta = {
            hidden: true,
            textContent: '',
            classList: { add: vi.fn(), remove: vi.fn() }
        };
        vi.spyOn(document, 'getElementById').mockImplementation((id) => ({
            'lap-flash': lapFlash,
            'lap-flash-label': lapFlashLabel,
            'lap-flash-time': lapFlashTime,
            'lap-flash-delta': lapFlashDelta
        }[id] || null));

        const hud = new RaceHud();
        hud.showLapFlash({
            lapNumber: 2,
            lapTime: 21.24,
            deltaVsBest: 0.31,
            bestTimeSec: 20.93,
            isBest: false,
            isNewBest: false
        });

        expect(lapFlashDelta.hidden).toBe(false);
        expect(lapFlashDelta.textContent).toBe('+0.31s');
        expect(lapFlash.classList.add).toHaveBeenCalledWith('is-loss');
    });

    it('shows a compact ghost-unavailable notice for two seconds', () => {
        vi.useFakeTimers();
        const lapFlash = { classList: { add: vi.fn(), remove: vi.fn() } };
        const lapFlashLabel = { textContent: '' };
        const lapFlashTime = { textContent: '' };
        const lapFlashDelta = { hidden: true, textContent: '' };
        vi.spyOn(document, 'getElementById').mockImplementation((id) => ({
            'lap-flash': lapFlash,
            'lap-flash-label': lapFlashLabel,
            'lap-flash-time': lapFlashTime,
            'lap-flash-delta': lapFlashDelta,
        }[id] || null));

        const hud = new RaceHud();
        vi.spyOn(hud, 'hideLapFlash');
        expect(hud.showGhostUnavailableNotice()).toBe(true);
        expect(lapFlashDelta.textContent).toBe('GHOST UNAVAILABLE');
        expect(lapFlash.classList.add).toHaveBeenCalledWith('is-warning', 'visible');

        vi.advanceTimersByTime(300);
        hud.resetCountdown({ preserveLapFlash: true });
        expect(hud.hideLapFlash).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1699);
        expect(hud.hideLapFlash).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(hud.hideLapFlash).toHaveBeenCalledTimes(1);
    });

    it('toggles the pause affordance on both HUD speedometers', () => {
        const pauseBtn = {
            hidden: true,
            style: {}
        };
        vi.spyOn(document, 'getElementById').mockImplementation((id) => ({
            'pause-btn': pauseBtn
        }[id] || null));

        const hud = new RaceHud();
        hud.setPauseVisible(true);
        expect(pauseBtn.hidden).toBe(false);
        expect(pauseBtn.style.display).toBe('inline-flex');
        hud.setPauseVisible(false);
        expect(pauseBtn.hidden).toBe(true);
        expect(pauseBtn.style.display).toBe('none');
    });

    it('pins the HUD near the top when no header is present', () => {
        const hudBar = { style: {} };
        vi.spyOn(document, 'querySelector').mockImplementation((selector) => {
            if (selector === 'header') return null;
            if (selector === '.hud-bar') return hudBar;
            return null;
        });
        const disconnect = vi.fn();
        const hud = new RaceHud();
        hud._hudAnchorResizeObserver = { disconnect };
        hud.anchorHudBar();

        expect(hudBar.style.top).toBe('12px');
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(hud._hudAnchorResizeObserver).toBeNull();
    });
});
