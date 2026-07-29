import {
    PLAYER_CAR_SKIN_SECTIONS,
    PLAYER_CAR_SKINS,
    getPlayerCarSkinUnlockLabel,
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
import { closeModalElement, openModalElement } from '../ui/modal-handoff.js';
import { bindReusableModal, configureReusableModal } from '../ui/reusable-modal.js';

const GARAGE_TABS = Object.freeze(['skin', 'trails']);

export class GarageUi {
    constructor({
        onCarSkinChanged = null,
        onTrailStrokeStyleChanged = null,
        onPlayerPreferencesChanged = null,
        prefetchCarSpriteAsset = null,
        modal = null,
    } = {}) {
        this.onCarSkinChanged = onCarSkinChanged;
        this.onTrailStrokeStyleChanged = onTrailStrokeStyleChanged;
        this.onPlayerPreferencesChanged = onPlayerPreferencesChanged;
        this.prefetchCarSpriteAsset = prefetchCarSpriteAsset;
        this.modal = modal;
        this.activeGarageTab = 'skin';
        this.skinOptionButtons = new Map();
        this.trailOptionButtons = new Map();
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
        this.buildSkinGrid();
        this.buildTrailGrid();
        this.syncSkinSelection();
        this.syncTrailSelection();
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

        if (typeof this.prefetchCarSpriteAsset === 'function') {
            for (const { assetName } of PLAYER_CAR_SKINS) {
                this.prefetchCarSpriteAsset(assetName);
            }
        }
    }

    setPanelVisible(isVisible) {
        const panel = this.panel;
        const garageModal = this.garageModal;
        if (!panel || !garageModal) return;
        panel.hidden = !isVisible;
        if (isVisible) {
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

                const requirement = document.createElement('span');
                requirement.className = 'garage-skin-option__requirement';

                btn.append(thumb, label, requirement);
                btn.addEventListener('click', () => this.selectCarSkin(skin.assetName));
                grid.appendChild(btn);
                this.skinOptionButtons.set(skin.assetName, btn);
            }

            sectionEl.append(title, grid);
            host.appendChild(sectionEl);
        }
        this.refreshCarUnlocks();
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
            const requirement = btn.querySelector('.garage-skin-option__requirement');
            btn.disabled = !unlocked;
            btn.classList.toggle('is-locked', !unlocked);
            btn.setAttribute('aria-label', !unlocked && unlockLabel
                ? `${skin.label}. Locked. ${unlockLabel}`
                : skin.label);
            if (requirement) {
                requirement.textContent = !unlocked ? unlockLabel : '';
                requirement.hidden = unlocked;
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
