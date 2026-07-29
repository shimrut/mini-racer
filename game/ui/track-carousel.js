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
import {
    resolveTrackPresentation,
    TRACK_PRESENTATION_SURFACES,
} from '../track/presentation.js';

const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 176;
const SCROLL_SETTLE_MS = 90;
const PROGRAMMATIC_SCROLL_TIMEOUT_MS = 1200;

function setText(element, value) {
    if (element) element.textContent = value;
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
    } = {}) {
        this.idPrefix = idPrefix;
        this.previewCacheNamespace = previewCacheNamespace;
        this.onSelect = onSelect;
        this.onOpenLeaderboard = onOpenLeaderboard;
        this.onSettle = onSettle;
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

    getCards() {
        return this._cards;
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
            rail.replaceChildren(...this._elements);
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
        const canvas = document.createElement('canvas');
        canvas.width = PREVIEW_WIDTH;
        canvas.height = PREVIEW_HEIGHT;
        canvas.setAttribute('aria-hidden', 'true');
        const medal = document.createElement('div');
        medal.className = 'daily-playlist-hero-medal';
        medal.setAttribute('aria-hidden', 'true');
        preview.append(canvas, medal);

        const content = document.createElement('div');
        content.className = 'daily-playlist-hero-content';

        const info = document.createElement('div');
        info.className = 'daily-playlist-hero-info';

        const eyebrow = document.createElement('span');
        eyebrow.className = 'daily-playlist-hero-day';
        const title = document.createElement('span');
        title.className = 'daily-playlist-hero-title';
        const meta = document.createElement('span');
        meta.className = 'track-carousel__meta';
        const chase = document.createElement('span');
        chase.className = 'track-carousel__chase';
        chase.hidden = true;

        const rank = document.createElement('button');
        rank.type = 'button';
        rank.className = 'track-carousel__rank';
        const rankLabel = document.createElement('span');
        rankLabel.className = 'track-carousel__rank-label';
        rankLabel.textContent = 'Rank';
        const rankValue = document.createElement('span');
        rankValue.className = 'track-carousel__rank-value';
        rank.append(rankLabel, rankValue);
        rank.addEventListener('click', (event) => {
            event.stopPropagation();
            const current = this._cards[Number(element.dataset.index)] || null;
            if (current && !current.locked) {
                this.onOpenLeaderboard?.(current.challenge, current);
            }
        });

        info.append(eyebrow, title, meta, chase);
        content.append(info, rank);
        element.append(preview, content);

        // Poking a peeking card is the obvious way to bring it in.
        element.addEventListener('click', () => {
            const cardIndex = Number(element.dataset.index);
            if (Number.isInteger(cardIndex)) this.select(cardIndex);
        });

        element._parts = { canvas, eyebrow, title, meta, chase, rank, rankLabel, rankValue, medal };
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
        this.paintChase(parts.chase, card.chase);
        // `current` is the sheet's own treatment for the track in play; the
        // track a player is on gets it here for the same reason.
        element.classList.toggle('current', Boolean(card.isCurrent));
        element.classList.toggle('is-locked', Boolean(card.locked));

        this.paintRank(parts, card);

        this.paintMedals(parts.medal, card);

        this.renderPreview(parts.canvas, card);
    }

    /**
     * Every tier the track offers, bronze at the top through author, so the card
     * shows the whole ladder and how far up it the player is. Rebuilt only when
     * the earned set changes — this runs on every repaint.
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
            }));
            return;
        }

        element.replaceChildren(...tiers.map(({ tier, filled }) => {
            const icon = createMedalIconSvg(tier, {
                className: 'track-carousel__medal',
                outline: !filled,
            });
            icon.classList?.toggle?.('is-earned', filled);
            return icon;
        }));
    }

    /** The one target the track is chasing, when it has one left. */
    paintChase(element, chase) {
        element.hidden = !chase;
        element.dataset.tier = chase?.tier || '';
        if (!chase) {
            element.replaceChildren();
            return;
        }
        const label = document.createElement('span');
        label.className = 'track-carousel__chase-label';
        label.textContent = chase.label;
        const value = document.createElement('span');
        value.className = 'track-carousel__chase-value';
        value.textContent = chase.value;
        element.replaceChildren(label, value);
        if (chase.gap) {
            const gap = document.createElement('span');
            gap.className = 'track-carousel__chase-gap';
            gap.textContent = chase.gap;
            element.appendChild(gap);
        }
    }

    /** A locked track has no standings to open, so the chip states the gate. */
    paintRank(parts, card) {
        if (card.locked) {
            setText(parts.rankValue, 'Locked');
            parts.rankLabel.hidden = true;
            parts.rank.disabled = true;
            parts.rank.classList.add('is-muted');
            parts.rank.setAttribute(
                'aria-label',
                `${card.trackName} is locked. ${card.lockedLabel || ''}`.trim(),
            );
            return;
        }

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
            const box = canvas?.parentElement?.getBoundingClientRect?.();
            if (!canvas || !box?.width || !box?.height) continue;
            const width = Math.round(box.width * scale);
            const height = Math.round(box.height * scale);
            if (canvas.width === width && canvas.height === height) continue;
            canvas.width = width;
            canvas.height = height;
            const card = this._cards[Number(element.dataset.index)];
            if (card) this.renderPreview(canvas, card, { force: true });
        }
    }

    renderPreview(canvas, card, { force = false } = {}) {
        const track = TRACKS[card.trackKey];
        if (!canvas || !track) return;
        const previewKey = `${card.trackKey}:${card.skin || 'default'}:${canvas.width}x${canvas.height}`;
        if (!force && canvas.dataset.previewKey === previewKey) return;
        canvas.dataset.previewKey = previewKey;

        renderCachedTrackPreviewCanvas(canvas, {
            cacheKey: `${this.previewCacheNamespace}:${card.trackKey}:${card.skin || 'default'}`,
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
            if (!animate) this.scheduleSettle();
        };

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(apply);
        } else {
            apply();
        }
    }

    /**
     * Give both ends a measured spacer. Percentage padding inside an intrinsic
     * flex rail is inconsistent in embedded WebViews, which can make the final
     * card hit maxScrollLeft before its centre reaches the viewport centre.
     */
    syncEdgeSpacing(element = this._elements[this._selectedIndex]) {
        const viewport = this.viewport;
        if (!viewport || !element || !(viewport.clientWidth > 0) || !(element.offsetWidth > 0)) {
            return false;
        }
        const edgeSpace = Math.max(0, (viewport.clientWidth - element.offsetWidth) / 2);
        this.rail?.style?.setProperty?.('--track-carousel-edge-space', `${edgeSpace}px`);
        return true;
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
        if (this._suppressScrollSync) return;
        if (this._scrollFrame !== null) return;
        const schedule = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : (callback) => setTimeout(callback, 16);
        this._scrollFrame = schedule(() => {
            this._scrollFrame = null;
            this.syncSelectionFromScroll();
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

    focusSelected() {
        this._elements[this._selectedIndex]?._parts?.rank?.focus?.();
    }
}
