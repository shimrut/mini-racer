/** Lobby track carousel — the picker both Daily and Campaign use. Card content comes from a per-mode builder; this file is the plate that renders it. */
import { createMedalIconSvg } from '../medals/medal-icon.js';
import { renderCachedTrackPreviewCanvas } from '../track/preview-renderer.js';
import { TRACKS } from '../track/tracks.js';
import { createLockIconSvg } from './lock-icon.js';
import {
    resolveTrackPresentation,
    TRACK_PRESENTATION_SURFACES,
} from '../track/presentation.js';

const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 176;
const PREVIEW_CAR_SCALE = 2;
// Matches the margin `getTrackBoundsLayout` keeps inside the preview canvas.
const PREVIEW_RENDER_PADDING = 16;
const DEFAULT_PLATE_ASPECT = 1.4;
const MIN_PLATE_ASPECT = 0.62;
const MAX_PLATE_ASPECT = 2.4;
const SCROLL_SETTLE_MS = 90;
const PROGRAMMATIC_SCROLL_TIMEOUT_MS = 1200;

function setText(element, value) {
    if (element) element.textContent = value;
}

function createUnlockMedalMeter(meter) {
    const icon = createMedalIconSvg('silver', {
        className: 'track-carousel__unlock-medal',
        outline: true,
        centerText: meter.value,
        showEmblem: false,
    });
    icon.classList.toggle('is-complete', meter.ratio >= 1);
    icon.setAttribute('aria-hidden', 'true');
    const svg = icon.querySelector?.('svg');
    const track = svg?.querySelector?.('.medal-svg__shape');
    if (!svg || !track) return icon;

    track.classList.add('track-carousel__unlock-medal-track');
    track.setAttribute('pathLength', '100');
    track.removeAttribute('stroke-dasharray');

    const progress = track.cloneNode(false);
    progress.setAttribute('class', 'track-carousel__unlock-medal-progress');
    progress.setAttribute('pathLength', '100');
    progress.setAttribute('stroke-dasharray', '100');
    progress.setAttribute('stroke-dashoffset', String(100 - (meter.ratio * 100)));
    svg.insertBefore(progress, svg.querySelector('text'));
    return icon;
}

const plateAspectCache = new Map();

/** Aspect ratio of the track's own bounding box, published to CSS so the plate frames the drawing instead of letterboxing it. Clamped so an extreme track can't flatten the plate to a strip. */
export function getTrackPlateAspect(trackKey) {
    const cached = plateAspectCache.get(trackKey);
    if (cached !== undefined) return cached;
    const aspect = measureTrackPlateAspect(trackKey);
    plateAspectCache.set(trackKey, aspect);
    return aspect;
}

/** Walks the track's points; called once per track, then cached. */
function measureTrackPlateAspect(trackKey) {
    const track = TRACKS[trackKey];
    const points = [...(track?.outer || []), ...(track?.inner || [])];
    if (points.length < 2) return DEFAULT_PLATE_ASPECT;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of points) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
    }
    const width = maxX - minX;
    const height = maxY - minY;
    if (!(width > 0) || !(height > 0)) return DEFAULT_PLATE_ASPECT;
    return Math.min(MAX_PLATE_ASPECT, Math.max(MIN_PLATE_ASPECT, width / height));
}

