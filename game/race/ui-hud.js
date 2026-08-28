import { TRACK_MODE_DAILY_GP } from '../config.js';
import { createMedalIconSvg } from '../medals/medal-icon.js';
import { isStandardMedalTier } from '../medals/medal-timing.js';
import { getHideHudEnabled } from '../settings/hide-hud-preference.js';
import { getPauseOnTimerEnabled } from '../settings/pause-on-timer-preference.js';

const HUD_TIME_MIN_MS = 1000 / 30;
const HUD_SPEED_MIN_MS = 1000 / 15;

function isLaidOutHudElement(el) {
    if (!el) return false;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    if (typeof width !== 'number' && typeof height !== 'number') return true;
    return (width || 0) > 0 || (height || 0) > 0;
}

function shouldWriteHudSurface(container, valueEl) {
    if (!valueEl) return false;
    if (!container) return true;
    return isLaidOutHudElement(container);
}

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
        this._lastActiveSpeedSurface = null;
        this._pauseAvailable = false;
        this._lapFlashTimer = null;
        this._hudAnchorResizeObserver = null;
        this._maxSpeed = 240;
        this._speedTicks = [];
        this._mobileSpeedTicks = [];
        this._lastActiveSpeedTicks = -1;
        this.elements = {
            header: document.querySelector('header'),
            hudBar: document.querySelector('.hud-bar'),
            timeVal: document.getElementById('time-val'),
            speedVal: document.getElementById('speed-val'),
            mobileSpeedVal: document.getElementById('mobile-speed-val'),
            speedBar: document.getElementById('speed-bar'),
            mobileSpeedBar: document.getElementById('mobile-speed-bar'),
            bestTimeDisplay: document.getElementById('best-time-display'),
            bestTimeVal: document.getElementById('best-time-val'),
            bestTimeMedal: document.getElementById('best-time-medal'),
            desktopSpeedometer: document.getElementById('desktop-speedometer'),
            mobileSpeedometer: document.getElementById('mobile-speedometer'),
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
    get mobileSpeedVal() { return this.elements.mobileSpeedVal; }
    get speedBar() { return this.elements.speedBar; }
    get mobileSpeedBar() { return this.elements.mobileSpeedBar; }
    get timeDisplay() { return this.elements.timeDisplay; }
    get timeLabel() { return this.elements.timeLabel; }
    get bestTimeDisplay() { return this.elements.bestTimeDisplay; }
    get bestTimeVal() { return this.elements.bestTimeVal; }
    get bestTimeMedal() { return this.elements.bestTimeMedal; }
    get desktopSpeedometer() { return this.elements.desktopSpeedometer; }
    get mobileSpeedometer() { return this.elements.mobileSpeedometer; }
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
        const createBar = (container) => {
            if (!container || typeof document.createElement !== 'function') return [];
            container.innerHTML = '';
            const ticks = [];
            for (let t = 0; t < 20; t++) {
                const tick = document.createElement('div');
                tick.className = 'speedometer-tick';
                container.appendChild(tick);
                ticks.push(tick);
            }
            return ticks;
        };

        this._speedTicks = createBar(this.speedBar);
        this._mobileSpeedTicks = createBar(this.mobileSpeedBar);
    }


    resolveVisibleSpeedSurfaces() {
        const desktop = shouldWriteHudSurface(this.desktopSpeedometer, this.speedVal);
        const mobile = shouldWriteHudSurface(this.mobileSpeedometer, this.mobileSpeedVal);
        const surface = desktop && mobile ? 'both' : desktop ? 'desktop' : mobile ? 'mobile' : 'none';
        if (surface !== this._lastActiveSpeedSurface) {
            this._lastActiveSpeedSurface = surface;
            this._lastActiveSpeedTicks = -1;
        }
        return { desktop, mobile };
    }

    writeVisibleSpeed(speedText) {
        const { desktop, mobile } = this.resolveVisibleSpeedSurfaces();
        if (desktop) this.speedVal.textContent = speedText;
        if (mobile) this.mobileSpeedVal.textContent = speedText;
        this.updateSpeedTicks(Number(speedText), { desktop, mobile });
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
            this.writeVisibleSpeed(speedText);
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
                this.writeVisibleSpeed(speedText);
                this._lastSpeedText = speedText;
            }
            this._lastHudSpeedWrite = now;
        }
    }

    updateSpeedTicks(speedKph, surfaces = null) {
        const totalTicks = 20;
        const maxSpeed = this._maxSpeed || 240;
        const activeTicks = Math.min(totalTicks, Math.ceil((speedKph / maxSpeed) * totalTicks));
        const { desktop, mobile } = surfaces || this.resolveVisibleSpeedSurfaces();
        if (activeTicks === this._lastActiveSpeedTicks) return;
        this._lastActiveSpeedTicks = activeTicks;

        const updateBar = (ticks) => {
            ticks.forEach((tick, i) => {
                tick.classList.toggle('active', i < activeTicks);
            });
        };

        if (desktop) updateBar(this._speedTicks);
        if (mobile) updateBar(this._mobileSpeedTicks);
    }

    setMaxSpeed(speedKph) {
        this._maxSpeed = speedKph;
    }

    resetHud() {
    if (this.timeLabel) this.timeLabel.textContent = 'LAP';
    if (this.timeVal) this.timeVal.textContent = '0.000';
    if (this.speedVal) this.speedVal.textContent = '0';
    if (this.mobileSpeedVal) this.mobileSpeedVal.textContent = '0';
    this._lastActiveSpeedTicks = -1;
    this.updateSpeedTicks(0, { desktop: true, mobile: true });
    this._hudPrimaryMetricMode = 'time';
    this._lastTimeText = '0.000';
    this._lastSpeedText = '0';
    this._lastHudTimeWrite = undefined;
    this._lastHudSpeedWrite = undefined;
    this._lastActiveSpeedSurface = null;
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

    setHudBestMetric({ label = 'BEST', value = '--', visible = false } = {}) {
    if (!this.bestTimeDisplay || !this.bestTimeVal) return;

    if (visible) {
        this.bestTimeVal.textContent = value;
        if (this.bestTimeDisplay) this.bestTimeDisplay.style.display = 'flex';
        return;
    }

    this.bestTimeVal.textContent = '--';
    this.bestTimeDisplay.style.display = 'none';
}

    syncBestTimeMedalBadge(trackKey, bestLapTime) {
        const el = this.bestTimeMedal;
        if (!el) return;
        el.replaceChildren();
        el.hidden = true;
        el.className = 'hud-medal';
        el.removeAttribute('title');
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
            label: 'BEST',
            value: bestLapTime.toFixed(3),
            visible: true
        });
        this.syncBestTimeMedalBadge(trackKey, bestLapTime);
        return;
    }

    this.syncBestTimeMedalBadge(null, null);
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
        label: `VS ${displayName}`,
        value: finishTimeSec.toFixed(3),
        visible: true,
    });
    this.syncBestTimeMedalBadge(null, null);
}

    setPauseVisible(isVisible) {
    this._pauseAvailable = Boolean(isVisible);
    this.syncPauseControls();
}

    syncPauseControls() {
    const pauseOnTimer = getPauseOnTimerEnabled();
    const hideHud = getHideHudEnabled();
    const showBottomPause = this._pauseAvailable && !pauseOnTimer;
    const showTimerPause = this._pauseAvailable && pauseOnTimer;
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
    document.body?.classList?.toggle?.('pause-on-timer', pauseOnTimer);
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
