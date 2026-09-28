import {
    getLeaderboardIdentityPreference,
    setLeaderboardIdentityPreference,
} from '../scoreboard/display-preference.js';
import {
    LEADERBOARD_IDENTITY_CONSTRUCTED,
    LEADERBOARD_IDENTITY_REDDIT,
    getConstructedLeaderboardName,
    normalizeLeaderboardIdentityPreference,
    sanitizeRedditUsername,
} from '../shared/leaderboard-identity.js';
import { getPlayerProgressState } from '../player/progress-state.js';
import {
    API_ROUTES,
} from '../scoreboard/api-client.js';
import {
    getGuestPlayerToken,
    getOrCreatePlayerId,
    setGuestPlayerToken,
} from '../scoreboard/player-identity.js';
import {
    getCarProceduralAudioEnabled,
    setCarProceduralAudioEnabled,
} from './car-audio-preference.js';
import {
    getCollisionAutoRestartEnabled,
    setCollisionAutoRestartEnabled,
} from './collision-auto-restart-preference.js';
import {
    COLLISION_RESTART_DELAY_METER_TICKS,
    COLLISION_RESTART_DELAY_STEP,
    collisionRestartDelayToMeterStep,
    getCollisionRestartDelaySec,
    setCollisionRestartDelaySec,
} from './collision-restart-delay-preference.js';
import { userGesturePrepareCarEffects } from '../audio/car-effects-audio.js';
import { userGesturePrepareMedalEffects } from '../audio/medal-effects-audio.js';
import { userGesturePrepareMusic } from '../audio/procedural-music.js';
import {
    getMusicEnabled,
    setMusicEnabled,
} from './music-preference.js';
import {
    getHideHudEnabled,
    setHideHudEnabled,
} from './hide-hud-preference.js';
import {
    getPausePlacement,
    setPausePlacement,
} from './pause-placement-preference.js';
import {
    getPbGhostEnabled,
    setPbGhostEnabled,
} from './pb-ghost-preference.js';
import {
    QUICK_RESTART_SETTING_VISIBLE,
    getQuickRestartEnabled,
    isQuickRestartActive,
    setQuickRestartEnabled,
} from './quick-restart-preference.js';
import { closeModalElement, openModalElement } from '../ui/modal-handoff.js';
import { bindReusableModal, configureReusableModal } from '../ui/reusable-modal.js';

export class SettingsUi {
    constructor({ modal, onCollisionAutoRestartChanged, onQuickRestartChanged, onCollisionRestartDelayChanged, onCarAudioChanged, onMusicChanged, onPausePlacementChanged, onHideHudChanged, onPbGhostChanged, onLeaderboardIdentityChanged, onPlayerPreferencesChanged } = {}) {
        this.modal = modal;
        this.onCollisionAutoRestartChanged = onCollisionAutoRestartChanged;
        this.onQuickRestartChanged = onQuickRestartChanged;
        this.onCollisionRestartDelayChanged = onCollisionRestartDelayChanged;
        this.onCarAudioChanged = onCarAudioChanged;
        this.onMusicChanged = onMusicChanged;
        this.onPausePlacementChanged = onPausePlacementChanged;
        this.onHideHudChanged = onHideHudChanged;
        this.onPbGhostChanged = onPbGhostChanged;
        this.onLeaderboardIdentityChanged = onLeaderboardIdentityChanged;
        this.onPlayerPreferencesChanged = onPlayerPreferencesChanged;
        this.identityBootstrap = null;
        this.bindEvents();
        this.refreshIdentityPanel();
        this.refreshCarAudioPanel();
        this.refreshMusicPanel();
        this.refreshCollisionAutoRestartPanel();
        this.refreshQuickRestartPanel();
        this.refreshCollisionRestartDelayPanel();
        this.refreshPausePlacementPanel();
        this.refreshHideHudPanel();
        this.refreshPbGhostPanel();
    }

