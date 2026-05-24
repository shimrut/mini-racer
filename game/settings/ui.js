import {
    getLeaderboardIdentityPreference,
    setLeaderboardIdentityPreference,
} from '../scoreboard/display-preference.js?v=1.91';
import {
    LEADERBOARD_IDENTITY_CONSTRUCTED,
    LEADERBOARD_IDENTITY_REDDIT,
    getConstructedLeaderboardName,
    sanitizeRedditUsername,
} from '../shared/leaderboard-identity.js';
import { getPlayerProgressState } from '../storage.js?v=1.91';
import { getOrCreatePlayerId } from '../scoreboard/api-client.js?v=1.91';
import {
    getCarProceduralAudioEnabled,
    setCarProceduralAudioEnabled,
} from './car-audio-preference.js?v=1.91';
import {
    getCrashAutoRestartAfterCrashEnabled,
    setCrashAutoRestartAfterCrashEnabled,
} from './crash-auto-restart-preference.js?v=1.91';
import {
    CRASH_RESTART_DELAY_METER_TICKS,
    CRASH_RESTART_DELAY_STEP,
    crashRestartDelayToMeterStep,
    getCrashRestartDelaySec,
    setCrashRestartDelaySec,
} from './crash-restart-delay-preference.js?v=1.91';
import { userGesturePrepareCarEffects } from '../audio/car-effects-audio.js?v=1.97';
import { userGesturePrepareMedalEffects } from '../audio/medal-effects-audio.js?v=1.97';
import { userGesturePrepareMusic } from '../audio/procedural-music.js?v=1.97';
import {
    getMusicEnabled,
    setMusicEnabled,
} from './music-preference.js?v=1.91';
import { closeModalElement, openModalElement } from '../ui/modal-handoff.js';
import { bindReusableModal, configureReusableModal } from '../ui/reusable-modal.js';

export class SettingsUi {
    constructor({ modal, onCrashAutoRestartChanged, onCrashRestartDelayChanged, onCarAudioChanged, onMusicChanged } = {}) {
        this.modal = modal;
        this.onCrashAutoRestartChanged = onCrashAutoRestartChanged;
        this.onCrashRestartDelayChanged = onCrashRestartDelayChanged;
        this.onCarAudioChanged = onCarAudioChanged;
        this.onMusicChanged = onMusicChanged;
        this.identityBootstrap = null;
        this.bindEvents();
        this.refreshIdentityPanel();
        this.refreshCarAudioPanel();
        this.refreshMusicPanel();
        this.refreshCrashAutoRestartPanel();
        this.refreshCrashRestartDelayPanel();
    }

    get settingsModal() { return document.getElementById('settings-modal'); }
    get settingsBtn() { return document.getElementById('menu-btn-settings'); }
    get settingsView() { return document.getElementById('modal-settings-view'); }
    get settingsBackBtn() { return document.getElementById('settings-back-btn'); }
    get redditIdentitySwitch() { return document.getElementById('settings-reddit-identity-switch'); }
    get redditHeading() { return document.getElementById('settings-reddit-heading'); }
    get identityDesc() { return document.getElementById('settings-identity-desc'); }
    get carAudioSwitch() { return document.getElementById('settings-car-audio-switch'); }
    get carAudioHeading() { return document.getElementById('settings-car-audio-heading'); }
    get carAudioDesc() { return document.getElementById('settings-car-audio-desc'); }
    get crashAutoRestartSwitch() { return document.getElementById('settings-crash-auto-restart-switch'); }
    get crashAutoRestartHeading() { return document.getElementById('settings-crash-auto-restart-heading'); }
    get crashAutoRestartDesc() { return document.getElementById('settings-crash-auto-restart-desc'); }
    get crashRestartDelayMeter() { return document.getElementById('settings-crash-restart-delay-meter'); }
    get crashRestartDelayMinus() { return document.getElementById('settings-crash-restart-delay-minus'); }
    get crashRestartDelayPlus() { return document.getElementById('settings-crash-restart-delay-plus'); }
    get crashRestartDelayValue() { return document.getElementById('settings-crash-restart-delay-value'); }
    get crashRestartDelayHeading() { return document.getElementById('settings-crash-restart-delay-heading'); }
    get crashRestartDelayDesc() { return document.getElementById('settings-crash-restart-delay-desc'); }
    get musicSwitch() { return document.getElementById('settings-music-switch'); }
    get musicHeading() { return document.getElementById('settings-music-heading'); }

