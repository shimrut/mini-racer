import { RealTimeRacer } from './engine.js?v=2.05';
import { RUNTIME_SCOREBOARD_CONFIG } from './runtime-config.js?v=1.91';

if (typeof window !== 'undefined' && !window.VECTORGP_SCOREBOARD_CONFIG) {
    window.VECTORGP_SCOREBOARD_CONFIG = RUNTIME_SCOREBOARD_CONFIG;
}

function setupButtonDownActivation() {
    if (!window.PointerEvent) return;

    let suppressNextTrustedClick = false;
    let dispatchingDownClick = false;
    let suppressClickTimer = 0;

    document.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (event.isPrimary === false) return;
        if (!(event.target instanceof Element)) return;

        const button = event.target.closest('button');
        if (!(button instanceof HTMLButtonElement) || button.disabled) return;
        if (button.classList.contains('touch-btn')) return;

        event.preventDefault();
        event.stopImmediatePropagation();

        window.clearTimeout(suppressClickTimer);
        suppressNextTrustedClick = true;
        suppressClickTimer = window.setTimeout(() => {
            suppressNextTrustedClick = false;
        }, 750);
        dispatchingDownClick = true;
        button.click();
        dispatchingDownClick = false;
    }, true);

    document.addEventListener('click', (event) => {
        if (dispatchingDownClick || !suppressNextTrustedClick) return;
        suppressNextTrustedClick = false;
        window.clearTimeout(suppressClickTimer);
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);
}

function setupMobileViewportGuards() {
    const hasTouchInput = window.matchMedia('(pointer: coarse)').matches
        || navigator.maxTouchPoints > 0
        || 'ontouchstart' in window;
    if (!hasTouchInput) return;

    let lastTouchEndAt = 0;
    const preventDefault = (event) => event.preventDefault();
    const shouldSuppressSafariLoupe = (event) => {
        if (!(event.target instanceof Element)) return false;
        return Boolean(event.target.closest('.mobile-controls'));
    };
    const preventMultiTouchGesture = (event) => {
        if ((event.touches && event.touches.length > 1) || (event.scale && event.scale !== 1)) {
            event.preventDefault();
        }
    };
    const preventControlTouchUi = (event) => {
        if (!event.cancelable) return;
        if (!shouldSuppressSafariLoupe(event)) return;
        event.preventDefault();
    };
    const preventDoubleTapZoom = (event) => {
        const now = Date.now();
        if (now - lastTouchEndAt < 300) {
            event.preventDefault();
        }
        lastTouchEndAt = now;
    };

    document.addEventListener('gesturestart', preventDefault, { passive: false });
    document.addEventListener('gesturechange', preventDefault, { passive: false });
    document.addEventListener('gestureend', preventDefault, { passive: false });
    document.addEventListener('touchstart', preventControlTouchUi, { passive: false, capture: true });
    document.addEventListener('touchend', preventControlTouchUi, { passive: false, capture: true });
    document.addEventListener('touchcancel', preventControlTouchUi, { passive: false, capture: true });
    document.addEventListener('touchstart', preventMultiTouchGesture, { passive: false });
    document.addEventListener('touchmove', preventMultiTouchGesture, { passive: false });
    document.addEventListener('touchend', preventDoubleTapZoom, { passive: false });
    document.addEventListener('dblclick', preventDefault, { passive: false });
}

setupButtonDownActivation();
setupMobileViewportGuards();
new RealTimeRacer();
// Local-only debug/test hooks are exposed on window.__RACER_DEBUG__.
