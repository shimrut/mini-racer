import { TRACK_MODE_DAILY_GP } from '../config.js';
import { createMedalIconSvg } from '../medals/medal-icon.js';
import { isStandardMedalTier } from '../medals/medal-timing.js';
import { getHideHudEnabled } from '../settings/hide-hud-preference.js';
import {
    getPausePlacement,
    PAUSE_PLACEMENT_SEPARATE,
    PAUSE_PLACEMENT_SPEEDO,
    PAUSE_PLACEMENT_TIMER,
} from '../settings/pause-placement-preference.js';

const HUD_TIME_MIN_MS = 1000 / 30;
const HUD_SPEED_MIN_MS = 1000 / 15;

// Tarmac and Grip show the race-circuit speed bar: many thin red lights.
// Dirt and Snow show the rally speed bar: fewer wide slanted lights, in the
// yellow of the Rally car's lamps.
const RALLY_SPEEDOMETER_GROUNDS = new Set(['dirt', 'snow']);
const CIRCUIT_SPEED_TICKS = 20;
const RALLY_SPEED_TICKS = 10;

export class RaceHud {
    constructor({
        getTrackPersonalBest = () => null,
        getCurrentTrackKey = () => null,
        persistTrackPersonalBest = null,
    } = {}) {
        this.getTrackPersonalBest = getTrackPersonalBest;
        this.getCurrentTrackKey = getCurrentTrackKey;
        this.persistTrackPersonalBest = persistTrackPersonalBest;
        this._hudPrimaryMetricMode = 'time';
        this._lastTimeText = '0.000';
        this._lastSpeedText = '0';
        this._lastHudTimeWrite = undefined;
        this._lastHudSpeedWrite = undefined;
        this._pauseAvailable = false;
        this._lapFlashTimer = null;
        this._hudAnchorResizeObserver = null;
        this._maxSpeed = 240;
        this._rallySpeedometer = false;
        this._speedTicks = [];
        this._lastActiveSpeedTicks = -1;
        this.elements = {
            header: document.querySelector('header'),
            hudBar: document.querySelector('.hud-bar'),
            timeVal: document.getElementById('time-val'),
            speedVal: document.getElementById('speed-val'),
            speedBar: document.getElementById('speed-bar'),
            bestTimeDisplay: document.getElementById('best-time-display'),
            bestTimeVal: document.getElementById('best-time-val'),
            speedometer: document.getElementById('speedometer'),
            pauseBtn: document.getElementById('pause-btn'),
            hudStatsBtn: document.getElementById('hud-stats-btn'),
            timerPauseIcon: document.getElementById('hud-timer-pause-icon'),
            startLights: document.getElementById('start-lights'),
            countdownLights: [
                document.getElementById('light-1'),
                document.getElementById('light-2'),
                document.getElementById('light-3')
            ],
            goMessage: document.getElementById('go-message'),
            lapFlash: document.getElementById('lap-flash'),
            lapFlashLabel: document.getElementById('lap-flash-label'),
            lapFlashTime: document.getElementById('lap-flash-time'),
            lapFlashMedal: document.getElementById('lap-flash-medal'),
            lapFlashDelta: document.getElementById('lap-flash-delta'),
        };
        this.elements.timeDisplay =
            typeof this.elements.timeVal?.closest === 'function'
                ? this.elements.timeVal.closest('.hud-stat')
                : null;
        this.elements.timeLabel =
            typeof this.elements.timeDisplay?.querySelector === 'function'
                ? this.elements.timeDisplay.querySelector('.hud-label')
                : null;

        this.anchorHudBar();
        this.initSpeedBars();
        this.syncPauseControls();
    }

