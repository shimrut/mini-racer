import {
    PLAYER_CAR_SKIN_SECTIONS,
    PLAYER_CAR_SKINS,
    getPlayerCarSkinUnlockLabel,
    getPlayerCarSkinUnlockProgress,
    isPlayerCarSkinUnlocked,
    readPlayerCarSkinAssetName,
    writePlayerCarSkinAssetName
} from '../car/player-car-skin.js';
import {
    PLAYER_TRAIL_COLORS,
    readPlayerTrailId,
    readPlayerTrailStrokeStyle,
    writePlayerTrailId
} from '../car/player-trail.js';
import { setCarAssetImageWithFallbacks } from '../car/sprite.js';
import { createLockIconSvg } from '../ui/lock-icon.js';
import { closeModalElement, openModalElement } from '../ui/modal-handoff.js';
import { bindReusableModal, configureReusableModal } from '../ui/reusable-modal.js';

const GARAGE_TABS = Object.freeze(['skin', 'trails']);
const SVG_NS = 'http://www.w3.org/2000/svg';

export class GarageUi {
    constructor({
        onCarSkinChanged = null,
        onTrailStrokeStyleChanged = null,
        onPlayerPreferencesChanged = null,
        modal = null,
    } = {}) {
        this.onCarSkinChanged = onCarSkinChanged;
        this.onTrailStrokeStyleChanged = onTrailStrokeStyleChanged;
        this.onPlayerPreferencesChanged = onPlayerPreferencesChanged;
        this.modal = modal;
        this.activeGarageTab = 'skin';
        this.skinOptionButtons = new Map();
        this.trailOptionButtons = new Map();
        this.unlockDetailsPanel = null;
    }

    get panel() { return document.getElementById('garage-panel'); }
    get garageModal() { return document.getElementById('garage-modal'); }
    get garageButton() { return document.getElementById('menu-btn-garage'); }
    get garageToggleButtons() { return document.querySelectorAll('[aria-controls="garage-modal"]'); }
    get closeButton() { return document.getElementById('garage-close-btn'); }
    get tabSkin() { return document.getElementById('garage-tab-skin'); }
    get tabTrails() { return document.getElementById('garage-tab-trails'); }
    get panelSkin() { return document.getElementById('garage-panel-skin'); }
    get panelTrails() { return document.getElementById('garage-panel-trails'); }
    get skinGrid() { return document.getElementById('garage-skin-grid'); }
    get trailGrid() { return document.getElementById('garage-trail-grid'); }

    bind() {
        this.setGarageTab(this.activeGarageTab, { focusTab: false });
        configureReusableModal(this.garageModal, {
            title: 'Garage',
            subtitle: 'Car Style',
            closeLabel: 'Back',
        });
        bindReusableModal(this.garageModal, () => this.setPanelVisible(false));

        this.garageToggleButtons.forEach((button) => {
            button.addEventListener('click', () => this.togglePanel());
        });
        this.tabSkin?.addEventListener('click', () => this.setGarageTab('skin'));
        this.tabTrails?.addEventListener('click', () => this.setGarageTab('trails'));
    }

    /**
     * Each option in these grids pulls its own image, so they are built the first time
     * the Garage opens rather than competing at boot with the one car being raced.
     */
    buildGarageGrids() {
        if (this._garageGridsBuilt) return;
        this._garageGridsBuilt = true;
        this.buildSkinGrid();
        this.buildTrailGrid();
        this.syncSkinSelection();
        this.syncTrailSelection();
    }

    setPanelVisible(isVisible) {
        const panel = this.panel;
        const garageModal = this.garageModal;
        if (!panel || !garageModal) return;
        panel.hidden = !isVisible;
        if (isVisible) {
            this.buildGarageGrids();
            openModalElement(garageModal, () => garageModal.classList.add('active'));
        } else {
            closeModalElement(garageModal, () => garageModal.classList.remove('active'));
        }
        this.garageToggleButtons.forEach((button) => {
            button.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
            if (button.classList.contains('combined-action-btn')) {
                button.classList.toggle('combined-action-btn--active', Boolean(isVisible));
            }
        });
        if (isVisible) {
            this.setGarageTab(this.activeGarageTab, { focusTab: false });
            requestAnimationFrame(() => {
                this.modal?.activateModalFocusTrap?.(garageModal);
                this.modal?.resetGarageMenuKeyboardNav?.();
            });
        } else {
            this.closeUnlockDetails({ restoreFocus: false });
            this.modal?.releaseModalFocusTrap?.(garageModal);
            if (this.modal?.isModalActive?.()) {
                requestAnimationFrame(() => this.modal?.activateModalFocusTrap?.(this.modal.modal));
            }
        }
    }

    isGarageOpen() {
        return Boolean(this.garageModal?.classList.contains('active'));
    }

    togglePanel() {
        this.setPanelVisible(!this.isGarageOpen());
    }

