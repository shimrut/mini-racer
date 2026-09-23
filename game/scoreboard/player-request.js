import { getGuestPlayerToken, getOrCreatePlayerId } from './api-client.js';

export async function requestJsonWithTimeout(url, options = {}, timeoutMs) {
    const controller = typeof AbortController === 'function' && !options.signal
        ? new AbortController()
        : null;
    const timeoutId = controller
        ? setTimeout(() => controller.abort(), timeoutMs)
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

export function withPlayerIdentity(url) {
    url.searchParams.set('playerId', getOrCreatePlayerId('campaign'));
    const guestToken = getGuestPlayerToken();
    if (guestToken) url.searchParams.set('guestToken', guestToken);
    return url;
}

export function playerIdentityBody(extra = {}) {
    return {
        ...extra,
        playerId: getOrCreatePlayerId('campaign'),
        guestToken: getGuestPlayerToken(),
    };
}

export function playerRequestUrl(route) {
    return withPlayerIdentity(
        new URL(route, globalThis.location?.origin ?? 'http://localhost'),
    );
}
