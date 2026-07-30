/**
 * Lobby track carousel — the picker both Daily and Campaign use.
 *
 * One card sits in the middle and its neighbours peek in from both edges, so
 * the run of tracks is visible without opening anything. Swipe, A/D, arrows and
 * the two chevrons all move the same selection, and the rank chip on a card is
 * the way into that track's standings.
 *
 * The view is model-driven: what a card *says* comes from a per-mode card
 * builder, and everything here is the rail that scrolls them.
 */
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
        // A player may grab the rail while a button/restore scroll is still in
        // flight. Their gesture owns selection immediately; a fixed suppression
        // window otherwise leaves the visible card and Start target disagreeing.
        const takeScrollControl = () => this.handleUserScrollIntent();
        viewport.addEventListener('pointerdown', takeScrollControl, { passive: true });
        viewport.addEventListener('touchstart', takeScrollControl, { passive: true });
        viewport.addEventListener('wheel', takeScrollControl, { passive: true });
        viewport.addEventListener('scrollend', () => this.handleScrollEnd(), { passive: true });
        window.addEventListener('resize', () => {
            this.fitPreviews();
            this.scrollToSelected({ animate: false });
        });
        if (typeof ResizeObserver === 'function') {
            this._resizeObserver = new ResizeObserver(() => {
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

    /**
     * Repaints the rail. Cards are rebuilt only when the run of tracks actually
     * changes — a rank or medal arriving late patches the existing card so the
     * scroll position and any in-flight swipe survive the update.
     */
    render(cards = [], {
        selectedChallengeId = this.getSelectedChallengeId(),
        loading = false,
    } = {}) {
        const rail = this.rail;
        if (!rail) return;

        const previousIds = this._cards.map((card) => card.challengeId).join('|');
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
            cards.forEach((card, index) => this.paintCard(this._elements[index], card));
        } else {
            this._elements = cards.map((card, index) => this.buildCard(card, index));
            rail.replaceChildren(this.edgeSpacer('lead'), ...this._elements, this.edgeSpacer('tail'));
            this.playRailEntrance(rail);
        }

        const requestedIndex = findCarouselIndex(cards, selectedChallengeId);
        const nextIndex = requestedIndex >= 0 ? requestedIndex : 0;
        const changed = nextIndex !== this._selectedIndex;
        this._selectedIndex = nextIndex;
        this.applySelectionClasses();
        this.syncNavButtons();
        // A fresh rail has no layout yet, so centring and sizing the previews
        // both have to wait for the paint.
        //
        // Never animated: a render is a repaint, not a navigation. Smooth
        // scrolling belongs to select()/step(), where the player asked to move.
        // Re-entering a mode screen used to animate here — and because the rail
        // sits inside a display:none overlay while a race is on, its scrollLeft
        // is clamped to 0 by then, so "no change" became a half-second glide
        // across the whole rail before the centred card arrived.
        this.scrollToSelected({ animate: false });
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => this.fitPreviews());
        }
        if (changed || !sameRun) this.emitSelection();
    }

    /**
     * The room the first and last cards need on their outer side to reach the
     * middle of the viewport.
     *
     * A real child rather than the rail's own `padding-inline`: a scroll
     * container's trailing padding is dropped by some WebKit builds, and the
     * embedded Reddit browser is one of them — the rail then runs out of scroll
     * a third of a card early and the last track stops short of centre. A flex
     * item is counted by every engine.
     */
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

    /**
     * The rail is only rebuilt when the run of tracks changes, which in
     * practice is the frame the tracks finish loading and replace "Loading
     * tracks". The class carries the entrance; it comes back off so that
     * re-showing the lobby after a race does not replay it on top of the
     * pane's own entrance.
     */
    playRailEntrance(rail) {
        if (!rail?.classList) return;
        rail.classList.remove('is-entering');
        void rail.offsetWidth;
        rail.classList.add('is-entering');
        rail.addEventListener?.(
            'animationend',
            () => rail.classList.remove('is-entering'),
            { once: true },
        );
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

    /**
     * Built from the same hero-row parts the tracks sheet uses, so a track card
     * looks like a track card wherever it is shown; the carousel only changes
     * how they are laid out.
     */
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
        const medal = document.createElement('div');
        medal.className = 'daily-playlist-hero-medal';
        medal.setAttribute('aria-hidden', 'true');
        const previewLock = document.createElement('span');
        previewLock.className = 'track-carousel__preview-lock';
        previewLock.setAttribute('aria-hidden', 'true');
        previewLock.appendChild(createLockIconSvg('track-carousel__preview-lock-icon'));
        previewArt.append(canvas);
        preview.append(previewArt, previewLock);

        const content = document.createElement('div');
        content.className = 'daily-playlist-hero-content';

        // Two rows: what the track is called in the run, then what it is and how
        // the player stands on it.
        const head = document.createElement('div');
        head.className = 'track-carousel__card-head';
        const foot = document.createElement('div');
        foot.className = 'track-carousel__card-foot';

        const info = document.createElement('div');
        info.className = 'daily-playlist-hero-info';

        const eyebrow = document.createElement('span');
        eyebrow.className = 'daily-playlist-hero-day';
        const title = document.createElement('span');
        title.className = 'daily-playlist-hero-title';
        const meta = document.createElement('span');
        meta.className = 'track-carousel__meta';
        const rank = document.createElement('button');
        rank.type = 'button';
        rank.className = 'track-carousel__rank';
        const rankLabel = document.createElement('span');
        rankLabel.className = 'track-carousel__rank-label';
        rankLabel.textContent = 'Rank';
        const rankValue = document.createElement('span');
        rankValue.className = 'track-carousel__rank-value';
        const rankMedal = document.createElement('span');
        rankMedal.className = 'track-carousel__unlock-medal-host';
        rankMedal.hidden = true;
        rank.append(rankLabel, rankValue, rankMedal);
        rank.addEventListener('click', (event) => {
            event.stopPropagation();
            const current = this._cards[Number(element.dataset.index)] || null;
            if (current && !current.locked) {
                this.onOpenLeaderboard?.(current.challenge, current);
            }
        });

        info.append(title, meta);
        head.append(eyebrow, medal);
        foot.append(info, rank);
        content.append(head, foot);
        element.append(preview, content);

        // Poking a peeking card is the obvious way to bring it in.
        element.addEventListener('click', () => {
            const cardIndex = Number(element.dataset.index);
            if (Number.isInteger(cardIndex)) this.select(cardIndex);
        });

        element._parts = {
            canvas, eyebrow, title, meta, rank, rankLabel, rankValue, rankMedal, medal,
            previewLock,
        };
        this.paintCard(element, card);
        return element;
    }

    paintCard(element, card) {
        const parts = element?._parts;
        if (!parts || !card) return;
        element.dataset.challengeId = card.challengeId;

        setText(parts.eyebrow, card.eyebrowLabel);
        setText(parts.title, card.trackName);
        setText(parts.meta, card.metaLabel);
        // `current` is the sheet's own treatment for the track in play; the
        // track a player is on gets it here for the same reason.
        element.classList.toggle('current', Boolean(card.isCurrent));
        element.classList.toggle('is-locked', Boolean(card.locked));
        parts.previewLock.hidden = !card.locked;

        this.paintRank(parts, card);

        this.paintMedals(parts.medal, card);

        this.renderPreview(parts.canvas, card);
    }

    /**
     * Every tier the track offers, bronze through author, so the card shows the
     * whole ladder and how far up it the player is. Read as a row of pips rather
     * than four separate badges, so the wordmark and tier caption the shared
     * medal carries would only be noise at this size. Rebuilt only when the
     * earned set changes — this runs on every repaint.
     */
    paintMedals(element, card) {
        const tiers = Array.isArray(card.medalTiers) ? card.medalTiers : [];
        const key = tiers.map(({ tier, filled }) => `${tier}${filled ? '+' : '-'}`).join('');
        if (element.dataset.medalKey === key) return;
        element.dataset.medalKey = key;

        if (!tiers.length) {
            // A track with no thresholds has no ladder to show.
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

    /**
     * A locked track has no standings to open, so the chip states the gate. The
     * medal count is the one number governing it, and it belongs in the slot the
     * card already sizes for a number rather than in the fine print.
     */
    paintRank(parts, card) {
        if (card.locked) {
            const meter = card.lockMeter || null;
            setText(parts.rankValue, meter ? '' : 'Locked');
            setText(parts.rankLabel, 'Rank');
            parts.rankLabel.hidden = true;
            parts.rankValue.hidden = Boolean(meter);
            parts.rankMedal.hidden = !meter;
            if (meter) {
                const key = `${meter.value}:${meter.ratio}`;
                if (parts.rankMedal.dataset.meterKey !== key) {
                    parts.rankMedal.dataset.meterKey = key;
                    parts.rankMedal.replaceChildren(createUnlockMedalMeter(meter));
                }
            }
            parts.rank.disabled = true;
            parts.rank.classList.toggle('is-muted', !meter);
            parts.rank.setAttribute(
                'aria-label',
                `${card.trackName} is locked. ${card.lockedLabel || ''}`.trim(),
            );
            return;
        }

        parts.rankMedal.hidden = true;
        parts.rankValue.hidden = false;
        setText(parts.rankLabel, 'Rank');
        parts.rank.disabled = false;
        setText(parts.rankValue, card.rankPending ? '···' : (card.rankLabel || 'Unranked'));
        // "Rank Unranked" reads as a stutter; the word stands on its own.
        parts.rankLabel.hidden = !card.rankPending && !card.rankLabel;
        parts.rank.classList.toggle('is-muted', card.rankPending || !card.rankLabel);
        parts.rank.setAttribute(
            'aria-label',
            `${card.trackName} standings. Your rank: ${card.rankPending ? 'loading' : (card.rankLabel || 'unranked')}`,
        );
    }

    /**
     * The card stretches to the pane, so the preview is drawn once at a nominal
     * size and redrawn by `fitPreviews` once its real box is known — a 16:9
     * bitmap letterboxed into a tall panel is mostly empty gradient.
     */
    fitPreviews() {
        // Draw at device resolution: a 1x bitmap stretched this far reads as a
        // soft, smeared track.
        const scale = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
        for (const element of this._elements) {
            const canvas = element?._parts?.canvas;
            // Layout box, not the painted one: a peeking card is scaled down, and
            // measuring that would size its bitmap for the smaller of the two
            // sizes it is shown at, then stretch it when the card takes centre.
            const host = canvas?.parentElement;
            if (!canvas || !host?.offsetWidth || !host?.offsetHeight) continue;
            const width = Math.round(host.offsetWidth * scale);
            const height = Math.round(host.offsetHeight * scale);
            if (canvas.width === width && canvas.height === height) continue;
            canvas.width = width;
            canvas.height = height;
            const card = this._cards[Number(element.dataset.index)];
            if (card) this.renderPreview(canvas, card, { force: true });
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

    /**
     * How close each card is to the middle of the viewport, 0 to 1, published to
     * CSS as `--card-proximity`.
     *
     * The card's fade, its set-back scale and whether its details are showing
     * all hang off this. They used to hang off `is-carousel-selected`, which
     * flips the instant a card takes the centre — so mid-swipe, a card's date,
     * laps, best time and rank all appeared at once, in one step, while the
     * player's finger was still moving. Tying them to distance instead means
     * the details arrive with the card.
     */
    updateProximity() {
        const viewport = this.viewport;
        const width = viewport?.clientWidth || 0;
        // Before the pane is visible there is no geometry to measure against;
        // fall back to the selection so a card is never stranded invisible.
        const measurable = width > 0 && this._elements.some((element) => element.offsetWidth > 0);
        const center = measurable ? viewport.scrollLeft + (width / 2) : 0;

        // Measured in full, then written in full. Writing a custom property the
        // card's transform reads invalidates its style, so reading the next
        // card's box in the same pass forces a fresh layout on every card, on
        // every frame of every scroll.
        const proximities = this._elements.map((element, index) => {
            if (!measurable || !(element.offsetWidth > 0)) {
                return index === this._selectedIndex ? 1 : 0;
            }
            const distance = Math.abs((element.offsetLeft + (element.offsetWidth / 2)) - center);
            // Falls to zero exactly as the neighbouring card takes centre.
            return Math.max(0, 1 - (distance / element.offsetWidth));
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
            // display:none panes report zero geometry in retained mobile
            // WebViews. Do not turn that temporary layout into a new selection;
            // ResizeObserver will centre the remembered card when it is visible.
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

    /**
     * Give both ends a measured spacer. Percentage sizing inside an intrinsic
     * flex rail is inconsistent in embedded WebViews, which can make the final
     * card hit maxScrollLeft before its centre reaches the viewport centre.
     */
    syncEdgeSpacing(element = this._elements[this._selectedIndex]) {
        const viewport = this.viewport;
        const rail = this.rail;
        if (!viewport || !rail || !element
            || !(viewport.clientWidth > 0) || !(element.offsetWidth > 0)) {
            return false;
        }
        const edgeSpace = Math.max(0, (viewport.clientWidth - element.offsetWidth) / 2);
        rail.style?.setProperty?.('--track-carousel-edge-space', `${edgeSpace}px`);
        this.syncTailShortfall();
        return true;
    }

    /**
     * Whatever the rail can actually be scrolled to is the last word on whether
     * the final card can reach the middle. Measuring it and topping the tail up
     * by the difference covers the rounding a fractional card width leaves
     * behind, and any engine that measures the rail short for its own reasons.
     *
     * The shortfall is read with the current top-up already applied, so it
     * accumulates onto itself and settles instead of oscillating.
     */
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
        // Pointer/touch/wheel input interrupts a smooth scroll in browsers. It
        // must also interrupt our bookkeeping so the following scroll event can
        // adopt the card now under the viewport centre.
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
            // Once a frame, and whoever moved the rail: a button's smooth scroll
            // brings the details up exactly the way a swipe does. Selection is
            // the part a programmatic scroll must not touch mid-flight.
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
