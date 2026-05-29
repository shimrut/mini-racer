import { TRACK_MODE_DAILY_GP } from '../config.js?v=1.91';

/** Speed readout: cap DOM writes (lap timer updates every frame when centiseconds change). */
const HUD_SPEED_MIN_MS = 1000 / 15;

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
        this._lastTimeText = '0.00';
        this._lastSpeedText = '0';
        this._lastHudSpeedWrite = undefined;
        this._hasPersonalBests = false;
        this._hudPersonalBestsAllowed = false;
        this._lapFlashTimer = null;
        this._hudAnchorResizeObserver = null;
        this._maxSpeed = 240;
        this._speedTicks = [];
        this._mobileSpeedTicks = [];

        this.anchorHudBar();
        this.initSpeedBars();
    }

    get header() { return document.querySelector('header'); }
    get hudBar() { return document.querySelector('.hud-bar'); }
    get timeVal() { return document.getElementById('time-val'); }
    get speedVal() { return document.getElementById('speed-val'); }
    get mobileSpeedVal() { return document.getElementById('mobile-speed-val'); }
    get speedBar() { return document.getElementById('speed-bar'); }
    get mobileSpeedBar() { return document.getElementById('mobile-speed-bar'); }
    get timeDisplay() { return this.timeVal?.closest('.hud-stat') || null; }
    get timeLabel() { return this.timeDisplay?.querySelector('.hud-label') || null; }
    get bestTimeDisplay() { return document.getElementById('best-time-display'); }
    get bestTimeVal() { return document.getElementById('best-time-val'); }
    get bestTimeLabel() { return document.getElementById('best-time-label'); }
    get bestTimeMedal() { return document.getElementById('best-time-medal'); }
    get desktopSpeedometer() { return document.getElementById('desktop-speedometer'); }
    get mobileSpeedometer() { return document.getElementById('mobile-speedometer'); }
    get pauseBtn() { return document.getElementById('pause-btn'); }
    get hudStatsBtn() { return document.getElementById('hud-stats-btn'); }
    get startLights() { return document.getElementById('start-lights'); }
    get countdownLights() {
        return [
            document.getElementById('light-1'),
            document.getElementById('light-2'),
            document.getElementById('light-3')
        ];
    }
    get goMessage() { return document.getElementById('go-message'); }
    get lapFlash() { return document.getElementById('lap-flash'); }
    get lapFlashLabel() { return document.getElementById('lap-flash-label'); }
    get lapFlashTime() { return document.getElementById('lap-flash-time'); }
    get lapFlashDelta() { return document.getElementById('lap-flash-delta'); }


    anchorHudBar() {
        const header = this.header;
        const hudBar = this.hudBar;
        if (!hudBar) return;
        if (!header) {
            hudBar.style.top = '12px';
            this._hudAnchorResizeObserver?.disconnect?.();
            this._hudAnchorResizeObserver = null;
            return;
        }

        const getHeaderHeight = (entry) => {
            const observedSize = entry?.borderBoxSize;
            if (Array.isArray(observedSize) && observedSize[0]?.blockSize) {
                return observedSize[0].blockSize;
            }
            if (observedSize?.blockSize) {
                return observedSize.blockSize;
            }
            return header.offsetHeight;
        };

        const setHudTop = (entry) => {
            hudBar.style.top = `${Math.round(getHeaderHeight(entry)) + 12}px`;
        };

        setHudTop();
        this._hudAnchorResizeObserver?.disconnect?.();
        this._hudAnchorResizeObserver = new ResizeObserver((entries) =>
            setHudTop(entries[0])
        );
        this._hudAnchorResizeObserver.observe(header);
    }

    initSpeedBars() {
        const createBar = (container) => {
            if (!container || typeof document.createElement !== 'function') return [];
            container.innerHTML = '';
            const ticks = [];
            // Create a single continuous sequence of ticks
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


    syncHud({ time, speed, force = false }) {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const timeText = time.toFixed(2);
    const speedText = Math.round(speed * 20).toString();
    const useLapTimer = this._hudPrimaryMetricMode === 'time';

    if (force) {
        if (useLapTimer) {
            if (this.timeVal) this.timeVal.textContent = timeText;
            this._lastTimeText = timeText;
        }
        if (this.speedVal) this.speedVal.textContent = speedText;
        if (this.mobileSpeedVal) this.mobileSpeedVal.textContent = speedText;
        this._lastSpeedText = speedText;
        this._lastHudSpeedWrite = now;
        return;
    }

    if (useLapTimer && this._lastTimeText !== timeText) {
        if (this.timeVal) this.timeVal.textContent = timeText;
        this._lastTimeText = timeText;
    }

    const speedDue = !this._lastHudSpeedWrite || (now - this._lastHudSpeedWrite) >= HUD_SPEED_MIN_MS;
    if (speedDue && (this._lastSpeedText !== speedText || force)) {
        if (this.speedVal) this.speedVal.textContent = speedText;
        if (this.mobileSpeedVal) this.mobileSpeedVal.textContent = speedText;
        this.updateSpeedTicks(Number(speedText));
        this._lastSpeedText = speedText;
        this._lastHudSpeedWrite = now;
    }
}

    updateSpeedTicks(speedKph) {
        const totalTicks = 20;
        // Scaling: we use the car's actual max speed for precise filling.
        const maxSpeed = this._maxSpeed || 240; 
        const activeTicks = Math.min(totalTicks, Math.ceil((speedKph / maxSpeed) * totalTicks));

        const updateBar = (ticks) => {
            ticks.forEach((tick, i) => {
                tick.classList.toggle('active', i < activeTicks);
            });
        };

        updateBar(this._speedTicks);
        updateBar(this._mobileSpeedTicks);
    }

    setMaxSpeed(speedKph) {
        this._maxSpeed = speedKph;
    }

    resetHud() {
    if (this.timeLabel) this.timeLabel.textContent = 'LAP';
    if (this.timeVal) this.timeVal.textContent = '0.00';
    if (this.speedVal) this.speedVal.textContent = '0';
    if (this.mobileSpeedVal) this.mobileSpeedVal.textContent = '0';
    this.updateSpeedTicks(0);
    this._hudPrimaryMetricMode = 'time';
    this._lastTimeText = '0.00';
    this._lastSpeedText = '0';
    this._lastHudSpeedWrite = undefined;
}

    setHudPrimaryMetric({ label = 'LAP', value = '0.00', useTimer = true, visible = true } = {}) {
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
        if (this.bestTimeLabel) this.bestTimeLabel.textContent = label;
        this.bestTimeVal.textContent = value;
        if (this.bestTimeDisplay) this.bestTimeDisplay.style.display = 'flex';
        return;
    }

    if (this.bestTimeLabel) this.bestTimeLabel.textContent = 'BEST';
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
            value: bestLapTime.toFixed(2),
            visible: true
        });
        this.syncBestTimeMedalBadge(trackKey, bestLapTime);
        this._hasPersonalBests = true;
        this.updateHudStatsButtonState();
        return;
    }

    this.syncBestTimeMedalBadge(null, null);
    this.setHudBestMetric({ visible: false });
    this._hasPersonalBests = false;
    this.updateHudStatsButtonState();
}

    setHudPersonalBestsOpenAllowed(isAllowed) {
    this._hudPersonalBestsAllowed = Boolean(isAllowed);
    this.updateHudStatsButtonState();
}

    setPauseVisible(isVisible) {
    if (!this.pauseBtn) return;
    this.pauseBtn.hidden = !isVisible;
    this.pauseBtn.style.display = isVisible ? 'inline-flex' : 'none';
}

    updateHudStatsButtonState() {
    if (this.hudStatsBtn) {
        this.hudStatsBtn.disabled = !(this._hasPersonalBests && this._hudPersonalBestsAllowed);
    }
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

    _showTimingFlash({ label, timeSec, deltaVsBest, isNewBest = false, evenDeltaText = 'Even lap' }) {
        if (!this.lapFlash || !this.lapFlashLabel || !this.lapFlashTime || !this.lapFlashDelta) return;

        if (this._lapFlashTimer !== null) {
            clearTimeout(this._lapFlashTimer);
            this._lapFlashTimer = null;
        }

        if (!isNewBest && (deltaVsBest === null || deltaVsBest === undefined)) {
            this.hideLapFlash();
            return;
        }

        this.lapFlashLabel.textContent = label;
        this.lapFlashTime.textContent = `${timeSec.toFixed(2)}s`;
        this.lapFlash.classList.remove('is-gain', 'is-loss', 'is-warning');
        const roundedDeltaAbs = deltaVsBest === null || deltaVsBest === undefined
            ? null
            : Number(Math.abs(deltaVsBest).toFixed(2));

        if (isNewBest) {
            this.lapFlashDelta.hidden = false;
            this.lapFlashDelta.textContent = 'New PB';
            this.lapFlash.classList.add('is-gain');
        } else if (deltaVsBest === null || deltaVsBest === undefined) {
            this.lapFlashDelta.textContent = '';
            this.lapFlashDelta.hidden = true;
        } else if (roundedDeltaAbs === 0.01) {
            this.lapFlashDelta.hidden = false;
            this.lapFlashDelta.textContent = deltaVsBest < 0 ? `${deltaVsBest.toFixed(2)}s` : `+${deltaVsBest.toFixed(2)}s`;
            this.lapFlash.classList.add('is-warning');
        } else if (deltaVsBest < -0.005) {
            this.lapFlashDelta.hidden = false;
            this.lapFlashDelta.textContent = `${deltaVsBest.toFixed(2)}s`;
            this.lapFlash.classList.add('is-gain');
        } else if (deltaVsBest > 0.005) {
            this.lapFlashDelta.hidden = false;
            this.lapFlashDelta.textContent = `+${deltaVsBest.toFixed(2)}s`;
            this.lapFlash.classList.add('is-loss');
        } else {
            this.lapFlashDelta.hidden = false;
            this.lapFlashDelta.textContent = evenDeltaText;
        }

        this.lapFlash.classList.add('visible');
        this._lapFlashTimer = setTimeout(() => this.hideLapFlash(), 1400);
    }

    showLapFlash({ lapNumber, lapTime, deltaVsBest, isBest, isNewBest = false }) {
        this._showTimingFlash({
            label: isBest ? `Lap ${lapNumber} Best` : `Lap ${lapNumber}`,
            timeSec: lapTime,
            deltaVsBest,
            isNewBest
        });
    }

    showCheckpointFlash({ checkpointNumber, splitTimeSec, deltaVsBest }) {
        this._showTimingFlash({
            label: `CP ${checkpointNumber}`,
            timeSec: splitTimeSec,
            deltaVsBest,
            evenDeltaText: 'Even split'
        });
    }

    hideLapFlash() {
    if (this._lapFlashTimer !== null) {
        clearTimeout(this._lapFlashTimer);
        this._lapFlashTimer = null;
    }
    if (this.lapFlash) this.lapFlash.classList.remove('visible');
}

    resetCountdown() {
    this.hideStartLights();
    if (this.goMessage) this.goMessage.classList.remove('visible');
    this.hideLapFlash();
}

}
