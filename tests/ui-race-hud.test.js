import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACK_MODE_DAILY_GP } from '../game/config.js';
import { RaceHud } from '../game/race/ui-hud.js';

vi.mock('../game/medals/medal-icon.js', () => ({
    createMedalIconSvg: vi.fn((medal, options) => ({ medal, options })),
}));

describe('ui race hud helpers', () => {
    beforeEach(() => {
        const headerNode = { offsetHeight: 48 };
        const hudBarNode = { style: {} };
        vi.stubGlobal('document', {
            getElementById: vi.fn((id) => {
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

        expect(timeVal.textContent).toBe('12.345');
        expect(speedVal.textContent).toBe('64');
        expect(mobileSpeedVal.textContent).toBe('64');
        expect(hud._lastTimeText).toBe('12.345');
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
            value: '48.350',
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
        expect(lapFlashTime.textContent).toBe('27.431s');
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
        expect(lapFlashDelta.textContent).toBe('+0.310s');
        expect(lapFlash.classList.add).toHaveBeenCalledWith('is-loss');
    });

    it('shows an intermediary race medal without requiring a lap delta', () => {
        const lapFlash = { classList: { add: vi.fn(), remove: vi.fn() } };
        const lapFlashLabel = { textContent: '' };
        const lapFlashTime = { textContent: '' };
        const lapFlashMedal = {
            hidden: true,
            classList: { add: vi.fn(), remove: vi.fn() },
            replaceChildren: vi.fn(),
            appendChild: vi.fn(),
        };
        const lapFlashDelta = { hidden: false, textContent: '' };
        vi.spyOn(document, 'getElementById').mockImplementation((id) => ({
            'lap-flash': lapFlash,
            'lap-flash-label': lapFlashLabel,
            'lap-flash-time': lapFlashTime,
            'lap-flash-medal': lapFlashMedal,
            'lap-flash-delta': lapFlashDelta,
        }[id] || null));

        const hud = new RaceHud();
        hud.showLapFlash({
            lapNumber: 1,
            lapTime: 9.5,
            deltaVsBest: null,
            isBest: false,
            completedLaps: 1,
            requiredLaps: 3,
            elapsedTimeSec: 9.5,
            medal: 'gold',
        });

        expect(lapFlashLabel.textContent).toBe('Lap 1 / 3');
        expect(lapFlashTime.textContent).toBe('9.500s');
        expect(lapFlashMedal.hidden).toBe(false);
        expect(lapFlashMedal.appendChild).toHaveBeenCalledWith(expect.objectContaining({
            medal: 'gold',
        }));
        expect(lapFlashDelta.hidden).toBe(true);
        expect(lapFlash.classList.add).toHaveBeenCalledWith('visible');
    });

    it('shows an explicit no-medal intermediary state', () => {
        const lapFlash = { classList: { add: vi.fn(), remove: vi.fn() } };
        const lapFlashMedal = {
            hidden: true,
            classList: { add: vi.fn(), remove: vi.fn() },
            replaceChildren: vi.fn(),
            appendChild: vi.fn(),
        };
        vi.spyOn(document, 'getElementById').mockImplementation((id) => ({
            'lap-flash': lapFlash,
            'lap-flash-label': { textContent: '' },
            'lap-flash-time': { textContent: '' },
            'lap-flash-medal': lapFlashMedal,
            'lap-flash-delta': { hidden: false, textContent: '' },
        }[id] || null));

        const hud = new RaceHud();
        hud.showLapFlash({
            lapNumber: 2,
            lapTime: 20,
            deltaVsBest: null,
            isBest: false,
            completedLaps: 2,
            requiredLaps: 3,
            elapsedTimeSec: 20,
            medal: null,
        });

        expect(lapFlashMedal.hidden).toBe(false);
        expect(lapFlashMedal.classList.add).toHaveBeenCalledWith('is-no-medal');
        expect(lapFlashMedal.appendChild).toHaveBeenCalledWith(expect.objectContaining({
            medal: 'white',
            options: expect.objectContaining({ outline: true, showEmblem: false }),
        }));
        expect(lapFlash.classList.add).toHaveBeenCalledWith('visible');
    });

    it('colors ±0.01 checkpoint deltas as gain/loss, not warning amber', () => {
        const makeFlash = () => {
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
            return { hud: new RaceHud(), lapFlash, lapFlashDelta };
        };

        const gain = makeFlash();
        gain.hud.showCheckpointFlash({
            checkpointNumber: 1,
            splitTimeSec: 4.2,
            deltaVsBest: -0.01
        });
        expect(gain.lapFlashDelta.textContent).toBe('-0.010s');
        expect(gain.lapFlash.classList.add).toHaveBeenCalledWith('is-gain');
        expect(gain.lapFlash.classList.add).not.toHaveBeenCalledWith('is-warning');

        vi.restoreAllMocks();
        const loss = makeFlash();
        loss.hud.showCheckpointFlash({
            checkpointNumber: 1,
            splitTimeSec: 4.2,
            deltaVsBest: 0.01
        });
        expect(loss.lapFlashDelta.textContent).toBe('+0.010s');
        expect(loss.lapFlash.classList.add).toHaveBeenCalledWith('is-loss');
        expect(loss.lapFlash.classList.add).not.toHaveBeenCalledWith('is-warning');
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

    it('keeps the HUD at its race position while the lobby header is visible', () => {
        const hud = new RaceHud();

        expect(hud.hudBar.style.top).toBe('12px');
        expect(hud._hudAnchorResizeObserver).toBeNull();
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
