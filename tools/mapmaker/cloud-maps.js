// The online Mapmaker at miniracer.club/mapmaker is built with the 'online' mode
// (tools/build-site.js). It saves maps to the cloud instead of the repository.
import { DEFAULT_TRACK_GROUND_KEY, TRACK_GROUND_KEYS } from '../../game/track/grounds.js';

export const MAPMAKER_ONLINE = import.meta.env?.MODE === 'online';

let ownerId = null;
let groundKeys = [DEFAULT_TRACK_GROUND_KEY];

async function readCloudSession() {
    const response = await fetch('/api/session', { cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || typeof result.ownerId !== 'string' || !/^[a-f0-9]{64}$/.test(result.ownerId)) {
        throw new Error(result.error || 'The Mapmaker is locked. Reload and enter your password.');
    }
    return {
        ownerId: result.ownerId,
        groundKeys: Array.isArray(result.groundKeys) && result.groundKeys.length
            && result.groundKeys.every((key) => TRACK_GROUND_KEYS.includes(key))
            ? result.groundKeys : [DEFAULT_TRACK_GROUND_KEY],
    };
}

export async function loadCloudSession() {
    const session = await readCloudSession();
    ownerId = session.ownerId;
    groundKeys = session.groundKeys;
}

export function getCloudGroundKeys() {
    return [...(MAPMAKER_ONLINE ? groundKeys : TRACK_GROUND_KEYS)];
}

export async function verifyCloudSession() {
    if ((await readCloudSession()).ownerId !== ownerId) {
        throw new Error('The password changed in another tab. Reload to open its maps.');
    }
}

// Browser drafts, Test Drive and lap times use the authenticated workspace too.
// Never fall back to old shared browser data in the online editor.
export function cloudStorageKey(key) {
    if (!MAPMAKER_ONLINE) return key;
    if (!ownerId) throw new Error('Your maps are still loading.');
    return `${key}:workspace:${ownerId}`;
}

export async function closeCloudSession() {
    const response = await fetch('/api/session', { method: 'DELETE' });
    if (!response.ok) throw new Error('Could not switch passwords. Try again.');
}

// Online, the page calls the cloud maps API itself; the unlock cookie lets it
// in. The local Mapmaker asks its Vite server, which adds the passcode from
// .env.local (tools/mapmaker/vite-track-authoring-plugin.js).
async function requestCloudMaps(method, key = '', body = undefined) {
    if (MAPMAKER_ONLINE && !ownerId) throw new Error('Your maps are still loading.');
    const response = MAPMAKER_ONLINE
        ? await fetch(`/api/maps${key ? `/${encodeURIComponent(key)}` : ''}`, {
            method,
            cache: 'no-store',
            headers: {
                'X-Mapmaker-Owner': ownerId ?? '',
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        })
        : await fetch('/__mapmaker/cloud-maps', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method, key }),
        });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.error || `Cloud maps failed with status ${response.status}.`);
    }
    return result;
}

// Newest first. Each map: { trackKey, originalTrackKey, track, draftLoop, medalRow, updatedAt }.
export async function listCloudMaps() {
    return (await requestCloudMaps('GET')).maps ?? [];
}

// Online only.
export function saveCloudMap(map) {
    return requestCloudMaps('PUT', map.trackKey, map);
}

export function deleteCloudMap(key) {
    return requestCloudMaps('DELETE', key);
}