/** One timing-row reading: a label with its figure below. `element` lets the rank cell be a button without looking different from its neighbours. */
function createSpecCell(label, element = 'span') {
    const cell = document.createElement(element);
    cell.className = 'track-carousel__spec';
    if (element === 'button') cell.type = 'button';
    const labelEl = document.createElement('span');
    labelEl.className = 'track-carousel__spec-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = 'track-carousel__spec-value';
    cell.append(labelEl, valueEl);
    return [cell, valueEl, labelEl];
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
        getPreviewCarImage = null,
        getPreviewCarAssetKey = null,
        getPreviewCarWorldSize = null,
    } = {}) {
        this.idPrefix = idPrefix;
        this.previewCacheNamespace = previewCacheNamespace;
        this.onSelect = onSelect;
        this.onOpenLeaderboard = onOpenLeaderboard;
        this.onSettle = onSettle;
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
    get status() { return this.element('status'); }

    bind() {
        if (this._bound) return;
        const viewport = this.viewport;
        if (!viewport) return;
        this._bound = true;

        this.prevBtn?.addEventListener('click', () => this.step(-1));
        this.nextBtn?.addEventListener('click', () => this.step(1));
        viewport.addEventListener('scroll', () => this.handleScroll(), { passive: true });
        // A grab mid-scroll takes selection immediately, or the visible card and
        // Start target disagree until a fixed suppression window expires.
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

    /** Repaints the rail. Cards rebuild only when the run of tracks changes; a late rank/medal patches the existing card so scroll position and any in-flight swipe survive. */
    render(cards = [], {
        selectedChallengeId = this.getSelectedChallengeId(),
        loading = false,
    } = {}) {
        const rail = this.rail;
        if (!rail) return;

        // Card width must be set before cards exist, or the first one lays out
        // and paints once at the wrong width before a scroll pass corrects it.
        this.syncCardWidth();

        const previousCards = this._cards;
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
        const nextIndex = requestedIndex >= 0 ? requestedIndex : 0;
        const changed = nextIndex !== this._selectedIndex;
        this._selectedIndex = nextIndex;
        this.applySelectionClasses();
        this.syncNavButtons();
        // Never animated: a render is a repaint, not a navigation. The rail's
        // scrollLeft is clamped to 0 while its display:none overlay is hidden
        // during a race, so animating here glided across the whole rail.
        this.scrollToSelected({ animate: false });
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => this.fitPreviews());
        }
        if (changed || !sameRun) this.emitSelection();
    }

    /** Spacer giving the first/last card room to reach viewport centre. A real element, not rail padding — some WebKit builds drop a scroll container's trailing padding, so a flex item is used instead. */
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

    /** Built from the tracks-sheet hero-row parts, so a card looks like a track card wherever it's shown. */
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
        // Gate note sits on the plate rather than the scoreline: on the
        // scoreline it wrapped to a second line and pushed into Start Race.
        const gate = document.createElement('div');
        gate.className = 'track-carousel__gate';
        gate.hidden = true;
        const previewLock = document.createElement('span');
        previewLock.className = 'track-carousel__preview-lock';
        previewLock.setAttribute('aria-hidden', 'true');
        previewLock.appendChild(createLockIconSvg('track-carousel__preview-lock-icon'));
        const gateNote = document.createElement('span');
        gateNote.className = 'track-carousel__gate-note';
        gate.append(previewLock, gateNote);
        previewArt.append(canvas);
        preview.append(previewArt, gate);

        // Three bands: run, drawing, standing. The drawing takes what the two
        // type bands leave, so title length never crowds it.
        const head = document.createElement('div');
        head.className = 'track-carousel__card-head';
        const foot = document.createElement('div');
        foot.className = 'track-carousel__card-foot';

        // Lap count is billed here (true before the player has raced) rather
        // than on the scoreline below, which frees room there for the ladder.
        const billing = document.createElement('div');
        billing.className = 'track-carousel__billing';
        const eyebrow = document.createElement('span');
        eyebrow.className = 'daily-playlist-hero-day';
        const billingRule = document.createElement('span');
        billingRule.className = 'track-carousel__billing-rule';
        billingRule.setAttribute('aria-hidden', 'true');
        const format = document.createElement('span');
        format.className = 'track-carousel__format';
        // Two lines always (first word / last word), not a wrap, so the
        // schematic below never resizes as the name changes.
        const title = document.createElement('span');
        title.className = 'daily-playlist-hero-title';
        const titleLead = document.createElement('span');
        titleLead.className = 'track-carousel__title-lead';
        const titleTail = document.createElement('span');
        titleTail.className = 'track-carousel__title-tail';
        title.append(titleLead, titleTail);

        const meta = document.createElement('div');
        meta.className = 'track-carousel__meta';
        const [bestCell, bestValue] = createSpecCell('Best');
        const [rank, rankValue, rankLabel] = createSpecCell('Rank', 'button');
        rank.classList.add('track-carousel__rank');
        rank.addEventListener('click', (event) => {
            event.stopPropagation();
            const current = this._cards[Number(element.dataset.index)] || null;
            if (current && !current.locked) {
                this.onOpenLeaderboard?.(current.challenge, current);
            }
        });
        // A locked stage has no Best/Rank, so the unlock medal count takes
        // that spot on the scoreline instead.
        const rankMedal = document.createElement('span');
        rankMedal.className = 'track-carousel__unlock-medal-host';
        rankMedal.hidden = true;
        meta.append(rankMedal, bestCell, rank);

        // The ladder still shows on a locked card, dormant, as the preview of
        // what's on offer.
        const medal = document.createElement('div');
        medal.className = 'daily-playlist-hero-medal';
        medal.setAttribute('aria-hidden', 'true');

        billing.append(eyebrow, billingRule, format);
        head.append(billing, title);
        foot.append(meta, medal);
        element.append(head, preview, foot);

        element.addEventListener('click', () => {
            const cardIndex = Number(element.dataset.index);
            if (Number.isInteger(cardIndex)) this.select(cardIndex);
        });

        element._parts = {
            canvas, eyebrow, format, titleLead, titleTail, meta, rank, rankLabel, rankValue,
            rankMedal, medal,
            preview, gate, gateNote, head, foot,
            bestCell, bestValue,
        };
        this.paintCard(element, card, { renderPreview: false });
        return element;
    }

    paintCard(element, card, { renderPreview = true } = {}) {
        const parts = element?._parts;
        if (!parts || !card) return;
        element.dataset.challengeId = card.challengeId;

        setText(parts.eyebrow, card.eyebrowLabel);
        setText(parts.format, card.lapsLabel || '');
        this.paintTitle(parts, element, card);
        this.paintSpec(parts, card);
        element.style?.setProperty?.(
            '--track-plate-aspect',
            String(getTrackPlateAspect(card.trackKey)),
        );
        element.classList.toggle('current', Boolean(card.isCurrent));
        element.classList.toggle('is-locked', Boolean(card.locked));
        this.paintGate(parts, card);

        this.paintRank(parts, card);

        this.paintMedals(parts.medal, card);

        if (renderPreview) this.renderPreview(parts.canvas, card);
    }

    /** Track name as two lines (first word white, last word red). Line lengths are published to CSS so the longest name (e.g. "Harbor Principality") doesn't wrap to a third line in the narrow column. */
    paintTitle(parts, element, card) {
        const words = String(card.trackName || '').split(/\s+/).filter(Boolean);
        const tail = words.length ? words[words.length - 1] : '';
        const lead = words.slice(0, -1).join(' ');
        setText(parts.titleLead, lead ? `${lead} ` : '');
        setText(parts.titleTail, tail);
        element.style?.setProperty?.('--title-lead-length', String(lead.length || 1));
        element.style?.setProperty?.('--title-tail-length', String(tail.length || 1));
    }

    /** Lock state shown twice: the puck over the drawing, and the unlock condition in words on the plate (which wraps/clips independently of the rest of the card). */
    paintGate(parts, card) {
        const locked = Boolean(card.locked);
        parts.gate.hidden = !locked;
        setText(parts.gateNote, locked ? (card.lockedLabel || 'Locked') : '');
    }

    /** Best time on the scoreline. An unraced track keeps the cell and shows an em dash rather than hiding it, so the row doesn't reflow card to card. A locked stage hides it — the requirement reads on the plate instead. */
    paintSpec(parts, card) {
        parts.bestCell.hidden = Boolean(card.locked);
        parts.bestCell.classList.toggle('is-muted', !card.bestLabel);
        setText(parts.bestValue, card.bestLabel || '—');
    }

    /** Bronze-through-author ladder as a row of pips (a full medal badge per tier would be noise at this size). Rebuilt only when the earned set changes. Locked stages still show it, dormant. */
    paintMedals(element, card) {
        const tiers = Array.isArray(card.medalTiers) ? card.medalTiers : [];
        const key = tiers.map(({ tier, filled }) => `${tier}${filled ? '+' : '-'}`).join('');
        if (element.dataset.medalKey === key) return;
        element.dataset.medalKey = key;

        if (!tiers.length) {
            element.replaceChildren(createMedalIconSvg('white', {
                className: 'track-carousel__medal',
                outline: true,
                rowPlaceholder: true,
                showEmblem: false,
            }));
            return;
        }

        element.replaceChildren(...tiers.map(({ tier, filled }) => {
            const icon = createMedalIconSvg(tier, {
                className: 'track-carousel__medal',
                outline: !filled,
                showEmblem: false,
            });
            icon.classList?.toggle?.('is-earned', filled);
            return icon;
        }));
    }

    /** Rank + leaderboard entry point. A locked stage has neither, so its unlock medal count takes that spot on the scoreline instead. */
    paintRank(parts, card) {
        if (card.locked) {
            const meter = card.lockMeter || null;
            parts.rank.hidden = true;
            parts.rank.disabled = true;
            parts.rankMedal.hidden = !meter;
            if (meter) {
                const key = `${meter.value}:${meter.ratio}`;
                if (parts.rankMedal.dataset.meterKey !== key) {
                    parts.rankMedal.dataset.meterKey = key;
                    parts.rankMedal.replaceChildren(createUnlockMedalMeter(meter));
                }
                parts.rankMedal.setAttribute(
                    'aria-label',
                    `${card.trackName} is locked. ${card.lockedLabel || ''}`.trim(),
                );
            }
            return;
        }

        parts.rankMedal.hidden = true;
        parts.rank.hidden = false;
        parts.rankValue.hidden = false;
        parts.rankLabel.hidden = false;
        setText(parts.rankLabel, 'Rank');
        parts.rank.disabled = false;
        setText(parts.rankValue, card.rankPending ? '···' : (card.rankLabel || '—'));
        parts.rank.classList.toggle('is-muted', card.rankPending || !card.rankLabel);
        parts.rank.setAttribute(
            'aria-label',
            `${card.trackName} standings. Your rank: ${card.rankPending ? 'loading' : (card.rankLabel || 'unranked')}`,
        );
    }

    /** Plate width matching the drawing's aspect at its measured height. CSS can cap height from width but not the reverse, so a short window leaves the frame wider than the track; this computes the matching width and hands it back to CSS. Keyed off the head's own column so a wrapped title can't create a feedback loop. */
    fitPlateFrames() {
        for (const element of this._elements) {
            const preview = element?._parts?.preview;
            if (!preview) continue;
            const card = this._cards[Number(element.dataset.index)];
            if (!card) continue;
            // Preview's own measured height, not the card minus its two type
            // bands — that would double-count the grid's row gaps as drawable
            // space.
            const available = preview.clientHeight;
            if (!(available > 0)) continue;
            // Subtract the canvas's own render margin so the frame doesn't
            // leave a dead band around the drawing.
            const margin = 2 * (PREVIEW_RENDER_PADDING / this.previewPixelScale());
            const drawn = Math.max(0, available - margin);
            const width = Math.round((drawn * getTrackPlateAspect(card.trackKey)) + margin);
            element.style?.setProperty?.('--plate-frame-width', `${width}px`);
        }
    }

    /** Bitmap pixels per CSS pixel the previews are drawn at. */
    previewPixelScale() {
        return Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
    }

    fitPreviews() {
        this.fitPlateFrames();
        // Device resolution: a 1x bitmap stretched this far reads as smeared.
        const scale = this.previewPixelScale();
        for (const element of this._elements) {
            const canvas = element?._parts?.canvas;
            // Layout box, not the painted (scaled-down peek) box, or the
            // bitmap is sized for the smaller peek and stretches at centre.
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
        const track = TRACKS[card.trackKey];
        if (!canvas || !track) return;
        const previewCarImage = this.getPreviewCarImage?.() || null;
        const previewCarAssetKey = this.getPreviewCarAssetKey?.() || 'fallback';
        const raceCarWorldSize = this.getPreviewCarWorldSize?.() || null;
        const previewCarWorldSize = raceCarWorldSize
            ? {
                width: raceCarWorldSize.width * PREVIEW_CAR_SCALE,
                height: raceCarWorldSize.height * PREVIEW_CAR_SCALE,
            }
            : null;
        const previewCarSizeKey = previewCarWorldSize
            ? `${previewCarWorldSize.width}x${previewCarWorldSize.height}`
            : 'default-size';
        const previewKey = [
            card.trackKey,
            card.skin || 'default',
            previewCarAssetKey,
            previewCarSizeKey,
            `${canvas.width}x${canvas.height}`,
        ].join(':');
        if (!force && canvas.dataset.previewKey === previewKey) return;
        canvas.dataset.previewKey = previewKey;

        renderCachedTrackPreviewCanvas(canvas, {
            cacheKey: [
                this.previewCacheNamespace,
                card.trackKey,
                card.skin || 'default',
                previewCarAssetKey,
                previewCarSizeKey,
            ].join(':'),
            trackGeometry: { outer: track.outer, inner: track.inner },
            presentation: resolveTrackPresentation(card.trackKey, {
                surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
                event: card.skin
                    ? { key: 'daily-challenge', trackKey: card.trackKey, skin: card.skin }
                    : null,
            }),
            startLine: track.startLine,
            startPos: track.startPos,
            startAngle: track.startAngle,
            transparentBackground: true,
            previewRenderMode: 'schematic',
            schematicCarImage: previewCarImage,
            schematicCarWorldSize: previewCarWorldSize,
            hideSchematicStartArrow: Boolean(previewCarImage),
        });
    }

    step(delta) {
        if (!this._cards.length) return;
        this.select(this._selectedIndex + delta);
    }

    /** Arrow/WASD from the lobby. Returns true when the carousel consumed it. */
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
            const rank = element._parts?.rank;
            // Only the centred card is reachable; the peeking ones are scenery.
            if (rank) rank.tabIndex = isSelected ? 0 : -1;
        });
        this.updateProximity();
    }

    /** Distance-to-centre per card, 0 to 1, published as `--card-proximity` for fade/scale/detail-reveal. Tied to distance rather than `is-carousel-selected` so details arrive gradually with the card instead of snapping in mid-swipe. */
    updateProximity() {
        const viewport = this.viewport;
        const width = viewport?.clientWidth || 0;
        // No geometry before the pane is visible; fall back to selection.
        const measurements = this._elements.map((element) => ({
            left: element?.offsetLeft || 0,
            width: element?.offsetWidth || 0,
        }));
        const measurable = width > 0 && measurements.some(({ width: cardWidth }) => cardWidth > 0);
        const center = measurable ? viewport.scrollLeft + (width / 2) : 0;

        // All layout reads complete before any style write below, or mixing
        // the two forces a fresh layout per card on every scroll frame.
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
            // Hidden panes report zero geometry in retained mobile WebViews;
            // don't treat that as a real selection change.
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

    /** One card's width, published to CSS in pixels — the lobby shell's own measure, read rather than restated, so Home and both mode screens stay the same width. */
    syncCardWidth() {
        const viewport = this.viewport;
        // Published on the root, not the rail: the peek on either side is a
        // fraction of this measure, and includes the rail's own gap.
        const host = this.root || this.rail;
        const width = viewport?.clientWidth || 0;
        if (!host || !(width > 0)) return false;
        host.style?.setProperty?.('--track-carousel-card-width', `${width}px`);
        return true;
    }

    /** Measured (not percentage) edge spacers — percentage sizing inside an intrinsic flex rail is inconsistent in embedded WebViews and can strand the last card short of centre. */
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

    /** Tops up the tail spacer by however short the rail's actual scroll range falls of centring the last card — covers rounding and any engine that measures the rail short. Reads its own prior top-up so it settles instead of oscillating. */
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
        // Interrupts our bookkeeping too, so the next scroll event adopts
        // whatever card the user's gesture left under viewport centre.
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
            // Selection must not move during a programmatic (button) scroll.
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
