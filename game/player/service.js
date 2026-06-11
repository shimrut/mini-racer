import { getBaseApiConfig, getOrCreatePlayerId } from '../scoreboard/api-client.js?v=2.09';

const FIRST_SEEN_AT_KEY = 'playerFirstSeenAt';
const RETURNING_PLAYER_DELAY_MS = 24 * 60 * 60 * 1000;

export class SessionFlagStore {
    get(key) {
        try {
            return sessionStorage.getItem(key) === '1';
        } catch (error) {
            return false;
        }
    }

    set(key, value) {
        try {
            sessionStorage.setItem(key, value);
        } catch (error) {
            // Storage access can fail in privacy-restricted contexts; gameplay should continue.
        }
    }
}

export class PlayerStatusStore {

    constructor(now = () => Date.now()) {
        this.now = now;
    }

    getOrCreateFirstSeenAt() {
        const stored = this.getStoredFirstSeenAt();
        if (stored !== null) return stored;

        const firstSeenAt = this.now();
        this.setStoredFirstSeenAt(firstSeenAt);
        return firstSeenAt;
    }

    isReturningPlayer(hasAnyTrackData) {
        if (!hasAnyTrackData) {
            this.getOrCreateFirstSeenAt();
            return false;
        }

        const firstSeenAt = this.getOrCreateFirstSeenAt();
        return (this.now() - firstSeenAt) > RETURNING_PLAYER_DELAY_MS;
    }

    getStoredFirstSeenAt() {
        try {
            const raw = localStorage.getItem(FIRST_SEEN_AT_KEY);
            if (!raw) return null;
            const parsed = Number(raw);
            return Number.isFinite(parsed) ? parsed : null;
        } catch (error) {
            return null;
        }
    }

    setStoredFirstSeenAt(value) {
        try {
            localStorage.setItem(FIRST_SEEN_AT_KEY, String(value));
        } catch (error) {
            // Storage access can fail in privacy-restricted contexts; gameplay should continue.
        }
    }
}
// --- Analytics ---

function createSessionId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sanitizePayload(payload) {
    return payload && typeof payload === 'object' ? payload : {};
}

function getClientPlatform() {
    const client = globalThis.devvit?.context?.client;
    if (client?.name === 'ANDROID') return 'android';
    if (client?.name === 'IOS') return 'ios';
    return 'web';
}

function getLanguage() {
    const language = typeof navigator !== 'undefined' && typeof navigator.language === 'string'
        ? navigator.language.trim().toLowerCase()
        : '';
    return language || undefined;
}

function getClientVersion() {
    const nativeVersion = globalThis.devvit?.context?.client?.version;
    if (nativeVersion && Number.isFinite(nativeVersion.yyyy) && Number.isFinite(nativeVersion.release)) {
        return `${nativeVersion.yyyy}.${nativeVersion.release}`;
    }

    const webClientVersion = globalThis.devvit?.dependencies?.client;
    return typeof webClientVersion === 'string' && webClientVersion.trim()
        ? webClientVersion.trim()
        : undefined;
}

function getTimezone() {
    try {
        const timezone = Intl.DateTimeFormat().resolvedOptions?.().timeZone;
        return typeof timezone === 'string' && timezone.trim() ? timezone.trim() : undefined;
    } catch (_error) {
        return undefined;
    }
}

function getScreenBucket() {
    const width = Math.max(
        0,
        typeof window !== 'undefined' ? Number(window.innerWidth) || 0 : 0,
        typeof document !== 'undefined' ? Number(document.documentElement?.clientWidth) || 0 : 0,
    );

    if (width >= 1280) return 'xl';
    if (width >= 960) return 'lg';
    if (width >= 720) return 'md';
    if (width >= 480) return 'sm';
    return 'xs';
}

