const LAUNCH_TARGET_KEY = 'MiniRacerLaunchTarget';
const LAUNCH_TARGET_TTL_MS = 5 * 60 * 1000;
const VALID_TARGETS = new Set(['home', 'daily', 'campaign', 'challenge']);

function normalizeTarget(value) {
    return typeof value === 'string' && VALID_TARGETS.has(value) ? value : null;
}

function readQueryTarget(root) {
    try {
        return normalizeTarget(new URLSearchParams(root?.location?.search || '').get('mode'));
    } catch {
        return null;
    }
}

function readPostTarget(root) {
    const postData = root?.devvit?.context?.postData;
    if (!postData || typeof postData !== 'object') return null;
    if (postData.postType === 'campaign-challenge' && postData.challengeId) {
        return { mode: 'challenge', challengeId: String(postData.challengeId) };
    }
    if (postData.challenge || postData.challengeId) {
        return { mode: 'daily', challengeId: null };
    }
    return null;
}

function readStoredTarget(root) {
    const storage = root?.localStorage;
    if (!storage) return null;
    try {
        const raw = storage.getItem(LAUNCH_TARGET_KEY);
        if (!raw) return null;
        storage.removeItem(LAUNCH_TARGET_KEY);
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (!Number.isFinite(parsed.expiresAt) || Date.now() > parsed.expiresAt) return null;
        const mode = normalizeTarget(parsed.mode);
        if (!mode) return null;
        return {
            mode,
            challengeId: mode === 'challenge' && typeof parsed.challengeId === 'string'
                ? parsed.challengeId
                : null,
        };
    } catch {
        return null;
    }
}

export function requestGameLaunchTarget(mode, {
    challengeId = null,
    root = globalThis,
} = {}) {
    const target = normalizeTarget(mode);
    if (!target || !root?.localStorage) return false;
    try {
        root.localStorage.setItem(LAUNCH_TARGET_KEY, JSON.stringify({
            mode: target,
            challengeId: target === 'challenge' && typeof challengeId === 'string'
                ? challengeId
                : null,
            expiresAt: Date.now() + LAUNCH_TARGET_TTL_MS,
        }));
        return true;
    } catch {
        return false;
    }
}

function peekStoredCampaignTarget(root) {
    const storage = root?.localStorage;
    if (!storage) return null;
    try {
        const raw = storage.getItem(LAUNCH_TARGET_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (!Number.isFinite(parsed.expiresAt) || Date.now() > parsed.expiresAt) return null;
        if (normalizeTarget(parsed.mode) !== 'campaign') return null;
        storage.removeItem(LAUNCH_TARGET_KEY);
        return { mode: 'campaign', challengeId: null };
    } catch {
        return null;
    }
}

export function resolveGameLaunchTarget(root = globalThis) {
    const queryMode = readQueryTarget(root);
    if (queryMode) return { mode: queryMode, challengeId: null };

    // Own-challenge Accept stores campaign; that must beat challenge post data.
    const storedCampaign = peekStoredCampaignTarget(root);
    if (storedCampaign) return storedCampaign;

    const postTarget = readPostTarget(root);
    if (postTarget?.mode === 'challenge') return postTarget;

    const storedTarget = readStoredTarget(root);
    if (storedTarget) return storedTarget;

    if (postTarget) return postTarget;
    return { mode: 'home', challengeId: null };
}

export { LAUNCH_TARGET_KEY };