    get settingsModal() { return document.getElementById('settings-modal'); }
    get settingsToggleButtons() {
        return document.querySelectorAll?.('[aria-controls="settings-modal"]') || [];
    }
    get redditIdentitySwitch() { return document.getElementById('settings-reddit-identity-switch'); }
    get redditHeading() { return document.getElementById('settings-reddit-heading'); }
    get identityDesc() { return document.getElementById('settings-identity-desc'); }
    get carAudioSwitch() { return document.getElementById('settings-car-audio-switch'); }
    get carAudioHeading() { return document.getElementById('settings-car-audio-heading'); }
    get collisionAutoRestartSwitch() { return document.getElementById('settings-collision-auto-restart-switch'); }
    get collisionAutoRestartHeading() { return document.getElementById('settings-collision-auto-restart-heading'); }
    get quickRestartSwitch() { return document.getElementById('settings-quick-restart-switch'); }
    get quickRestartHeading() { return document.getElementById('settings-quick-restart-heading'); }
    get collisionRestartDelayMeter() { return document.getElementById('settings-collision-restart-delay-meter'); }
    get collisionRestartDelayMinus() { return document.getElementById('settings-collision-restart-delay-minus'); }
    get collisionRestartDelayPlus() { return document.getElementById('settings-collision-restart-delay-plus'); }
    get collisionRestartDelayValue() { return document.getElementById('settings-collision-restart-delay-value'); }
    get collisionRestartDelayHeading() { return document.getElementById('settings-collision-restart-delay-heading'); }
    get musicSwitch() { return document.getElementById('settings-music-switch'); }
    get musicHeading() { return document.getElementById('settings-music-heading'); }
    get pausePlacementGroup() { return document.getElementById('settings-pause-placement'); }
    get pausePlacementHeading() { return document.getElementById('settings-pause-placement-heading'); }
    get hideHudSwitch() { return document.getElementById('settings-hide-hud-switch'); }
    get hideHudHeading() { return document.getElementById('settings-hide-hud-heading'); }
    get pbGhostSwitch() { return document.getElementById('settings-pb-ghost-switch'); }
    get pbGhostHeading() { return document.getElementById('settings-pb-ghost-heading'); }

    wireCollisionRestartDelayMeter() {
        const meter = this.collisionRestartDelayMeter;
        if (!meter || meter.dataset.wired === '1') return;
        meter.dataset.wired = '1';
        meter.replaceChildren();
        for (let i = 0; i < COLLISION_RESTART_DELAY_METER_TICKS; i += 1) {
            const tick = document.createElement('button');
            tick.type = 'button';
            tick.className = 'settings-collision-delay-meter__tick';
            tick.dataset.delayStep = String(i);
            const labelSec = (i * COLLISION_RESTART_DELAY_STEP).toFixed(1);
            tick.setAttribute('aria-label', `${labelSec} seconds`);
            meter.appendChild(tick);
        }
        meter.addEventListener('click', (event) => {
            const tick = event.target.closest('[data-delay-step]');
            if (!tick || !meter.contains(tick)) return;
            this.applyCollisionRestartMeterStep(Number.parseInt(tick.dataset.delayStep, 10));
        });
        meter.addEventListener('keydown', (event) => {
            const step = collisionRestartDelayToMeterStep(getCollisionRestartDelaySec());
            let next = step;
            if (event.key === 'ArrowRight') {
                next = Math.min(COLLISION_RESTART_DELAY_METER_TICKS - 1, step + 1);
            } else if (event.key === 'ArrowLeft') {
                next = Math.max(0, step - 1);
            } else if (event.key === 'End') {
                next = COLLISION_RESTART_DELAY_METER_TICKS - 1;
            } else if (event.key === 'Home') {
                next = 0;
            } else {
                return;
            }
            event.preventDefault();
            this.applyCollisionRestartMeterStep(next);
        });

        this.collisionRestartDelayMinus?.addEventListener('click', () => {
            const s = collisionRestartDelayToMeterStep(getCollisionRestartDelaySec());
            this.applyCollisionRestartMeterStep(Math.max(0, s - 1));
        });
        this.collisionRestartDelayPlus?.addEventListener('click', () => {
            const s = collisionRestartDelayToMeterStep(getCollisionRestartDelaySec());
            this.applyCollisionRestartMeterStep(Math.min(COLLISION_RESTART_DELAY_METER_TICKS - 1, s + 1));
        });
    }

    applyCollisionRestartMeterStep(stepIndex) {
        const next = setCollisionRestartDelaySec(stepIndex * COLLISION_RESTART_DELAY_STEP);
        this.onCollisionRestartDelayChanged?.(next);
        this.onPlayerPreferencesChanged?.();
        this.refreshCollisionRestartDelayPanel();
    }

    _syncBooleanSettingRow({ getValue, switchEl, headingEl, descEl, title }) {
        const on = getValue();
        if (switchEl) {
            switchEl.checked = on;
        }
        if (headingEl) {
            headingEl.textContent = title;
        }
        if (descEl) {
            descEl.textContent = '';
        }
    }

    wireSettingsSwitchPills() {
        this.settingsModal?.querySelectorAll('.modal-sheet-settings-switch').forEach((root) => {
            if (root.dataset.wired === '1') return;
            const input = root.querySelector('.modal-sheet-settings-switch__input');
            if (!input) return;
            root.dataset.wired = '1';
            root.addEventListener('click', (event) => {
                const opt = event.target.closest('[data-settings-switch]');
                if (!opt || !root.contains(opt)) return;
                const wantOn = opt.dataset.settingsSwitch === 'on';
                if (input.checked === wantOn) {
                    event.preventDefault();
                }
            });
        });
    }