function getOrientation() {
    const width = Math.max(
        0,
        typeof window !== 'undefined' ? Number(window.innerWidth) || 0 : 0,
        typeof document !== 'undefined' ? Number(document.documentElement?.clientWidth) || 0 : 0,
    );
    const height = Math.max(
        0,
        typeof window !== 'undefined' ? Number(window.innerHeight) || 0 : 0,
        typeof document !== 'undefined' ? Number(document.documentElement?.clientHeight) || 0 : 0,
    );

    if (!width || !height) return undefined;
    return width >= height ? 'landscape' : 'portrait';
}

function getAnalyticsContextPayload() {
    return {
        clientPlatform: getClientPlatform(),
        clientVersion: getClientVersion(),
        language: getLanguage(),
        timezone: getTimezone(),
        screenBucket: getScreenBucket(),
        orientation: getOrientation(),
    };
}

export class AnalyticsService {
    constructor({
        config = getBaseApiConfig(),
        now = () => performance.now(),
    } = {}) {
        this.analyticsUrl = `${config.apiBaseUrl || '/api'}/analytics/event`;
        this.playerId = getOrCreatePlayerId('analytics');
        this.sessionId = createSessionId();
        this.now = now;
        this.openedAt = this.now();
        this.lastChunkAt = this.openedAt;
        this.closed = false;
        this.track('game_opened');

        if (typeof setInterval === 'function') {
            this.chunkInterval = setInterval(() => this.trackPlaytimeChunk(), 15000);
        }
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    this.trackPlaytimeChunk();
                } else {
                    this.lastChunkAt = this.now();
                }
            });
        }
    }

    track(eventName, payload) {
        if (!eventName || typeof fetch !== 'function') return;

        const body = JSON.stringify({
            eventName,
            playerId: this.playerId,
            sessionId: this.sessionId,
            payload: {
                ...getAnalyticsContextPayload(),
                ...sanitizePayload(payload),
            },
        });

        fetch(this.analyticsUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true,
        }).catch(() => {
            // Analytics failures must never affect gameplay.
        });
    }

    trackPlaytimeChunk() {
        if (this.closed) return;
        const now = this.now();
        const durationSec = Math.max(0, (now - this.lastChunkAt) / 1000);
        this.lastChunkAt = now;
        
        if (durationSec >= 1) {
            this.track('game_playtime_chunk', { durationSec });
        }
    }

    trackGameClosed() {
        if (this.closed) return;
        this.closed = true;
        if (this.chunkInterval) clearInterval(this.chunkInterval);
        
        const now = this.now();
        const durationSec = Math.max(0, (now - this.lastChunkAt) / 1000);
        
        const body = JSON.stringify({
            eventName: 'game_closed',
            playerId: this.playerId,
            sessionId: this.sessionId,
            payload: {
                ...getAnalyticsContextPayload()
            },
        });
        
        if (durationSec >= 1) {
            this.track('game_playtime_chunk', { durationSec });
        }

        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
            const blob = new Blob([body], { type: 'application/json' });
            if (navigator.sendBeacon(this.analyticsUrl, blob)) return;
        }

        if (typeof fetch !== 'function') return;
        fetch(this.analyticsUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true,
        }).catch(() => {
            // Analytics failures must never affect gameplay.
        });
    }

    trackPlayerType(isReturningPlayer) {
        // Analytics disabled
    }

    trackSupportClick() {
        // Analytics disabled
    }

    trackHeaderMenuOpen() {
        // Analytics disabled
    }

    trackHowToPlayOpen() {
        // Analytics disabled
    }

    trackModeSelected(payload) {
        // Analytics disabled
    }

    trackModeStarted(payload) {
        this.track('race_started', payload);
    }

    trackMapEvent(mapStats) {
        // Analytics disabled
    }

    trackPageview(url, title) {
        // Analytics disabled
    }

    trackRaceEnded(payload) {
        this.track('race_ended', payload);
    }

    trackRaceRestarted(payload) {
        this.track('race_restarted', payload);
    }
}