    get header() { return this.elements.header; }
    get hudBar() { return this.elements.hudBar; }
    get timeVal() { return this.elements.timeVal; }
    get speedVal() { return this.elements.speedVal; }
    get speedBar() { return this.elements.speedBar; }
    get timeDisplay() { return this.elements.timeDisplay; }
    get timeLabel() { return this.elements.timeLabel; }
    get bestTimeDisplay() { return this.elements.bestTimeDisplay; }
    get bestTimeVal() { return this.elements.bestTimeVal; }
    get speedometer() { return this.elements.speedometer; }
    get pauseBtn() { return this.elements.pauseBtn; }
    get hudStatsBtn() { return this.elements.hudStatsBtn; }
    get timerPauseIcon() { return this.elements.timerPauseIcon; }
    get startLights() { return this.elements.startLights; }
    get countdownLights() { return this.elements.countdownLights; }
    get goMessage() { return this.elements.goMessage; }
    get lapFlash() { return this.elements.lapFlash; }
    get lapFlashLabel() { return this.elements.lapFlashLabel; }
    get lapFlashTime() { return this.elements.lapFlashTime; }
    get lapFlashMedal() { return this.elements.lapFlashMedal; }
    get lapFlashDelta() { return this.elements.lapFlashDelta; }


    anchorHudBar() {
        const hudBar = this.hudBar;
        if (!hudBar) return;

        hudBar.style.top = '12px';
        this._hudAnchorResizeObserver?.disconnect?.();
        this._hudAnchorResizeObserver = null;
    }

    initSpeedBars() {
        const tickCount = this._rallySpeedometer ? RALLY_SPEED_TICKS : CIRCUIT_SPEED_TICKS;
        const createBar = (container) => {
            if (!container || typeof document.createElement !== 'function') return [];
            container.innerHTML = '';
            const ticks = [];
            for (let t = 0; t < tickCount; t++) {
                const tick = document.createElement('div');
                tick.className = 'speedometer-tick';
                container.appendChild(tick);
                ticks.push(tick);
            }
            return ticks;
        };

        this._speedTicks = createBar(this.speedBar);
    }

    writeSpeed(speedText) {
        if (this.speedVal) this.speedVal.textContent = speedText;
        this.updateSpeedTicks(Number(speedText));
    }

    syncHud({ time, speed, force = false }) {
        const now = typeof performance !== 'undefined' ? performance.now() : 0;
        const useLapTimer = this._hudPrimaryMetricMode === 'time';

        if (force) {
            if (useLapTimer) {
                const timeText = time.toFixed(3);
                if (this.timeVal) this.timeVal.textContent = timeText;
                this._lastTimeText = timeText;
                this._lastHudTimeWrite = now;
            }
            const speedText = Math.round(speed * 20).toString();
            this.writeSpeed(speedText);
            this._lastSpeedText = speedText;
            this._lastHudSpeedWrite = now;
            return;
        }

        const timeDue = !this._lastHudTimeWrite
            || (now - this._lastHudTimeWrite) >= HUD_TIME_MIN_MS;
        if (useLapTimer && timeDue) {
            const timeText = time.toFixed(3);
            if (this._lastTimeText !== timeText) {
                if (this.timeVal) this.timeVal.textContent = timeText;
                this._lastTimeText = timeText;
            }
            this._lastHudTimeWrite = now;
        }

        const speedDue = !this._lastHudSpeedWrite
            || (now - this._lastHudSpeedWrite) >= HUD_SPEED_MIN_MS;
        if (speedDue) {
            const speedText = Math.round(speed * 20).toString();
            if (this._lastSpeedText !== speedText) {
                this.writeSpeed(speedText);
                this._lastSpeedText = speedText;
            }
            this._lastHudSpeedWrite = now;
        }
    }

    updateSpeedTicks(speedKph) {
        const totalTicks = this._speedTicks.length;
        const maxSpeed = this._maxSpeed || 240;
        const activeTicks = Math.min(totalTicks, Math.ceil((speedKph / maxSpeed) * totalTicks));
        if (activeTicks === this._lastActiveSpeedTicks) return;
        this._lastActiveSpeedTicks = activeTicks;

        this._speedTicks.forEach((tick, i) => {
            tick.classList.toggle('active', i < activeTicks);
        });
    }

