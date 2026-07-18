import {
    collectVisibleActionButtons,
    createMenuKeyboardState,
    dismissMenuKeyboardCue,
    handleMenuListKeydown,
    resetMenuKeyboardState,
} from '../ui/menu-keyboard-nav.js';

const BLOCKING_OVERLAY_IDS = [
    'modal',
    'settings-modal',
    'garage-modal',
    'daily-playlist-modal',
];

export class StartOverlay {
    constructor({
        dailyChallengeUi,
    } = {}) {
        this.dailyChallengeUi = dailyChallengeUi;
        this._startOverlayHasAnyData = false;
        this._startOverlayIsReturningPlayer = false;
        this._isReady = false;
        this._menuKeyboardState = createMenuKeyboardState();
        this._menuKeydownHandler = null;
        this._menuPointerMoveHandler = null;
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

    refreshStartOverlay(
        status,
        hasAnyData,
        isReturningPlayer = false,
    ) {
        const overlay = this.startOverlay;
        if (status !== "ready" || (overlay && overlay.style.display === "none")) return;
        this.updateStartOverlayMode(hasAnyData, isReturningPlayer);
    }

    isStartOverlayVisible() {
        const overlay = this.startOverlay;
        return Boolean(
            overlay && overlay.style.display !== "none",
        );
    }

    isLobbyKeyboardNavBlocked() {
        for (const id of BLOCKING_OVERLAY_IDS) {
            const el = document.getElementById(id);
            if (el?.classList?.contains('active')) return true;
        }
        return false;
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

    bindKeyboardNavigation() {
        if (typeof document === 'undefined') return;
        if (!this._menuKeydownHandler) {
            this._menuKeydownHandler = (event) => this.handleLobbyMenuKeydown(event);
            document.addEventListener('keydown', this._menuKeydownHandler, true);
        }
        if (!this._menuPointerMoveHandler) {
            this._menuPointerMoveHandler = (event) => this.handleLobbyMenuPointerMove(event);
            document.addEventListener('pointermove', this._menuPointerMoveHandler, true);
        }
    }

    handleLobbyMenuKeydown(event) {
        if (!this.isStartOverlayVisible()) return;
        if (this.isLobbyKeyboardNavBlocked()) return;

        const buttons = this.getLobbyMenuButtons();
        handleMenuListKeydown(event, {
            buttons,
            state: this._menuKeyboardState,
            container: this.mainMenu,
        });
    }

    handleLobbyMenuPointerMove(event) {
        if (!this._menuKeyboardState.keyboardNavActive) return;
        if (event.pointerType && event.pointerType !== 'mouse') return;
        if (!this.isStartOverlayVisible()) return;
        if (this.isLobbyKeyboardNavBlocked()) return;

        const buttons = this.getLobbyMenuButtons();
        dismissMenuKeyboardCue(this._menuKeyboardState, buttons, {
            container: this.mainMenu,
            preferredIndex: this.getLobbyPreferredIndex(buttons),
        });
    }

    showStartOverlay(hasAnyData, isReturningPlayer = false) {
        const overlay = this.startOverlay;
        const group = this.startGroup;
        if (overlay) overlay.style.display = "flex";
        if (group) group.style.display = "flex";
        this.setStartOverlayActive(true);
        this.updateStartOverlayMode(hasAnyData, isReturningPlayer);
        this.resetLobbyMenuKeyboardNav();
        requestAnimationFrame(() => this.focusPrimaryAction());
    }

    hideStartOverlay() {
        const overlay = this.startOverlay;
        if (overlay) overlay.style.display = "none";
        this.setStartOverlayActive(false);
        this.setStartSelectionMode(false);
        this.resetLobbyMenuKeyboardNav();
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
                if (hasChallenge) {
                    const summary = this.dailyChallengeUi?.getSummary?.();
                    const trackName = summary?.trackName || "Daily challenge";
                    const primaryLabel = document.createElement("span");
                    primaryLabel.className = "start-btn-main";
                    primaryLabel.textContent = "Start Race";

                    const secondaryLabel = document.createElement("span");
                    secondaryLabel.className = "start-btn-sub";
                    secondaryLabel.textContent = trackName;

                    labelSpan.replaceChildren(primaryLabel, secondaryLabel);
                } else {
                    labelSpan.textContent = "Challenge unavailable";
                }
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
        if (!this._isReady || this.startBtn?.disabled) {
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
        if (this._isReady) {
            requestAnimationFrame(() => this.focusPrimaryAction());
        }
    }
}
