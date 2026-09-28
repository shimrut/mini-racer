import {
    readPlayerCarSkinAssetName,
    readPlayerGroundCarSkinChoice,
    writePlayerCarSkinAssetName,
} from '../car/player-car-skin.js';
import {
    readPlayerTrailId,
    writePlayerTrailId,
} from '../car/player-trail.js';
import {
    API_ROUTES,
} from '../scoreboard/api-client.js';
import {
    getGuestPlayerToken,
    getOrCreatePlayerId,
    setGuestPlayerToken,
} from '../scoreboard/player-identity.js';
import {
    getCarProceduralAudioEnabled,
    setCarProceduralAudioEnabled,
} from '../settings/car-audio-preference.js';
import {
    getCollisionAutoRestartEnabled,
    setCollisionAutoRestartEnabled,
} from '../settings/collision-auto-restart-preference.js';
import {
    getCollisionRestartDelaySec,
    setCollisionRestartDelaySec,
} from '../settings/collision-restart-delay-preference.js';
import { getMusicEnabled, setMusicEnabled } from '../settings/music-preference.js';
import {
    getHideHudEnabled,
    setHideHudEnabled,
} from '../settings/hide-hud-preference.js';
import {
    applyPausePlacementPreference,
    getPausePlacement,
    PAUSE_PLACEMENT_TIMER,
} from '../settings/pause-placement-preference.js';
import { getPbGhostEnabled, setPbGhostEnabled } from '../settings/pb-ghost-preference.js';
import {
    getQuickRestartEnabled,
    setQuickRestartEnabled,
} from '../settings/quick-restart-preference.js';
import { isLocalEnvironment } from '../track/environment.js';

let saveTimer = null;

export function readPlayerPreferences() {
    const carSkinGrip = readPlayerGroundCarSkinChoice('grip');
    const carSkinDirt = readPlayerGroundCarSkinChoice('dirt');
    const carSkinSnow = readPlayerGroundCarSkinChoice('snow');
    const carSkinWater = readPlayerGroundCarSkinChoice('water');
    const carSkinSpace = readPlayerGroundCarSkinChoice('space');
    return {
        carSkin: readPlayerCarSkinAssetName(),
        // Sent only once the player picks a skin for that ground.
        ...(carSkinGrip ? { carSkinGrip } : {}),
        ...(carSkinDirt ? { carSkinDirt } : {}),
        ...(carSkinSnow ? { carSkinSnow } : {}),
        ...(carSkinWater ? { carSkinWater } : {}),
        ...(carSkinSpace ? { carSkinSpace } : {}),
        trailId: readPlayerTrailId(),
        musicEnabled: getMusicEnabled(),
        carAudioEnabled: getCarProceduralAudioEnabled(),
        pbGhostEnabled: getPbGhostEnabled(),
        pausePlacement: getPausePlacement(),
        pauseOnTimerEnabled: getPausePlacement() === PAUSE_PLACEMENT_TIMER,
        hideHudEnabled: getHideHudEnabled(),
        crashAutoRestartEnabled: getCollisionAutoRestartEnabled(),
        crashRestartDelaySec: getCollisionRestartDelaySec(),
        quickRestartEnabled: getQuickRestartEnabled(),
    };
}

export function applyPlayerPreferences(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }

    writePlayerCarSkinAssetName(value.carSkin, 'tarmac');
    writePlayerCarSkinAssetName(value.carSkinGrip, 'grip');
    writePlayerCarSkinAssetName(value.carSkinDirt, 'dirt');
    writePlayerCarSkinAssetName(value.carSkinSnow, 'snow');
    writePlayerCarSkinAssetName(value.carSkinWater, 'water');
    writePlayerCarSkinAssetName(value.carSkinSpace, 'space');
    writePlayerTrailId(value.trailId);
    setMusicEnabled(value.musicEnabled);
    setCarProceduralAudioEnabled(value.carAudioEnabled);
    setPbGhostEnabled(value.pbGhostEnabled !== false);
    applyPausePlacementPreference(value);
    setHideHudEnabled(value.hideHudEnabled === true);
    setCollisionAutoRestartEnabled(value.crashAutoRestartEnabled);
    setCollisionRestartDelaySec(value.crashRestartDelaySec);
    setQuickRestartEnabled(value.quickRestartEnabled === true);
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
