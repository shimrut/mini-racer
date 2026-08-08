import {
    API_ROUTES,
    getGuestPlayerToken,
    getOrCreatePlayerId,
} from '../scoreboard/api-client.js';

export const HEAD_TO_HEAD_REQUEST_TIMEOUT_MS = 20_000;

async function requestJson(url, options = {}) {
    const controller = typeof AbortController === 'function' && !options.signal
        ? new AbortController()
        : null;
    const timeoutId = controller
        ? setTimeout(() => controller.abort(), HEAD_TO_HEAD_REQUEST_TIMEOUT_MS)
        : null;
    try {
        const response = await fetch(url, controller
            ? { ...options, signal: controller.signal }
            : options);
        const body = await response.json().catch(() => null);
        return { ok: response.ok, status: response.status, body };
    } finally {
        if (timeoutId !== null) clearTimeout(timeoutId);
    }
}

function withPlayerIdentity(url) {
    url.searchParams.set('playerId', getOrCreatePlayerId('campaign'));
    const guestToken = getGuestPlayerToken();
    if (guestToken) url.searchParams.set('guestToken', guestToken);
    return url;
}

function playerIdentityBody(extra = {}) {
    return {
        ...extra,
        playerId: getOrCreatePlayerId('campaign'),
        guestToken: getGuestPlayerToken(),
    };
}

export function readChallengePostId() {
    const postId = globalThis.devvit?.context?.postId;
    return typeof postId === 'string' && postId.startsWith('t3_') ? postId : null;
}

export function challengePostIdentityBody(extra = {}) {
    const postId = readChallengePostId();
    return playerIdentityBody({
        ...extra,
        ...(postId ? { postId } : {}),
    });
}

function challengeUrl(route) {
    const url = campaignUrl(route);
    const postId = readChallengePostId();
    if (postId) url.searchParams.set('postId', postId);
    return url;
}

function campaignUrl(route) {
    return withPlayerIdentity(
        new URL(route, globalThis.location?.origin ?? 'http://localhost'),
    );
}

export async function previewHeadToHead(input) {
    return requestJson(API_ROUTES.headToHeadPreviewUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
}

export async function createHeadToHead(challengeToken, extra = {}) {
    return requestJson(API_ROUTES.headToHeadCreateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken, ...extra }),
    });
}

export async function getHeadToHead(challengeId) {
    const url = challengeUrl(API_ROUTES.headToHeadUrl);
    url.searchParams.set('challengeId', challengeId);
    return requestJson(url.toString());
}

export async function submitHeadToHeadRun({ challengeId, replay }) {
    return requestJson(API_ROUTES.headToHeadSubmitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(challengePostIdentityBody({ challengeId, replay })),
    });
}

export async function previewHeadToHeadBrag({ acceptToken }) {
    return requestJson(API_ROUTES.headToHeadBragPreviewUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(challengePostIdentityBody({ acceptToken })),
    });
}

export async function confirmHeadToHeadBrag(shareToken) {
    return requestJson(API_ROUTES.headToHeadBragConfirmUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareToken }),
    });
}

const WON_CHALLENGE_KEY = 'MiniRacerHeadToHeadWin';
const WON_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** A won duel outlives its finish sheet, so reopening the post still lands on the win. */
export function rememberHeadToHeadWin(challengeId, bestTimeMs, root = globalThis) {
    if (typeof challengeId !== 'string' || !challengeId || !root?.localStorage) return false;
    try {
        root.localStorage.setItem(WON_CHALLENGE_KEY, JSON.stringify({
            challengeId,
            bestTimeMs: Number.isFinite(bestTimeMs) ? bestTimeMs : null,
            expiresAt: Date.now() + WON_CHALLENGE_TTL_MS,
        }));
        return true;
    } catch {
        return false;
    }
}

export function readHeadToHeadWin(challengeId, root = globalThis) {
    const storage = root?.localStorage;
    if (typeof challengeId !== 'string' || !challengeId || !storage) return null;
    try {
        const parsed = JSON.parse(storage.getItem(WON_CHALLENGE_KEY) || 'null');
        if (!parsed || typeof parsed !== 'object') return null;
        if (!Number.isFinite(parsed.expiresAt) || Date.now() > parsed.expiresAt) {
            storage.removeItem(WON_CHALLENGE_KEY);
            return null;
        }
        if (parsed.challengeId !== challengeId) return null;
        return {
            outcome: 'won',
            bestTimeMs: Number.isFinite(parsed.bestTimeMs) ? parsed.bestTimeMs : null,
        };
    } catch {
        return null;
    }
}

export { WON_CHALLENGE_KEY, WON_CHALLENGE_TTL_MS };
