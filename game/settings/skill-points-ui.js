import {
    DEFAULT_SKILL_POINT_ALLOCATION,
    SKILL_POINT_DEFINITIONS,
    SKILL_POINT_TOTAL,
    getSkillPointDisplayValues,
    isDefaultSkillPointAllocation,
    normalizeSkillPointAllocation,
    readSkillPointAllocation,
    writeSkillPointAllocation
} from '../car/skill-points.js';
import {
    PLAYER_CAR_SKIN_SECTIONS,
    PLAYER_CAR_SKINS,
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

const GARAGE_TABS = Object.freeze(['tuning', 'skin', 'trails']);

export class SkillPointsUi {
    constructor({
        getBaseConfig = () => ({}),
        onAllocationChanged = null,
        onCarSkinChanged = null,
        onTrailStrokeStyleChanged = null,
        prefetchCarSpriteAsset = null,
        modal = null,
    } = {}) {
        this.getBaseConfig = getBaseConfig;
        this.onAllocationChanged = onAllocationChanged;
        this.onCarSkinChanged = onCarSkinChanged;
        this.onTrailStrokeStyleChanged = onTrailStrokeStyleChanged;
        this.prefetchCarSpriteAsset = prefetchCarSpriteAsset;
        this.modal = modal;
        this.allocation = readSkillPointAllocation();
        this.activeGarageTab = 'tuning';
        this.skinOptionButtons = new Map();
        this.trailOptionButtons = new Map();
    }

    get panel() { return document.getElementById('skill-points-panel'); }
    get garageModal() { return document.getElementById('garage-modal'); }
    get rows() { return document.getElementById('skill-points-rows'); }
    get remaining() { return document.getElementById('skill-points-remaining'); }
    get garageButton() { return document.getElementById('menu-btn-garage'); }
    get closeButton() { return document.getElementById('skill-points-close-btn'); }
    get resetButton() { return document.getElementById('skill-points-reset-btn'); }
    get tabTuning() { return document.getElementById('garage-tab-tuning'); }
    get tabSkin() { return document.getElementById('garage-tab-skin'); }
    get tabTrails() { return document.getElementById('garage-tab-trails'); }
    get panelTuning() { return document.getElementById('garage-panel-tuning'); }
    get panelSkin() { return document.getElementById('garage-panel-skin'); }
    get panelTrails() { return document.getElementById('garage-panel-trails'); }
    get skinGrid() { return document.getElementById('garage-skin-grid'); }
    get trailGrid() { return document.getElementById('garage-trail-grid'); }

    bind() {
        this.render();
        this.buildSkinGrid();
        this.buildTrailGrid();
        this.syncSkinSelection();
        this.syncTrailSelection();
        this.setGarageTab(this.activeGarageTab, { focusTab: false });

        this.garageButton?.addEventListener('click', () => this.togglePanel());
        this.closeButton?.addEventListener('click', () => this.setPanelVisible(false));
        this.resetButton?.addEventListener('click', () => {
            this.setAllocation(DEFAULT_SKILL_POINT_ALLOCATION);
        });
        this.tabTuning?.addEventListener('click', () => this.setGarageTab('tuning'));
        this.tabSkin?.addEventListener('click', () => this.setGarageTab('skin'));
        this.tabTrails?.addEventListener('click', () => this.setGarageTab('trails'));

        if (typeof this.prefetchCarSpriteAsset === 'function') {
            for (const { assetName } of PLAYER_CAR_SKINS) {
                this.prefetchCarSpriteAsset(assetName);
            }
        }
    }

    getAllocation() {
        return normalizeSkillPointAllocation(this.allocation);
    }

    setAllocation(allocation) {
        this.allocation = writeSkillPointAllocation(allocation);
        this.render();
        this.onAllocationChanged?.(this.getAllocation());
    }

    setPanelVisible(isVisible) {
        const panel = this.panel;
        const garageModal = this.garageModal;
        if (!panel || !garageModal) return;
        panel.hidden = !isVisible;
        garageModal.classList.toggle('active', Boolean(isVisible));
        this.garageButton?.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
        if (isVisible) {
            this.setGarageTab(this.activeGarageTab, { focusTab: false });
            requestAnimationFrame(() => this.modal?.activateModalFocusTrap?.(garageModal));
        } else {
            this.modal?.releaseModalFocusTrap?.(garageModal);
        }
    }

    isGarageOpen() {
        return Boolean(this.garageModal?.classList.contains('active'));
    }

    togglePanel() {
        this.setPanelVisible(!this.isGarageOpen());
    }

    setGarageTab(tab, { focusTab = true } = {}) {
        this.activeGarageTab = GARAGE_TABS.includes(tab) ? tab : 'tuning';

        const tabButtons = [
            ['tuning', this.tabTuning],
            ['skin', this.tabSkin],
            ['trails', this.tabTrails]
        ];
        for (const [id, el] of tabButtons) {
            const selected = id === this.activeGarageTab;
            el?.setAttribute('aria-selected', selected ? 'true' : 'false');
            el?.classList.toggle('is-selected', selected);
        }

        this.panelTuning?.toggleAttribute('hidden', this.activeGarageTab !== 'tuning');
        this.panelSkin?.toggleAttribute('hidden', this.activeGarageTab !== 'skin');
        this.panelTrails?.toggleAttribute('hidden', this.activeGarageTab !== 'trails');

        if (focusTab) {
            const focusEl = tabButtons.find(([id]) => id === this.activeGarageTab)?.[1];
            focusEl?.focus();
        }
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

                btn.append(thumb, label);
                btn.addEventListener('click', () => this.selectCarSkin(skin.assetName));
                grid.appendChild(btn);
                this.skinOptionButtons.set(skin.assetName, btn);
            }

            sectionEl.append(title, grid);
            host.appendChild(sectionEl);
        }
    }

    selectCarSkin(assetName) {
        const next = writePlayerCarSkinAssetName(assetName);
        this.syncSkinSelection();
        this.onCarSkinChanged?.(next);
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
            swatch.style.backgroundColor = trail.swatch;

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
    }

    syncTrailSelection() {
        const current = readPlayerTrailId();
        for (const [id, btn] of this.trailOptionButtons) {
            const selected = id === current;
            btn.classList.toggle('is-selected', selected);
            btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
        }
    }

    adjustSkill(skillKey, delta) {
        if (!SKILL_POINT_DEFINITIONS.some(({ key }) => key === skillKey)) return;

        const next = { ...this.allocation };
        const current = Math.trunc(next[skillKey] || 0);
        const used = SKILL_POINT_DEFINITIONS.reduce((total, { key }) => total + Math.trunc(next[key] || 0), 0);
        if (delta > 0 && used >= SKILL_POINT_TOTAL) return;
        if (delta < 0 && current <= 0) return;

        next[skillKey] = current + delta;
        this.setAllocation(next);
    }

    createSkillRow({ key, label }, statValues, used) {
        const row = document.createElement('div');
        row.className = 'skill-points-row';

        const labelEl = document.createElement('div');
        labelEl.className = 'skill-points-row__label';
        labelEl.textContent = label;

        if (key === 'accel') {
            row.classList.add('skill-points-row--accel');
        } else if (key === 'speed') {
            row.classList.add('skill-points-row--speed');
        } else if (key === 'handling') {
            row.classList.add('skill-points-row--handling');
        }

        const value = Math.trunc(this.allocation[key] || 0);
        const meter = document.createElement('div');
        meter.className = 'skill-points-meter';
        meter.setAttribute('aria-label', `${label}: ${value} skill points`);
        for (let index = 0; index < SKILL_POINT_TOTAL; index += 1) {
            const segment = document.createElement('span');
            segment.className = 'skill-points-meter__segment';
            segment.classList.toggle('is-filled', index < value);
            meter.appendChild(segment);
        }

        const effect = document.createElement('div');
        effect.className = 'skill-points-row__effect';
        if (key === 'accel') {
            const desktopNum = document.createElement('span');
            desktopNum.className = 'skill-points-row__effect-desktop';
            desktopNum.textContent = statValues.accelNumber || statValues.accel || '';
            const mobileFull = document.createElement('span');
            mobileFull.className = 'skill-points-row__effect-mobile';
            mobileFull.textContent = statValues.accelNumber || statValues.accel || '';
            effect.append(desktopNum, mobileFull);
        } else if (key === 'speed') {
            const desktopNum = document.createElement('span');
            desktopNum.className = 'skill-points-row__effect-desktop';
            desktopNum.textContent = statValues.speedNumber || statValues.speed || '';
            const mobileFull = document.createElement('span');
            mobileFull.className = 'skill-points-row__effect-mobile';
            mobileFull.textContent = statValues.speedNumber || statValues.speed || '';
            effect.append(desktopNum, mobileFull);
        } else {
            const desktopNumber = document.createElement('span');
            desktopNumber.className = 'skill-points-row__effect-desktop';
            desktopNumber.textContent = statValues[`${key}Number`] || statValues[key] || '';
            const mobileFull = document.createElement('span');
            mobileFull.className = 'skill-points-row__effect-mobile';
            mobileFull.textContent = statValues[`${key}Number`] || statValues[key] || '';
            effect.append(desktopNumber, mobileFull);
        }

        const controls = document.createElement('div');
        controls.className = 'skill-points-row__controls';

        const minus = document.createElement('button');
        minus.className = 'skill-points-stepper';
        minus.type = 'button';
        minus.textContent = '-';
        minus.disabled = value <= 0;
        minus.setAttribute('aria-label', `Remove one point from ${label}`);
        minus.addEventListener('click', () => this.adjustSkill(key, -1));

        const plus = document.createElement('button');
        plus.className = 'skill-points-stepper';
        plus.type = 'button';
        plus.textContent = '+';
        plus.disabled = used >= SKILL_POINT_TOTAL;
        plus.setAttribute('aria-label', `Add one point to ${label}`);
        plus.addEventListener('click', () => this.adjustSkill(key, 1));

        controls.append(minus, plus);
        row.append(labelEl, meter, effect, controls);
        return row;
    }

    render() {
        const rows = this.rows;
        if (!rows) return;

        this.allocation = normalizeSkillPointAllocation(this.allocation);
        const used = SKILL_POINT_DEFINITIONS.reduce(
            (total, { key }) => total + Math.trunc(this.allocation[key] || 0),
            0
        );
        const statValues = getSkillPointDisplayValues(this.getBaseConfig?.() || {}, this.allocation);

        rows.replaceChildren();
        for (const definition of SKILL_POINT_DEFINITIONS) {
            rows.appendChild(this.createSkillRow(definition, statValues, used));
        }

        if (this.remaining) {
            const left = Math.max(0, SKILL_POINT_TOTAL - used);
            const inlineTune = Boolean(this.remaining.closest('#combined-tune-inline'));
            this.remaining.textContent = inlineTune ? String(left) : `Points left: ${left}`;
            this.remaining.setAttribute('aria-label', `${left} skill points remaining`);
        }

        if (this.resetButton) {
            this.resetButton.disabled = isDefaultSkillPointAllocation(this.allocation);
        }

        this.syncSkinSelection();
        this.syncTrailSelection();
    }
}
