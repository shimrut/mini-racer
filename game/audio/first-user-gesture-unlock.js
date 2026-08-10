const prepareFns = new Set();
let windowListenersInstalled = false;

function runRegisteredPrepares() {
    for (const fn of prepareFns) {
        try {
            fn();
        } catch {
            // Ignore; unlock should not break the page if one graph throws.
        }
    }
}

function onFirstUserGesture() {
    if (prepareFns.size === 0) {
        return;
    }
    runRegisteredPrepares();
    if (typeof window === 'undefined') {
        return;
    }
    window.removeEventListener('click', onFirstUserGesture);
    window.removeEventListener('touchstart', onFirstUserGesture);
    window.removeEventListener('keydown', onFirstUserGesture);
    windowListenersInstalled = false;
}

export function registerAudioPrepareOnFirstUserGesture(prepareFn) {
    if (typeof window === 'undefined') {
        return;
    }
    prepareFns.add(prepareFn);
    if (!windowListenersInstalled) {
        windowListenersInstalled = true;
        window.addEventListener('click', onFirstUserGesture);
        window.addEventListener('touchstart', onFirstUserGesture);
        window.addEventListener('keydown', onFirstUserGesture);
    }
}