    wireCrashRestartDelayMeter() {
        const meter = this.crashRestartDelayMeter;
        if (!meter || meter.dataset.wired === '1') return;
        meter.dataset.wired = '1';
        meter.replaceChildren();
        for (let i = 0; i < CRASH_RESTART_DELAY_METER_TICKS; i += 1) {
            const tick = document.createElement('button');
            tick.type = 'button';
            tick.className = 'settings-crash-delay-meter__tick';
            tick.dataset.delayStep = String(i);
            const labelSec = (i * CRASH_RESTART_DELAY_STEP).toFixed(1);
            tick.setAttribute('aria-label', `${labelSec} seconds`);
            meter.appendChild(tick);
        }
        meter.addEventListener('click', (event) => {
            const tick = event.target.closest('[data-delay-step]');
            if (!tick || !meter.contains(tick)) return;
            this.applyCrashRestartMeterStep(Number.parseInt(tick.dataset.delayStep, 10));
        });
        meter.addEventListener('keydown', (event) => {
            const step = crashRestartDelayToMeterStep(getCrashRestartDelaySec());
            let next = step;
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                next = Math.min(CRASH_RESTART_DELAY_METER_TICKS - 1, step + 1);
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                next = Math.max(0, step - 1);
            } else if (event.key === 'End') {
                next = CRASH_RESTART_DELAY_METER_TICKS - 1;
            } else if (event.key === 'Home') {
                next = 0;
            } else {
                return;
            }
            event.preventDefault();
            this.applyCrashRestartMeterStep(next);
        });