    setMaxSpeed(speedKph) {
        this._maxSpeed = speedKph;
    }

    setGround(groundKey) {
        const rally = RALLY_SPEEDOMETER_GROUNDS.has(groundKey);
        if (rally === this._rallySpeedometer) return;
        this._rallySpeedometer = rally;
        this.speedometer?.classList?.toggle('speedometer--rally', rally);
        this.initSpeedBars();
        this._lastActiveSpeedTicks = -1;
        this.updateSpeedTicks(Number(this._lastSpeedText));
    }

    resetHud() {
    if (this.timeLabel) this.timeLabel.textContent = 'LAP';
    if (this.timeVal) this.timeVal.textContent = '0.000';
    if (this.speedVal) this.speedVal.textContent = '0';
    this._lastActiveSpeedTicks = -1;
    this.updateSpeedTicks(0);
    this._hudPrimaryMetricMode = 'time';
    this._lastTimeText = '0.000';
    this._lastSpeedText = '0';
    this._lastHudTimeWrite = undefined;
    this._lastHudSpeedWrite = undefined;
}

    setHudPrimaryMetric({ label = 'LAP', value = '0.000', useTimer = true, visible = true } = {}) {
    if (!this.timeDisplay || !this.timeVal) return;

    this.setHudLapTimeVisible(visible);
    if (this.timeLabel) this.timeLabel.textContent = label;
    this._hudPrimaryMetricMode = useTimer ? 'time' : 'custom';

    if (!useTimer) {
        const nextValue = String(value);
        this.timeVal.textContent = nextValue;
        this._lastTimeText = nextValue;
    }
}

    setHudLapTimeVisible(isVisible) {
    if (!this.timeDisplay) return;
    this.timeDisplay.style.display = isVisible ? '' : 'none';
}

    setHudBestMetric({ value = '--', visible = false } = {}) {
    if (!this.bestTimeDisplay || !this.bestTimeVal) return;

    if (visible) {
        this.bestTimeVal.textContent = value;
        if (this.bestTimeDisplay) this.bestTimeDisplay.style.display = 'flex';
        return;
    }

    this.bestTimeVal.textContent = '--';
    this.bestTimeDisplay.style.display = 'none';
}

    setBestTime(bestLapTime, {
    persistToTrackCard = true,
    trackKey = this.getCurrentTrackKey(),
    scoreboardSubmitPromise = null
} = {}) {
    if (!this.bestTimeDisplay || !this.bestTimeVal) return;

    if (persistToTrackCard && trackKey && bestLapTime !== null && bestLapTime !== undefined) {
        this.persistTrackPersonalBest?.({
            trackKey,
            mode: TRACK_MODE_DAILY_GP,
            bestLapTime,
            scoreboardSubmitPromise
        });
    }

    if (bestLapTime !== null && bestLapTime !== undefined) {
        this.setHudBestMetric({
            value: bestLapTime.toFixed(3),
            visible: true
        });
        return;
    }

    this.setHudBestMetric({ visible: false });
}

    setComparisonTarget(target) {
    const finishTimeSec = Number(target?.finishTimeSec);
    const displayName = typeof target?.displayName === 'string'
        ? target.displayName.trim()
        : '';
    if (!(finishTimeSec > 0) || !displayName) {
        this.setBestTime(null, { persistToTrackCard: false });
        return;
    }
    this.setHudBestMetric({
        value: finishTimeSec.toFixed(3),
        visible: true,
    });
}

    setPauseVisible(isVisible) {
    this._pauseAvailable = Boolean(isVisible);
    this.syncPauseControls();
}

