import { createMedalIconSvg } from '../medals/medal-icon.js';
import { getMedalRowSlots } from '../medals/medal-timing.js';
import { openMedalTimesPopover } from '../race/ui-modal-content.js';
import { renderCachedTrackPreviewCanvas } from '../track/preview-renderer.js';
import { getLoadedClientTrack, loadClientTrack } from '../track/client-registry.js';
import { getTrackDefinitionIdentity } from '../track/definition-identity.js';
import { createLockIconSvg } from './lock-icon.js';
import {
    resolveTrackPresentation,
    TRACK_PRESENTATION_SURFACES,
} from '../track/presentation.js';
import { setText } from './dom.js';

const legacyPreviewTracks = import.meta.env.MODE === 'test'
    ? (await import('../track/tracks.js')).TRACKS
    : null;

const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 176;
const PREVIEW_CAR_SCALE = 2;
const SCROLL_SETTLE_MS = 90;
const PROGRAMMATIC_SCROLL_TIMEOUT_MS = 1200;
const SVG_NS = 'http://www.w3.org/2000/svg';
const REQUIREMENT_CHECK_PATH =
    'M434.8 70.1c14.3 10.4 17.5 30.4 7.1 44.7l-256 352c-5.5 7.6-14 12.3-23.4 13.1s-18.5-2.7-25.1-9.3l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0l101.5 101.5 234-321.7c10.4-14.3 30.4-17.5 44.7-7.1z';

function createUnlockMedalMeter(meter) {
    const icon = createMedalIconSvg('silver', {
        className: 'track-carousel__unlock-medal medal-svg--row-placeholder',
        outline: true,
        rowPlaceholder: true,
        centerText: meter.remainingMedals,
        showEmblem: false,
    });
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

function createRequirementMedalIcon(requirement) {
    const remainingMedals = Number.isInteger(requirement.remainingMedals)
        ? requirement.remainingMedals
        : null;
    const icon = createMedalIconSvg('silver', {
        className: [
            'track-carousel__requirement-medal-icon',
            'medal-svg--row-placeholder',
            requirement.satisfied ? 'is-satisfied' : 'is-locked',
        ].join(' '),
        outline: true,
        rowPlaceholder: true,
        centerText: requirement.id === 'medal-total' && !requirement.satisfied
            ? remainingMedals
            : null,
        showEmblem: false,
    });
    icon.setAttribute('aria-hidden', 'true');

    if (requirement.satisfied) {
        const svg = icon.querySelector?.('svg');
        if (svg) {
            const check = document.createElementNS(SVG_NS, 'path');
            check.setAttribute('class', 'track-carousel__requirement-check');
            check.setAttribute('d', REQUIREMENT_CHECK_PATH);
            check.setAttribute('fill', 'rgb(30, 48, 80)');
            check.setAttribute('transform', 'translate(208 190) scale(0.5)');
            svg.append(check);
        }
    }
    return icon;
}

const PERSONAL_BEST_ICON_PATH =
    'M168.5 0c-13.3 0-24 10.7-24 24s10.7 24 24 24l32 0 0 25.3c-108 11.9-192 103.5-192 214.7 0 119.3 96.7 216 216 216s216-96.7 216-216c0-39.8-10.8-77.1-29.6-109.2l28.2-28.2c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0l-23.4 23.4c-32.9-30.2-75.2-50.3-122-55.5l0-25.3 32 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-112 0zm80 184l0 104c0 13.3-10.7 24-24 24s-24-10.7-24-24l0-104c0-13.3 10.7-24 24-24s24 10.7 24 24z';
const STANDINGS_ICON_PATH =
    'M353.8 118.1L330.2 70.3C326.3 62 314.1 61.7 309.8 70.3L286.2 118.1L233.9 125.6C224.6 127 220.6 138.5 227.5 145.4L265.5 182.4L256.5 234.5C255.1 243.8 264.7 251 273.3 246.7L320.2 221.9L366.8 246.3C375.4 250.6 385.1 243.4 383.6 234.1L374.6 182L412.6 145.4C419.4 138.6 415.5 127.1 406.2 125.6L353.9 118.1zM288 320C261.5 320 240 341.5 240 368L240 528C240 554.5 261.5 576 288 576L352 576C378.5 576 400 554.5 400 528L400 368C400 341.5 378.5 320 352 320L288 320zM80 384C53.5 384 32 405.5 32 432L32 528C32 554.5 53.5 576 80 576L144 576C170.5 576 192 554.5 192 528L192 432C192 405.5 170.5 384 144 384L80 384zM448 496L448 528C448 554.5 469.5 576 496 576L560 576C586.5 576 608 554.5 608 528L608 496C608 469.5 586.5 448 560 448L496 448C469.5 448 448 469.5 448 496z';

function createPersonalBestIcon() {
    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.classList.add('track-carousel__spec-icon');
    icon.setAttribute('viewBox', '0 0 448 512');
    icon.setAttribute('width', '16');
    icon.setAttribute('height', '16');
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', 'Personal best');
    icon.setAttribute('focusable', 'false');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', PERSONAL_BEST_ICON_PATH);
    path.setAttribute('fill', 'currentColor');
    icon.append(path);
    return icon;
}

function createStandingsIcon() {
    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.classList.add('track-carousel__spec-icon');
    icon.setAttribute('viewBox', '0 0 640 640');
    icon.setAttribute('width', '16');
    icon.setAttribute('height', '16');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', STANDINGS_ICON_PATH);
    path.setAttribute('fill', 'currentColor');
    icon.append(path);
    return icon;
}

function createSpecCell(label, element = 'span') {
    const cell = document.createElement(element);
    cell.className = 'track-carousel__spec';
    if (element === 'button') cell.type = 'button';
    const labelEl = typeof label === 'string' ? document.createElement('span') : label;
    if (typeof label === 'string') {
        labelEl.className = 'track-carousel__spec-label';
        labelEl.textContent = label;
    }
    const valueEl = document.createElement('span');
    valueEl.className = 'track-carousel__spec-value';
    cell.append(labelEl, valueEl);
    return [cell, valueEl, labelEl];
}

export function getTrackAspectRatio(trackKey) {
    const track = getLoadedClientTrack(trackKey) || legacyPreviewTracks?.[trackKey];
    const points = track?.outer;
    if (!Array.isArray(points) || !points.length) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const point of points) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
    }
    const width = maxX - minX;
    const height = maxY - minY;
    if (!(width > 0) || !(height > 0)) return null;
    return width / height;
}

