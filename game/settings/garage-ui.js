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
import { getCarPaintColors, getDrawnCar, setCarAssetImageWithFallbacks } from '../car/sprite.js';
import { CAR_PAINT_CHANNELS, CAR_PAINT_COLORS, getCarPaintOptions } from '../car/car-paint.js';
import { paintTones } from '../car/drawn-car/paint.js';
import { readPlayerCarPaint, writePlayerCarPaint } from '../car/player-car-paint.js';
import { DRAWN_CAR_SKINS } from '../car/drawn-car-skins.js';
import { DrawnCar } from '../car/drawn-car.js';
import { getCarDecalStyleOptions } from '../car/car-decals.js';
import { readPlayerCarDecalStyle, writePlayerCarDecalStyle } from '../car/player-car-decals.js';
import { createLockIconSvg } from '../ui/lock-icon.js';
import { closeModalElement, openModalElement } from '../ui/modal-handoff.js';
import { bindReusableModal, configureReusableModal } from '../ui/reusable-modal.js';

const GARAGE_TYPES = Object.freeze([
    { id: 'street', series: 'formula', ground: 'tarmac' },
    { id: 'circuit', series: 'grip', ground: 'grip' },
    { id: 'dirt', series: 'dirt', ground: 'dirt' },
    { id: 'snow', series: 'snow', ground: 'snow' },
    { id: 'water', series: 'water', ground: 'water' },
    { id: 'space', series: 'space', ground: 'space' },
]);
const GARAGE_TABS = Object.freeze([...GARAGE_TYPES.map(({ id }) => id), 'legacy']);
const SVG_NS = 'http://www.w3.org/2000/svg';