    syncPauseControls() {
    const placement = getPausePlacement();
    const hideHud = getHideHudEnabled();
    const pauseOnTimer = placement === PAUSE_PLACEMENT_TIMER;
    const pauseOnSpeedo = placement === PAUSE_PLACEMENT_SPEEDO;
    const showBottomPause = this._pauseAvailable && (
        placement === PAUSE_PLACEMENT_SEPARATE
        || (pauseOnSpeedo && hideHud)
    );
    const showTimerPause = this._pauseAvailable && pauseOnTimer;
    const showSpeedoPause = this._pauseAvailable && pauseOnSpeedo && !hideHud;
    const showTimerPauseOnly = showTimerPause && hideHud;

    if (this.pauseBtn) {
        this.pauseBtn.hidden = !showBottomPause;
        this.pauseBtn.style.display = showBottomPause ? 'inline-flex' : 'none';
    }
    if (this.hudStatsBtn) {
        this.hudStatsBtn.disabled = !showTimerPause;
        this.hudStatsBtn.classList.toggle('hud-stats--pause', showTimerPause);
        this.hudStatsBtn.classList.toggle('hud-stats--pause-only', showTimerPauseOnly);
        this.hudStatsBtn.setAttribute(
            'aria-label',
            showTimerPause ? 'Pause run' : 'Race time',
        );
    }
    if (this.timerPauseIcon) {
        this.timerPauseIcon.hidden = !showTimerPause;
    }
    if (this.speedometer) {
        this.speedometer.classList.toggle('speedometer--pause', showSpeedoPause);
        if (showSpeedoPause) {
            this.speedometer.setAttribute('role', 'button');
            this.speedometer.setAttribute('aria-label', 'Pause run');
        } else {
            this.speedometer.removeAttribute?.('role');
            this.speedometer.setAttribute('aria-label', 'Current speed');
        }
    }
    document.body?.classList?.toggle?.('pause-on-timer', placement === PAUSE_PLACEMENT_TIMER);
    document.body?.classList?.toggle?.('pause-on-speedo', placement === PAUSE_PLACEMENT_SPEEDO);
    document.body?.classList?.toggle?.('hide-hud', hideHud);
}

    showStartLights() {
    if (this.startLights) this.startLights.classList.add('visible');
}

    turnOnCountdownLight(index) {
    const light = this.countdownLights[index];
    if (light) light.classList.add('on');
}

    hideStartLights() {
    if (this.startLights) this.startLights.classList.remove('visible');
    this.countdownLights.forEach((light) => {
        if (!light) return;
        light.className = 'light';
    });
}

    showGoMessage() {
    if (this.goMessage) this.goMessage.classList.add('visible');
}

    showGhostUnavailableNotice({ durationMs = 2000 } = {}) {
        if (!this.lapFlash || !this.lapFlashDelta) return false;

        if (this._lapFlashTimer !== null) {
            clearTimeout(this._lapFlashTimer);
            this._lapFlashTimer = null;
        }

        this.lapFlashLabel && (this.lapFlashLabel.textContent = '');
        this.lapFlashTime && (this.lapFlashTime.textContent = '');
        this._syncLapFlashMedal(undefined);
        this.lapFlashDelta.hidden = false;
        this.lapFlashDelta.textContent = 'GHOST UNAVAILABLE';
        this.lapFlash.classList.remove('is-gain', 'is-loss');
        this.lapFlash.classList.add('is-warning', 'visible');
        this._lapFlashTimer = setTimeout(() => this.hideLapFlash(), durationMs);
        return true;
    }

    _syncLapFlashMedal(medal) {
        const slot = this.lapFlashMedal;
        if (!slot) return;
        slot.replaceChildren();
        slot.classList?.remove?.('is-no-medal');
        if (slot.dataset) delete slot.dataset.medal;
        if (medal === undefined) {
            slot.hidden = true;
            return;
        }

        const earnedMedal = isStandardMedalTier(medal) ? medal : null;
        slot.appendChild(createMedalIconSvg(earnedMedal || 'white', {
            className: 'medal-svg--lap-flash',
            outline: !earnedMedal,
            showEmblem: Boolean(earnedMedal),
        }));
        slot.hidden = false;
        if (slot.dataset) slot.dataset.medal = earnedMedal || 'none';
        if (!earnedMedal) slot.classList?.add?.('is-no-medal');
    }

