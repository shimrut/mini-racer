export class InteractionsUi {
    constructor({
        modal,
        startOverlay,
        leaderboards,
        onStart = null,
        onStartDailyChallenge = null,
        onShowPersonalBests = null,
        onPauseRun = null,
    } = {}) {
        this.modal = modal;
        this.startOverlay = startOverlay;
        this.leaderboards = leaderboards;
        this.onStart = onStart;
        this.onStartDailyChallenge = onStartDailyChallenge;
        this.onShowPersonalBests = onShowPersonalBests;
        this.onPauseRun = onPauseRun;
    }

    get leftTouchBtn() { return document.getElementById('btn-left'); }
    get rightTouchBtn() { return document.getElementById('btn-right'); }
    get backToMainBtn() { return document.getElementById('back-to-main-btn'); }
    get startBtn() { return document.getElementById('daily-challenge-start-btn'); }
    get hudStatsBtn() { return document.getElementById('hud-stats-btn'); }
    get menuGarageBtn() { return document.getElementById('menu-btn-garage'); }
    get desktopSpeedometer() { return document.getElementById('desktop-speedometer'); }
    get mobileSpeedometer() { return document.getElementById('mobile-speedometer'); }
    get pauseBtn() { return document.getElementById('pause-btn'); }


    bindModalViewToggles() {
        if (this.backToMainBtn) {
            this.backToMainBtn.addEventListener("click", () => {
                this.modal.dismissRunsView?.();
            });
        }
    }

    /**
     * Mobile / WebKit often leaves :focus on the first-tapped action while another looks “active”.
     * Blur siblings on pointerdown (capture) so only the pressed control keeps focus + focus ring.
     */
    bindModalActionRowPointerFocus() {
        const row = document.getElementById('modal')?.querySelector(".modal-action-row");
        if (!row) return;
        row.addEventListener(
            "pointerdown",
            (e) => {
                if (e.pointerType === "mouse" && e.button !== 0) return;
                const pressed = e.target.closest("button");
                if (!(pressed instanceof HTMLButtonElement) || !row.contains(pressed))
                    return;
                row.querySelectorAll(":scope > button").forEach((button) => {
                    if (button !== pressed) button.blur();
                });
            },
            true,
        );
    }

    bindMenu() {
        this.startOverlay?.bindKeyboardNavigation?.();
    }

    bindPrimaryActions() {
        if (this.startBtn) {
            this.startBtn.addEventListener("click", () => {
                this.startOverlay.handleStartAction(
                    this.onStart || this.onStartDailyChallenge,
                );
            });
        }
        if (this.hudStatsBtn && this.onShowPersonalBests) {
            this.hudStatsBtn.addEventListener("click", this.onShowPersonalBests);
        }
        if (this.menuGarageBtn) {
            this.menuGarageBtn.addEventListener("click", () => {
                if (this.modal?.isModalActive?.()) {
                    this.modal.closeModal();
                }
            });
        }
        if (this.desktopSpeedometer && this.onPauseRun)
            this.desktopSpeedometer.addEventListener("click", this.onPauseRun);
        if (this.mobileSpeedometer && this.onPauseRun)
            this.bindTapAction(this.mobileSpeedometer, this.onPauseRun);
        if (this.pauseBtn && this.onPauseRun)
            this.pauseBtn.addEventListener("click", this.onPauseRun);
    }

    showBottomNavPlaceholder(title, message) {
        if (!this.modal?.showModal) return;

        this.modal.showModal(title, message, null, {
            primaryActionLabel: "Back to Race",
            primaryAction: () => this.modal.closeModal?.(),
        });
    }

    bindSteeringControls({
        onLeftDown,
        onLeftUp,
        onRightDown,
        onRightUp,
    }) {
        this.bindTouchButton(this.leftTouchBtn, onLeftDown, onLeftUp);
        this.bindTouchButton(this.rightTouchBtn, onRightDown, onRightUp);
    }

    bindTapAction(element, onTap) {
        if (!element || !onTap) return;

        if (window.PointerEvent) {
            element.addEventListener("pointerup", (e) => {
                if (e.button !== undefined && e.button !== 0) return;
                e.preventDefault?.();
                onTap();
            });
            return;
        }

        element.addEventListener(
            "touchend",
            (e) => {
                e.preventDefault();
                onTap();
            },
            { passive: false },
        );
    }

    bindTouchButton(button, onDown, onUp) {
        if (!button) return;

        let isPressed = false;

        const press = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            e.preventDefault();
            if (isPressed) return;
            isPressed = true;
            onDown?.();
            button.classList.add("active");
            if (e.pointerId !== undefined) {
                button.setPointerCapture?.(e.pointerId);
            }
        };

        const release = (e) => {
            e?.preventDefault?.();
            if (!isPressed) return;
            isPressed = false;
            onUp?.();
            button.classList.remove("active");
            if (e?.pointerId !== undefined && button.hasPointerCapture?.(e.pointerId)) {
                button.releasePointerCapture?.(e.pointerId);
            }
        };

        if (window.PointerEvent) {
            button.addEventListener("pointerdown", press);
            button.addEventListener("pointerup", release);
            button.addEventListener("pointercancel", release);
            button.addEventListener("lostpointercapture", release);
            return;
        }

        button.addEventListener("touchstart", press, { passive: false });
        button.addEventListener("touchend", release, { passive: false });
        button.addEventListener("touchcancel", release, { passive: false });
        button.addEventListener("mousedown", press);
        button.addEventListener("mouseup", release);
        button.addEventListener("mouseleave", release);
    }
    resetTouchControls() {
        if (this.leftTouchBtn) this.leftTouchBtn.classList.remove("active");
        if (this.rightTouchBtn) this.rightTouchBtn.classList.remove("active");
    }
}
