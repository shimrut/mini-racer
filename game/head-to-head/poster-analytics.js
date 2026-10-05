const CHALLENGE_ANALYTICS_URL = '/api/analytics/challenge';
// A positive threshold also reports entry after an edge-adjacent ratio of 0.
const MIN_VISIBLE_RATIO = 0.001;
const trackers = new WeakMap();

function isChallengePoster(root) {
    const context = root?.devvit?.context;
    return context?.postData?.postType === 'head-to-head'
        && typeof context.postData.challengeId === 'string'
        && Boolean(context.postData.challengeId.trim())
        && typeof context.postId === 'string'
        && /^t3_[a-z0-9]+$/i.test(context.postId);
}

// Reporting must never hold up the poster or its expansion gesture. Identity
// and the target post are derived by the server, not supplied by the browser.
export function reportChallengePosterEvent(action, root = globalThis) {
    if (!['view', 'click', 'own_open'].includes(action)
        || !isChallengePoster(root)
        || typeof root.fetch !== 'function') return;
    try {
        void Promise.resolve(root.fetch(CHALLENGE_ANALYTICS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
            keepalive: true,
        })).catch(() => {});
    } catch {
    }
}

export function startChallengePosterViews(
    documentRef = globalThis.document,
    root = globalThis,
    report = (action) => reportChallengePosterEvent(action, root),
) {
    const target = documentRef?.querySelector?.('.challenge-shell');
    if (!target || !isChallengePoster(root)) return () => {};
    if (trackers.has(documentRef)) return trackers.get(documentRef);

    let intersecting = typeof root.IntersectionObserver !== 'function';
    let pageActive = true;
    let viewActive = false;
    let disposed = false;
    let observer;

    const update = () => {
        if (disposed) return;
        const visible = pageActive && intersecting && !documentRef.hidden;
        if (visible && !viewActive) {
            viewActive = true;
            try { report('view'); } catch { /* Analytics cannot break the poster. */ }
        } else if (!visible) {
            viewActive = false;
        }
    };
    const onPageHide = () => { pageActive = false; update(); };
    const onPageShow = () => { pageActive = true; update(); };
    const dispose = () => {
        disposed = true;
        observer?.disconnect();
        documentRef.removeEventListener?.('visibilitychange', update);
        root.removeEventListener?.('pagehide', onPageHide);
        root.removeEventListener?.('pageshow', onPageShow);
        trackers.delete(documentRef);
    };
    trackers.set(documentRef, dispose);
    documentRef.addEventListener?.('visibilitychange', update);
    root.addEventListener?.('pagehide', onPageHide);
    root.addEventListener?.('pageshow', onPageShow);

    if (!intersecting) {
        try {
            observer = new root.IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (entry.target !== target) continue;
                    intersecting = entry.isIntersecting && entry.intersectionRatio >= MIN_VISIBLE_RATIO;
                    update();
                }
            }, { threshold: MIN_VISIBLE_RATIO });
            observer.observe(target);
        } catch {
            // Older WebViews still report visible-document poster loads.
            observer?.disconnect();
            intersecting = true;
        }
    }
    update();
    return dispose;
}