        this.crashRestartDelayMinus?.addEventListener('click', () => {
            const s = crashRestartDelayToMeterStep(getCrashRestartDelaySec());
            this.applyCrashRestartMeterStep(Math.max(0, s - 1));
        });
        this.crashRestartDelayPlus?.addEventListener('click', () => {
            const s = crashRestartDelayToMeterStep(getCrashRestartDelaySec());
            this.applyCrashRestartMeterStep(Math.min(CRASH_RESTART_DELAY_METER_TICKS - 1, s + 1));
        });
    }

    applyCrashRestartMeterStep(stepIndex) {
        const next = setCrashRestartDelaySec(stepIndex * CRASH_RESTART_DELAY_STEP);
        this.onCrashRestartDelayChanged?.(next);
        this.refreshCrashRestartDelayPanel();
    }

    /**
     * @param {object} opts
     * @param {() => boolean} opts.getValue
     * @param {HTMLInputElement|null|undefined} opts.switchEl
     * @param {HTMLElement|null|undefined} opts.headingEl
     * @param {HTMLElement|null|undefined} [opts.descEl]
     * @param {string} opts.title Shown as "{title}: On" / "{title}: Off"
     */
    _syncBooleanSettingRow({ getValue, switchEl, headingEl, descEl, title }) {
        const on = getValue();
        if (switchEl) {
            switchEl.checked = on;
        }
        if (headingEl) {
            headingEl.textContent = `${title}: ${on ? 'On' : 'Off'}`;
        }
        if (descEl) {
            descEl.textContent = '';
        }
    }

    bindEvents() {
        configureReusableModal(this.settingsModal, {
            title: 'Settings',
            closeLabel: 'Close',
        });
        bindReusableModal(this.settingsModal, () => this.closeSettings());

        if (this.settingsBtn) {
            this.settingsBtn.addEventListener('click', () => {
                this.openSettings();
            });
        }
        if (this.redditIdentitySwitch) {
            this.redditIdentitySwitch.addEventListener('change', () => {
                const next = this.redditIdentitySwitch.checked
                    ? LEADERBOARD_IDENTITY_REDDIT
                    : LEADERBOARD_IDENTITY_CONSTRUCTED;
                setLeaderboardIdentityPreference(next);
                this.refreshIdentityPanel();
            });
        }
        if (this.carAudioSwitch) {
            this.carAudioSwitch.addEventListener('change', () => {
                const on = setCarProceduralAudioEnabled(this.carAudioSwitch.checked);
                if (on) {
                    userGesturePrepareCarEffects();
                    userGesturePrepareMedalEffects();
                }
                this.onCarAudioChanged?.(on);
                this.refreshCarAudioPanel();
            });
        }
        if (this.musicSwitch) {
            this.musicSwitch.addEventListener('change', () => {
                const on = setMusicEnabled(this.musicSwitch.checked);
                if (on) {
                    userGesturePrepareMusic();
                }
                this.onMusicChanged?.(on);
                this.refreshMusicPanel();
            });
        }
        if (this.crashAutoRestartSwitch) {
            this.crashAutoRestartSwitch.addEventListener('change', () => {
                const next = setCrashAutoRestartAfterCrashEnabled(this.crashAutoRestartSwitch.checked);
                this.onCrashAutoRestartChanged?.(next);
                this.refreshCrashAutoRestartPanel();
            });
        }
        this.wireCrashRestartDelayMeter();
    }

    refreshIdentityPanel() {
        const preference = getLeaderboardIdentityPreference();
        const isReddit = preference === LEADERBOARD_IDENTITY_REDDIT;
        const playerId = this.identityBootstrap?.leaderboardPlayerId
            ?? getOrCreatePlayerId('player bootstrap');
        const safeReddit = sanitizeRedditUsername(this.identityBootstrap?.redditUsername ?? null);

        if (this.redditIdentitySwitch) {
            this.redditIdentitySwitch.checked = isReddit;
        }
        if (this.redditHeading) {
            this.redditHeading.textContent = `Reddit Username: ${isReddit ? 'On' : 'Off'}`;
        }
        if (this.identityDesc) {
            if (isReddit && safeReddit) {
                this.identityDesc.textContent = safeReddit;
            } else {
                this.identityDesc.textContent = getConstructedLeaderboardName(playerId);
            }
        }
    }

    refreshCarAudioPanel() {
        this._syncBooleanSettingRow({
            getValue: getCarProceduralAudioEnabled,
            switchEl: this.carAudioSwitch,
            headingEl: this.carAudioHeading,
            descEl: this.carAudioDesc,
            title: 'Sound Effects',
        });
    }

    refreshMusicPanel() {
        this._syncBooleanSettingRow({
            getValue: getMusicEnabled,
            switchEl: this.musicSwitch,
            headingEl: this.musicHeading,
            title: 'Music',
        });
    }

    refreshCrashAutoRestartPanel() {
        this._syncBooleanSettingRow({
            getValue: getCrashAutoRestartAfterCrashEnabled,
            switchEl: this.crashAutoRestartSwitch,
            headingEl: this.crashAutoRestartHeading,
            descEl: this.crashAutoRestartDesc,
            title: 'Crash Auto-Restart',
        });
    }

    refreshCrashRestartDelayPanel() {
        const sec = getCrashRestartDelaySec();
        const step = crashRestartDelayToMeterStep(sec);
        const maxStep = CRASH_RESTART_DELAY_METER_TICKS - 1;

        const meter = this.crashRestartDelayMeter;
        if (meter) {
            meter.setAttribute('aria-valuenow', String(step));
            meter.setAttribute('aria-valuemin', '0');
            meter.setAttribute('aria-valuemax', String(maxStep));
            const ticks = meter.querySelectorAll('.settings-crash-delay-meter__tick');
            ticks.forEach((tick, index) => {
                tick.classList.toggle('is-filled', index <= step);
                tick.classList.toggle('is-active', index === step);
            });
        }

        const label = sec <= 0 ? 'Instant' : `${sec.toFixed(1)} s`;
        if (this.crashRestartDelayValue) {
            this.crashRestartDelayValue.textContent = label;
        }
        if (this.crashRestartDelayHeading) {
            this.crashRestartDelayHeading.textContent = 'Crash Respawn Delay';
        }
        if (this.crashRestartDelayDesc) {
            this.crashRestartDelayDesc.textContent = '';
        }
        if (this.crashRestartDelayMinus) {
            this.crashRestartDelayMinus.disabled = step <= 0;
        }
        if (this.crashRestartDelayPlus) {
            this.crashRestartDelayPlus.disabled = step >= maxStep;
        }
    }

    async syncIdentityBootstrap() {
        try {
            const state = await getPlayerProgressState();
            this.identityBootstrap = {
                redditUsername: state.redditUsername ?? null,
                leaderboardPlayerId: state.leaderboardPlayerId ?? null,
            };
        } catch (_error) {
            this.identityBootstrap = null;
        }
        this.refreshIdentityPanel();
    }

    closeSettings() {
        if (this.settingsModal) {
            this.modal?.releaseModalFocusTrap?.(this.settingsModal);
            closeModalElement(this.settingsModal, () => this.settingsModal.classList.remove('active'));
        }
        if (this.modal?.isPauseModalActive?.()) {
            const raceModal = document.getElementById('modal');
            if (raceModal) {
                requestAnimationFrame(() => {
                    this.modal?.activateModalFocusTrap?.(raceModal);
                });
            }
        }
    }

    openSettings() {
        if (!this.settingsModal) return;

        this.refreshIdentityPanel();
        this.refreshCarAudioPanel();
        this.refreshMusicPanel();
        this.refreshCrashAutoRestartPanel();
        this.wireCrashRestartDelayMeter();
        this.refreshCrashRestartDelayPanel();
        this.onCrashAutoRestartChanged?.(getCrashAutoRestartAfterCrashEnabled());
        this.onCrashRestartDelayChanged?.(getCrashRestartDelaySec());
        void this.syncIdentityBootstrap();

        openModalElement(this.settingsModal, () => this.settingsModal.classList.add('active'));

        requestAnimationFrame(() => {
            if (this.modal && this.modal.activateModalFocusTrap) {
                this.modal.activateModalFocusTrap(this.settingsModal);
            }
        });
    }
}