    setGarageTab(tab, { focusTab = true } = {}) {
        this.activeGarageTab = GARAGE_TABS.includes(tab) ? tab : 'skin';

        const tabButtons = [
            ['skin', this.tabSkin],
            ['trails', this.tabTrails]
        ];
        for (const [id, el] of tabButtons) {
            const selected = id === this.activeGarageTab;
            el?.setAttribute('aria-selected', selected ? 'true' : 'false');
            el?.classList.toggle('is-selected', selected);
        }

        this.panelSkin?.toggleAttribute('hidden', this.activeGarageTab !== 'skin');
        this.panelTrails?.toggleAttribute('hidden', this.activeGarageTab !== 'trails');

        if (focusTab) {
            const focusEl = tabButtons.find(([id]) => id === this.activeGarageTab)?.[1];
            focusEl?.focus();
        }
        this.modal?.onGarageTabChangedForKeyboardNav?.();
    }

    buildSkinGrid() {
        const host = this.skinGrid;
        if (!host) return;
        host.replaceChildren();
        this.skinOptionButtons.clear();

        for (const section of PLAYER_CAR_SKIN_SECTIONS) {
            const sectionEl = document.createElement('section');
            sectionEl.className = 'garage-skin-section';

            const titleId = `garage-skin-section-${section.id}`;
            const title = document.createElement('h3');
            title.id = titleId;
            title.className = 'garage-skin-section__title';
            title.textContent = section.title;
            sectionEl.setAttribute('aria-labelledby', titleId);

            const grid = document.createElement('div');
            grid.className = 'garage-skin-grid';

            for (const skin of section.skins) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'garage-skin-option';
                btn.dataset.assetName = skin.assetName;
                btn.setAttribute('aria-pressed', 'false');

                const thumb = document.createElement('img');
                thumb.className = 'garage-skin-option__thumb';
                thumb.alt = '';
                thumb.decoding = 'async';
                setCarAssetImageWithFallbacks(thumb, skin.assetName);

                const label = document.createElement('span');
                label.className = 'garage-skin-option__label';
                label.textContent = skin.label;

                const lockIndicator = this.createLockIndicator();

                btn.append(thumb, label, lockIndicator);
                btn.addEventListener('click', () => {
                    if (isPlayerCarSkinUnlocked(skin.assetName)) {
                        this.selectCarSkin(skin.assetName);
                    } else {
                        this.showUnlockDetails(skin, btn);
                    }
                });
                grid.appendChild(btn);
                this.skinOptionButtons.set(skin.assetName, btn);
            }

            sectionEl.append(title, grid);
            host.appendChild(sectionEl);
        }
        this.refreshCarUnlocks();
    }

    createLockIndicator() {
        const indicator = document.createElement('span');
        indicator.className = 'garage-skin-option__lock';
        indicator.setAttribute('aria-hidden', 'true');

        const progress = document.createElementNS(SVG_NS, 'svg');
        progress.classList.add('garage-skin-option__progress');
        progress.setAttribute('viewBox', '0 0 44 44');

        const track = document.createElementNS(SVG_NS, 'circle');
        track.classList.add('garage-skin-option__progress-track');
        track.setAttribute('cx', '22');
        track.setAttribute('cy', '22');
        track.setAttribute('r', '19');

        const value = document.createElementNS(SVG_NS, 'circle');
        value.classList.add('garage-skin-option__progress-value');
        value.setAttribute('cx', '22');
        value.setAttribute('cy', '22');
        value.setAttribute('r', '19');
        value.setAttribute('pathLength', '100');
        progress.append(track, value);

        const lock = createLockIconSvg('garage-skin-option__lock-icon');

        indicator.append(progress, lock);
        return indicator;
    }

    showUnlockDetails(skin, restoreFocusElement = null) {
        const status = getPlayerCarSkinUnlockProgress(skin.assetName);
        const host = this.garageModal?.querySelector?.('.modal-view');
        if (!status || status.unlocked || !host) return;
        this.closeUnlockDetails({ restoreFocus: false });

        const scrim = document.createElement('section');
        scrim.className = 'result-share-panel garage-unlock-panel';
        scrim.setAttribute('role', 'dialog');
        scrim.setAttribute('aria-label', `${skin.label} unlock requirements`);
        scrim.dataset.nestedModal = '';
        scrim._restoreFocusElement = restoreFocusElement;

        const card = document.createElement('div');
        card.className = 'result-share-panel__card garage-unlock-panel__card';
        const title = document.createElement('h3');
        title.className = 'result-share-panel__title';
        title.textContent = `${skin.label} locked`;
        const statusLabel = document.createElement('p');
        statusLabel.className = 'result-share-panel__status';
        statusLabel.textContent = 'Unlock requirement';
        const requirement = document.createElement('blockquote');
        requirement.className = 'result-share-panel__copy';
        requirement.textContent = status.label;
        const progress = document.createElement('p');
        progress.className = 'garage-unlock-panel__progress';
        progress.textContent = `Progress ${status.current}/${status.required}`;
        const actions = document.createElement('div');
        actions.className = 'result-share-panel__actions';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'result-share-panel__button';
        close.dataset.nestedModalClose = '';
        close.textContent = 'Close';
        close.addEventListener('click', () => this.closeUnlockDetails());

        actions.appendChild(close);
        card.append(title, statusLabel, requirement, progress, actions);
        scrim.appendChild(card);
        host.appendChild(scrim);
        this.unlockDetailsPanel = scrim;
        this.modal?.resetGarageMenuKeyboardNav?.();
    }

    closeUnlockDetails({ restoreFocus = true } = {}) {
        const panel = this.unlockDetailsPanel;
        if (!panel) return;
        const restoreFocusElement = panel._restoreFocusElement || null;
        panel.remove();
        this.unlockDetailsPanel = null;
        if (restoreFocus && restoreFocusElement) {
            this.modal?.resetGarageMenuKeyboardNav?.({
                preferredElement: restoreFocusElement,
            });
        } else {
            this.modal?.resetGarageMenuKeyboardNav?.();
        }
        if (
            restoreFocus
            && !this.modal?.resetGarageMenuKeyboardNav
            && typeof restoreFocusElement?.focus === 'function'
        ) {
            restoreFocusElement.focus();
        }
    }

    selectCarSkin(assetName) {
        if (!isPlayerCarSkinUnlocked(assetName)) return;
        const next = writePlayerCarSkinAssetName(assetName);
        this.syncSkinSelection();
        this.onCarSkinChanged?.(next);
        this.onPlayerPreferencesChanged?.();
    }

    refreshCarUnlocks() {
        for (const skin of PLAYER_CAR_SKINS) {
            const btn = this.skinOptionButtons.get(skin.assetName);
            if (!btn) continue;
            const unlocked = isPlayerCarSkinUnlocked(skin.assetName);
            const unlockLabel = getPlayerCarSkinUnlockLabel(skin.assetName);
            const unlockProgress = getPlayerCarSkinUnlockProgress(skin.assetName);
            const progressValue = btn.querySelector('.garage-skin-option__progress-value');
            btn.disabled = false;
            btn.classList.toggle('is-locked', !unlocked);
            btn.setAttribute('aria-disabled', !unlocked ? 'true' : 'false');
            btn.setAttribute('aria-label', !unlocked && unlockLabel
                ? `${skin.label}. Locked. ${unlockLabel} Progress ${unlockProgress?.current ?? 0} of ${unlockProgress?.required ?? 1}. Open unlock requirements.`
                : skin.label);
            const lockIndicator = btn.querySelector('.garage-skin-option__lock');
            const ratio = Math.max(0, Math.min(1, unlockProgress?.ratio ?? 0));
            if (lockIndicator) {
                lockIndicator.hidden = unlocked;
                lockIndicator.classList.toggle('has-progress', !unlocked && ratio > 0);
            }
            if (progressValue) {
                progressValue.style.strokeDashoffset = String(100 - (ratio * 100));
            }
        }
        this.syncSkinSelection();
        this.modal?.resetGarageMenuKeyboardNav?.();
    }

    syncSkinSelection() {
        const current = readPlayerCarSkinAssetName();
        for (const [assetName, btn] of this.skinOptionButtons) {
            const selected = assetName === current;
            btn.classList.toggle('is-selected', selected);
            btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
        }
    }

    buildTrailGrid() {
        const grid = this.trailGrid;
        if (!grid) return;
        grid.replaceChildren();
        this.trailOptionButtons.clear();

        for (const trail of PLAYER_TRAIL_COLORS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'garage-trail-option';
            btn.dataset.trailId = trail.id;
            btn.setAttribute('aria-pressed', 'false');

            const swatch = document.createElement('span');
            swatch.className = 'garage-trail-option__swatch';
            if (trail.id !== 'none') {
                swatch.style.backgroundColor = trail.swatch;
            } else {
                swatch.classList.add('garage-trail-option__swatch--none');
            }

            const label = document.createElement('span');
            label.className = 'garage-trail-option__label';
            label.textContent = trail.label;

            btn.append(swatch, label);
            btn.addEventListener('click', () => this.selectTrail(trail.id));
            grid.appendChild(btn);
            this.trailOptionButtons.set(trail.id, btn);
        }
    }

    selectTrail(trailId) {
        writePlayerTrailId(trailId);
        this.syncTrailSelection();
        this.onTrailStrokeStyleChanged?.(readPlayerTrailStrokeStyle());
        this.onPlayerPreferencesChanged?.();
    }

    syncTrailSelection() {
        const current = readPlayerTrailId();
        for (const [id, btn] of this.trailOptionButtons) {
            const selected = id === current;
            btn.classList.toggle('is-selected', selected);
            btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
        }
    }
}