// Bounds of visible pixels, or pixels that change between two paint probes.
export function getSpriteBounds(sprite, comparison = null) {
    const { data } = sprite.getContext('2d').getImageData(0, 0, sprite.width, sprite.height);
    const other = comparison?.getContext('2d').getImageData(0, 0, sprite.width, sprite.height).data;
    let left = sprite.width, right = -1, top = sprite.height, bottom = -1, count = 0;
    let halfLeft = sprite.width, halfRight = -1, halfTop = sprite.height, halfBottom = -1, halfCount = 0;
    let touchesCenter = false;
    for (let y = 0; y < sprite.height; y += 1) {
        for (let x = 0; x < sprite.width; x += 1) {
            const i = (y * sprite.width + x) * 4;
            const changed = other && (Math.abs(data[i] - other[i]) > 8
                || Math.abs(data[i + 1] - other[i + 1]) > 8 || Math.abs(data[i + 2] - other[i + 2]) > 8);
            if (data[i + 3] < 10 || (other && !changed)) continue;
            left = Math.min(left, x); right = Math.max(right, x);
            top = Math.min(top, y); bottom = Math.max(bottom, y);
            count += 1;
            if (other && Math.abs(y - sprite.height / 2) <= 2) touchesCenter = true;
            if (other && y < sprite.height / 2) {
                halfLeft = Math.min(halfLeft, x); halfRight = Math.max(halfRight, x);
                halfTop = Math.min(halfTop, y); halfBottom = Math.max(halfBottom, y);
                halfCount += 1;
            }
        }
    }
    // Mirrored stripes/wing ends are one element repeated on each side.
    // Show one side when the empty middle would shrink both in the detail.
    if (other && halfCount && bottom >= sprite.height / 2 && !touchesCenter) {
        return { left: halfLeft, top: halfTop, width: halfRight - halfLeft + 1,
            height: halfBottom - halfTop + 1, count: halfCount };
    }
    return right < left ? null : { left, top, width: right - left + 1, height: bottom - top + 1, count };
}

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
        this.activeGarageTab = 'street';
        this.colorOptionButtons = new Map();
        this.decalOptionButtons = new Map();
        this.paintRows = new Map();
        this.partPreviews = new Map();
        this.paintDetailRegions = new Map();
        this.previewArtwork = new WeakMap();
        this.previewCar = null;
        this.skinOptionButtons = new Map();
        this.trailOptionButtons = new Map();
        this.unlockDetailsPanel = null;
    }

    get panel() { return document.getElementById('garage-panel'); }
    get garageModal() { return document.getElementById('garage-modal'); }
    get garageToggleButtons() { return document.querySelectorAll('[aria-controls="garage-modal"]'); }
    get customPanel() { return document.getElementById('garage-panel-custom'); }
    get panelSkin() { return document.getElementById('garage-panel-skin'); }
    get panelTrails() { return document.getElementById('garage-panel-trails'); }
    get skinGrid() { return document.getElementById('garage-skin-grid'); }
    get trailGrid() { return document.getElementById('garage-trail-grid'); }

    bind() {
        this.setGarageTab(this.activeGarageTab, { focusTab: false });
        configureReusableModal(this.garageModal, {
            title: 'Garage',
            subtitle: '',
            closeLabel: 'Back',
        });
        bindReusableModal(this.garageModal, () => this.setPanelVisible(false));

        this.garageToggleButtons.forEach((button) => {
            button.addEventListener('click', () => this.togglePanel());
        });
        for (const id of GARAGE_TABS) {
            const button = document.getElementById(`garage-tab-${id}`);
            button?.addEventListener('click', () => this.setGarageTab(id));
            button?.addEventListener('focus', () => button.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
        }
    }

    buildGarageGrids() {
        if (this._garageGridsBuilt) return;
        this._garageGridsBuilt = true;
        this.buildCustomPanel();
        this.buildSkinGrid();
        this.buildTrailGrid();
        this.refreshCarUnlocks();
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
        this.activeGarageTab = GARAGE_TABS.includes(tab) ? tab : 'street';
        for (const id of GARAGE_TABS) {
            const button = document.getElementById(`garage-tab-${id}`);
            const selected = id === this.activeGarageTab;
            button?.setAttribute('aria-selected', String(selected));
            button?.classList.toggle('is-selected', selected);
        }
        const legacy = this.activeGarageTab === 'legacy';
        this.panelSkin?.toggleAttribute('hidden', !legacy);
        this.customPanel?.toggleAttribute('hidden', legacy);
        this.customPanel?.setAttribute('aria-labelledby', `garage-tab-${this.activeGarageTab}`);
        if (!legacy) {
            this.syncSkinSelection();
        }
        if (focusTab) document.getElementById(`garage-tab-${this.activeGarageTab}`)?.focus();
        if (legacy) this.syncTrailSelection();
        this.modal?.onGarageTabChangedForKeyboardNav?.();
    }

    get previewSkin() {
        const type = GARAGE_TYPES.find(({ id }) => id === this.activeGarageTab);
        if (!type) return null;
        const skins = PLAYER_CAR_SKINS.filter(({ series, assetName }) => series === type.series && DRAWN_CAR_SKINS[assetName]);
        const picked = readPlayerCarSkinAssetName(type.ground);
        return skins.find(({ assetName }) => assetName === picked) ?? skins[0];
    }

    get trailAssetName() {
        return this.previewSkin?.assetName ?? readPlayerCarSkinAssetName('tarmac');
    }

    buildCustomPanel() {
        const host = this.customPanel;
        if (!host) return;
        const showcase = document.createElement('section');
        showcase.className = 'garage-showcase';
        showcase.setAttribute('aria-label', 'Car preview');
        const stage = document.createElement('div');
        stage.className = 'garage-car-stage';
        this.carPreview = document.createElement('img');
        this.carPreview.className = 'garage-car-preview';
        this.carPreview.alt = 'Car, top view';
        stage.appendChild(this.carPreview);
        showcase.appendChild(stage);
        const paintPanel = document.createElement('section');
        paintPanel.className = 'garage-paint-panel';
        paintPanel.setAttribute('aria-label', 'Car colors');
        for (const channel of CAR_PAINT_CHANNELS) {
            const row = document.createElement('div');
            row.className = 'garage-paint-row';
            const preview = document.createElement('canvas');
            preview.className = 'garage-part-preview';
            preview.width = 192;
            preview.height = 160;
            preview.setAttribute('aria-hidden', 'true');
            this.partPreviews.set(channel.id, preview);
            const detail = document.createElement('div');
            detail.className = 'garage-part-detail';
            detail.appendChild(preview);
            const label = document.createElement('h3');
            label.id = `garage-paint-${channel.id}`;
            label.className = 'garage-paint-label';
            label.textContent = channel.label;
            const colors = document.createElement('div');
            colors.className = 'garage-color-options';
            colors.setAttribute('role', 'group');
            colors.setAttribute('aria-labelledby', label.id);
            this.paintRows.set(channel.id, { row, label, detail });
            for (const [index, color] of CAR_PAINT_COLORS.entries()) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'garage-color-option';
                button.style.setProperty('--paint-color', color.value);
                button.dataset.channel = channel.id;
                button.dataset.color = color.value;
                button.setAttribute('aria-label', `${channel.label}: ${color.label}`);
                button.setAttribute('aria-pressed', 'false');
                button.title = color.label;
                const swatch = document.createElement('span');
                swatch.className = 'color-swatch garage-color-swatch';
                swatch.setAttribute('aria-hidden', 'true');
                button.appendChild(swatch);
                button.addEventListener('click', () => {
                    const skin = this.previewSkin;
                    if (!skin) return;
                    if (button.dataset.preset === 'true') {
                        writePlayerCarPaint(skin.assetName, channel.id, null);
                    } else if (button.getAttribute('aria-pressed') !== 'true') {
                        writePlayerCarPaint(skin.assetName, channel.id, button.dataset.color);
                    }
                    this.selectCarSkin(skin.assetName);
                });
                colors.appendChild(button);
                this.colorOptionButtons.set(`${channel.id}:${index}`, button);
            }
            row.append(detail, label, colors);
            paintPanel.appendChild(row);
        }
        const decalPanel = document.createElement('section');
        decalPanel.className = 'garage-paint-panel';
        const decalRow = document.createElement('div');
        decalRow.className = 'garage-paint-row garage-decal-row';
        const decalLabel = document.createElement('h3');
        decalLabel.id = 'garage-decal-label';
        decalLabel.className = 'garage-paint-label';
        decalLabel.textContent = 'Decal style';
        this.decalOptions = document.createElement('div');
        this.decalOptions.className = 'garage-decal-options';
        this.decalOptions.setAttribute('role', 'group');
        this.decalOptions.setAttribute('aria-labelledby', decalLabel.id);
        decalRow.append(decalLabel, this.decalOptions);
        decalPanel.appendChild(decalRow);
        host.replaceChildren(showcase, decalPanel, paintPanel);
    }

    buildDecalOptions(assetName) {
        if (!this.decalOptions) return;
        const model = DRAWN_CAR_SKINS[assetName].car;
        if (this.decalOptionModel === model) return;
        this.decalOptionModel = model;
        this.decalOptions.replaceChildren();
        this.decalOptionButtons.clear();
        const styles = getCarDecalStyleOptions(assetName);
        this.decalOptions.style.setProperty('--decal-count', styles.length);
        for (const [index, style] of styles.entries()) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'garage-skin-option garage-decal-option';
            button.dataset.decalStyle = style.id;
            button.setAttribute('aria-pressed', 'false');
            button.setAttribute('aria-label', `Decal style ${index + 1}: ${style.label} pattern`);
            button.title = `${style.label} decal pattern`;
            const image = document.createElement('img');
            image.className = 'garage-skin-option__thumb';
            image.alt = '';
            const label = document.createElement('span');
            label.className = 'garage-skin-option__label';
            label.textContent = `Style ${index + 1}`;
            button.append(image, label);
            button.addEventListener('click', () => {
                const skin = this.previewSkin;
                if (!skin || !isPlayerCarSkinUnlocked(skin.assetName)) return;
                writePlayerCarDecalStyle(skin.assetName, style.id);
                this.selectCarSkin(skin.assetName);
            });
            this.decalOptions.appendChild(button);
            this.decalOptionButtons.set(style.id, button);
        }
    }

    syncCustomPreview() {
        const skin = this.previewSkin;
        if (!skin || !this.carPreview) return;
        const options = {
            paint: readPlayerCarPaint(skin.assetName),
            decalStyle: readPlayerCarDecalStyle(skin.assetName),
        };
        const car = getDrawnCar(skin.assetName, options);
        if (!car) return;
        this.buildDecalOptions(skin.assetName);
        let artwork = this.previewArtwork.get(car);
        if (!artwork) {
            // Render the large still at three times the race sprite's density.
            // Keep it separate from the cached car used during racing.
            const showcase = new DrawnCar(car.car, DRAWN_CAR_SKINS[skin.assetName], {
                ...options, pixelsPerUnit: 9,
            });
            this.setShowcaseImage(showcase.sprite);
            const regionKey = `${skin.assetName}:${JSON.stringify(car.decals)}`;
            if (!this.paintDetailRegions.has(regionKey)) {
                this.paintDetailRegions.set(regionKey, this.findPaintDetails(car));
            }
            const details = new Map();
            for (const [channel, target] of this.partPreviews) {
                const bounds = this.paintDetailRegions.get(regionKey).get(channel);
                if (!bounds) continue;
                const canvas = document.createElement('canvas');
                canvas.width = target.width;
                canvas.height = target.height;
                this.fitPartPreview(canvas, this.makePartDetail(car, bounds), bounds);
                details.set(channel, canvas);
            }
            artwork = { image: this.carPreview.src, details, decalImages: new Map() };
            this.previewArtwork.set(car, artwork);
        }
        const equipped = readPlayerCarSkinAssetName(skin.ground) === skin.assetName;
        for (const [id, button] of this.decalOptionButtons) {
            const selected = equipped && id === (options.decalStyle ?? skin.assetName);
            button.classList.toggle('is-selected', selected);
            button.setAttribute('aria-pressed', String(selected));
            if (!artwork.decalImages.has(id)) {
                const image = button.querySelector('img');
                if (selected) image.src = artwork.image;
                else {
                    // Transient previews use the same constructor without
                    // replacing the cached animated car for this skin.
                    const preview = new DrawnCar(car.car, DRAWN_CAR_SKINS[skin.assetName], {
                        paint: options.paint, decalStyle: id,
                    });
                    this.setShowcaseImage(preview.sprite, image);
                }
                artwork.decalImages.set(id, image.src);
            }
            button.querySelector('img').src = artwork.decalImages.get(id);
        }
        const paint = getCarPaintColors(skin.assetName, options);
        const preset = getCarPaintColors(skin.assetName);
        for (const channel of CAR_PAINT_CHANNELS) {
            const used = artwork.details.has(channel.id);
            const paintRow = this.paintRows.get(channel.id);
            if (paintRow) {
                paintRow.row.classList.toggle('is-unused', !used);
                paintRow.detail.hidden = !used;
                paintRow.label.textContent = `${channel.label}${used ? '' : ' (unused)'}`;
            }
            getCarPaintOptions(preset[channel.id], paint[channel.id]).forEach((color, index) => {
                const button = this.colorOptionButtons.get(`${channel.id}:${index}`);
                if (!button) return;
                button.dataset.color = color.value;
                button.dataset.preset = String(color.id === 'preset');
                button.style.setProperty('--paint-color', color.value);
                button.title = `${color.label} (${color.value})`;
                button.setAttribute('aria-label', `${channel.label}: ${button.title}`);
                button.disabled = !used;
                const active = paint[channel.id]?.toLowerCase() === color.value;
                button.classList.toggle('is-selected', active);
                button.setAttribute('aria-pressed', String(active));
            });
        }
        // Paint and decal refreshes reuse the prepared artwork. Only a different
        // resolved car requires another PNG or painted detail.
        if (this.previewCar === car) return;
        this.previewCar = car;
        this.carPreview.src = artwork.image;
        for (const [channel, canvas] of this.partPreviews) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const detail = artwork.details.get(channel);
            if (detail) ctx.drawImage(detail, 0, 0);
        }
    }

    findPaintDetails(car) {
        const details = new Map();
        const white = paintTones('#ffffff');
        const black = paintTones('#000000');
        // The part renderer identifies its own used paint areas. Comparing two
        // colors locates the painted region without copying decal assignments
        // or maintaining model-specific crop coordinates.
        for (const id of new Set(car.placements.map((placement) => placement.id))) {
            const channels = new Set();
            car.partSprite([id], { single: true, paint: (area, fallback) => {
                const channel = car.paintForArea.channelFor(area, fallback);
                if (channel) channels.add(channel);
                return car.paintForArea(area, fallback);
            } });
            for (const channel of channels) {
                const render = (tones) => car.partSprite([id], { single: true,
                    paint: (area, fallback) => car.paintForArea.channelFor(area, fallback) === channel
                        ? tones : car.paintForArea(area, fallback),
                });
                const bounds = getSpriteBounds(render(white), render(black));
                if (bounds && bounds.count > (details.get(channel)?.count ?? 0)) {
                    const padding = car.pixelsPerUnit * 3;
                    const left = Math.max(0, bounds.left - padding);
                    const top = Math.max(0, bounds.top - padding);
                    const width = Math.min(car.sprite.width, bounds.left + bounds.width + padding) - left;
                    const height = Math.min(car.sprite.height, bounds.top + bounds.height + padding) - top;
                    // Body is a close-up around its center, rather than a
                    // second miniature of the complete pointed silhouette.
                    const detailWidth = channel === 'main' ? Math.min(width, height * 1.2) : width;
                    details.set(channel, { left: left + (width - detailWidth) / 2, top,
                        width: detailWidth, height, count: bounds.count, partId: id });
                }
            }
        }
        for (const bounds of details.values()) bounds.bodyPartId = details.get('main')?.partId;
        return details;
    }

    makePartDetail(car, bounds) {
        const part = car.partSprite([bounds.partId, bounds.bodyPartId]);
        const ctx = part.getContext('2d');
        // Keep overlays such as the cockpit inside the chosen part's shape,
        // while excluding neighboring tires/frame from the close-up.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-in';
        ctx.drawImage(car.sprite, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        return part;
    }

    fitPartPreview(canvas, sprite, bounds = getSpriteBounds(sprite)) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!bounds) return;
        const { left, top, width, height } = bounds;
        const scale = Math.min((canvas.width - 12) / width, (canvas.height - 12) / height);
        ctx.drawImage(sprite, left, top, width, height,
            (canvas.width - width * scale) / 2, (canvas.height - height * scale) / 2,
            width * scale, height * scale);
    }

    setShowcaseImage(sprite, target = this.carPreview) {
        const bounds = getSpriteBounds(sprite);
        if (!bounds) return;
        const canvas = document.createElement('canvas');
        canvas.width = bounds.width;
        canvas.height = bounds.height;
        canvas.getContext('2d').drawImage(sprite, -bounds.left, -bounds.top);
        target.src = canvas.toDataURL('image/png');
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

    // Each ground keeps its own pick; refresh that car and its per-skin trail together.
    syncSkinSelection() {
        const currentByGround = new Map();
        for (const skin of PLAYER_CAR_SKINS) {
            if (!currentByGround.has(skin.ground)) {
                currentByGround.set(skin.ground, readPlayerCarSkinAssetName(skin.ground));
            }
        }
        this.syncCustomPreview();
        for (const [assetName, btn] of this.skinOptionButtons) {
            const ground = PLAYER_CAR_SKINS.find((skin) => skin.assetName === assetName)?.ground ?? 'tarmac';
            const selected = assetName === currentByGround.get(ground);
            btn.classList.toggle('is-selected', selected);
            btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
        }
        this.syncTrailSelection();
    }

    buildTrailGrid() {
        const grid = this.trailGrid;
        if (!grid) return;
        grid.replaceChildren();
        this.trailOptionButtons.clear();

        for (const trail of PLAYER_TRAIL_COLORS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'garage-color-option garage-trail-option';
            btn.dataset.trailId = trail.id;
            btn.style.setProperty('--paint-color', trail.swatch);
            btn.setAttribute('aria-pressed', 'false');
            btn.setAttribute('aria-label', `Trail color: ${trail.label}`);
            btn.title = trail.label;

            const swatch = document.createElement('span');
            swatch.className = 'color-swatch garage-color-swatch';
            swatch.setAttribute('aria-hidden', 'true');
            if (trail.id === 'none') {
                swatch.classList.add('garage-trail-option__swatch--none');
            }
            btn.append(swatch);
            btn.addEventListener('click', () => this.selectTrail(trail.id));
            grid.appendChild(btn);
            this.trailOptionButtons.set(trail.id, btn);
        }
    }

    selectTrail(trailId) {
        const assetName = this.trailAssetName;
        if (!isPlayerCarSkinUnlocked(assetName)) return;
        writePlayerTrailId(trailId, assetName);
        this.selectCarSkin(assetName);
        this.onTrailStrokeStyleChanged?.(readPlayerTrailStrokeStyle(assetName));
    }

    syncTrailSelection() {
        const current = readPlayerTrailId(this.trailAssetName);
        for (const [id, btn] of this.trailOptionButtons) {
            const selected = id === current;
            btn.classList.toggle('is-selected', selected);
            btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
        }
    }
}
