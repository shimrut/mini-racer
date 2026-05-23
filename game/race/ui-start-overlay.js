export class StartOverlay {
    constructor({
        dailyChallengeUi,
    } = {}) {
        this.dailyChallengeUi = dailyChallengeUi;
        this._startOverlayHasAnyData = false;
        this._startOverlayIsReturningPlayer = false;
    }

    get startOverlay() { return document.getElementById('start-overlay'); }
    get startGroup() { return document.getElementById('start-group'); }
    get startBtn() { return document.getElementById('daily-challenge-start-btn'); }

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

    showStartOverlay(hasAnyData, isReturningPlayer = false) {
        const overlay = this.startOverlay;
        const group = this.startGroup;
        if (overlay) overlay.style.display = "flex";
        if (group) group.style.display = "flex";
        this.setStartOverlayActive(true);
        this.updateStartOverlayMode(hasAnyData, isReturningPlayer);
        requestAnimationFrame(() => this.focusPrimaryAction());
    }

    hideStartOverlay() {
        const overlay = this.startOverlay;
        if (overlay) overlay.style.display = "none";
        this.setStartOverlayActive(false);
        this.setStartSelectionMode(false);
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
                    labelSpan.innerHTML = `
                        <div class="start-btn-main">Start Race</div>
                        <div class="start-btn-sub">${trackName}</div>
                    `;
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
        if (this.startBtn?.disabled) {
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
        const overlay = this.startOverlay;
        if (overlay) {
            overlay.classList.toggle('is-ready', Boolean(isReady));
        }
        if (isReady) {
            requestAnimationFrame(() => this.focusPrimaryAction());
        }
    }
}