    bindEvents() {
        configureReusableModal(this.settingsModal, {
            title: 'Settings',
            closeLabel: 'Back',
        });
        bindReusableModal(this.settingsModal, () => this.closeSettings());
        this.wireSettingsSwitchPills();

        this.settingsToggleButtons.forEach((button) => {
            button.addEventListener('click', () => {
                this.openSettings();
            });
        });
        if (this.redditIdentitySwitch) {
            this.redditIdentitySwitch.addEventListener('change', async () => {
                const next = this.redditIdentitySwitch.checked
                    ? LEADERBOARD_IDENTITY_REDDIT
                    : LEADERBOARD_IDENTITY_CONSTRUCTED;
                await this.persistIdentityPreference(next);
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
                this.onPlayerPreferencesChanged?.();
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
                this.onPlayerPreferencesChanged?.();
                this.refreshMusicPanel();
            });
        }
        if (this.collisionAutoRestartSwitch) {
            this.collisionAutoRestartSwitch.addEventListener('change', () => {
                const next = setCollisionAutoRestartEnabled(this.collisionAutoRestartSwitch.checked);
                this.onCollisionAutoRestartChanged?.(next);
                this.onPlayerPreferencesChanged?.();
                this.refreshCollisionAutoRestartPanel();
            });
        }
        if (this.quickRestartSwitch) {
            this.quickRestartSwitch.addEventListener('change', () => {
                setQuickRestartEnabled(this.quickRestartSwitch.checked);
                this.onQuickRestartChanged?.(isQuickRestartActive());
                this.onPlayerPreferencesChanged?.();
                this.refreshQuickRestartPanel();
            });
        }
        if (this.pausePlacementGroup) {
            this.pausePlacementGroup.addEventListener('click', (event) => {
                const option = event.target.closest('[data-pause-placement]');
                if (!option || !this.pausePlacementGroup.contains(option)) return;
                const next = setPausePlacement(option.dataset.pausePlacement);
                this.onPausePlacementChanged?.(next);
                this.onPlayerPreferencesChanged?.();
                this.refreshPausePlacementPanel();
            });
        }
        if (this.hideHudSwitch) {
            this.hideHudSwitch.addEventListener('change', () => {
                const next = setHideHudEnabled(this.hideHudSwitch.checked);
                this.onHideHudChanged?.(next);
                this.onPlayerPreferencesChanged?.();
                this.refreshHideHudPanel();
            });
        }
        if (this.pbGhostSwitch) {
            this.pbGhostSwitch.addEventListener('change', () => {
                const next = setPbGhostEnabled(this.pbGhostSwitch.checked);
                this.onPbGhostChanged?.(next);
                this.onPlayerPreferencesChanged?.();
                this.refreshPbGhostPanel();
            });
        }
        this.wireCollisionRestartDelayMeter();
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
            this.redditHeading.textContent = 'Username';
        }
        if (this.identityDesc) {
            if (isReddit && safeReddit) {
                this.identityDesc.textContent = safeReddit;
            } else {
                this.identityDesc.textContent = getConstructedLeaderboardName(playerId);
            }
        }
    }

    async persistIdentityPreference(nextPreference) {
        const previousPreference = getLeaderboardIdentityPreference();
        const normalizedNextPreference = normalizeLeaderboardIdentityPreference(nextPreference);

        setLeaderboardIdentityPreference(normalizedNextPreference);
        this.refreshIdentityPanel();

        try {
            const config = API_ROUTES;
            if (!config?.playerIdentityUrl || typeof fetch !== 'function') {
                return;
            }

            const response = await fetch(config.playerIdentityUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    playerId: getOrCreatePlayerId('player identity'),
                    guestToken: getGuestPlayerToken(),
                    leaderboardIdentity: normalizedNextPreference,
                }),
            });

            if (!response.ok) {
                throw new Error(`Identity update failed: ${response.status}`);
            }

            const payload = await response.json().catch(() => null);
            const storedPreference = normalizeLeaderboardIdentityPreference(
                payload?.leaderboardIdentity ?? normalizedNextPreference,
            );
            setGuestPlayerToken(payload?.guestToken ?? getGuestPlayerToken());
            setLeaderboardIdentityPreference(storedPreference);
        } catch (error) {
            setLeaderboardIdentityPreference(previousPreference);
            this.refreshIdentityPanel();
            console.error('Error saving leaderboard identity preference:', error);
            return;
        }

        this.refreshIdentityPanel();
        await this.onLeaderboardIdentityChanged?.(normalizedNextPreference);
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

    refreshCollisionAutoRestartPanel() {
        this._syncBooleanSettingRow({
            getValue: getCollisionAutoRestartEnabled,
            switchEl: this.collisionAutoRestartSwitch,
            headingEl: this.collisionAutoRestartHeading,
            descEl: this.collisionAutoRestartDesc,
            title: 'Collision Auto-Restart',
        });
    }

    refreshQuickRestartPanel() {
        this._syncBooleanSettingRow({
            getValue: getQuickRestartEnabled,
            switchEl: this.quickRestartSwitch,
            headingEl: this.quickRestartHeading,
            title: 'Quick Restart',
        });
        this.syncQuickRestartRowVisibility();
    }

    // While Quick Restart is held back, its row is hidden and its switch is
    // disabled, so keyboard navigation skips it.
    syncQuickRestartRowVisibility() {
        const switchEl = this.quickRestartSwitch;
        if (!switchEl) return;
        const hidden = !QUICK_RESTART_SETTING_VISIBLE;
        switchEl.disabled = hidden;
        const desc = document.getElementById('settings-quick-restart-desc');
        const divider = desc?.nextElementSibling?.classList?.contains('modal-sheet-settings-row-divider')
            ? desc.nextElementSibling
            : null;
        const rowParts = [switchEl.closest?.('.modal-sheet-settings-identity-head'), desc, divider];
        for (const part of rowParts) {
            if (!part) continue;
            part.hidden = hidden;
            part.style.display = hidden ? 'none' : '';
        }
    }

    refreshPausePlacementPanel() {
        const placement = getPausePlacement();
        if (this.pausePlacementGroup) {
            this.pausePlacementGroup.dataset.selected = placement;
        }
        this.pausePlacementGroup?.querySelectorAll?.('[data-pause-placement]').forEach((option) => {
            option.setAttribute('aria-checked', option.dataset.pausePlacement === placement ? 'true' : 'false');
        });
        if (this.pausePlacementHeading) {
            this.pausePlacementHeading.textContent = 'Pause';
        }
    }

    refreshHideHudPanel() {
        this._syncBooleanSettingRow({
            getValue: getHideHudEnabled,
            switchEl: this.hideHudSwitch,
            headingEl: this.hideHudHeading,
            title: 'Hide HUD',
        });
    }

    refreshPbGhostPanel() {
        this._syncBooleanSettingRow({
            getValue: getPbGhostEnabled,
            switchEl: this.pbGhostSwitch,
            headingEl: this.pbGhostHeading,
            title: 'Personal Best Ghost',
        });
    }

    refreshCollisionRestartDelayPanel() {
        const sec = getCollisionRestartDelaySec();
        const step = collisionRestartDelayToMeterStep(sec);
        const maxStep = COLLISION_RESTART_DELAY_METER_TICKS - 1;

        const meter = this.collisionRestartDelayMeter;
        if (meter) {
            meter.setAttribute('aria-valuenow', String(step));
            meter.setAttribute('aria-valuemin', '0');
            meter.setAttribute('aria-valuemax', String(maxStep));
            const ticks = meter.querySelectorAll('.settings-collision-delay-meter__tick');
            ticks.forEach((tick, index) => {
                tick.classList.toggle('is-filled', index <= step);
                tick.classList.toggle('is-active', index === step);
            });
        }

        const label = sec <= 0 ? 'Instant' : `${sec.toFixed(1)} s`;
        if (this.collisionRestartDelayValue) {
            this.collisionRestartDelayValue.textContent = label;
        }
        if (this.collisionRestartDelayHeading) {
            this.collisionRestartDelayHeading.textContent = 'Collision Restart Delay';
        }
        if (this.collisionRestartDelayDesc) {
            this.collisionRestartDelayDesc.textContent = '';
        }
        if (this.collisionRestartDelayMinus) {
            this.collisionRestartDelayMinus.disabled = step <= 0;
        }
        if (this.collisionRestartDelayPlus) {
            this.collisionRestartDelayPlus.disabled = step >= maxStep;
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
        if (
            this.modal?.isPauseModalActive?.()
            || this.modal?.isCombinedResultsModalActive?.()
        ) {
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
        this.refreshCollisionAutoRestartPanel();
        this.refreshQuickRestartPanel();
        this.refreshPausePlacementPanel();
        this.refreshHideHudPanel();
        this.refreshPbGhostPanel();
        this.wireCollisionRestartDelayMeter();
        this.refreshCollisionRestartDelayPanel();
        this.onCollisionAutoRestartChanged?.(getCollisionAutoRestartEnabled());
        this.onQuickRestartChanged?.(isQuickRestartActive());
        this.onCollisionRestartDelayChanged?.(getCollisionRestartDelaySec());
        void this.syncIdentityBootstrap();

        openModalElement(this.settingsModal, () => this.settingsModal.classList.add('active'));

        requestAnimationFrame(() => {
            if (this.modal && this.modal.activateModalFocusTrap) {
                this.modal.activateModalFocusTrap(this.settingsModal);
            }
            this.modal?.resetSettingsMenuKeyboardNav?.();
        });
    }
}
