import {
    collectVisibleActionButtons,
    createMenuKeyboardState,
    resetMenuKeyboardState,
} from '../ui/menu-keyboard-nav.js';

const RACE_START_EXIT_MS = 100;

export class StartOverlay {
    constructor({
        dailyChallengeUi,
    } = {}) {
        this.dailyChallengeUi = dailyChallengeUi;
        this._startOverlayHasAnyData = false;
        this._startOverlayIsReturningPlayer = false;
        this._isReady = false;
        this._isInteractive = false;
        this._raceStartTransitionGeneration = 0;
        this._raceStartTransitionPending = false;
        this._menuKeyboardState = createMenuKeyboardState();
    }

    get startOverlay() { return document.getElementById('start-overlay'); }
    get startGroup() { return document.getElementById('start-group'); }
    get startBtn() { return document.getElementById('daily-challenge-start-btn'); }
    get mainMenu() { return this.startOverlay?.querySelector?.('.main-menu') || null; }

    setStartOverlayActive(isActive) {
        document.body.classList.toggle("start-overlay-active", Boolean(isActive));
    }

    setStartSelectionMode(isActive) {
        document.body.classList.toggle("start-selection-active", Boolean(isActive));
    }

    isStartOverlayVisible() {
        const overlay = this.startOverlay;
        return Boolean(
            overlay && overlay.style.display !== "none",
        );
    }

    getLobbyMenuButtons() {
        return collectVisibleActionButtons(this.mainMenu, ':scope > .main-menu__item');
    }

    getLobbyPreferredIndex(buttons = this.getLobbyMenuButtons()) {
        const preferredIndex = buttons.indexOf(this.startBtn);
        return preferredIndex >= 0 ? preferredIndex : null;
    }

    resetLobbyMenuKeyboardNav() {
        const buttons = this.getLobbyMenuButtons();
        resetMenuKeyboardState(this._menuKeyboardState, buttons, {
            preferredIndex: this.getLobbyPreferredIndex(buttons),
            container: this.mainMenu,
            focusPreferred: true,
        });
    }

    showStartOverlay(hasAnyData, isReturningPlayer = false) {
        const overlay = this.startOverlay;
        const group = this.startGroup;
        this._raceStartTransitionGeneration += 1;
        this._raceStartTransitionPending = false;
        if (overlay) {
            overlay.classList?.remove?.('is-race-start-exiting');
            overlay.style.display = "flex";
        }
        if (group) group.style.display = "flex";
        this.setStartOverlayActive(true);
        this.updateStartOverlayMode(hasAnyData, isReturningPlayer);
        this.resetLobbyMenuKeyboardNav();
        requestAnimationFrame(() => this.focusPrimaryAction());
    }

    beginRaceStartTransition() {
        const overlay = this.startOverlay;
        if (!overlay || overlay.style.display === "none") {
            return Promise.resolve();
        }

        const generation = this._raceStartTransitionGeneration + 1;
        this._raceStartTransitionGeneration = generation;
        this._raceStartTransitionPending = true;
        overlay.classList?.add?.('is-race-start-exiting');
        const reduceMotion = globalThis.matchMedia
            ?.('(prefers-reduced-motion: reduce)')
            ?.matches === true;
        if (reduceMotion) {
            this._raceStartTransitionPending = false;
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            setTimeout(() => {
                if (this._raceStartTransitionGeneration === generation) {
                    this._raceStartTransitionPending = false;
                }
                resolve();
            }, RACE_START_EXIT_MS);
        });
    }

    hideStartOverlay() {
        if (this._raceStartTransitionPending) return false;
        const overlay = this.startOverlay;
        if (overlay) {
            overlay.style.display = "none";
            overlay.classList?.remove?.('is-race-start-exiting');
        }
        this.setStartOverlayActive(false);
        this.setStartSelectionMode(false);
        this.resetLobbyMenuKeyboardNav();
        return true;
    }

    updateStartOverlayMode(
        hasAnyData,
        isReturningPlayer = this._startOverlayIsReturningPlayer,
    ) {
        this._startOverlayHasAnyData = Boolean(hasAnyData);
        this._startOverlayIsReturningPlayer = Boolean(isReturningPlayer);
        const isOverlayVisible = this.isStartOverlayVisible();
        const hasChallenge = Boolean(this.dailyChallengeUi?.getSummary?.()?.available);

        const startBtn = this.startBtn;
        if (startBtn) {
            startBtn.style.display = "inline-flex";
            startBtn.disabled = !hasChallenge;

            const labelSpan = startBtn.querySelector(".main-menu__label");
            if (labelSpan) {
                labelSpan.textContent = hasChallenge ? "Start Race" : "Challenge unavailable";
            } else {
                startBtn.textContent = hasChallenge
                    ? "Start Race"
                    : "Challenge unavailable";
            }
        }

        if (typeof document !== "undefined") {
            document.body.classList.toggle("ftu-onboarding-active", false);
        }
        this.setStartSelectionMode(false);
        if (isOverlayVisible) {
            requestAnimationFrame(() => this.focusPrimaryAction());
        }
    }

    focusPrimaryAction() {
        if (!this._isInteractive) return;
        if (!this.isStartOverlayVisible()) return;

        const overlay = this.startOverlay;
        const active = document.activeElement;
        if (
            active
            && active !== document.body
            && typeof overlay?.contains === 'function'
            && overlay.contains(active)
        ) {
            return;
        }

        this.dailyChallengeUi?.focus?.();
    }

    handleStartAction(onStart) {
        if (!this._isInteractive || this.startBtn?.disabled) {
            return;
        }

        onStart?.();
    }

    get hasAnyData() {
        return this._startOverlayHasAnyData;
    }

    get isReturningPlayer() {
        return this._startOverlayIsReturningPlayer;
    }

    setReady(isReady) {
        this._isReady = Boolean(isReady);
        const overlay = this.startOverlay;
        if (overlay) {
            overlay.classList.toggle('is-ready', this._isReady);
        }
    }

    setInteractive(isInteractive) {
        this._isInteractive = Boolean(isInteractive);
        if (this._isInteractive) {
            requestAnimationFrame(() => this.focusPrimaryAction());
        }
    }
}