export function trackPreviewPixelScale() {
    return Math.min(2, Math.max(1, Math.round(globalThis.devicePixelRatio || 1)));
}

export function renderTrackPreviewCanvas(canvas, card, {
    cacheNamespace = 'track-preview',
    carImage = null,
    carAssetKey = 'fallback',
    carWorldSize = null,
    force = false,
} = {}) {
    const track = getLoadedClientTrack(card?.trackKey) || legacyPreviewTracks?.[card?.trackKey];
    if (!canvas) return;
    if (!track) {
        void loadClientTrack(card?.trackKey).then(() => {
            if (canvas.isConnected !== false) renderTrackPreviewCanvas(canvas, card, { cacheNamespace, carImage, carAssetKey, carWorldSize, force: true });
        }).catch(() => {});
        return;
    }
    const previewCarWorldSize = carWorldSize
        ? {
            width: carWorldSize.width * PREVIEW_CAR_SCALE,
            height: carWorldSize.height * PREVIEW_CAR_SCALE,
        }
        : null;
    const previewCarSizeKey = previewCarWorldSize
        ? `${previewCarWorldSize.width}x${previewCarWorldSize.height}`
        : 'default-size';
    const previewKey = [
        card.trackKey,
        getTrackDefinitionIdentity(track),
        card.skin || 'default',
        carAssetKey,
        previewCarSizeKey,
        `${canvas.width}x${canvas.height}`,
    ].join(':');
    if (!force && canvas.dataset.previewKey === previewKey) return;
    canvas.dataset.previewKey = previewKey;

    renderCachedTrackPreviewCanvas(canvas, {
        cacheKey: [
            cacheNamespace,
            card.trackKey,
            getTrackDefinitionIdentity(track),
            card.skin || 'default',
            carAssetKey,
            previewCarSizeKey,
        ].join(':'),
        trackGeometry: { outer: track.outer, inner: track.inner },
        cornerRadius: track.cornerRadius,
        presentation: resolveTrackPresentation(card.trackKey, {
            surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
            event: card.skin
                ? { key: 'daily-challenge', trackKey: card.trackKey, skin: card.skin }
                : null,
            ground: track.ground,
        }),
        startLine: track.startLine,
        startPos: track.startPos,
        startAngle: track.startAngle,
        transparentBackground: true,
        previewRenderMode: 'schematic',
        schematicCarImage: carImage,
        schematicCarWorldSize: previewCarWorldSize,
        hideSchematicStartArrow: Boolean(carImage),
    });
}

