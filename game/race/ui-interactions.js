import {
    getPausePlacement,
    PAUSE_PLACEMENT_SPEEDO,
    PAUSE_PLACEMENT_TIMER,
} from '../settings/pause-placement-preference.js';

export class InteractionsUi {
    constructor({
        modal,
        startOverlay,
        leaderboards,
        onStart = null,
        onStartDailyChallenge = null,
        onPauseRun = null,
    } = {}) {
        this.modal = modal;
        this.startOverlay = startOverlay;
        this.leaderboards = leaderboards;
        this.onStart = onStart;
        this.onStartDailyChallenge = onStartDailyChallenge;
        this.onPauseRun = onPauseRun;
    }

    get leftTouchBtn() { return document.getElementById('btn-left'); }
    get rightTouchBtn() { return document.getElementById('btn-right'); }
    get backToMainBtn() { return document.getElementById('back-to-main-btn'); }
    get startBtn() { return document.getElementById('daily-challenge-start-btn'); }
    get hudStatsBtn() { return document.getElementById('hud-stats-btn'); }
    get menuGarageBtn() { return document.getElementById('menu-btn-garage'); }
    get speedometer() { return document.getElementById('speedometer'); }
    get pauseBtn() { return document.getElementById('pause-btn'); }


    bindModalViewToggles() {
        if (this.backToMainBtn) {
            this.backToMainBtn.addEventListener("click", () => {
                this.modal.dismissRunsView?.();
            });
        }
    }

    // WebKit keeps :focus on the tapped button.
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

    bindPrimaryActions() {
        if (this.startBtn) {
            this.startBtn.addEventListener("click", () => {
                this.startOverlay.handleStartAction(
                    this.onStart || this.onStartDailyChallenge,
                );
            });
        }
        if (this.menuGarageBtn) {
            this.menuGarageBtn.addEventListener("click", () => {
                if (this.modal?.isModalActive?.()) {
                    this.modal.closeModal();
                }
            });
        }
        if (this.speedometer && this.onPauseRun)
            this.speedometer.addEventListener("click", (event) => {
                if (getPausePlacement() !== PAUSE_PLACEMENT_SPEEDO) return;
                this.onPauseRun(event);
            });
        if (this.pauseBtn && this.onPauseRun)
            this.pauseBtn.addEventListener("click", this.onPauseRun);
        if (this.hudStatsBtn && this.onPauseRun)
            this.hudStatsBtn.addEventListener("click", (event) => {
                if (getPausePlacement() !== PAUSE_PLACEMENT_TIMER) return;
                this.onPauseRun(event);
            });
    }

    bindSteeringControls({
        onLeftDown,
        onLeftUp,
        onRightDown,
        onRightUp,
    }) {
        this.steeringSides = [
            this.bindSteeringSide(this.leftTouchBtn, onLeftDown, onLeftUp),
            this.bindSteeringSide(this.rightTouchBtn, onRightDown, onRightUp),
        ].filter(Boolean);

        // Each touch event lists the fingers that are still down. A finger
        // whose lift the browser lost is not in the list at the next touch.
        // This listener runs after the handlers of each side.
        const dropLostFingers = (e) => {
            if (!e.touches) return;
            const down = new Set(Array.from(e.touches, (touch) => touch.identifier));
            this.steeringSides.forEach((side) => side.keepFingers(down));
        };
        ["touchstart", "touchmove", "touchend", "touchcancel"].forEach((type) => {
            window.addEventListener(type, dropLostFingers, { passive: true });
        });
    }

    bindSteeringSide(button, onDown, onUp) {
        if (!button) return null;

        // Fingers steer from touch events. Pointer events steer only for a
        // mouse or a pen, so that one finger does not count two times.
        const fingersUseTouchEvents = "ontouchstart" in window;
        const fingers = new Set();
        const pointers = new Set();
        let isPressed = false;

        const update = () => {
            const shouldPress = fingers.size > 0 || pointers.size > 0;
            if (shouldPress === isPressed) return;
            isPressed = shouldPress;
            button.classList.toggle("active", isPressed);
            if (isPressed) onDown?.();
            else onUp?.();
        };

        const touchDown = (e) => {
            if (e.cancelable) e.preventDefault();
            Array.from(e.changedTouches || [], (touch) => fingers.add(touch.identifier));
            update();
        };

        // A lift also ends the older fingers on this side. Thus a tap stops a
        // turn when the browser lost a lift but still lists the finger.
        const touchUp = (e) => {
            if (e.cancelable) e.preventDefault();
            Array.from(e.changedTouches || [], (touch) => {
                if (!fingers.has(touch.identifier)) return;
                for (const id of fingers) {
                    fingers.delete(id);
                    if (id === touch.identifier) break;
                }
            });
            update();
        };

        const pointerDown = (e) => {
            if (e.pointerType === "touch" && fingersUseTouchEvents) return;
            if (e.button !== undefined && e.button !== 0) return;
            e.preventDefault();
            pointers.add(e.pointerId);
            update();
            if (e.pointerId !== undefined) {
                button.setPointerCapture?.(e.pointerId);
            }
        };

        const pointerUp = (e) => {
            if (!pointers.delete(e.pointerId)) return;
            if (e.pointerId !== undefined && button.hasPointerCapture?.(e.pointerId)) {
                button.releasePointerCapture?.(e.pointerId);
            }
            update();
        };

        button.addEventListener("touchstart", touchDown, { passive: false });
        button.addEventListener("touchend", touchUp, { passive: false });
        button.addEventListener("touchcancel", touchUp, { passive: false });
        if (window.PointerEvent) {
            button.addEventListener("pointerdown", pointerDown);
            button.addEventListener("pointerup", pointerUp);
            button.addEventListener("pointercancel", pointerUp);
            button.addEventListener("lostpointercapture", pointerUp);
        } else {
            button.addEventListener("mousedown", pointerDown);
            button.addEventListener("mouseup", pointerUp);
            button.addEventListener("mouseleave", pointerUp);
        }

        return {
            keepFingers(down) {
                fingers.forEach((id) => {
                    if (!down.has(id)) fingers.delete(id);
                });
                update();
            },
            // A finger or a pointer that is down now must lift and touch again.
            reset() {
                fingers.clear();
                pointers.clear();
                isPressed = false;
                button.classList.remove("active");
            },
        };
    }

    resetTouchControls() {
        this.steeringSides?.forEach((side) => side.reset());
    }
}
