import { RealTimeRacer } from './engine.js';
import { setupVisibleViewportHeight } from './ui/visible-viewport.js';

function setupMobileViewportGuards() {
    const hasTouchInput = window.matchMedia('(pointer: coarse)').matches
        || navigator.maxTouchPoints > 0
        || 'ontouchstart' in window;
    if (!hasTouchInput) return;

    let lastTouchEndAt = 0;
    const preventDefault = (event) => event.preventDefault();
    const isInteractiveTouchTarget = (event) => {
        if (!(event.target instanceof Element)) return false;
        return Boolean(event.target.closest(
            'button, [role="button"], a, input, select, textarea, label, summary, .modal, #start-overlay'
        ));
    };
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
        if (isInteractiveTouchTarget(event)) {
            lastTouchEndAt = now;
            return;
        }
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

setupVisibleViewportHeight();
setupMobileViewportGuards();
new RealTimeRacer();