export function fitTrackPreviewCanvas(canvas, card, options = {}) {
    const host = canvas?.parentElement;
    if (!canvas || !host?.offsetWidth || !host?.offsetHeight) return false;
    const scale = trackPreviewPixelScale();
    const width = Math.round(host.offsetWidth * scale);
    const height = Math.round(host.offsetHeight * scale);
    const sizeChanged = canvas.width !== width || canvas.height !== height;
    if (sizeChanged) {
        canvas.width = width;
        canvas.height = height;
    }
    const previousKey = canvas.dataset?.previewKey;
    renderTrackPreviewCanvas(canvas, card, { ...options, force: sizeChanged || options.force });
    return sizeChanged || previousKey !== canvas.dataset?.previewKey || Boolean(options.force);
}

export function findCarouselIndex(cards = [], challengeId = null) {
    if (!challengeId) return -1;
    return cards.findIndex((card) => card.challengeId === challengeId);
}

export class TrackCarousel {
    constructor({
        idPrefix = 'daily-carousel',
        previewCacheNamespace = idPrefix,
        onSelect = null,
        onOpenLeaderboard = null,
        onSettle = null,
        resolveExpiry = null,
        getPreviewCarImage = null,
        getPreviewCarAssetKey = null,
        getPreviewCarWorldSize = null,
    } = {}) {
        this.idPrefix = idPrefix;
        this.previewCacheNamespace = previewCacheNamespace;
        this.onSelect = onSelect;
        this.onOpenLeaderboard = onOpenLeaderboard;
        this.onSettle = onSettle;
        this.resolveExpiry = resolveExpiry;
        this._expiryTimer = null;
        this.getPreviewCarImage = getPreviewCarImage;
        this.getPreviewCarAssetKey = getPreviewCarAssetKey;
        this.getPreviewCarWorldSize = getPreviewCarWorldSize;
        this._cards = [];
        this._elements = [];
        this._selectedIndex = -1;
        this._bound = false;
        this._scrollFrame = null;
        this._settleTimer = null;
        this._programmaticScrollTimer = null;
        this._suppressScrollSync = false;
        this._resizeObserver = null;
    }

    element(suffix) {
        return globalThis.document?.getElementById?.(`${this.idPrefix}-${suffix}`) || null;
    }

    get root() { return globalThis.document?.getElementById?.(this.idPrefix) || null; }
    get viewport() { return this.element('viewport'); }
    get rail() { return this.element('rail'); }
    get prevBtn() { return this.element('prev'); }
    get nextBtn() { return this.element('next'); }
    get navigation() { return this.element('navigation'); }
    get countLabel() { return this.element('count'); }
    get expiryLine() { return this.element('expiry'); }
    get status() { return this.element('status'); }

    bind() {
        if (this._bound) return;
        const viewport = this.viewport;
        if (!viewport) return;
        this._bound = true;

        this._footParts = this.buildFoot();
        if (this.root) {
            this.root.append(this._footParts.foot);
        }

        this.prevBtn?.addEventListener('click', () => this.step(-1));
        this.nextBtn?.addEventListener('click', () => this.step(1));
        viewport.addEventListener('scroll', () => this.handleScroll(), { passive: true });
        const takeScrollControl = () => this.handleUserScrollIntent();
        viewport.addEventListener('pointerdown', takeScrollControl, { passive: true });
        viewport.addEventListener('touchstart', takeScrollControl, { passive: true });
        viewport.addEventListener('wheel', takeScrollControl, { passive: true });
        viewport.addEventListener('scrollend', () => this.handleScrollEnd(), { passive: true });
        window.addEventListener('resize', () => {
            this.syncCardWidth();
            this.fitPreviews();
            this.scrollToSelected({ animate: false });
        });
        if (typeof ResizeObserver === 'function') {
            this._resizeObserver = new ResizeObserver(() => {
                this.syncCardWidth();
                this.fitPreviews();
                this.scrollToSelected({ animate: false });
            });
            this._resizeObserver.observe(viewport);
        }
    }

    getSelectedCard() {
        return this._cards[this._selectedIndex] || null;
    }

    getSelectedChallenge() {
        return this.getSelectedCard()?.challenge || null;
    }

    getSelectedChallengeId() {
        return this.getSelectedCard()?.challengeId || null;
    }

    isEmpty() {
        return this._cards.length === 0;
    }