    _showTimingFlash({
        label,
        timeSec,
        deltaVsBest,
        isNewBest = false,
        evenDeltaText = 'Even lap',
        medal = undefined,
    }) {
        if (!this.lapFlash || !this.lapFlashLabel || !this.lapFlashTime || !this.lapFlashDelta) return;

        if (this._lapFlashTimer !== null) {
            clearTimeout(this._lapFlashTimer);
            this._lapFlashTimer = null;
        }

        this._syncLapFlashMedal(medal);
        if (
            medal === undefined
            && !isNewBest
            && (deltaVsBest === null || deltaVsBest === undefined)
        ) {
            this.hideLapFlash();
            return;
        }

        this.lapFlashLabel.textContent = label;
        this.lapFlashTime.textContent = `${timeSec.toFixed(3)}s`;
        this.lapFlash.classList.remove('is-gain', 'is-loss', 'is-warning');

        if (isNewBest) {
            this.lapFlashDelta.hidden = false;
            this.lapFlashDelta.textContent = 'New PB';
            this.lapFlash.classList.add('is-gain');
        } else if (deltaVsBest === null || deltaVsBest === undefined) {
            this.lapFlashDelta.textContent = '';
            this.lapFlashDelta.hidden = true;
        } else if (deltaVsBest < -0.0005) {
            this.lapFlashDelta.hidden = false;
            this.lapFlashDelta.textContent = `${deltaVsBest.toFixed(3)}s`;
            this.lapFlash.classList.add('is-gain');
        } else if (deltaVsBest > 0.0005) {
            this.lapFlashDelta.hidden = false;
            this.lapFlashDelta.textContent = `+${deltaVsBest.toFixed(3)}s`;
            this.lapFlash.classList.add('is-loss');
        } else {
            this.lapFlashDelta.hidden = false;
            this.lapFlashDelta.textContent = evenDeltaText;
        }

        this.lapFlash.classList.add('visible');
        this._lapFlashTimer = setTimeout(() => this.hideLapFlash(), 1400);
    }

    showLapFlash({
        lapNumber,
        lapTime,
        deltaVsBest,
        isBest,
        isNewBest = false,
        completedLaps = null,
        requiredLaps = null,
        elapsedTimeSec = null,
        medal = undefined,
    }) {
        const hasRaceProgress = Number.isInteger(completedLaps)
            && completedLaps > 0
            && Number.isInteger(requiredLaps)
            && requiredLaps > 0;
        const displayLapNumber = hasRaceProgress ? completedLaps : lapNumber;
        const label = hasRaceProgress
            ? `Lap ${displayLapNumber} / ${requiredLaps}`
            : (isBest ? `Lap ${lapNumber} Best` : `Lap ${lapNumber}`);
        const displayTime = Number.isFinite(elapsedTimeSec) ? elapsedTimeSec : lapTime;
        this._showTimingFlash({
            label,
            timeSec: displayTime,
            deltaVsBest,
            isNewBest,
            medal,
        });
    }

    showCheckpointFlash({ checkpointNumber, splitTimeSec, deltaVsBest }) {
        this._showTimingFlash({
            label: `CP ${checkpointNumber}`,
            timeSec: splitTimeSec,
            deltaVsBest,
            evenDeltaText: 'Even split',
            medal: undefined,
        });
    }

    hideLapFlash() {
    if (this._lapFlashTimer !== null) {
        clearTimeout(this._lapFlashTimer);
        this._lapFlashTimer = null;
    }
    if (this.lapFlash) this.lapFlash.classList.remove('visible');
}

    resetCountdown({ preserveLapFlash = false } = {}) {
    this.hideStartLights();
    if (this.goMessage) this.goMessage.classList.remove('visible');
    if (!preserveLapFlash) this.hideLapFlash();
}

}
