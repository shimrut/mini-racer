import {
    readPlayerCarSkinAssetName,
    writePlayerCarSkinAssetName,
} from '../car/player-car-skin.js';
import {
    readPlayerTrailId,
    writePlayerTrailId,
} from '../car/player-trail.js';
import {
    API_ROUTES,
    getGuestPlayerToken,
    getOrCreatePlayerId,
    setGuestPlayerToken,
} from '../scoreboard/api-client.js';
import {
    getCarProceduralAudioEnabled,
    setCarProceduralAudioEnabled,
} from '../settings/car-audio-preference.js';
import {
    getCrashAutoRestartAfterCrashEnabled,
    setCrashAutoRestartAfterCrashEnabled,
} from '../settings/crash-auto-restart-preference.js';
import {
    getCrashRestartDelaySec,
    setCrashRestartDelaySec,
} from '../settings/crash-restart-delay-preference.js';
import { getMusicEnabled, setMusicEnabled } from '../settings/music-preference.js';
import { isLocalEnvironment } from '../track/environment.js';

let saveTimer = null;

export function readPlayerPreferences() {
    return {
        carSkin: readPlayerCarSkinAssetName(),
        trailId: readPlayerTrailId(),
        musicEnabled: getMusicEnabled(),
        carAudioEnabled: getCarProceduralAudioEnabled(),
        crashAutoRestartEnabled: getCrashAutoRestartAfterCrashEnabled(),
        crashRestartDelaySec: getCrashRestartDelaySec(),
    };
}

export function applyPlayerPreferences(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }

    writePlayerCarSkinAssetName(value.carSkin);
    writePlayerTrailId(value.trailId);
    setMusicEnabled(value.musicEnabled);
    setCarProceduralAudioEnabled(value.carAudioEnabled);
    setCrashAutoRestartAfterCrashEnabled(value.crashAutoRestartEnabled);
    setCrashRestartDelaySec(value.crashRestartDelaySec);
    return true;
}

export async function persistPlayerPreferences() {
    if (isLocalEnvironment() || typeof fetch !== 'function') {
        return null;
    }

    const response = await fetch(API_ROUTES.playerPreferencesUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            playerId: getOrCreatePlayerId('player preferences'),
            guestToken: getGuestPlayerToken(),
            playerPreferences: readPlayerPreferences(),
        }),
    });
    if (!response.ok) {
        throw new Error(`Player preferences update failed: ${response.status}`);
    }

    const payload = await response.json().catch(() => null);
    setGuestPlayerToken(payload?.guestToken ?? getGuestPlayerToken());
    return payload?.playerPreferences ?? null;
}

export function queuePlayerPreferencesSave() {
    if (saveTimer !== null) {
        clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
        saveTimer = null;
        persistPlayerPreferences().catch((error) => {
            console.error('Error saving player preferences:', error);
        });
    }, 250);
}