    render(cards = [], {
        selectedChallengeId = this.getSelectedChallengeId(),
        loading = false,
    } = {}) {
        for (const card of cards) {
            if (card?.trackKey && !getLoadedClientTrack(card.trackKey)) {
                void loadClientTrack(card.trackKey).catch(() => {});
            }
        }

        const rail = this.rail;
        if (!rail) return;

        this.syncCardWidth();

        const previousCards = this._cards;
        const previousSelectedId = previousCards[this._selectedIndex]?.challengeId ?? null;
        const previousIds = previousCards.map((card) => card.challengeId).join('|');
        const nextIds = cards.map((card) => card.challengeId).join('|');
        const sameRun = previousIds === nextIds && this._elements.length === cards.length;
        this._cards = cards;

        this.renderStatus({ loading });

        if (!cards.length) {
            rail.replaceChildren();
            this._elements = [];
            this._selectedIndex = -1;
            this.syncNavButtons();
            this.onSelect?.(null, null);
            return;
        }

        if (sameRun) {
            cards.forEach((card, index) => {
                const previousCard = previousCards[index];
                const previewChanged = previousCard?.trackKey !== card.trackKey
                    || previousCard?.skin !== card.skin;
                this.paintCard(this._elements[index], card, { renderPreview: previewChanged });
            });
        } else {
            this._elements = cards.map((card, index) => this.buildCard(card, index));
            rail.replaceChildren(this.edgeSpacer('lead'), ...this._elements, this.edgeSpacer('tail'));
        }

        const requestedIndex = findCarouselIndex(cards, selectedChallengeId);
        const heldIndex = requestedIndex >= 0
            ? requestedIndex
            : findCarouselIndex(cards, previousSelectedId);
        const nextIndex = heldIndex >= 0 ? heldIndex : 0;
        const changed = nextIndex !== this._selectedIndex;
        this._selectedIndex = nextIndex;
        this.applySelectionClasses();
        this.syncNavButtons();
        this.scrollToSelected({ animate: false });
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => this.fitPreviews());
        }
        if (changed || !sameRun) this.emitSelection();
    }

    // WebKit can drop a scroller's trailing padding.
    edgeSpacer(side) {
        const key = side === 'lead' ? '_edgeLead' : '_edgeTail';
        if (!this[key]) {
            const spacer = document.createElement('span');
            spacer.className = `track-carousel__edge track-carousel__edge--${side}`;
            spacer.setAttribute('aria-hidden', 'true');
            this[key] = spacer;
        }
        return this[key];
    }

    renderStatus({ loading = false } = {}) {
        const status = this.status;
        if (!status) return;
        if (this._cards.length) {
            status.hidden = true;
            status.textContent = '';
            return;
        }
        status.hidden = false;
        status.textContent = loading ? 'Loading tracks' : 'No tracks available';
    }

    buildCard(card, index) {
        const element = document.createElement('div');
        element.className = 'daily-playlist-entry--hero';
        element.dataset.challengeId = card.challengeId;
        element.dataset.index = String(index);
        element.setAttribute('role', 'group');
        element.setAttribute('aria-roledescription', 'slide');

        const preview = document.createElement('div');
        preview.className = 'daily-playlist-hero-preview';
        const previewArt = document.createElement('div');
        previewArt.className = 'track-carousel__preview-art';
        const canvas = document.createElement('canvas');
        canvas.width = PREVIEW_WIDTH;
        canvas.height = PREVIEW_HEIGHT;
        canvas.setAttribute('aria-hidden', 'true');
        const gate = document.createElement('div');
        gate.className = 'track-carousel__gate';
        gate.hidden = true;
        const previewLock = document.createElement('span');
        previewLock.className = 'track-carousel__preview-lock';
        previewLock.setAttribute('aria-hidden', 'true');
        const previewLockMedal = createMedalIconSvg('silver', {
            className: 'track-carousel__preview-lock-medal medal-svg--row-placeholder',
            outline: true,
            rowPlaceholder: true,
            showEmblem: false,
        });
        previewLockMedal.setAttribute('aria-hidden', 'true');
        previewLock.append(
            previewLockMedal,
            createLockIconSvg('track-carousel__preview-lock-icon'),
        );
        gate.append(previewLock);
        previewArt.append(canvas);
        preview.append(previewArt, gate);

        element.append(preview);

        element.addEventListener('click', () => {
            const cardIndex = Number(element.dataset.index);
            if (Number.isInteger(cardIndex)) this.select(cardIndex);
        });

        element._parts = {
            canvas, preview, gate,
        };
        this.paintCard(element, card, { renderPreview: false });
        return element;
    }

    buildFoot() {
        const foot = document.createElement('div');
        foot.className = 'track-carousel__card-foot';
        const requirement = document.createElement('div');
        requirement.className = 'track-carousel__requirement';
        requirement.hidden = true;
        const requirementList = document.createElement('div');
        requirementList.className = 'track-carousel__requirement-list';

        const meta = document.createElement('div');
        meta.className = 'track-carousel__meta';
        const verificationError = document.createElement('div');
        verificationError.className = 'track-carousel__verification-error';
        verificationError.hidden = true;
        const [bestCell, bestValue] = createSpecCell(createPersonalBestIcon());
        const [rank, rankValue, rankIcon] = createSpecCell(createStandingsIcon(), 'button');
        rank.classList.add('track-carousel__rank');
        rank.addEventListener('click', (event) => {
            event.stopPropagation();
            const current = this.getSelectedCard();
            if (current && !current.locked) {
                this.onOpenLeaderboard?.(current.challenge, current);
            }
        });
        const rankMedal = document.createElement('span');
        rankMedal.className = 'track-carousel__unlock-medal-host';
        rankMedal.hidden = true;
        requirement.append(requirementList);
        meta.append(bestCell, rank);

        const medal = document.createElement('button');
        medal.type = 'button';
        medal.className = 'daily-playlist-hero-medal';
        medal.setAttribute('aria-label', 'View medal times');
        medal.addEventListener('click', (event) => {
            event.stopPropagation();
            this.openSelectedMedalTimes();
        });

        foot.append(requirement, meta, verificationError, medal);

        return {
            foot, requirement, requirementList, meta, bestCell, bestValue,
            rank, rankValue, rankIcon, rankMedal, medal, verificationError,
        };
    }

    paintCard(element, card, { renderPreview = true } = {}) {
        const parts = element?._parts;
        if (!parts || !card) return;
        element.dataset.challengeId = card.challengeId;

        element.classList.toggle('current', Boolean(card.isCurrent));
        element.classList.toggle('is-locked', Boolean(card.locked));
        parts.gate.hidden = !Boolean(card.locked);

        if (renderPreview) this.renderPreview(parts.canvas, card);
    }

    paintExpiry(card) {
        if (this._expiryTimer) {
            clearTimeout(this._expiryTimer);
            this._expiryTimer = null;
        }
        const line = this.expiryLine;
        if (!line) return;

        const { label = '', refreshMs = null } = this.resolveExpiry?.(card) || {};
        line.textContent = label;
        line.hidden = !label;
        if (Number.isFinite(refreshMs) && refreshMs > 0) {
            this._expiryTimer = setTimeout(
                () => this.paintExpiry(this.getSelectedCard()),
                refreshMs,
            );
        }
    }

    paintFoot(card) {
        if (!this._footParts || !card) return;
        const parts = this._footParts;

        if (this.root) {
            this.root.classList.toggle('is-locked', Boolean(card.locked));
        }

        const locked = Boolean(card.locked);
        const verificationError = !locked && typeof card.verificationError === 'string'
            ? card.verificationError.trim()
            : '';
        
        parts.bestCell.hidden = locked;
        parts.bestCell.classList.toggle('is-muted', !card.bestLabel);
        setText(parts.bestValue, card.bestLabel || '—');

        if (locked) {
            const meter = card.lockMeter || null;
            parts.rank.hidden = true;
            parts.rank.disabled = true;
            parts.rankMedal.hidden = !meter;
            if (meter) {
                const key = `${meter.remainingMedals}:${meter.ratio}`;
                if (parts.rankMedal.dataset.meterKey !== key) {
                    parts.rankMedal.dataset.meterKey = key;
                    parts.rankMedal.replaceChildren(createUnlockMedalMeter(meter));
                }
                parts.rankMedal.setAttribute(
                    'aria-label',
                    `${card.trackName} is locked. ${meter.remainingMedals} additional medals needed`,
                );
            }
        } else {
            parts.rankMedal.hidden = true;
            parts.rank.hidden = false;
            parts.rankValue.hidden = false;
            parts.rankIcon.hidden = false;
            parts.rank.disabled = false;
            setText(parts.rankValue, card.rankPending ? '···' : (card.rankLabel || '—'));
            parts.rank.classList.toggle('is-muted', card.rankPending || !card.rankLabel);
            parts.rank.setAttribute(
                'aria-label',
                `${card.trackName} standings. Your rank: ${card.rankPending ? 'loading' : (card.rankLabel || 'unranked')}`,
            );
        }

        const tiers = Array.isArray(card.medalTiers) ? card.medalTiers : [];
        const key = tiers.map(({ tier, filled }) => `${tier}${filled ? '+' : '-'}`).join('');
        if (parts.medal.dataset.medalKey !== key) {
            parts.medal.dataset.medalKey = key;

            if (!tiers.length) {
                parts.medal.replaceChildren(createMedalIconSvg('white', {
                    className: 'track-carousel__medal',
                    outline: true,
                    rowPlaceholder: true,
                    showEmblem: false,
                }));
            } else {
                parts.medal.replaceChildren(...tiers.map(({ tier, filled }) => {
                    const icon = createMedalIconSvg(tier, {
                        className: 'track-carousel__medal',
                        outline: !filled,
                        showEmblem: false,
                    });
                    icon.classList?.toggle?.('is-earned', filled);
                    return icon;
                }));
            }
        }

        parts.requirement.hidden = !locked;
        parts.verificationError.hidden = !verificationError;
        setText(parts.verificationError, verificationError);
        parts.meta.hidden = locked || Boolean(verificationError);
        parts.medal.hidden = locked;
        parts.medal.disabled = locked || !tiers.length;
        if (locked || !tiers.length) {
            parts.medal.removeAttribute('aria-label');
        } else {
            parts.medal.setAttribute(
                'aria-label',
                `View medal times for ${card.trackName || 'this track'}`,
            );
        }

        if (!locked) {
            parts.requirementList.replaceChildren();
            return;
        }
        const requirements = Array.isArray(card.unlockRequirements) && card.unlockRequirements.length
            ? card.unlockRequirements
            : [{
                id: 'unlock',
                copy: card.lockedLabel || 'Locked',
                satisfied: false,
            }];
        parts.requirementList.replaceChildren(...requirements.map((requirement) => {
            const item = document.createElement('div');
            item.className = 'track-carousel__requirement-item';
            item.classList.toggle('is-satisfied', Boolean(requirement.satisfied));
            const status = document.createElement('span');
            status.className = 'track-carousel__requirement-medal';
            if (requirement.id === 'medal-total' && !requirement.satisfied && card.lockMeter) {
                status.append(parts.rankMedal);
            } else {
                status.append(createRequirementMedalIcon(requirement));
            }
            const copy = document.createElement('span');
            copy.className = 'track-carousel__requirement-note';
            setText(copy, requirement.copy || 'Locked');
            item.append(status, copy);
            return item;
        }));
    }

    openSelectedMedalTimes() {
        const card = this.getSelectedCard();
        if (!card || card.locked) return;
        const slots = getMedalRowSlots(card.trackKey, card.medal, card.laps);
        if (!slots.length) return;
        const host = globalThis.document?.getElementById?.('start-overlay') || this.root;
        openMedalTimesPopover(host, slots);
    }

    previewPixelScale() {
        return trackPreviewPixelScale();
    }

    fitPreviews() {
        const scale = this.previewPixelScale();
        for (const element of this._elements) {
            const canvas = element?._parts?.canvas;
            const host = canvas?.parentElement;
            if (!canvas || !host?.offsetWidth || !host?.offsetHeight) continue;
            const width = Math.round(host.offsetWidth * scale);
            const height = Math.round(host.offsetHeight * scale);
            const card = this._cards[Number(element.dataset.index)];
            const sizeChanged = canvas.width !== width || canvas.height !== height;
            if (sizeChanged) {
                canvas.width = width;
                canvas.height = height;
            }
            if (card && (sizeChanged || !canvas.dataset?.previewKey)) {
                this.renderPreview(canvas, card, { force: sizeChanged });
            }
        }
    }

    refreshPreviews() {
        for (const element of this._elements) {
            const canvas = element?._parts?.canvas;
            const card = this._cards[Number(element?.dataset?.index)];
            if (canvas && card) this.renderPreview(canvas, card, { force: true });
        }
    }

    renderPreview(canvas, card, { force = false } = {}) {
        // The car on the card depends on the track's ground, so load the
        // track first and pick the car after.
        if (card?.trackKey && !getLoadedClientTrack(card.trackKey) && !legacyPreviewTracks?.[card.trackKey]) {
            void loadClientTrack(card.trackKey).then(() => {
                if (canvas.isConnected !== false) this.renderPreview(canvas, card, { force: true });
            }).catch(() => {});
            return;
        }
        renderTrackPreviewCanvas(canvas, card, {
            cacheNamespace: this.previewCacheNamespace,
            carImage: this.getPreviewCarImage?.(card) || null,
            carAssetKey: this.getPreviewCarAssetKey?.(card) || 'fallback',
            carWorldSize: this.getPreviewCarWorldSize?.() || null,
            force,
        });
    }

    step(delta) {
        if (!this._cards.length) return;
        this.select(this._selectedIndex + delta);
    }

    handleNavDirection(direction) {
        if (!this._cards.length) return false;
        if (direction === 'left') {
            if (this._selectedIndex <= 0) return true;
            this.step(-1);
            return true;
        }
        if (direction === 'right') {
            if (this._selectedIndex >= this._cards.length - 1) return true;
            this.step(1);
            return true;
        }
        return false;
    }

    select(index, { animate = true, notify = true } = {}) {
        if (!this._cards.length) return;
        const clamped = Math.min(Math.max(index, 0), this._cards.length - 1);
        if (clamped === this._selectedIndex) {
            this.scrollToSelected({ animate });
            return;
        }
        this._selectedIndex = clamped;
        this.applySelectionClasses();
        this.syncNavButtons();
        this.scrollToSelected({ animate });
        if (notify) this.emitSelection();
    }

    selectChallenge(challengeId, options = {}) {
        const index = findCarouselIndex(this._cards, challengeId);
        if (index < 0) return false;
        this.select(index, options);
        return true;
    }

    applySelectionClasses() {
        this._elements.forEach((element, index) => {
            const isSelected = index === this._selectedIndex;
            element.classList.toggle('is-carousel-selected', isSelected);
            element.setAttribute('aria-hidden', String(!isSelected));
        });
        
        const card = this.getSelectedCard();
        if (card) {
            this.paintFoot(card);
        }
        this.paintExpiry(card);

        this.updateProximity();
    }

    updateProximity() {
        const viewport = this.viewport;
        const width = viewport?.clientWidth || 0;
        const measurements = this._elements.map((element) => ({
            left: element?.offsetLeft || 0,
            width: element?.offsetWidth || 0,
        }));
        const measurable = width > 0 && measurements.some(({ width: cardWidth }) => cardWidth > 0);
        const center = measurable ? viewport.scrollLeft + (width / 2) : 0;

        const proximities = measurements.map(({ left, width: cardWidth }, index) => {
            if (!measurable || !(cardWidth > 0)) {
                return index === this._selectedIndex ? 1 : 0;
            }
            const distance = Math.abs((left + (cardWidth / 2)) - center);
            return Math.max(0, 1 - (distance / cardWidth));
        });

        this._elements.forEach((element, index) => {
            element.style?.setProperty?.('--card-proximity', proximities[index].toFixed(3));
        });
    }

    syncNavButtons() {
        const count = this._cards.length;
        const prev = this.prevBtn;
        const next = this.nextBtn;
        const navigation = this.navigation;
        const countLabel = this.countLabel;
        const selectedIndex = count > 0
            ? Math.min(Math.max(this._selectedIndex, 0), count - 1)
            : -1;
        if (navigation) navigation.hidden = count === 0;
        if (countLabel) {
            countLabel.textContent = count > 0 ? `${selectedIndex + 1} / ${count}` : '';
            if (count > 0) {
                countLabel.setAttribute('aria-label', `Track ${selectedIndex + 1} of ${count}`);
            } else {
                countLabel.removeAttribute('aria-label');
            }
        }
        if (prev) {
            prev.disabled = count === 0 || this._selectedIndex <= 0;
            prev.hidden = count < 2;
        }
        if (next) {
            next.disabled = count === 0 || this._selectedIndex >= count - 1;
            next.hidden = count < 2;
        }
    }

    scrollToSelected({ animate = true } = {}) {
        const viewport = this.viewport;
        const element = this._elements[this._selectedIndex];
        if (!viewport || !element) return;

        const apply = () => {
            if (!(viewport.clientWidth > 0) || !(element.offsetWidth > 0)) return;
            this.syncEdgeSpacing(element);
            const left = element.offsetLeft
                - ((viewport.clientWidth - element.offsetWidth) / 2);
            if (!Number.isFinite(left)) return;
            if (animate) {
                this.beginProgrammaticScroll();
            } else {
                this.cancelProgrammaticScroll();
            }
            if (typeof viewport.scrollTo === 'function') {
                viewport.scrollTo({
                    left,
                    behavior: animate ? 'smooth' : 'auto',
                });
            } else {
                viewport.scrollLeft = left;
            }
            this.updateProximity();
            if (!animate) this.scheduleSettle();
        };

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(apply);
        } else {
            apply();
        }
    }

    syncCardWidth() {
        const viewport = this.viewport;
        const host = this.root || this.rail;
        const width = viewport?.clientWidth || 0;
        if (!host || !(width > 0)) return false;
        host.style?.setProperty?.('--track-carousel-card-width', `${width}px`);
        return true;
    }

    syncEdgeSpacing(element = this._elements[this._selectedIndex]) {
        const viewport = this.viewport;
        const rail = this.rail;
        if (!viewport || !rail || !element
            || !(viewport.clientWidth > 0) || !(element.offsetWidth > 0)) {
            return false;
        }
        this.syncCardWidth();
        const edgeSpace = Math.max(0, (viewport.clientWidth - element.offsetWidth) / 2);
        rail.style?.setProperty?.('--track-carousel-edge-space', `${edgeSpace}px`);
        this.syncTailShortfall();
        return true;
    }

    syncTailShortfall() {
        const viewport = this.viewport;
        const rail = this.rail;
        const last = this._elements[this._elements.length - 1];
        if (!viewport || !rail || !last || !(last.offsetWidth > 0)) return;
        const needed = last.offsetLeft + (last.offsetWidth / 2) - (viewport.clientWidth / 2);
        const reachable = viewport.scrollWidth - viewport.clientWidth;
        const current = Number.parseFloat(
            rail.style?.getPropertyValue?.('--track-carousel-tail-shortfall') || '0',
        ) || 0;
        const shortfall = Math.max(0, Math.round(current + (needed - reachable)));
        if (!Number.isFinite(shortfall) || shortfall === Math.round(current)) return;
        rail.style?.setProperty?.('--track-carousel-tail-shortfall', `${shortfall}px`);
    }

    beginProgrammaticScroll() {
        this.cancelProgrammaticScroll();
        this._suppressScrollSync = true;
        this._programmaticScrollTimer = setTimeout(() => {
            this.finishProgrammaticScroll();
        }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
    }

    cancelProgrammaticScroll() {
        if (this._programmaticScrollTimer !== null) {
            clearTimeout(this._programmaticScrollTimer);
            this._programmaticScrollTimer = null;
        }
        this._suppressScrollSync = false;
    }

    finishProgrammaticScroll() {
        this.cancelProgrammaticScroll();
        this.scheduleSettle();
    }

    handleUserScrollIntent() {
        this.cancelProgrammaticScroll();
        if (this._settleTimer !== null) {
            clearTimeout(this._settleTimer);
            this._settleTimer = null;
        }
    }

    handleScrollEnd() {
        if (this._suppressScrollSync) {
            this.finishProgrammaticScroll();
            return;
        }
        this.syncSelectionFromScroll();
    }

    scheduleSettle() {
        if (this._settleTimer !== null) clearTimeout(this._settleTimer);
        this._settleTimer = setTimeout(() => {
            this._settleTimer = null;
            this.onSettle?.(this.getSelectedCard());
        }, SCROLL_SETTLE_MS * 2);
    }

    handleScroll() {
        if (this._scrollFrame !== null) return;
        const schedule = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : (callback) => setTimeout(callback, 16);
        this._scrollFrame = schedule(() => {
            this._scrollFrame = null;
            this.updateProximity();
            if (!this._suppressScrollSync) this.syncSelectionFromScroll();
        });
    }

    syncSelectionFromScroll() {
        const viewport = this.viewport;
        if (
            !viewport
            || !this._elements.length
            || !(viewport.clientWidth > 0)
            || !this._elements.some((element) => element.offsetWidth > 0)
        ) {
            return;
        }

        const center = viewport.scrollLeft + (viewport.clientWidth / 2);
        let bestIndex = this._selectedIndex;
        let bestDistance = Number.POSITIVE_INFINITY;
        this._elements.forEach((element, index) => {
            const elementCenter = element.offsetLeft + (element.offsetWidth / 2);
            const distance = Math.abs(elementCenter - center);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = index;
            }
        });

        if (bestIndex !== this._selectedIndex) {
            this._selectedIndex = bestIndex;
            this.applySelectionClasses();
            this.syncNavButtons();
            this.emitSelection();
        }

        this.scheduleSettle();
    }

    emitSelection() {
        const card = this.getSelectedCard();
        if (card) this.onSelect?.(card.challenge, card);
    }

}
